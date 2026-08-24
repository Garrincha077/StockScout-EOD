-- The complete active snapshot keeps two GIN indexes.  Building the initial
-- 2,224-row snapshot with the default 4 MB pending-list limit can repeatedly
-- flush those indexes while eod_finalize_publish is still inserting rows.
-- Keep the same indexes and atomic transaction, but give this one bounded bulk
-- load enough room for the measured index working set before commit.
-- Keep both the REST facade and implementation on the same bounded timeout:
-- the authenticator role otherwise starts the PostgREST statement with its
-- project-wide 8-second limit before the inner implementation is entered.
alter function public.eod_finalize_publish(uuid)
  set gin_pending_list_limit = '64MB';

alter function public.eod_finalize_publish(uuid)
  set statement_timeout = '60s';

alter function stockscout_api.eod_finalize_publish(uuid)
  set statement_timeout = '60s';
