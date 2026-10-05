'use client';

/**
 * The single place that knows how a theme change is recorded.
 *
 * ── Why not just `useTheme().setTheme` ─────────────────────────────────────
 * A theme preference that lives only in localStorage does not follow the user
 * to a second device, so it needs a server-side record too. But the toggle
 * appears in three places — the shared dashboard header, the portal sidebars
 * and the Settings panel — and if each of them owned the save step they would
 * drift: one would post the new theme, another would post a stale copy of the
 * previous one and silently undo it. Wrapping `setTheme` means every caller
 * persists by construction, and there is no path that changes the theme without
 * recording the choice.
 *
 * ── Why failures are silent ────────────────────────────────────────────────
 * The caller's session may not be established yet (the header toggle renders
 * before hydration completes on some pages), and the preferences table is not
 * provisioned until the migration runs. Neither is worth interrupting a theme
 * switch over: next-themes has already written localStorage, so the choice is
 * already in effect on this device. The Settings panel reports persistence
 * state separately, where there is room to explain it.
 *
 * ── Why no extra localStorage key ──────────────────────────────────────────
 * next-themes already persists under `astar-theme` before this runs. A second
 * copy would be a second source of truth that could disagree with the first.
 */
import { useCallback } from 'react';
import { useTheme } from 'next-themes';

import { fetchApiJson } from '@/lib/api-client';

export type ThemeChoice = 'light' | 'dark' | 'system';

export function useThemePreference() {
  const { theme, resolvedTheme, setTheme: setNextTheme } = useTheme();

  const setTheme = useCallback(
    (next: ThemeChoice) => {
      // Applied locally first, always. The colour scheme is what the user is
      // looking at right now and must not wait on a network round trip.
      setNextTheme(next);

      void fetchApiJson<{ ok: true }>('/api/profile/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Only the theme field. Sending the whole preferences object from here
        // would let a toggle click overwrite a notification setting the user
        // changed in another tab, from a stale render.
        body: JSON.stringify({ theme: next }),
      });
    },
    [setNextTheme]
  );

  return { theme, resolvedTheme, setTheme };
}