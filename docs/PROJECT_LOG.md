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
