from __future__ import annotations

from pathlib import Path

from stockscout_eod.deployment import verify_pages_activation
from stockscout_eod.jsonio import write_json


def test_pages_activation_retries_old_pointer_then_matches_exact_hash(tmp_path) -> None:
    public = tmp_path / "public"
    current = {"runId": "new-run", "status": "healthy"}
    current_bytes = write_json(public / "data" / "manifest.json", current)
    responses = iter([b'{"runId":"old-run"}', current_bytes])
    sleeps: list[float] = []
    result = verify_pages_activation(
        public_dir=public,
        manifest_url="https://example.test/data/manifest.json",
        fetcher=lambda _url: next(responses),
        sleeper=sleeps.append,
    )
    assert result["runId"] == "new-run"
    assert result["attempt"] == 2
    assert sleeps == [2.0]


def test_pages_shell_repair_preserves_snapshot_and_has_no_outward_workflow() -> None:
    workflow = Path(".github/workflows/pages-shell.yml").read_text(encoding="utf-8")
    assert "source_run_id" in workflow
    assert "actions/download-artifact" in workflow
    assert "source artifact is not the currently active Pages snapshot" in workflow
    assert "sha256sum frontend/dist/data/manifest.json" in workflow
    assert 'grep -q \'/StockScout-EOD/assets/\'' in workflow
    assert "stockscout_eod scan" not in workflow
    assert "publish-cloud" not in workflow
    assert "notify-telegram" not in workflow
