# StockScout-EOD project log

## 2026-08-22 — Clean unified bootstrap

- Started a new clean-history repository; the private StockScout repository and
  both existing public fallbacks remain untouched.
- Chosen architecture: GitHub-hosted deterministic EOD scan, public derived
  snapshot, owner-only custom charts/personal state, GitHub Pages PWA,
  Supabase-backed MCP and alert state.
- Imported the validated StockScreener-next frontend source without generated
  scan data and preserved LEGACY as shadow-only confirmation.
- Scoring/model impact: none intended; parity and invariant gates are required
  before any production cutover.
- Status: implementation in progress; no deployment or green CI claim yet.

## 2026-08-22 — Portable engine and EOD publication contract

- Allowlist-exported the production StockScout detector/scoring/trade-plan
  engine and current multipart Telegram renderer; frozen source hashes and an
  optional private-workspace parity check guard against silent drift.
- Added the `stockscout-eod/v1` manifest/core/detail/excluded/history contracts,
  immutable hash-addressed assets, NYSE close guard, and fail-closed coverage,
  date, provenance, secret/path, and raw-OHLCV gates.
- Added private gzip chart staging with ticker-to-shard lookup and direct GitHub
  OIDC publication; neither chart shards nor the ephemeral market cache are
  included in Pages or Actions artifacts.
- Verification: 66 tests passed, 2 intentionally skipped in public mode; the
  optional parity test passed against the private workspace; focused Ruff
  checks passed. No scan, notification, deployment, commit, or push was run.

## 2026-08-22 — Artifact/UI parity and LEGACY shadow execution

- Expanded the public summary into an allowlisted camelCase Grid/Table
  projection and flattened detail shards so the mobile UI receives the same
  derived candidate fields without a hidden wrapper. Added deterministic
  ticker-to-detail-shard lookup to the core asset.
- Corrected serialized `focusBlend` and headline rank evaluation to call the
  frozen blend with the actual score, RS, setup-quality, and actionability
  inputs. Original `scanOrder` remains unchanged.
- Added the MIT-attributed Ryan phase/Minervini engine as a separate shadow
  sidecar in the EOD workflow. Its output is explicitly observational
  (`affectsRanking: false`) and cannot change StockScout score, order, trade
  plan, or sizing.
- Verification: 81 tests passed and 2 intentionally skipped in public mode
  before final formatting checks; no scan, notification, deployment, commit,
  or push was run.

## 2026-08-22 — Atomic cloud snapshot publisher

- Added a separate `CloudPublishManifestV1` built only from a verified public
  snapshot. It carries every candidate and excluded record, a scalar field
  catalog, asset provenance, counts, and deterministic content hashes without
  changing scan order or ranking values.
- Implemented GitHub OIDC begin/chunk/finalize publication with idempotent
  chunks, bounded retry, and the Edge/SQL JCS wrapper-hash contract. Local
  validation fails before any request when record, aggregate, catalog, or
  manifest hashes do not reconcile.
- Added cloud-publish and private market-cache CLI entry points. Tests use an
  in-memory Edge double only; no network request, scan, notification,
  deployment, commit, or push was made.
- Verification: 13 focused publisher tests passed, including a 2,200-row
  round trip, out-of-order and duplicate chunks, bad hashes, retry identity,
  and the shared cross-language JCS fixture; focused Ruff checks passed.

## 2026-08-22 — Owner PWA, cloud cutover plumbing and production MCP

- Added the mobile Grid/Table/Detail PWA, Today/New/Changes review, excluded and
  history views, lazy owner-only chart shards, owner watchlists/screens/drawings/
  alerts, and non-enumerating password recovery. Sizing remains gated by
  `entry_ready` plus a real tactical stop.
- Added the GitHub-native NYSE session guard, private market cache, health and
  chart-coverage gates, atomic Pages artifact, OIDC Supabase publication,
  supported EOD alert evaluation, and resumable multipart Telegram delivery.
- Added the deployable OAuth MCP with `search`, `fetch`,
  `describe_scan_fields`, `screen_scan`, `list_scans`, and `compare_scans`.
  Production was redeployed at `https://stockscout-paper.vercel.app/mcp`; its
  protected-resource metadata and unauthenticated `401` challenge were smoke
  tested against the canonical URL.
- Applied the additive Supabase EOD migration and covering scan-state FK index.
  Owner-state import completed with 21 watchlist rows, 11 drawings, and 24
  alerts; owner/non-owner/anon RLS and execute-grant boundaries were verified.
- Added a sanitized five-session cutover ledger that joins `(ticker, date)` and
  keeps provider divergences distinct from detector/ranking differences. The
  production cutover is intentionally not claimed before five real sessions.
