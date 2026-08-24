import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export type JsonRecord = Record<string, unknown>;

export const SCAN_FILTER_OPERATORS = [
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
] as const;

export interface ScanFilter {
  field: string;
  op: (typeof SCAN_FILTER_OPERATORS)[number];
  value?: unknown;
}

export interface ScanSort {
  field: string;
  direction: "asc" | "desc";
}

export interface LegacyScanAccess {
  searchFullScan(query: string, limit: number): Promise<JsonRecord[]>;
  fetchFullScan(documentId: string): Promise<JsonRecord | null>;
  describeFullScanFields(query?: string): Promise<JsonRecord[]>;
  screenFullScan(
    filters: ScanFilter[],
    sorts: ScanSort[],
    limit: number,
  ): Promise<JsonRecord[]>;
}

export interface EodHistoryAccess {
  listEodScans(limit: number): Promise<JsonRecord[]>;
  compareEodScans(
    baseRunId: string,
    comparisonRunId: string,
    ticker: string | undefined,
    limit: number,
  ): Promise<JsonRecord>;
}

export interface EodDataSource {
  latestScan(): Promise<JsonRecord | null>;
  searchLatest(query: string, limit: number): Promise<JsonRecord[]>;
  fetchLatest(documentId: string): Promise<JsonRecord | null>;
  describeLatestFields(query?: string): Promise<JsonRecord[]>;
  screenLatest(
    filters: ScanFilter[],
    sorts: ScanSort[],
    limit: number,
  ): Promise<JsonRecord[]>;
  listScans(limit: number): Promise<JsonRecord[]>;
  findScans(runIds: string[]): Promise<JsonRecord[]>;
  historyRows(scanId: number, ticker?: string): Promise<JsonRecord[]>;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? (value as JsonRecord[]) : [];
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

const FIELD_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const RELATION_MISSING_CODES = new Set(["42P01", "PGRST205"]);
export type ScalarKind = "text" | "number" | "boolean" | "null" | "mixed" | "unknown";
const EXTRACTED_FIELDS: Record<string, string> = {
  ticker: "ticker",
  _scan_source: "source",
  _scan_order: "scan_order",
  primary_setup: "primary_setup",
  risk_level: "risk_level",
  scan_price: "scan_price",
  "trade_plan.status": "trade_status",
  "trade_plan.entry_risk_pct": "entry_risk_pct",
  ranking_score: "ranking_score",
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
  ranking_score: "number",
};

export function assertAllowedFields(
  items: Array<{ field: string }>,
  allowedKinds: ReadonlyMap<string, ScalarKind>,
): void {
  for (const item of items) {
    const kind = allowedKinds.get(item.field);
    if (
      !FIELD_PATH.test(item.field) ||
      !kind ||
      kind === "mixed" ||
      kind === "unknown" ||
      kind === "null"
    ) {
      throw new Error(`Unknown or non-scalar scan field: ${item.field}`);
    }
  }
}

function relationMissing(error: { code?: string; message?: string } | null): boolean {
  return Boolean(
    error &&
      (RELATION_MISSING_CODES.has(error.code ?? "") ||
        /could not find the (?:table|relation)|does not exist/i.test(error.message ?? "")),
  );
}

export function scalarKind(types: unknown): ScalarKind {
  const normalized = Array.isArray(types)
    ? types
        .map((value) => String(value).toLowerCase())
        .filter((value) => !["nonetype", "null", "undefined"].includes(value))
    : [];
  if (normalized.length === 0) return "null";
  if (normalized.every((value) => ["str", "string", "text"].includes(value))) return "text";
  if (normalized.every((value) => ["int", "float", "number", "decimal"].includes(value))) {
    return "number";
  }
  if (normalized.every((value) => ["bool", "boolean"].includes(value))) return "boolean";
  return "mixed";
}

export function jsonFieldExpression(path: string, kind: ScalarKind): string {
  const parts = path.split(".");
  const final = parts.pop();
  if (!final) throw new Error(`Invalid JSON field path: ${path}`);
  const prefix = parts.length > 0 ? `record->${parts.join("->")}->` : "record->";
  return kind === "text" ? `${prefix}>${final}` : `${prefix}${final}`;
}

export function postgrestOperator(
  operator: ScanFilter["op"],
): "eq" | "neq" | "gt" | "gte" | "lt" | "lte" {
  if (operator === "ne") return "neq";
  if (["eq", "gt", "gte", "lt", "lte"].includes(operator)) {
    return operator as "eq" | "gt" | "gte" | "lt" | "lte";
  }
  throw new Error(`Operator ${operator} is not a scalar PostgREST operator`);
}

function databaseField(path: string, kind: ScalarKind): string {
  return EXTRACTED_FIELDS[path] ?? jsonFieldExpression(path, kind);
}

function eodContext(value: JsonRecord | null): JsonRecord | null {
  if (!value) return null;
  return Object.fromEntries(
    Object.entries({
      run_id: value.run_id,
      scan_date: value.scan_date,
      market_data_date: value.market_data_date,
      health_status: value.health_status,
      published_at: value.published_at,
      prices_are_live: false,
    }).filter(([, nested]) => nested !== undefined),
  );
}

function withEodContext(value: JsonRecord): JsonRecord {
  return { ...value, scan_context: eodContext(value) };
}

export class SupabaseEodDataSource implements EodDataSource {
  constructor(private readonly database: SupabaseClient) {}

