'use client';

/**
 * Sun/Moon theme switch.
 *
 * ── Why the mounted guard ──────────────────────────────────────────────────
 * The resolved theme is unknown on the server and during the first client
 * render, because it depends on localStorage and the OS preference. Rendering
 * the inactive icon until `mounted` is true means the server and first client
 * render agree, so there is no hydration mismatch and no flash of the wrong
 * glyph. A fixed-size placeholder reserves the space, so nothing shifts when the
 * real icon appears.
 *
 * The button is intentionally left unlabelled until mounted rather than given a
 * static label: a "Switch to dark mode" label that is wrong for half a second is
 * worse than no label, and `aria-label` on the mounted version is accurate.
 *
 * `aria-live="polite"` is on the wrapper so the state change is announced
 * without stealing focus.
 */
import { useEffect, useState } from 'react';

import { useThemePreference, type ThemeChoice } from '@/lib/theme-preference';

export type ThemeToggleVariant = 'icon' | 'segmented';

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <circle cx={12} cy={12} r={4} />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x={2} y={3} width={20} height={14} rx={2} />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

/** Resolves the next theme in the light -> dark -> system cycle. */
function nextTheme(current: string | undefined): ThemeChoice {
  if (current === 'system') return 'light';
  if (current === 'light') return 'dark';
  return 'system';
}

const SEGMENTS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const;

export function ThemeToggle({ variant = 'icon' }: { variant?: ThemeToggleVariant }) {
  // `useThemePreference` rather than `useTheme`, so a change made here is
  // recorded against the account and not just in this browser.
  const { theme, resolvedTheme, setTheme } = useThemePreference();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = resolvedTheme === 'dark';

  const actionLabel = !mounted
    ? 'Theme'
    : theme === 'system'
      ? `Theme: following system (currently ${isDark ? 'dark' : 'light'}). Activate to use light.`
      : `Theme: ${theme}. Activate to use ${nextTheme(theme)}.`;

  if (variant === 'segmented') {
    return (
      <div
        role="group"
        aria-label="Theme"
        className="inline-flex rounded-lg border border-line bg-surface-2 p-1"
      >
        {SEGMENTS.map((segment) => {
          const active = mounted && theme === segment.value;

          return (
            <button
              key={segment.value}
              type="button"
              onClick={() => setTheme(segment.value)}
              aria-pressed={active}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                active
                  ? 'bg-brand-solid text-white'
                  : 'text-white-subtle hover:text-white'
              }`}
            >
              {segment.value === 'system' ? <MonitorIcon /> : null}
              {segment.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <span aria-live="polite" className="inline-flex">
      <button
        type="button"
        onClick={() => setTheme(nextTheme(theme))}
        title={actionLabel}
        aria-label={actionLabel}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface-2 text-content transition hover:border-accent hover:text-accent"
      >
        {/* Fixed-size box either way, so the header does not reflow on mount. */}
        {mounted ? (
          isDark ? (
            <MoonIcon />
          ) : (
            <SunIcon />
          )
        ) : (
          <span className="block h-[18px] w-[18px]" aria-hidden="true" />
        )}
      </button>
    </span>
  );
}