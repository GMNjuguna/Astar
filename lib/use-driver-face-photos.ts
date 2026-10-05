'use client';

/**
 * Batched driver identity (name + face photo) for reviewer surfaces.
 *
 * Both the manager driver list and the CEO approval queue need the same thing: a
 * map of driver id to a name and a short-lived signed URL, fetched once per set of
 * ids rather than once per row. Signing per row would mean a review queue of
 * twenty drivers issuing twenty storage round trips before it could paint.
 *
 * ── Why the URLs are never cached across mounts ─────────────────────────────
 * Each URL expires in an hour. The hook holds them in component state, so they
 * live exactly as long as the view that asked for them and are re-minted on the
 * next mount. There is deliberately no persistence to localStorage -- a cached
 * face photo URL is exactly the kind of durable link the private bucket exists
 * to prevent.
 *
 * ── Why a failed request degrades instead of throwing ───────────────────────
 * A missing photo is not an error condition, it is the common case for drivers
 * who have not uploaded one, so those ids are simply absent from the map and the
 * caller falls back to the name it already has. A transport failure *is* tracked,
 * because "the avatar bucket is unreachable" should be visible as a broken page
 * rather than as a queue of drivers mysteriously without photos.
 */
import { useEffect, useState } from 'react';

import { fetchApiJson } from '@/lib/api-client';
import type { ReviewerDriverIdentity } from '@/app/api/reviewer/face-photos/route';

type PhotoState = {
  drivers: Record<string, ReviewerDriverIdentity>;
  isLoading: boolean;
  error: string | null;
};

const EMPTY: PhotoState = { drivers: {}, isLoading: false, error: null };

/** Stable key for a set of ids, so a re-render does not refetch unchanged input. */
function idsKey(ids: string[]): string {
  return [...ids].sort().join(',');
}

export function useDriverFacePhotos(driverIds: string[]): PhotoState {
  const [state, setState] = useState<PhotoState>(EMPTY);

  const key = idsKey(driverIds);

  useEffect(() => {
    const ids = key ? key.split(',') : [];

    if (ids.length === 0) {
      setState(EMPTY);
      return;
    }

    let cancelled = false;

    setState((current) => ({ ...current, isLoading: true, error: null }));

    (async () => {
      const result = await fetchApiJson<{ drivers?: Record<string, ReviewerDriverIdentity> }>(
        `/api/reviewer/face-photos?driverIds=${encodeURIComponent(ids.join(','))}`
      );

      if (cancelled) return;

      if (!result.ok) {
        setState({ drivers: {}, isLoading: false, error: result.message });
        return;
      }

      setState({
        drivers: result.data.drivers ?? {},
        isLoading: false,
        error: null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [key]);

  return state;
}