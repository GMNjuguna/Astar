'use client';

/**
 * Revenue, fleet and maintenance analytics with CSV export.
 *
 * Mounted on both the CEO and Manager dashboards. One component rather than two
 * because the aggregation is identical for both roles — the RLS policies grant
 * the CEO and the manager the same read access to all three tables — so a second
 * copy could only ever drift.
 *
 * ── Data provenance ─────────────────────────────────────────────────────────
 * Every figure here comes from `/api/analytics`, which queries the live database
 * through the caller's own session. Nothing is a default, a placeholder or a
 * sample row. Where the database cannot answer a question — there is no revenue
 * target, no mileage column, no driver-to-vehicle assignment — the panel says so
 * in place of the chart or column rather than approximating it.
 *
 * ── Why every prop is required (fully controlled) ───────────────────────────
 * This panel used to fetch for itself, owning the range as internal state. Its
 * two mount points both now also render live figures derived from the *same*
 * response — the CEO metric cards and ledger, and the manager's remittance and
 * fleet panels. A self-fetching panel would issue a second request for the same
 * URL and race its sibling on every range change, so the card and the chart it
 * sits above could briefly disagree. The page owns the range and the payload;
 * this component renders what it is given. That makes a divergence impossible
 * rather than merely unlikely.
 */
import {
  CHART_COLORS,
  FleetStatusRing,
  MaintenanceBarChart,
  RevenueTrendChart,
  type FleetSliceView,
  type MaintenanceBar,
} from '@/components/analytics/charts';
import {
  buildFleetCsv,
  buildMaintenanceCsv,
  buildRemittanceCsv,
} from '@/lib/analytics-exports';
import { TIME_RANGES, type TimeRange } from '@/lib/analytics';
import { csvFilename, downloadCsv } from '@/lib/csv';
import { formatKsh, formatKshCompact } from '@/lib/format';
import type { AnalyticsPayload } from '@/types/analytics';

export type AnalyticsPanelProps = {
  range: TimeRange;
  onRangeChange: (range: TimeRange) => void;
  payload: AnalyticsPayload | null;
  isLoading: boolean;
  error: string | null;
};

const SLICE_COLORS: Record<string, string> = {
  active: CHART_COLORS.active,
  servicing: CHART_COLORS.servicing,
  inactive: CHART_COLORS.inactive,
};

