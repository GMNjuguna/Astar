'use client';

/**
 * System diagnostics, built from real row timestamps.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 * The panel previously fetched `/api/developer/audit`, which returned five
 * hardcoded entries describing a M-Pesa callback failing signature validation with
 * `result_code: 1032`, a Paystack retry queue overflowing, replica lag at 3.4s and
 * an AI prompt refresh to `v2.4.1`. Each carried a `statusCode` and a `stackTrace`.
 *
 * Two of those artefacts are the reason this could not be left in place by merely
 * swapping the data source:
 *
 *   - The stack traces named functions that do not exist in this codebase
 *     (`verifySignature()`, `reject()`, a `retry_max_exceeded` queue drain), and
 *     described a Paystack endpoint this application never calls. A fabricated
 *     stack trace is worse than a fabricated metric, because a stack trace is the
 *     one artefact an operator trusts without checking. So the column is gone
 *     rather than filled with something equally unsupported.
 *   - `statusCode` had no source either — no HTTP layer is involved in reading a
 *     table — so the drawer now shows the fields that do have a source: which
 *     table the event came from, its measured query latency, and the row values
 *     the severity rule actually fired on.
 *
 * ── What the entries are, and are not ──────────────────────────────────────
 * There is no audit-log or event table in `supabase/baseline.sql`. These entries
 * are reconstructed from `created_at` / `reviewed_at` / `updated_at` on
 * operational tables. That is a real signal — when rows appeared and what state
 * they are in — but it is not an audit trail: it cannot show an action that
 * changed nothing, it has no before/after, and `cars` has no `updated_at` at all,
 * so vehicle edits cannot appear. The endpoint marks this with
 * `derivedFromRowTimestamps` and the header says it, so nobody reads the list as a
 * complete record of what happened.
 *
 * Severity is derived by rules stated in `/api/developer/logs`, not asserted per
 * row. The one that matters most is a `developer` or `ceo` profile appearing in
 * the recent-accounts stream: a self-registered account must never hold a
 * privileged role, so it is filed as an error rather than as routine activity.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchApiJson } from '@/lib/api-client';
import type { DeveloperLogsPayload, LogSeverity, SystemLogEntry } from '@/types/developer-health';

const severityStyles: Record<LogSeverity, string> = {
  INFO: 'bg-chart-billed/10 text-chart-billed',
  WARN: 'bg-chart-servicing/5 text-chart-servicing',
  ERROR: 'bg-chart-danger/10 text-chart-danger',
};

const severityOrder: Array<'ALL' | LogSeverity> = ['ALL', 'ERROR', 'WARN', 'INFO'];

/**
 * One shape rather than a discriminated union of ready/failed variants.
 *
 * `payload` and `error` are genuinely independent — a failed refresh keeps the
 * previous payload and adds an error — so a union would force an artificial
 * `status: 'ready' | 'failed'` computed from them, which is one more place for the
 * two to disagree.
 */
type LoadState = {
  payload: DeveloperLogsPayload | null;
  error: string | null;
  /** True only before the first response arrives. */
  isInitialLoad: boolean;
};

