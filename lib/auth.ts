import { NextResponse } from 'next/server';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { Database } from '@/types/database';

/**
 * Inferred from the factory rather than written out by hand, so the client type
 * always tracks the installed `@supabase/supabase-js` generic signature.
 */
export type RequestScopedClient = ReturnType<typeof createSupabaseServerClient>;

export type AppRole = Database['public']['Tables']['profiles']['Row']['role'];

export type AuthorizedProfile = {
  id: string;
  email: string;
  full_name: string | null;
  role: AppRole;
  phone: string | null;
};

export type AuthorizeSuccess = {
  authorized: true;
  /** The authenticated Supabase auth user (verified via `auth.getUser()`). */
  user: { id: string; email: string | null };
  /** The matching `profiles` row, used for role checks and ownership scoping. */
  profile: AuthorizedProfile;
  /**
   * A request-scoped, cookie-authenticated client that is subject to RLS.
   * Prefer this over the service-role client for anything RLS can express.
   */
  supabase: RequestScopedClient;
};

export type AuthorizeFailure = {
  authorized: false;
  response: NextResponse;
};

export type AuthorizeResult = AuthorizeSuccess | AuthorizeFailure;

const PROFILE_COLUMNS = 'id, email, full_name, role, phone' as const;

function failure(status: 401 | 403, code: string, message: string): AuthorizeFailure {
  return {
    authorized: false,
    response: NextResponse.json(
      { error: status === 401 ? 'Unauthorized' : 'Forbidden', code, message },
      { status, headers: { 'Cache-Control': 'no-store' } }
    ),
  };
}

/**
 * Server-side role gate for API route handlers.
 *
 * Usage:
 * ```ts
 * const auth = await authorizeRole(['manager']);
 * if (!auth.authorized) return auth.response;   // 401 / 403 already built
 * // auth.user, auth.profile, auth.supabase are available here
 * ```
 *
 * Security notes:
 * - Uses `auth.getUser()` (revalidates the JWT against the auth server) rather
 *   than `getSession()`, so a forged or stale cookie cannot pass the gate.
 * - The role is read from the `profiles` table through the RLS-scoped client, so
 *   a client cannot self-assert its own role.
 * - Callers MUST return `auth.response` immediately when `authorized` is false.
 *   Nothing before this call may touch a service-role client.
 * - Any privileged work performed after authorization (for example
 *   `auth.admin.createUser`) must happen strictly after the gate passes.
 *
 * @param allowedRoles Roles permitted to run the handler. `suspended` should
 *   never be included.
 */
export async function authorizeRole(allowedRoles: string[]): Promise<AuthorizeResult> {
  const supabase = createSupabaseServerClient();

  let user: { id: string; email?: string | null } | null = null;

  try {
    const { data, error } = await supabase.auth.getUser();

    if (error) {
      // Distinguish "no cookie at all" from "cookie present but not valid",
      // since `getUser()` reports both through the same `error` channel.
      const code = /session missing/i.test(error.message) ? 'session_missing' : 'session_invalid';
      return failure(401, code, 'Your session could not be verified. Please sign in again.');
    }

    user = data.user;
  } catch {
    return failure(401, 'session_error', 'Your session could not be verified. Please sign in again.');
  }

  if (!user) {
    return failure(401, 'session_missing', 'Authentication required. Please sign in to continue.');
  }

  let profile: AuthorizedProfile | null = null;

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', user.id)
      .maybeSingle();

    if (error) {
      return failure(403, 'profile_lookup_failed', 'Unable to resolve the role for this account.');
    }

    profile = (data as AuthorizedProfile | null) ?? null;
  } catch {
    return failure(403, 'profile_lookup_failed', 'Unable to resolve the role for this account.');
  }

  if (!profile) {
    return failure(403, 'profile_missing', 'No profile is linked to this account. Contact an administrator.');
  }

  if (profile.role === 'suspended') {
    return failure(403, 'account_suspended', 'This account has been suspended.');
  }

  if (!allowedRoles.includes(profile.role)) {
    return failure(
      403,
      'role_not_permitted',
      `This action requires one of the following roles: ${allowedRoles.join(', ')}.`
    );
  }

  return {
    authorized: true,
    user: { id: user.id, email: user.email ?? null },
    profile,
    supabase,
  };
}