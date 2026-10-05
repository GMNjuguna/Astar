'use client';

/**
 * Live Supabase health for the Developer System Portal.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 * The Overview tab previously rendered, in total:
 *
 *   - four invented summary cards: "API latency 132ms", "Active accounts 248",
 *     "Webhook failures 2", "System status Healthy";
 *   - a hardcoded "All services nominal" badge;
 *   - three progress bars — Infrastructure health 94%, Driver verification
 *     pipeline 87%, Payment webhook integrity 96%;
 *   - three "active incidents": two payment callbacks pending reconciliation,
 *     driver docs bucket at 67% of quota, and an AI prompt layer online without
 *     rollback.
 *
 * None of it was measured, and several of the things it described do not exist
 * in this application:
 *
 *   - "Webhook failures: 2" and the two payment incidents describe Daraja and
 *     Paystack callbacks. No payment provider is integrated — there is no webhook
 *     route at all — so the number could never have been anything but 0, and its
 *     being 2 was not a coincidence. Counting failures in a system with no
 *     failures is the most confidently wrong thing a dashboard can do: it tells
 *     an operator to go and fix something that is not broken while the thing that
 *     *is* broken has no tile.
 *   - "Bucket usage at 67% of quota" has no denominator. Supabase exposes no
 *     quota through PostgREST, and the panel would have needed a real object count
 *     and byte total to say anything truthful.
 *   - "Driver verification pipeline 87%" was a percentage of an unstated
 *     population, so it was not interpretable at all — 87% of what?
 *   - "Payment webhook integrity 96%" was the same shape as a success rate with
 *     no sample size, on a subsystem that does not exist.
 *
 * The replacements are only things that can be observed: a measured round trip,
 * real row counts, the actual bucket inventory, the real active policy count, and
 * findings derived from those by stated rules.
 *
 * ── Why progress bars are gone rather than re-sourced ──────────────────────
 * A bar needs a numerator and a denominator that mean the same unit. The
 * candidates here do not: policies are a count with no meaningful "complete"
 * value, row counts have no target, and latency has no budget in this schema. A
 * filled bar would imply a ceiling that does not exist, so these are reported as
 * figures with their units instead.
 *
 * ── Why an unavailable measurement is shown as unavailable ──────────────────
 * `pg_policies` and `storage.buckets` are not exposed through PostgREST, so the
 * panel cannot see them until `supabase/migrations/20261005_developer_health_introspection.sql`
 * has been run. That state renders as an explicit "needs migration" note naming
 * the file. The alternative — omitting the rows — makes a permanent coverage gap
 * look identical to a healthy system with nothing to report.
 */
import { HEALTH_POLL_INTERVAL_MS, type DeveloperHealthState } from '@/lib/use-developer-health';
import type {
  CountScope,
  DeveloperHealthPayload,
  HealthSeverity,
  StorageBucketStatus,
} from '@/types/developer-health';

/**
 * Severity → presentation.
 *
 * `chart-*` text tokens on a 10%-alpha wash of the same hue, which is the
 * pattern used by every other status pill in this codebase. Contrast was
 * verified in both themes (see the audit note in `types/developer-health.ts`):
 * `chart-collected` reaches 5.55:1 on `surface` in light and 8.11:1 in dark,
 * `chart-servicing` and `chart-danger` are higher. The wash is a light tint of the
 * same hue rather than a competing colour, so it cannot shift the text off its
 * measured value.
 */
const severityStyles: Record<HealthSeverity, { pill: string; label: string }> = {
  ok: { pill: 'bg-chart-collected/10 text-chart-collected', label: 'Healthy' },
  warn: { pill: 'bg-chart-servicing/5 text-chart-servicing', label: 'Degraded' },
  error: { pill: 'bg-chart-danger/10 text-chart-danger', label: 'Attention required' },
};

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;

  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/**
 * Renders a count with its RLS scope attached.
 *
 * The scope is not decoration. `user_preferences` has no developer bypass policy
 * by design, so without the migration the count a developer can read is their own
 * single row. Showing "1" bare would be the most plausible-looking wrong number
 * on the panel; showing it as "your rows" makes the gap legible instead.
 */
const scopeLabels: Record<CountScope, { label: string; tone: string }> = {
  all: { label: 'all rows', tone: 'text-chart-collected' },
  authoritative: { label: 'all rows, RLS bypassed', tone: 'text-chart-collected' },
  caller: { label: 'your rows only', tone: 'text-chart-servicing' },
};

function HealthFigure({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-canvas p-5">
      <p className="text-sm font-medium text-content-subtle">{label}</p>
      <p className={`mt-3 text-3xl font-bold ${tone}`}>{value}</p>
      <p className="mt-2 text-xs text-content-muted">{detail}</p>
    </div>
  );
}