- Final local verification: Ruff, actionlint, recursive path checks and Gitleaks
  passed; Python 125 passed/2 intentionally skipped, frontend 46 unit + 10
  Pixel 5/desktop E2E passed, MCP 13 passed, Edge 6 passed, and both npm audits
  reported zero vulnerabilities. Supabase advisors show no new EOD security
  warning and the new scan-state FK warning is resolved; unrelated
  legacy-project notices remain out of scope.

## 2026-08-22 — Cross-platform and OAuth CI hardening

- Canonicalized frozen-source fingerprints to LF so the same allowlisted engine
  hashes verify on Windows and Linux without changing scanner source or logic.
- Made the credential-history scan fetch the complete Git history on pull
  requests, preserving the repository-wide secret boundary.
- Replaced the readable signed OAuth session cookie with versioned AES-256-GCM
  authenticated encryption. Fresh nonces, authenticated version metadata and
  strict parsing reject tampered, legacy, malformed and wrong-key cookies.
- Verification: Python 125 passed/2 intentionally skipped, frontend 46 tests
  and production build passed, and MCP 14 passed including the new cookie
  confidentiality/tamper regression. The hosted CI and CodeQL rerun remain the
  final merge gate.

## 2026-08-24 — Narrow PostgREST facade for the first EOD run

- The first manually dispatched, notification-disabled EOD run for 2026-08-21
  stopped safely before scanning or deployment while restoring the private
  market cache. The Edge publisher had implicitly selected the unexposed
  `public` API schema, so Supabase rejected the owner lookup. The prior Pages
  app, cloud snapshot and Telegram state were unchanged.
- Added an explicitly exposed `stockscout_api` facade with security-invoker
  views, minimal role grants and service-only wrapper RPCs. The Edge publisher,
  MCP data source and owner browser client now select that schema explicitly;
  the broad `public` schema remains unexposed.
- Replaced view-based conflict writes with bounded, validated RPCs for alert
  events and atomic owner watchlist toggles. Market-cache restore now treats
  only a real missing object as a cold bootstrap and fails closed on permission
  or service errors.
- Local verification: Python 129 passed/2 intentionally skipped, frontend 46
  tests and production build passed, MCP 14 passed, and Edge 9 passed with a
  clean Deno type check. Production migration, deployment and the retry run
  remain gated on a green pull request.

## 2026-08-24 — Resumable atomic market-cache refresh

- The notification-disabled retry run `32745729860` completed the deterministic
  scan, health gate, Ryan shadow, 100% private chart coverage, chart publication,
  public snapshot build and public hash/cardinality audit. It stopped safely
  during the final private cache refresh after uploading 196 of 256 shards: the
  `c4` request hit a 120-second read timeout. No cache manifest was written, so
  the partial upload never became active; Pages, cloud activation and Telegram
  remained unchanged.
- The root-cause audit also found that the publisher reused one GitHub OIDC JWT
  across the entire upload: the final Edge success occurred almost exactly at
  that short-lived token's five-minute boundary. The client now reads the JWT
  `exp` claim only to refresh it 60 seconds early during long publish and restore
  operations; Supabase Edge remains the authority that verifies every token.
- Added three-attempt bounded retries for transient Edge POST and signed-Storage
  download failures. Each attempt obtains a still-valid bearer while reusing
  identical canonical payload bytes and content hash; authorization, validation
  and other protocol failures still fail immediately.
- Changed rolling cache publication to two alternating object slots. All shards
  are written to the inactive slot before the stable manifest is committed, so
  an interrupted later refresh keeps the prior cache restorable. Slot zero
  retains legacy object names to reuse the safe first-run partial upload, and
  legacy manifests remain readable. The mutable manifest now has zero Storage
  cache lifetime while immutable slot shards retain the long cache lifetime.
- Local verification: 30 focused cache/security-contract tests passed; the full
  Python suite passed 140 tests with 2 intentional public-mode skips; Ruff and
  whitespace checks passed, and Edge format/type checks plus all 9 Edge tests
  passed. No scanner, ranking, detector, trade-plan, report or notification
  behavior was changed; production deployment remains gated on the pull request.

## 2026-08-24 — First healthy Pages run and cloud-finalize optimization

- The notification-disabled verification run `32755523760` produced the healthy
  `2026-08-21-eod-32755523760-1` snapshot: 2,209 candidates plus 15 excluded,
  99.93% market coverage, 100% owner chart coverage and all 256 private cache
  shards. After enabling workflow-based GitHub Pages, deployment and the exact
  Pages run/hash pointer verification passed without rerunning the scan.
- Supabase accepted all 2,224 idempotent cloud staging rows but its atomic
  finalize rolled back at the PostgREST authenticator's inherited 8-second
  statement timeout. The 90-second limit on the inner implementation could not
  extend the already-started exposed wrapper call. The prior cloud snapshot
  remained active and downstream alerts/Telegram did not run.
