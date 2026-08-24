"""Private GitHub-runner market cache backed by the owner-only Supabase bucket.

Raw provider bars never enter Git, Pages, or an Actions artifact/cache.  The
workflow restores and refreshes these deterministic gzip/tar shards directly
through the OIDC-authenticated publisher.
"""
from __future__ import annotations

import base64
import gzip
import io
import json
import os
import tarfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from stockscout_eod.jsonio import canonical_json_bytes, sha256_bytes, write_json

CACHE_RUN_ID = "rolling-v1"
MAX_REMOTE_SHARD_BYTES = 8_000_000
TARGET_SHARD_BYTES = 6_500_000


@dataclass(frozen=True)
class CacheShard:
    name: str
    sha256: str
    bytes: int
    files: int


def _cache_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and (path.suffix == ".parquet" or path.name.endswith(".meta.json"))
    )


def _archive(root: Path, files: list[Path]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for path in files:
            relative = path.resolve().relative_to(root.resolve()).as_posix()
            data = path.read_bytes()
            info = tarfile.TarInfo(relative)
            info.size = len(data)
            info.mtime = 0
            info.mode = 0o600
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            archive.addfile(info, io.BytesIO(data))
    return gzip.compress(buffer.getvalue(), compresslevel=9, mtime=0)


def _split_archive(root: Path, name: str, files: list[Path]) -> list[tuple[str, bytes, int]]:
    payload = _archive(root, files)
    if len(payload) <= TARGET_SHARD_BYTES:
        return [(name, payload, len(files))]
    if len(files) == 1:
        raise ValueError(f"market cache file cannot fit an 8 MB shard: {files[0].name}")
    midpoint = len(files) // 2
    return [
        *_split_archive(root, f"{name}a", files[:midpoint]),
        *_split_archive(root, f"{name}b", files[midpoint:]),
    ]


def build_market_cache_staging(
    cache_dir: str | Path,
    output_dir: str | Path,
) -> dict[str, Any]:
    root = Path(cache_dir).resolve()
    output = Path(output_dir).resolve()
    if output == root or root in output.parents:
        raise ValueError("market cache staging must be outside the raw cache directory")
    groups: dict[str, list[Path]] = {}
    for path in _cache_files(root):
        relative = path.relative_to(root).as_posix()
        groups.setdefault(sha256_bytes(relative.encode("utf-8"))[:2], []).append(path)

    shard_dir = output / "shards"
    shard_dir.mkdir(parents=True, exist_ok=True)
    shards: list[CacheShard] = []
    for group, files in sorted(groups.items()):
        for name, payload, file_count in _split_archive(root, group, files):
            if not payload or len(payload) > MAX_REMOTE_SHARD_BYTES:
                raise ValueError(f"market cache shard {name} violates remote size limits")
            (shard_dir / f"{name}.bin.gz").write_bytes(payload)
            shards.append(
                CacheShard(
                    name=name,
                    sha256=sha256_bytes(payload),
                    bytes=len(payload),
                    files=file_count,
                )
            )
    manifest = {
        "schemaVersion": "stockscout-eod/market-cache-v1",
        "runId": CACHE_RUN_ID,
        "shards": [shard.__dict__ for shard in shards],
        "fileCount": sum(shard.files for shard in shards),
    }
    write_json(output / "manifest.json", manifest)
    return manifest


def _oidc_token(audience: str = "stockscout-eod-publish") -> str:
    base_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not base_url or not request_token:
        raise RuntimeError("GitHub Actions OIDC environment is unavailable")
    parts = urlsplit(base_url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["audience"] = audience
    request = Request(
        urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)),
        headers={"Authorization": f"Bearer {request_token}"},
    )
    with urlopen(request, timeout=30) as response:
        token = json.loads(response.read().decode("utf-8")).get("value")
    if not token:
        raise RuntimeError("GitHub OIDC response did not contain a token")
    return str(token)


