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

