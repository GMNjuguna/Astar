'use client';

/**
 * Driver identity card for the driver portal header.
 *
 * ── Why this fetches instead of receiving props ─────────────────────────────
 * The driver page it sits on holds no profile state — it is built around the
 * remittance ledger — and the portal layout is a server component that renders
 * header text only. Threading a profile through either would mean changing the
 * page's data flow for a card that is self-contained. Two small requests (the
 * profile, then the photo) are cheaper than that coupling.
 *
 * ── Why the photo is a second request rather than part of `/api/profile` ────
 * Signing is a storage operation, not a database read, and it has a different
 * failure mode: the row can exist while the object is missing. Bundling them
 * would mean one error response for two independent problems. Asking separately
 * also means the identity card renders from the profile even when the avatar
 * bucket is unreachable.
 *
 * This card displays only. The upload lives in the driver portal's Settings page,
 * which is where a driver goes to change something about themselves.
 */
import { useEffect, useState } from 'react';

import { DriverAvatar } from '@/components/driver/driver-avatar';
import { fetchApiJson } from '@/lib/api-client';

type Profile = {
  fullName: string | null;
  role: string;
  status: string;
  phone: string | null;
};

const STATUS_TONES: Record<string, string> = {
  active: 'bg-chart-collected/10 text-chart-collected border-chart-collected/30',
  pending: 'bg-chart-servicing/5 text-chart-servicing border-chart-servicing/30',
  suspended: 'bg-chart-danger/10 text-chart-danger border-chart-danger/30',
};

const STATUS_PILL = 'rounded-full border px-3 py-1 text-xs font-semibold';

export function DriverProfileCard() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const result = await fetchApiJson<{ profile?: Profile }>('/api/profile');

        if (cancelled) return;

        if (!result.ok) {
          setProfile(null);
          return;
        }

        setProfile(result.data.profile ?? null);

        // The photo is requested only once the profile has resolved, so the id
        // is known and there is no point asking for a driver who has no profile.
        const photo = await fetch('/api/profile/photo', { cache: 'no-store' });

        if (cancelled) return;

        if (photo.ok) {
          const payload = (await photo.json()) as { photoUrl?: string | null };
          setPhotoUrl(payload.photoUrl ?? null);
        }
      } catch {
        if (!cancelled) setProfile(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading) {
    return (
      <div className="card" aria-busy="true">
        <div className="h-6 w-48 animate-pulse rounded bg-surface-2" />
      </div>
    );
  }

  // No profile is a real state for an account whose row has not been created
  // yet. Rendering nothing is honest; rendering an empty shell would suggest the
  // card failed to load.
  if (!profile) {
    return null;
  }

  const displayName = profile.fullName?.trim() || 'Driver';

  return (
    <section className="card" aria-label="Your profile">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <DriverAvatar
          photoUrl={photoUrl}
          fullName={displayName}
          sizeClassName="h-16 w-16 text-lg"
          label={`${displayName}'s face photo`}
        />

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-xl font-bold text-content">{displayName}</h2>
            <span
              className={`${STATUS_PILL} ${STATUS_TONES[profile.status] ?? 'bg-surface-2 text-content-muted border-line'}`}
            >
              {profile.status}
            </span>
          </div>

          <p className="mt-1 text-sm text-content-muted">
            {profile.phone ? (
              <span>{profile.phone}</span>
            ) : (
              <span>No phone number on file</span>
            )}
          </p>

          {!photoUrl ? (
            <p className="mt-1 text-xs text-content-subtle">
              No face photo on file. Add one in Settings so managers can identify you during
              document review.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}