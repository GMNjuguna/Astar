'use client';

/**
 * Driver face photo upload, preview and remove.
 *
 * ── Why the browser re-validates the file ───────────────────────────────────
 * `lib/photo.ts` validates on the server, which is the only check that cannot be
 * bypassed. The checks here are duplicated deliberately: the server's job is to
 * reject, and this is the job of telling someone their 12-megabyte photo will be
 * refused *before* they wait for an upload to finish. The constants are imported
 * rather than retyped, so the two copies cannot drift apart.
 *
 * ── Why the preview is a local object URL ───────────────────────────────────
 * Previewing the chosen file does not require uploading it. `URL.createObjectURL`
 * gives an instant preview; sending the bytes to storage and re-signing to view
 * them would make choosing a photo feel like a slow save.
 */
import { useEffect, useRef, useState } from 'react';

import { DriverAvatar } from '@/components/driver/driver-avatar';
import {
  FACE_PHOTO_CONTENT_TYPES,
  FACE_PHOTO_LABEL,
  MAX_FACE_PHOTO_BYTES,
} from '@/lib/photo';

type FacePhotoUploadProps = {
  /**
   * Called with the newly stored signed URL so a parent can show it immediately
   * without waiting for its own refetch.
   */
  onChanged?: (photoUrl: string | null) => void;
  fullName?: string | null;
};

type Check = { ok: false; message: string } | { ok: true };

/**
 * Mirrors `validateFacePhoto` for immediate feedback.
 *
 * This checks the declared type only, not the magic bytes — sniffing needs the
 * bytes, and doing it here would mean reading the whole file in the browser to
 * save an upload that the server would reject in under a second anyway. So a file
 * that is *not* really an image still reaches the server and is refused there;
 * this only catches the cases a user can fix without a round trip.
 */
function checkFileLocally(file: File): Check {
  if (file.size === 0) {
    return { ok: false, message: `${FACE_PHOTO_LABEL} is empty.` };
  }

  if (file.size > MAX_FACE_PHOTO_BYTES) {
    const megabytes = (file.size / (1024 * 1024)).toFixed(1);

    return { ok: false, message: `That photo is ${megabytes} MB. The limit is 5 MB.` };
  }

  // `image/jpg` is not a registered media type but some browsers report it.
  const declared = file.type.trim().toLowerCase() === 'image/jpg' ? 'image/jpeg' : file.type.toLowerCase();

  if (!(FACE_PHOTO_CONTENT_TYPES as readonly string[]).includes(declared)) {
    return { ok: false, message: 'Choose a JPG, PNG or WebP image.' };
  }

  return { ok: true };
}

export function FacePhotoUpload({ onChanged, fullName }: FacePhotoUploadProps) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Object URLs are a leak until revoked. Every preview is revoked when it is
  // replaced or the component unmounts; without this, browsing a folder of photos
  // holds every one of them in memory.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch('/api/profile/photo', { cache: 'no-store' });

        if (!response.ok) {
          if (!cancelled) {
            // Not being able to read the current photo is not a reason to block
            // uploading a new one, so this is a notice rather than an error.
            setNotice('Your current photo could not be loaded. Uploading a new one will replace it.');
          }
          return;
        }

        const payload = (await response.json()) as { photoUrl?: string | null };

        if (!cancelled) {
          setPhotoUrl(payload.photoUrl ?? null);
          setHasLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setNotice('Your current photo could not be loaded. Check your connection.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function upload(file: File) {
    setError(null);
    setNotice(null);

    const check = checkFileLocally(file);

    if (!check.ok) {
      setError(check.message);
      return;
    }

    const localPreview = URL.createObjectURL(file);
    setPreview(localPreview);
    setIsBusy(true);

    try {
      const payload = new FormData();
      payload.set('facePhoto', file);

      const response = await fetch('/api/profile/photo', { method: 'POST', body: payload });
      const result = (await response.json()) as {
        ok?: boolean;
        photoUrl?: string | null;
        message?: string;
        error?: { message?: string };
      };

      if (!response.ok || !result.ok) {
        setError(result.error?.message ?? result.message ?? 'The photo could not be uploaded.');
        return;
      }

      setPhotoUrl(result.photoUrl ?? null);
      setHasLoaded(true);
      setNotice('Photo saved.');
      onChanged?.(result.photoUrl ?? null);
    } catch {
      setError('The photo could not be uploaded. Check your connection and try again.');
    } finally {
      URL.revokeObjectURL(localPreview);
      setPreview(null);
      setIsBusy(false);
      // Cleared so re-picking the same file fires `change` again.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function remove() {
    setError(null);
    setNotice(null);
    setIsBusy(true);

    try {
      const response = await fetch('/api/profile/photo', { method: 'DELETE' });

      if (!response.ok) {
        setError('The photo could not be removed. Please try again.');
        return;
      }

      const result = (await response.json()) as { warnings?: string[] };

      setPhotoUrl(null);
      setNotice('Photo removed.');
      onChanged?.(null);

      if (result.warnings?.length) {
        setNotice(result.warnings.join(' '));
      }
    } catch {
      setError('The photo could not be removed. Check your connection and try again.');
    } finally {
      setIsBusy(false);
    }
  }

  const shown = preview ?? photoUrl;

  return (
    <div className="rounded-2xl border border-line bg-canvas p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <DriverAvatar
          photoUrl={shown}
          fullName={fullName}
          sizeClassName="h-20 w-20 text-xl"
          label={fullName ? `${fullName}'s face photo` : 'Face photo'}
        />

        <div className="flex-1">
          <p className="text-sm font-semibold text-content">Face photo</p>
          <p className="mt-1 text-sm text-content-subtle">
            Shown to managers and the CEO so a driver can be identified in review lists. Keep your
            face centred and well lit.
          </p>
          <p className="mt-1 text-xs text-content-subtle">
            JPG, PNG or WebP, up to 5 MB. Stored privately and shared only through short-lived links.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <label
              className={`inline-flex cursor-pointer items-center rounded-lg bg-brand-solid px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-solid-strong ${
                isBusy ? 'cursor-not-allowed opacity-60' : ''
              }`}
            >
              {hasLoaded && photoUrl && !preview ? 'Replace photo' : 'Upload photo'}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                disabled={isBusy}
                aria-describedby="face-photo-status"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
            </label>

            {hasLoaded && photoUrl ? (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={isBusy}
                className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-content-muted transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Single live region for both outcomes, so a screen reader hears one
          message instead of two competing alerts. */}
      <div id="face-photo-status" aria-live="polite" className="mt-3">
        {isBusy ? <p className="text-sm text-content-subtle">Uploading&hellip;</p> : null}

        {error ? (
          <p role="alert" className="text-sm text-chart-danger">
            {error}
          </p>
        ) : null}

        {!isBusy && notice ? <p className="text-sm text-content-muted">{notice}</p> : null}
      </div>
    </div>
  );
}