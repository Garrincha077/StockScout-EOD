import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClient } from "@supabase/supabase-js";

import {
  compareHistoryRows,
  EodCompatibleScanAccess,
  jsonFieldExpression,
  postgrestOperator,
  scalarKind,
  SupabaseEodDataSource,
  type EodDataSource,
  type JsonRecord,
  type LegacyScanAccess,
  registerEodHistoryTools,
} from "../src/eodScanPatch.js";

class MemoryLegacy implements LegacyScanAccess {
  calls = 0;
  async searchFullScan(): Promise<JsonRecord[]> {
    this.calls += 1;
    return [{ ticker: "LEGACY" }];
  }
  async fetchFullScan(): Promise<JsonRecord | null> {
    this.calls += 1;
    return { ticker: "LEGACY" };
  }
  async describeFullScanFields(): Promise<JsonRecord[]> {
    this.calls += 1;
    return [{ field_path: "legacy" }];
  }
  async screenFullScan(): Promise<JsonRecord[]> {
    this.calls += 1;
    return [{ ticker: "LEGACY" }];
  }
}

class MemoryEod implements EodDataSource {
  constructor(readonly active: boolean) {}
  async latestScan(): Promise<JsonRecord | null> {
    return this.active
      ? {
          run_id: "eod-2",
          scan_date: "2026-08-21",
          market_data_date: "2026-08-21",
          health_status: "healthy",
        }
      : null;
  }
  async searchLatest(): Promise<JsonRecord[]> {
    return [{ ticker: "EOD" }];
  }
  async fetchLatest(): Promise<JsonRecord | null> {
    return { ticker: "EOD" };
  }
  async describeLatestFields(): Promise<JsonRecord[]> {
    return [{ field_path: "trade_plan.status" }];
  }
  async screenLatest(): Promise<JsonRecord[]> {
    return [{ ticker: "EOD" }];
  }
  async listScans(): Promise<JsonRecord[]> {
    return [
      {
        id: 1,
        run_id: "eod-1",
        scan_date: "2026-08-20",
        market_data_date: "2026-08-20",
        health_status: "healthy",
      },
      {
        id: 2,
        run_id: "eod-2",
        scan_date: "2026-08-21",
        market_data_date: "2026-08-21",
        health_status: "healthy",
      },
    ];
  }
  async findScans(): Promise<JsonRecord[]> {
    return [
      {
        id: 1,
        run_id: "eod-1",
        scan_date: "2026-08-20",
        market_data_date: "2026-08-20",
        health_status: "healthy",
      },
      {
        id: 2,
        run_id: "eod-2",
        scan_date: "2026-08-21",
        market_data_date: "2026-08-21",
        health_status: "healthy",
      },
    ];
  }
  async historyRows(scanId: number): Promise<JsonRecord[]> {
    return scanId === 1
      ? [{ ticker: "AAA", source: "candidate", scan_order: 1, trade_status: "trigger_pending" }]
      : [
          { ticker: "AAA", source: "candidate", scan_order: 1, trade_status: "entry_ready" },
          { ticker: "BBB", source: "candidate", scan_order: 2, trade_status: "trigger_pending" },
        ];
  }
}

test("latest scan methods fall back exactly when EOD has no active snapshot", async () => {
  const legacy = new MemoryLegacy();
  const access = new EodCompatibleScanAccess(new MemoryEod(false), legacy);
  assert.deepEqual(await access.searchFullScan("anything", 20), [{ ticker: "LEGACY" }]);
  assert.deepEqual(await access.fetchFullScan("scan:old:candidate:LEGACY"), { ticker: "LEGACY" });
  assert.equal(legacy.calls, 2);
  assert.equal((await access.listEodScans(20)).length, 2);
});

test("active EOD snapshot replaces only latest scan methods", async () => {
  const legacy = new MemoryLegacy();
  const access = new EodCompatibleScanAccess(new MemoryEod(true), legacy);
  assert.deepEqual(await access.screenFullScan([], [], 20), [{ ticker: "EOD" }]);
  assert.equal(legacy.calls, 0);
});

test("history comparison names concrete changes and examples", () => {
  const changes = compareHistoryRows(
    [{ ticker: "AAA", source: "candidate", scan_order: 1, trade_status: "trigger_pending" }],
    [
      { ticker: "AAA", source: "candidate", scan_order: 1, trade_status: "entry_ready" },
      { ticker: "BBB", source: "candidate", scan_order: 2, trade_status: "trigger_pending" },
    ],
  );
  assert.deepEqual(changes.map((item) => item.ticker), ["AAA", "BBB"]);
  assert.deepEqual(changes[0]?.change_types, ["trade_status_changed"]);
  assert.deepEqual(changes[1]?.change_types, ["entered_scan"]);
});