function BucketRow({ bucket, missing }: { bucket: StorageBucketStatus | null; missing: string }) {
  if (!bucket) {
    return (
      <tr>
        <td className="px-4 py-3 font-medium text-content">{missing}</td>
        <td className="px-4 py-3">
          <span className="inline-flex rounded-full bg-chart-danger/10 px-2.5 py-1 text-xs font-semibold text-chart-danger">
            MISSING
          </span>
        </td>
        <td className="px-4 py-3 text-content-muted">—</td>
        <td className="px-4 py-3 text-content-muted">—</td>
        <td className="px-4 py-3 text-content-muted">—</td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="px-4 py-3 font-medium text-content">{bucket.name}</td>
      <td className="px-4 py-3">
        {/* Three states, not two. `null` means the inventory did not report
            visibility, and rendering that as "private" would assert a security
            property nobody checked — the specific failure this table exists to
            catch. */}
        <span
          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
            bucket.isPublic === true
              ? 'bg-chart-danger/10 text-chart-danger'
              : bucket.isPublic === false
                ? 'bg-chart-collected/10 text-chart-collected'
                : 'bg-chart-servicing/5 text-chart-servicing'
          }`}
        >
          {bucket.isPublic === true ? 'PUBLIC' : bucket.isPublic === false ? 'private' : 'not reported'}
        </span>
      </td>
      <td className="px-4 py-3 text-content-muted">{bucket.objectCount.toLocaleString()}</td>
      <td className="px-4 py-3 text-content-muted">{formatBytes(bucket.sizeBytes)}</td>
      <td className="px-4 py-3 text-content-muted">
        {bucket.fileSizeLimit === null ? 'unlimited' : `${formatBytes(bucket.fileSizeLimit)} / file`}
      </td>
    </tr>
  );
}

export function SystemHealthPanel({ health }: { health: DeveloperHealthState }) {
  const { payload, isLoading, isRefreshing, error, refresh } = health;

  if (isLoading && !payload) {
    return (
      <div className="rounded-2xl border border-line bg-canvas p-6" role="status">
        <p className="text-sm text-content-muted">Checking Supabase connectivity and row counts…</p>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="rounded-2xl border border-chart-danger/30 bg-chart-danger/5 p-6">
        <p className="text-sm font-semibold text-chart-danger">Health check unavailable</p>
        <p className="mt-2 text-sm text-content-muted">
          {error ?? 'The endpoint returned no data and no error, which should not happen.'}
        </p>
        <button
          type="button"
          onClick={refresh}
          className="mt-4 rounded-xl bg-brand-solid px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-solid-strong"
        >
          Try again
        </button>
      </div>
    );
  }

  const style = severityStyles[payload.overall];
  const byName = new Map(payload.storage.buckets.map((bucket) => [bucket.name, bucket]));
  const knownBuckets = ['driver-credentials', 'driver-docs', 'avatars'];
  // A bucket present but not on the known list is still shown: an unexpected
  // public bucket in this project is worth seeing, not filtering out.
  const bucketRows = [
    ...knownBuckets.map((name) => name),
    ...payload.storage.buckets.map((bucket) => bucket.name).filter((name) => !knownBuckets.includes(name)),
  ];

  const totalObjects = payload.storage.buckets.reduce((sum, bucket) => sum + bucket.objectCount, 0);
  const totalBytes = payload.storage.buckets.reduce((sum, bucket) => sum + bucket.sizeBytes, 0);

  return (
    <div className="space-y-6 text-content">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] ${style.pill}`}>
            <span className={`h-2 w-2 rounded-full ${payload.overall === 'ok' ? 'bg-chart-collected' : payload.overall === 'warn' ? 'bg-chart-servicing' : 'bg-chart-danger'}`} />
            {style.label}
          </span>
          <p className="text-xs text-content-muted">
            Checked{' '}
            <time dateTime={payload.checkedAt}>{new Date(payload.checkedAt).toLocaleTimeString()}</time>
            {' · '}
            {payload.durationMs}ms total
            {error ? ' · showing the last successful reading' : ''}
          </p>
        </div>

        <button
          type="button"
          onClick={refresh}
          disabled={isRefreshing}
          className="inline-flex items-center gap-2 self-start rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-content transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRefreshing ? 'Refreshing…' : 'Refresh metrics'}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-chart-danger/30 bg-chart-danger/5 p-3">
          <p className="text-sm font-semibold text-chart-danger">The last refresh failed</p>
          <p className="mt-1 text-sm text-content-muted">{error}</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <HealthFigure
          label="Database round trip"
          value={payload.database.latencyMs === null ? '—' : `${payload.database.latencyMs} ms`}
          detail={payload.database.probe}
          tone={payload.database.reachable ? 'text-chart-blue' : 'text-chart-danger'}
        />
        <HealthFigure
          label="Active RLS policies"
          value={payload.rls.policyCount === null ? 'unavailable' : payload.rls.policyCount.toLocaleString()}
          detail={
            payload.rls.available
              ? `${payload.rls.publicPolicies ?? 0} public · ${payload.rls.storagePolicies ?? 0} storage`
              : 'Needs the introspection migration'
          }
          tone={payload.rls.available ? 'text-chart-collected' : 'text-chart-servicing'}
        />
        <HealthFigure
          label="Stored objects"
          value={payload.storage.available ? totalObjects.toLocaleString() : 'unavailable'}
          detail={payload.storage.available ? formatBytes(totalBytes) : 'Needs the introspection migration'}
          tone={payload.storage.available ? 'text-chart-blue' : 'text-chart-servicing'}
        />
        <HealthFigure
          label="Findings"
          value={String(payload.findings.length)}
          detail={
            payload.findings.some((finding) => finding.severity === 'error')
              ? 'Includes at least one error'
              : payload.findings.length > 0
                ? 'Warnings only'
                : 'Nothing to report'
          }
          tone={
            payload.findings.some((finding) => finding.severity === 'error')
              ? 'text-chart-danger'
              : payload.findings.length > 0
                ? 'text-chart-servicing'
                : 'text-chart-collected'
          }
        />
      </div>

      <p className="text-xs text-content-muted">
        Re-checks automatically every {HEALTH_POLL_INTERVAL_MS / 1000} seconds.
      </p>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-line bg-canvas p-5">
          <p className="text-sm font-medium text-content-subtle">Row counts</p>
          <h3 className="mt-1 text-xl font-bold text-content">Core tables</h3>

          <dl className="mt-4 space-y-3">
            {payload.tables.map((table) => (
              <div key={table.table} className="rounded-xl border border-line bg-surface p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <dt className="font-mono text-sm font-medium text-content">{table.table}</dt>
                  <dd className="text-2xl font-bold text-content">
                    {table.count === null ? (
                      <span className="text-base font-semibold text-chart-servicing">unknown</span>
                    ) : (
                      table.count.toLocaleString()
                    )}
                  </dd>
                </div>
                <p className={`mt-1 text-xs font-semibold ${scopeLabels[table.scope].tone}`}>
                  {table.error
                    ? `Could not count: ${table.error}`
                    : `${scopeLabels[table.scope].label}${table.note ? ` — ${table.note}` : ''}`}
                </p>
              </div>
            ))}
          </dl>
        </div>

        <div className="rounded-2xl border border-line bg-canvas p-5">
          <p className="text-sm font-medium text-content-subtle">Findings</p>
          <h3 className="mt-1 text-xl font-bold text-content">What this check actually observed</h3>

          {payload.findings.length === 0 ? (
            <p className="mt-4 text-sm text-content-muted">
              No findings. Every measurement this endpoint can make came back clean.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {payload.findings.map((finding, index) => (
                <li
                  key={`${finding.severity}-${index}`}
                  className={`rounded-xl border p-3 ${
                    finding.severity === 'error'
                      ? 'border-chart-danger/30 bg-chart-danger/5'
                      : 'border-chart-servicing/30 bg-chart-servicing/5'
                  }`}
                >
                  <p
                    className={`text-xs font-semibold uppercase tracking-[0.12em] ${
                      finding.severity === 'error' ? 'text-chart-danger' : 'text-chart-servicing'
                    }`}
                  >
                    {finding.severity === 'error' ? 'Error' : 'Warning'}
                  </p>
                  <p className="mt-1 text-sm text-content">{finding.message}</p>
                </li>
              ))}
            </ul>
          )}

          {!payload.storage.available && (
            <div className="mt-4 rounded-xl border border-line bg-surface p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-content-subtle">
                Why storage is unavailable
              </p>
              <p className="mt-1 text-sm text-content-muted">{payload.storage.reason}</p>
            </div>
          )}

          {!payload.rls.available && (
            <div className="mt-4 rounded-xl border border-line bg-surface p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-content-subtle">
                Why the policy count is unavailable
              </p>
              <p className="mt-1 text-sm text-content-muted">{payload.rls.reason}</p>
            </div>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-canvas">
        <div className="p-5 pb-0">
          <p className="text-sm font-medium text-content-subtle">Storage</p>
          <h3 className="mt-1 text-xl font-bold text-content">Bucket inventory</h3>
          <p className="mt-1 text-sm text-content-muted">
            Every bucket in this schema must be private. A public one means driver national IDs and face photos
            are readable by anyone holding the URL. &ldquo;Not reported&rdquo; means the inventory function did not
            return that column, so this check could not verify it either way.
          </p>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-line text-left text-sm">
            <thead className="bg-surface text-content-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Bucket</th>
                <th className="px-4 py-3 font-semibold">Visibility</th>
                <th className="px-4 py-3 font-semibold">Objects</th>
                <th className="px-4 py-3 font-semibold">Size on disk</th>
                <th className="px-4 py-3 font-semibold">Per-file cap</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line bg-canvas">
              {bucketRows.map((name) => (
                <BucketRow key={name} bucket={byName.get(name) ?? null} missing={name} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
