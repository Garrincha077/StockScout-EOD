from __future__ import annotations

import io
import tarfile

import pytest

import stockscout_eod.market_cache as market_cache
from stockscout_eod.market_cache import (
    _extract_archive,
    build_market_cache_staging,
    restore_market_cache,
)


def test_market_cache_round_trip_is_private_sharded_and_deterministic(tmp_path) -> None:
    cache = tmp_path / "cache"
    (cache / "yfinance" / "daily").mkdir(parents=True)
    (cache / "yfinance" / "daily" / "AAA.parquet").write_bytes(b"derived-test-bars")
    (cache / "yfinance" / "daily" / "AAA.meta.json").write_text("{}")
    first = tmp_path / "first"
    second = tmp_path / "second"
    manifest = build_market_cache_staging(cache, first)
    repeated = build_market_cache_staging(cache, second)
    assert manifest == repeated
    assert manifest["fileCount"] == 2
    assert not any(path.suffix == ".parquet" for path in first.rglob("*"))
    restored = tmp_path / "restored"
    count = 0
    for shard in manifest["shards"]:
        count += _extract_archive(
            (first / "shards" / f"{shard['name']}.bin.gz").read_bytes(), restored
        )
    assert count == 2
    assert (restored / "yfinance" / "daily" / "AAA.parquet").read_bytes() == b"derived-test-bars"


def test_market_cache_archive_rejects_path_traversal(tmp_path) -> None:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as archive:
        info = tarfile.TarInfo("../secret")
        info.size = 1
        archive.addfile(info, io.BytesIO(b"x"))
    import gzip

    with pytest.raises(ValueError, match="unsafe"):
        _extract_archive(gzip.compress(raw.getvalue()), tmp_path / "restore")


def test_market_cache_restore_allows_only_a_real_cold_bootstrap(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def missing(*_args: object, **_kwargs: object) -> bytes:
        raise RuntimeError("market cache lookup failed: Object not found")

    monkeypatch.setattr(market_cache, "_download_cache_blob", missing)
    assert restore_market_cache(tmp_path / "cache", "https://publisher.invalid", token="oidc") is None


def test_market_cache_restore_does_not_hide_authorization_or_service_failures(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def denied(*_args: object, **_kwargs: object) -> bytes:
        raise RuntimeError("market cache lookup failed: permission denied")

    monkeypatch.setattr(market_cache, "_download_cache_blob", denied)
    with pytest.raises(RuntimeError, match="permission denied"):
        restore_market_cache(tmp_path / "cache", "https://publisher.invalid", token="oidc")
