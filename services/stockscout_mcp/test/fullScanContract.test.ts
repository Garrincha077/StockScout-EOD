import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { TOOL_NAMES } from "../src/contracts.js";
import type { JsonRecord } from "../src/contracts.js";
import { InMemoryStockScoutRepository } from "../src/inMemoryRepository.js";
import { createStockScoutServer } from "../src/mcpServer.js";

const scanContext = {
  run_id: "eod-2026-08-21",
  scan_date: "2026-08-21",
  market_data_date: "2026-08-21",
  health_status: "healthy",
  published_at: "2026-08-21T22:00:00Z",
  prices_are_live: false,
};

function seedRepository(): InMemoryStockScoutRepository {
  return new InMemoryStockScoutRepository({
    fullScan: [
      {
        document_id: "scan:eod-2026-08-21:candidate:AAPL",
        ticker: "AAPL",
        primary_setup: "rwb",
        source: "candidate",
        scan_order: 1,
        trade_status: "entry_ready",
        entry_risk_pct: 8.5,
        scan_date: "2026-08-21",
        scan_context: scanContext,
        record: {
          ticker: "AAPL",
          trade_plan: { status: "entry_ready", entry_risk_pct: 8.5 },
          setups: {
            rwb_squeeze_thrust: {
              triggered: true,
              state: "fresh",
              bundle_width_pct: 2.4,
            },
          },
        },
      },
      {
        document_id: "scan:eod-2026-08-21:candidate:MSFT",
        ticker: "MSFT",
        primary_setup: "none",
        source: "excluded",
        scan_order: 2,
        trade_status: "trigger_pending",
        entry_risk_pct: 12.2,
        scan_date: "2026-08-21",
        scan_context: scanContext,
        record: {
          ticker: "MSFT",
          trade_plan: { status: "trigger_pending", entry_risk_pct: 12.2 },
          setups: {
            rwb_squeeze_thrust: {
              triggered: false,
              state: "pending",
              bundle_width_pct: 7.5,
            },
          },
        },
      },
    ],
    scanFields: [
      { ...scanContext, scan_context: scanContext, field_path: "trade_plan.status", scalar_types: ["str"], populated_count: 2 },
      { ...scanContext, scan_context: scanContext, field_path: "trade_plan.entry_risk_pct", scalar_types: ["float"], populated_count: 2 },
      { ...scanContext, scan_context: scanContext, field_path: "setups.rwb_squeeze_thrust.triggered", scalar_types: ["bool"], populated_count: 2 },
      { ...scanContext, scan_context: scanContext, field_path: "setups.rwb_squeeze_thrust.state", scalar_types: ["str"], populated_count: 2 },
      { ...scanContext, scan_context: scanContext, field_path: "setups.rwb_squeeze_thrust.bundle_width_pct", scalar_types: ["float"], populated_count: 2 },
    ],
    scanHistory: [
      { run_id: "eod-2026-08-21", scan_date: "2026-08-21", market_data_date: "2026-08-21", health_status: "healthy", published_at: "2026-08-21T22:00:00Z" },
      { run_id: "eod-2026-08-20", scan_date: "2026-08-20", market_data_date: "2026-08-20", health_status: "healthy", published_at: "2026-08-20T22:00:00Z" },
    ],
    candidateHistory: {
      "eod-2026-08-20": [
        { ticker: "AAPL", scan_order: 1, source: "candidate", trade_status: "trigger_pending", scan_price: 224 },
      ],
      "eod-2026-08-21": [
        { ticker: "AAPL", scan_order: 1, source: "candidate", trade_status: "entry_ready", scan_price: 225 },
        { ticker: "MSFT", scan_order: 2, source: "excluded", trade_status: "trigger_pending", scan_price: 505 },
      ],
    },
    scanStatus: [{ session_date: "2026-08-21", state: "complete" }],
    volumeEvents: [{ ticker: "AAPL", side: "long", relative_volume: 2.4 }],
    watch: [{ ticker: "AAPL", side: "long", structural_status: "early_accumulation", watch_qualified: true }],
    actionable: [{ proposal_id: 7, ticker: "AAPL", side: "long", proposal_eligible: true }],
    riskPreviews: [{ preview_id: 11, status: "ready", preview_hash: "a".repeat(64) }],
    stagedBatches: [{ batch_id: 13, stage_request_id: 17, transmit: false }],
  });
}

