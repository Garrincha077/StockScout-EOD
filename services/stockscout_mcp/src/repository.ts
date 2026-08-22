import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  JsonRecord,
  PreviewRequestResult,
  Side,
  StageRequestResult,
  StructuralStatus,
  ScanFilter,
  ScanSort,
} from "./contracts.js";
import {
  assertAllowedFields,
  jsonFieldExpression,
  postgrestOperator,
  scalarKind,
  type ScalarKind,
} from "./eodScanPatch.js";

export interface StockScoutRepository {
  searchFullScan(query: string, limit: number): Promise<JsonRecord[]>;
  fetchFullScan(documentId: string): Promise<JsonRecord | null>;
  describeFullScanFields(query?: string): Promise<JsonRecord[]>;
  screenFullScan(filters: ScanFilter[], sorts: ScanSort[], limit: number): Promise<JsonRecord[]>;
  getScanStatus(sessionDate?: string): Promise<JsonRecord | null>;
  listVolumeEvents(side: Side, limit: number): Promise<JsonRecord[]>;
  listWatch(
    side: Side,
    structuralStatus: StructuralStatus | undefined,
    qualifiedOnly: boolean,
    limit: number,
  ): Promise<JsonRecord[]>;
  listActionable(side: Side, limit: number): Promise<JsonRecord[]>;
  explainCandidate(proposalId: number): Promise<JsonRecord | null>;
  createRiskPreviewRequest(
    proposalIds: number[],
    riskUsdByProposal: Record<string, number>,
  ): Promise<PreviewRequestResult>;
  getRiskPreview(previewId: number): Promise<JsonRecord | null>;
  requestStageUntransmitted(
    previewId: number,
    selectedProposalIds: number[],
    idempotencyKey: string,
  ): Promise<StageRequestResult>;
  getStagedBatch(batchId: number): Promise<JsonRecord | null>;
  getStagedBatchByStageRequest(stageRequestId: number): Promise<JsonRecord | null>;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? (value as JsonRecord[]) : [];
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function isoAfterMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

const FIELD_QUERY_ALIASES = ["preferred breakout", "research fit", "recovery reclaim", "tight efficient", "fresh momentum"];

const EXTRACTED_FIELDS: Record<string, string> = {
  ticker: "ticker",
  _scan_source: "source",
  _scan_order: "scan_order",
  primary_setup: "primary_setup",
  risk_level: "risk_level",
  scan_price: "scan_price",
  "trade_plan.status": "trade_status",
  "trade_plan.entry_risk_pct": "entry_risk_pct",
};

const EXTRACTED_FIELD_KINDS: Record<string, ScalarKind> = {
  ticker: "text",
  _scan_source: "text",
  _scan_order: "number",
  primary_setup: "text",
  risk_level: "text",
  scan_price: "number",
  "trade_plan.status": "text",
  "trade_plan.entry_risk_pct": "number",
};

function databaseField(path: string, kind: ScalarKind): string {
  return EXTRACTED_FIELDS[path] ?? jsonFieldExpression(path, kind);
}

export class SupabaseStockScoutRepository implements StockScoutRepository {
  constructor(
    private readonly database: SupabaseClient,
    private readonly userId: string,
  ) {}

  async searchFullScan(query: string, limit: number): Promise<JsonRecord[]> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("full_scan_candidates")
      .select("document_id,ticker,source,scan_order,trade_status,primary_setup,risk_level,run_id,scan_date")
      .eq("owner_id", this.userId)
      .textSearch("search_document", query, { config: "simple", type: "websearch" })
      .order("scan_order", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`search failed: ${error.message}`);
    return records(data);
  }

