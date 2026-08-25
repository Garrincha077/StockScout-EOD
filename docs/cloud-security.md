# Cloud, publishing, and owner-state security

This slice is additive to the existing Supabase deployment. It must be reviewed
before the migration or Edge Function is applied. The current `full_scan_*`,
`stockscout_next_*`, OAuth, alerts, and MCP objects remain available as rollback
compatibility, while `services/stockscout_mcp` is a complete deployable OAuth
service rather than a source-only patch.

## Deployment gates

1. Apply `20260822163140_stockscout_eod_cloud_security.sql` and the later
   `20260824213000_public_chart_bucket.sql` only after a schema diff and
   Supabase security/performance advisor review. The initial migration seeds
   `stockscout_private.eod_owners` only when the legacy full-scan table proves
   exactly one distinct owner; more than one aborts and zero leaves it empty.
2. Verify Auth **Allow new users to sign up** is disabled. RLS also checks the
   private owner allowlist, so an accidental future signup still has no access
   to personal state. Never authorize from `user_metadata`.
3. Verify `stockscout_private.eod_owners` contains exactly the same UUID as the
   exactly one legacy full-scan owner before the first publish.
4. Deploy `stockscout-eod-publish` with `verify_jwt=false` only because it
   validates GitHub's external OIDC JWT itself. Required production claims are:
   audience `stockscout-eod-publish`, repository
   `Garrincha077/StockScout-EOD`, protected `refs/heads/main`, workflow
   `.github/workflows/eod.yml@refs/heads/main`, and environment `production`.
   The one-time chart promotion workflow is separately pinned and may call only
   `promote_chart_run`.
5. GitHub receives no Supabase secret/service-role key. It requests an OIDC
   token and calls `SUPABASE_URL/functions/v1/stockscout-eod-publish`; the Edge
   runtime alone uses its project-internal service key.
6. Preview-deploy the backward-compatible MCP service. Before an EOD activation
   exists, its four latest-scan tools must still return the current
   `stockscout_api.full_scan_*` data. Promote only after this fallback and OAuth
   consent are verified.