  async latestScan(): Promise<JsonRecord | null> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("eod_latest_scan")
      .select("*")
      .maybeSingle();
    if (relationMissing(error)) return null;
    if (error) throw new Error(`EOD latest scan lookup failed: ${error.message}`);
    return record(data);
  }

  async searchLatest(query: string, limit: number): Promise<JsonRecord[]> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("eod_latest_candidates")
      .select(
        "document_id,ticker,source,scan_order,trade_status,primary_setup,risk_level,run_id,scan_date,market_data_date,health_status,published_at",
      )
      .textSearch("search_document", query, { config: "simple", type: "websearch" })
      .order("scan_order", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`EOD search failed: ${error.message}`);
    return records(data).map(withEodContext);
  }

  async fetchLatest(documentId: string): Promise<JsonRecord | null> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("eod_latest_candidates")
      .select("*")
      .eq("document_id", documentId)
      .maybeSingle();
    if (error) throw new Error(`EOD fetch failed: ${error.message}`);
    const row = record(data);
    return row ? withEodContext(row) : null;
  }

  async describeLatestFields(query = ""): Promise<JsonRecord[]> {
    let request = this.database
      .schema("stockscout_api")
      .from("eod_latest_fields")
      .select(
        "run_id,scan_date,market_data_date,health_status,published_at,field_path,scalar_types,populated_count,example",
      )
      .order("populated_count", { ascending: false })
      .limit(100);
    if (query.trim()) request = request.ilike("field_path", `%${query.trim()}%`);
    const { data, error } = await request;
    if (error) throw new Error(`EOD field lookup failed: ${error.message}`);
    return records(data).map(withEodContext);
  }

  async screenLatest(
    filters: ScanFilter[],
    sorts: ScanSort[],
    limit: number,
  ): Promise<JsonRecord[]> {
    const requestedFields = [
      ...new Set(
        [...filters, ...sorts]
          .map((item) => item.field)
          .filter((field) => !Object.hasOwn(EXTRACTED_FIELD_KINDS, field)),
      ),
    ];
    let fieldRows: JsonRecord[] = [];
    if (requestedFields.length > 0) {
      const { data, error } = await this.database
        .schema("stockscout_api")
        .from("eod_latest_fields")
        .select("field_path,scalar_types")
        .in("field_path", requestedFields)
        .limit(requestedFields.length);
      if (error) {
        throw new Error(`EOD field allowlist lookup failed: ${error.message}`);
      }
      fieldRows = records(data);
    }
    const allowedKinds = new Map<string, ScalarKind>(Object.entries(EXTRACTED_FIELD_KINDS));
    for (const item of fieldRows) {
      allowedKinds.set(String(item.field_path), scalarKind(item.scalar_types));
    }
    assertAllowedFields([...filters, ...sorts], allowedKinds);

    let request = this.database
      .schema("stockscout_api")
      .from("eod_latest_candidates")
      .select(
        "document_id,ticker,source,scan_order,trade_status,primary_setup,risk_level,scan_price,entry_risk_pct,ranking_score,record,run_id,scan_date,market_data_date,health_status,published_at",
      );
    for (const item of filters) {
      const kind = allowedKinds.get(item.field) ?? "unknown";
      const field = databaseField(item.field, item.op === "contains" ? "text" : kind);
      if (item.op === "in") {
        if (!Array.isArray(item.value) || item.value.length === 0 || item.value.length > 1000) {
          throw new Error("The in operator requires an array with 1 to 1000 values");
        }
        request = request.in(field, item.value);
      } else if (item.op === "contains") {
        if (kind !== "text") throw new Error(`The contains operator requires a text field`);
        request = request.ilike(field, `%${String(item.value ?? "")}%`);
      } else if (item.op === "is_true" || item.op === "is_false") {
        if (kind !== "boolean") {
          throw new Error(`${item.op} requires a boolean field`);
        }
        request = request.eq(field, item.op === "is_true");
      } else {
        if (item.value === undefined) throw new Error(`${item.op} requires a value`);
        request = request.filter(field, postgrestOperator(item.op), item.value);
      }
    }
    if (sorts.length > 0) {
      for (const item of sorts) {
        request = request.order(
          databaseField(item.field, allowedKinds.get(item.field) ?? "unknown"),
          {
          ascending: item.direction === "asc",
          nullsFirst: false,
          },
        );
      }
    } else {
      request = request.order("source", { ascending: true }).order("scan_order", {
        ascending: true,
      });
    }
    const { data, error } = await request.limit(limit);
    if (error) throw new Error(`EOD screen failed: ${error.message}`);
    return records(data).map(withEodContext);
  }

  async listScans(limit: number): Promise<JsonRecord[]> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("eod_scan_history")
      .select("*")
      .order("scan_date", { ascending: false })
      .order("published_at", { ascending: false })
      .limit(limit);
    if (relationMissing(error)) return [];
    if (error) throw new Error(`EOD scan history failed: ${error.message}`);
    return records(data).map(withEodContext);
  }

  async findScans(runIds: string[]): Promise<JsonRecord[]> {
    const { data, error } = await this.database
      .schema("stockscout_api")
      .from("eod_scans")
      .select("id,run_id,scan_date,market_data_date,health_status,records_hash")
      .in("run_id", runIds);
    if (relationMissing(error)) return [];
    if (error) throw new Error(`EOD scan lookup failed: ${error.message}`);
    return records(data);
  }

  async historyRows(scanId: number, ticker?: string): Promise<JsonRecord[]> {
    const output: JsonRecord[] = [];
    const pageSize = 1000;
    for (let offset = 0; offset < 10_000; offset += pageSize) {
      let request = this.database
        .schema("stockscout_api")
        .from("eod_candidate_history")
        .select("*")
        .eq("scan_id", scanId)
        .order("scan_order", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (ticker) request = request.eq("ticker", ticker);
      const { data, error } = await request;
      if (error) throw new Error(`EOD candidate history failed: ${error.message}`);
      const page = records(data);
      output.push(...page);
      if (page.length < pageSize) return output;
    }
    throw new Error("EOD history exceeded the 10,000-row safety limit");
  }
}