async function connectedClient() {
  const server = createStockScoutServer(seedRepository());
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

function contentText(response: unknown): string {
  const candidate = response && typeof response === "object"
    ? (response as { content?: unknown }).content
    : undefined;
  const content = Array.isArray(candidate) ? candidate : [];
  return content
    .filter((item): item is { type: string; text: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text"))
    .map((item) => item.text)
    .join("\n");
}

async function expectToolError(
  client: Client,
  request: { name: string; arguments: Record<string, unknown> },
): Promise<void> {
  try {
    const response = await client.callTool(request);
    assert.equal(response.isError, true, `expected ${request.name} to reject its input`);
  } catch (error) {
    assert.ok(error instanceof Error);
  }
}

test("the deployable server preserves every legacy tool and its safety annotations", async () => {
  const { server, client } = await connectedClient();
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      [...listed.tools.map((tool) => tool.name)].sort(),
      [...TOOL_NAMES].sort(),
    );
    const mutating = new Set(["create_risk_preview", "request_stage_untransmitted"]);
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, !mutating.has(tool.name), tool.name);
    }

    assert.equal(
      ((await client.callTool({ name: "get_scan_status", arguments: {} })).structuredContent as { record: JsonRecord }).record.state,
      "complete",
    );
    assert.equal(
      ((await client.callTool({ name: "list_volume_events", arguments: { side: "long" } })).structuredContent as { records: JsonRecord[] }).records[0]?.ticker,
      "AAPL",
    );
    assert.equal(
      ((await client.callTool({ name: "list_watch", arguments: { side: "long" } })).structuredContent as { records: JsonRecord[] }).records[0]?.structural_status,
      "early_accumulation",
    );
    assert.equal(
      ((await client.callTool({ name: "list_actionable", arguments: { side: "long" } })).structuredContent as { records: JsonRecord[] }).records[0]?.proposal_id,
      7,
    );
    assert.equal(
      ((await client.callTool({ name: "explain_candidate", arguments: { proposal_id: 7 } })).structuredContent as { record: JsonRecord }).record.ticker,
      "AAPL",
    );
    assert.equal(
      ((await client.callTool({ name: "get_risk_preview", arguments: { preview_id: 11 } })).structuredContent as { record: JsonRecord }).record.status,
      "ready",
    );
    assert.equal(
      ((await client.callTool({ name: "get_staged_batch", arguments: { stage_request_id: 17 } })).structuredContent as { record: JsonRecord }).record.transmit,
      false,
    );
    const preview = await client.callTool({
      name: "create_risk_preview",
      arguments: { proposal_ids: [7], risk_usd_by_proposal: { "7": 100 } },
    });
    assert.equal(
      ((preview.structuredContent as { preview_request: JsonRecord }).preview_request).status,
      "requested",
    );
    const staged = await client.callTool({
      name: "request_stage_untransmitted",
      arguments: {
        preview_id: 11,
        selected_proposal_ids: [7],
        idempotency_key: "contract-test-0001",
      },
    });
    assert.equal(
      ((staged.structuredContent as { stage_request: JsonRecord }).stage_request).status,
      "pending",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("search, fetch, describe and screen carry dated non-live context and PWA URLs", async () => {
  const { server, client } = await connectedClient();
  try {
    const search = await client.callTool({
      name: "search",
      arguments: { query: "RWB entry-ready risk max 10" },
    });
    const searched = search.structuredContent as { scan: JsonRecord; results: JsonRecord[] };
    assert.equal(searched.scan.scan_date, "2026-08-21");
    assert.equal(searched.scan.health_status, "healthy");
    assert.equal(searched.scan.prices_are_live, false);
    assert.deepEqual(searched.results.map((row) => row.id), [
      "scan:eod-2026-08-21:candidate:AAPL",
    ]);
    assert.equal(
      searched.results[0]?.url,
      "https://garrincha077.github.io/StockScout-EOD/ticker/AAPL?run=eod-2026-08-21",
    );
    assert.match(contentText(search), /2026-08-21.*healthy.*not live/i);

    const fetched = await client.callTool({
      name: "fetch",
      arguments: { id: "scan:eod-2026-08-21:candidate:AAPL" },
    });
    const fetchOutput = fetched.structuredContent as {
      scan: JsonRecord;
      id: string;
      text: string;
      metadata: JsonRecord;
      url: string;
    };
    assert.equal(fetchOutput.scan.market_data_date, "2026-08-21");
    assert.equal(fetchOutput.metadata.excluded, false);
    assert.match(fetchOutput.text, /entry_risk_pct/);
    assert.match(fetchOutput.url, /\/StockScout-EOD\/ticker\/AAPL\?run=/);
    assert.match(contentText(fetched), /prices are not live/i);

    const described = await client.callTool({
      name: "describe_scan_fields",
      arguments: { query: "bundle_width" },
    });
    const fieldOutput = described.structuredContent as { scan: JsonRecord; records: JsonRecord[] };
    assert.equal(fieldOutput.scan.scan_date, "2026-08-21");
    assert.deepEqual(fieldOutput.records.map((row) => row.field_path), [
      "setups.rwb_squeeze_thrust.bundle_width_pct",
    ]);

    const screened = await client.callTool({
      name: "screen_scan",
      arguments: {
        filters: [
          { field: "setups.rwb_squeeze_thrust.bundle_width_pct", op: "lte", value: 3 },
          { field: "setups.rwb_squeeze_thrust.state", op: "contains", value: "fresh" },
        ],
        sort: [{ field: "trade_plan.entry_risk_pct", direction: "asc" }],
        limit: 100,
      },
    });
    const screenOutput = screened.structuredContent as { scan: JsonRecord; records: JsonRecord[] };
    assert.equal(screenOutput.scan.prices_are_live, false);
    assert.deepEqual(screenOutput.records.map((row) => row.id), [
      "scan:eod-2026-08-21:candidate:AAPL",
    ]);
    assert.equal(
      (screenOutput.records[0]?.values as JsonRecord)["setups.rwb_squeeze_thrust.bundle_width_pct"],
      2.4,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("screen_scan rejects arbitrary and unknown JSON paths", async () => {
  const { server, client } = await connectedClient();
  try {
    await expectToolError(client, {
      name: "screen_scan",
      arguments: {
        filters: [{ field: "record->secret", op: "eq", value: "x" }],
      },
    });
    await expectToolError(client, {
      name: "screen_scan",
      arguments: {
        filters: [{ field: "setups.private_payload.token", op: "eq", value: "x" }],
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("list_scans and compare_scans expose retained history through the real server", async () => {
  const { server, client } = await connectedClient();
  try {
    const scans = await client.callTool({ name: "list_scans", arguments: { limit: 2 } });
    const listed = scans.structuredContent as { scan: JsonRecord; records: JsonRecord[] };
    assert.equal(listed.records.length, 2);
    assert.equal(listed.scan.scan_date, "2026-08-21");
    assert.equal(listed.scan.prices_are_live, false);
    assert.match(contentText(scans), /2026-08-21.*healthy.*not live/i);

    const compared = await client.callTool({
      name: "compare_scans",
      arguments: {
        base_run_id: "eod-2026-08-20",
        comparison_run_id: "eod-2026-08-21",
      },
    });
    const comparison = (compared.structuredContent as { comparison: JsonRecord }).comparison;
    assert.equal(comparison.status, "ok");
    assert.equal(comparison.prices_are_live, false);
    assert.deepEqual(
      (comparison.changes as JsonRecord[]).map((row) => row.ticker),
      ["AAPL", "MSFT"],
    );
    assert.match(contentText(compared), /2026-08-20.*healthy.*2026-08-21.*healthy.*not live/i);
  } finally {
    await client.close();
    await server.close();
  }
});
