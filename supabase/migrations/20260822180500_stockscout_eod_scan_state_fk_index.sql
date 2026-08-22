-- The state table is a singleton, but indexing the foreign key keeps deletes
-- and advisor checks predictable without changing any query semantics.
create index eod_scan_state_active_scan_idx
  on public.eod_scan_state (active_scan_id);