- A live temporary-table benchmark measured the bounded indexed bulk-load path:
  the unchanged full payload and both existing indexes completed in 26.608
  seconds when the transaction used a 64 MB GIN pending-list limit; separate
  bulk heap/vector and index construction completed in 30.972 seconds. The
  migration gives finalize that scoped limit while preserving the JSONB/
  full-text indexes and atomic cutover. Both the exposed wrapper and inner
  implementation share a scoped 60-second fail-safe; the project-wide role
  timeout is unchanged. No scan, ranking, detector, trade-plan, public record or
  search semantics changed. Exact production activation remains the final gate.

## 2026-08-24 — Active ChatGPT snapshot and complete field allowlist lookup

- The exact notification-disabled publish retry activated all 2,224 records for
  `2026-08-21-eod-32755523760-1`; alert evaluation and cleanup passed, while
  Telegram remained intentionally disabled. Database cardinality, health,
  records hash and removal of the completed staging upload were verified.
- The first authenticated production MCP smoke test then exposed stale Vercel
  code that still selected the now-unexposed `public` API schema. Redeploying
  current `main` restored ticker, full-text and exact `entry_ready` screening.
- A real RWB query found a second boundary case: the active field catalog has
  1,145 paths, while screening fetched an arbitrary first 1,000 before checking
  requested paths. Screening now asks the allowlisted catalog only for its at
  most 23 explicitly referenced filter/sort fields. This keeps arbitrary JSON
  paths rejected and does not alter records, setup logic, ranking or search
  semantics.
- The standalone natural-language term `RWB` now takes setup precedence instead
  of also being parsed as a three-letter ticker. Zero-match search, describe and
  screen responses resolve their context from the active scan history, so they
  still report the correct dated health state rather than `legacy_snapshot`.

## 2026-08-24 — Recover GitHub Pages ticker deep links

- The first public snapshot exposed two independent blank-screen failures. Its
  market regime is a nested object, while several React views rendered that object
  directly; additionally, the PWA used relative bundle URLs, so a cached shell
  served at `/ticker/*` requested nonexistent `/ticker/assets/*` files.
- Market regime rendering now accepts both the legacy scalar and production
  nested shape. The Pages build uses repository-absolute assets, shell v3
  redirects canonical ticker navigations through the query-preserving fallback,
  and a bounded compatibility entry recovers clients still controlled by the
  only deployed shell-v2 bundle.
- Added a manual shell-only Pages repair workflow. It restores the successful
  `github-pages` artifact selected by workflow run ID, proves the public manifest
  hash is byte-identical before deployment, and verifies the exact live run and
  entry asset afterward. It cannot run a scan, cloud publish or notification.
- Local verification used the real `2026-08-21-eod-32755523760-1` artifact and
  preserved manifest SHA-256
  `47f288d096dfe446871a338bedef32a18d5f0a6db62b3ae644468a629e83b709`.
  A simulated stale shell-v2 request and a fresh direct PSNL route both rendered
  the healthy app with `UNDER PRESSURE`, no failed requests and no console
  errors. Python passed 142 tests with 2 intentional skips, Ruff passed,
  frontend passed 48 Node tests, production build and all 10 Pixel 5/desktop
  Playwright cases.

## 2026-08-25 — Login-free current-run charts

- Removed chart loading from owner authentication. The PWA now resolves a
  hashed chart index and immutable gzip shards without a Supabase session;
  owner login remains only for watchlists, saved screens, drawings and alerts.
- Chart publication now uses non-personal `{run_id}` Storage prefixes. A
  narrowly pinned OIDC workflow can promote the existing owner-prefixed active
  run once, verifies the canonical manifest/shards, and removes legacy objects
  only after the public commit is complete.
- Added a migration that makes only `stockscout-eod-charts` publicly retrievable.
  Browser listing and writes remain denied, while the raw market-cache bucket
  and all personal tables remain private. Cleanup protects both the cloud-active
  run and the exact Pages run.
- Limited published chart data to five years of daily OHLCV and weekly bars
  derived from that window. Shard bytes remain outside Git/Pages; Pages carries
  only the chart manifest and hashes.
- Local evidence: 32 focused Python artifact/security tests passed, 49 frontend
  Node tests and the production build passed, and all 10 Pixel 5/desktop
  Playwright cases passed. Production migration, Edge deployment and live
  anonymous chart verification remain explicit final cutover gates.

## 2026-08-25 — Actionable chart-publisher failures

- The one-time legacy chart promotion returned HTTP 400, but Python's urllib
  raised before the publisher could surface its bounded JSON error message.
  The client now reports only the publisher's sanitized `error`/`message`
  field, capped at 500 characters, without response headers or OIDC tokens.
- Added a regression test for the HTTP error path. The focused chart tests and
  Ruff pass; this is diagnostics-only and does not change chart data, scan
  output, ranking, detector or trade-plan behavior.