test("filter translation uses typed JSON paths and valid PostgREST operators", () => {
  assert.equal(postgrestOperator("ne"), "neq");
  assert.equal(scalarKind(["str", "NoneType"]), "text");
  assert.equal(scalarKind(["float", "int"]), "number");
  assert.equal(
    jsonFieldExpression("setups.rwb_squeeze_thrust.state", "text"),
    "record->setups->rwb_squeeze_thrust->>state",
  );
  assert.equal(
    jsonFieldExpression("setups.rwb_squeeze_thrust.score", "number"),
    "record->setups->rwb_squeeze_thrust->score",
  );
});

test("Supabase screening emits typed nested PostgREST filters", async () => {
  const requests: Request[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(request);
    const payload = url.pathname.endsWith("/eod_latest_fields")
      ? [
          { field_path: "setups.rwb_squeeze_thrust.state", scalar_types: ["str"] },
          { field_path: "setups.rwb_squeeze_thrust.bundle_width_pct", scalar_types: ["float"] },
          { field_path: "setups.rwb_squeeze_thrust.triggered", scalar_types: ["bool"] },
        ]
      : [];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const database = createClient("https://example.supabase.co", "anon-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: mockFetch },
  });
  const source = new SupabaseEodDataSource(database);
  await source.screenLatest(
    [
      { field: "setups.rwb_squeeze_thrust.state", op: "ne", value: "pending" },
      { field: "setups.rwb_squeeze_thrust.bundle_width_pct", op: "lte", value: 3 },
      { field: "setups.rwb_squeeze_thrust.triggered", op: "is_true" },
    ],
    [{ field: "setups.rwb_squeeze_thrust.bundle_width_pct", direction: "asc" }],
    20,
  );
  const candidateRequest = requests.find((request) =>
    new URL(request.url).pathname.endsWith("/eod_latest_candidates"));
  assert.ok(candidateRequest);
  const candidateUrl = new URL(candidateRequest.url);
  assert.ok(requests.length >= 2);
  assert.ok(requests.every((request) =>
    request.headers.get("Accept-Profile") === "stockscout_api"));
  assert.equal(
    candidateUrl.searchParams.get("record->setups->rwb_squeeze_thrust->>state"),
    "neq.pending",
  );
  assert.equal(
    candidateUrl.searchParams.get("record->setups->rwb_squeeze_thrust->bundle_width_pct"),
    "lte.3",
  );
  assert.equal(
    candidateUrl.searchParams.get("record->setups->rwb_squeeze_thrust->triggered"),
    "eq.true",
  );
  assert.match(
    String(candidateUrl.searchParams.get("order")),
    /record->setups->rwb_squeeze_thrust->bundle_width_pct\.asc\.nullslast/,
  );
});

test("list_scans and compare_scans are read-only MCP tools", async () => {
  const access = new EodCompatibleScanAccess(new MemoryEod(true), new MemoryLegacy());
  const server = new McpServer({ name: "stockscout-test", version: "1.0.0" });
  registerEodHistoryTools(server, access, { securitySchemes: [{ type: "oauth2", scopes: ["email"] }] });
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    for (const name of ["list_scans", "compare_scans"]) {
      const tool = listed.tools.find((item) => item.name === name);
      assert.ok(tool, `${name} is registered`);
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
    const scans = await client.callTool({ name: "list_scans", arguments: {} });
    const scanOutput = scans.structuredContent as {
      scan: JsonRecord;
      records: JsonRecord[];
    };
    assert.equal(scanOutput.scan.scan_date, "2026-08-20");
    assert.equal(scanOutput.scan.health_status, "healthy");
    assert.equal(scanOutput.scan.prices_are_live, false);
    const comparison = await client.callTool({
      name: "compare_scans",
      arguments: { base_run_id: "eod-1", comparison_run_id: "eod-2" },
    });
    const output = comparison.structuredContent as { comparison: JsonRecord };
    assert.equal(output.comparison.status, "ok");
    assert.equal(output.comparison.prices_are_live, false);
    assert.deepEqual(output.comparison.base_scan, {
      run_id: "eod-1",
      scan_date: "2026-08-20",
      market_data_date: "2026-08-20",
      health_status: "healthy",
      prices_are_live: false,
    });
  } finally {
    await client.close();
    await server.close();
  }
});
