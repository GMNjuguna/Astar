-- =============================================================================
-- Developer health introspection
--
-- ── Why this needs SQL at all ───────────────────────────────────────────────
-- The Developer System Portal has to answer three questions that PostgREST
-- cannot reach:
--
--   1. How many RLS policies are actually active?
--   2. Do the three private buckets exist, are they private, and what are their
--      size limits and allowed MIME types?
--   3. How many objects does each bucket hold, and how many bytes do they use?
--
-- `pg_policies` is a `pg_catalog` view. PostgREST only exposes tables in the
-- schemas listed in the API config, so there is no `.from('pg_policies')` and no
-- way to reach it from `supabase-js` at any privilege level -- including the
-- service-role key, because the key bypasses RLS but not the schema allowlist.
--
-- `storage.buckets` and `storage.objects` are in the `storage` schema, which is
-- not in the exposed-schema list either. The Storage REST API can list buckets,
-- but only with the service-role key, and counting objects would mean paginating
-- every object in every bucket on every health check.
--
-- So this adds one narrow, developer-gated function that answers exactly those
-- three questions and nothing else. It is deliberately NOT a general-purpose
-- "run any SQL" escape hatch: no dynamic SQL, no caller-supplied table names, no
-- text that is concatenated into a statement.
--
-- ── Why `security definer` ─────────────────────────────────────────────────
-- A `security invoker` function would be bounded by the caller's RLS, and
-- `storage.objects` has no developer-wide policy -- its policies scope to driver
-- path prefixes (`(storage.foldername(name))[1] = auth.uid()::text`). A
-- developer would therefore count only their own uploads and be told the bucket
-- held three objects when it held three thousand. An invoker function would make
-- the health panel confidently wrong, which is the one thing it must not be.
--
-- ── Why the caller's role is checked INSIDE the function ───────────────────
-- `security definer` runs with the function owner's privileges, so RLS on the
-- underlying tables does not apply to it. Without an explicit gate the function
-- would hand any authenticated user a bucket inventory and a policy count. The
-- gate uses `public.is_role('developer')`, which is itself `security definer` and
-- reads `profiles.role` from the database, so it cannot be spoofed from the
-- client. It is re-checked on every call rather than trusted from a parameter.
--
-- ── Why EXECUTE is revoked from PUBLIC ─────────────────────────────────────
-- `CREATE FUNCTION` grants EXECUTE to PUBLIC by default. Every function here is
-- revoked from PUBLIC and from `anon` before being granted to `authenticated`,
-- so the only way in is a signed-in user who passes the role gate. Without the
-- revoke, revoking later would leave a window where anyone could call it.
-- =============================================================================

