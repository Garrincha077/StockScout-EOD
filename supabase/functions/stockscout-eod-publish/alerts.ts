export type JsonRecord = Record<string, unknown>;

export interface AlertCandidate extends JsonRecord {
  document_id?: string;
  ticker?: string;
  source?: string;
  scan_order?: number;
  trade_status?: string | null;
  primary_setup?: string | null;
  risk_level?: string | null;
  scan_price?: number | null;
  entry_risk_pct?: number | null;
  ranking_score?: number | null;
  record?: JsonRecord;
}

export interface OwnerAlert extends JsonRecord {
  id: string;
  name: string;
  ticker?: string | null;
  payload: JsonRecord;
}

export interface AlertEvaluation {
  alertId: string;
  alertName: string;
  kind: string;
  status: "evaluated" | "skipped";
  matches: AlertCandidate[];
  reason?: string;
}

const FIELD_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const TICKER = /^[A-Z0-9._-]{1,20}$/;
const FILTER_OPERATORS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "is_true",
  "is_false",
]);
const GROUP_FILTER_OPERATORS = new Set([
  "gte",
  "lte",
  "gt",
  "lt",
  "eq",
  "neq",
  "between",
  "in",
  "not_in",
  "is_set",
  "is_unset",
  "is_true",
  "is_false",
]);
const TRADE_STATUSES = new Set([
  "entry_ready",
  "trigger_pending",
  "wait_for_retest",
  "not_tradeable",
  "insufficient_data",
]);
const UNSUPPORTED_CHART_KINDS = new Set([
  "chart",
  "drawing",
  "trendline",
  "price",
]);
const SUPPORTED_KINDS = new Set(["ticker", "trade_status", "screen"]);

export const ALERT_EXTRACTED_FIELDS = new Set([
  "ticker",
  "source",
  "_scan_source",
  "scan_order",
  "_scan_order",
  "primary_setup",
  "risk_level",
  "scan_price",
  "trade_status",
  "entry_risk_pct",
  "ranking_score",
  "trade_plan.status",
  "trade_plan.entry_risk_pct",
]);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function candidateField(candidate: AlertCandidate, path: string): unknown {
  if (path === "source" || path === "_scan_source") return candidate.source;
  if (path === "scan_order" || path === "_scan_order") {
    return candidate.scan_order;
  }
  if (path === "trade_plan.status" || path === "trade_status") {
    return candidate.trade_status ??
      nestedField(candidate.record, "trade_plan.status");
  }
  if (
    path === "trade_plan.entry_risk_pct" ||
    path === "entry_risk_pct"
  ) {
    return candidate.entry_risk_pct ??
      nestedField(candidate.record, "trade_plan.entry_risk_pct");
  }
  if (path in candidate && path !== "record") return candidate[path];
  return nestedField(candidate.record, path);
}

function nestedField(record: JsonRecord | undefined, path: string): unknown {
  let value: unknown = record;
  for (const part of path.split(".")) {
    value = asRecord(value)?.[part];
    if (value === undefined) return undefined;
  }
  return value;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("$", "").replaceAll("%", "")
    .replaceAll(",", "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function missingValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" ||
    (typeof value === "number" && !Number.isFinite(value));
}

function validFilter(
  filter: JsonRecord,
  allowedFields: ReadonlySet<string>,
): boolean {
  const field = filter.field;
  const operator = filter.op;
  if (
    typeof field !== "string" ||
    !FIELD_PATH.test(field) ||
    !allowedFields.has(field) ||
    typeof operator !== "string" ||
    !FILTER_OPERATORS.has(operator)
  ) {
    return false;
  }
  if (operator === "is_true" || operator === "is_false") return true;
  if (operator === "in") {
    return Array.isArray(filter.value) &&
      filter.value.length > 0 && filter.value.length <= 100;
  }
  return filter.value !== undefined &&
    (filter.value === null || ["string", "number", "boolean"].includes(
      typeof filter.value,
    ));
}

function matchesFilter(candidate: AlertCandidate, filter: JsonRecord): boolean {
  const value = candidateField(candidate, String(filter.field));
  const operator = String(filter.op);
  if (operator === "is_true") return value === true;
  if (operator === "is_false") return value === false;
  if (operator === "contains") {
    return typeof value === "string" && typeof filter.value === "string" &&
      value.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());
  }
  if (operator === "in") {
    return Array.isArray(filter.value) && filter.value.includes(value);
  }
  if (operator === "eq") return value === filter.value;
  if (operator === "ne") return value !== filter.value;
  const left = finiteNumber(value);
  const right = finiteNumber(filter.value);
  if (left === null || right === null) return false;
  if (operator === "gt") return left > right;
  if (operator === "gte") return left >= right;
  if (operator === "lt") return left < right;
  return left <= right;
}