export class EodCompatibleScanAccess implements LegacyScanAccess, EodHistoryAccess {
  private activePromise: Promise<boolean> | undefined;

  constructor(
    private readonly eod: EodDataSource,
    private readonly legacy: LegacyScanAccess,
  ) {}

  private hasActiveEod(): Promise<boolean> {
    this.activePromise ??= this.eod.latestScan().then((value) => Boolean(value?.run_id));
    return this.activePromise;
  }

  async searchFullScan(query: string, limit: number): Promise<JsonRecord[]> {
    return (await this.hasActiveEod())
      ? this.eod.searchLatest(query, limit)
      : this.legacy.searchFullScan(query, limit);
  }

  async fetchFullScan(documentId: string): Promise<JsonRecord | null> {
    return (await this.hasActiveEod())
      ? this.eod.fetchLatest(documentId)
      : this.legacy.fetchFullScan(documentId);
  }

  async describeFullScanFields(query?: string): Promise<JsonRecord[]> {
    return (await this.hasActiveEod())
      ? this.eod.describeLatestFields(query)
      : this.legacy.describeFullScanFields(query);
  }

  async screenFullScan(
    filters: ScanFilter[],
    sorts: ScanSort[],
    limit: number,
  ): Promise<JsonRecord[]> {
    return (await this.hasActiveEod())
      ? this.eod.screenLatest(filters, sorts, limit)
      : this.legacy.screenFullScan(filters, sorts, limit);
  }

