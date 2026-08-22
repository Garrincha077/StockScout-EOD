# StockScout-EOD

Public, mobile-first end-of-day stock screener. The Python scanner produces a
versioned, sanitized snapshot; the React/Vite PWA renders it on GitHub Pages.
Owner-only state and chart data live behind Supabase RLS.

## Non-negotiable rules

- `headline_ranking`, `focus_blend`, detector thresholds, and `trade_plan`
  semantics are frozen unless a preregistered backtest explicitly promotes a
  change.
- Ryan/LEGACY output is read-only confirmation and must never mutate the
  StockScout score or default order.
- Public assets may contain derived scan fields, but never raw provider caches,
  DuckDB files, local reports, credentials, personal state, or private chart
  payloads.
- Sizing is enabled only for `entry_ready` candidates with a valid tactical
  stop. Legacy invalidation fields are not sizing fallbacks.
- Scheduled scans run only after a completed US market session. Manual and test
  runs default to notifications disabled.
- Do not claim a workflow, deployment, or scan is healthy until its exact run
  has been verified.

## Required checks

- Python: unit/contract tests and engine parity fixtures.
- Frontend: Node tests, TypeScript build, and Pixel 5 + desktop Playwright.
- Data: manifest/hash/cardinality/secret-path audit and chart coverage audit.
- Supabase: owner/anon RLS negative tests, explicit grants, and advisors.

Record meaningful changes and validation evidence in `docs/PROJECT_LOG.md`.

