-- ============================================================================
-- LEGACY: legacy-manager-portal.sql
-- SUPERSEDED by supabase/baseline.sql — kept for history only. DO NOT RUN.
-- Its objects are already present in the consolidated baseline, which is
-- also idempotent. This file is not.
-- ============================================================================

-- Manager portal onboarding and operational schema enhancement
DO $$
BEGIN
  ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'manager';
END $$;

create table if not exists public.driver_onboarding_queue (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid references public.profiles(id) on delete set null,
  full_name text not null,
  phone text not null,
  national_id text not null,
  driving_license_number text not null,
  assigned_car text,
  daily_remittance_target numeric(10,2) not null default 0,
  verification_status text not null default 'needs_manual_review' check (verification_status in ('auto_verified', 'needs_manual_review')),
  setup_email text,
  setup_link text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'provisioned')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.driver_payouts (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(10,2) not null,
  payout_type text not null,
  status text not null default 'queued' check (status in ('queued', 'processed', 'review')),
  transaction_reference text unique,
  created_at timestamptz not null default now()
);

create table if not exists public.vehicle_maintenance (
  id uuid primary key default gen_random_uuid(),
  vehicle_registration text not null,
  issue_summary text not null,
  estimated_cost numeric(10,2) not null default 0,
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status text not null default 'open' check (status in ('open', 'scheduled', 'completed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_driver_onboarding_status on public.driver_onboarding_queue (status);
create index if not exists idx_driver_onboarding_verification on public.driver_onboarding_queue (verification_status);
create index if not exists idx_driver_payouts_driver on public.driver_payouts (driver_id);
create index if not exists idx_vehicle_maintenance_status on public.vehicle_maintenance (status);

alter table public.driver_onboarding_queue enable row level security;
alter table public.driver_payouts enable row level security;
alter table public.vehicle_maintenance enable row level security;

create policy "manager_can_read_own_onboarding"
on public.driver_onboarding_queue
for select
using (public.is_role('manager') or public.is_role('ceo') or public.is_role('developer'));

create policy "manager_can_manage_onboarding"
on public.driver_onboarding_queue
for all
using (public.is_role('manager'))
with check (public.is_role('manager'));

create policy "manager_can_manage_payouts"
on public.driver_payouts
for all
using (public.is_role('manager') or public.is_role('ceo') or public.is_role('developer'))
with check (public.is_role('manager') or public.is_role('ceo') or public.is_role('developer'));

create policy "manager_can_manage_vehicle_maintenance"
on public.vehicle_maintenance
for all
using (public.is_role('manager') or public.is_role('ceo') or public.is_role('developer'))
with check (public.is_role('manager') or public.is_role('ceo') or public.is_role('developer'));
