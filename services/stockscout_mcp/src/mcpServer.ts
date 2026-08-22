import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SCAN_FILTER_OPERATORS, STRUCTURAL_STATUSES } from "./contracts.js";
import type { ScanFilter } from "./contracts.js";
import {
  registerEodHistoryTools,
  type EodHistoryAccess,
  type JsonRecord as EodJsonRecord,
} from "./eodScanPatch.js";
import { oauthToolMeta } from "./oauth.js";
import type { StockScoutRepository } from "./repository.js";

const sideSchema = z.enum(["long", "short"]);
const idSchema = z.number().int().positive().safe();
const recordSchema = z.record(z.string(), z.unknown());
const recordsOutput = { records: z.array(recordSchema) };
const recordOutput = { record: recordSchema.nullable() };
const scanOutput = recordSchema;
const scanRecordsOutput = { scan: scanOutput, records: z.array(recordSchema) };
const searchResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().url(),
});
const searchOutput = { scan: scanOutput, results: z.array(searchResultSchema) };
const fetchOutput = {
  scan: scanOutput, id: z.string(), title: z.string(), text: z.string(), url: z.string().url(), metadata: recordSchema,
};
const scanFilterSchema = z.object({
  field: z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/),
  op: z.enum(SCAN_FILTER_OPERATORS),
  value: z.unknown().optional(),
});
const scanSortSchema = z.object({
  field: z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

function canonicalUrl(documentId: string): string {
  const match = /^scan:(.+):candidate:([A-Z0-9._-]{1,20})$/.exec(documentId);
  if (!match) throw new Error("Invalid StockScout document id");
  const configured = process.env.MCP_CANONICAL_BASE_URL ?? "https://garrincha077.github.io/StockScout-EOD/";
  const base = new URL(configured);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const url = new URL(`ticker/${encodeURIComponent(match[2] ?? "")}`, base);
  url.searchParams.set("run", match[1] ?? "");
  return url.toString();
}

function scanContext(row: Record<string, unknown> | undefined): EodJsonRecord {
  const nested = row?.scan_context && typeof row.scan_context === "object" && !Array.isArray(row.scan_context)
    ? row.scan_context as Record<string, unknown>
    : {};
  const scanDate = nested.scan_date ?? row?.scan_date ?? null;
  return {
    run_id: nested.run_id ?? row?.run_id ?? null,
    scan_date: scanDate,
    market_data_date: nested.market_data_date ?? row?.market_data_date ?? scanDate,
    health_status: nested.health_status ?? row?.health_status ?? "legacy_snapshot",
    published_at: nested.published_at ?? row?.published_at ?? null,
    prices_are_live: false,
  };
}

function scanSummary(scan: EodJsonRecord): string {
  const date = scan.scan_date ? String(scan.scan_date) : "date unavailable";
  return `Scan ${date} is ${String(scan.health_status)}; prices are not live.`;
}

function documentResult(row: Record<string, unknown>) {
  const id = String(row.document_id);
  const ticker = String(row.ticker ?? "candidate");
  return {
    id,
    title: `${ticker} — ${String(row.primary_setup ?? "StockScout scan")}`,
    url: canonicalUrl(id),
  };
}

function result<T extends Record<string, unknown>>(structuredContent: T, summary: string) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text: summary }],
  };
}

function readAnnotations() {
  return {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
    idempotentHint: true,
  };
}

