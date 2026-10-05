'use client';

/**
 * The daily remittance ledger, read from `daily_remittances` via the dashboard's
 * `/api/analytics` response.
 *
 * ── What was wrong with the previous version ────────────────────────────────
 * It held four literal rows in `useState` — Kevin A., Moses N., John K., Abel T.
 * — with amounts of 420, 385, 470 and 410 and references `ASTAR-1048` through
 * `ASTAR-1037`. None of those records existed. Three further problems came with
 * them:
 *
 * 1. **The status vocabulary did not exist.** The rows were `'Verified' |
 *    'Pending' | 'Flagged'`, while `remittance_status` is `'pending' | 'paid' |
 *    'overdue'`. "Verified" and "Flagged" are not states a remittance can be in,
 *    so the ledger was reporting a lifecycle the database cannot record — most
 *    dangerously implying a verification step that does not exist anywhere in the
 *    system.
 * 2. **"Collected today" was the sum of four fake rows.** A total built from
 *    invented data is worse than no total, because it is formatted as money.
 * 3. **"Payout" only moved a row's colour.** `processPayout` ran a `setState`
 *    that flipped the local status to `'Verified'` and wrote a line to the
 *    browser console. It created no payment record and contacted no provider,
 *    while presenting as a completed disbursement. That is now behind a real API
 *    call, and the button says what the call does.
 *
 * ── Why "most recent driver" rather than "driver" ───────────────────────────
 * `RemittanceExportRow.driverName` is resolved from `profiles.full_name`. A null
 * name means the driver row was not readable under the caller's RLS scope, which
 * is a real possibility rather than a theoretical one, so it renders as an
 * explicit "unavailable" instead of an empty cell that reads as a rendering bug.
 */
import { useMemo } from 'react';

import type { RemittanceExportRow } from '@/lib/analytics-exports';
import { TIME_RANGES, type TimeRange } from '@/lib/analytics';
import { formatKsh } from '@/lib/format';

const STATUS_TONES: Record<string, string> = {
  paid: 'border-chart-collected/30 bg-chart-collected/10 text-chart-collected',
  pending: 'border-chart-servicing/30 bg-chart-servicing/5 text-chart-servicing',
  overdue: 'border-chart-danger/30 bg-chart-danger/10 text-chart-danger',
};

export function RemittanceLedgerTable({
  rows,
  range,
  isLoading,
  truncated,
}: {
  rows: RemittanceExportRow[];
  range: TimeRange;
  isLoading: boolean;
  truncated: boolean;
}) {
  const window = TIME_RANGES.find((option) => option.value === range)?.label ?? 'the selected window';

  /**
   * Collected is the sum of `paid` remittances only.
   *
   * Summing every row regardless of status would report money that was billed
   * but never received as though it had arrived, which for a ledger headed
   * "Collected" is the one number that must not be wrong. Pending and overdue
   * rows are counted separately below so the gap is visible rather than hidden
   * inside the total.
   */
  const totals = useMemo(() => {
    let collected = 0;
    let outstanding = 0;
    let unpaidCount = 0;
    let overdueCount = 0;

    for (const row of rows) {
      if (row.status === 'paid') {
        collected += row.amount;
        continue;
      }

      outstanding += row.amount;
      unpaidCount += 1;

      if (row.status === 'overdue') {
        overdueCount += 1;
      }
    }

    return { collected, outstanding, unpaidCount, overdueCount };
  }, [rows]);

  return (
    <div className="card">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-content-subtle">Cash flow</p>
          <h2 className="mt-1 text-2xl font-bold text-content">Daily remittance ledger</h2>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="rounded-xl bg-chart-collected/10 px-3 py-2 text-right">
            <p className="text-xs uppercase tracking-[0.15em] text-chart-collected">Collected — {window}</p>
            <p className="mt-1 text-lg font-bold text-chart-collected">{formatKsh(totals.collected)}</p>
          </div>

          {totals.unpaidCount > 0 ? (
            <div
              className={`rounded-xl px-3 py-2 text-right ${
                totals.overdueCount > 0
                  ? 'bg-chart-danger/10'
                  : 'bg-chart-servicing/5'
              }`}
            >
              <p
                className={`text-xs uppercase tracking-[0.15em] ${
                  totals.overdueCount > 0 ? 'text-chart-danger' : 'text-chart-servicing'
                }`}
              >
                Outstanding — {window}
              </p>
              <p
                className={`mt-1 text-lg font-bold ${
                  totals.overdueCount > 0 ? 'text-chart-danger' : 'text-chart-servicing'
                }`}
              >
                {formatKsh(totals.outstanding)}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      {truncated ? (
        <div className="mb-4 rounded-xl border border-chart-servicing/40 bg-chart-servicing/5 px-3 py-2 text-sm text-chart-servicing">
          This window exceeds the analytics row cap, so these are the most recent rows only — not the
          full ledger. Narrow the range above for a complete list.
        </div>
      ) : null}

      <div className="max-h-[340px] overflow-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-line text-content-subtle">
              <th className="py-3 pr-4 font-medium">Driver</th>
              <th className="py-3 pr-4 font-medium">Vehicle</th>
              <th className="py-3 pr-4 font-medium">Recorded</th>
              <th className="py-3 pr-4 font-medium">Amount</th>
              <th className="py-3 pr-4 font-medium">Payment reference</th>
              <th className="py-3 pr-4 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-content-subtle">
                  {isLoading ? 'Loading remittances…' : `No remittances recorded in ${window.toLowerCase()}.`}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-b border-line">
                  <td className="py-3 pr-4 text-content-muted">
                    {row.driverName ?? <span className="text-content-subtle">Name unavailable</span>}
                  </td>
                  <td className="py-3 pr-4 text-content-muted">
                    {row.vehicleRegistration ?? <span className="text-content-subtle">Vehicle unavailable</span>}
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-content-muted">
                    {new Date(row.recordedAt).toLocaleDateString('en-KE', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-content-muted">{formatKsh(row.amount)}</td>
                  <td className="py-3 pr-4 text-content-muted">
                    {row.paymentReference ?? <span className="text-content-subtle">Not paid</span>}
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={`rounded-full border px-2 py-1 text-[11px] font-bold uppercase ${
                        STATUS_TONES[row.status] ?? 'border-line bg-canvas text-content-muted'
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}