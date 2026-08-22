from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from stockscout_eod.legacy_runner import evaluate_ryan_confirmation


def _bars(start: float, end: float, count: int = 260) -> pd.DataFrame:
    close = np.linspace(start, end, count)
    index = pd.bdate_range("2025-08-25", periods=count)
    return pd.DataFrame(
        {
            "Open": close * 0.995,
            "High": close * 1.01,
            "Low": close * 0.99,
            "Close": close,
            "Volume": np.full(count, 1_000_000.0),
        },
        index=index,
    )


def test_ryan_shadow_confirms_an_uptrend_without_ranking_authority() -> None:
    result = evaluate_ryan_confirmation("UP", _bars(50.0, 150.0), provider="fixture")

    assert result["status"] == "CONFIRMED"
    assert result["available"] is True
    assert result["affectsRanking"] is False
    assert result["evidence"]["phase"] == 2
    assert result["evidence"]["templatePasses"] is True


def test_ryan_shadow_marks_a_downtrend_as_risk() -> None:
    result = evaluate_ryan_confirmation("DOWN", _bars(150.0, 50.0))

    assert result["status"] == "RISK"
    assert result["evidence"]["phase"] == 4
    assert result["affectsRanking"] is False


def test_ryan_shadow_refuses_to_guess_without_200_bars() -> None:
    result = evaluate_ryan_confirmation("SHORT", _bars(50.0, 60.0, 199))

    assert result["status"] == "UNAVAILABLE"
    assert result["available"] is False
    assert result["reasons"] == ["INSUFFICIENT_DAILY_BARS"]


def test_production_workflow_runs_shadow_sidecar_but_keeps_it_out_of_pages_artifact() -> None:
    # Use pathlib without importing a workflow parser: the contract here is the
    # explicit CLI handoff and the fact that only frontend/dist is uploaded.
    text = Path(".github/workflows/eod.yml").read_text(encoding="utf-8")
    assert "stockscout_eod legacy-shadow" in text
    assert "--legacy-sidecar .staging/legacy-confirmation.json" in text
    assert "path: frontend/dist" in text
    assert ".staging/legacy-confirmation.json\n        uses: actions/upload" not in text
