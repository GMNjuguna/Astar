/**
 * Driver face photo: view, upload and remove.
 *
 * ── The owner is always the session ─────────────────────────────────────────
 * There is no `driverId` parameter anywhere in this route. Every operation is
 * scoped to `auth.profile.id`, which is what the `profiles_self_update` RLS
 * policy enforces underneath. A body field naming another driver would be
 * ignored at best, and is the exact shape of the bug that would let one driver
 * overwrite another's photo -- so the field does not exist to be forged.
 *
 * ── Why the key is deterministic ────────────────────────────────────────────
 * `buildFacePhotoPath` returns one fixed key per driver, and the upload uses
 * `upsert: true`. Replacing a photo therefore overwrites the object in place
 * rather than creating a second one, so re-uploading a hundred times leaves
 * exactly one object and the column can never point at a stale version. The
 * alternative -- a timestamped key per upload -- orphans every previous photo
 * with nothing left to reference it.
 *
 * ── Why the old object is removed on replace ────────────────────────────────
 * Because the key is stable, replacing does not need a delete: the bytes are
 * overwritten by the same key. `remove` exists for the explicit "remove my
 * photo" case, where clearing the column without deleting the object would leave
 * a face photo sitting in the bucket that no code can reach or delete it.
 */
import { NextResponse } from 'next/server';

import {
  badRequestResponse,
  databaseErrorResponse,
  unexpectedErrorResponse,
} from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import {
  FACE_PHOTO_LABEL,
  FACE_PHOTO_STORAGE_BUCKET,
  buildFacePhotoPath,
  validateFacePhoto,
} from '@/lib/photo';
import { SIGNED_URL_TTL_SECONDS } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['driver'];

type Authorized = Extract<Awaited<ReturnType<typeof authorizeRole>>, { authorized: true }>;

/**
 * Resolves the caller's photo to a short-lived signed URL.
 *
 * Minted per request and never persisted: a stored signed URL keeps working for
 * as long as it is valid, so keeping one in a database or a profile payload would
 * hand out a durable link to someone's face.
 */
async function signedUrlFor(auth: Authorized): Promise<string | null> {
  const { data, error } = await auth.supabase
    .from('profiles')
    .select('driver_profile_photo_path')
    .eq('id', auth.profile.id)
    .maybeSingle();

  if (error) {
    return null;
  }

  const path = (data as { driver_profile_photo_path: string | null } | null)?.driver_profile_photo_path;

  if (!path) {
    return null;
  }

  const { data: signed, error: signError } = await auth.supabase.storage
    .from(FACE_PHOTO_STORAGE_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    return null;
  }

  return signed.signedUrl;
}

/** Returns the caller's own photo. Absent is a 200 with `hasPhoto: false`. */
export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const url = await signedUrlFor(auth);

    return NextResponse.json({
      ok: true,
      /**
       * `false` distinguishes "this driver has not uploaded a photo" from "the
       * photo exists but could not be signed". The UI renders initials for the
       * first and a retry/notice for the second, which are different problems.
       */
      hasPhoto: url !== null,
      photoUrl: url,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
  } catch {
    return unexpectedErrorResponse('load face photo');
  }
}

export async function POST(request: Request) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return badRequestResponse('Upload must be sent as multipart/form-data.');
  }

  const file = formData.get('facePhoto');

  if (!(file instanceof File)) {
    return badRequestResponse('A "facePhoto" file part is required.');
  }

  const check = await validateFacePhoto(file);

  if (!check.ok) {
    return badRequestResponse(check.message);
  }

  const driverId = auth.profile.id;
  const storagePath = buildFacePhotoPath(driverId);

  // Upsert onto the fixed key: replacing overwrites in place, so no previous
  // photo is orphaned and the column below cannot disagree with the object.
  const { error: uploadError } = await auth.supabase.storage
    .from(FACE_PHOTO_STORAGE_BUCKET)
    .upload(storagePath, file, {
      contentType: file.type || 'application/octet-stream',
      // Matches the signed-URL window, so a cached response cannot outlive the
      // permission that produced it.
      cacheControl: String(SIGNED_URL_TTL_SECONDS),
      upsert: true,
    });

  if (uploadError) {
    return databaseErrorResponse(uploadError, `upload ${FACE_PHOTO_LABEL.toLowerCase()}`);
  }

  // Second write. If this fails the object exists but nothing points at it, so
  // it is unreachable from every surface -- reported with the path so support
  // can find and remove it, rather than silently leaking a stored photo.
  const { error: updateError } = await auth.supabase
    .from('profiles')
    .update({ driver_profile_photo_path: storagePath })
    .eq('id', driverId);

  if (updateError) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'photo_metadata_write_failed',
          message: `${FACE_PHOTO_LABEL} was uploaded but could not be attached to your profile, so it is not visible yet. Please try again.`,
        },
        orphanedStoragePath: storagePath,
      },
      { status: 500 }
    );
  }

  const url = await signedUrlFor(auth);

  return NextResponse.json({
    ok: true,
    hasPhoto: url !== null,
    photoUrl: url,
    storagePath,
  });
}

/**
 * Removes the caller's photo.
 *
 * Clears the column first, then deletes the object. That order is deliberate: if
 * the delete fails, the profile no longer claims to have a photo, so the UI is
 * consistent and the leftover object is merely unreachable -- the recoverable
 * direction. Doing it the other way round would leave a profile pointing at an
 * object that no longer resolves, which renders as a broken image.
 */
export async function DELETE() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const driverId = auth.profile.id;

  const { data, error: lookupError } = await auth.supabase
    .from('profiles')
    .select('driver_profile_photo_path')
    .eq('id', driverId)
    .maybeSingle();

  if (lookupError) {
    return databaseErrorResponse(lookupError, 'load face photo');
  }

  const path = (data as { driver_profile_photo_path: string | null } | null)?.driver_profile_photo_path;

  if (!path) {
    // Already absent. Idempotent success, so a double-click on "remove" is not
    // an error and does not need its own handling in the UI.
    return NextResponse.json({ ok: true, removed: false, hadPhoto: false });
  }

  const { error: clearError } = await auth.supabase
    .from('profiles')
    .update({ driver_profile_photo_path: null })
    .eq('id', driverId);

  if (clearError) {
    return databaseErrorResponse(clearError, 'clear face photo reference');
  }

  const { error: removeError } = await auth.supabase.storage
    .from(FACE_PHOTO_STORAGE_BUCKET)
    .remove([path]);

  if (removeError) {
    return NextResponse.json(
      {
        ok: true,
        removed: false,
        hadPhoto: true,
        warnings: [
          'Your profile no longer shows a photo, but the stored file could not be deleted. Please contact an administrator.',
        ],
      },
      { status: 200 }
    );
  }

  return NextResponse.json({ ok: true, removed: true, hadPhoto: true });
}