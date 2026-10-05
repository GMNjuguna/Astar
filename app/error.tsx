'use client';

import { useEffect } from 'react';

/**
 * Root error boundary for the App Router.
 *
 * Scope, stated precisely because it is a common misunderstanding: this catches
 * errors thrown while rendering the segments *below* `app/layout.tsx`. It does
 * NOT catch an error thrown by `app/layout.tsx` itself, nor by the root layout's
 * own body. Catching those requires `app/global-error.tsx`, which replaces the
 * entire document including `<html>`. See the notes in the project README.
 *
 * This boundary also wraps `(dashboard)/layout.tsx`, so a crash anywhere in the
 * CEO, Manager, Developer or Driver portals lands here rather than showing a
 * blank page.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /**
   * Log in an effect rather than in the component body.
   *
   * A body-level log would fire on every re-render, including the re-render
   * that `reset()` triggers, burying the original failure under duplicates. An
   * effect keyed on `error` runs once per distinct error instance.
   *
   * `digest` is the only stable identifier Next.js gives us in production: the
   * real `message` and stack are stripped server-side before reaching the
   * client, so `digest` is what correlates this with the server log.
   */
  useEffect(() => {
    console.error('[app/error.tsx] Uncaught render error', {
      message: error.message,
      digest: error.digest ?? null,
      stack: error.stack ?? null,
    });
  }, [error]);

  const isDevelopment = process.env.NODE_ENV === 'development';

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12 text-content">
      {/*
        `role="alert"` + `aria-live="assertive"` because this replaces content
        the user was waiting on. An error is the opposite of the polite loading
        state: it should be announced immediately.
      */}
      <div
        role="alert"
        aria-live="assertive"
        className="w-full max-w-lg rounded-2xl border border-chart-danger/30 bg-surface p-8 shadow-[0_30px_80px_rgba(18,20,24,0.45)]"
      >
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-chart-danger/15 text-xl"
          >
            !
          </span>

          <div className="min-w-0">
            <h1 className="text-xl font-bold text-content">Something went wrong</h1>
            <p className="mt-2 text-sm leading-relaxed text-content-muted">
              An unexpected error interrupted this page. Nothing you submitted has been lost. You can retry,
              or sign in again if the problem continues.
            </p>
          </div>
        </div>

        {/*
          The raw message is shown in development only. In production Next.js
          replaces `error.message` with a generic string precisely so internal
          details cannot leak, so rendering it unconditionally would either
          expose internals or display a useless "An error occurred".
        */}
        {isDevelopment ? (
          <pre className="mt-5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-canvas p-4 text-xs leading-relaxed text-chart-danger">
            {error.message}
          </pre>
        ) : null}

        {error.digest ? (
          <p className="mt-5 text-xs text-content-subtle">
            Reference for support:{' '}
            <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-content-muted">{error.digest}</code>
          </p>
        ) : null}

        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-lg bg-brand-solid px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-solid-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Try Again
          </button>

          <a
            href="/login"
            className="rounded-lg border border-line bg-canvas px-5 py-2.5 text-center text-sm font-semibold text-content transition hover:bg-line focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Back to sign in
          </a>
        </div>
      </div>
    </main>
  );
}