-- ============================================================================
-- LEGACY: legacy-schema.sql
-- SUPERSEDED by supabase/baseline.sql — kept for history only. DO NOT RUN.
-- Its objects are already present in the consolidated baseline, which is
-- also idempotent. This file is not.
-- ============================================================================

-- Astar Travels SaaS schema
create extension if not exists "pgcrypto";

create type public.app_role as enum ('driver', 'ceo', 'manager', 'developer', 'suspended');
create type public.car_status as enum ('active', 'servicing', 'inactive');
create type public.remittance_status as enum ('pending', 'paid', 'overdue');
create type public.document_status as enum ('pending', 'approved', 'rejected');

create or replace function public.is_role(target_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = target_role
  );
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text,
  role public.app_role not null default 'driver',
  phone text,
  created_at timestamptz not null default now()
);

create table if not exists public.system_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.cars (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  registration_number text not null unique,
  model text not null,
  year integer not null check (year between 2000 and 2100),
  status public.car_status not null default 'active',
  daily_rate numeric(10,2) not null check (daily_rate >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.daily_remittances (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles (id) on delete cascade,
  car_id uuid not null references public.cars (id) on delete cascade,
  amount numeric(10,2) not null check (amount >= 0),
  status public.remittance_status not null default 'pending',
  payment_reference text unique,
  payment_date timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.driver_documents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles (id) on delete cascade,
  document_type text not null,
  -- Legacy permanent URL. Nullable: new rows store `storage_path` and the
  -- client mints a short-lived signed URL. Buckets are private; see
  -- supabase/migrations/private_storage_buckets.sql.
  document_url text,
  storage_path text,
  storage_bucket text,
  status public.document_status not null default 'pending',
  uploaded_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  receiver_id uuid not null references public.profiles (id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  check (sender_id <> receiver_id)
);

create index if not exists idx_profiles_role on public.profiles (role);
create index if not exists idx_system_config_updated_at on public.system_config (updated_at desc);
create index if not exists idx_cars_company_id on public.cars (company_id);
create index if not exists idx_cars_status on public.cars (status);
create index if not exists idx_daily_remittances_driver_id on public.daily_remittances (driver_id);
create index if not exists idx_daily_remittances_car_id on public.daily_remittances (car_id);
create index if not exists idx_daily_remittances_status on public.daily_remittances (status);
create index if not exists idx_driver_documents_driver_id on public.driver_documents (driver_id);
create index if not exists idx_driver_documents_status on public.driver_documents (status);
create index if not exists idx_messages_sender_receiver on public.messages (sender_id, receiver_id);
create index if not exists idx_messages_created_at on public.messages (created_at desc);

alter table public.profiles enable row level security;
alter table public.system_config enable row level security;
alter table public.cars enable row level security;
alter table public.daily_remittances enable row level security;
alter table public.driver_documents enable row level security;
alter table public.messages enable row level security;

create policy "developers_manage_system_config"
on public.system_config
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

create policy "profiles_self_read"
on public.profiles
for select
using (auth.uid() = id);

create policy "profiles_ceo_read_all"
on public.profiles
for select
using (public.is_role('ceo'));

create policy "profiles_developer_read_all"
on public.profiles
for select
using (public.is_role('developer'));

create policy "profiles_self_manage"
on public.profiles
for insert
with check (auth.uid() = id);

create policy "profiles_self_update"
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id);

create policy "profiles_ceo_manage"
on public.profiles
for update
using (public.is_role('ceo'))
with check (public.is_role('ceo'));

create policy "profiles_developer_bypass"
on public.profiles
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

create policy "ceos_manage_all_cars"
on public.cars
for all
using (public.is_role('ceo'))
with check (public.is_role('ceo'));

create policy "developers_manage_all_cars"
on public.cars
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

create policy "driver_manage_own_remittances"
on public.daily_remittances
for all
using (auth.uid() = driver_id)
with check (auth.uid() = driver_id);

create policy "ceo_manage_all_remittances"
on public.daily_remittances
for all
using (public.is_role('ceo'))
with check (public.is_role('ceo'));

create policy "developer_bypass_remittances"
on public.daily_remittances
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

create policy "driver_manage_own_documents"
on public.driver_documents
for all
using (auth.uid() = driver_id)
with check (auth.uid() = driver_id);

create policy "ceo_manage_all_documents"
on public.driver_documents
for all
using (public.is_role('ceo'))
with check (public.is_role('ceo'));

create policy "developer_bypass_documents"
on public.driver_documents
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

create policy "driver_manage_own_messages"
on public.messages
for all
using (auth.uid() = sender_id or auth.uid() = receiver_id)
with check (auth.uid() = sender_id);

create policy "ceo_manage_all_messages"
on public.messages
for all
using (public.is_role('ceo'))
with check (public.is_role('ceo'));

create policy "developer_bypass_messages"
on public.messages
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

-- Optional helper trigger to auto-populate profiles on auth.users sign-up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data ->> 'role')::public.app_role, 'driver')
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();
