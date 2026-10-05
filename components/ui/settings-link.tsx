'use client';

/**
 * "Profile & Settings" link in the shared dashboard header.
 *
 * ── Why a separate client component ─────────────────────────────────────────
 * The header lives in a server component (`app/(dashboard)/layout.tsx`), which
 * cannot call `usePathname()`. Isolating the one link that needs the current
 * route keeps the rest of the header server-rendered.
 *
 * ── Why the href is derived from the path ───────────────────────────────────
 * Rather than four hand-written links, one per portal, the destination is
 * computed from the route the user is currently on.
 *
 * ── Why there is a real fallback route ──────────────────────────────────────
 * `/settings` is a genuine page, not a stub. An unrecognised portal — or the
 * fallback page itself, whose own path resolves to no known portal — still lands
 * somewhere that renders the panel inside the same header, rather than on a 404.
 * The href is typed as the union of those routes because `typedRoutes` is enabled
 * in next.config, and a computed `string` will not typecheck.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** First path segment of each portal that has its own settings page. */
const PORTALS = ['ceo', 'manager', 'developer', 'driver'] as const;

type Portal = (typeof PORTALS)[number];
type SettingsRoute = '/settings' | `/ceo/settings` | `/manager/settings` | `/developer/settings` | `/driver/settings`;

function routeForPortal(portal: string): SettingsRoute {
  return (PORTALS as readonly string[]).includes(portal)
    ? (`/${portal}/settings` as SettingsRoute)
    : '/settings';
}

export function SettingsLink() {
  const pathname = usePathname();
  const portal = pathname?.split('/').filter(Boolean)[0] ?? '';

  return (
    <Link
      href={routeForPortal(portal)}
      className="rounded-full border border-line px-3 py-1.5 transition hover:border-accent hover:text-accent"
    >
      Settings
    </Link>
  );
}