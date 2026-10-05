'use client';

/**
 * Sign-out control for the shared portal header.
 *
 * ── Why a confirmation dialog ───────────────────────────────────────────────
 * Signing out is destructive to the session even though it touches no data: the
 * driver who is three fields into a daily log loses it. A confirm step is cheap
 * insurance, so the dialog asks first. It is a real modal dialog -- `role`,
 * `aria-modal`, focus trap, Escape, focus restored to the trigger -- because
 * without those it is a div that happens to cover the screen, which a
 * screen-reader user can tab straight out of. Those behaviours now live in
 * `ConfirmDialog`, shared with the fleet page.
 *
 * ── Why a hard navigation, not router.replace() ──────────────────────────────
 * `signOut()` clears the auth cookie and revokes the refresh token server-side.
 * That is enough to invalidate the middleware: `middleware.ts` calls
 * `supabase.auth.getUser()` on every request, which revalidates the JWT against
 * the auth server rather than trusting anything cached locally — so there is no
 * stale session token left to invalidate and the next request is rejected.
 *
 * What `signOut()` does *not* clear is Next.js' client-side Router Cache, which
 * still holds the RSC payload for the page the user is currently looking at. A
 * `router.replace('/login')` swaps the visible route but that cache can be
 * reused on a later back/forward navigation, briefly re-rendering authenticated
 * markup. `window.location.assign` forces a document navigation, so the cache is
 * dropped wholesale and the middleware re-runs on a clean slate. It costs a full
 * page load, which is the correct trade for the one action that must not leave
 * residue behind.
 *
 * The failure path deliberately does not navigate: if revocation fails the
 * session is still live, so pretending to have signed out would strand the user
 * on a login page that silently bounces them back into the portal.
 */
import { useCallback, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { createSupabaseClient } from '@/lib/supabase/client';

function ExitIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

export function LogoutButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);

  const confirmLogout = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const supabase = createSupabaseClient();
      // Default scope ('global') revokes every refresh token for this user, not
      // just this browser's. Stronger than strictly necessary for a shared
      // dispatch tablet, and the safer default against a lifted token.
      const { error: signOutError } = await supabase.auth.signOut();

      if (signOutError) {
        setError('Could not sign out. Please try again.');
        setBusy(false);
        return;
      }

      window.location.assign('/login');
    } catch {
      setError('Could not sign out. Please try again.');
      setBusy(false);
    }
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        title="Sign out"
        aria-label="Sign out"
        aria-haspopup="dialog"
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-sm font-medium text-content-muted transition hover:border-chart-danger hover:text-chart-danger"
      >
        <ExitIcon />
        {/* The label collapses on narrow viewports so the header keeps the icon
            affordance rather than overflowing into a second row. */}
        <span className="hidden sm:inline">Sign out</span>
      </button>

      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirmLogout}
        eyebrow="Session"
        title="Sign out of Astar Travels?"
        description={
          <>
            You will be returned to the sign-in page and this device will forget your session.
            Any unsaved work on this screen is discarded.
          </>
        }
        confirmLabel="Sign out"
        busyLabel="Signing out..."
        cancelLabel="Stay signed in"
        busy={busy}
        error={error}
        returnFocusRef={triggerRef}
      />
    </>
  );
}