# StockScout-EOD OAuth MCP service

Deployable, read-mostly Model Context Protocol service for the public
StockScout-EOD app. The Vercel entrypoints expose Supabase OAuth consent,
protected-resource metadata, password reset, health, and stateless MCP HTTP.

The service uses the caller's verified Supabase JWT with the publishable key.
It does not use a service-role key, so `auth.uid()`, RLS, grants, and
`security_invoker` views remain authoritative.

## Tools

- Full EOD scan: `search`, `fetch`, `describe_scan_fields`, `screen_scan`
- History: `list_scans`, `compare_scans`
- Existing private workflow: `get_scan_status`, `list_volume_events`,
  `list_watch`, `list_actionable`, `explain_candidate`, `create_risk_preview`,
  `get_risk_preview`, `request_stage_untransmitted`, `get_staged_batch`

The four full-scan tools use the active `eod_latest_*` snapshot when one is
available. Before the first successful EOD activation they fall back to the
legacy `stockscout_api.full_scan_*` views. The other existing tools are not
overridden. Every scan response reports the scan date, health, and that prices
are not live. Candidate citations open the StockScout-EOD PWA.

## Configuration

Copy `.env.example` into Vercel environment settings and replace every
placeholder. `MCP_OAUTH_AUDIENCE` must be a resource-specific audience emitted
by the Supabase custom access-token hook in production. Use a random value of
at least 32 bytes for `MCP_CONSENT_COOKIE_SECRET`.

Required variables:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `MCP_RESOURCE_URL` (the public HTTPS MCP URL ending in `/mcp`)
- `MCP_RESOURCE_DOCUMENTATION_URL`
- `MCP_CANONICAL_BASE_URL`
- `MCP_OAUTH_AUDIENCE`
- `MCP_OAUTH_SCOPES`
- `MCP_CONSENT_COOKIE_SECRET`

Do not configure a Supabase secret/service-role key for this service.

## Verify and deploy

```bash
npm ci
npm test
```

Deploy this directory as its own Vercel project. `vercel.json` maps the OAuth,
password-reset, health, and `/mcp` routes to the TypeScript handlers. Apply the
repository's Supabase migrations before enabling the EOD fallback; until then,
the legacy scan tools continue to work.
