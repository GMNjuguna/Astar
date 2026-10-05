-- =============================================================================
-- Astar Travels — consolidated baseline
-- =============================================================================
--
-- Single source of truth for the database. Replaces the previous split across
-- schema.sql, manager-portal-migration.sql, migrations/add_manager_role.sql and
-- migrations/private_storage_buckets.sql, which had to be applied in a
-- specific order and could not be re-run.
--
-- IDEMPOTENT. Safe to run on an empty project and safe to run again on an
-- already-provisioned one. Every statement either checks for its own existence
-- or drops before it creates.
--
-- SUPABASE SQL EDITOR: section 7 touches tables owned by the storage service
-- (`supabase_storage_admin`), which the editor's role does not own. Those
-- statements are wrapped so they emit a WARNING instead of aborting the run.
-- The run always reaches sections 8 and 9, which carry the two security fixes
-- (no self-assigned role at sign-up, no self-promotion afterwards). Read the
-- warnings after running: any WARNING from section 7 means the storage policies
-- still need applying via Dashboard > Storage > Policies.
--
-- Run it in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -f supabase/baseline.sql
--
-- To verify afterwards, run the check query in section 8.
--
-- Ordering inside this file matters: enums -> is_role() -> tables -> indexes ->
-- RLS enablement -> policies -> buckets -> storage policies -> trigger.
-- =============================================================================


-- =============================================================================
-- 1. Extensions and enums
-- =============================================================================

create extension if not exists "pgcrypto";

-- PostgreSQL has no `create type if not exists`, so each enum is wrapped in a
-- block that swallows the duplicate-object error. The `alter type ... add value`
-- afterwards is what actually guarantees `manager` is present, including on
-- databases provisioned before the enum included it.
do $$ begin
  create type public.app_role as enum ('driver', 'ceo', 'manager', 'developer', 'suspended');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.car_status as enum ('active', 'servicing', 'inactive');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.remittance_status as enum ('pending', 'paid', 'overdue');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.document_status as enum ('pending', 'approved', 'rejected');
exception
  when duplicate_object then null;
end $$;

-- Safe on PostgreSQL 12+. The DO block is required for older servers, where
-- ADD VALUE cannot run inside a transaction block.
do $$ begin
  alter type public.app_role add value if not exists 'manager';
end $$;

-- `action_required` is distinct from `rejected`: a rejected document has been
-- reviewed and refused, whereas `action_required` means the driver must
-- re-upload something before it can be reviewed at all. Reusing `rejected`
-- would make the two indistinguishable in the review queue, and the driver
-- would be told their document was refused when in fact it was never read.
--
-- Added separately because `create type ... as enum` is a no-op when the type
-- already exists, so extending the original declaration would never reach a
-- database provisioned before this value existed.
--
-- A value added here cannot be *used* until the transaction commits, so nothing
-- in this file writes it; only the application does, on a later request.
do $$ begin
  alter type public.document_status add value if not exists 'action_required';
end $$;


-- =============================================================================
-- 2. Tables
--
-- Declared before `is_role()` is created (section 3) so the function body has
-- something to resolve against at creation time.
-- =============================================================================

-- NOTE: the `references auth.users` foreign key is deliberately NOT inline.
-- `create table if not exists` still resolves an inline REFERENCES clause even
-- when the table already exists, which requires the REFERENCES privilege on
-- auth.users. The SQL editor's role does not hold that privilege, so an inline
-- FK makes this file fail on every run after the first. The constraint is added
-- separately below, inside a guarded block.
create table if not exists public.profiles (
  id uuid primary key,
  email text not null unique,
  full_name text,
  role public.app_role not null default 'driver',
  phone text,
  created_at timestamptz not null default now(),
  -- Account state, separate from `role`. `role` answers "what may this person
  -- do"; `status` answers "is this account usable yet". A driver who has been
  -- onboarded but not approved is role='driver' *and* status='pending' — a
  -- distinction the role column alone cannot express.
  --
  -- Defaults to 'active' rather than 'pending' so that existing rows and the
  -- `on_auth_user_created` trigger keep their current behaviour: making new
  -- sign-ups default to pending would lock out every self-registered driver
  -- until someone reviewed them.
  status text not null default 'active'
    check (status in ('active', 'pending', 'suspended'))
);

-- profiles.id -> auth.users.id, cascading so that deleting an auth user removes
-- their profile. Guarded for the same ownership reason as sections 7 and 8.
-- `pg_constraint` is consulted rather than `information_schema` because the
-- latter hides constraints on tables the current role cannot fully access.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_id_fkey
      foreign key (id) references auth.users (id) on delete cascade;
    raise notice 'OK: profiles_id_fkey added (profiles.id -> auth.users.id, on delete cascade)';
  else
    raise notice 'OK: profiles_id_fkey already present';
  end if;
