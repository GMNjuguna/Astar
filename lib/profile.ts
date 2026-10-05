/**
 * Shared session guard for the Profile & Settings routes.
 *
 * Lives in `lib/` rather than being exported from a `route.ts` because Next.js
 * validates the export surface of a route module and rejects anything that is
 * not an HTTP verb — a named export alongside `GET`/`PATCH` fails the build with
 * "<name> is not a valid Route export field".
 */
import { NextResponse } from 'next/server';

import { createSupabaseServerClient, type SupabaseServerClient } from '@/lib/supabase/server';

export type SessionUser = {
  id: string;
  email: string | null;
};

export type SessionResult =
  | { ok: true; supabase: SupabaseServerClient; user: SessionUser }
  | { ok: false; response: NextResponse };

/**
 * The signed-in user, resolved from the request cookie.
 *
 * `getUser()` revalidates the JWT against the auth server rather than trusting a
 * merely decodable token, which is what `getSession()` would do — the session
 * cookie is not a proof of identity on its own.
 *
 * Every authenticated role is admitted. These routes operate on the caller's own
 * row, which `profiles_self_read` already scopes to `auth.uid() = id`, so a role
 * list would add nothing.
 */
export async function requireUser(): Promise<SessionResult> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: {
            code: 'session_missing',
            message: 'Your session could not be verified. Please sign in again.',
          },
        },
        { status: 401 }
      ),
    };
  }

  return {
    ok: true,
    supabase,
    user: { id: data.user.id, email: data.user.email ?? null },
  };
}

/** Shape sent to the client for the profile panel. */
export type ProfileView = {
  id: string;
  email: string;
  fullName: string | null;
  role: string;
  status: string;
  phone: string | null;
  createdAt: string;
};

export function toProfileView(row: {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  status: string;
  phone: string | null;
  created_at: string;
}): ProfileView {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    phone: row.phone,
    createdAt: row.created_at,
  };
}

export const PROFILE_SELECT = 'id, email, full_name, role, status, phone, created_at' as const;