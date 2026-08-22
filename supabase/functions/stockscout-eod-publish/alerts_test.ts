import {
  ALERT_EXTRACTED_FIELDS,
  type AlertCandidate,
  alertEventKey,
  alertEventPayload,
  evaluateOwnerAlert,
  type OwnerAlert,
} from "./alerts.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const candidates: AlertCandidate[] = [
  {
    document_id: "scan:eod-1:candidate:AAA",
    ticker: "AAA",
    source: "candidate",
    scan_order: 1,
    trade_status: "entry_ready",
    entry_risk_pct: 8.2,
    record: {
      setups: { rwb_squeeze_thrust: { triggered: true, width_pct: 2.5 } },
    },
  },
  {
    document_id: "scan:eod-1:candidate:BBB",
    ticker: "BBB",
    source: "excluded",
    scan_order: 2,
    trade_status: "trigger_pending",
    entry_risk_pct: 12,
    record: {
      setups: { rwb_squeeze_thrust: { triggered: false, width_pct: 7.5 } },
    },
  },
];

const allowed = new Set([
  ...ALERT_EXTRACTED_FIELDS,
  "setups.rwb_squeeze_thrust.triggered",
  "setups.rwb_squeeze_thrust.width_pct",
]);

function alert(
  payload: Record<string, unknown>,
  ticker: string | null = null,
): OwnerAlert {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "contract alert",
    ticker,
    payload,
  };
}

Deno.test("ticker and trade-status alerts use only the active candidate rows", () => {
  const ticker = evaluateOwnerAlert(
    alert({ kind: "ticker" }, "AAA"),
    candidates,
    allowed,
  );
  assert(ticker.status === "evaluated", "ticker alert should be evaluated");
  assert(
    ticker.matches.length === 1 && ticker.matches[0]?.ticker === "AAA",
    "ticker mismatch",
  );

  const status = evaluateOwnerAlert(
    alert({ kind: "trade_status", status: "entry_ready" }),
    candidates,
    allowed,
  );
  assert(
    status.status === "evaluated",
    "trade-status alert should be evaluated",
  );
  assert(
    status.matches.length === 1 && status.matches[0]?.ticker === "AAA",
    "status mismatch",
  );
});

Deno.test("screen alerts evaluate allowlisted nested scalar filters", () => {
  const evaluation = evaluateOwnerAlert(
    alert({
      kind: "screen",
      match: "all",
      filters: [
        { field: "setups.rwb_squeeze_thrust.triggered", op: "is_true" },
        { field: "setups.rwb_squeeze_thrust.width_pct", op: "lte", value: 3 },
        { field: "trade_plan.entry_risk_pct", op: "lte", value: 10 },
      ],
    }),
    candidates,
    allowed,
  );
  assert(evaluation.status === "evaluated", "screen alert should be evaluated");
  assert(
    evaluation.matches.length === 1 && evaluation.matches[0]?.ticker === "AAA",
    "screen mismatch",
  );
});

Deno.test("migrated screen alerts retain the established nested group contract", () => {
  const evaluation = evaluateOwnerAlert(
    alert({
      _imported_kind: "screen",
      filter: {
        logic: "ALL",
        conditions: [
          {
            field: "trade_plan.entry_risk_pct",
            op: "between",
            min: 5,
            max: 10,
          },
          {
            field: "trade_plan.status",
            op: "in",
            values: ["entry_ready"],
          },
        ],
        groups: [],
      },
    }),
    candidates,
    allowed,
  );
  assert(
    evaluation.status === "evaluated",
    "migrated screen should be evaluated",
  );
  assert(
    evaluation.matches.length === 1 && evaluation.matches[0]?.ticker === "AAA",
    "migrated screen mismatch",
  );
});

Deno.test("unknown paths and chart/drawing kinds are explicitly skipped", () => {
  const invalid = evaluateOwnerAlert(
    alert({
      kind: "screen",
      filters: [{ field: "record.private_token", op: "contains", value: "x" }],
    }),
    candidates,
    allowed,
  );
  assert(invalid.status === "skipped", "unknown field should be skipped");
  assert(
    invalid.reason === "invalid_or_non_allowlisted_screen_filter",
    "wrong field reason",
  );

  for (const kind of ["chart", "drawing", "trendline", "price"]) {
    const unsupported = evaluateOwnerAlert(
      alert({ kind }),
      candidates,
      allowed,
    );
    assert(unsupported.status === "skipped", `${kind} should be skipped`);
    assert(
      unsupported.reason === "chart_and_drawing_alerts_require_bar_data",
      `${kind} should explain the missing bar-data evaluator`,
    );
  }
});

Deno.test("alert events have a deterministic per-run alert+ticker key", () => {
  const evaluation = evaluateOwnerAlert(
    alert({ kind: "ticker" }, "AAA"),
    candidates,
    allowed,
  );
  const key = alertEventKey("eod-1", evaluation.alertId, "AAA");
  assert(
    key === "eod-1:11111111-1111-4111-8111-111111111111:AAA",
    "event key is not deterministic",
  );
  const payload = alertEventPayload(
    evaluation,
    candidates[0]!,
    "eod-1",
    "2026-08-21",
  );
  assert(
    payload.prices_are_live === false,
    "event must state that prices are not live",
  );
  assert(
    (payload.candidate as Record<string, unknown>).ticker === "AAA",
    "event candidate mismatch",
  );
});
