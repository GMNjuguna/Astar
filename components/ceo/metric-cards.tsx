'use client';

/**
 * The CEO's four headline figures, read from the same `/api/analytics` response
 * as the charts beneath them.
 *
 * ── Why the labels carry the window ─────────────────────────────────────────
 * These cards previously read "Today's Total Collected Revenue", "Outstanding
 * Driver Balances", "Total Active Fleet" and "Fleet Servicing Alerts" over
 * invented constants — Ksh 4,080, 12 drivers, 18 vehicles, 3 alerts. The first
 * label was also wrong about its own window: `/api/analytics` resolves to 7
 * days, 30 days or year-to-date and has no "today" resolution, so a live figure
 * under that label would have been a 30-day total wearing a one-day label. Every
 * money figure now states the window it covers, because a number whose period is
 * ambiguous is not a smaller lie than a fake one — it is the same lie with an
 * authoritative font.
 *
 * ── What each figure is, precisely ──────────────────────────────────────────
 * - Collected: `daily_remittances` with `status = 'paid'`, summed. Not billed.
 * - Outstanding: `pending` + `overdue`, summed. Distinct remittances, and the
 *   overdue count is reported separately so a single stuck account cannot hide
 *   inside an aggregate.
 * - Fleet in service: `cars` with `status = 'active'`, out of the total on file.
 *   "Total Active Fleet" implied a count of everything; only the active share is
 *   earning, so the denominator is shown too.
 * - Maintenance: `vehicle_maintenance` rows whose `status` is not `completed`,
 *   with their estimated cost. `estimated_cost` is a quote, not a spend — the
 *   schema has no actual-cost column, so the card says "estimated".
 *
 * ── Why a truncated window is called out ─────────────────────────────────────
 * `lib/analytics.ts` caps the rows it aggregates and flags when the cap was hit.
 * Past the cap the totals are arithmetically correct over a partial set, which
 * renders as a plausible wrong number. That is the exact failure the hardcoded
 * cards had, so the cards refuse to present a capped total as a complete one.
 */
import { TIME_RANGES, type TimeRange } from '@/lib/analytics';
import { formatKsh, formatKshCompact } from '@/lib/format';
import type { AnalyticsPayload } from '@/types/analytics';

import { MetricCard } from './metric-card';

export function CEOMetricCards({
  payload,
  range,
  isLoading,
  error,
}: {
  payload: AnalyticsPayload | null;
  range: TimeRange;
  isLoading: boolean;
  error: string | null;
}) {
  const window = TIME_RANGES.find((option) => option.value === range)?.label ?? 'the selected window';

  if (!payload) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {['Collected revenue', 'Outstanding balance', 'Fleet in service', 'Open maintenance'].map((label) => (
          <MetricCard
            key={label}
            label={label}
            value={error ? 'Unavailable' : isLoading ? 'Loading…' : '—'}
            detail={error ? 'See the message below' : isLoading ? 'Reading the database' : 'No data yet'}
            accent="blue"
          />
        ))}
      </div>
    );
  }

  const collection = payload.revenue.collection;
  const outstanding = collection.pending + collection.overdue;
  const activeFleet = payload.fleet.slices.find((slice) => slice.status === 'active')?.count ?? 0;
  const servicingFleet = payload.fleet.slices.find((slice) => slice.status === 'servicing')?.count ?? 0;
  const maintenance = payload.maintenance;
  const capped = payload.truncated.remittances || payload.truncated.cars || payload.truncated.maintenance;

  return (
    <div className="space-y-3">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={`Collected revenue — ${window}`}
          value={formatKsh(collection.collected)}
          detail={`${collection.paidEntries} of ${collection.entries} remittances paid`}
          accent="emerald"
        />
        <MetricCard
          label={`Outstanding balance — ${window}`}
          value={formatKsh(outstanding)}
          detail={
            collection.overdueEntries > 0
              ? `${collection.overdueEntries} overdue — chase these first`
              : `${collection.entries - collection.paidEntries} awaiting payment`
          }
          accent={collection.overdueEntries > 0 ? 'red' : 'amber'}
        />
        <MetricCard
          label="Fleet in service"
          value={`${activeFleet} of ${payload.fleet.total}`}
          detail={
            servicingFleet > 0
              ? `${servicingFleet} in maintenance, ${payload.fleet.total - activeFleet - servicingFleet} idle`
              : `${payload.fleet.total - activeFleet} not in service`
          }
          accent="blue"
        />
        <MetricCard
          label="Open maintenance jobs"
          value={String(maintenance.openRecords)}
          detail={`${formatKshCompact(maintenance.totalEstimated)} estimated across ${maintenance.records} records`}
          accent={maintenance.openRecords > 0 ? 'amber' : 'emerald'}
        />
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-chart-danger/40 bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger"
        >
          Could not refresh these figures: {error}. The values above are from the last successful load.
        </div>
      ) : null}

      {capped ? (
        <div className="rounded-xl border border-chart-servicing/40 bg-chart-servicing/5 px-3 py-2 text-sm text-chart-servicing">
          This window holds more than {payload.truncated.rowCap.toLocaleString()} rows, so these totals cover
          only the first {payload.truncated.rowCap.toLocaleString()} and understate the true figures.
          Narrow the date range below for complete numbers.
        </div>
      ) : null}
    </div>
  );
}