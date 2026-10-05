'use client';

import { formatKsh } from '@/lib/format';

export type PaymentStatus = 'Paid' | 'Pending' | 'Overdue';

export function DailyLedgerSummaryCard({
  status,
  amount,
  dueDate,
  onPay,
}: {
  status: PaymentStatus;
  amount: number;
  dueDate: string;
  onPay: () => void;
}) {
  const statusStyles: Record<PaymentStatus, string> = {
    Paid: 'bg-chart-collected/10 text-chart-collected border-chart-collected/30',
    Pending: 'bg-chart-servicing/5 text-chart-servicing border-chart-servicing/30',
    Overdue: 'bg-chart-danger/10 text-chart-danger border-chart-danger/30',
  };

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-content-subtle">Daily ledger summary</p>
          <h2 className="mt-2 text-3xl font-bold text-content">{formatKsh(amount)}</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusStyles[status]}`}>
          {status}
        </span>
      </div>

      <div className="mt-6 flex items-center justify-between rounded-xl bg-surface-2 p-3">
        <div>
          <p className="text-xs uppercase tracking-[0.15em] text-content-subtle">Due date</p>
          <p className="mt-1 text-sm font-medium text-content-muted">{dueDate}</p>
        </div>
        <button
          type="button"
          onClick={onPay}
          className="rounded-lg bg-brand-solid px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-solid-strong"
        >
          Pay Daily Fee
        </button>
      </div>
    </div>
  );
}
