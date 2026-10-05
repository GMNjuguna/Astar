/**
 * Read and update the signed-in user's own profile.
 *
 * ── Why the field whitelist lives here and not in the client ────────────────
 * The client sends only what the form collected, but a client is not a trust
 * boundary: anyone can craft a request with `role` or `status` in the body. The
 * RLS trigger `profiles_guard_role_change` already blocks an unprivileged write
 * to those columns, so this route is the second of two independent layers rather
 * than the only one. Even so the writable set is declared explicitly, and the
 * payload is built by *copying named fields out* of the request rather than by
 * spreading it, so an unexpected key cannot reach the query even if the trigger
 * were dropped.
 *
 * `role` and `status` are returned but never accepted. Status is changed through
 * the onboarding approval flow, which is a separate and audited path.
 *
 * Every authenticated role may read and edit its own profile, so the guard is a
 * session check rather than `authorizeRole(['ceo', ...])`.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { badRequestResponse, databaseErrorResponse } from '@/lib/api-errors';
import { PROFILE_SELECT, requireUser, toProfileView } from '@/lib/profile';

export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 120;
const MAX_PHONE_LENGTH = 32;

/** Columns a user is permitted to change about themselves. */
const WRITABLE_FIELDS = ['full_name', 'phone'] as const;

export async function GET() {
  const session = await requireUser();

  if (!session.ok) {
    return session.response;
  }

  // `profiles_self_read` admits `auth.uid() = id`, so this returns at most the
  // caller's own row. A missing row is a 404 rather than a 200 with nulls: the
  // sign-up trigger may have failed to attach, and the caller needs to know their
  // profile is absent rather than being handed an empty form that silently
  // discards anything they type.
  const { data, error } = await session.supabase
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('id', session.user.id)
    .maybeSingle();

  if (error) {
    return databaseErrorResponse(error, 'load your profile');
  }

  if (!data) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'profile_not_found',
          message:
            'No profile row exists for your account. Ask a CEO or developer to create one, or re-run the sign-up trigger section of the schema.',
        },
      },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, profile: toProfileView(data) });
}

export async function PATCH(request: NextRequest) {
  const session = await requireUser();

  if (!session.ok) {
    return session.response;
  }

  let body: Record<string, unknown>;

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequestResponse('Request body must be JSON.');
  }

  const update: { full_name?: string | null; phone?: string | null } = {};

  if ('full_name' in body) {
    if (body.full_name !== null && typeof body.full_name !== 'string') {
      return badRequestResponse('"full_name" must be a string or null.');
    }

    const trimmed = typeof body.full_name === 'string' ? body.full_name.trim() : null;

    if (trimmed !== null && trimmed.length > MAX_NAME_LENGTH) {
      return badRequestResponse(`"full_name" must be ${MAX_NAME_LENGTH} characters or fewer.`);
    }

    // Empty normalises to null, so the column never holds '' where the rest of the
    // app tests for a missing name.
    update.full_name = trimmed === null || trimmed === '' ? null : trimmed;
  }

  if ('phone' in body) {
    if (body.phone !== null && typeof body.phone !== 'string') {
      return badRequestResponse('"phone" must be a string or null.');
    }

    const trimmed = typeof body.phone === 'string' ? body.phone.trim() : null;

    if (trimmed !== null && trimmed.length > MAX_PHONE_LENGTH) {
      return badRequestResponse(`"phone" must be ${MAX_PHONE_LENGTH} characters or fewer.`);
    }

    update.phone = trimmed === null || trimmed === '' ? null : trimmed;
  }

  if (Object.keys(update).length === 0) {
    return badRequestResponse(
      `Nothing to update. Send at least one of: ${WRITABLE_FIELDS.join(', ')}.`,
      'The role and status fields are read-only here; account status is changed through the onboarding approval flow.'
    );
  }

  const result = await session.supabase
    .from('profiles')
    .update(update)
    .eq('id', session.user.id)
    .select(PROFILE_SELECT)
    .maybeSingle();

  if (result.error) {
    // The trigger raises 42501 for a privileged write. It cannot fire for the
    // whitelisted fields above, but silently reporting a generic database error
    // would mislead if it ever did, so the case is named.
    if (result.error.message.includes('may assign a role')) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'privileged_field_rejected',
            message:
              'Only a CEO or developer can assign a role. That field is not editable from your profile.',
          },
        },
        { status: 403 }
      );
    }

    if (result.error.message.includes('may modify a profile')) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'privileged_field_rejected',
            message:
              'Only a CEO, developer or service role can modify a profile whose role is not driver. Your own role and status are not editable here.',
          },
        },
        { status: 403 }
      );
    }

    if (result.error.message.includes('may change a profile status')) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'privileged_field_rejected',
            message:
              'Only a CEO, developer or manager can change an account status. Changing your own status here is not permitted.',
          },
        },
        { status: 403 }
      );
    }

    return databaseErrorResponse(result.error, 'update your profile');
  }

  if (!result.data) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'profile_not_found',
          message: 'No profile row exists for your account, so there was nothing to update.',
        },
      },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, profile: toProfileView(result.data) });
}