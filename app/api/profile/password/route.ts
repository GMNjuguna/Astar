/**
 * Change the signed-in user's password.
 *
 * ── Why the current password is verified first ─────────────────────────────
 * Supabase's `updateUser({ password })` accepts a new password from any valid
 * session. On its own that means a stolen or unattended-but-unlocked session can
 * take the account over permanently — the attacker sets a password the real
 * owner does not know, and the owner is locked out. Requiring the current
 * password turns that into a visible, recoverable failure instead.
 *
 * ── How verification is done ────────────────────────────────────────────────
 * GoTrue exposes no "check password" call. The only supported way to confirm a
 * password is to attempt a sign-in. That is done with a **throwaway client**:
 *
 *   - `persistSession: false` and `autoRefreshToken: false` stop it writing a
 *     cookie, which is what would otherwise replace the caller's real session.
 *   - it is constructed with the *anon* key, not the service-role key, because
 *     `signInWithPassword` performs a real credential check against the user.
 *
 * The service-role key is not required and is deliberately not used here. It
 * would let this route change any account's password given only a session.
 *
 * The new password is then applied with the caller's own request-scoped client,
 * so the write is attributable to the user making it.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { badRequestResponse, unauthorizedResponse, unexpectedErrorResponse } from '@/lib/api-errors';
import { requireUser } from '@/lib/profile';

export const dynamic = 'force-dynamic';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

/**
 * 72 bytes is bcrypt's input limit. A longer password is not an error in
 * principle, but GoTrue truncates at 72 bytes, so two passwords sharing a
 * prefix would both be accepted — which makes the "you chose a longer password"
 * case a security-relevant surprise rather than a cosmetic one.
 */
function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Your new password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  }

  if (!/[a-zA-Z]/.test(password)) {
    return 'Your new password must include at least one letter.';
  }

  if (!/[0-9]/.test(password)) {
    return 'Your new password must include at least one number.';
  }

  return null;
}

export async function POST(request: NextRequest) {
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

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword) {
    return badRequestResponse('"currentPassword" is required so we can confirm it is really you.');
  }

  if (!newPassword) {
    return badRequestResponse('"newPassword" is required.');
  }

  const problem = passwordProblem(newPassword);

  if (problem) {
    return badRequestResponse(problem);
  }

  if (currentPassword === newPassword) {
    return badRequestResponse('Your new password must be different from your current password.');
  }

  const email = session.user.email;

  if (!email) {
    // Phone-only sign-ups have no password to change, so this is a real state
    // rather than a missing field.
    return badRequestResponse(
      'This account signs in with a phone number, so it has no password to change.'
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return unexpectedErrorResponse('change your password');
  }

  // ── Step 1: confirm the current password ─────────────────────────────────
  // A separate, sessionless client. `persistSession: false` is what keeps this
  // from overwriting the caller's cookies with the verification client's tokens.
  const verifier = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { error: signInError } = await verifier.auth.signInWithPassword({
    email,
    password: currentPassword,
  });

  if (signInError) {
    // Deliberately does not echo GoTrue's message. Supabase returns
    // "Invalid login credentials" for both a wrong password and a non-existent
    // user, and the distinction is only useful to someone enumerating accounts.
    return unauthorizedResponse(
      'Your current password is not correct, so the password was not changed.'
    );
  }

  // ── Step 2: apply the new password ───────────────────────────────────────
  // Done on the caller's own client so the write is scoped to their account by
  // their session. `updateUser` cannot target another user through it.
  const { error: updateError } = await session.supabase.auth.updateUser({ password: newPassword });

  if (updateError) {
    // GoTrue can reject here even after a successful verification — most often
    // because the new password matches a very recent one, which it will not
    // report distinctly. The surface message stays generic but the code differs.
    if (/same|recent|reuse/i.test(updateError.message)) {
      return badRequestResponse(
        'That password is too similar to one you have used recently. Choose a different one.'
      );
    }

    if (/session|token|expired/i.test(updateError.message)) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'session_expired',
            message: 'Your session expired while changing your password. Sign in again and retry.',
          },
        },
        { status: 401 }
      );
    }

    return unexpectedErrorResponse('change your password');
  }

  return NextResponse.json({
    ok: true,
    message: 'Your password has been changed. Existing sessions remain signed in.',
  });
}