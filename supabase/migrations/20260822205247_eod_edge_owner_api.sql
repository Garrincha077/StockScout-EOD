-- The project deliberately exposes stockscout_api instead of the broad public
-- schema. Keep EOD REST/RPC access behind narrow security-invoker facades;
-- never weaken the project boundary by exposing every public object.

create schema if not exists stockscout_api;
grant usage on schema stockscout_api to anon, authenticated, service_role;

-- Public, derived-only scan contracts. Raw OHLCV remains private storage data.
create or replace view stockscout_api.eod_scans
with (security_invoker = true)
as select * from public.eod_scans;

create or replace view stockscout_api.eod_candidate_history
with (security_invoker = true)
as select * from public.eod_candidate_history;

create or replace view stockscout_api.eod_latest_scan
with (security_invoker = true)
as select * from public.eod_latest_scan;

create or replace view stockscout_api.eod_latest_candidates
with (security_invoker = true)
as select * from public.eod_latest_candidates;

create or replace view stockscout_api.eod_latest_fields
with (security_invoker = true)
as select * from public.eod_latest_fields;

create or replace view stockscout_api.eod_scan_history
with (security_invoker = true)
as select * from public.eod_scan_history;

revoke all on table
  stockscout_api.eod_scans,
  stockscout_api.eod_candidate_history,
  stockscout_api.eod_latest_scan,
  stockscout_api.eod_latest_candidates,
  stockscout_api.eod_latest_fields,
  stockscout_api.eod_scan_history
from public, anon, authenticated, service_role;

grant select on table
  stockscout_api.eod_scans,
  stockscout_api.eod_candidate_history,
  stockscout_api.eod_latest_scan,
  stockscout_api.eod_latest_candidates,
  stockscout_api.eod_latest_fields,
  stockscout_api.eod_scan_history
to anon, authenticated, service_role;

-- Owner state stays protected by the underlying public-table RLS policies.
-- These are simple, automatically updatable views; security_invoker makes the
-- authenticated caller's grants and auth.uid() apply to every operation.
create or replace view stockscout_api.eod_watchlists
with (security_invoker = true)
as select * from public.eod_watchlists;

create or replace view stockscout_api.eod_saved_screens
with (security_invoker = true)
as select * from public.eod_saved_screens;

create or replace view stockscout_api.eod_drawings
with (security_invoker = true)
as select * from public.eod_drawings;

create or replace view stockscout_api.eod_alerts
with (security_invoker = true)
as select * from public.eod_alerts;

create or replace view stockscout_api.eod_alert_events
with (security_invoker = true)
as select * from public.eod_alert_events;

create or replace view stockscout_api.eod_delivery_state
with (security_invoker = true)
as select * from public.eod_delivery_state;

revoke all on table
  stockscout_api.eod_watchlists,
  stockscout_api.eod_saved_screens,
  stockscout_api.eod_drawings,
  stockscout_api.eod_alerts,
  stockscout_api.eod_alert_events,
  stockscout_api.eod_delivery_state
from public, anon, authenticated, service_role;

grant select, insert, update, delete on table
  stockscout_api.eod_watchlists,
  stockscout_api.eod_saved_screens,
  stockscout_api.eod_drawings,
  stockscout_api.eod_alerts
to authenticated;
grant select on table
  stockscout_api.eod_alert_events,
  stockscout_api.eod_delivery_state
to authenticated;
grant update (read_at) on table stockscout_api.eod_alert_events
  to authenticated;
grant select on table
  stockscout_api.eod_watchlists,
  stockscout_api.eod_saved_screens,
  stockscout_api.eod_drawings,
  stockscout_api.eod_alerts,
  stockscout_api.eod_alert_events,
  stockscout_api.eod_delivery_state
to service_role;

-- Service-only wrappers let the OIDC-authenticated Edge publisher use the
-- exposed schema while retaining the existing audited public RPC bodies.
create or replace function stockscout_api.eod_edge_single_owner_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select public.eod_single_owner_id();
$function$;

