/**
 * Reviewer access to driver identity: name and face photo.
 *
 * The manager driver list and the CEO approval queue both need to answer "whose
 * document is this?" before they can review it. The approval queue in particular
 * previously rendered a document type and a timestamp with no name at all, which
 * is not reviewable.
 *
 * Signing is centralised here rather than done in each component because:
 *
 *  - the storage read policy (`reviewers_read_avatars`) is the real boundary, and
 *    it only applies to requests made with the caller's own session. A
 *    service-role client would bypass it entirely, so there is deliberately no
 *    admin client in this file;
 *  - signing needs a caller's session, and the browser already has one, so there
 *    is no reason to proxy the bytes through the server;
 *  - two components asking for the same id list would otherwise sign the same
 *    objects twice.
 *
 * ── What is and is not returned ─────────────────────────────────────────────
 * `full_name` is returned because a face next to no name identifies nobody, and
 * because the queue rows already carry the driver's name, so this discloses
 * nothing the caller does not already have. `phone` and `email` are deliberately
 * not selected: a review screen has no use for a driver's contact details, and a
 * response that carried them would be one more place to leak them.
 */
import { NextResponse } from 'next/server';

import { badRequestResponse, databaseErrorResponse, unexpectedErrorResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import { FACE_PHOTO_STORAGE_BUCKET } from '@/lib/photo';
import { SIGNED_URL_TTL_SECONDS } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['ceo', 'manager', 'developer'];

/** Caps a single request, so one call cannot ask the signer to sign everything. */
const MAX_DRIVER_IDS = 200;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReviewerDriverIdentity = {
  fullName: string | null;
  /**
   * `null` when the driver has no photo attached *or* when the object exists but
   * could not be signed. Both render as initials; only the difference matters for
   * debugging, and both are honest answers to "do I have a picture of them".
   */
  photoUrl: string | null;
};

export async function GET(request: Request) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const raw = new URL(request.url).searchParams.get('driverIds') ?? '';
  const requested = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (requested.length === 0) {
    return badRequestResponse('Provide a "driverIds" query parameter as a comma-separated list of profile ids.');
  }

  if (requested.length > MAX_DRIVER_IDS) {
    return badRequestResponse(`Ask for at most ${MAX_DRIVER_IDS} drivers at a time.`);
  }

  // Non-uuid values are dropped rather than rejected: a stale id in a list would
  // otherwise fail the whole batch, when the useful behaviour is to return the
  // drivers that do resolve.
  const driverIds = [...new Set(requested)].filter((value) => UUID_SHAPE.test(value));

  if (driverIds.length === 0) {
    return NextResponse.json({ ok: true, drivers: {}, expiresInSeconds: SIGNED_URL_TTL_SECONDS });
  }

  try {
    const { data, error } = await auth.supabase
      .from('profiles')
      .select('id, full_name, driver_profile_photo_path')
      .in('id', driverIds)
      // Reviewers are looking at drivers. Restricting to that role keeps a
      // manager's list from rendering another manager's portrait if an id were
      // ever mistyped or tampered with in the request.
      .eq('role', 'driver');

    if (error) {
      return databaseErrorResponse(error, 'load driver identity');
    }

    const rows = (data ?? []) as Array<{
      id: string;
      full_name: string | null;
      driver_profile_photo_path: string | null;
    }>;

    // Signed in parallel: each call is a round trip to the storage service, and a
    // review queue routinely shows a page of drivers at once.
    const signedUrls = await Promise.all(
      rows.map(async (row) => {
        if (!row.driver_profile_photo_path) return null;

        const { data: result, error: signError } = await auth.supabase.storage
          .from(FACE_PHOTO_STORAGE_BUCKET)
          .createSignedUrl(row.driver_profile_photo_path, SIGNED_URL_TTL_SECONDS);

        if (signError || !result?.signedUrl) {
          return null;
        }

        return [row.id, result.signedUrl] as const;
      })
    );

    const urlById = new Map<string, string>();
    for (const entry of signedUrls) {
      if (entry) urlById.set(entry[0], entry[1]);
    }

    const drivers: Record<string, ReviewerDriverIdentity> = {};

    for (const row of rows) {
      drivers[row.id] = {
        fullName: row.full_name,
        photoUrl: urlById.get(row.id) ?? null,
      };
    }

    return NextResponse.json({
      ok: true,
      drivers,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
  } catch {
    return unexpectedErrorResponse('load driver identity');
  }
}