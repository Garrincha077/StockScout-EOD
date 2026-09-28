# Production operations and cutover

## What runs without the local computer

Production moved to `Garrincha077/StockScout-Unified`. Its `StockScout Unified
EOD` workflow is the canonical scheduled operator for scans, publication,
charts, owner alerts, Telegram delivery, and current cache handling.

This repository is retained as a historical fallback only. Its `StockScout EOD`
workflow has no schedule and must not be used as the production operator. The
legacy Supabase publisher and private market-cache path were retired on
2026-09-28 after they were identified as the source of repeated egress.

## Safe manual run

Run production recovery/backfill from the Unified repository. A manual run
defaults to no outward notification:

```powershell
gh workflow run eod.yml `
  --repo Garrincha077/StockScout-Unified `
  --ref main `
  -f scan_date=2026-09-25 `
  -f notify=false `
  -f force_full_refresh=false `
  -f reuse_existing=false
```

Use `notify=true` only when a real Telegram delivery is intended. Use
`force_full_refresh=true` only when the Next fundamentals cache must be
deliberately refreshed, and `reuse_existing=true` only to republish an already
verified session without running the scanners again.

## Failure behavior

- A health, schema, coverage, hash, or secret/path failure never activates a
  new Pages or Supabase snapshot.
- Pages deploy is atomic; a failed deployment leaves the previous site live.
- A cloud-index failure leaves the previous ChatGPT scan active. If Telegram is
  enabled, its header marks that the ChatGPT index is stale.
- Telegram parts are numbered, sent sequentially, deduplicated by content hash,
  and resumed from the last confirmed part.
- Chart shards and the private market cache never enter Pages or Git. Cleanup
  preserves both the cloud-active run and the exact run deployed on Pages;
  other canonical chart runs are removed after a later successful workflow.

## Five-session parity ledger

Cutover is temporal, not a same-day checkbox. For each completed market session,
provide sanitized scan JSON from the new GitHub run, the private local
StockScout run, and Stable. The tool joins strictly on `(ticker, date)` and
compares setup hits, `trade_plan`, and canonical order:

```powershell
$env:PYTHONPATH = "src"
python -m stockscout_eod cutover-evidence `
  --new C:\explicit\sanitized\new.json `
  --local C:\explicit\sanitized\local.json `
  --stable C:\explicit\sanitized\stable.json `
  --ledger-json .staging\cutover\ledger.json `
  --ledger-markdown .staging\cutover\ledger.md
```

Exit code `3` means the evidence is valid but the cutover gate is not ready.
The gate becomes ready only after five consecutive actual NYSE sessions pass.
Provider differences must identify their ticker/date/provenance; they are not
silently treated as engine differences. Ledger output is sanitized and remains
runtime data outside Git.

Do not enable scheduled Telegram or declare the new app canonical until:

1. five consecutive session comparisons are green;
2. chart coverage is 100% for every run and unauthenticated retrieval passes;
3. every selected Telegram ticker exists in the recombined parts;
4. MCP and Pages report the same `run_id` and manifest hash;
5. Pixel 5 and desktop E2E checks pass.

The previous repositories remain read-only fallbacks for at least 30 days after
cutover. They are not automatically archived or deleted.

## Cloud configuration checklist

- GitHub environment `production` is restricted to protected branches.
- `STOCKSCOUT_EOD_NOTIFY_ENABLED=false` remains set until cutover.
- GitHub contains only the Edge publish URL, browser-safe Supabase values, and
  optional provider/Telegram secrets; it contains no Supabase service-role key.
- Supabase signup is disabled, the owner allowlist contains exactly one user,
  and Auth redirect URLs include
  `https://garrincha077.github.io/StockScout-EOD/**`.
- The Vercel MCP has only a publishable Supabase key and its server-side OAuth
  consent secret. It contains no service-role key.

Supported cloud alert payloads are ticker membership, `trade_status`, and
allowlisted screen filters. Price, drawing, and trendline alerts remain visibly
`skipped` until the EOD alert contract receives bar data; they are never guessed.