export function createStockScoutServer(
  repository: StockScoutRepository & EodHistoryAccess,
): McpServer {
  const server = new McpServer(
    { name: "stockscout", version: "1.1.0" },
    {
      instructions:
        "StockScout prices are from the dated EOD scan, never live. Always state the scan date. Show risk_level, excluded/source labels and warnings without silently hiding them. Published setup personas are transcribed criteria, not backtested edge. Never size a position unless trade_plan.status is entry_ready and tactical_stop_level is valid. Use search and fetch for company knowledge, and describe_scan_fields plus screen_scan for exact criteria. Explicit tool sorting never changes production headline_ranking or focus_blend. Create and poll an immutable risk preview before requesting staging. request_stage_untransmitted is approval-gated; every staged leg has transmit=false and there is no market-transmit capability.",
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search the latest full StockScout scan",
      description: "Search all candidates and excluded rows in the latest successful EOD scan. For exact numeric constraints, follow with screen_scan and fetch.",
      inputSchema: { query: z.string().min(1).max(500) },
      outputSchema: searchOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ query }) => {
      const filters: ScanFilter[] = [];
      if (/\bentry[-_ ]ready\b/i.test(query)) filters.push({ field: "trade_plan.status", op: "eq", value: "entry_ready" });
      const risk = /(?:risk|rizik)[^0-9]{0,20}(?:<=|≤|najvi(?:š|s)e|max(?:imum)?)?\s*(\d+(?:\.\d+)?)/i.exec(query);
      if (risk?.[1]) filters.push({ field: "trade_plan.entry_risk_pct", op: "lte", value: Number(risk[1]) });
      const ticker = /^\s*\$?([A-Z]{1,6}(?:\.[A-Z])?)\s*$/.exec(query);
      if (ticker?.[1]) filters.push({ field: "ticker", op: "eq", value: ticker[1] });
      if (/\brwb\b/i.test(query)) {
        filters.push({ field: "setups.rwb_squeeze_thrust.triggered", op: "is_true" });
      }
      if (/\bcrash[-_ ]base\b/i.test(query)) filters.push({ field: "primary_setup", op: "eq", value: "crash_base_stage1" });
      if (/\baccumulation\b/i.test(query)) filters.push({ field: "primary_setup", op: "eq", value: "accumulation_base" });
      const rows = (
        filters.length
          ? await repository.screenFullScan(filters, [], 20)
          : await repository.searchFullScan(query, 20)
      );
      const results = rows.map(documentResult);
      const scan = scanContext(rows[0]);
      return result(
        { scan, results },
        `Found ${results.length} full-scan documents. ${scanSummary(scan)}`,
      );
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch one complete StockScout scan record",
      description: "Return every stored field, nested setup result and raw feature for one stable scan document id.",
      inputSchema: { id: z.string().regex(/^scan:.+:candidate:[A-Z0-9._-]{1,20}$/) },
      outputSchema: fetchOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ id }) => {
      const row = await repository.fetchFullScan(id);
      if (!row) throw new Error("StockScout scan document not found");
      const record = row.record && typeof row.record === "object" ? row.record : {};
      const scan = scanContext(row);
      const output = {
        scan,
        ...documentResult(row),
        text: JSON.stringify(record, null, 2),
        metadata: {
          run_id: row.run_id, scan_date: row.scan_date, price_type: "scan",
          source: row.source, excluded: row.source === "excluded",
          risk_level: row.risk_level, trade_status: row.trade_status,
        },
      };
      return result(
        output,
        `Loaded complete ${String(row.ticker)} scan record. ${scanSummary(scan)}`,
      );
    },
  );

  server.registerTool(
    "describe_scan_fields",
    {
      title: "Describe full-scan fields",
      description: "Find allowlisted scalar JSON paths, their types and examples before building a precise screen.",
      inputSchema: { query: z.string().max(200).optional() },
      outputSchema: scanRecordsOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ query }) => {
      const records = await repository.describeFullScanFields(query);
      const scan = scanContext(records[0]);
      return result(
        { scan, records },
        `Found ${records.length} scan fields. ${scanSummary(scan)}`,
      );
    },
  );

  server.registerTool(
    "screen_scan",
    {
      title: "Screen the latest full StockScout scan",
      description: "Apply allowlisted scalar filters and up to three explicit sorts without changing the production ranking. Includes excluded rows unless filtered out.",
      inputSchema: {
        filters: z.array(scanFilterSchema).max(20).default([]),
        sort: z.array(scanSortSchema).max(3).default([]),
        limit: z.number().int().min(1).max(100).default(20),
      },
      outputSchema: scanRecordsOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ filters, sort, limit }) => {
      const rows = await repository.screenFullScan(filters, sort, limit);
      const requested = new Set([...filters.map((item) => item.field), ...sort.map((item) => item.field)]);
      const records = rows.map((row) => {
        const payload = row.record && typeof row.record === "object" ? row.record as Record<string, unknown> : {};
        const values: Record<string, unknown> = {
          ticker: row.ticker, source: row.source, excluded: row.source === "excluded",
          trade_status: row.trade_status, primary_setup: row.primary_setup,
          risk_level: row.risk_level, scan_price: row.scan_price,
        };
        for (const path of requested) {
          let value: unknown = payload;
          for (const part of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : null;
          values[path] = value;
        }
        return { ...documentResult(row), values, scan_date: row.scan_date, price_type: "scan" };
      });
      const scan = scanContext(rows[0]);
      return result(
        { scan, records },
        `Matched and returned ${records.length} candidates. ${scanSummary(scan)}`,
      );
    },
  );

  server.registerTool(
    "get_scan_status",
    {
      title: "Get StockScout scan status",
      description:
        "Use this when checking whether a StockScout EOD run is fresh, complete, and eligible to produce trade proposals.",
      inputSchema: {
        session_date: z.string().date().optional(),
      },
      outputSchema: recordOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ session_date }) => {
      const record = await repository.getScanStatus(session_date);
      return result({ record }, record ? "Scan status loaded." : "No matching scan run.");
    },
  );

  server.registerTool(
    "list_volume_events",
    {
      title: "List volume ignition events",
      description:
        "Use this when reviewing recent bullish or bearish volume anomalies retained by the full-market scanner.",
      inputSchema: {
        side: sideSchema,
        limit: z.number().int().min(1).max(100).default(20),
      },
      outputSchema: recordsOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ side, limit }) => {
      const records = await repository.listVolumeEvents(side, limit);
      return result({ records }, `Found ${records.length} volume events.`);
    },
  );

  server.registerTool(
    "list_watch",
    {
      title: "List structural watch candidates",
      description:
        "Use this when reviewing persistent long-base or distribution-watch candidates separately from current entry signals.",
      inputSchema: {
        side: sideSchema,
        structural_status: z.enum(STRUCTURAL_STATUSES).optional(),
        qualified_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(20),
      },
      outputSchema: recordsOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ side, structural_status, qualified_only, limit }) => {
      const records = await repository.listWatch(
        side,
        structural_status,
        qualified_only,
        limit,
      );
      return result({ records }, `Found ${records.length} watch candidates.`);
    },
  );

  server.registerTool(
    "list_actionable",
    {
      title: "List actionable daily proposals",
      description:
        "Use this when selecting zero to three fresh, fully qualified daily proposals; it never pads the list with weak candidates.",
      inputSchema: {
        side: sideSchema,
        limit: z.number().int().min(1).max(3).default(3),
      },
      outputSchema: recordsOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ side, limit }) => {
      const records = await repository.listActionable(side, limit);
      return result({ records }, `Found ${records.length} actionable proposals.`);
    },
  );

  server.registerTool(
    "explain_candidate",
    {
      title: "Explain a StockScout proposal",
      description:
        "Use this when inspecting the setup, structural evidence, execution trigger, invalidation, risk gates, and warnings for one proposal id.",
      inputSchema: {
        proposal_id: idSchema,
      },
      outputSchema: recordOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ proposal_id }) => {
      const record = await repository.explainCandidate(proposal_id);
      return result({ record }, record ? "Proposal loaded." : "Proposal not found.");
    },
  );

  server.registerTool(
    "create_risk_preview",
    {
      title: "Create proposal-bound risk preview",
      description:
        "Use this when the user has chosen one to three existing proposals and supplied a USD risk cap for each. It asynchronously queues an immutable, release-bound broker quote and aggregate WhatIf preview; poll get_risk_preview with the returned preview_request_id.",
      inputSchema: {
        proposal_ids: z.array(idSchema).min(1).max(3),
        risk_usd_by_proposal: z.record(z.string(), z.number().positive().finite()),
      },
      outputSchema: { preview_request: recordSchema },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
      _meta: oauthToolMeta(),
    },
    async ({ proposal_ids, risk_usd_by_proposal }) => {
      const preview_request = await repository.createRiskPreviewRequest(
        proposal_ids,
        risk_usd_by_proposal,
      );
      return result(
        { preview_request: { ...preview_request } },
        "Risk preview queued. Poll get_risk_preview with preview_request_id; the request expires after ten minutes.",
      );
    },
  );

  server.registerTool(
    "get_risk_preview",
    {
      title: "Get risk preview",
      description:
        "Use this when reading an immutable risk preview, its sizing, targets, expiry, broker what-if evidence, rejections, and hash.",
      inputSchema: {
        preview_id: idSchema,
      },
      outputSchema: recordOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ preview_id }) => {
      const record = await repository.getRiskPreview(preview_id);
      return result({ record }, record ? "Risk preview loaded." : "Risk preview not found.");
    },
  );

  server.registerTool(
    "request_stage_untransmitted",
    {
      title: "Request untransmitted TWS staging",
      description:
        "Use this only after the user explicitly approves a ready preview. This approval-gated external action queues a one-time five-minute request for the release-bound local TWS helper. At most two proposals may be selected. Inputs cannot override environment, ticker, price, stop, quantity, targets, account, or order flags.",
      inputSchema: {
        preview_id: idSchema,
        selected_proposal_ids: z.array(idSchema).min(1).max(2),
        idempotency_key: z
          .string()
          .min(16)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/),
      },
      outputSchema: { stage_request: recordSchema },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: oauthToolMeta(),
    },
    async ({ preview_id, selected_proposal_ids, idempotency_key }) => {
      const stage_request = await repository.requestStageUntransmitted(
        preview_id,
        selected_proposal_ids,
        idempotency_key,
      );
      return result(
        { stage_request: { ...stage_request } },
        "Five-minute staging request created. Every leg remains transmit=false; the orders disappear when the current TWS session restarts.",
      );
    },
  );

  server.registerTool(
    "get_staged_batch",
    {
      title: "Get staged order batch",
      description:
        "Use this when reading local-helper audit results and order ids for a staged batch. Use stage_request_id while waiting for the helper, or batch_id after it is known.",
      inputSchema: {
        batch_id: idSchema.optional(),
        stage_request_id: idSchema.optional(),
      },
      outputSchema: recordOutput,
      annotations: readAnnotations(),
      _meta: oauthToolMeta(),
    },
    async ({ batch_id, stage_request_id }) => {
      if ((batch_id === undefined) === (stage_request_id === undefined)) {
        throw new Error("provide exactly one of batch_id or stage_request_id");
      }
      const record =
        stage_request_id !== undefined
          ? await repository.getStagedBatchByStageRequest(stage_request_id)
          : await repository.getStagedBatch(batch_id as number);
      return result(
        { record },
        record
          ? "Staged batch loaded. Untransmitted orders disappear when TWS restarts."
          : "Staged batch not found.",
      );
    },
  );

  registerEodHistoryTools(server, repository, oauthToolMeta());

  return server;
}