These gates follow current Supabase guidance on [explicit Data API grants and
RLS](https://supabase.com/docs/guides/api/securing-your-api), [RLS policy
performance](https://supabase.com/docs/guides/database/postgres/row-level-security),
[Storage access models](https://supabase.com/docs/guides/storage/buckets/fundamentals),
and [custom Edge Function authentication](https://supabase.com/docs/guides/functions/auth).
The April 2026 [Data API exposure change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
is handled by explicit grants in the migration.

## Data boundaries

- `eod_scans`, the active pointer, latest full derived candidates/fields, and
  the compact 252-session history are public read-only data. Mutations have no
  anon/authenticated policy or grant.
- `eod_watchlists`, `eod_saved_screens`, `eod_drawings`, `eod_alerts`, events,
  and delivery state require both owner allowlist membership and
  `auth.uid() = user_id`. Events and delivery markers are server-written.
- `stockscout-eod-charts` is public for object retrieval only. The app uses
  `{run_id}/manifest.json` plus lazy `{run_id}/shards/{shard}.json.gz` objects;
  no browser policy permits listing, insert, update, move, copy, or delete.
- `stockscout-eod-market-cache` has no browser policy. Only the OIDC publisher
  can read or write its content-hashed shards.
- All views are `security_invoker`; all write RPCs revoke default `PUBLIC`
  execute and grant only `service_role`. The private owner helper has a fixed
  empty search path and narrowly granted execute permission.

## Publish contract

Every request is `POST` JSON with `Authorization: Bearer <GitHub OIDC JWT>`.

- `begin`: `{action, manifest}`. `schemaVersion` is
  `stockscout-eod/v1`; `manifestHash` is SHA-256 of JCS canonical JSON after
  removing `manifestHash`. Repeating `begin` safely clears partial staging, so
  the publisher must resend every chunk.
- `chunk`: `{action, uploadId, chunkIndex, records}` with at most 100 rows.
  Every `recordHash` is SHA-256 of the JCS wrapper
  `{ticker,source,scanOrder,record,summary}`. The final `recordsHash` is
  SHA-256 of wrapper hashes sorted by `(source,ticker)` and joined with `\n`.
  The shared Python/Deno fixture is `jcs_fixture.json` beside the function.
- Chart blobs use `put_blob` with kind `chart-shard` or `chart-manifest`, a
  `runId`, content SHA-256 and base64 bytes. Upload all shards and manifest
  before activating the public scan with `finalize`; the Pages snapshot carries
  the matching hashed chart index, not the shard bytes.
- `finalize` verifies count/hash and atomically swaps the active scan. It keeps
  only current full records and up to 252 compact sessions. `cleanup` requires
  the Pages run ID and preserves it together with the cloud-active run before
  pruning other canonical chart runs.
- `delivery_get` reads the owner Telegram marker for allowlisted `digestType`
  (`daily` or `operational_error`) and `sessionDate`. `delivery_progress`
  atomically records `contentHash`, `partCount`, monotonic `lastPart`, and
  `completed`; completion is accepted only for the final part. Both actions
  derive the single allowlisted owner through a service-role-only RPC, never
  from request data. Zero or multiple owner rows fail closed.
- `evaluate_alerts` reads only the active healthy scan and enabled alerts for
  that same configured owner. Supported payload kinds are `ticker`,
  `trade_status`, and allowlisted `screen` filters. Existing nested screen
  groups imported with `_imported_kind: "screen"` remain supported. Chart,
  drawing, trendline and price kinds are returned as `skipped` because this EOD
  evaluator has no bar payload. Events use the idempotent key
  `{run_id}:{alert_id}:{ticker}`; a retry returns only newly inserted events.

## OAuth MCP deployment settings

Deploy `services/stockscout_mcp` as the companion Vercel project and configure
only these server variables (replace angle-bracket placeholders):

```ini
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
MCP_RESOURCE_URL=https://<mcp-host>.vercel.app/mcp
MCP_RESOURCE_DOCUMENTATION_URL=https://garrincha077.github.io/StockScout-EOD/
MCP_CANONICAL_BASE_URL=https://garrincha077.github.io/StockScout-EOD/
MCP_OAUTH_AUDIENCE=https://<mcp-host>.vercel.app/mcp
MCP_OAUTH_SCOPES=email
MCP_CONSENT_COOKIE_SECRET=<at-least-32-random-bytes>
```

Do not add a Supabase service-role/secret key to Vercel. In Supabase Auth,
enable the OAuth server and dynamic client registration, set the authorization
path to `/oauth/consent`, set the Site URL to
`https://<mcp-host>.vercel.app`, enable the existing custom access-token hook,
and make its resource audience exactly `MCP_RESOURCE_URL`. Add these password
recovery redirects to the Auth redirect allowlist:

- `https://<mcp-host>.vercel.app/password-reset`
- `https://garrincha077.github.io/StockScout-EOD/**`

The ChatGPT OAuth callback is dynamically registered by the client; do not
copy an unrelated callback URL between clients. The stable MCP URL entered in
ChatGPT is `https://<mcp-host>.vercel.app/mcp`.

## One-time local owner-state import

The helper has no default paths and performs no network call without
`--apply`. It never prints row contents, tokens, or response bodies:

```powershell
python scripts/migrate_owner_state.py `
  --user-id <OWNER_UUID> `
  --watchlists C:\explicit\watchlists.json `
  --drawings C:\explicit\drawings.json `
  --alerts C:\explicit\alerts.json
```

After inspecting counts, set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and a
short-lived `SUPABASE_USER_TOKEN`, then repeat with `--apply`. Upserts are
idempotent and source files are never changed or deleted.

## Verification (no deployment)

```powershell
python -m unittest tests/test_cloud_security_contract.py
cd services/stockscout_mcp
npm test
npx --yes deno check ../../supabase/functions/stockscout-eod-publish/index.ts
npx --yes deno test ../../supabase/functions/stockscout-eod-publish/jcs_test.ts ../../supabase/functions/stockscout-eod-publish/alerts_test.ts
```

After applying in a controlled environment, run Supabase security and
performance advisors, test anonymous chart GET plus denied listing/writes,
negative non-owner personal-state reads, owner CRUD, duplicate/out-of-order
chunks, corrupt hashes, interrupted
uploads, atomic activation, and exactly-252-session retention.
