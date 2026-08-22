# Security boundary

## Public

- Source code, methodology documentation, synthetic fixtures.
- Sanitized derived scan fields, excluded reasons, health/provenance, and
  compact scan history.
- Supabase URL and publishable browser key, protected by RLS.

## Private

- Provider and Telegram credentials.
- Raw market caches, DuckDB stores, reports and backtest artifacts.
- Full custom chart payloads.
- Watchlists, saved screens, drawings, alerts, events and delivery state.

Production secrets live only in the protected GitHub `production` environment
or Supabase secrets. Pull-request workflows receive no production secrets.
Third-party Actions are pinned, permissions are job-scoped, and no
`pull_request_target` workflow is permitted.

All exposed Supabase tables require RLS plus explicit grants. Personal rows use
`(select auth.uid()) = user_id` for both read and write checks; authorization
never trusts user-editable metadata. Public clients never receive a secret or
service-role key.

