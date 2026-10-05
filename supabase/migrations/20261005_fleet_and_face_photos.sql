-- =============================================================================
-- Fleet management + driver face photos
--
-- The delta for the two features, written to be run on its own against a
-- database that already has `supabase/baseline.sql` applied.
--
-- Every statement is idempotent, so running this twice is harmless, and running
-- it after a full `baseline.sql` re-run is also harmless -- baseline.sql already
-- contains all of it. It exists as a separate file only so the change can be
-- reviewed and applied without re-running 130 statements.
--
-- NOTHING here is destructive: no DROP TABLE, no DROP COLUMN, no DROP SCHEMA.
-- Two `drop policy if exists` statements are the only drops, and each is
-- immediately preceded by the `create policy` it guards, so the table is never
-- left unprotected by a failure partway through.
-- =============================================================================


-- =============================================================================
-- 1. `cars.company_id` becomes nullable
--
-- Declared `not null` by an earlier schema, but nothing has ever populated it:
-- there is no `companies` table, `profiles` has no `company_id`, and no code in
-- app/, lib/ or components/ has ever referenced the column. Left as-is, no
-- vehicle could be inserted through the application, because there was no valid
-- value to supply.
--
-- The policies named `managers_*_company_cars` scope by role only -- none of them
-- test this column -- so relaxing it removes no existing enforcement.
--
-- Idempotent: dropping a constraint that is already absent is a no-op.
-- =============================================================================
alter table public.cars
  alter column company_id drop not null;


-- =============================================================================
-- 2. Face photo column on `profiles`
--
-- Stores an object KEY in the private `avatars` bucket, never a URL. A permanent
-- URL would hand out a durable link to someone's face; the key is resolved to a
-- short-lived signed URL per read instead.
--
-- Only `profiles` carries it, even though a queue row can exist without a driver
-- account: `/api/manager/create-driver` creates the auth user and the profile row
-- before it uploads anything, so there is always a profile to attach a photo to.
-- A second column on `driver_onboarding_queue` would have been
-- unreachable-by-any-code, which is worse than absent -- it would look wired up.
-- =============================================================================
alter table public.profiles
  add column if not exists driver_profile_photo_path text;


-- =============================================================================
-- 3. Vehicle deletion, by role
--
-- Deletion is permitted by role here, but the API refuses to delete a car that
-- still has remittance rows pointing at it.
--
-- That check cannot live in this policy. `daily_remittances.car_id` is declared
-- `on delete cascade`, so by the time the DELETE is authorised the dependent rows
-- are already being destroyed silently. RLS answers "may this person delete a car
-- at all?"; the route answers "is it safe to delete this specific one?", because
-- only the route can count the dependents and name the blocker in the error.
-- =============================================================================
drop policy if exists "fleet_managers_delete_cars" on public.cars;
create policy "fleet_managers_delete_cars"
on public.cars
for delete
using (
  public.is_role('manager')
  or public.is_role('ceo')
  or public.is_role('developer')
);


-- =============================================================================
-- 4. The private `avatars` bucket
--
-- Its own bucket rather than a folder in `driver-docs`. The payoff is
-- `allowed_mime_types`: the two document buckets permit PDF, so sharing one of
-- them would mean nothing below the application layer could stop a PDF being
-- written to a face-photo path. Here the bucket itself rejects any non-image,
-- which survives an application bug. Separating them also keeps a
-- document-retention sweep from deleting faces, and vice versa.
--
-- file_size_limit is 5242880 (5 MB) and the mime list is images only -- no PDF,
-- no SVG.
--
-- GUARDED for the same reason as section 7 of baseline.sql: `storage.buckets` is
-- owned by `supabase_storage_admin`, not by the role the SQL editor runs as, so
-- this can legitimately fail with "must be owner of table objects" even though
-- the same statement succeeds elsewhere. On failure it degrades to a WARNING so
-- a permissions problem cannot abort the policies in section 5.
--
-- ── MANUAL STEP IF YOU SEE THE WARNING ───────────────────────────────────────
-- Dashboard > Storage > New bucket:
--   name                    avatars
--   public                  OFF
--   file size limit         5 MiB
--   allowed MIME types      image/jpeg, image/png, image/webp
-- The app degrades gracefully without it -- uploads fail with a clear
-- `NoSuchBucket` message rather than silently succeeding -- but nothing works
-- until the bucket exists.
-- =============================================================================
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatars', 'avatars', false, 5242880,
      array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  raise notice 'OK: avatars bucket present, private, 5 MB, images only';
