'use client';

import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';

/**
 * Client boundary for next-themes.
 *
 * next-themes has to inject a blocking inline script into <head> that sets the
 * theme class before first paint. That is what prevents the flash of the wrong
 * colour scheme — without it a dark-mode user sees a white page for a frame
 * while React hydrates. This component exists only so the provider can live
 * under the server-rendered root layout; it renders no markup of its own.
 *
 * `attribute="class"` matches the `.dark { ... }` block in globals.css rather
 * than a `data-theme` attribute, so the CSS selector stays conventional.
 *
 * `disableTransitionOnChange` suppresses the CSS colour transition during the
 * switch itself. Every animated property would otherwise tween, so the change
 * arrives as a sweep across the page instead of an instant repaint.
 */
export function ThemeProviderWrapper({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="astar-theme"
    >
      {children}
    </ThemeProvider>
  );
}