"""Private-only compact chart staging and OIDC publication."""
from __future__ import annotations

import base64
import gzip
import math
from datetime import UTC, date, timedelta
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pandas as pd

from stock_scout.config.loader import load_config
from stock_scout.data.cache import ParquetCache
from stockscout_eod.contracts import (
    ChartPayloadV1,
    PrivateChartManifestV1,
    PrivateChartShardV1,
    RawScanEnvelopeV1,
    wire_dump,
)
from stockscout_eod.github_oidc import github_oidc_token
from stockscout_eod.jsonio import canonical_json_bytes, sha256_bytes, write_json

CHART_BUCKETS = 128
MAX_SHARD_BYTES = 5 * 1024 * 1024


def _bucket(ticker: str) -> str:
    return f"{int(sha256_bytes(ticker.encode('utf-8'))[:8], 16) % CHART_BUCKETS:03d}"


def _providers(row: dict[str, Any], settings: Any) -> list[str]:
    values = [
        row.get("provider_used"),
        settings.providers.primary_data_provider,
        settings.providers.fallback_provider,
        settings.providers.tertiary_fallback_provider,
        settings.providers.deep_history_provider,
    ]
    return list(dict.fromkeys(str(value) for value in values if value))


def _read_first(
    cache: ParquetCache,
    providers: list[str],
    ticker: str,
    frequency: str,
) -> pd.DataFrame:
    for provider in providers:
        frame = cache.read(provider, ticker, frequency)
        if not frame.empty:
            return frame
    return pd.DataFrame()


def _derive_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    if daily.empty:
        return daily
    return daily.resample("W-FRI").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    ).dropna(subset=["open", "high", "low", "close"])


def _compact(frame: pd.DataFrame, *, start: date, end: date) -> list[list[int | float]]:
    if frame.empty:
        return []
    subset = frame[(frame.index.date >= start) & (frame.index.date <= end)]
    rows: list[list[int | float]] = []
    for timestamp, row in subset.iterrows():
        values = [row.get(name) for name in ("open", "high", "low", "close", "volume")]
        try:
            numeric = [float(value) for value in values]
        except (TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in numeric):
            continue
        point = pd.Timestamp(timestamp)
        point = point.tz_localize(UTC) if point.tzinfo is None else point.tz_convert(UTC)
        rows.append(
            [
                int(point.timestamp()),
                round(numeric[0], 6),
                round(numeric[1], 6),
                round(numeric[2], 6),
                round(numeric[3], 6),
                round(numeric[4]),
            ]
        )
    return rows


def build_private_chart_staging(
    scan: RawScanEnvelopeV1,
    *,
    config_path: str | Path,
    output_dir: str | Path,
) -> PrivateChartManifestV1:
    destination = Path(output_dir).resolve()
    lowered_parts = {part.lower().replace("-", "_") for part in destination.parts}
    if "public" in lowered_parts or "frontend_public" in lowered_parts:
        raise ValueError("private chart staging must never be inside a public directory")

    settings = load_config(config_path)
    cache = ParquetCache(settings.project_root / settings.cache.base_dir)
    all_rows = [*scan.candidates, *scan.excluded]
    requested = len(all_rows)
    available = 0
    shards_by_ticker: dict[str, str] = {}
    shards: dict[str, dict[str, Any]] = {f"{index:03d}": {} for index in range(CHART_BUCKETS)}
    session = date.fromisoformat(scan.session_date)
    daily_start = session - timedelta(days=round(5 * 365.25))
    weekly_start = session - timedelta(days=round(20 * 365.25))

    for row in all_rows:
        ticker = str(row.get("ticker") or "").strip().upper()
        providers = _providers(row, settings)
        daily = _read_first(cache, providers, ticker, "daily")
        weekly = _read_first(cache, providers, ticker, "weekly")
        if weekly.empty:
            weekly = _derive_weekly(daily)
        daily_rows = _compact(daily, start=daily_start, end=session)
        weekly_rows = _compact(weekly, start=weekly_start, end=session)
        if not daily_rows:
            continue
        available += 1
        payload = ChartPayloadV1(
            ticker=ticker,
            asOf=scan.session_date,
            priceMode=scan.price_mode,
            daily=daily_rows,
            weekly=weekly_rows,
        )
        bucket = _bucket(ticker)
        shards[bucket][ticker] = wire_dump(payload)
        shards_by_ticker[ticker] = bucket

    shard_records: list[PrivateChartShardV1] = []
    shard_dir = destination / scan.run_id / "shards"
    shard_dir.mkdir(parents=True, exist_ok=True)
    for name, rows in shards.items():
        raw = canonical_json_bytes(rows)
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        if len(compressed) > MAX_SHARD_BYTES:
            raise ValueError(f"private chart shard {name} exceeds 5 MiB")
        filename = f"{name}.json.gz"
        (shard_dir / filename).write_bytes(compressed)
        shard_records.append(
            PrivateChartShardV1(
                name=name,
                sha256=sha256_bytes(compressed),
                bytes=len(compressed),
                tickerCount=len(rows),
            )
        )

    coverage = round(100.0 * available / max(1, requested), 2)
    manifest = PrivateChartManifestV1(
        runId=scan.run_id,
        sessionDate=scan.session_date,
        generatedAt=scan.generated_at,
        priceMode=scan.price_mode,
        requested=requested,
        available=available,
        coveragePct=coverage,
        shards=shard_records,
        shardsByTicker=shards_by_ticker,
    )
    write_json(destination / scan.run_id / "manifest.json", wire_dump(manifest))
    return manifest


def _post_blob(endpoint: str, token: str, payload: dict[str, Any]) -> None:
    request = Request(
        endpoint,
        data=canonical_json_bytes(payload),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "StockScout-EOD/0.1",
        },
        method="POST",
    )
    with urlopen(request, timeout=90) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"chart publish failed with HTTP {response.status}")


def publish_private_chart_staging(
    *,
    staging_dir: str | Path,
    run_id: str,
    endpoint: str,
    audience: str = "stockscout-eod-publish",
) -> PrivateChartManifestV1:
    root = Path(staging_dir).resolve() / run_id
    manifest_path = root / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = PrivateChartManifestV1.model_validate_json(manifest_bytes)
    if manifest.run_id != run_id:
        raise ValueError("private chart manifest runId mismatch")
    token = github_oidc_token(audience)

    for shard in manifest.shards:
        path = root / "shards" / f"{shard.name}.json.gz"
        content = path.read_bytes()
        if len(content) != shard.bytes or sha256_bytes(content) != shard.sha256:
            raise ValueError(f"private chart shard integrity mismatch: {shard.name}")
        _post_blob(
            endpoint,
            token,
            {
                "action": "put_blob",
                "kind": "chart-shard",
                "runId": run_id,
                "shard": shard.name,
                "contentHash": shard.sha256,
                "contentBase64": base64.b64encode(content).decode("ascii"),
            },
        )

    _post_blob(
        endpoint,
        token,
        {
            "action": "put_blob",
            "kind": "chart-manifest",
            "runId": run_id,
            "contentHash": sha256_bytes(manifest_bytes),
            "contentBase64": base64.b64encode(manifest_bytes).decode("ascii"),
        },
    )
    return manifest
