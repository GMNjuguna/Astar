/**
 * Global loading boundary.
 *
 * Sits directly beneath `app/layout.tsx`, which means it renders *outside*
 * `app/(dashboard)/layout.tsx`. That matters: the dashboard's `bg-canvas`
 * shell is not in scope here, so this component supplies its own full-height
 * dark background. Without it the boundary would expose the light
 * `linear-gradient(180deg, #f7f9fc, #ffffff)` on `body` in app/globals.css and
 * flash white on every dashboard navigation — the exact problem `themeColor` in
 * app/layout.tsx is meant to prevent.
 *
 * No `"use client"` directive: this is a static skeleton with no interactivity,
 * so it stays a server component and ships no client JavaScript.
 */

/**
 * One shimmering placeholder bar. `aria-hidden` keeps the decorative rectangles
 * out of the accessibility tree so screen readers announce only the status
 * message, not six meaningless empty boxes.
 */
function SkeletonBar({ className }: { className: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-full bg-line ${className}`} />;
}

export default function Loading() {
  return (
    <main
      className="min-h-screen bg-canvas text-content"
      // Politely announced rather than assertively: a loading state is not an
      // emergency and must not interrupt whatever the user is doing.
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading…</span>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <SkeletonBar className="h-3 w-32" />
            <SkeletonBar className="mt-3 h-8 w-80" />
          </div>
          <SkeletonBar className="h-4 w-48" />
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="rounded-2xl border border-line bg-surface p-5">
              <SkeletonBar className="h-3 w-28" />
              <SkeletonBar className="mt-4 h-7 w-24" />
              <SkeletonBar className="mt-3 h-3 w-20" />
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-2xl border border-line bg-surface p-5">
          <SkeletonBar className="h-4 w-40" />
          <div className="mt-5 space-y-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex items-center justify-between gap-4">
                <SkeletonBar className="h-4 flex-1" />
                <SkeletonBar className="h-4 w-24" />
                <SkeletonBar className="h-6 w-20 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}