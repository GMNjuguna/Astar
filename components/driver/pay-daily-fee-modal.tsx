'use client';

import { formatKsh } from '@/lib/format';

export function PayDailyFeeModal({
  open,
  amount,
  isProcessing,
  onClose,
  onPay,
}: {
  open: boolean;
  amount: number;
  isProcessing: boolean;
  onClose: () => void;
  onPay: (method: 'M-PESA' | 'Paystack') => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/50 px-4">
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Payment</p>
            <h3 className="mt-2 text-2xl font-bold text-content">Pay daily fee</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-content-subtle transition hover:text-content"
          >
            Close
          </button>
        </div>

        <div className="mt-6 rounded-xl bg-surface-2 p-4">
          <p className="text-sm text-content-subtle">Total due</p>
          <p className="mt-1 text-3xl font-bold text-content">{formatKsh(amount)}</p>
        </div>

        <div className="mt-6 space-y-3">
          <button
            type="button"
            onClick={() => onPay('M-PESA')}
            disabled={isProcessing}
            className="flex w-full items-center justify-between rounded-xl border border-chart-collected/30 bg-chart-collected/10 px-4 py-3 text-left text-sm font-semibold text-chart-collected transition hover:bg-chart-collected/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>M-PESA / Daraja</span>
            <span>Instant pay</span>
          </button>

          <button
            type="button"
            onClick={() => onPay('Paystack')}
            disabled={isProcessing}
            className="flex w-full items-center justify-between rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-left text-sm font-semibold text-accent transition hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>Paystack</span>
            <span>Card/Wallet</span>
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-content-muted transition hover:bg-surface-2"
        >
          {isProcessing ? 'Processing...' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