  listEodScans(limit: number): Promise<JsonRecord[]> {
    return this.eod.listScans(limit);
  }

  async compareEodScans(
    baseRunId: string,
    comparisonRunId: string,
    ticker: string | undefined,
    limit: number,
  ): Promise<JsonRecord> {
    if (baseRunId === comparisonRunId) throw new Error("Scan ids must be different");
    const scans = await this.eod.findScans([baseRunId, comparisonRunId]);
    const byRun = new Map(scans.map((item) => [String(item.run_id), item]));
    const base = byRun.get(baseRunId);
    const comparison = byRun.get(comparisonRunId);
    if (!base || !comparison) {
      return {
        base_run_id: baseRunId,
        comparison_run_id: comparisonRunId,
        base_scan: eodContext(base ?? null),
        comparison_scan: eodContext(comparison ?? null),
        status: "insufficient_history",
        prices_are_live: false,
        changes: [],
      };
    }
    const [baseRows, comparisonRows] = await Promise.all([
      this.eod.historyRows(Number(base.id), ticker),
      this.eod.historyRows(Number(comparison.id), ticker),
    ]);
    const allChanges = compareHistoryRows(baseRows, comparisonRows);
    const changes = allChanges.slice(0, limit);
    return {
      base_run_id: baseRunId,
      base_scan_date: base.scan_date,
      base_scan: eodContext(base),
      comparison_run_id: comparisonRunId,
      comparison_scan_date: comparison.scan_date,
      comparison_scan: eodContext(comparison),
      status: "ok",
      prices_are_live: false,
      change_count: allChanges.length,
      truncated: allChanges.length > limit,
      changes,
    };
  }
}

function numericDelta(after: unknown, before: unknown): number | null {
  const left = Number(after);
  const right = Number(before);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Number((left - right).toFixed(6));
}

export function compareHistoryRows(
  baseRows: JsonRecord[],
  comparisonRows: JsonRecord[],
): JsonRecord[] {
  const base = new Map(baseRows.map((item) => [String(item.ticker), item]));
  const comparison = new Map(comparisonRows.map((item) => [String(item.ticker), item]));
  const tickers = [...new Set([...base.keys(), ...comparison.keys()])].sort((a, b) => {
    const left = Number(comparison.get(a)?.scan_order ?? base.get(a)?.scan_order ?? 1e9);
    const right = Number(comparison.get(b)?.scan_order ?? base.get(b)?.scan_order ?? 1e9);
    return left - right || a.localeCompare(b);
  });
  const output: JsonRecord[] = [];
  for (const ticker of tickers) {
    const before = base.get(ticker);
    const after = comparison.get(ticker);
    if (!before) {
      output.push({ ticker, change_types: ["entered_scan"], before: null, after });
      continue;
    }
    if (!after) {
      output.push({ ticker, change_types: ["left_scan"], before, after: null });
      continue;
    }
    const changeTypes: string[] = [];
    if (before.source !== after.source) changeTypes.push("source_changed");
    if (before.trade_status !== after.trade_status) changeTypes.push("trade_status_changed");
    if (before.primary_setup !== after.primary_setup) changeTypes.push("primary_setup_changed");
    if (before.risk_level !== after.risk_level) changeTypes.push("risk_level_changed");
    const entryRiskDelta = numericDelta(after.entry_risk_pct, before.entry_risk_pct);
    const priceDelta = numericDelta(after.scan_price, before.scan_price);
    const rankingScoreDelta = numericDelta(after.ranking_score, before.ranking_score);
    const priceChanged = priceDelta !== null && priceDelta !== 0;
    if (entryRiskDelta !== null && entryRiskDelta !== 0) changeTypes.push("entry_risk_changed");
    if (rankingScoreDelta !== null && rankingScoreDelta !== 0) changeTypes.push("ranking_score_changed");
    if (changeTypes.length === 0 && !priceChanged) continue;
    output.push({
      ticker,
      change_types: changeTypes.length > 0 ? changeTypes : ["price_changed"],
      before,
      after,
      entry_risk_pct_delta: entryRiskDelta,
      scan_price_delta: priceDelta,
      ranking_score_delta: rankingScoreDelta,
    });
  }
  return output;
}