def _post(endpoint: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
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
    try:
        with urlopen(request, timeout=120) as response:
            body = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error")
        except (UnicodeDecodeError, json.JSONDecodeError):
            detail = f"HTTP {exc.code}"
        raise RuntimeError(f"market cache publisher rejected request: {detail}") from exc
    if not body.get("ok"):
        raise RuntimeError(f"market cache publisher rejected request: {body.get('error')}")
    return body.get("data") or {}


def publish_market_cache_staging(
    staging_dir: str | Path,
    endpoint: str,
    *,
    token: str | None = None,
) -> dict[str, Any]:
    root = Path(staging_dir).resolve()
    manifest_bytes = (root / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get("runId") != CACHE_RUN_ID:
        raise ValueError("market cache manifest runId mismatch")
    bearer = token or _oidc_token()
    for shard in manifest.get("shards") or []:
        content = (root / "shards" / f"{shard['name']}.bin.gz").read_bytes()
        if len(content) != shard["bytes"] or sha256_bytes(content) != shard["sha256"]:
            raise ValueError(f"market cache shard integrity mismatch: {shard['name']}")
        _post(
            endpoint,
            bearer,
            {
                "action": "put_blob",
                "kind": "market-cache",
                "runId": CACHE_RUN_ID,
                "shard": shard["name"],
                "contentHash": shard["sha256"],
                "contentBase64": base64.b64encode(content).decode("ascii"),
            },
        )
    compressed_manifest = gzip.compress(manifest_bytes, compresslevel=9, mtime=0)
    _post(
        endpoint,
        bearer,
        {
            "action": "put_blob",
            "kind": "market-cache",
            "runId": CACHE_RUN_ID,
            "shard": "manifest",
            "contentHash": sha256_bytes(compressed_manifest),
            "contentBase64": base64.b64encode(compressed_manifest).decode("ascii"),
        },
    )
    return manifest


def _download_cache_blob(endpoint: str, token: str, shard: str) -> bytes:
    data = _post(
        endpoint,
        token,
        {"action": "get_market_cache", "runId": CACHE_RUN_ID, "shard": shard},
    )
    signed_url = data.get("signedUrl")
    if not isinstance(signed_url, str) or not signed_url.startswith("https://"):
        raise RuntimeError("market cache publisher did not return a signed URL")
    with urlopen(Request(signed_url, headers={"User-Agent": "StockScout-EOD/0.1"}), timeout=120) as response:
        return response.read()


def _extract_archive(payload: bytes, destination: Path) -> int:
    tar_bytes = gzip.decompress(payload)
    count = 0
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or ".." in path.parts:
                raise ValueError("unsafe market cache archive member")
            target = destination.joinpath(*path.parts).resolve()
            if destination.resolve() not in target.parents:
                raise ValueError("market cache archive escaped its destination")
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("market cache archive member has no content")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read())
            count += 1
    return count


def restore_market_cache(
    cache_dir: str | Path,
    endpoint: str,
    *,
    token: str | None = None,
) -> dict[str, Any] | None:
    bearer = token or _oidc_token()
    try:
        manifest = json.loads(gzip.decompress(_download_cache_blob(endpoint, bearer, "manifest")))
    except Exception as exc:  # cold bootstrap is an expected first-run state
        message = str(exc).lower()
        if "not found" in message or "http 404" in message:
            return None
        raise
    if manifest.get("schemaVersion") != "stockscout-eod/market-cache-v1":
        raise ValueError("unsupported market cache manifest")
    destination = Path(cache_dir).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    restored = 0
    for shard in manifest.get("shards") or []:
        payload = _download_cache_blob(endpoint, bearer, str(shard["name"]))
        if len(payload) != shard["bytes"] or sha256_bytes(payload) != shard["sha256"]:
            raise ValueError(f"market cache download integrity mismatch: {shard['name']}")
        restored += _extract_archive(payload, destination)
    if restored != manifest.get("fileCount"):
        raise ValueError("market cache restored file count mismatch")
    return manifest