exception
  when others then
    raise warning 'storage.buckets not writable by this role (%). Create the bucket in Dashboard > Storage: name=avatars, public OFF, 5 MiB, allowed MIME types image/jpeg, image/png, image/webp. Continuing so the storage policies still apply.',
      substring(sqlerrm from 1 for 160);
end $$;


-- =============================================================================
-- 5. `storage.objects` policies for `avatars`
--
-- Separate policies rather than widening the document policies, because those
-- name `driver-docs` / `driver-credentials` explicitly in their `bucket_id` test
-- and would have to be re-audited every time a bucket is added.
--
-- A face-photo key is `<owner_uuid>/face-photo/avatar`. Only the FIRST path
-- segment is tested, which is what makes ownership derivable from the key rather
-- than trusted from a column -- the same scheme the document buckets use.
--
-- `for insert` + `for update` + `for delete` as separate policies rather than one
-- `for all`, so no policy here can accidentally be read as granting something it
-- was not written to grant.
--
-- Each is wrapped in its own block with an `applied` counter, so a single failure
-- reports which policy did not apply rather than aborting the transaction and
-- leaving the rest of the file unapplied. Check the final NOTICE/WARNING.
-- =============================================================================
do $$
declare
  applied int := 0;
  skipped text := '';
begin
  -- A driver may read their own face photo, and no one else's.
  begin
    drop policy if exists "drivers_read_own_avatar" on storage.objects;
    create policy "drivers_read_own_avatar"
    on storage.objects
    for select
    using (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' drivers_read_own_avatar';
  end;

  -- A driver may upload only under their own prefix.
  begin
    drop policy if exists "drivers_upload_own_avatar" on storage.objects;
    create policy "drivers_upload_own_avatar"
    on storage.objects
    for insert
    with check (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' drivers_upload_own_avatar';
  end;

  -- ... and may replace their own, which is what the fixed object key means.
  begin
    drop policy if exists "drivers_update_own_avatar" on storage.objects;
    create policy "drivers_update_own_avatar"
    on storage.objects
    for update
    using (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    )
    with check (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' drivers_update_own_avatar';
  end;

  -- A driver may remove their own (the Settings "remove" action).
  begin
    drop policy if exists "drivers_delete_own_avatar" on storage.objects;
    create policy "drivers_delete_own_avatar"
    on storage.objects
    for delete
    using (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' drivers_delete_own_avatar';
  end;

  -- Reviewers read every face photo: a compliance queue that cannot show who a
  -- document belongs to is not a review queue.
  begin
    drop policy if exists "reviewers_read_avatars" on storage.objects;
    create policy "reviewers_read_avatars"
    on storage.objects
    for select
    using (
      bucket_id = 'avatars'
      and (
        public.is_role('ceo')
        or public.is_role('manager')
        or public.is_role('developer')
      )
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' reviewers_read_avatars';
  end;

  -- Reviewers write too, which is what lets a manager attach a face photo at
  -- onboarding: the candidate's own policies cannot apply, because before the
  -- account is created there is no auth.uid() matching their namespace.
  begin
    drop policy if exists "reviewers_manage_avatars" on storage.objects;
    create policy "reviewers_manage_avatars"
    on storage.objects
    for insert
    with check (
      bucket_id = 'avatars'
      and (
        public.is_role('ceo')
        or public.is_role('manager')
        or public.is_role('developer')
      )
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' reviewers_manage_avatars';
  end;

  begin
    drop policy if exists "reviewers_update_avatars" on storage.objects;
    create policy "reviewers_update_avatars"
    on storage.objects
    for update
    using (
      bucket_id = 'avatars'
      and (
        public.is_role('ceo')
        or public.is_role('manager')
        or public.is_role('developer')
      )
    )
    with check (
      bucket_id = 'avatars'
      and (
        public.is_role('ceo')
        or public.is_role('manager')
        or public.is_role('developer')
      )
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' reviewers_update_avatars';
  end;

  begin
    drop policy if exists "reviewers_delete_avatars" on storage.objects;
    create policy "reviewers_delete_avatars"
    on storage.objects
    for delete
    using (
      bucket_id = 'avatars'
      and (
        public.is_role('ceo')
        or public.is_role('manager')
        or public.is_role('developer')
      )
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' reviewers_delete_avatars';
  end;

  if applied = 8 and skipped = '' then
    raise notice 'OK: all 8 avatars storage policies applied';
  else
    raise warning 'Applied % of 8 avatars storage policies. Not applied:%',
      applied, skipped;
  end if;
end $$;