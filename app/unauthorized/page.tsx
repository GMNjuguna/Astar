import Link from 'next/link';

export default function UnauthorizedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-2 px-4">
      <div className="w-full max-w-lg rounded-xl border border-chart-servicing/30 bg-surface p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-chart-servicing/5 text-2xl">⚠️</div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-chart-servicing">Access restricted</p>
        <h1 className="mt-3 text-3xl font-bold text-content">Unauthorized</h1>
        <p className="mt-4 text-sm text-content-subtle">
          You do not have permission to access this area of the Astar Travels platform.
        </p>

        <Link
          href="/login"
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-canvas px-4 py-2.5 text-sm font-semibold text-content transition hover:bg-surface-2"
        >
          Return to Login
        </Link>
      </div>
    </main>
  );
}
