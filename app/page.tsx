import Image from 'next/image';
import Link from 'next/link';

import { BrandLogo } from '@/components/ui/BrandLogo';

/**
 * ── The hero photograph ─────────────────────────────────────────────────────
 * A second-generation Honda N-Box — the kei car this fleet is built around —
 * photographed in Moscow traffic.
 *
 * Hotlinked rather than vendored, per the decision to keep the asset out of the
 * repository. Two consequences worth knowing before editing this constant:
 *
 *   1. The host must stay in `images.remotePatterns` in `next.config.mjs`, or
 *      next/image throws at request time rather than degrading.
 *   2. Wikimedia asks hotlinked consumers to send a descriptive User-Agent and to
 *      keep request volume sane. next/image's optimiser fetches the origin once
 *      per generated size and caches to `.next/cache/images`, so the volume is
 *      bounded by how many distinct widths are requested — but a CDN in front of
 *      this app is the right long-term answer, and downloading the file into
 *      `public/` removes the dependency entirely.
 *
 * Source: "Moscow, Honda N-Box (2nd gen) Sept 2025 41.jpg" by Retired electrician,
 * CC0 (public domain dedication) — no attribution or share-alike obligation.
 * https://commons.wikimedia.org/wiki/File:Moscow,_Honda_N-Box_(2nd_gen)_Sept_2025_41.jpg
 */
const HERO_IMAGE =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/Moscow%2C_Honda_N-Box_%282nd_gen%29_Sept_2025_41.jpg/1920px-Moscow%2C_Honda_N-Box_%282nd_gen%29_Sept_2025_41.jpg';

const HERO_IMAGE_ALT = 'Silver Honda N-Box kei car in city traffic';

const fleetStats = [
  {
    label: 'Active vehicles',
    value: '148',
    detail: 'of 156 in service',
    accent: 'text-chart-collected',
    bar: 'bg-chart-collected',
    fill: 95,
  },
  {
    label: 'Operational coverage',
    value: '96.4%',
    detail: 'on-time dispatch',
    accent: 'text-chart-billed',
    bar: 'bg-chart-billed',
    fill: 96,
  },
  {
    label: 'Trips logged today',
    value: '1,284',
    detail: 'across six corridors',
    accent: 'text-chart-violet',
    bar: 'bg-chart-violet',
    fill: 78,
  },
] as const;

const featurePillars = [
  {
    title: 'Fleet visibility',
    text: 'Track vehicle availability, route health and convoy performance across every active corridor.',
  },
  {
    title: 'Driver-first flow',
    text: 'Give drivers an intuitive control layer for logs, checklists, route events and service timing.',
  },
  {
    title: 'Secure operations',
    text: 'Role-based access and system controls maintain oversight without slowing down frontline teams.',
  },
] as const;

/**
 * The four portals.
 *
 * `href` carries a `role` parameter only where the login form can act on it. That
 * parameter seeds the registration form's role picker, whose union is
 * `ceo | manager | developer` — so `?role=driver` is deliberately absent and the
 * driver card links to a plain `/login`. Sending it anyway would silently
 * preselect "Manager" for anyone who then switches the form to Register.
 *
 * Driver accounts are invite-provisioned by a fleet manager rather than
 * self-registered, so a generic sign-in link is the honest destination there.
 */
const portals = [
  {
    role: 'CEO',
    href: '/login?role=ceo',
    blurb: 'Network-wide revenue, remittance and fleet oversight.',
  },
  {
    role: 'Manager',
    href: '/login?role=manager',
    blurb: 'Driver onboarding, route assignment and corridor health.',
  },
  {
    role: 'Developer',
    href: '/login?role=developer',
    blurb: 'Platform diagnostics, user administration and the AI assistant.',
  },
  {
    role: 'Driver',
    href: '/login',
    blurb: 'Daily logs, checklists, documents and payout status.',
  },
] as const;

