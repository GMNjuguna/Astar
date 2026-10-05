import Link from 'next/link';

import { BrandLogo } from '@/components/ui/BrandLogo';

/**
 * Root 404 page.
 *
 * Handles unmatched routes resolved at the root segment. Because it sits beside
 * `app/layout.tsx` rather than inside `(dashboard)/layout.tsx`, the dashboard's
 * `bg-canvas` shell is not available here, so this page supplies its own
 * full-height dark background for consistency with every other route.
 *
 * Server component: no interactivity, so no `"use client"` and no client JS.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col bg-canvas text-content">
      <header className="mx-auto w-full max-w-6xl px-6 py-4">
        <Link href="/" className="inline-flex items-center gap-3">
          <BrandLogo size="sm" variant="full" />
        </Link>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-accent">Error 404</p>

          <h1 className="mt-3 text-4xl font-bold text-content sm:text-5xl">Page not found</h1>

          <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-content-muted">
            The page you requested does not exist, or it may have been moved. Check the address, or head back to
            your dashboard.
          </p>

          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              href="/login"
              className="rounded-lg bg-brand-solid px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-solid-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Go to sign in
            </Link>

            {/*
              Points at `/`, which is the public landing page. The four portals
              (/ceo, /manager, /developer, /driver) each resolve a different
              dashboard based on the signed-in role, so there is no single
              correct portal URL to hardcode here. Middleware redirects an
              authenticated user from `/` to whichever portal their profile
              permits.
            */}
            <Link
              href="/"
              className="rounded-lg border border-line bg-surface px-5 py-2.5 text-sm font-semibold text-content transition hover:bg-line focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}