-- Guarded: the file must not fail on a project where `storage` does not exist.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise warning 'storage schema not found. Skipping developer_health_introspection(); the health endpoint will report storage as unavailable.';
    return;
  end if;

  -- -----------------------------------------------------------------------
  -- 1. RLS policy inventory
  -- -----------------------------------------------------------------------
  -- Counted per schema rather than as one total so a drop in the `storage`
  -- policies -- the ones protecting driver documents and credentials -- is
  -- distinguishable from a drop in the `public` ones. The two protect different
  -- things and a single number would hide which one moved.
  create or replace function public.developer_rls_policy_counts()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $$
    select jsonb_build_object(
      'public', (
        select count(*)::int
        from pg_policies
        where schemaname = 'public'
      ),
      'storage', (
        select count(*)::int
        from pg_policies
        where schemaname = 'storage'
      ),
      'total', (
        select count(*)::int
        from pg_policies
        where schemaname in ('public', 'storage')
      )
    );
  $$;

  -- -----------------------------------------------------------------------
  -- 2 & 3. Bucket inventory, object counts and byte usage
  -- -----------------------------------------------------------------------
  -- Returns a TABLE, not a `jsonb` object.
  --
  -- `returns table` is the shape the route's parser expects, and it is the right
  -- one here for a reason beyond parser convenience: PostgREST types a set-returning
  -- function as an array of row objects, so every column arrives under its own
  -- declared name. A hand-built `jsonb` object has to be re-keyed in TypeScript
  -- after every schema tweak, and the two spellings of the same field (`sizeBytes`
  -- vs `total_bytes`) is exactly how a parser and a query fall out of step.
  --
  -- `size_bytes` comes from `metadata->>'size'`, since that is where the Storage API
  -- records it. The cast is guarded: metadata is jsonb written by another service,
  -- so a row with a missing or non-numeric size must degrade to 0 bytes rather than
  -- abort the whole inventory.
  --
  -- `is_public` and `file_size_limit` are carried because a health panel that counts
  -- objects but cannot see whether a bucket is public has missed the most serious
  -- thing it could report: driver national IDs and face photos readable by anyone
  -- holding the URL. They are nullable in the payload for the same reason.
  create or replace function public.developer_storage_inventory()
  returns table (
    bucket_id text,
    is_public boolean,
    file_size_limit bigint,
    object_count bigint,
    total_bytes bigint
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $$
    select
      b.id::text,
      b.public,
      b.file_size_limit::bigint,
      counts.object_count::bigint,
      counts.size_bytes::bigint
    from storage.buckets b
    left join lateral (
      select
        count(*)::bigint as object_count,
        coalesce(sum(
          case
            when o.metadata ? 'size'
              and (o.metadata->>'size') ~ '^[0-9]+$'
            then (o.metadata->>'size')::bigint
            else 0
          end
        ), 0)::bigint as size_bytes
      from storage.objects o
      where o.bucket_id = b.id
    ) counts on true
    order by b.name;
  $$;

  -- -----------------------------------------------------------------------
  -- 5. Postgres connection pressure
  -- -----------------------------------------------------------------------
  -- `pg_stat_activity` and `pg_settings` are `pg_catalog` views. Neither is in the
  -- exposed-schema list, so there is no client-side route to them at any privilege
  -- level -- a service-role key bypasses RLS but not the schema allowlist.
  --
  -- `max_connections` is included rather than left implicit because it is the
  -- denominator that makes the figure mean something. Connection count without a
  -- ceiling is just a number; "412 of 500 connections in use" is the reading that
  -- tells an operator a project is about to start refusing connections, which is
  -- how Supabase actually presents exhaustion.
  --
  -- `state` is grouped rather than filtered on `backend_type` so the count reflects
  -- the client-facing pool. Rows where `state` is null (a backend mid-startup) fall
  -- into neither bucket, so `active + idle` can be less than `total`; that is
  -- reported rather than papered over by forcing the remainder into `idle`.
  create or replace function public.developer_connection_counts()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $$
    select jsonb_build_object(
      'total', (select count(*)::int from pg_stat_activity),
      'active', (select count(*)::int from pg_stat_activity where state = 'active'),
      'idle', (select count(*)::int from pg_stat_activity where state = 'idle'),
      'maxConnections', (
        select setting::int
        from pg_settings
        where name = 'max_connections'
      )
    );
  $$;

  -- -----------------------------------------------------------------------
  -- 6. Authoritative row counts, bypassing RLS
  -- -----------------------------------------------------------------------
  -- Each table is named literally in its own scalar subquery. This is verbose on
  -- purpose: a caller-supplied table name would need `format()` plus
  -- `regclass` casting, and that combination is exactly how a table-name
  -- injection gets written. There are four tables; four subqueries is cheaper
  -- than the risk.
  --
  -- `user_preferences` is included because a developer has NO policy on that
  -- table by design -- the schema comment at the table says so, and the absence
  -- is deliberate, because notification preferences are nobody else's business.
  -- Without this function the health panel can only report that developer's own
  -- preferences row and must label it as scoped. With it, the panel reports the
  -- true count and labels the table as unrestricted-for-developers, which is the
  -- fact an operator actually needs.
  create or replace function public.developer_table_counts()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $$
    select jsonb_build_object(
      'profiles', (select count(*)::int from public.profiles),
      'cars', (select count(*)::int from public.cars),
      'daily_remittances', (select count(*)::int from public.daily_remittances),
      'user_preferences', (select count(*)::int from public.user_preferences)
    );
  $$;
end;
$$;

-- =============================================================================
-- Grants
--
-- Every function above: revoke the default PUBLIC execute grant, then grant it
-- to `authenticated` only. `anon` never receives it, so an unauthenticated
-- request cannot reach the inventory even if it guesses the function name.
--
-- The role gate lives inside each function body, so the grant only narrows *who
-- can attempt a call*, not *who can succeed* -- an authenticated non-developer
-- receives `{"error":"forbidden"}` from inside the function. Both layers are
-- present deliberately: the grant keeps unauthenticated callers out of the
-- function entirely, the in-function check keeps authenticated non-developers
-- out of the data.
-- =============================================================================

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.developer_rls_policy_counts',
    'public.developer_storage_inventory',
    'public.developer_table_counts',
    'public.developer_connection_counts'
  ]
  loop
    -- Only revokes/grants when the function actually exists: if the storage
    -- schema was missing, the guard above never created them and this would
    -- raise on a null regclass.
    if to_regprocedure(fn) is not null then
      execute format('revoke execute on function %s from public', fn);
      execute format('revoke execute on function %s from anon', fn);
      execute format('grant execute on function %s to authenticated', fn);
    else
      raise warning 'Function % does not exist; skipping grant.', fn;
    end if;
  end loop;
end;
$$;