export default function HomePage() {
  return (
    <main className="min-h-screen overflow-hidden bg-canvas text-content">
      <section className="relative isolate">
        <div className="absolute inset-0">
          <Image
            src={HERO_IMAGE}
            alt={HERO_IMAGE_ALT}
            fill
            priority
            className="object-cover"
            sizes="100vw"
          />
          {/*
           * The scrim is what makes overlaid text pass AA over a photograph, and
           * it is built from the `canvas` token so it inverts with the theme: a
           * near-white wash under near-black text in light mode, a near-black
           * wash under near-white text in dark. A single fixed-colour scrim
           * cannot do both.
           *
           * Two things are happening in the responsive stops. On mobile the copy
           * spans the full width, so the wash is held heavy and near-uniform
           * (95/90/85) — light enough to still read as a photograph, dark enough
           * that a bright sky behind the headline cannot wash out the text. From
           * `md` up the copy is confined to the left column, so the wash is
           * allowed to fall away to 30% on the right and the car is visible
           * rather than fogged.
           */}
          <div className="absolute inset-0 bg-gradient-to-r from-canvas/95 via-canvas/90 to-canvas/85 md:via-canvas/85 md:to-canvas/30" />
          {/* Fades the hero into the canvas so the next section has no hard seam. */}
          <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-canvas to-transparent" />
        </div>

        <div className="relative mx-auto max-w-7xl px-6 lg:px-10">
          {/* `bg-canvas/90`, not `/25`. This bar is sticky over a photograph but
              is a *sibling* of the hero scrim, not a descendant of it, so the
              scrim never accounts for it — at /25 the nav links sat on a
              25%-opaque wash and measured 1.6:1 against a dark scene. */}
          <header className="sticky top-0 z-20 -mx-6 mb-10 flex items-center justify-between gap-4 border-b border-line/40 bg-canvas/90 px-6 py-3 backdrop-blur-md lg:-mx-10 lg:px-10">
            <Link href="/" className="flex shrink-0 items-center gap-3">
              <BrandLogo size="sm" variant="full" className="drop-shadow-[0_0_12px_rgba(255,78,66,0.3)]" />
            </Link>

            {/* Collapses below md rather than shrinking: four links plus the
                sign-in pill do not fit at phone widths without wrapping. */}
            <nav className="hidden items-center gap-7 text-sm text-content-muted md:flex">
              <a href="#telemetry" className="transition hover:text-content">Telemetry</a>
              <a href="#features" className="transition hover:text-content">Features</a>
              <a href="#portals" className="transition hover:text-content">Portals</a>
              <a href="#contact" className="transition hover:text-content">Contact</a>
            </nav>

            <Link
              href="/login"
              className="shrink-0 rounded-full bg-brand-solid px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-solid-strong"
            >
              Sign In
            </Link>
          </header>

          {/*
           * One column on mobile, copy + telemetry side by side from lg. The
           * telemetry card drops below the copy on tablet because at `md` the
           * three stat tiles are still too narrow to sit beside a paragraph
           * without wrapping mid-value.
           */}
          <div className="grid items-center gap-10 pb-16 pt-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:pb-24 lg:pt-16">
            <div className="max-w-xl space-y-7">
              <div className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-surface/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-accent backdrop-blur-md">
                <span className="h-2 w-2 rounded-full bg-brand-500 shadow-[0_0_12px_rgba(255,78,66,0.8)]" />
                Fleet • Transport • Intelligence
              </div>

              <div className="space-y-5">
                <h1 className="text-4xl font-black leading-[1.05] tracking-[-0.05em] text-content sm:text-5xl md:text-6xl lg:text-7xl">
                  Move your fleet with mission control precision.
                </h1>
                <p className="max-w-lg text-base leading-7 text-content-muted sm:text-lg sm:leading-8">
                  Astar Travels gives operators a live operational cockpit for routing,
                  driver execution, vehicle health and service continuity across the
                  network.
                </p>
              </div>

              {/* flex-wrap so the two CTAs stack rather than overflow at 320px. */}
              <div className="flex flex-wrap gap-3 sm:gap-4">
                <Link
                  href="/login"
                  className="rounded-full bg-brand-solid px-6 py-3 text-sm font-semibold text-white shadow-[0_0_18px_rgba(255,78,66,0.28)] transition hover:bg-brand-solid-strong"
                >
                  Sign in to your portal
                </Link>
                <Link
                  href="/login?mode=register"
                  className="rounded-full border border-line-strong bg-surface/70 px-6 py-3 text-sm font-semibold text-content backdrop-blur-md transition hover:border-accent/60 hover:bg-surface"
                >
                  Create an account
                </Link>
              </div>

              <dl className="flex flex-wrap gap-x-8 gap-y-4 pt-2">
                {[
                  { term: '14k+', detail: 'trip events tracked' },
                  { term: '98.6%', detail: 'fleet availability' },
                  { term: '24/7', detail: 'operational support' },
                ].map((item) => (
                  <div key={item.term}>
                    <dd className="text-2xl font-bold tracking-[-0.03em] text-content">{item.term}</dd>
                    <dt className="text-sm text-content-muted">{item.detail}</dt>
                  </div>
                ))}
              </dl>
            </div>

            <div id="telemetry" className="scroll-mt-24">
              {/* `bg-surface/90`, not `/70`. This panel sits in the right column
                  where the scrim thins to 63%, so at /70 its own surface is only
                  half-resolved and the small accent label inside measures 4.32:1
                  in light mode. Raising the card's own opacity fixes every text
                  run inside it at once. */}
              <div className="w-full rounded-[2rem] border border-line-strong bg-surface/90 p-4 shadow-xl backdrop-blur-md sm:p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div className="rounded-full border border-line bg-canvas/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-content">
                    Fleet Telemetry
                  </div>
                  {/* No tinted wash behind this label. `bg-accent/10` over the
                      light card lands at 4.17:1 — the wash pulls the backdrop
                      toward the text colour, so adding alpha makes it worse, not
                      better. The border and the dot carry the accent instead. */}
                  <div className="flex items-center gap-2 rounded-full border border-accent/40 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-accent">
                    <span className="h-2 w-2 rounded-full bg-chart-collected shadow-[0_0_12px_rgba(52,211,153,0.8)]" />
                    Live
                  </div>
                </div>

                {/* grid-cols-1 first, then three across from md: on a phone the
                    tiles stack full-width so the figures stay legible, and at
                    640-767px three tiles would be ~190px each — too narrow for
                    a 30px figure plus its label. */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {fleetStats.map((stat) => (
                    <div
                      key={stat.label}
                      className="rounded-2xl border border-line bg-canvas/60 p-4"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-[10px] uppercase tracking-[0.18em] text-content-subtle">
                          {stat.label}
                        </span>
                        <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" />
                      </div>

                      <div className={`text-3xl font-black tracking-[-0.05em] ${stat.accent}`}>
                        {stat.value}
                      </div>
                      <p className="mt-1 text-xs text-content-subtle">{stat.detail}</p>

                      {/* Decorative: aria-hidden because the same figure is
                          already announced as text immediately above it. */}
                      <div
                        aria-hidden="true"
                        className="mt-3 h-1.5 overflow-hidden rounded-full bg-chart-track"
                      >
                        <div
                          className={`h-full rounded-full ${stat.bar}`}
                          style={{ width: `${stat.fill}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 rounded-2xl border border-line bg-canvas/60 p-4">
                  <div className="mb-3 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-content-subtle">
                    <span>Network Pulse</span>
                    <span className="text-chart-collected">Stable</span>
                  </div>

                  <div aria-hidden="true" className="flex items-end gap-2">
                    {[28, 46, 38, 62, 54, 72, 80, 68, 82, 96].map((height, index) => (
                      <div
                        key={index}
                        className="flex-1 rounded-t-md bg-brand-500"
                        style={{ height: `${height}px` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-7xl scroll-mt-24 px-6 py-16 lg:px-10 lg:py-24">
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-accent">
          Operations Matrix
        </p>
        <h2 className="mt-2 max-w-2xl text-3xl font-black tracking-[-0.04em] text-content md:text-4xl">
          Built for high-velocity transport teams.
        </h2>

        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-3">
          {featurePillars.map((feature) => (
            <div
              key={feature.title}
              className="rounded-[1.5rem] border border-line bg-surface p-5"
            >
              <div
                aria-hidden="true"
                className="mb-4 h-12 w-12 rounded-2xl bg-brand-500"
              />
              <h3 className="mb-3 text-xl font-bold text-content">{feature.title}</h3>
              <p className="text-sm leading-7 text-content-subtle">{feature.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section
        id="portals"
        className="mx-auto max-w-7xl scroll-mt-24 px-6 py-16 lg:px-10 lg:py-24"
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-accent">
          Role Portals
        </p>
        <h2 className="mt-2 max-w-2xl text-3xl font-black tracking-[-0.04em] text-content md:text-4xl">
          One platform, four views of the operation.
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-content-subtle">
          Sign in and you are routed to the portal your account is provisioned for.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {portals.map((portal) => (
            <Link
              key={portal.role}
              href={portal.href}
              className="group flex flex-col rounded-[1.5rem] border border-line bg-surface p-5 transition hover:border-accent/60"
            >
              <h3 className="text-lg font-bold tracking-[-0.02em] text-content">
                {portal.role}
              </h3>
              <p className="mt-2 flex-1 text-sm leading-6 text-content-subtle">
                {portal.blurb}
              </p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
                Sign in
                <span aria-hidden="true" className="transition group-hover:translate-x-0.5">
                  →
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <footer
        id="contact"
        className="scroll-mt-24 border-t border-line bg-surface-2 px-6 py-10 lg:px-10"
      >
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <BrandLogo size="sm" variant="full" />
          <p className="text-sm text-content-subtle">
            Astar Travels — fleet operations platform.
          </p>
          <Link
            href="/login"
            className="rounded-full border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-content transition hover:border-accent/60"
          >
            Sign in
          </Link>
        </div>
      </footer>
    </main>
  );
}