function StatTile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-canvas p-3">
      <p className="text-xs text-content-subtle">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${tone ?? 'text-content'}`}>{value}</p>
      {detail ? <p className="mt-0.5 text-[11px] text-content-subtle">{detail}</p> : null}
    </div>
  );
}

export function AnalyticsPanel({
  range,
  onRangeChange,
  payload,
  isLoading,
  error,
}: AnalyticsPanelProps) {
  /**
   * Exports are disabled rather than trimmed when the row cap was hit.
   *
   * A CSV missing rows with no indication looks identical to a complete one, and
   * a finance report is exactly the wrong artefact to be quietly short. The cap
   * is surfaced in the panel and the button explains why it is unavailable.
   */
  const exportBlocked = (source: 'remittances' | 'maintenance' | 'cars') =>
    payload ? payload.truncated[source] : false;

  const runExport = (kind: 'remittances' | 'fleet' | 'maintenance') => {
    if (!payload) {
      return;
    }

    if (kind === 'remittances') {
      downloadCsv(csvFilename('remittances'), buildRemittanceCsv(payload.exports.remittances));
    } else if (kind === 'fleet') {
      downloadCsv(csvFilename('fleet_status'), buildFleetCsv(payload.exports.fleet));
    } else {
      downloadCsv(csvFilename('maintenance'), buildMaintenanceCsv(payload.exports.maintenance));
    }
  };

  const slices: FleetSliceView[] =
    payload?.fleet.slices.map((slice) => ({ ...slice, color: SLICE_COLORS[slice.status] ?? CHART_COLORS.inactive })) ?? [];

  const bars: MaintenanceBar[] =
    payload?.maintenance.byVehicle.slice(0, 12).map((group) => ({
      key: group.key,
      label: group.key,
      count: group.count,
      value: group.totalEstimated,
    })) ?? [];

  return (
    <section
      className="rounded-[1.5rem] border border-line bg-surface/80 p-5"
      aria-label="Revenue, fleet and maintenance analytics"
    >
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm text-content-subtle">Live analytics</p>
          <h2 className="mt-1 text-2xl font-bold text-content">Revenue, fleet and maintenance</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-line bg-canvas p-1" role="group" aria-label="Time range">
            {TIME_RANGES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => onRangeChange(option.value)}
                aria-pressed={range === option.value}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  range === option.value
                    ? 'bg-brand-solid text-white'
                    : 'text-content-subtle hover:text-content'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? (
        <div role="alert" className="rounded-xl border border-chart-danger/40 bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger">
          Could not load analytics: {error}
        </div>
      ) : null}

      {payload?.truncated.remittances || payload?.truncated.maintenance ? (
        <div className="mb-4 rounded-xl border border-chart-servicing/40 bg-chart-servicing/5 px-3 py-2 text-sm text-chart-servicing">
          This window holds more than {payload.truncated.rowCap.toLocaleString()} rows, so the figures below
          cover only the first {payload.truncated.rowCap.toLocaleString()} and the exports are disabled.
          Narrow the date range to get complete numbers.
        </div>
      ) : null}

      {/* Revenue */}
      <div className="rounded-2xl border border-line bg-canvas p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold text-content">Revenue trend</h3>
            <p className="text-xs text-content-subtle">Collected versus billed remittances</p>
          </div>
          <button
            type="button"
            onClick={() => runExport('remittances')}
            disabled={exportBlocked('remittances') || (payload?.exports.remittances.length ?? 0) === 0}
            title={
              exportBlocked('remittances')
                ? `Over the ${payload?.truncated.rowCap} row cap — narrow the range first`
                : undefined
            }
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-content transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            Export Remittance Report (CSV)
          </button>
        </div>

        {payload ? (
          <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Collected" value={formatKsh(payload.revenue.collection.collected)} tone="text-chart-collected" />
            <StatTile label="Outstanding" value={formatKsh(payload.revenue.collection.pending)} tone="text-chart-servicing" />
            <StatTile label="Overdue" value={formatKsh(payload.revenue.collection.overdue)} tone="text-chart-danger" />
            <StatTile
              label="Collection rate"
              value={
                payload.revenue.collection.collectionRate === null
                  ? '—'
                  : `${payload.revenue.collection.collectionRate.toFixed(1)}%`
              }
              detail={
                payload.revenue.collection.collectionRate === null ? 'Nothing billed in this window' : undefined
              }
            />
          </div>
        ) : null}

        {payload && payload.revenue.collection.entries > 0 ? (
          <>
            <RevenueTrendChart points={payload.revenue.buckets} hasTarget={payload.revenue.targetAvailable} />
            <p className="mt-2 text-xs text-content-subtle">{payload.revenue.targetUnavailableReason}</p>
            <p className="mt-1 text-xs text-content-subtle">
              Averaged across {payload.revenue.drivers.activeDrivers} remitting driver
              {payload.revenue.drivers.activeDrivers === 1 ? '' : 's'}:{' '}
              {payload.revenue.drivers.averagePerDriver === null
                ? '—'
                : formatKsh(payload.revenue.drivers.averagePerDriver)}{' '}
              per driver over this window.
            </p>
          </>
        ) : (
          <p className="py-10 text-center text-sm text-content-subtle">
            {isLoading ? 'Loading analytics…' : 'No remittances recorded in this window.'}
          </p>
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {/* Fleet */}
        <div className="rounded-2xl border border-line bg-canvas p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-lg font-semibold text-content">Fleet availability</h3>
              <p className="text-xs text-content-subtle">
                {payload?.fleet.total ?? 0} vehicles · bookable daily rate{' '}
                {formatKshCompact(payload?.fleet.totalDailyRate ?? 0)} if all were earning
              </p>
            </div>
            <button
              type="button"
              onClick={() => runExport('fleet')}
              disabled={exportBlocked('cars') || (payload?.exports.fleet.length ?? 0) === 0}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-content transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Export Fleet Status (CSV)
            </button>
          </div>

          {payload && payload.fleet.total > 0 ? (
            <FleetStatusRing slices={slices} />
          ) : (
            <p className="py-10 text-center text-sm text-content-subtle">
              {isLoading ? 'Loading analytics…' : 'No vehicles on file.'}
            </p>
          )}

          <p className="mt-3 text-xs text-content-subtle">
            The schema records three statuses: in service, in maintenance, and idle/out of service. Idle and
            decommissioned vehicles are both stored as <code className="text-content-subtle">inactive</code>, so they
            cannot be separated.
          </p>
        </div>

        {/* Maintenance */}
        <div className="rounded-2xl border border-line bg-canvas p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-lg font-semibold text-content">Maintenance cost tracker</h3>
              <p className="text-xs text-content-subtle">
                Estimated, by vehicle · {payload?.maintenance.records ?? 0} records,{' '}
                {payload?.maintenance.openRecords ?? 0} not yet completed
              </p>
            </div>
            <button
              type="button"
              onClick={() => runExport('maintenance')}
              disabled={exportBlocked('maintenance') || (payload?.exports.maintenance.length ?? 0) === 0}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-content transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Export Maintenance Summary (CSV)
            </button>
          </div>

          {payload && payload.maintenance.records > 0 ? (
            <>
              <div className="mb-3 grid gap-3 sm:grid-cols-3">
                <StatTile label="Total estimated" value={formatKsh(payload.maintenance.totalEstimated)} tone="text-chart-servicing" />
                <StatTile
                  label="Largest single quote"
                  value={formatKsh(payload.maintenance.highestSingleEstimate)}
                  detail="One maintenance record"
                />
                <StatTile
                  label="Vehicles seen more than once"
                  value={String(payload.maintenance.recurring.length)}
                  detail="Recurring repair signal"
                />
              </div>

              {bars.length > 0 ? (
                <MaintenanceBarChart bars={bars} />
              ) : null}

              {payload.maintenance.recurring.length > 0 ? (
                <ul className="mt-3 space-y-1 text-xs text-content-subtle">
                  {payload.maintenance.recurring.slice(0, 3).map((item) => (
                    <li key={item.vehicleRegistration}>
                      <span className="font-semibold text-content">{item.vehicleRegistration}</span> —{' '}
                      {item.occurrences} records, {formatKsh(item.totalEstimated)} estimated (
                      {item.share.toFixed(0)}% of all maintenance)
                    </li>
                  ))}
                </ul>
              ) : null}

              <p className="mt-2 text-xs text-content-subtle">
                These are <code className="text-content-subtle">estimated_cost</code> quotes, not invoices. The schema
                records no actual spend, and open work has not been paid for at all.
              </p>
            </>
          ) : (
            <p className="py-10 text-center text-sm text-content-subtle">
              {isLoading ? 'Loading analytics…' : 'No maintenance records in this window.'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}