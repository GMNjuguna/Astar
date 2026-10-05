/**
 * Read and update the signed-in user's own preferences.
 *
 * ── Defaults are returned even when no row exists ──────────────────────────
 * A user who has never opened Settings has no row. Returning 404 would make the
 * panel unable to render at all on first visit, so GET synthesises the column
 * defaults and reports `persisted: false`. The UI then knows the values on
 * screen are defaults rather than a saved choice, and does not claim otherwise.
 *
 * ── `theme` is a preference, not the source of truth for the theme ─────────
 * next-themes resolves the active scheme from localStorage, because a theme
 * that has not been read yet would otherwise render as a flash of the wrong
 * colours. This table records the *choice* so it follows the user to another
 * device. The two are deliberately separate: the browser copy is applied on
 * load, and the stored copy is written when the user changes it.
 *
 * Every authenticated role may manage its own row. The RLS policies scope this
 * table to `auth.uid() = user_id` with no privileged override — a CEO has no
 * business reading another person's notification settings — so the route needs
 * no role check beyond having a session.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { badRequestResponse, databaseErrorResponse } from '@/lib/api-errors';
import { requireUser } from '@/lib/profile';

export const dynamic = 'force-dynamic';

const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/**
 * Mirrors the column defaults in supabase/baseline.sql.
 *
 * Duplicated rather than read from the schema so a user with no row still gets a
 * complete, renderable response. If a default is ever changed in SQL this must
 * change with it — the alternative, returning nulls, would force the UI to
 * reimplement the defaults and could drift independently.
 */
const DEFAULTS = {
  emailAlerts: true,
  smsReminders: false,
  theme: 'system' as Theme,
};

export async function GET() {
  const session = await requireUser();

  if (!session.ok) {
    return session.response;
  }

  const { data, error } = await session.supabase
    .from('user_preferences')
    .select('email_alerts, sms_reminders, theme, updated_at')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (error) {
    // Includes 42P01 while the migration is unapplied. The UI treats that code
    // as "device-local only" and keeps working off localStorage rather than
    // reporting the settings page as broken.
    return databaseErrorResponse(error, 'load your preferences');
  }

  if (!data) {
    return NextResponse.json({
      ok: true,
      // False means "these are the defaults, not something you chose". The UI
      // shows the toggles in their default position without claiming a save.
      persisted: false,
      preferences: DEFAULTS,
    });
  }

  return NextResponse.json({
    ok: true,
    persisted: true,
    preferences: {
      emailAlerts: data.email_alerts,
      smsReminders: data.sms_reminders,
      // Re-validated against the allow-list rather than trusted: the value comes
      // from a text column with a CHECK constraint, and the UI switches on it
      // directly. A future constraint change should not silently blank the
      // segmented control.
      theme: THEMES.includes(data.theme) ? data.theme : DEFAULTS.theme,
    },
    updatedAt: data.updated_at,
  });
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

  const update: {
    email_alerts?: boolean;
    sms_reminders?: boolean;
    theme?: Theme;
  } = {};

  if ('email_alerts' in body) {
    if (typeof body.email_alerts !== 'boolean') {
      return badRequestResponse('"email_alerts" must be a boolean.');
    }

    update.email_alerts = body.email_alerts;
  }

  if ('sms_reminders' in body) {
    if (typeof body.sms_reminders !== 'boolean') {
      return badRequestResponse('"sms_reminders" must be a boolean.');
    }

    update.sms_reminders = body.sms_reminders;
  }

  if ('theme' in body) {
    if (typeof body.theme !== 'string' || !THEMES.includes(body.theme as Theme)) {
      return badRequestResponse(`"theme" must be one of: ${THEMES.join(', ')}.`);
    }

    update.theme = body.theme as Theme;
  }

  if (Object.keys(update).length === 0) {
    return badRequestResponse(
      `Nothing to update. Send at least one of: email_alerts, sms_reminders, theme.`
    );
  }

  // Upsert. The primary key is user_id, so a user with no row gets one created
  // and a user with an existing row has it updated — no read-then-branch race
  // where two tabs both see "no row" and both insert.
  //
  // `user_id` is pinned to the session id rather than read from the body, so a
  // crafted request cannot write into another account's preferences even if RLS
  // were somehow satisfied.
  const { data, error } = await session.supabase
    .from('user_preferences')
    .upsert({ user_id: session.user.id, ...update }, { onConflict: 'user_id' })
    .select('email_alerts, sms_reminders, theme, updated_at')
    .maybeSingle();

  if (error) {
    return databaseErrorResponse(error, 'save your preferences');
  }

  if (!data) {
    // The upsert reported success but returned nothing. Treated as a failure
    // rather than reported as saved: a preferences panel that says "Saved" when
    // nothing was written is worse than an error the user can see.
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'unexpected_error',
          message:
            'Your preferences could not be confirmed as saved. Please try again.',
        },
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    persisted: true,
    preferences: {
      emailAlerts: data.email_alerts,
      smsReminders: data.sms_reminders,
      theme: THEMES.includes(data.theme) ? data.theme : DEFAULTS.theme,
    },
    updatedAt: data.updated_at,
  });
}