export type EnhancedRepository<T> = T & LegacyScanAccess & EodHistoryAccess;

export function withEodScanFallback<T extends LegacyScanAccess>(
  legacy: T,
  database: SupabaseClient,
): EnhancedRepository<T> {
  const enhanced = new EodCompatibleScanAccess(
    new SupabaseEodDataSource(database),
    legacy,
  );
  const overridden = new Set([
    "searchFullScan",
    "fetchFullScan",
    "describeFullScanFields",
    "screenFullScan",
    "listEodScans",
    "compareEodScans",
  ]);
  return new Proxy(legacy, {
    get(target, property, receiver) {
      if (typeof property === "string" && overridden.has(property)) {
        const value = Reflect.get(enhanced, property, enhanced) as unknown;
        return typeof value === "function" ? value.bind(enhanced) : value;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as EnhancedRepository<T>;
}

function readAnnotations() {
  return {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: true,
  };
}

const recordSchema = z.record(z.string(), z.unknown());
const nullableRecordSchema = recordSchema.nullable();

export function registerEodHistoryTools(
  server: McpServer,
  repository: EodHistoryAccess,
  oauthMeta: Record<string, unknown>,
): void {
  server.registerTool(
    "list_scans",
    {
      title: "List StockScout EOD scan history",
      description:
        "List dated, non-live EOD snapshots retained for up to 252 market sessions, including health and provenance.",
      inputSchema: { limit: z.number().int().min(1).max(252).default(20) },
      outputSchema: { scan: nullableRecordSchema, records: z.array(recordSchema) },
      annotations: readAnnotations(),
      _meta: oauthMeta,
    },
    async ({ limit }) => {
      const records = await repository.listEodScans(limit);
      const scan = eodContext(records[0] ?? null);
      return {
        structuredContent: { scan, records },
        content: [
          {
            type: "text" as const,
            text: scan
              ? `Found ${records.length} dated EOD scans. Latest scan ${String(scan.scan_date)} is ${String(scan.health_status)}; prices are not live.`
              : "No retained EOD scan is available; prices are not live.",
          },
        ],
      };
    },
  );

  server.registerTool(
    "compare_scans",
    {
      title: "Compare two StockScout EOD scans",
      description:
        "Compare candidate membership, setup, trade status, risk, price, and ranking metadata between two dated scans. This is not a performance backtest.",
      inputSchema: {
        base_run_id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
        comparison_run_id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
        ticker: z.string().regex(/^[A-Z0-9._-]{1,20}$/).optional(),
        limit: z.number().int().min(1).max(100).default(100),
      },
      outputSchema: { comparison: recordSchema },
      annotations: readAnnotations(),
      _meta: oauthMeta,
    },
    async ({ base_run_id, comparison_run_id, ticker, limit }) => {
      const comparison = await repository.compareEodScans(
        base_run_id,
        comparison_run_id,
        ticker,
        limit,
      );
      return {
        structuredContent: { comparison },
        content: [
          {
            type: "text" as const,
            text:
              comparison.status === "ok"
                ? `Compared ${String((comparison.base_scan as JsonRecord | null)?.scan_date)} (${String((comparison.base_scan as JsonRecord | null)?.health_status)}) with ${String((comparison.comparison_scan as JsonRecord | null)?.scan_date)} (${String((comparison.comparison_scan as JsonRecord | null)?.health_status)}); prices are not live.`
                : "Insufficient retained EOD history for this comparison; prices are not live.",
          },
        ],
      };
    },
  );
}
