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
  compareHistoryRows,
  scalarKind,
  type EodHistoryAccess,
  type ScalarKind,
} from "./eodScanPatch.js";
import type { StockScoutRepository } from "./repository.js";

export interface InMemorySeed {
  scanStatus?: JsonRecord[];
  volumeEvents?: JsonRecord[];
  watch?: JsonRecord[];
  actionable?: JsonRecord[];
  riskPreviews?: JsonRecord[];
  stagedBatches?: JsonRecord[];
  fullScan?: JsonRecord[];
  scanFields?: JsonRecord[];
  scanHistory?: JsonRecord[];
  candidateHistory?: Record<string, JsonRecord[]>;
}

function matchingSide(record: JsonRecord, side: Side): boolean {
  return record.side === side;
}

const IN_MEMORY_EXTRACTED_KINDS: Record<string, ScalarKind> = {
  ticker: "text",
  _scan_source: "text",
  _scan_order: "number",
  primary_setup: "text",
  risk_level: "text",
  scan_price: "number",
  "trade_plan.status": "text",
  "trade_plan.entry_risk_pct": "number",
};

function scanValue(row: JsonRecord, path: string): unknown {
  if (path === "_scan_source") return row.source;
  if (path === "_scan_order") return row.scan_order;
  if (path === "trade_plan.status" && row.trade_status !== undefined) return row.trade_status;
  if (path === "trade_plan.entry_risk_pct" && row.entry_risk_pct !== undefined) {
    return row.entry_risk_pct;
  }
  if (path in row) return row[path];
  let value: unknown = row.record && typeof row.record === "object" ? row.record : row;
  for (const part of path.split(".")) {
    value = value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonRecord)[part]
      : undefined;
  }
  return value;
}