export function SystemAuditPanel() {
  const [state, setState] = useState<LoadState>({ payload: null, error: null, isInitialLoad: true });
  const [severityFilter, setSeverityFilter] = useState<'ALL' | LogSeverity>('ALL');
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const inFlight = useRef(false);

  const load = useCallback(async (background: boolean) => {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;

    if (background) {
      setIsRefreshing(true);
    }

    const result = await fetchApiJson<DeveloperLogsPayload>('/api/developer/logs');

    inFlight.current = false;
    setIsRefreshing(false);

    if (result.ok) {
      // A failed refresh keeps the previous payload; the same reasoning as the
      // health hook, and the reason the previous panel could sit on its sample set
      // for a whole session without anyone noticing.
      setState({ payload: result.data, error: null, isInitialLoad: false });
    } else {
      setState((current) => ({ payload: current.payload, error: result.message, isInitialLoad: false }));
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const logs = useMemo(() => state.payload?.logs ?? [], [state.payload]);

  const filteredLogs = useMemo(
    () => (severityFilter === 'ALL' ? logs : logs.filter((log) => log.severity === severityFilter)),
    [logs, severityFilter]
  );

  const counts = useMemo(() => {
    const tally: Record<LogSeverity, number> = { INFO: 0, WARN: 0, ERROR: 0 };

    for (const log of logs) {
      tally[log.severity] += 1;
    }

    return tally;
  }, [logs]);

  const selectedLog = useMemo<SystemLogEntry | null>(
    () => filteredLogs.find((log) => log.id === selectedLogId) ?? filteredLogs[0] ?? null,
    [filteredLogs, selectedLogId]
  );

  if (state.isInitialLoad) {
    return (
      <div className="rounded-2xl border border-line bg-canvas p-6" role="status">
        <p className="text-sm text-content-muted">Reading recent activity from the database…</p>
      </div>
    );
  }

  if (!state.payload) {
    return (
      <div className="rounded-2xl border border-chart-danger/30 bg-chart-danger/5 p-6">
        <p className="text-sm font-semibold text-chart-danger">Could not read system activity</p>
        <p className="mt-2 text-sm text-content-muted">{state.error}</p>
        <button
          type="button"
          onClick={() => void load(false)}
          className="mt-4 rounded-xl bg-brand-solid px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-solid-strong"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5 text-content">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm font-medium text-content-subtle">Live event stream</p>
          <h2 className="mt-1 text-2xl font-bold text-content">System diagnostics</h2>
          <p className="mt-2 max-w-2xl text-sm text-content-muted">
            Derived from row timestamps on {state.payload.sources.length} tables — there is no audit-log table in
            this schema, so an action that changed nothing cannot appear here. Severity is derived by rule, not
            assigned per row.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-content-subtle">
            Severity
            <select
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value as 'ALL' | LogSeverity)}
              className="rounded-lg border border-line bg-canvas px-3 py-2 text-content outline-none focus:border-accent"
            >
              {severityOrder.map((severity) => (
                <option key={severity} value={severity}>
                  {severity === 'ALL'
                    ? `All (${logs.length})`
                    : `${severity} (${counts[severity]})`}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => void load(true)}
            disabled={isRefreshing}
            className="rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-content transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {state.error && (
        <div className="rounded-xl border border-chart-danger/30 bg-chart-danger/5 p-3">
          <p className="text-sm font-semibold text-chart-danger">The last refresh failed</p>
          <p className="mt-1 text-sm text-content-muted">
            {state.error} — the entries below are from {new Date(state.payload.checkedAt).toLocaleTimeString()}.
          </p>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[1.4fr_0.6fr]">
        <div className="overflow-hidden rounded-2xl border border-line bg-canvas">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-line text-left text-sm">
              <thead className="bg-surface text-content-muted">
                <tr>
                  <th className="px-4 py-3 font-semibold">Recorded</th>
                  <th className="px-4 py-3 font-semibold">Source</th>
                  <th className="px-4 py-3 font-semibold">Severity</th>
                  <th className="px-4 py-3 font-semibold">Event</th>
                  <th className="px-4 py-3 font-semibold">Query</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line bg-canvas">
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-content-muted">
                      {logs.length === 0
                        ? 'No rows in the tables this endpoint reads. There is nothing recent to report.'
                        : `No ${severityFilter} entries among the ${logs.length} most recent.`}
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((log) => (
                    <tr
                      key={log.id}
                      onClick={() => setSelectedLogId(log.id)}
                      aria-selected={selectedLog?.id === log.id}
                      className={`cursor-pointer align-top transition ${
                        selectedLog?.id === log.id ? 'bg-surface' : 'hover:bg-surface'
                      }`}
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-content-muted">
                        {new Date(log.timestamp).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-content-subtle">{log.source}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${severityStyles[log.severity]}`}
                        >
                          {log.severity}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-content">{log.message}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-content-muted">
                        {log.queryLatencyMs === null ? '—' : `${log.queryLatencyMs}ms`}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {selectedLog && (
          <aside className="rounded-2xl border border-line bg-canvas p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-content-subtle">
                  Inspection drawer
                </p>
                <h3 className="mt-1 text-xl font-bold text-content">{selectedLog.source}</h3>
              </div>
              <span
                className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${severityStyles[selectedLog.severity]}`}
              >
                {selectedLog.severity}
              </span>
            </div>

            <div className="space-y-4 text-sm text-content-muted">
              <div className="rounded-xl border border-line bg-surface p-3">
                <p className="text-content-subtle">Event</p>
                <p className="mt-1 leading-6 text-content">{selectedLog.message}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-line bg-surface p-3">
                  <p className="text-content-subtle">Recorded</p>
                  <p className="mt-1 font-semibold text-content">
                    {new Date(selectedLog.timestamp).toLocaleTimeString()}
                  </p>
                </div>
                <div className="rounded-xl border border-line bg-surface p-3">
                  <p className="text-content-subtle">Source query</p>
                  <p className="mt-1 font-semibold text-content">
                    {selectedLog.queryLatencyMs === null ? 'not measured' : `${selectedLog.queryLatencyMs} ms`}
                  </p>
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-subtle">
                  Row values behind the severity
                </p>
                <pre className="max-h-48 overflow-auto rounded-xl border border-line bg-surface p-3 text-xs leading-5 text-chart-billed">
                  {JSON.stringify(selectedLog.payload, null, 2)}
                </pre>
              </div>
            </div>
          </aside>
        )}
      </div>

      <details className="rounded-2xl border border-line bg-canvas p-4">
        <summary className="cursor-pointer text-sm font-semibold text-content">
          Sources queried ({state.payload.sources.length})
        </summary>
        <ul className="mt-3 space-y-1 text-xs text-content-muted">
          {state.payload.sources.map((source) => (
            <li key={source.name} className="flex flex-wrap justify-between gap-2">
              <span className="font-mono">{source.name}</span>
              <span>
                {source.rows} {source.rows === 1 ? 'row' : 'rows'} · {source.latencyMs}ms
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