create or replace function stockscout_api.eod_begin_publish(p_manifest jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select public.eod_begin_publish(p_manifest);
$function$;

create or replace function stockscout_api.eod_append_publish_chunk(
  p_upload_id uuid,
  p_chunk_index integer,
  p_records jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select public.eod_append_publish_chunk(
    p_upload_id, p_chunk_index, p_records
  );
$function$;

create or replace function stockscout_api.eod_finalize_publish(
  p_upload_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select public.eod_finalize_publish(p_upload_id);
$function$;

create or replace function stockscout_api.eod_cleanup_abandoned_publish()
returns integer
language sql
security invoker
set search_path = ''
as $function$
  select public.eod_cleanup_abandoned_publish();
$function$;

create or replace function stockscout_api.eod_record_delivery_progress(
  p_user_id uuid,
  p_digest_type text,
  p_session_date date,
  p_content_hash text,
  p_part_count integer,
  p_last_part integer,
  p_completed boolean
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select public.eod_record_delivery_progress(
    p_user_id,
    p_digest_type,
    p_session_date,
    p_content_hash,
    p_part_count,
    p_last_part,
    p_completed
  );
$function$;

create or replace function stockscout_api.eod_get_delivery_state(
  p_user_id uuid,
  p_digest_type text,
  p_session_date date
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select public.eod_get_delivery_state(
    p_user_id, p_digest_type, p_session_date
  );
$function$;

-- PostgreSQL does not support ON CONFLICT against an updatable view. Keep the
-- alert insert idempotent in one service-only RPC backed by the real unique
-- constraint, and validate every JSON row before casting it.
create or replace function stockscout_api.eod_upsert_alert_events(
  p_events jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) < 1
     or jsonb_array_length(p_events) > 500 then
    raise exception 'alert events must contain between 1 and 500 rows'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_events) as e
    where coalesce(e->>'user_id', '')
        !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or coalesce(e->>'alert_id', '')
        !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or coalesce(e->>'run_id', '') !~ '^[A-Za-z0-9._:-]{1,100}$'
       or length(coalesce(e->>'event_key', '')) not between 1 and 200
       or jsonb_typeof(e->'payload') <> 'object'
  ) then
    raise exception 'invalid alert event payload' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_events) as e
    where not exists (
      select 1
      from public.eod_alerts a
      join stockscout_private.eod_owners o
        on o.user_id = a.user_id
      where a.id = (e->>'alert_id')::uuid
        and a.user_id = (e->>'user_id')::uuid
    )
  ) then
    raise exception 'alert event owner or alert is not allowlisted'
      using errcode = '42501';
  end if;

  with inserted as (
    insert into public.eod_alert_events (
      user_id, alert_id, run_id, event_key, payload
    )
    select
      (e->>'user_id')::uuid,
      (e->>'alert_id')::uuid,
      e->>'run_id',
      e->>'event_key',
      e->'payload'
    from jsonb_array_elements(p_events) as e
    on conflict (user_id, event_key) do nothing
    returning id, alert_id, run_id, event_key, payload, created_at
  )
  select coalesce(jsonb_agg(to_jsonb(inserted) order by id), '[]'::jsonb)
  into v_result
  from inserted;

  return v_result;
end;
$function$;

-- The REST facade is an updatable view, but PostgreSQL cannot use ON CONFLICT
-- against a view. This owner-only RPC preserves an atomic watchlist toggle.
create or replace function stockscout_api.eod_set_watchlist_ticker(
  p_name text,
  p_ticker text,
  p_present boolean
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null
     or p_present is null
     or p_name is null or length(p_name) not between 1 and 80
     or p_ticker is null or p_ticker !~ '^[A-Z0-9._-]{1,20}$'
     or not (select stockscout_private.eod_is_owner()) then
    raise exception 'watchlist owner or payload is invalid'
      using errcode = '42501';
  end if;

  if p_present then
    insert into public.eod_watchlists (user_id, name, ticker)
    values (v_user_id, p_name, p_ticker)
    on conflict (user_id, name, ticker) do nothing;
  else
    delete from public.eod_watchlists
    where user_id = v_user_id
      and name = p_name
      and ticker = p_ticker;
  end if;

  return true;
end;
$function$;

revoke all on function
  stockscout_api.eod_edge_single_owner_id(),
  stockscout_api.eod_begin_publish(jsonb),
  stockscout_api.eod_append_publish_chunk(uuid, integer, jsonb),
  stockscout_api.eod_finalize_publish(uuid),
  stockscout_api.eod_cleanup_abandoned_publish(),
  stockscout_api.eod_record_delivery_progress(
    uuid, text, date, text, integer, integer, boolean
  ),
  stockscout_api.eod_get_delivery_state(uuid, text, date),
  stockscout_api.eod_upsert_alert_events(jsonb),
  stockscout_api.eod_set_watchlist_ticker(text, text, boolean)
from public, anon, authenticated, service_role;

grant execute on function
  stockscout_api.eod_edge_single_owner_id(),
  stockscout_api.eod_begin_publish(jsonb),
  stockscout_api.eod_append_publish_chunk(uuid, integer, jsonb),
  stockscout_api.eod_finalize_publish(uuid),
  stockscout_api.eod_cleanup_abandoned_publish(),
  stockscout_api.eod_record_delivery_progress(
    uuid, text, date, text, integer, integer, boolean
  ),
  stockscout_api.eod_get_delivery_state(uuid, text, date),
  stockscout_api.eod_upsert_alert_events(jsonb)
to service_role;

grant execute on function
  stockscout_api.eod_set_watchlist_ticker(text, text, boolean)
to authenticated, service_role;

notify pgrst, 'reload schema';