function validGroupCondition(
  condition: JsonRecord,
  allowedFields: ReadonlySet<string>,
): boolean {
  const field = condition.field;
  const operator = condition.op;
  if (
    typeof field !== "string" || !FIELD_PATH.test(field) ||
    !allowedFields.has(field) || typeof operator !== "string" ||
    !GROUP_FILTER_OPERATORS.has(operator)
  ) {
    return false;
  }
  if (["is_set", "is_unset", "is_true", "is_false"].includes(operator)) {
    return true;
  }
  if (operator === "in" || operator === "not_in") {
    return Array.isArray(condition.values) && condition.values.length > 0 &&
      condition.values.length <= 100;
  }
  if (operator === "between") {
    return (condition.min === undefined ||
      numericValue(condition.min) !== null) &&
      (condition.max === undefined || numericValue(condition.max) !== null) &&
      (condition.min !== undefined || condition.max !== undefined);
  }
  return numericValue(condition.value) !== null;
}

function validateFilterGroup(
  value: unknown,
  allowedFields: ReadonlySet<string>,
  depth = 0,
): { group: JsonRecord; conditionCount: number } | null {
  const group = asRecord(value);
  if (!group || depth > 5 || !["ALL", "ANY"].includes(String(group.logic))) {
    return null;
  }
  const conditions = group.conditions === undefined ? [] : group.conditions;
  const groups = group.groups === undefined ? [] : group.groups;
  if (!Array.isArray(conditions) || !Array.isArray(groups)) return null;
  let conditionCount = conditions.length;
  if (
    conditions.some((condition) => {
      const row = asRecord(condition);
      return !row || !validGroupCondition(row, allowedFields);
    })
  ) {
    return null;
  }
  for (const child of groups) {
    const nested = validateFilterGroup(child, allowedFields, depth + 1);
    if (!nested) return null;
    conditionCount += nested.conditionCount;
  }
  if (conditionCount < 1 || conditionCount > 20) return null;
  return { group, conditionCount };
}

function matchesGroupCondition(
  candidate: AlertCandidate,
  condition: JsonRecord,
): boolean {
  const raw = candidateField(candidate, String(condition.field));
  const operator = String(condition.op);
  if (operator === "is_set") return !missingValue(raw);
  if (operator === "is_unset") return missingValue(raw);
  if (operator === "is_true") return raw === true;
  if (operator === "is_false") return raw === false;
  if (operator === "in" || operator === "not_in") {
    const values = (condition.values as unknown[]).map((value) =>
      String(value).toLocaleLowerCase()
    );
    const hit = !missingValue(raw) &&
      values.includes(String(raw).toLocaleLowerCase());
    return operator === "in" ? hit : !hit;
  }
  const left = numericValue(raw);
  if (left === null) return false;
  if (operator === "between") {
    const minimum = condition.min === undefined
      ? null
      : numericValue(condition.min);
    const maximum = condition.max === undefined
      ? null
      : numericValue(condition.max);
    return (minimum === null || left >= minimum) &&
      (maximum === null || left <= maximum);
  }
  const right = numericValue(condition.value);
  if (right === null) return false;
  if (operator === "gte") return left >= right;
  if (operator === "lte") return left <= right;
  if (operator === "gt") return left > right;
  if (operator === "lt") return left < right;
  if (operator === "eq") return left === right;
  return left !== right;
}

function matchesFilterGroup(
  candidate: AlertCandidate,
  group: JsonRecord,
): boolean {
  const conditions = (group.conditions as unknown[] ?? []).map((condition) =>
    matchesGroupCondition(candidate, asRecord(condition)!)
  );
  const groups = (group.groups as unknown[] ?? []).map((child) =>
    matchesFilterGroup(candidate, asRecord(child)!)
  );
  const results = [...conditions, ...groups];
  return group.logic === "ALL" ? results.every(Boolean) : results.some(Boolean);
}

