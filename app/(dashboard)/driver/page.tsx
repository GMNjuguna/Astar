'use client';

import { useMemo, useState } from 'react';
import { DailyLedgerSummaryCard, type PaymentStatus } from '@/components/driver/daily-ledger-summary';
import { formatKsh } from '@/lib/format';
import { DocumentManagementHub } from '@/components/driver/document-management-hub';
import { DriverProfileCard } from '@/components/driver/driver-profile-card';
import { DriverChat } from '@/components/driver/driver-chat';
import { PayDailyFeeModal } from '@/components/driver/pay-daily-fee-modal';

type RemittanceRecord = {
  date: string;
  amount: number;
  reference: string;
  status: 'Paid' | 'Pending' | 'Overdue';
};

const remittanceHistory: RemittanceRecord[] = [
  { date: '2026-09-12', amount: 420, reference: 'ASTAR-1048', status: 'Paid' },
  { date: '2026-09-11', amount: 420, reference: 'ASTAR-1041', status: 'Paid' },
  { date: '2026-09-10', amount: 420, reference: 'ASTAR-1034', status: 'Pending' },
  { date: '2026-09-09', amount: 420, reference: 'ASTAR-1028', status: 'Overdue' },
  { date: '2026-09-08', amount: 420, reference: 'ASTAR-1020', status: 'Paid' },
];

export default function DriverPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [remittanceStatus, setRemittanceStatus] = useState<PaymentStatus>('Pending');
  const [history, setHistory] = useState(remittanceHistory);

  const todayAmount = 420;

  const summaryText = useMemo(() => {
    if (remittanceStatus === 'Paid') return 'Payment confirmed for today.';
    if (remittanceStatus === 'Overdue') return 'Payment is overdue. Please settle immediately.';
    return 'Your daily remittance is awaiting confirmation.';
  }, [remittanceStatus]);

  const handlePayment = async (method: 'M-PESA' | 'Paystack') => {
    setIsProcessingPayment(true);
    setIsModalOpen(false);

    const paymentReference = `ASTAR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(
      Math.random() * 900 + 100
    )}`;

    setTimeout(() => {
      setRemittanceStatus('Paid');
      setHistory((current) => [
        {
          date: new Date().toISOString().slice(0, 10),
          amount: todayAmount,
          reference: paymentReference,
          status: 'Paid',
        },
        ...current,
      ]);
      setIsProcessingPayment(false);
    }, 900);

    console.info(`Payment processed via ${method}: ${paymentReference}`);
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          {/* Eyebrow, heading and summary sit directly on the layout's `bg-canvas`
            shell. brand-500 = 5.64:1, text-content = 18.44:1, text-content-subtle =
            7.19:1. The previous brand-600 (4.31:1), slate-900 (1.03:1) and
            slate-500 (3.87:1) all failed AA against the shell. */}
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Driver Portal</p>
          <h1 className="mt-2 text-3xl font-bold text-content">Daily remittances and compliance</h1>
        </div>
        <p className="text-sm text-content-subtle">{summaryText}</p>
      </div>

      <DriverProfileCard />

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <DailyLedgerSummaryCard
          status={remittanceStatus}
          amount={todayAmount}
          dueDate={new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          onPay={() => setIsModalOpen(true)}
        />

        {/* The slate-900 values inside this card are correct and must not be
            changed to a light colour. `.card` is `bg-surface` (see
            app/globals.css), so slate-900 measures 17.85:1 on the card and
            17.06:1 on the nested `bg-surface-2` tile below. Light text here
            would be the unreadable direction, not the fix. */}
        <div className="card">
          <p className="text-sm font-medium text-content-subtle">Quick stats</p>
          <div className="mt-4 space-y-4">
            <div className="rounded-xl bg-surface-2 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-content-subtle">Total paid</p>
              <p className="mt-2 text-2xl font-bold text-content">{formatKsh(2100)}</p>
            </div>
            <div className="rounded-xl bg-surface-2 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-content-subtle">Current status</p>
              <p className="mt-2 text-2xl font-bold text-content capitalize">{remittanceStatus.toLowerCase()}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Same reasoning as above: this card is white, so the slate-900 heading
            below is 17.85:1 and stays dark. */}
      <div className="card">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-content-subtle">Payment ledger</p>
            <h2 className="mt-1 text-2xl font-bold text-content">Remittance history</h2>
          </div>
        </div>

        <div className="max-h-[340px] overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line text-content-subtle">
                <th className="py-3 pr-4 font-medium">Date</th>
                <th className="py-3 pr-4 font-medium">Amount</th>
                <th className="py-3 pr-4 font-medium">Reference</th>
                <th className="py-3 pr-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={`${row.reference}-${row.date}`} className="border-b border-line">
                  <td className="py-3 pr-4 text-content-muted">{row.date}</td>
                  <td className="py-3 pr-4 text-content-muted">{formatKsh(row.amount)}</td>
                  <td className="py-3 pr-4 text-content-muted">{row.reference}</td>
                  <td className="py-3 pr-4">
                    <span
                      className={`rounded-full border px-2 py-1 text-[11px] font-bold uppercase ${
                        row.status === 'Paid'
                          ? 'border-chart-collected/30 bg-chart-collected/10 text-chart-collected'
                          : row.status === 'Pending'
                            ? 'border-chart-servicing/30 bg-chart-servicing/5 text-chart-servicing'
                            : 'border-chart-danger/30 bg-chart-danger/10 text-chart-danger'
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-6">
        <DocumentManagementHub />
        <DriverChat />
      </div>

      <PayDailyFeeModal
        open={isModalOpen}
        amount={todayAmount}
        isProcessing={isProcessingPayment}
        onClose={() => setIsModalOpen(false)}
        onPay={(method) => {
          void handlePayment(method);
        }}
      />
    </div>
  );
}
