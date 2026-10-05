-- ============================================================================
-- LEGACY: legacy-add_manager_role.sql
-- SUPERSEDED by supabase/baseline.sql — kept for history only. DO NOT RUN.
-- Its objects are already present in the consolidated baseline, which is
-- also idempotent. This file is not.
-- ============================================================================

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'manager';

-- PostgreSQL has no `create policy if not exists`, so drop first. Dropping is
-- idempotent, and the statements below recreate the policies on every run.
drop policy if exists "managers_read_company_drivers" on public.profiles;

create policy "managers_read_company_drivers"
on public.profiles
for select
using (
  public.is_role('manager')
  or public.is_role('ceo')
  or public.is_role('developer')
);

drop policy if exists "managers_write_company_drivers" on public.profiles;

create policy "managers_write_company_drivers"
on public.profiles
for update
using (public.is_role('manager'))
with check (
  public.is_role('manager')
  and role = 'driver'
);

drop policy if exists "managers_read_company_cars" on public.cars;

create policy "managers_read_company_cars"
on public.cars
for select
using (
  public.is_role('manager')
  or public.is_role('ceo')
  or public.is_role('developer')
);

drop policy if exists "managers_write_company_cars" on public.cars;

create policy "managers_write_company_cars"
on public.cars
for insert
with check (public.is_role('manager'));

drop policy if exists "managers_update_company_cars" on public.cars;

create policy "managers_update_company_cars"
on public.cars
for update
using (public.is_role('manager'))
with check (public.is_role('manager'));

drop policy if exists "managers_read_company_documents" on public.driver_documents;

create policy "managers_read_company_documents"
on public.driver_documents
for select
using (
  public.is_role('manager')
  or public.is_role('ceo')
  or public.is_role('developer')
);

drop policy if exists "managers_write_company_documents" on public.driver_documents;

create policy "managers_write_company_documents"
on public.driver_documents
for insert
with check (public.is_role('manager'));

drop policy if exists "managers_update_company_documents" on public.driver_documents;

create policy "managers_update_company_documents"
on public.driver_documents
for update
using (public.is_role('manager'))
with check (public.is_role('manager'));