  async fetchFullScan(documentId: string): Promise<JsonRecord | null> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("full_scan_candidates")
      .select("*")
      .eq("owner_id", this.userId)
      .eq("document_id", documentId)
      .maybeSingle();
    if (error) throw new Error(`fetch failed: ${error.message}`);
    return record(data);
  }

  async describeFullScanFields(query = ""): Promise<JsonRecord[]> {
    let request = this.database
      .schema("stockscout_api")
      .from("full_scan_fields")
      .select("run_id,field_path,scalar_types,populated_count,example")
      .eq("owner_id", this.userId)
      .order("populated_count", { ascending: false })
      .limit(100);
    const normalized = query.toLowerCase().replaceAll("/", " ").trim();
    const fieldQuery = FIELD_QUERY_ALIASES.some((alias) => normalized.includes(alias))
      ? "ma_cluster_research"
      : query.trim();
    if (fieldQuery) request = request.ilike("field_path", `%${fieldQuery}%`);
    const { data, error } = await request;
    if (error) throw new Error(`describe_scan_fields failed: ${error.message}`);
    return records(data);
  }

  async screenFullScan(filters: ScanFilter[], sorts: ScanSort[], limit: number): Promise<JsonRecord[]> {
    const { data: fieldRows, error: fieldError } = await this.database
      .schema("stockscout_api")
      .from("full_scan_fields")
      .select("field_path,scalar_types")
      .eq("owner_id", this.userId)
      .limit(1000);
    if (fieldError) throw new Error(`screen_scan field lookup failed: ${fieldError.message}`);
    const allowedKinds = new Map<string, ScalarKind>(Object.entries(EXTRACTED_FIELD_KINDS));
    for (const item of records(fieldRows)) {
      allowedKinds.set(String(item.field_path), scalarKind(item.scalar_types));
    }
    assertAllowedFields([...filters, ...sorts], allowedKinds);
    let request = this.database
      .schema("stockscout_api")
      .from("full_scan_candidates")
      .select("document_id,ticker,source,scan_order,trade_status,primary_setup,risk_level,scan_price,entry_risk_pct,record,run_id,scan_date")
      .eq("owner_id", this.userId);
    for (const item of filters) {
      const kind = allowedKinds.get(item.field) ?? "unknown";
      const field = databaseField(item.field, item.op === "contains" ? "text" : kind);
      if (item.op === "in") {
        if (!Array.isArray(item.value) || item.value.length < 1 || item.value.length > 1000) {
          throw new Error("The in operator requires an array with 1 to 1000 values");
        }
        request = request.in(field, item.value);
      } else if (item.op === "contains") {
        if (kind !== "text") throw new Error("The contains operator requires a text field");
        request = request.ilike(field, `%${String(item.value ?? "")}%`);
      } else if (item.op === "is_true" || item.op === "is_false") {
        if (kind !== "boolean") throw new Error(`${item.op} requires a boolean field`);
        request = request.eq(field, item.op === "is_true");
      } else {
        if (item.value === undefined) throw new Error(`${item.op} requires a value`);
        request = request.filter(field, postgrestOperator(item.op), item.value);
      }
    }
    if (sorts.length) {
      for (const item of sorts) {
        request = request.order(
          databaseField(item.field, allowedKinds.get(item.field) ?? "unknown"), {
          ascending: item.direction === "asc",
          nullsFirst: false,
          },
        );
      }
    } else {
      request = request.order("source", { ascending: true }).order("scan_order", { ascending: true });
    }
    const { data, error } = await request.limit(limit);
    if (error) throw new Error(`screen_scan failed: ${error.message}`);
    return records(data);
  }

  async getScanStatus(sessionDate?: string): Promise<JsonRecord | null> {
    let query = this.database
      .schema("stockscout_api")
      .from("scan_status")
      .select("*")
      .eq("owner_id", this.userId)
      .order("session_date", { ascending: false })
      .order("completed_at", { ascending: false, nullsFirst: false })
      .order("scan_run_id", { ascending: false })
      .limit(1);
    if (sessionDate) {
      query = query.eq("session_date", sessionDate);
    }
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(`get_scan_status failed: ${error.message}`);
    return record(data);
  }

  async listVolumeEvents(side: Side, limit: number): Promise<JsonRecord[]> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("volume_events")
      .select("*")
      .eq("owner_id", this.userId)
      .eq("side", side)
      .order("event_date", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`list_volume_events failed: ${error.message}`);
    return records(data);
  }

  async listWatch(
    side: Side,
    structuralStatus: StructuralStatus | undefined,
    qualifiedOnly: boolean,
    limit: number,
  ): Promise<JsonRecord[]> {
    let query = this.database
      .schema("stockscout_api")
      .from("watch")
      .select("*")
      .eq("owner_id", this.userId)
      .eq("side", side)
      .order("structural_watch_score", { ascending: false })
      .limit(limit);
    if (structuralStatus) {
      query = query.eq("structural_status", structuralStatus);
    }
    if (qualifiedOnly) {
      query = query.eq("watch_qualified", true);
    }
    const { data, error } = await query;
    if (error) throw new Error(`list_watch failed: ${error.message}`);
    return records(data);
  }

  async listActionable(side: Side, limit: number): Promise<JsonRecord[]> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("actionable")
      .select("*")
      .eq("owner_id", this.userId)
      .eq("side", side)
      .order("proposal_eligible", { ascending: false })
      .order("trade_score", { ascending: false })
      .limit(Math.min(limit, 3));
    if (error) throw new Error(`list_actionable failed: ${error.message}`);
    return records(data);
  }

  async explainCandidate(proposalId: number): Promise<JsonRecord | null> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("actionable")
      .select("*")
      .eq("owner_id", this.userId)
      .eq("proposal_id", proposalId)
      .maybeSingle();
    if (error) throw new Error(`explain_candidate failed: ${error.message}`);
    return record(data);
  }

  async createRiskPreviewRequest(
    proposalIds: number[],
    riskUsdByProposal: Record<string, number>,
  ): Promise<PreviewRequestResult> {
    const selected = unique(proposalIds);
    if (
      selected.length < 1 ||
      selected.length > 3 ||
      selected.length !== proposalIds.length
    ) {
      throw new Error("Select between one and three unique proposals");
    }
    if (
      Object.keys(riskUsdByProposal).length !== selected.length ||
      selected.some((id) => !(id in riskUsdByProposal))
    ) {
      throw new Error("risk_usd_by_proposal must exactly match proposal_ids");
    }

    const { data: proposals, error: proposalError } = await this.database
      .schema("stockscout_api")
      .from("actionable")
      .select("proposal_id")
      .eq("owner_id", this.userId)
      .in("proposal_id", selected);
    if (proposalError) {
      throw new Error(`proposal authorization failed: ${proposalError.message}`);
    }
    if (records(proposals).length !== selected.length) {
      throw new Error("One or more proposals are missing, stale, or not owned by the user");
    }

    const expiresAt = isoAfterMinutes(10);
    const { data, error } = await this.database
      .schema("stockscout_api")
      .rpc("create_preview_request", {
        p_proposal_ids: selected,
        p_risk_usd_by_proposal: riskUsdByProposal,
      });
    if (error) throw new Error(`create_risk_preview failed: ${error.message}`);
    return {
      preview_request_id: Number(data),
      status: "requested",
      expires_at: expiresAt,
      poll_after_seconds: 2,
    };
  }

  async getRiskPreview(previewId: number): Promise<JsonRecord | null> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("risk_previews")
      .select("*")
      .eq("owner_id", this.userId)
      .eq("preview_id", previewId)
      .maybeSingle();
    if (error) throw new Error(`get_risk_preview failed: ${error.message}`);
    return record(data);
  }

  private previewProposalIds(preview: JsonRecord): number[] {
    if (Array.isArray(preview.proposal_ids)) {
      return preview.proposal_ids.map(Number);
    }
    const payload = record(preview.preview_payload);
    const items = payload?.items;
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => record(item))
      .map((item) => Number(record(item?.proposal)?.proposal_id))
      .filter((value): value is number => Number.isSafeInteger(value) && value > 0);
  }

  async requestStageUntransmitted(
    previewId: number,
    selectedProposalIds: number[],
    idempotencyKey: string,
  ): Promise<StageRequestResult> {
    const selected = unique(selectedProposalIds);
    if (
      selected.length < 1 ||
      selected.length > 2 ||
      selected.length !== selectedProposalIds.length
    ) {
      throw new Error("Select one or two unique preview proposals");
    }

    const preview = await this.getRiskPreview(previewId);
    if (!preview) throw new Error("Risk preview was not found");
    if (preview.status !== "ready") throw new Error("Risk preview is not ready");
    if (
      typeof preview.expires_at !== "string" ||
      Date.parse(preview.expires_at) <= Date.now()
    ) {
      throw new Error("Risk preview has expired");
    }
    if (
      typeof preview.preview_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(preview.preview_hash)
    ) {
      throw new Error("Risk preview has no valid immutable hash");
    }
    const allowed = new Set(this.previewProposalIds(preview));
    if (selected.some((proposalId) => !allowed.has(proposalId))) {
      throw new Error("Selection is not a subset of the immutable risk preview");
    }

    const { data, error } = await this.database
      .schema("stockscout_api")
      .rpc("request_stage_untransmitted_state", {
        p_risk_preview_id: Number(preview.risk_preview_id),
        p_selected_proposal_ids: selected,
        p_idempotency_key: idempotencyKey,
      })
      ;
    if (error) throw new Error(`request_stage_untransmitted failed: ${error.message}`);
    const persisted = record(data);
    if (
      !persisted ||
      !Number.isSafeInteger(Number(persisted.stage_request_id)) ||
      typeof persisted.expires_at !== "string" ||
      typeof persisted.status !== "string"
    ) {
      throw new Error("staging RPC returned an invalid durable state");
    }
    return {
      stage_request_id: Number(persisted.stage_request_id),
      status: String(persisted.status),
      expires_at: persisted.expires_at,
      idempotency_key: String(persisted.idempotency_key),
    };
  }

  async getStagedBatch(batchId: number): Promise<JsonRecord | null> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("staged_batches")
      .select("*")
      .eq("owner_id", this.userId)
      .eq("batch_id", batchId)
      .maybeSingle();
    if (error) throw new Error(`get_staged_batch failed: ${error.message}`);
    return record(data);
  }

  async getStagedBatchByStageRequest(
    stageRequestId: number,
  ): Promise<JsonRecord | null> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("staged_batches")
      .select("*")
      .eq("owner_id", this.userId)
      .eq("stage_request_id", stageRequestId)
      .maybeSingle();
    if (error) {
      throw new Error(`get_staged_batch failed: ${error.message}`);
    }
    return record(data);
  }
}
