export const TOOL_NAMES = [
  "get_scan_status",
  "list_volume_events",
  "list_watch",
  "list_actionable",
  "explain_candidate",
  "create_risk_preview",
  "get_risk_preview",
  "request_stage_untransmitted",
  "get_staged_batch",
  "search",
  "fetch",
  "describe_scan_fields",
  "screen_scan",
  "list_scans",
  "compare_scans",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type Side = "long" | "short";

export const STRUCTURAL_STATUSES = [
  "dormant_base",
  "early_accumulation",
  "volume_awakening",
  "base_improving",
  "high_priority_watch",
  "failed_structure",
  "topping_base",
  "early_distribution",
  "volume_breakdown",
  "weak_rally_watch",
  "high_priority_short",
  "failed_short_thesis",
] as const;

export type StructuralStatus = (typeof STRUCTURAL_STATUSES)[number];

export type JsonRecord = Record<string, unknown>;

export const SCAN_FILTER_OPERATORS = [
  "eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "is_true", "is_false",
] as const;
export type ScanFilterOperator = (typeof SCAN_FILTER_OPERATORS)[number];
export interface ScanFilter {
  field: string;
  op: ScanFilterOperator;
  value?: unknown;
}
export interface ScanSort {
  field: string;
  direction: "asc" | "desc";
}

export interface PreviewRequestResult {
  preview_request_id: number;
  status: string;
  expires_at: string;
  poll_after_seconds: number;
}

export interface StageRequestResult {
  stage_request_id: number;
  status: string;
  expires_at: string;
  idempotency_key: string;
}
