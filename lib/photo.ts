/**
 * Driver face photo: validation and object-key construction.
 *
 * ── Why photos get their own rules rather than reusing `lib/documents.ts` ────
 * The document helpers deliberately permit PDF. A face photo must not: the whole
 * point of the `avatars` bucket is that its `allowed_mime_types` contains only
 * images, so a PDF cannot reach it even if this file is wrong. Reusing
 * `ALLOWED_CONTENT_TYPES` would have quietly widened that boundary.
 *
 * ── Why the declared MIME type is not trusted ───────────────────────────────
 * `File.type` and the content type passed to `storage.upload()` are both chosen
 * by the caller, and Supabase's bucket `allowed_mime_types` is enforced against
 * that declared value -- not against the bytes. So a caller could declare
 * `image/jpeg` and upload an SVG (which can carry script) or an HTML file, and
 * every layer above would agree it was a JPEG. {@link sniffImageType} reads the
 * leading bytes and rejects anything that is not genuinely one of the three
 * allowed formats. The declared type is still checked, because a mismatch means
 * the client is confused about what it sent.
 */

import type { FileCheck } from '@/lib/documents';
import { normalizeContentType } from '@/lib/documents';

/** Mirrors `allowed_mime_types` on the `avatars` bucket in baseline.sql section 7. */
export const FACE_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const MAX_FACE_PHOTO_BYTES = 5 * 1024 * 1024;

export const FACE_PHOTO_LABEL = 'Face photo';

/**
 * Object-key folder, second path segment.
 *
 * Not load-bearing for security -- storage policies test only the first segment
 * -- but it keeps avatars self-describing in the bucket listing, and keeps the
 * owner prefix from ever containing an arbitrary caller-supplied folder name.
 */
const PHOTO_FOLDER = 'face-photo';

/**
 * File name inside the owner's folder.
 *
 * Fixed, with no extension and no timestamp, so that re-uploading a photo
 * *replaces* the existing object instead of adding another. A timestamped name
 * would mean every replacement left the previous photo behind as an orphan:
 * unreachable by any policy that only reads `profiles.driver_profile_photo_path`,
 * invisible in the UI, and permanent, because nothing else ever references it.
 *
 * The missing extension costs nothing: the bucket serves the object with the
 * `contentType` recorded at upload, and `<img>` reads that header rather than
 * inferring a type from the URL, so a `avatar` key renders correctly whether the
 * bytes are JPEG, PNG or WebP.
 */
const PHOTO_FILE_NAME = 'avatar';

/**
 * Builds the private object key for a face photo.
 *
 * Shape is `<ownerId>/face-photo/avatar`. `ownerId` is the driver's profile id
 * once they have an account, or the onboarding queue row's id before they do --
 * matching how the existing credential uploads namespace themselves by queue row.
 * The storage policies test only this first segment, so which of the two it is
 * decides who can read the object, and the caller must not choose it freely.
 */
export function buildFacePhotoPath(ownerId: string): string {
  return `${ownerId}/${PHOTO_FOLDER}/${PHOTO_FILE_NAME}`;
}

/**
 * Identifies an image by its magic bytes rather than its declared type.
 *
 * Returns the canonical media type, or `null` when the bytes are not one of the
 * three allowed image formats. Each signature is checked in full rather than by
 * first byte alone, so a file beginning with `RIFF` but not carrying `WEBP` at
 * offset 8 -- an AVI or a WAV, for instance -- is rejected rather than accepted
 * as a WebP.
 */
export function sniffImageType(bytes: Uint8Array): (typeof FACE_PHOTO_CONTENT_TYPES)[number] | null {
  // JPEG: SOI marker followed by any third byte. `FF D8` alone is too weak --
  // it is only two bytes and JPEG's second marker varies by encoder.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: the full 8-byte signature. No image/avif, no image/heic is allowed, so
  // there is no second signature to disambiguate against here.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: a RIFF container whose form type is WEBP. Both halves are required.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

/** How many leading bytes {@link sniffImageType} needs in the worst case. */
const SNIFF_BYTES = 12;

/**
 * Server-side gate for an uploaded face photo.
 *
 * Async because it has to read the bytes to sniff them. The size check runs
 * *before* `arrayBuffer()`, so an oversized upload is refused on its declared
 * length rather than being buffered into memory first.
 */
export async function validateFacePhoto(file: File): Promise<FileCheck> {
  if (file.size === 0) {
    return { ok: false, message: `${FACE_PHOTO_LABEL} is empty.` };
  }

  if (file.size > MAX_FACE_PHOTO_BYTES) {
    const megabytes = (file.size / (1024 * 1024)).toFixed(1);

    return { ok: false, message: `${FACE_PHOTO_LABEL} is ${megabytes} MB. The limit is 5 MB.` };
  }

  const declared = normalizeContentType(file.type);

  if (!(FACE_PHOTO_CONTENT_TYPES as readonly string[]).includes(declared)) {
    return {
      ok: false,
      message: `${FACE_PHOTO_LABEL} must be a JPG, PNG or WebP image.`,
    };
  }

  let sniffed: string | null;

  try {
    sniffed = sniffImageType(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
  } catch {
    // An unreadable body cannot be sniffed, so it cannot be vouched for.
    return { ok: false, message: `${FACE_PHOTO_LABEL} could not be read.` };
  }

  if (!sniffed) {
    return {
      ok: false,
      message: `${FACE_PHOTO_LABEL} is not a valid JPG, PNG or WebP image.`,
    };
  }

  if (sniffed !== declared) {
    return {
      ok: false,
      message: `${FACE_PHOTO_LABEL} is a ${sniffed.replace('image/', '').toUpperCase()} file but was uploaded as ${declared
        .replace('image/', '')
        .toUpperCase()}. Please re-upload it.`,
    };
  }

  return { ok: true };
}

/**
 * Bucket holding face photos.
 *
 * Kept alongside the rest of the face-photo rules rather than in
 * `STORAGE_BUCKETS`, which is the map the document UI uses to address the two
 * credential buckets. Grouping it here means every constant that decides what a
 * face photo may be -- bucket, mime list, size limit, key shape -- is readable in
 * one file, which is the only place a reviewer would look for it.
 */
export const FACE_PHOTO_STORAGE_BUCKET = 'avatars';

/**
 * Initials used as the avatar fallback.
 *
 * A face photo is optional, so the component that renders an avatar must handle
 * its absence -- and the fallback has to be derived from something, because
 * "anonymous user" would make every photo-less driver indistinguishable in a
 * review queue.
 */
export function initialsFromName(fullName: string | null | undefined, fallback = '?'): string {
  const parts = (fullName ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return fallback;
  }

  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';

  return (first + last).toUpperCase() || fallback;
}