exception
  when insufficient_privilege then
    raise warning 'Cannot add profiles_id_fkey (no REFERENCES on auth.users). Deleting an auth user will leave an orphan profiles row. Add it as a role owning auth.users.';
  when others then
    raise warning 'profiles_id_fkey not added: %', substring(sqlerrm from 1 for 160);
end $$;

create table if not exists public.system_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.cars (
  id uuid primary key default gen_random_uuid(),
  -- Nullable on purpose, and deliberately NOT a foreign key.
  --
  -- This column was declared `not null` by an earlier version of the schema, but
  -- nothing has ever populated it: there is no `companies` table, `profiles` has
  -- no `company_id`, and no application code has ever referenced `company_id` at
  -- all (verified by grep across app/, lib/ and components/). It is unfinished
  -- multi-tenancy scaffolding, and leaving it `not null` meant no vehicle could
  -- ever be inserted through the application, because no valid value existed to
  -- supply.
  --
  -- The RLS policies below are named `managers_*_company_cars` but scope by role
  -- only -- they never test this column -- so relaxing it to nullable removes no
  -- existing enforcement. If multi-tenancy is ever implemented properly, this
  -- column should become a foreign key to a real `companies` table at the same
  -- time the policies are rewritten to scope by it.
  company_id uuid,
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
  -- Legacy permanent URL. Retained so historical rows are not lost. New rows
  -- leave this null and store the object key in `storage_path` instead, because
  -- both buckets are private and a permanent URL would leak credentials.
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

-- Manager portal tables.
create table if not exists public.driver_onboarding_queue (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid references public.profiles (id) on delete set null,
  full_name text not null,
  phone text not null,
  national_id text not null,
  driving_license_number text not null,
  assigned_car text,
  daily_remittance_target numeric(10,2) not null default 0,
  verification_status text not null default 'needs_manual_review'
    check (verification_status in ('auto_verified', 'needs_manual_review')),
  setup_email text,
  setup_link text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'provisioned')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  -- The driver account this queue entry was submitted for, once one exists.
  --
  -- Nullable on purpose: a manager can submit a candidate who has never signed
  -- up, so an entry may legitimately have no account yet. Approving such an
  -- entry updates the queue row and reports that no profile was activated,
  -- rather than inventing an id and writing to a row that does not exist.
  driver_id uuid references public.profiles (id) on delete set null,
  -- Object keys in the private `driver-credentials` bucket, for the scans the
  -- manager uploaded when submitting the candidate. `national_id` /
  -- `driving_license_number` above are the identifier *strings*; these are the
  -- files, and without them there is nothing to preview or re-sign later.
  national_id_storage_path text,
  driving_license_storage_path text,
  -- Required when status = 'rejected' by application logic (not by a CHECK,
  -- because the database cannot express "only sometimes").
  rejection_reason text
);

create table if not exists public.driver_payouts (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles (id) on delete cascade,
  amount numeric(10,2) not null,
  payout_type text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processed', 'review')),
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

-- Per-user settings for the Profile & Settings tab.
--
-- Deliberately not stored in `system_config`: that table is a single global
-- key/value space, so a per-user setting written there would either collide
-- between users or be readable by every developer regardless of who set it.
--
-- `user_id` is both the primary key and the foreign key, which makes the "at
-- most one row per user, and it belongs to them" invariant structural rather
-- than a matter of a unique index plus a policy. `on delete cascade` means
-- deleting an auth user takes the preferences with it, so no orphans survive an
-- account deletion.
--
-- Only `theme` is stored server-side. Email/SMS toggles are here too so the
-- choice follows the account across devices; the theme is additionally mirrored
-- into localStorage by next-themes, because a theme that has not resolved yet
-- renders as a flash of the wrong colour scheme.
create table if not exists public.user_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  email_alerts boolean not null default true,
  sms_reminders boolean not null default false,
  -- 'system' resolves against the OS preference at render time and is never
  -- expanded server-side, so the stored value stays honest about what the user
  -- chose rather than recording whichever theme happened to be active.
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  updated_at timestamptz not null default now()
);

-- For databases provisioned from the older schema, where these columns did not
-- exist and `document_url` was NOT NULL. Both statements are no-ops otherwise.
alter table public.driver_documents
  add column if not exists storage_path text,
  add column if not exists storage_bucket text;

alter table public.driver_documents
  alter column document_url drop not null;

-- `create table if not exists` skips the whole declaration when the table is
-- already present, so every column added to an existing table needs its own
-- idempotent ALTER. The statements below are no-ops on a database that already
-- has them. `driver_id` is added without a foreign key for the same ownership
-- reason as `profiles_id_fkey`: the inline REFERENCES would need privileges on
-- public.profiles that the SQL editor's role may not hold.

alter table public.profiles
  add column if not exists status text not null default 'active'
    check (status in ('active', 'pending', 'suspended'));