function skipped(
  alert: OwnerAlert,
  kind: string,
  reason: string,
): AlertEvaluation {
  return {
    alertId: alert.id,
    alertName: alert.name,
    kind,
    status: "skipped",
    matches: [],
    reason,
  };
}

export function evaluateOwnerAlert(
  alert: OwnerAlert,
  candidates: AlertCandidate[],
  allowedFields: ReadonlySet<string>,
): AlertEvaluation {
  const payload = asRecord(alert.payload);
  const declaredKind = payload?.kind ?? payload?._imported_kind;
  const kind = typeof declaredKind === "string" ? declaredKind : "missing";
  if (!payload) return skipped(alert, kind, "payload_must_be_an_object");
  if (UNSUPPORTED_CHART_KINDS.has(kind)) {
    return skipped(alert, kind, "chart_and_drawing_alerts_require_bar_data");
  }
  if (!SUPPORTED_KINDS.has(kind)) {
    return skipped(alert, kind, "unsupported_alert_kind");
  }

  const configuredTicker = String(alert.ticker ?? payload.ticker ?? "")
    .trim().toUpperCase();
  if (configuredTicker && !TICKER.test(configuredTicker)) {
    return skipped(alert, kind, "invalid_ticker");
  }
  let scoped = configuredTicker
    ? candidates.filter((candidate) => candidate.ticker === configuredTicker)
    : candidates;

  if (kind === "ticker") {
    if (!configuredTicker) return skipped(alert, kind, "ticker_is_required");
  } else if (kind === "trade_status") {
    const expected = payload.status ?? payload.trade_status;
    if (typeof expected !== "string" || !TRADE_STATUSES.has(expected)) {
      return skipped(alert, kind, "invalid_trade_status");
    }
    scoped = scoped.filter((candidate) => candidate.trade_status === expected);
  } else {
    if (Array.isArray(payload.filters)) {
      if (payload.filters.length < 1 || payload.filters.length > 20) {
        return skipped(
          alert,
          kind,
          "screen_filters_must_contain_1_to_20_items",
        );
      }
      const filters = payload.filters.map(asRecord);
      if (
        filters.some((filter) => !filter || !validFilter(filter, allowedFields))
      ) {
        return skipped(alert, kind, "invalid_or_non_allowlisted_screen_filter");
      }
      const match = payload.match ?? "all";
      if (match !== "all" && match !== "any") {
        return skipped(alert, kind, "screen_match_must_be_all_or_any");
      }
      const typedFilters = filters as JsonRecord[];
      scoped = scoped.filter((candidate) => {
        const results = typedFilters.map((filter) =>
          matchesFilter(candidate, filter)
        );
        return match === "all" ? results.every(Boolean) : results.some(Boolean);
      });
    } else {
      const validated = validateFilterGroup(payload.filter, allowedFields);
      if (!validated) {
        return skipped(alert, kind, "invalid_or_non_allowlisted_screen_filter");
      }
      scoped = scoped.filter((candidate) =>
        matchesFilterGroup(candidate, validated.group)
      );
    }
  }

  return {
    alertId: alert.id,
    alertName: alert.name,
    kind,
    status: "evaluated",
    matches: scoped,
  };
}

export function alertEventKey(
  runId: string,
  alertId: string,
  ticker: string,
): string {
  return `${runId}:${alertId}:${ticker}`;
}

export function alertEventPayload(
  evaluation: AlertEvaluation,
  candidate: AlertCandidate,
  runId: string,
  scanDate: string,
): JsonRecord {
  return {
    kind: evaluation.kind,
    alert_name: evaluation.alertName,
    run_id: runId,
    scan_date: scanDate,
    prices_are_live: false,
    candidate: {
      document_id: candidate.document_id ?? null,
      ticker: candidate.ticker ?? null,
      source: candidate.source ?? null,
      scan_order: candidate.scan_order ?? null,
      trade_status: candidate.trade_status ?? null,
      primary_setup: candidate.primary_setup ?? null,
      risk_level: candidate.risk_level ?? null,
      scan_price: candidate.scan_price ?? null,
      entry_risk_pct: candidate.entry_risk_pct ?? null,
      ranking_score: candidate.ranking_score ?? null,
    },
  };
}
