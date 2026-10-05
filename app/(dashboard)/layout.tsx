import Link from 'next/link';
import { AIAssistantWidget } from '@/components/driver/ai-assistant-widget';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { LogoutButton } from '@/components/ui/logout-button';
import { SettingsLink } from '@/components/ui/settings-link';
import { ThemeToggle } from '@/components/ui/theme-toggle';

const navItems = [
  { label: 'CEO', href: '/ceo' as const },
  { label: 'Manager', href: '/manager' as const },
  { label: 'Developer', href: '/developer' as const },
  { label: 'Driver', href: '/driver' as const },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-canvas text-content">
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <Link href="/" className="flex items-center gap-3">
            <BrandLogo
              size="sm"
              variant="full"
              className="drop-shadow-[0_0_12px_rgba(255,78,66,0.3)]"
            />
          </Link>

          {/*
           * The nav wraps rather than scrolling. Four portal links plus Settings
           * and the theme toggle overflow a narrow viewport, and a horizontally
           * scrolling header hides the theme switch — the one control with no
           * equivalent anywhere else on the page.
           */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <nav className="flex flex-wrap items-center gap-1 text-sm text-content-muted">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-full px-3 py-1.5 transition hover:bg-surface hover:text-content"
                >
                  {item.label}
                </Link>
              ))}

              {/*
               * Rendered by a client component so it can read the current path.
               * The route it links to is derived from that path, which keeps this
               * single shared header correct for all four portals.
               */}
              <SettingsLink />
            </nav>

            {/*
             * The theme switch lives in the shared header rather than inside
             * each portal, so it is reachable from every screen in every role
             * and there is exactly one implementation to keep consistent.
             *
             * Sign-out sits beside it for the same reason, and is grouped with a
             * divider so the two session-scoped controls read as a set rather
             * than trailing off the end of the navigation.
             */}
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <span aria-hidden="true" className="h-6 w-px bg-line" />
              <LogoutButton />
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      <AIAssistantWidget />
    </div>
  );
}
