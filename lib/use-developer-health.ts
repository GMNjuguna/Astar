'use client';

/**
 * Polls `/api/developer/health` for the Developer System Portal.
 *
 * ── Why this is a hook and not two fetches ─────────────────────────────────
 * The portal renders the same health figure in three places: the header badge,
 * the four summary cards, and the health panel in the Overview tab. Reading the
 * endpoint once per place would mean three polls on the same 30-second cadence,
 * and — because they resolve independently — a header reading "Degraded" above a
 * panel reading "All clear" for as long as one in-flight request lagged. The
 * page owns one instance and passes it down, the same way the CEO page owns the
 * analytics range.
 *
 * ── Why a failed refresh does not blank the screen ──────────────────────────
 * The previous behaviour in this portal was to hold a set of invented constants
 * as the initial state, which made a failed request invisible: the numbers simply
 * never changed. The replacement has to do the opposite — show that the read
 * failed — without destroying the last good reading. So a background failure
 * sets `error` and keeps `payload`; the panel renders a stale badge with an
 * explicit age rather than an empty panel or a fabricated number.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchApiJson } from '@/lib/api-client';
import type { DeveloperHealthPayload } from '@/types/developer-health';

/** How often the health check re-runs on its own. */
export const HEALTH_POLL_INTERVAL_MS = 30_000;

export type DeveloperHealthState = {
  payload: DeveloperHealthPayload | null;
  /** True only before the very first response; later refreshes do not blank it. */
  isLoading: boolean;
  /** True while a manual or interval refresh is in flight over existing data. */
  isRefreshing: boolean;
  error: string | null;
  /** Manual trigger, for the "Refresh metrics" button. */
  refresh: () => void;
};

export function useDeveloperHealth(): DeveloperHealthState {
  const [payload, setPayload] = useState<DeveloperHealthPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Guards against overlapping requests.
   *
   * Without it, clicking "Refresh metrics" repeatedly queues one request per
   * click; they land out of order, so a slow first response overwrites a fast
   * second one and the panel ends up showing a reading older than the badge above
   * it. The interval can also fire while a manual refresh is still running.
   */
  const inFlight = useRef(false);

  const load = useCallback(async (background: boolean) => {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;

    if (background) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    const result = await fetchApiJson<DeveloperHealthPayload>('/api/developer/health');

    inFlight.current = false;

    if (result.ok) {
      setPayload(result.data);
      setError(null);
    } else {
      // Deliberately not clearing `payload`: the last reading is still the most
      // recent thing known, and the caller is told about the failure separately.
      setError(result.message);
    }

    setIsLoading(false);
    setIsRefreshing(false);
  }, []);

  const refresh = useCallback(() => {
    void load(payload !== null);
  }, [load, payload]);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    // Initial read, then the 30-second poll.
    void load(false).then(() => {
      // The first read is awaited rather than fired and forgotten so the poll does
      // not start until it settles; otherwise a slow first response could be
      // overwritten by an interval tick.
      if (cancelled) {
        return;
      }

      interval = setInterval(() => {
        void load(true);
      }, HEALTH_POLL_INTERVAL_MS);
    });

    return () => {
      // Without this the interval outlives the component, so navigating away from
      // /developer keeps polling the endpoint for the rest of the session.
      cancelled = true;

      if (interval !== null) {
        clearInterval(interval);
      }
    };
  }, [load]);

  return { payload, isLoading, isRefreshing, error, refresh };
}