alter table public.driver_onboarding_queue
  add column if not exists driver_id uuid,
  add column if not exists national_id_storage_path text,
  add column if not exists driving_license_storage_path text,
  add column if not exists rejection_reason text;

-- Fleet management: `cars.company_id` loses its `not null` on databases created
-- from the older schema. Idempotent -- dropping a constraint that is already
-- absent is a no-op, not an error.
alter table public.cars
  alter column company_id drop not null;

-- Driver face photos.
--
-- Stored as an object KEY in the private `avatars` bucket, never as a URL. A
-- permanent URL would leak the photo to anyone who ever saw it, which for a
-- biometric-adjacent image is the whole risk this feature introduces. The path
-- is resolved to a short-lived signed URL at read time and re-minted per view.
--
-- Only `profiles` carries it, even though a queue entry can exist without a
-- driver account. The onboarding route (`/api/manager/create-driver`) creates the
-- auth user and the profile row *before* it uploads anything, so by the time a
-- face photo is attached there is always a profile to attach it to, and the
-- reviewer surfaces (manager driver list, CEO approval queue) all resolve through
-- `driver_documents.driver_id` anyway. A second column on
-- `driver_onboarding_queue` would have been unreachable-by-any-code, which is
-- worse than absent: it would look wired up.
alter table public.profiles
  add column if not exists driver_profile_photo_path text;


-- =============================================================================
-- 3. Helper function
--
-- `security definer` with a pinned `search_path` so the `profiles` reference
-- cannot be hijacked via a caller-controlled search_path.
-- =============================================================================

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


-- =============================================================================
-- 4. Indexes
-- =============================================================================

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
create index if not exists idx_driver_onboarding_status on public.driver_onboarding_queue (status);
create index if not exists idx_driver_onboarding_verification
  on public.driver_onboarding_queue (verification_status);
create index if not exists idx_driver_payouts_driver on public.driver_payouts (driver_id);
create index if not exists idx_vehicle_maintenance_status on public.vehicle_maintenance (status);


-- =============================================================================
-- 5. Enable RLS
--
-- Non-idempotent by nature, and harmless on repeat: enabling RLS on a table
-- that already has it is a no-op and does not drop existing policies.
-- =============================================================================

alter table public.profiles enable row level security;
alter table public.system_config enable row level security;
alter table public.cars enable row level security;
alter table public.daily_remittances enable row level security;
alter table public.driver_documents enable row level security;
alter table public.messages enable row level security;
alter table public.driver_onboarding_queue enable row level security;
alter table public.driver_payouts enable row level security;
alter table public.vehicle_maintenance enable row level security;
alter table public.user_preferences enable row level security;


-- =============================================================================
-- 6. Policies
--
-- PostgreSQL has no `create policy if not exists`, so every policy is preceded
-- by a `drop policy if exists`. Both statements are idempotent.
-- =============================================================================

-- --- system_config -------------------------------------------------------
drop policy if exists "developers_manage_system_config" on public.system_config;
create policy "developers_manage_system_config"
on public.system_config
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

-- The assistant reads the chatbot prompts on behalf of every signed-in role.
--
-- Without this, only `developer` can read them: an RLS-denied SELECT returns an
-- empty result set rather than an error, so a manager or driver asking a
-- question would silently get the hardcoded bootstrap prompt while the
-- Developer portal showed the saved one — correct-looking, and wrong.
--
-- Scoped to the two prompt keys on purpose. `system_config` is a generic
-- key/value store that also holds feature flags and is a plausible future home
-- for credentials, so a blanket authenticated-read policy would widen access to
-- future secrets. Widening this later is a one-line change; narrowing it after a
-- secret lands would be an incident.
drop policy if exists "authenticated_read_chatbot_prompts" on public.system_config;
create policy "authenticated_read_chatbot_prompts"
on public.system_config
for select
using (
  public.is_role('developer')
  or key in ('chatbot.system_prompt', 'chatbot.fallback_prompt')
);

-- --- profiles ------------------------------------------------------------
drop policy if exists "profiles_self_read" on public.profiles;
create policy "profiles_self_read"
on public.profiles
for select
using (auth.uid() = id);

drop policy if exists "profiles_ceo_read_all" on public.profiles;
create policy "profiles_ceo_read_all"
on public.profiles
for select
using (public.is_role('ceo'));

drop policy if exists "profiles_developer_read_all" on public.profiles;
create policy "profiles_developer_read_all"
on public.profiles
for select
using (public.is_role('developer'));

