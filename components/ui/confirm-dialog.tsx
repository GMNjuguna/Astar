'use client';

/**
 * Accessible confirmation dialog.
 *
 * Extracted from the logout button, which had the only correct modal in the app --
 * the five payout modals that predate it are plain overlays with no `role`, no
 * focus trap and no Escape handling. Rather than write a fourth variant for the
 * fleet page, the working one is now shared.
 *
 * ── Defaults that matter, and why ───────────────────────────────────────────
 * - Focus starts on **Cancel**, not the confirming button. Both dialogs that use
 *   this are destructive, and the cost of a stray Enter should be zero. A caller
 *   that genuinely wants the destructive default can pass
 *   `initialFocus="confirm"`, but nothing here does.
 * - **Escape closes**, and so does a backdrop press that both starts and ends
 *   outside the panel -- the containment test matters, because a text selection
 *   dragged from inside the dialog to outside it would otherwise discard the
 *   dialog and the selection with it.
 * - **Focus is returned** to whatever had it before the dialog opened. Without
 *   this, a keyboard user is dropped at the top of the document after every
 *   confirmation.
 * - **Tab is trapped** at both ends, including the case where focus arrives from
 *   outside the panel, which happens when the browser moves focus to browser UI
 *   while the dialog is open.
 * - **Body scroll is locked** and restored to its previous value, not to `''`,
 *   so a page that was already scroll-locked stays locked.
 *
 * `aria-busy` is reflected while a confirm handler is in flight, so the button
 * states are not announced as available.
 */
import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type ConfirmDialogProps = {
  open: boolean;
  /** Called on Escape, backdrop press, and Cancel. Ignored while `busy`. */
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  /** Small label above the title. Purely decorative -- not read as the name. */
  eyebrow?: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Shown while `busy`. Defaults to `confirmLabel` with an ellipsis. */
  busyLabel?: string;
  cancelLabel?: string;
  /**
   * `danger` renders the confirm button in the error colour. Used for anything
   * that destroys state -- deleting a vehicle, signing out.
   */
  tone?: 'danger' | 'primary';
  busy?: boolean;
  /** Rendered above the buttons with `role="alert"`. */
  error?: string | null;
  /**
   * Element to focus when the dialog opens. Defaults to the cancel button, which
   * is the safe choice; pass the confirm button only for non-destructive flows.
   */
  initialFocusRef?: RefObject<HTMLButtonElement>;
  /** Element focused on close. Usually the control that opened the dialog. */
  returnFocusRef?: RefObject<HTMLElement>;
};

const DANGER_BUTTON =
  'bg-chart-danger px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

const PRIMARY_BUTTON =
  'bg-brand-solid px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-solid-strong disabled:cursor-not-allowed disabled:opacity-60';

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  eyebrow,
  title,
  description,
  confirmLabel,
  busyLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  error = null,
  initialFocusRef,
  returnFocusRef,
}: ConfirmDialogProps) {
  // Generated rather than hard-coded, so two dialogs in one tree cannot collide
  // on `aria-labelledby` -- which would leave both announcing the wrong name.
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Read inside the keydown listener, which is registered once per open/close.
  // A ref avoids re-registering the listener on every busy-state change.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const close = useCallback(() => {
    if (busyRef.current) return;
    onClose();
    returnFocusRef?.current?.focus();
  }, [onClose, returnFocusRef]);

  useEffect(() => {
    if (!open) return;

    const target = initialFocusRef ?? cancelRef;
    target.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }

      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Wrap at both ends. The `!panel.contains(active)` arm covers focus
      // arriving from outside the dialog, which happens when the browser moves
      // focus to the address bar or a browser UI element mid-dialog.
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close, initialFocusRef]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        // Only a press that both starts and ends on the backdrop dismisses.
        // Otherwise a text selection that began inside the panel and ended
        // outside it would close the dialog and lose the selection.
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-xl"
      >
        {eyebrow ? (
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">{eyebrow}</p>
        ) : null}

        <h2 id={titleId} className="mt-2 text-2xl font-bold text-content">
          {title}
        </h2>

        <div id={descriptionId} className="mt-3 text-sm leading-6 text-content-subtle">
          {description}
        </div>

        {error ? (
          <p
            id={errorId}
            role="alert"
            className="mt-4 rounded-lg bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-content-muted transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => {
              void onConfirm();
            }}
            disabled={busy}
            aria-describedby={error ? errorId : undefined}
            className={`rounded-lg ${tone === 'danger' ? DANGER_BUTTON : PRIMARY_BUTTON}`}
          >
            {busy ? (busyLabel ?? `${confirmLabel}...`) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}