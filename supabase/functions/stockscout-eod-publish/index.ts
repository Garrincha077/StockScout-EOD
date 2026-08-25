import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.10.0";
import {
  jcsStringify,
  type JsonObject,
  publishRecordHash,
  sha256Hex,
} from "./jcs.ts";
import {
  ALERT_EXTRACTED_FIELDS,
  type AlertCandidate,
  alertEventKey,
  alertEventPayload,
  evaluateOwnerAlert,
  type JsonRecord as AlertJsonRecord,
  type OwnerAlert,
} from "./alerts.ts";
import { EDGE_API_SCHEMA, lookupSingleOwner } from "./database.ts";

const AUDIENCE = "stockscout-eod-publish";
const ISSUER = "https://token.actions.githubusercontent.com";
const DEFAULT_REPOSITORY = "Garrincha077/StockScout-EOD";
const DEFAULT_REF = "refs/heads/main";
const DEFAULT_WORKFLOW_REF =
  "Garrincha077/StockScout-EOD/.github/workflows/eod.yml@refs/heads/main";
const DEFAULT_CHART_PROMOTION_WORKFLOW_REF =
  "Garrincha077/StockScout-EOD/.github/workflows/promote-charts.yml@refs/heads/main";
const DEFAULT_ENVIRONMENT = "production";
const CHART_BUCKET = "stockscout-eod-charts";
const MARKET_CACHE_BUCKET = "stockscout-eod-market-cache";
const MAX_CONTROL_BODY_BYTES = 12_000_000;
const MAX_CHART_BYTES = 5_242_880;
const MAX_CHART_MANIFEST_BYTES = 1_000_000;
const MAX_MARKET_CACHE_SHARD_BYTES = 8_000_000;
const DELIVERY_TYPES = new Set(["daily", "operational_error"]);
const MAX_ALERT_EVENTS_PER_RUN = 2_000;
const GITHUB_JWKS = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
);

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? null;
}

async function authorizeGithub(request: Request): Promise<string> {
  const token = bearerToken(request);
  if (!token) throw new Error("missing GitHub OIDC bearer token");
  const { payload } = await jwtVerify(token, GITHUB_JWKS, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  const expectedRepository =
    Deno.env.get("STOCKSCOUT_GITHUB_REPOSITORY")?.trim() || DEFAULT_REPOSITORY;
  const expectedRef = Deno.env.get("STOCKSCOUT_GITHUB_REF")?.trim() ||
    DEFAULT_REF;
  const expectedWorkflowRef =
    Deno.env.get("STOCKSCOUT_GITHUB_WORKFLOW_REF")?.trim() ||
    DEFAULT_WORKFLOW_REF;
  const expectedChartPromotionWorkflowRef =
    Deno.env.get("STOCKSCOUT_GITHUB_CHART_PROMOTION_WORKFLOW_REF")?.trim() ||
    DEFAULT_CHART_PROMOTION_WORKFLOW_REF;
  const expectedEnvironment =
    Deno.env.get("STOCKSCOUT_GITHUB_ENVIRONMENT")?.trim() ||
    DEFAULT_ENVIRONMENT;

  if (
    payload.repository !== expectedRepository ||
    payload.ref !== expectedRef ||
    !new Set([
      expectedWorkflowRef,
      expectedChartPromotionWorkflowRef,
    ]).has(String(payload.workflow_ref ?? "")) ||
    payload.environment !== expectedEnvironment ||
    payload.ref_protected !== "true"
  ) {
    throw new Error("GitHub OIDC claims do not match the production publisher");
  }
  return String(payload.workflow_ref);
}

async function readJson(request: Request): Promise<JsonObject> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONTROL_BODY_BYTES) {
    throw new Error("request body is empty or exceeds the size limit");
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as JsonObject;
}