-- SECURITY: `role = 'driver'` is load-bearing, not decorative. Without it this
-- policy permits
--   supabase.from('profiles').insert({ id: <own id>, email, role: 'ceo' })
-- which is a direct privilege escalation: the guard trigger in section 9 only
-- fires BEFORE UPDATE, so an INSERT sails straight past it. That matters most
-- when the sign-up trigger in section 8 could not be attached (no profiles row is
-- created for you, so the INSERT path is the only way to get one) but the hole
-- exists regardless.
--
-- Privilege grants are therefore never made through a client INSERT. They go via
-- service_role (app/api/manager/create-driver writes role='driver' this way) or
-- out of band.
drop policy if exists "profiles_self_manage" on public.profiles;
create policy "profiles_self_manage"
on public.profiles
for insert
with check (auth.uid() = id and role = 'driver');

-- SECURITY: this policy is restricted to the caller's own row, but RLS `with
-- check` clauses cannot name columns — `auth.uid() = id` constrains *which row*
-- is written, never *what is written to it*. On its own this policy would let any
-- user rewrite the role and status of their own profile. What actually stops
-- that is `profiles_guard_role_change` in section 9, which can and does reject
-- privileged-column writes by an unprivileged actor. The two layers are only
-- meaningful together: this one keeps the blast radius to your own row, the
-- trigger decides whether the change to it is allowed.
drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update"
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "profiles_ceo_manage" on public.profiles;
create policy "profiles_ceo_manage"
on public.profiles
for update
using (public.is_role('ceo'))
with check (public.is_role('ceo'));

drop policy if exists "profiles_developer_bypass" on public.profiles;
create policy "profiles_developer_bypass"
on public.profiles
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

-- Managers read all profiles so they can resolve CEO ids and list drivers.
drop policy if exists "managers_read_company_drivers" on public.profiles;
create policy "managers_read_company_drivers"
on public.profiles
for select
using (
  public.is_role('manager')
  or public.is_role('ceo')
  or public.is_role('developer')
);

-- Managers may update driver rows, and may only write rows whose role stays
-- 'driver'. The `with check` is what stops a manager promoting themselves to ceo
-- by editing their own profile.
drop policy if exists "managers_write_company_drivers" on public.profiles;
create policy "managers_write_company_drivers"
on public.profiles
for update
using (public.is_role('manager'))
with check (
  public.is_role('manager')
  and role = 'driver'
);

-- --- cars ----------------------------------------------------------------
drop policy if exists "ceos_manage_all_cars" on public.cars;
create policy "ceos_manage_all_cars"
on public.cars
for all
using (public.is_role('ceo'))
with check (public.is_role('ceo'));

drop policy if exists "developers_manage_all_cars" on public.cars;
create policy "developers_manage_all_cars"
on public.cars
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

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

-- Deletion is permitted by role here, but the API refuses to delete a car that
-- still has remittance rows pointing at it.
--
-- That check cannot live in this policy. `daily_remittances.car_id` is declared
-- `on delete cascade`, so at the moment the DELETE is authorised the dependent
-- rows are about to be destroyed silently -- and the only place that can see
-- "is anything referencing this car?" and report which rows is the route, before
-- it issues the statement. RLS answers "may this person delete a car at all?";
-- the route answers "is it safe to delete this specific one?".
drop policy if exists "fleet_managers_delete_cars" on public.cars;
create policy "fleet_managers_delete_cars"
on public.cars
for delete
using (
  public.is_role('manager')
  or public.is_role('ceo')
  or public.is_role('developer')
);

-- --- daily_remittances ---------------------------------------------------
drop policy if exists "driver_manage_own_remittances" on public.daily_remittances;
create policy "driver_manage_own_remittances"
on public.daily_remittances
for all
using (auth.uid() = driver_id)
with check (auth.uid() = driver_id);

drop policy if exists "ceo_manage_all_remittances" on public.daily_remittances;
create policy "ceo_manage_all_remittances"
on public.daily_remittances
for all
using (public.is_role('ceo'))
with check (public.is_role('ceo'));

drop policy if exists "developer_bypass_remittances" on public.daily_remittances;
create policy "developer_bypass_remittances"
on public.daily_remittances
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

-- Managers aggregate remittances for the dashboard overview. Without this the
-- route has to fall back to the service-role client, which bypasses RLS.
drop policy if exists "managers_read_all_remittances" on public.daily_remittances;
create policy "managers_read_all_remittances"
on public.daily_remittances
for select
using (public.is_role('manager'));

-- --- driver_documents ----------------------------------------------------
drop policy if exists "driver_manage_own_documents" on public.driver_documents;
create policy "driver_manage_own_documents"
on public.driver_documents
for all
using (auth.uid() = driver_id)
with check (auth.uid() = driver_id);

drop policy if exists "ceo_manage_all_documents" on public.driver_documents;
create policy "ceo_manage_all_documents"
on public.driver_documents
for all
using (public.is_role('ceo'))
with check (public.is_role('ceo'));

drop policy if exists "developer_bypass_documents" on public.driver_documents;
create policy "developer_bypass_documents"
on public.driver_documents
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

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

-- --- messages ------------------------------------------------------------
-- NOTE the name is historical. Despite reading "driver", this applies to EVERY
-- authenticated user with no role restriction, because the manager/CEO chat
-- panel needs it. The name is kept so existing grants and references do not
-- break. `with check (auth.uid() = sender_id)` is what stops a user forging
-- messages that appear to come from someone else.
drop policy if exists "driver_manage_own_messages" on public.messages;
create policy "driver_manage_own_messages"
on public.messages
for all
using (auth.uid() = sender_id or auth.uid() = receiver_id)
with check (auth.uid() = sender_id);

drop policy if exists "ceo_manage_all_messages" on public.messages;
create policy "ceo_manage_all_messages"
on public.messages
for all
using (public.is_role('ceo'))
with check (public.is_role('ceo'));

drop policy if exists "developer_bypass_messages" on public.messages;
create policy "developer_bypass_messages"
on public.messages
for all
using (public.is_role('developer'))
with check (public.is_role('developer'));

-- --- driver_onboarding_queue --------------------------------------------
drop policy if exists "manager_can_read_own_onboarding" on public.driver_onboarding_queue;
create policy "manager_can_read_own_onboarding"
on public.driver_onboarding_queue
for select
using (public.is_role('manager') or public.is_role('ceo') or public.is_role('developer'));

-- `ceo` was added to `using` and `with check` because the verification queue is
-- reviewed by both managers and the CEO. Before this, `for select` allowed the
-- CEO to *see* every entry while only managers could `update` it, so the CEO's
-- approve/reject controls would have failed at the database with a policy
-- violation rather than an empty result — a distinction that is invisible from
-- the UI and easy to misread as "the click did nothing".
drop policy if exists "manager_can_manage_onboarding" on public.driver_onboarding_queue;
create policy "manager_can_manage_onboarding"
on public.driver_onboarding_queue
for all
using (public.is_role('manager') or public.is_role('ceo'))
with check (public.is_role('manager') or public.is_role('ceo'));

-- --- driver_payouts ------------------------------------------------------
drop policy if exists "manager_can_manage_payouts" on public.driver_payouts;
create policy "manager_can_manage_payouts"
on public.driver_payouts
for all
using (public.is_role('manager') or public.is_role('ceo') or public.is_role('developer'))
with check (public.is_role('manager') or public.is_role('ceo') or public.is_role('developer'));

-- --- vehicle_maintenance -------------------------------------------------
drop policy if exists "manager_can_manage_vehicle_maintenance" on public.vehicle_maintenance;
create policy "manager_can_manage_vehicle_maintenance"
on public.vehicle_maintenance
for all
using (public.is_role('manager') or public.is_role('ceo') or public.is_role('developer'))
with check (public.is_role('manager') or public.is_role('ceo') or public.is_role('developer'));


-- --- user_preferences ----------------------------------------------------
-- Strictly owner-scoped, with no privileged override. That is a deliberate
-- difference from every other table in this schema: a CEO or developer has no
-- business reading or rewriting another person's notification preferences, so
-- there is deliberately no `is_role('ceo')` branch here. `user_id = auth.uid()`
-- is the whole rule, and the absence of a bypass is the point.
drop policy if exists "users_manage_own_preferences" on public.user_preferences;
create policy "users_manage_own_preferences"
on public.user_preferences
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Upserting needs an explicit insert policy as well: `for all` covers INSERT,
-- but spelling it out keeps the upsert path from depending on how a future
-- refactor of the policy above is written. The primary key is user_id, so a
-- second insert for the same person collides instead of duplicating a row.
drop policy if exists "users_insert_own_preferences" on public.user_preferences;
create policy "users_insert_own_preferences"
on public.user_preferences
for insert
with check (auth.uid() = user_id);


-- =============================================================================
-- 7. Private storage buckets
--
-- Driver credentials (national IDs, licences, passports) and driver face photos
-- must never be world-readable. All three buckets are created with
-- `public = false` explicitly, so a project cannot end up with a public bucket by
-- omission.
--
-- Objects are addressed by path and exposed only via short-lived signed URLs
-- (`.createSignedUrl(path, 3600)`). Keys are namespaced
-- `<driver_id>/<document_type>/<filename>` so ownership is derivable from the
-- first path segment, which is all these policies test. The middle segment
-- groups a driver's uploads of one type together, so replacing a document can
-- target exactly the files of that type instead of guessing from the name.
-- =============================================================================

-- GUARDED. This section touches tables owned by Supabase's storage service
-- (`supabase_storage_admin`), not by the role the SQL editor runs as. That means
-- statements here can legitimately fail with "must be owner of table objects"
-- even though the same statements succeed elsewhere. Each block below therefore
-- catches `insufficient_privilege` and degrades to a WARNING instead of
-- aborting the transaction, so a permissions failure here can never prevent
-- sections 8 and 9 (the sign-up trigger and the role-change guard) from being
-- applied. A WARNING is still visible in the SQL editor output, so nothing fails
-- silently -- check the messages after running.
--
-- The bucket insert is guarded for a different reason: if it fails, sections 8
-- and 9 must still run. Bucket creation is recoverable (Dashboard, or the
-- Storage API) and is far less urgent than the role-change guard.
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values
    ('driver-credentials', 'driver-credentials', false, 5242880,
      array['application/pdf', 'image/png', 'image/jpeg']),
    ('driver-docs', 'driver-docs', false, 5242880,
      array['application/pdf', 'image/png', 'image/jpeg']),
    -- Face photos live in their own bucket rather than alongside the credential
    -- scans. The payoff is `allowed_mime_types`: these buckets permit PDF, so
    -- sharing one of them would mean nothing below the application layer could
    -- stop a PDF being written to a face-photo path. Here the bucket itself
    -- rejects any non-image, which survives an application bug. Separating them
    -- also keeps a document-retention sweep from silently deleting faces, and
    -- vice versa.
    ('avatars', 'avatars', false, 5242880,
      array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  raise notice 'OK: all three private buckets present with public = false';
exception
  when others then
    raise warning 'storage.buckets not writable by this role (%). Create the buckets in the Dashboard > Storage (driver-credentials, driver-docs, avatars), all set to Private, 5 MB, types pdf/png/jpeg for the first two and jpeg/png/webp for avatars. Continuing so the security triggers still apply.',
      substring(sqlerrm from 1 for 160);
end $$;

-- RLS on storage.objects is already enabled by Supabase on every project, so
-- this ALTER is normally a no-op. It is issued only when RLS is genuinely off,
-- which would be a security problem worth surfacing rather than a statement
-- worth failing on. Checks pg_class directly instead of attempting the ALTER
-- blindly, because the ALTER requires table ownership.
do $$
declare
  rls_on boolean;
begin
  select relrowsecurity into rls_on
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects';

  if rls_on is null then
    raise warning 'storage.objects not found. This is not a Supabase project, or Storage is disabled. Skipping.';
  elsif rls_on then
    raise notice 'OK: RLS already enabled on storage.objects; no ALTER needed';
  else
    begin
      execute 'alter table storage.objects enable row level security';
      raise notice 'OK: enabled RLS on storage.objects';
    exception
      when insufficient_privilege then
        raise warning 'RLS is OFF on storage.objects and this role cannot enable it. Enable it in the Dashboard > Storage > Policies before relying on the policies below.';
      when others then
        raise warning 'Could not enable RLS on storage.objects: %', substring(sqlerrm from 1 for 160);
    end;
  end if;
end $$;

-- The policies below are issued through `execute` inside a guarded block for the
-- same ownership reason as the ALTER above: if this role cannot alter
-- storage.objects, the CREATE POLICY would fail the same way. Each policy is
-- attempted independently and reported, so a partial permission grants a partial
-- result instead of a rollback.
--
-- Path convention: objects are namespaced `<driver_id>/<document_type>/<file>`,
-- so `(storage.foldername(name))[1]` is the owning driver and can be compared
-- against `auth.uid()`. The policies deliberately test only the first segment:
-- they must keep matching uploads written before the document-type segment was
-- introduced.
do $$
declare
  applied int := 0;
  skipped text := '';
begin
  -- No ownership pre-check: PostgreSQL has no reliable way to ask "am I the
  -- owner" (ownership is not reflected in the ACL, so has_table_privilege lies
  -- here). Each policy is simply attempted, and a failure is caught per policy
  -- below. That is both simpler and more accurate than probing first.

  -- Drivers may read, upload and delete only objects under their own prefix.
  begin
    drop policy if exists "drivers_read_own_documents" on storage.objects;
    create policy "drivers_read_own_documents"
    on storage.objects
    for select
    using (
      bucket_id in ('driver-docs', 'driver-credentials')
      and (storage.foldername(name))[1] = auth.uid()::text
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' drivers_read_own_documents';
  end;

  begin
    drop policy if exists "drivers_upload_own_documents" on storage.objects;
    create policy "drivers_upload_own_documents"
    on storage.objects
    for insert
    with check (
      bucket_id in ('driver-docs', 'driver-credentials')
      and (storage.foldername(name))[1] = auth.uid()::text
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' drivers_upload_own_documents';
  end;

  begin
    drop policy if exists "drivers_delete_own_documents" on storage.objects;
    create policy "drivers_delete_own_documents"
    on storage.objects
    for delete
    using (
      bucket_id in ('driver-docs', 'driver-credentials')
      and (storage.foldername(name))[1] = auth.uid()::text
    );
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' drivers_delete_own_documents';
  end;

  -- Reviewers (ceo / manager / developer) read both buckets to approve
  -- compliance documents. Writes stay with the owning driver and the
  -- service-role API routes.
  begin
    drop policy if exists "reviewers_read_company_documents" on storage.objects;
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
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' reviewers_read_company_documents';
  end;

  -- Managers onboard drivers, so they create credential objects.
  begin
    drop policy if exists "reviewers_manage_credentials" on storage.objects;
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
    applied := applied + 1;
  exception when others then
    skipped := skipped || ' reviewers_manage_credentials';
  end;

  -- --- avatars (driver face photos) ---------------------------------------
  --
  -- Separate policies rather than widening the two document policies above,
  -- because those name `driver-docs`/`driver-credentials` explicitly in their
  -- `bucket_id` test. Editing them would also have to be re-audited every time a
  -- bucket is added.
  --
  -- A face-photo key is `<owner_uuid>/...`. Once a driver exists the owner is
  -- their own profile id, so the driver's own read/write policy keys on
  -- `auth.uid()` exactly as the document policies do. Before an account exists --
  -- a candidate uploaded at onboarding -- the owner segment is instead the queue
  -- row's namespace, which no `auth.uid()` matches. Those objects are therefore
  -- unreachable by any driver and readable only through the reviewer policies,
  -- which is the correct outcome: a candidate's photo belongs to the onboarding
  -- review, not to any driver account.

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

  -- A driver may upload and replace only under their own prefix. `for insert`
  -- plus `for update` rather than `for all`, so this cannot accidentally be read
  -- as granting delete.
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

  -- A driver may remove their own face photo (the Settings "remove" action).
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
  -- onboarding -- the candidate has no account yet, so no driver policy applies.
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

  if applied = 13 and skipped = '' then
    raise notice 'OK: all 13 storage.objects policies applied';
  else
    raise warning 'Applied % of 13 storage policies. Not applied:%', applied, skipped;
  end if;
end $$;


-- =============================================================================
-- 8. Sign-up trigger
--
-- SECURITY: the role is hard-coded to 'driver' and never read from
-- `raw_user_meta_data`. The previous version did
-- `(new.raw_user_meta_data ->> 'role')::app_role`, which let anyone who signed
-- up self-assign the ceo or developer role by passing user metadata. Privileged
-- roles must be granted deliberately, out of band.
-- =============================================================================

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
    'driver'
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name;

  return new;
end;
$$;

-- GUARDED for the same reason as section 7: auth.users is owned by the auth
-- service. The function above is always created (it is in public, which this
-- role owns); only attaching the trigger to auth.users needs auth ownership.
-- Without this trigger, signing up creates no profile row at all, which fails
-- closed at the API layer (403 profile_missing) rather than open.
do $$
begin
  drop trigger if exists on_auth_user_created on auth.users;
  create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
  raise notice 'OK: sign-up trigger attached to auth.users';
exception
  when insufficient_privilege then
    raise warning 'Cannot attach on_auth_user_created to auth.users (not the owner). New sign-ups will not get a profiles row until this is added. Add it in Dashboard > SQL Editor as a role owning auth.users, or via `supabase db push`.';
  when others then
    raise warning 'Sign-up trigger not attached: %', substring(sqlerrm from 1 for 160);
end $$;


-- =============================================================================
-- 9. Guard against self-promotion
--
-- SECURITY: `profiles_self_update` has `using (auth.uid() = id)` and
-- `with check (auth.uid() = id)`, which constrains the ROW but not the
-- COLUMNS. Any driver could therefore run
--
--   supabase.from('profiles').update({ role: 'ceo' }).eq('id', <own id>)
--
-- and promote themselves. RLS alone cannot express "you may edit your profile
-- but not your own role", so this trigger enforces it.
--
-- The check is skipped for service_role, which the API routes use for
-- deliberate administrative changes.
-- =============================================================================

-- Covers INSERT as well as UPDATE. An earlier version fired only BEFORE UPDATE,
-- which left the INSERT path unguarded: with the sign-up trigger in section 8
-- unable to attach, a new user has no profiles row, and `profiles_self_manage`
-- (for insert) is the only way to create one. A BEFORE UPDATE trigger does not
-- see an INSERT at all.
--
-- Three independent layers now protect `role` and `status`:
--   1. `profiles_self_manage` requires role = 'driver' on INSERT
--   2. `profiles_self_update` is restricted to the caller's own row, but its
--      `with check` only tests `auth.uid() = id` — it cannot name columns, so it
--      cannot stop the caller rewriting `role` or `status` on that row
--   3. this trigger rejects privileged-column writes by an unprivileged actor
-- Layer 3 is the only one that can actually constrain *which columns* change.
--
-- `status` was previously unguarded, which combined with layer 2 produced two
-- real holes:
--   - a driver could set their own status from 'pending' to 'active', making the
--     onboarding queue's approval step meaningless
--   - a manager could set their own status, because `profiles_self_update`
--     applies to them and `managers_write_company_drivers`' `with check`
--     (role = 'driver') is satisfied by the self policy instead
--
-- Managers ARE permitted to change a *driver's* status: app/api/manager/drivers
-- activates the linked profile on approval through the caller's session client,
-- not a service-role one. Restricting status to ceo/developer would break that
-- flow, so the rule is scoped by target row instead: status is writable on a
-- driver row by a manager, and nowhere else.
create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- `old` is unassigned on INSERT and referencing its fields raises an error,
  -- so the prior values are read once, up front, guarded by tg_op.
  prior_role   public.app_role := null;
  prior_status text           := null;
begin
  if tg_op = 'UPDATE' then
    prior_role   := old.role;
    prior_status := old.status;
  end if;

  -- On UPDATE, only role and status are privileged. Anything else — full_name,
  -- phone, email — is the caller's own business and needs no further checks.
  if tg_op = 'UPDATE'
     and new.role is not distinct from prior_role
     and new.status is not distinct from prior_status then
    return new;
  end if;

  -- Service role (used by the API routes) may set these deliberately.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- CEO and developer may grant roles and change account status.
  if public.is_role('ceo') or public.is_role('developer') then
    return new;
  end if;

  -- Everything below is a driver or a manager.

  -- On UPDATE the row being written must already be a driver row. This is the
  -- check that closes the manager self-edit hole: their own row has
  -- role = 'manager', so it never matches. Scoped to UPDATE because on INSERT
  -- `prior_role` is NULL, and self-registration legitimately inserts a fresh
  -- driver row.
  if tg_op = 'UPDATE' and prior_role is distinct from 'driver' then
    raise exception
      'Only a ceo, developer or service_role account may modify a profile whose role is not driver'
      using errcode = '42501';
  end if;

  -- The role itself must stay 'driver' for everyone reaching this point.
  if new.role <> 'driver' then
    raise exception
      'Only a ceo, developer or service_role account may assign a role other than driver'
      using errcode = '42501';
  end if;

  -- Status is writable, but only by an actor who approves candidates. Without
  -- this a pending driver could self-promote to 'active' and skip the queue.
  if tg_op = 'UPDATE'
     and new.status is distinct from prior_status
     and not public.is_role('manager') then
    raise exception
      'Only a ceo, developer, manager or service_role account may change a profile status'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- public.profiles is owned by this role, so this is NOT guarded: if it fails,
-- the run should stop loudly rather than finish without its most important
-- protection. A driver who can set their own role to ceo defeats every RLS
-- policy in section 6, because all of them call public.is_role().
drop trigger if exists profiles_guard_role_change on public.profiles;

create trigger profiles_guard_role_change
before insert or update on public.profiles
for each row
execute function public.guard_profile_role_change();


-- =============================================================================
-- 10. Verification
--
-- Run this on its own AFTER the baseline. It returns one row; read the
-- `ok` column, which must be `t` for every check.
--
--   psql "$DATABASE_URL" -f supabase/baseline.sql
--   psql "$DATABASE_URL" -c "<paste the select below>"
-- =============================================================================

select
  (select count(*) from pg_tables
     where schemaname = 'public'
       and tablename in ('profiles','system_config','cars','daily_remittances',
                         'driver_documents','messages','driver_onboarding_queue',
                         'driver_payouts','vehicle_maintenance'))              as tables_1_is_9,
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename in ('profiles','system_config','cars','daily_remittances',
                         'driver_documents','messages','driver_onboarding_queue',
                         'driver_payouts','vehicle_maintenance'))              as policies_1_is_32,
  -- Every public table must have RLS switched on, not merely declared.
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity)    as rls_1_is_9,
  (select count(*) from pg_type t
     join pg_namespace n on n.oid = t.typnamespace
     where t.typname = 'app_role' and n.nspname = 'public')                   as app_role_exists_1_is_1,
  (select count(*) = 5 from pg_policies
     where schemaname = 'storage'
       and policyname in ('drivers_read_own_documents','drivers_upload_own_documents',
                          'drivers_delete_own_documents','reviewers_read_company_documents',
                          'reviewers_manage_credentials'))                   as storage_policies_1_is_5,
  (select count(*) from storage.buckets
     where id in ('driver-credentials','driver-docs'))                        as buckets_1_is_2,
  -- Must be 0. A non-zero value means credentials are world-readable.
  (select count(*) from storage.buckets where public)                         as public_buckets_1_is_0,
  -- The two security triggers. These are what make the file worth running.
  (select count(*) = 2 from pg_trigger
     where not tgisinternal
       and tgname in ('on_auth_user_created','profiles_guard_role_change'))   as triggers_1_is_2;

-- If storage_policies_1_is_5 or buckets_1_is_2 is false, apply section 7 as a
-- role owning storage.objects, or add the policies in Dashboard > Storage >
-- Policies. If triggers_1_is_2 is false, the self-promotion guard is NOT
-- active and must be fixed before any account is granted a privileged role.
