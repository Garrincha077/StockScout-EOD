# Architecture

## One deterministic scan, four consumers

The scheduled workflow produces one immutable `run_id` and content hash. The
same validated snapshot feeds:

1. the public GitHub Pages PWA;
2. the latest Supabase/MCP index used by ChatGPT;
3. owner-only EOD alert evaluation and Telegram delivery;
4. a compact public 252-session comparison history.

No consumer may rescore or reorder candidates silently.

## Data contracts

- `ScanManifestV1` records schema, run/session dates, health, provenance,
  cardinality, ranking/detector versions, and every asset hash.
- `CandidateSummaryV1` is the compact Grid/Table projection and preserves
  `scan_order`.
- `CandidateDetailV1` is the sanitized full candidate with nested setups,
  evidence metadata, risk flags, exclusion status, and `trade_plan`.
- `ChartPayloadV1` contains compact five-year daily arrays plus weekly bars
  derived from the same window. A hashed chart index is part of the immutable
  Pages snapshot; gzip shards live at public, read-only Supabase Storage URLs.

Candidate IDs use `scan:{run_id}:candidate:{ticker}`. The current full snapshot
is immutable; activation occurs only by switching a small manifest/index after
all cardinality and hash checks pass.

## Failure isolation

- An unhealthy scan never replaces the last known good Pages deployment or
  Supabase snapshot.
- A Pages failure leaves the old site live and suppresses the normal digest.
- An MCP sync failure does not discard a healthy Pages scan; Telegram labels
  the ChatGPT index stale.
- Telegram delivery is multipart, idempotent, and resumable.
- Chart cleanup protects both the active cloud run and the exact run deployed
  on Pages, so an MCP sync failure cannot remove charts still used by the app.
