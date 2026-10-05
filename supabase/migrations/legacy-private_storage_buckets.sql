-- ============================================================================
-- LEGACY: legacy-private_storage_buckets.sql
-- SUPERSEDED by supabase/baseline.sql — kept for history only. DO NOT RUN.
-- Its objects are already present in the consolidated baseline, which is
-- also idempotent. This file is not.
-- ============================================================================

-- Phase 1 security: private storage buckets + signed-URL access.
--
-- Driver credentials (national IDs, driving licences, passports) and driver
-- documents must never be world-readable. Both buckets are created explicitly
-- with `public = false` so a new Supabase project cannot default them to public.
--
-- Objects are addressed by their storage path, never by URL. Clients mint
-- short-lived signed URLs with `.createSignedUrl(path, 3600)` at the moment of
-- display.
--
-- Run once. Safe to re-run: policies are dropped before being recreated.

-- ---------------------------------------------------------------------------
-- 1. Buckets
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('driver-credentials', 'driver-credentials', false, 5242880, array['application/pdf', 'image/png', 'image/jpeg']),
  ('driver-docs', 'driver-docs', false, 5242880, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Object-level RLS
--
-- Paths are namespaced as `<driver_id>/<file>` so ownership is derivable from
-- the first path segment.
-- ---------------------------------------------------------------------------

alter table storage.objects enable row level security;

drop policy if exists "drivers_read_own_documents" on storage.objects;
drop policy if exists "drivers_upload_own_documents" on storage.objects;
drop policy if exists "drivers_delete_own_documents" on storage.objects;
drop policy if exists "reviewers_read_company_documents" on storage.objects;
drop policy if exists "reviewers_manage_credentials" on storage.objects;

-- Drivers may sign URLs for, and delete, only the objects under their own prefix.
create policy "drivers_read_own_documents"
on storage.objects
for select
using (
  bucket_id in ('driver-docs', 'driver-credentials')
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "drivers_upload_own_documents"
on storage.objects
for insert
with check (
  bucket_id in ('driver-docs', 'driver-credentials')
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "drivers_delete_own_documents"
on storage.objects
for delete
using (
  bucket_id in ('driver-docs', 'driver-credentials')
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- CEO, manager and developer review compliance documents, so they need read
-- access to both buckets. Writes stay with the owning driver and the
-- service-role API routes.
create policy "reviewers_read_company_documents"
on storage.objects
for select
using (
  bucket_id in ('driver-docs', 'driver-credentials')
  and (
    public.is_role('ceo')
    or public.is_role('manager')
    or public.is_role('developer')
  )
);

-- Managers onboard drivers and therefore create credential objects.
create policy "reviewers_manage_credentials"
on storage.objects
for insert
with check (
  bucket_id = 'driver-credentials'
  and (
    public.is_role('manager')
    or public.is_role('ceo')
    or public.is_role('developer')
  )
);

-- ---------------------------------------------------------------------------
-- 3. Track storage paths instead of URLs
--
-- `document_url` previously held a permanent public URL, which is unusable now
-- that both buckets are private. New rows store the object path in
-- `storage_path` and the client mints a short-lived signed URL on demand.
-- `document_url` is kept nullable for existing rows so no data is lost.
-- ---------------------------------------------------------------------------

alter table public.driver_documents
  add column if not exists storage_path text,
  add column if not exists storage_bucket text;

alter table public.driver_documents
  alter column document_url drop not null;
