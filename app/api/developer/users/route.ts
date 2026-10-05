import { NextResponse } from 'next/server';

import { badRequestResponse, databaseErrorResponse, notFoundResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['developer'];

/** Mirrors the `public.app_role` enum in supabase/baseline.sql. */
const ASSIGNABLE_ROLES = ['driver', 'manager', 'ceo', 'developer', 'suspended'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string;
  role: AssignableRole;
  phone: string | null;
  created_at: string;
};

function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

function toUserRecord(row: ProfileRow) {
  return {
    id: row.id,
    fullName: row.full_name ?? '',
    email: row.email,
    role: row.role,
    phone: row.phone ?? null,
    createdAt: row.created_at,
  };
}

export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  // Previously this returned five invented accounts with integer ids ('1', '2'),
  // which are not valid uuid values, so the list could never have come from the
  // database. `profiles_developer_read_all` grants a developer SELECT on every
  // profile, so no service-role bypass is needed.
  const { data, error } = await auth.supabase
    .from('profiles')
    .select('id, full_name, email, role, phone, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    return databaseErrorResponse(error, 'load profiles');
  }

  const rows = (data ?? []) as ProfileRow[];

  return NextResponse.json({
    users: rows.map(toUserRecord),
    /** Distinguishes "queried fine, no accounts" from a failed load. */
    empty: { users: rows.length === 0 },
  });
}

export async function PATCH(request: Request) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  let payload: { id?: unknown; role?: unknown };

  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return badRequestResponse('Request body must be valid JSON.');
  }

  const targetId = typeof payload.id === 'string' ? payload.id.trim() : '';

  if (!targetId) {
    return badRequestResponse('Missing user identifier.');
  }

  if (!isAssignableRole(payload.role)) {
    return badRequestResponse(`Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
  }

  // The database trigger `profiles_guard_role_change` permits any developer to
  // set any role, on any row, because it only asks "is the actor a developer or
  // ceo?". It never compares the target to the actor, so a developer could
  // otherwise promote themselves to ceo through this endpoint and inherit every
  // ceo policy. The restriction is applied here as well so the route is not the
  // vehicle, regardless of how the trigger is later edited.
  if (targetId === auth.user.id) {
    return badRequestResponse(
      'You cannot change your own role. Ask another developer or the CEO to do it.'
    );
  }

  // `profiles_developer_bypass` covers UPDATE for a developer. `.select()` is
  // required to tell a real update from one that matched no row: without it
  // PostgREST reports success for a statement that changed nothing.
  const { data, error } = await auth.supabase
    .from('profiles')
    .update({ role: payload.role })
    .eq('id', targetId)
    .select('id, full_name, email, role, phone, created_at')
    .maybeSingle();

  if (error) {
    return databaseErrorResponse(error, `update profiles role for "${targetId}"`);
  }

  if (!data) {
    return notFoundResponse('No user with that identifier exists, or it is not visible to this account.');
  }

  return NextResponse.json({
    ok: true,
    user: toUserRecord(data as ProfileRow),
    updatedBy: auth.profile.id,
  });
}