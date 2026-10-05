'use client';

/**
 * Face photo with an initials fallback.
 *
 * ── Why a plain `<img>` and not `next/image` ────────────────────────────────
 * The source is a Supabase signed URL on the project's own storage domain, which
 * is not in `images.remotePatterns`. Adding the project host to the optimizer
 * allowlist would mean the optimizer fetching a token that expires in an hour,
 * with the failure mode being a permanently cached 400. A plain `<img>` also
 * avoids a second network round trip per avatar in a list, which matters when a
 * review queue shows a page of drivers at once.
 *
 * ── Why the fallback is stateful ────────────────────────────────────────────
 * A photo can be absent, and it can also be present but fail to load — a revoked
 * token, a deleted object, a proxy that stripped the signature. Those are
 * different problems and the second one must not render as a broken-image icon.
 * `onError` therefore demotes the image to initials, so the component always
 * paints something legible rather than an empty box or a browser placeholder.
 */
import { useEffect, useState } from 'react';

import { initialsFromName } from '@/lib/photo';

type DriverAvatarProps = {
  /** Signed URL, or `null`/undefined when the driver has no photo attached. */
  photoUrl?: string | null;
  fullName?: string | null;
  /** Tailwind size classes for the square. */
  sizeClassName?: string;
  className?: string;
  /**
   * Shown to assistive tech in place of the photo. Defaults to the name, which
   * is already announced by whatever is next to the avatar; pass a distinct
   * string when the avatar is the only identity signal on the row.
   */
  label?: string;
};

export function DriverAvatar({
  photoUrl,
  fullName,
  sizeClassName = 'h-12 w-12',
  className = '',
  label,
}: DriverAvatarProps) {
  // Reset when the source changes, so a new driver's photo is not suppressed by
  // the previous driver's error.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [photoUrl]);

  const shared = `shrink-0 rounded-full object-cover ${sizeClassName} ${className}`;

  if (!photoUrl || failed) {
    return (
      <span
        // A face photo is personal data; the fallback is decorative, so it is
        // hidden from the tree and the real name is read from beside it.
        aria-hidden="true"
        title={label ?? undefined}
        className={`inline-flex items-center justify-center bg-surface-2 font-semibold text-content-muted ring-1 ring-line ${shared}`}
      >
        {initialsFromName(fullName)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- see the note above:
    // a signed URL on an un-allowlisted host cannot go through the optimizer.
    <img
      src={photoUrl}
      alt={label ?? (fullName ? `${fullName}'s photo` : 'Driver photo')}
      onError={() => setFailed(true)}
      loading="lazy"
      decoding="async"
      className={`${shared} bg-surface-2`}
    />
  );
}