function requiredString(
  object: JsonObject,
  key: string,
  pattern: RegExp,
): string {
  const value = object[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

function requiredDigestType(body: JsonObject): string {
  const value = body.digestType;
  if (typeof value !== "string" || !DELIVERY_TYPES.has(value)) {
    throw new Error("digestType must be daily or operational_error");
  }
  return value;
}

function requiredSessionDate(body: JsonObject): string {
  const value = requiredString(body, "sessionDate", /^\d{4}-\d{2}-\d{2}$/);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("sessionDate is not a real calendar date");
  }
  return value;
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("invalid contentBase64");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function putBlob(
  database: any,
  body: JsonObject,
): Promise<JsonObject> {
  const kind = body.kind;
  const runId = requiredString(body, "runId", /^[A-Za-z0-9._:-]{1,100}$/);
  const expectedHash = requiredString(body, "contentHash", /^[0-9a-f]{64}$/);
  const bytes = decodeBase64(body.contentBase64);
  let bucket: string;
  let path: string;
  let sizeLimit: number;
  let contentType = "application/gzip";
  let cacheControl = "31536000";

  if (kind === "chart") {
    // Compatibility path for one-file-per-ticker clients. The production
    // workflow uses chart-shard + chart-manifest below.
    const ticker = requiredString(body, "ticker", /^[A-Z0-9._-]{1,20}$/);
    bucket = CHART_BUCKET;
    path = `${runId}/${ticker}.json.gz`;
    sizeLimit = MAX_CHART_BYTES;
  } else if (kind === "chart-shard") {
    const shard = requiredString(body, "shard", /^\d{3,6}$/);
    bucket = CHART_BUCKET;
    path = `${runId}/shards/${shard}.json.gz`;
    sizeLimit = MAX_CHART_BYTES;
  } else if (kind === "chart-manifest") {
    bucket = CHART_BUCKET;
    path = `${runId}/manifest.json`;
    sizeLimit = MAX_CHART_MANIFEST_BYTES;
    contentType = "application/json";
  } else if (kind === "market-cache") {
    const shard = requiredString(body, "shard", /^[A-Za-z0-9._-]{1,120}$/);
    bucket = MARKET_CACHE_BUCKET;
    path = `${runId}/${shard}.bin.gz`;
    sizeLimit = MAX_MARKET_CACHE_SHARD_BYTES;
    // Data shards are immutable inside their active/inactive slot. The stable
    // manifest is the commit pointer and must be revalidated after each flip.
    if (shard === "manifest") cacheControl = "0";
  } else {
    throw new Error(
      "kind must be chart, chart-shard, chart-manifest, or market-cache",
    );
  }

  if (bytes.byteLength === 0 || bytes.byteLength > sizeLimit) {
    throw new Error(`${kind} blob is empty or exceeds its size limit`);
  }
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== expectedHash) {
    throw new Error("blob content hash mismatch");
  }
  if (kind === "chart-manifest") {
    parseChartManifest(bytes, runId, "stockscout-eod/charts-v1");
  }

  const { error } = await database.storage.from(bucket).upload(path, bytes, {
    upsert: true,
    contentType,
    cacheControl,
    metadata: { sha256: actualHash, runId },
  });
  if (error) throw new Error(`blob upload failed: ${error.message}`);
  return { bucket, path, byteSize: bytes.byteLength, contentHash: actualHash };
}

async function getMarketCacheUrl(
  database: any,
  body: JsonObject,
): Promise<JsonObject> {
  const runId = requiredString(body, "runId", /^[A-Za-z0-9._:-]{1,100}$/);
  const shard = requiredString(body, "shard", /^[A-Za-z0-9._-]{1,120}$/);
  const path = `${runId}/${shard}.bin.gz`;
  const { data, error } = await database.storage
    .from(MARKET_CACHE_BUCKET)
    .createSignedUrl(path, 300);
  if (error) throw new Error(`market cache lookup failed: ${error.message}`);
  return { path, signedUrl: data.signedUrl, expiresIn: 300 };
}

type ChartShardRecord = {
  name: string;
  sha256: string;
  bytes: number;
  tickerCount: number;
};

type ChartManifest = JsonObject & {
  schemaVersion: string;
  runId: string;
  requested: number;
  available: number;
  coveragePct: number;
  shards: ChartShardRecord[];
  shardsByTicker: Record<string, string>;
  storageBaseUrl?: string;
};

function chartStorageBaseUrl(runId: string): string {
  return `${
    requiredEnv("SUPABASE_URL").replace(/\/$/, "")
  }/storage/v1/object/public/${CHART_BUCKET}/${runId}`;
}

function isStorageNotFound(error: any): boolean {
  const status = Number(error?.statusCode ?? error?.status ?? 0);
  return status === 404 ||
    /not found|not_found|no such/i.test(String(error?.message ?? ""));
}

function storedObjectSize(item: any): number | null {
  const raw = item?.metadata?.size ?? item?.metadata?.contentLength ??
    item?.size;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function storedObjectHash(item: any): string | null {
  const value = item?.user_metadata?.sha256 ?? item?.userMetadata?.sha256 ??
    item?.metadata?.sha256;
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}

async function listStorageFiles(database: any, prefix: string): Promise<any[]> {
  const files: any[] = [];
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const { data, error } = await database.storage.from(CHART_BUCKET).list(
      prefix,
      { limit: 1000, offset, sortBy: { column: "name", order: "asc" } },
    );
    if (error) {
      throw new Error(`chart listing failed for ${prefix}: ${error.message}`);
    }
    const page = data ?? [];
    files.push(...page.filter((item: any) => item.id !== null));
    if (page.length < 1000) return files;
  }
  throw new Error(`chart listing safety limit reached for ${prefix}`);
}

async function downloadStorageObject(
  database: any,
  path: string,
): Promise<Uint8Array | null> {
  const { data, error } = await database.storage.from(CHART_BUCKET).download(
    path,
  );
  if (error) {
    if (isStorageNotFound(error)) return null;
    throw new Error(`chart download failed for ${path}: ${error.message}`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

function parseChartManifest(
  bytes: Uint8Array,
  runId: string,
  expectedSchema: string,
): ChartManifest {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHART_MANIFEST_BYTES) {
    throw new Error("chart manifest is empty or exceeds its size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("chart manifest is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("chart manifest must be an object");
  }
  const manifest = value as ChartManifest;
  if (manifest.schemaVersion !== expectedSchema || manifest.runId !== runId) {
    throw new Error("chart manifest schema or runId mismatch");
  }
  if (
    !Number.isInteger(manifest.requested) || manifest.requested < 1 ||
    !Number.isInteger(manifest.available) || manifest.available < 1 ||
    manifest.requested !== manifest.available || manifest.coveragePct !== 100
  ) {
    throw new Error("chart manifest does not provide complete coverage");
  }
  if (
    !Array.isArray(manifest.shards) || manifest.shards.length < 1 ||
    manifest.shards.length > 1000
  ) {
    throw new Error("chart manifest shard list is invalid");
  }
  if (
    !manifest.shardsByTicker || typeof manifest.shardsByTicker !== "object" ||
    Array.isArray(manifest.shardsByTicker)
  ) {
    throw new Error("chart manifest ticker map is invalid");
  }

  const names = new Set<string>();
  let tickerCount = 0;
  for (const shard of manifest.shards) {
    if (
      !shard || typeof shard !== "object" ||
      !/^\d{3,6}$/.test(shard.name) || names.has(shard.name) ||
      !/^[0-9a-f]{64}$/.test(shard.sha256) ||
      !Number.isInteger(shard.bytes) || shard.bytes < 1 ||
      shard.bytes > MAX_CHART_BYTES ||
      !Number.isInteger(shard.tickerCount) || shard.tickerCount < 0
    ) {
      throw new Error("chart manifest contains an invalid shard");
    }
    names.add(shard.name);
    tickerCount += shard.tickerCount;
  }
  const tickerEntries = Object.entries(manifest.shardsByTicker);
  if (
    tickerEntries.length !== manifest.available ||
    tickerCount !== manifest.available ||
    tickerEntries.some(([ticker, shard]) => !ticker || !names.has(shard))
  ) {
    throw new Error("chart manifest ticker map does not reconcile with shards");
  }
  if (
    expectedSchema === "stockscout-eod/charts-v1" &&
    manifest.storageBaseUrl !== chartStorageBaseUrl(runId)
  ) {
    throw new Error("public chart manifest storageBaseUrl mismatch");
  }
  return manifest;
}

function validateListedChartShards(
  files: any[],
  manifest: ChartManifest,
  label: string,
): void {
  const byName = new Map(files.map((item) => [String(item.name), item]));
  const expectedNames = new Set(
    manifest.shards.map((item) => `${item.name}.json.gz`),
  );
  if (
    byName.size !== expectedNames.size ||
    [...byName.keys()].some((name) => !expectedNames.has(name))
  ) {
    throw new Error(`${label} shard list does not match its manifest`);
  }
  for (const shard of manifest.shards) {
    const item = byName.get(`${shard.name}.json.gz`);
    const size = storedObjectSize(item);
    const hash = storedObjectHash(item);
    if (size !== null && size !== shard.bytes) {
      throw new Error(`${label} chart shard size mismatch: ${shard.name}`);
    }
    if (hash !== null && hash !== shard.sha256) {
      throw new Error(`${label} chart shard hash mismatch: ${shard.name}`);
    }
  }
}

async function verifyChartRunObjects(
  database: any,
  prefix: string,
  manifest: ChartManifest,
): Promise<void> {
  const rootFiles = await listStorageFiles(database, prefix);
  if (rootFiles.length !== 1 || rootFiles[0]?.name !== "manifest.json") {
    throw new Error(`chart run ${prefix} has unexpected root objects`);
  }
  validateListedChartShards(
    await listStorageFiles(database, `${prefix}/shards`),
    manifest,
    prefix,
  );
}

async function copyChartShardBatch(
  database: any,
  sourcePrefix: string,
  destinationPrefix: string,
  manifest: ChartManifest,
): Promise<number> {
  const destinationFiles = await listStorageFiles(
    database,
    `${destinationPrefix}/shards`,
  );
  const destinationByName = new Map(
    destinationFiles.map((item) => [String(item.name), item]),
  );
  let copied = 0;
  for (let offset = 0; offset < manifest.shards.length; offset += 12) {
    const batch = manifest.shards.slice(offset, offset + 12);
    await Promise.all(batch.map(async (shard) => {
      const filename = `${shard.name}.json.gz`;
      const existing = destinationByName.get(filename);
      if (existing) {
        const size = storedObjectSize(existing);
        const hash = storedObjectHash(existing);
        if (
          (size !== null && size !== shard.bytes) ||
          (hash !== null && hash !== shard.sha256)
        ) {
          throw new Error(
            `canonical chart shard conflicts with source: ${shard.name}`,
          );
        }
        return;
      }
      const { error } = await database.storage.from(CHART_BUCKET).copy(
        `${sourcePrefix}/shards/${filename}`,
        `${destinationPrefix}/shards/${filename}`,
      );
      if (error) {
        throw new Error(
          `chart shard copy failed: ${shard.name}: ${error.message}`,
        );
      }
      copied += 1;
    }));
  }
  validateListedChartShards(
    await listStorageFiles(database, `${destinationPrefix}/shards`),
    manifest,
    destinationPrefix,
  );
  return copied;
}

async function removeLegacyChartRun(
  database: any,
  prefix: string,
  manifest: ChartManifest,
): Promise<number> {
  const rootFiles = await listStorageFiles(database, prefix);
  const shardFiles = await listStorageFiles(database, `${prefix}/shards`);
  const expectedShards = new Set(
    manifest.shards.map((shard) => `${shard.name}.json.gz`),
  );
  if (
    rootFiles.some((item) => item.name !== "manifest.json") ||
    shardFiles.some((item) => !expectedShards.has(String(item.name)))
  ) {
    throw new Error("legacy chart prefix contains unexpected objects");
  }
  const paths = [
    ...rootFiles.map((item) => `${prefix}/${item.name}`),
    ...shardFiles.map((item) => `${prefix}/shards/${item.name}`),
  ];
  if (paths.length === 0) return 0;
  const { error } = await database.storage.from(CHART_BUCKET).remove(paths);
  if (error) throw new Error(`legacy chart cleanup failed: ${error.message}`);
  return paths.length;
}

async function promoteChartRun(
  database: any,
  body: JsonObject,
  ownerId: string,
): Promise<JsonObject> {
  const runId = requiredString(body, "runId", /^[A-Za-z0-9._:-]{1,100}$/);
  const sourcePrefix = `${ownerId}/${runId}`;
  const destinationPrefix = runId;
  const sourcePath = `${sourcePrefix}/manifest.json`;
  const destinationPath = `${destinationPrefix}/manifest.json`;
  const sourceBytes = await downloadStorageObject(database, sourcePath);

  if (sourceBytes === null) {
    const canonicalBytes = await downloadStorageObject(
      database,
      destinationPath,
    );
    if (canonicalBytes === null) {
      throw new Error("legacy and canonical chart manifests are missing");
    }
    const canonical = parseChartManifest(
      canonicalBytes,
      runId,
      "stockscout-eod/charts-v1",
    );
    await verifyChartRunObjects(database, destinationPrefix, canonical);
    const legacyRemoved = await removeLegacyChartRun(
      database,
      sourcePrefix,
      canonical,
    );
    return {
      runId,
      status: "already_promoted",
      copiedShards: 0,
      legacyRemoved,
    };
  }

  const legacy = parseChartManifest(
    sourceBytes,
    runId,
    "stockscout-eod/private-charts-v1",
  );
  await verifyChartRunObjects(database, sourcePrefix, legacy);
  const canonicalObject: ChartManifest = {
    ...legacy,
    schemaVersion: "stockscout-eod/charts-v1",
    storageBaseUrl: chartStorageBaseUrl(runId),
  };
  const canonicalBytes = new TextEncoder().encode(
    jcsStringify(canonicalObject),
  );
  const canonicalHash = await sha256Hex(canonicalBytes);
  const copiedShards = await copyChartShardBatch(
    database,
    sourcePrefix,
    destinationPrefix,
    canonicalObject,
  );

  const existingManifest = await downloadStorageObject(
    database,
    destinationPath,
  );
  if (existingManifest !== null) {
    if ((await sha256Hex(existingManifest)) !== canonicalHash) {
      throw new Error("canonical chart manifest conflicts with legacy source");
    }
  } else {
    const { error } = await database.storage.from(CHART_BUCKET).upload(
      destinationPath,
      canonicalBytes,
      {
        upsert: false,
        contentType: "application/json",
        cacheControl: "31536000",
        metadata: { sha256: canonicalHash, runId },
      },
    );
    if (error) {
      throw new Error(
        `canonical chart manifest upload failed: ${error.message}`,
      );
    }
  }

  const committedBytes = await downloadStorageObject(database, destinationPath);
  if (
    committedBytes === null ||
    (await sha256Hex(committedBytes)) !== canonicalHash
  ) {
    throw new Error("canonical chart manifest commit verification failed");
  }
  const committed = parseChartManifest(
    committedBytes,
    runId,
    "stockscout-eod/charts-v1",
  );
  await verifyChartRunObjects(database, destinationPrefix, committed);

  const legacyRemoved = await removeLegacyChartRun(
    database,
    sourcePrefix,
    legacy,
  );
  return {
    runId,
    status: "promoted",
    copiedShards,
    legacyRemoved,
    manifestHash: canonicalHash,
  };
}

async function activeCloudRunId(database: any): Promise<string | null> {
  const { data, error } = await database.from("eod_latest_scan").select(
    "run_id",
  )
    .maybeSingle();
  if (error) throw new Error(`active scan lookup failed: ${error.message}`);
  const value = (data as { run_id?: string } | null)?.run_id;
  return typeof value === "string" && value ? value : null;
}

async function removeCanonicalChartRun(
  database: any,
  runId: string,
): Promise<number> {
  const prefix = runId;
  let removed = 0;
  while (removed < 10_000) {
    const rootPaths = (await listStorageFiles(database, prefix)).map((item) =>
      `${prefix}/${item.name}`
    );
    const shardPaths = (await listStorageFiles(database, `${prefix}/shards`))
      .map(
        (item) => `${prefix}/shards/${item.name}`,
      );
    const paths = [...rootPaths, ...shardPaths];
    if (paths.length === 0) break;
    const { error } = await database.storage.from(CHART_BUCKET).remove(paths);
    if (error) throw new Error(`chart pruning failed: ${error.message}`);
    removed += paths.length;
  }
  if (removed >= 10_000) throw new Error("chart prune safety limit reached");
  return removed;
}

async function pruneChartRun(
  database: any,
  body: JsonObject,
): Promise<JsonObject> {
  const runId = requiredString(body, "runId", /^[A-Za-z0-9._:-]{1,100}$/);
  const protectedRunId = body.protectedRunId === undefined
    ? null
    : requiredString(body, "protectedRunId", /^[A-Za-z0-9._:-]{1,100}$/);
  const activeRunId = await activeCloudRunId(database);
  if (runId === activeRunId || runId === protectedRunId) {
    throw new Error("refusing to prune a protected chart run");
  }
  return { runId, removed: await removeCanonicalChartRun(database, runId) };
}

async function cleanupCloud(
  database: any,
  body: JsonObject,
  ownerId: string,
): Promise<JsonObject> {
  const protectedRunId = requiredString(
    body,
    "protectedRunId",
    /^[A-Za-z0-9._:-]{1,100}$/,
  );
  const cleanup = await database.rpc("eod_cleanup_abandoned_publish");
  if (cleanup.error) {
    throw new Error(
      `abandoned upload cleanup failed: ${cleanup.error.message}`,
    );
  }

  const activeRunId = await activeCloudRunId(database);
  const protectedRuns = new Set(
    [activeRunId, protectedRunId].filter((value): value is string =>
      Boolean(value)
    ),
  );

  const chartRuns: string[] = [];
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const { data, error } = await database.storage.from(CHART_BUCKET).list(
      "",
      {
        limit: 1000,
        offset,
        sortBy: { column: "name", order: "asc" },
      },
    );
    if (error) throw new Error(`chart run listing failed: ${error.message}`);
    const page = data ?? [];
    for (const item of page as Array<{ id: string | null; name: string }>) {
      if (
        item.id === null &&
        item.name !== ownerId &&
        !protectedRuns.has(item.name) &&
        /^[A-Za-z0-9._:-]{1,100}$/.test(item.name)
      ) {
        chartRuns.push(item.name);
      }
    }
    if (page.length < 1000) break;
    if (offset === 9000) {
      throw new Error("chart run cleanup safety limit reached");
    }
  }

  const pruned: JsonObject[] = [];
  for (const runId of chartRuns) {
    pruned.push({
      runId,
      removed: await removeCanonicalChartRun(database, runId),
    });
  }
  return {
    abandonedUploadsRemoved: Number(cleanup.data ?? 0),
    activeRunId,
    protectedPagesRunId: protectedRunId,
    chartRunsPruned: pruned,
  };
}

async function getDeliveryState(
  database: any,
  body: JsonObject,
  ownerId: string,
): Promise<JsonObject> {
  const digestType = requiredDigestType(body);
  const sessionDate = requiredSessionDate(body);
  const response = await database.rpc("eod_get_delivery_state", {
    p_user_id: ownerId,
    p_digest_type: digestType,
    p_session_date: sessionDate,
  });
  if (response.error) {
    throw new Error(`delivery state lookup failed: ${response.error.message}`);
  }
  if (!response.data || typeof response.data !== "object") {
    throw new Error("delivery state lookup returned an invalid state");
  }
  return response.data as JsonObject;
}

async function recordDeliveryProgress(
  database: any,
  body: JsonObject,
  ownerId: string,
): Promise<JsonObject> {
  const digestType = requiredDigestType(body);
  const sessionDate = requiredSessionDate(body);
  const contentHash = requiredString(body, "contentHash", /^[0-9a-f]{64}$/);
  const partCount = body.partCount;
  const lastPart = body.lastPart;
  const completed = body.completed;
  if (
    !Number.isInteger(partCount) || Number(partCount) < 1 ||
    Number(partCount) > 100
  ) {
    throw new Error("partCount must be an integer between 1 and 100");
  }
  if (
    !Number.isInteger(lastPart) ||
    Number(lastPart) < 0 ||
    Number(lastPart) > Number(partCount)
  ) {
    throw new Error("lastPart must be between 0 and partCount");
  }
  if (typeof completed !== "boolean") {
    throw new Error("completed must be boolean");
  }
  if (completed && lastPart !== partCount) {
    throw new Error("completed delivery must record the final part");
  }

  const response = await database.rpc("eod_record_delivery_progress", {
    p_user_id: ownerId,
    p_digest_type: digestType,
    p_session_date: sessionDate,
    p_content_hash: contentHash,
    p_part_count: partCount,
    p_last_part: lastPart,
    p_completed: completed,
  });
  if (response.error) {
    throw new Error(
      `delivery progress update failed: ${response.error.message}`,
    );
  }
  if (!response.data || typeof response.data !== "object") {
    throw new Error("delivery progress update returned an invalid state");
  }
  return response.data as JsonObject;
}

async function pagedRows(
  build: (offset: number, end: number) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>,
  label: string,
  safetyLimit = 10_000,
): Promise<AlertJsonRecord[]> {
  const rows: AlertJsonRecord[] = [];
  const pageSize = 1_000;
  for (let offset = 0; offset < safetyLimit; offset += pageSize) {
    const response = await build(offset, offset + pageSize - 1);
    if (response.error) {
      throw new Error(`${label} failed: ${response.error.message}`);
    }
    const page = Array.isArray(response.data)
      ? response.data as AlertJsonRecord[]
      : [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
  throw new Error(`${label} exceeded the ${safetyLimit}-row safety limit`);
}

async function evaluateAlerts(
  database: any,
  ownerId: string,
): Promise<JsonObject> {
  const latestResponse = await database
    .from("eod_latest_scan")
    .select("run_id,scan_date,market_data_date,health_status,published_at")
    .maybeSingle();
  if (latestResponse.error) {
    throw new Error(
      `active scan lookup failed: ${latestResponse.error.message}`,
    );
  }
  const latest = latestResponse.data as AlertJsonRecord | null;
  if (!latest?.run_id || !latest.scan_date) {
    return {
      status: "no_active_scan",
      pricesAreLive: false,
      alertCount: 0,
      insertedEventCount: 0,
      events: [],
      skipped: [],
    };
  }
  if (latest.health_status !== "healthy") {
    throw new Error("refusing to evaluate alerts against an unhealthy scan");
  }
  const runId = String(latest.run_id);
  const scanDate = String(latest.scan_date);

  const [alertRows, candidateRows, fieldRows] = await Promise.all([
    pagedRows(
      (offset, end) =>
        database
          .from("eod_alerts")
          .select("id,name,ticker,payload")
          .eq("user_id", ownerId)
          .eq("enabled", true)
          .order("created_at", { ascending: true })
          .range(offset, end),
      "enabled alert lookup",
      5_000,
    ),
    pagedRows(
      (offset, end) =>
        database
          .from("eod_latest_candidates")
          .select(
            "document_id,ticker,source,scan_order,trade_status,primary_setup,risk_level,scan_price,entry_risk_pct,ranking_score,record",
          )
          .order("source", { ascending: true })
          .order("scan_order", { ascending: true })
          .range(offset, end),
      "active candidate lookup",
    ),
    pagedRows(
      (offset, end) =>
        database
          .from("eod_latest_fields")
          .select("field_path")
          .order("field_path", { ascending: true })
          .range(offset, end),
      "alert field allowlist lookup",
      5_000,
    ),
  ]);

  const allowedFields = new Set(ALERT_EXTRACTED_FIELDS);
  for (const row of fieldRows) {
    if (typeof row.field_path === "string") allowedFields.add(row.field_path);
  }
  const candidates = candidateRows as AlertCandidate[];
  const evaluations = (alertRows as OwnerAlert[]).map((alert) =>
    evaluateOwnerAlert(alert, candidates, allowedFields)
  );
  const pendingEvents: AlertJsonRecord[] = [];
  for (const evaluation of evaluations) {
    for (const candidate of evaluation.matches) {
      const ticker = String(candidate.ticker ?? "");
      if (!/^[A-Z0-9._-]{1,20}$/.test(ticker)) {
        throw new Error("active scan contains an invalid alert ticker");
      }
      pendingEvents.push({
        user_id: ownerId,
        alert_id: evaluation.alertId,
        run_id: runId,
        event_key: alertEventKey(runId, evaluation.alertId, ticker),
        payload: alertEventPayload(evaluation, candidate, runId, scanDate),
      });
    }
  }
  if (pendingEvents.length > MAX_ALERT_EVENTS_PER_RUN) {
    throw new Error(
      `alert evaluation produced ${pendingEvents.length} events; narrow alerts below the ${MAX_ALERT_EVENTS_PER_RUN}-event safety limit`,
    );
  }

  const insertedEvents: AlertJsonRecord[] = [];
  for (let offset = 0; offset < pendingEvents.length; offset += 500) {
    const response = await database
      .rpc("eod_upsert_alert_events", {
        p_events: pendingEvents.slice(offset, offset + 500),
      });
    if (response.error) {
      throw new Error(`alert event insert failed: ${response.error.message}`);
    }
    if (Array.isArray(response.data)) {
      insertedEvents.push(...response.data as AlertJsonRecord[]);
    }
  }

  return {
    status: "ok",
    runId,
    scanDate,
    marketDataDate: latest.market_data_date ?? scanDate,
    healthStatus: latest.health_status,
    pricesAreLive: false,
    alertCount: evaluations.length,
    evaluatedAlertCount:
      evaluations.filter((item) => item.status === "evaluated").length,
    matchedEventCount: pendingEvents.length,
    insertedEventCount: insertedEvents.length,
    existingEventCount: pendingEvents.length - insertedEvents.length,
    events: insertedEvents,
    skipped: evaluations.filter((item) => item.status === "skipped").map(
      (item) => ({
        alertId: item.alertId,
        alertName: item.alertName,
        kind: item.kind,
        reason: item.reason,
      }),
    ),
  };
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  try {
    const workflowRef = await authorizeGithub(request);
    const body = await readJson(request);
    const action = body.action;
    const chartPromotionWorkflowRef =
      Deno.env.get("STOCKSCOUT_GITHUB_CHART_PROMOTION_WORKFLOW_REF")?.trim() ||
      DEFAULT_CHART_PROMOTION_WORKFLOW_REF;
    if (
      workflowRef === chartPromotionWorkflowRef &&
      action !== "promote_chart_run"
    ) {
      throw new Error("chart promotion workflow may only promote a chart run");
    }
    const database = createClient(
      requiredEnv("SUPABASE_URL"),
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
      {
        db: { schema: EDGE_API_SCHEMA },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const ownerId = await lookupSingleOwner(database);
    let data: unknown;

    if (action === "begin") {
      const manifest = body.manifest;
      if (
        !manifest || typeof manifest !== "object" || Array.isArray(manifest)
      ) {
        throw new Error("manifest must be an object");
      }
      const manifestObject = manifest as JsonObject;
      const expectedHash = requiredString(
        manifestObject,
        "manifestHash",
        /^[0-9a-f]{64}$/,
      );
      const actualHash = await sha256Hex(
        jcsStringify(
          Object.fromEntries(
            Object.entries(manifestObject).filter(([key]) =>
              key !== "manifestHash"
            ),
          ),
        ),
      );
      if (actualHash !== expectedHash) {
        throw new Error("manifest hash mismatch");
      }
      const response = await database.rpc("eod_begin_publish", {
        p_manifest: manifestObject,
      });
      if (response.error) {
        throw new Error(`begin failed: ${response.error.message}`);
      }
      data = response.data;
    } else if (action === "chunk") {
      const uploadId = requiredString(
        body,
        "uploadId",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      if (!Number.isInteger(body.chunkIndex) || Number(body.chunkIndex) < 0) {
        throw new Error("invalid chunkIndex");
      }
      if (
        !Array.isArray(body.records) || body.records.length < 1 ||
        body.records.length > 100
      ) {
        throw new Error("records must contain between 1 and 100 items");
      }
      for (const item of body.records) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error("invalid chunk record");
        }
        const row = item as JsonObject;
        const expectedHash = requiredString(
          row,
          "recordHash",
          /^[0-9a-f]{64}$/,
        );
        const record = row.record;
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          throw new Error("chunk record payload must be an object");
        }
        if (
          !row.summary || typeof row.summary !== "object" ||
          Array.isArray(row.summary)
        ) {
          row.summary = {};
        }
        if ((await publishRecordHash(row)) !== expectedHash) {
          throw new Error("publish record wrapper hash mismatch");
        }
      }
      const response = await database.rpc("eod_append_publish_chunk", {
        p_upload_id: uploadId,
        p_chunk_index: body.chunkIndex,
        p_records: body.records,
      });
      if (response.error) {
        throw new Error(`chunk failed: ${response.error.message}`);
      }
      data = response.data;
    } else if (action === "finalize") {
      const uploadId = requiredString(
        body,
        "uploadId",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      const response = await database.rpc("eod_finalize_publish", {
        p_upload_id: uploadId,
      });
      if (response.error) {
        throw new Error(`finalize failed: ${response.error.message}`);
      }
      data = response.data;
    } else if (action === "put_blob") {
      data = await putBlob(database, body);
    } else if (action === "get_market_cache") {
      data = await getMarketCacheUrl(database, body);
    } else if (action === "promote_chart_run") {
      data = await promoteChartRun(database, body, ownerId);
    } else if (action === "prune_chart_run") {
      data = await pruneChartRun(database, body);
    } else if (action === "cleanup") {
      data = await cleanupCloud(database, body, ownerId);
    } else if (action === "delivery_get") {
      data = await getDeliveryState(database, body, ownerId);
    } else if (action === "delivery_progress") {
      data = await recordDeliveryProgress(database, body, ownerId);
    } else if (action === "evaluate_alerts") {
      data = await evaluateAlerts(database, ownerId);
    } else {
      return json(400, { error: "unknown_action" });
    }

    return json(200, { ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "publish failed";
    const unauthorized = /OIDC|bearer token|JWT|signature|issuer|audience/i
      .test(message);
    return json(unauthorized ? 401 : 400, { ok: false, error: message });
  }
});
