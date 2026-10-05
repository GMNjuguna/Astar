'use client';

/**
 * Loads `/api/analytics` for a time range.
 *
 * ── Why the range lives in the page, not in each panel ──────────────────────
 * The CEO dashboard stacks four things that all read the same three tables: the
 * metric cards, the analytics charts, the remittance ledger and the fleet
 * tracker. Each of them used to own its own data, which is how the page ended up
 * showing a "today" revenue card, a 30-day chart and a hardcoded ledger side by
 * side with no two agreeing. Lifting the range and the payload to the page makes
 * the four read one response, so they cannot disagree.
 *
 * ── Why a refetch on every range change, with no cache ──────────────────────
 * This is an operational dashboard, and a stale revenue figure is worse than a
 * slow one. There is deliberately no shared cache keyed by range: two components
 * mounting together must see the same numbers, and the only way to guarantee
 * that is for the page to hold the single response they all read.
 */
import { useCallback, useEffect, useState } from 'react';

import { fetchApiJson } from '@/lib/api-client';
import type { TimeRange } from '@/lib/analytics';
import type { AnalyticsPayload } from '@/types/analytics';

export type AnalyticsState = {
  payload: AnalyticsPayload | null;
  isLoading: boolean;
  error: string | null;
  /** Re-runs the request for the current range, e.g. after a fleet edit. */
  reload: () => void;
};

export function useAnalytics(range: TimeRange): AnalyticsState {
  const [payload, setPayload] = useState<AnalyticsPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Bumped by `reload` to re-trigger the effect. Used instead of calling the
   * loader directly so an in-flight request for a superseded range cannot land
   * after the newer one and overwrite it.
   */
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);

      const result = await fetchApiJson<AnalyticsPayload>(`/api/analytics?range=${range}`);

      if (cancelled) {
        return;
      }

      setIsLoading(false);

      if (!result.ok) {
        // The previous payload is deliberately kept. A failed refetch after a
        // fleet edit should not blank the screen back to nothing; the error is
        // shown alongside, so the reader can see the figures are stale.
        setError(result.message);
        return;
      }

      setError(null);
      setPayload(result.data);
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [range, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { payload, isLoading, error, reload };
}