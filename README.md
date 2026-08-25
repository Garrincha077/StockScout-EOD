# StockScout-EOD

Mobile-first, end-of-day US market review built from the strongest parts of
StockScout, StockScreener-next, stock-screener2, and Ryan Hamby's original
scanner.

The public application is published at
[garrincha077.github.io/StockScout-EOD](https://garrincha077.github.io/StockScout-EOD/)
after the first healthy production scan. The read-only ChatGPT MCP endpoint is
`https://stockscout-paper.vercel.app/mcp`.

The PWA exposes the latest sanitized scan, compact 252-session history, and
lazy-loaded five-year EOD charts without requiring sign-in. Owner
authentication is only for synchronized watchlists, saved screens, drawings,
and EOD alerts.

## Product invariants

- StockScout's deterministic setup results and default scan order are
  authoritative.
- LEGACY is a transparent second opinion, never a hidden score modifier.
- `trade_plan` distinguishes entry trigger, structural invalidation, tactical
  stop, and readiness; sizing is available only when the candidate is
  `entry_ready` with a tactical stop.
- Every screen shows the scan date and data-health state. Prices are EOD, not
  live.

## Repository layout

- `src/stock_scout/` — portable production scanner and contracts.
- `scripts/` — EOD orchestration, artifact generation, health and security
  checks.
- `frontend/` — React/TypeScript installable PWA for GitHub Pages.
- `supabase/` — migrations and narrowly scoped publish functions.
- `services/` — read-only ChatGPT MCP service.
- `.github/workflows/` — CI, scheduled EOD scan, and atomic Pages deployment.

## Production workflow

GitHub Actions tries at 20:45 and 21:45 UTC on weekdays. An NYSE calendar guard
selects the first attempt after a completed US session and skips weekends,
holidays, early-close timing mistakes, and an already active session. A healthy
run builds one immutable snapshot for Pages, Supabase/MCP, alerts, and Telegram;
an unhealthy run leaves the previous snapshot live.

Scheduled Telegram delivery intentionally stays disabled through the five-session
parallel cutover. A manual workflow dispatch also defaults to `notify=false`.
See [operations and cutover](docs/OPERATIONS.md) for the exact commands and
activation gates.

## Local verification

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
.venv\Scripts\python.exe -m pytest

cd frontend
npm ci
npm run check
```

Manual scan workflows default to `notify=false`. Generated scan artifacts and
market caches are deliberately excluded from Git.

## Owner access

Charts and derived scan/setup data are available immediately. The single
allowlisted Supabase owner signs in only for watchlists, saved screens,
drawings, and EOD alerts. Sizing remains disabled unless
`trade_plan.status` is `entry_ready` and a valid tactical stop exists.

Owner password recovery requires this Supabase Auth redirect allowlist entry:

```text
https://garrincha077.github.io/StockScout-EOD/**
```

## Data and investment disclaimer

This project is for personal research and informational use. It is not
investment advice, a broker, or a guarantee of future results. Transcribed
setup rules are labeled separately from preregistered empirical evidence.

Raw provider caches are never committed to Git or exposed as downloadable
archives. The app publishes only the current run's compact five-year OHLCV
chart projection through read-only object URLs; personal state remains private.
