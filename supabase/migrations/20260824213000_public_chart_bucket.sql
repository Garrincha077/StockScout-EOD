-- Charts are part of the login-free EOD product. Only object retrieval is
-- public; trusted OIDC publication continues to use the Edge service role.
do $$
begin
  if not exists (
    select 1 from storage.buckets where id = 'stockscout-eod-charts'
  ) then
    raise exception 'stockscout-eod-charts bucket is missing';
  end if;

  update storage.buckets
  set public = true
  where id = 'stockscout-eod-charts';

  if not exists (
    select 1
    from storage.buckets
    where id = 'stockscout-eod-market-cache' and public = false
  ) then
    raise exception 'private market-cache bucket invariant failed';
  end if;
end
$$;

-- Public bucket URLs bypass SELECT policies. Removing the obsolete owner-only
-- read policy avoids implying that chart retrieval still depends on login.
drop policy if exists eod_chart_owner_read on storage.objects;