function filterMatches(value: unknown, filter: ScanFilter): boolean {
  if (filter.op === "is_true") return value === true;
  if (filter.op === "is_false") return value === false;
  if (filter.op === "contains") {
    return String(value ?? "").toLowerCase().includes(String(filter.value ?? "").toLowerCase());
  }
  if (filter.op === "in") return Array.isArray(filter.value) && filter.value.includes(value);
  if (filter.op === "eq") return value === filter.value;
  if (filter.op === "ne") return value !== filter.value;
  const left = Number(value);
  const right = Number(filter.value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (filter.op === "gt") return left > right;
  if (filter.op === "gte") return left >= right;
  if (filter.op === "lt") return left < right;
  return left <= right;
}

/**
 * Small deterministic adapter for MCP contract tests and local Inspector use.
 * It deliberately models queue creation only; it has no broker capability.
 */
export class InMemoryStockScoutRepository
  implements StockScoutRepository, EodHistoryAccess {
  private nextId = 1;
  private readonly previewRequests: JsonRecord[] = [];
  private readonly stageRequests: JsonRecord[] = [];

  constructor(private readonly seed: InMemorySeed = {}) {}

  async searchFullScan(query: string, limit: number): Promise<JsonRecord[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (this.seed.fullScan ?? [])
      .filter((item) => terms.some((term) => JSON.stringify(item).toLowerCase().includes(term)))
      .slice(0, limit);
  }

  async fetchFullScan(documentId: string): Promise<JsonRecord | null> {
    return (this.seed.fullScan ?? []).find((item) => item.document_id === documentId) ?? null;
  }

  async describeFullScanFields(query = ""): Promise<JsonRecord[]> {
    return (this.seed.scanFields ?? []).filter((item) =>
      !query || String(item.field_path).toLowerCase().includes(query.toLowerCase()));
  }

  async screenFullScan(filters: ScanFilter[], sorts: ScanSort[], limit: number): Promise<JsonRecord[]> {
    const allowedKinds = new Map<string, ScalarKind>(Object.entries(IN_MEMORY_EXTRACTED_KINDS));
    for (const field of this.seed.scanFields ?? []) {
      allowedKinds.set(String(field.field_path), scalarKind(field.scalar_types));
    }
    assertAllowedFields([...filters, ...sorts], allowedKinds);
    const rows = [...(this.seed.fullScan ?? [])].filter((row) =>
      filters.every((filter) => filterMatches(scanValue(row, filter.field), filter)));
    if (sorts.length > 0) {
      rows.sort((left, right) => {
        for (const sort of sorts) {
          const before = scanValue(left, sort.field);
          const after = scanValue(right, sort.field);
          if (before === after) continue;
          if (before === null || before === undefined) return 1;
          if (after === null || after === undefined) return -1;
          const comparison = typeof before === "number" && typeof after === "number"
            ? before - after
            : String(before).localeCompare(String(after));
          if (comparison !== 0) return sort.direction === "asc" ? comparison : -comparison;
        }
        return 0;
      });
    }
    return rows.slice(0, limit);
  }

  async listEodScans(limit: number): Promise<JsonRecord[]> {
    return (this.seed.scanHistory ?? []).slice(0, limit);
  }

  async compareEodScans(
    baseRunId: string,
    comparisonRunId: string,
    ticker: string | undefined,
    limit: number,
  ): Promise<JsonRecord> {
    if (baseRunId === comparisonRunId) throw new Error("Scan ids must be different");
    const base = (this.seed.scanHistory ?? []).find((row) => row.run_id === baseRunId);
    const comparison = (this.seed.scanHistory ?? []).find(
      (row) => row.run_id === comparisonRunId,
    );
    if (!base || !comparison) {
      return {
        base_run_id: baseRunId,
        comparison_run_id: comparisonRunId,
        status: "insufficient_history",
        prices_are_live: false,
        changes: [],
      };
    }
    const filterTicker = (rows: JsonRecord[]) => ticker
      ? rows.filter((row) => row.ticker === ticker)
      : rows;
    const allChanges = compareHistoryRows(
      filterTicker(this.seed.candidateHistory?.[baseRunId] ?? []),
      filterTicker(this.seed.candidateHistory?.[comparisonRunId] ?? []),
    );
    return {
      base_run_id: baseRunId,
      base_scan: { ...base, prices_are_live: false },
      comparison_run_id: comparisonRunId,
      comparison_scan: { ...comparison, prices_are_live: false },
      status: "ok",
      prices_are_live: false,
      change_count: allChanges.length,
      truncated: allChanges.length > limit,
      changes: allChanges.slice(0, limit),
    };
  }

  async getScanStatus(sessionDate?: string): Promise<JsonRecord | null> {
    return (
      (this.seed.scanStatus ?? []).find(
        (item) => !sessionDate || item.session_date === sessionDate,
      ) ?? null
    );
  }

  async listVolumeEvents(side: Side, limit: number): Promise<JsonRecord[]> {
    return (this.seed.volumeEvents ?? []).filter((item) => matchingSide(item, side)).slice(0, limit);
  }

  async listWatch(
    side: Side,
    structuralStatus: StructuralStatus | undefined,
    qualifiedOnly: boolean,
    limit: number,
  ): Promise<JsonRecord[]> {
    return (this.seed.watch ?? [])
      .filter(
        (item) =>
          matchingSide(item, side) &&
          (!structuralStatus || item.structural_status === structuralStatus) &&
          (!qualifiedOnly || item.watch_qualified === true),
      )
      .slice(0, limit);
  }

  async listActionable(side: Side, limit: number): Promise<JsonRecord[]> {
    return (this.seed.actionable ?? [])
      .filter((item) => matchingSide(item, side))
      .slice(0, Math.min(limit, 3));
  }

  async explainCandidate(proposalId: number): Promise<JsonRecord | null> {
    return (
      (this.seed.actionable ?? []).find(
        (item) => Number(item.proposal_id) === proposalId,
      ) ?? null
    );
  }

  async createRiskPreviewRequest(
    proposalIds: number[],
    riskUsdByProposal: Record<string, number>,
  ): Promise<PreviewRequestResult> {
    const id = this.nextId++;
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.previewRequests.push({
      id,
      proposal_ids: [...proposalIds],
      risk_usd_by_proposal: { ...riskUsdByProposal },
      status: "pending",
      expires_at: expiresAt,
    });
    return {
      preview_request_id: id,
      status: "requested",
      expires_at: expiresAt,
      poll_after_seconds: 2,
    };
  }

  async getRiskPreview(previewId: number): Promise<JsonRecord | null> {
    return (
      (this.seed.riskPreviews ?? []).find(
        (item) =>
          Number(item.preview_id ?? item.id) === previewId,
      ) ??
      null
    );
  }

  async requestStageUntransmitted(
    previewId: number,
    selectedProposalIds: number[],
    idempotencyKey: string,
  ): Promise<StageRequestResult> {
    if (selectedProposalIds.length < 1 || selectedProposalIds.length > 2) {
      throw new Error("Select one or two preview proposals");
    }
    const existing = this.stageRequests.find(
      (item) => item.idempotency_key === idempotencyKey,
    );
    if (existing) {
      if (
        Number(existing.preview_id) !== previewId ||
        JSON.stringify(existing.selected_proposal_ids) !==
          JSON.stringify(selectedProposalIds)
      ) {
        throw new Error("idempotency key collision");
      }
      return {
        stage_request_id: Number(existing.id),
        status: String(existing.status),
        expires_at: String(existing.expires_at),
        idempotency_key: String(existing.idempotency_key),
      };
    }
    if (
      this.stageRequests.some((item) => Number(item.preview_id) === previewId)
    ) {
      throw new Error(
        "preview already has a staging request; create a new preview",
      );
    }
    const id = this.nextId++;
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.stageRequests.push({
      id,
      preview_id: previewId,
      selected_proposal_ids: [...selectedProposalIds],
      idempotency_key: idempotencyKey,
      status: "pending",
      expires_at: expiresAt,
    });
    return {
      stage_request_id: id,
      status: "pending",
      expires_at: expiresAt,
      idempotency_key: idempotencyKey,
    };
  }

  async getStagedBatch(batchId: number): Promise<JsonRecord | null> {
    return (
      (this.seed.stagedBatches ?? []).find(
        (item) => Number(item.batch_id ?? item.id) === batchId,
      ) ??
      null
    );
  }

  async getStagedBatchByStageRequest(
    stageRequestId: number,
  ): Promise<JsonRecord | null> {
    return (
      (this.seed.stagedBatches ?? []).find(
        (item) => Number(item.stage_request_id) === stageRequestId,
      ) ?? null
    );
  }
}
