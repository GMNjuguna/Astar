'use client';

import { useEffect, useMemo, useState } from 'react';

import { fetchApiJson } from '@/lib/api-client';
import { FEATURE_FLAG_DEFINITIONS } from '@/lib/feature-flags';
import type { DeveloperHealthState } from '@/lib/use-developer-health';
import type { StorageBucketStatus } from '@/types/developer-health';

type FeatureFlag = {
  key: string;
  label: string;
  description: string;
  value: boolean;
  persisted: boolean;
  updatedAt: string | null;
};

type ConfigResponse = {
  flags?: FeatureFlag[];
  fullyConfigured?: boolean;
};

/**
 * Rendered before the first fetch resolves, and used as the shape the API
 * returns. The authoritative on/off state comes from `system_config`; these are
 * bootstrap values only.
 */
const initialFlags: FeatureFlag[] = FEATURE_FLAG_DEFINITIONS.map((definition) => ({
  key: definition.key,
  label: definition.label,
  description: definition.description,
  value: definition.defaultValue,
  persisted: false,
  updatedAt: null,
}));

/**
 * The latency bar's full-scale value.
 *
 * Matches the threshold `app/api/developer/health` raises its own warning at, so
 * the gauge and the findings list cannot disagree about what "slow" means. It is a
 * stated scale, not a target the database is being measured against.
 */
const LATENCY_SCALE_MS = 1000;

/** Local rather than imported: `lib/format.ts` only covers currency. */
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
 * Fleet Controls.
 *
 * ── Why `health` is passed in rather than fetched here ───────────────────────
 * The telemetry gauges below used to render three invented figures: "Supabase DB
 * latency 189ms" on a bar filled to 72%, "driver-docs bucket 67%", and "Active
 * sockets 1,284" on a bar filled to 82%.
 *
 * None of them was ever measured, and the third was not a stale reading — there was
 * no code anywhere in the project that could produce a socket count, so there was
 * nothing to refresh and only something to stop asserting. It also sat next to a
 * real toggle that saves to `system_config`, which made the panel read as a live
 * operational view.
 *
 * The developer page already polls `/api/developer/health` for its header badge, the
 * summary cards and the Overview panel. Fetching it a fourth time here would start
 * a second 30-second poll that resolves independently, so the Fleet Controls
 * latency figure could disagree with the badge directly above it. Taking the page's
 * state as a prop keeps one request and one reading.
 */
export function FeatureTogglePanel({ health }: { health: DeveloperHealthState }) {
  const [flags, setFlags] = useState<FeatureFlag[]>(initialFlags);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadFlags() {
      const result = await fetchApiJson<ConfigResponse>('/api/developer/config');

      if (cancelled) {
        return;
      }

      if (!result.ok) {
        // Previously this was swallowed and the bootstrap values were left on
        // screen, so a dead database looked exactly like a working one.
        setLoadError(result.message);
        return;
      }

      setLoadError('');

      if (Array.isArray(result.data.flags) && result.data.flags.length) {
        setFlags(result.data.flags);
      }
    }

    void loadFlags();

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleFlag = (key: string) => {
    setFlags((current) =>
      current.map((flag) =>
        flag.key === key
          ? {
              ...flag,
              value: !flag.value,
            }
          : flag
      )
    );
  };

  const saveChanges = async () => {
    setIsSaving(true);
    setSaveMessage('');

    const result = await fetchApiJson<ConfigResponse>('/api/developer/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flags: flags.map((flag) => ({ key: flag.key, value: flag.value })),
      }),
    });

    setIsSaving(false);

    if (!result.ok) {
      // The previous code ignored the response entirely and reported success
      // unconditionally, so a rejected save still claimed to have saved.
      setSaveMessage(result.message);
      return;
    }

    // Adopt the server's re-read state rather than the local optimistic copy.
    if (Array.isArray(result.data.flags) && result.data.flags.length) {
      setFlags(result.data.flags);
    }

    setSaveMessage('Emergency controls saved successfully.');
  };

  const unpersistedCount = flags.filter((flag) => !flag.persisted).length;

  const { payload, isLoading: isHealthLoading, error: healthError, refresh: refreshHealth } = health;

  /**
   * Storage, read off the live inventory.
   *
   * `totalBytes` is summed rather than taken from any single figure, and the
   * per-bucket table below is what makes the number auditable — a total with no
   * breakdown is not something an operator can act on when it surprises them.
   */
  const storage = useMemo(() => {
    const buckets: StorageBucketStatus[] = payload?.storage.buckets ?? [];
    const available = payload?.storage.available ?? false;

    return {
      available,
      buckets,
      objectCount: buckets.reduce((sum, bucket) => sum + bucket.objectCount, 0),
      sizeBytes: buckets.reduce((sum, bucket) => sum + bucket.sizeBytes, 0),
      /** The bucket the old panel singled out by name, now looked up. */
      documents: buckets.find((bucket) => bucket.name === 'driver-docs') ?? null,
      /** True when at least one bucket's visibility the inventory did not report. */
      visibilityUnknown: buckets.some((bucket) => bucket.isPublic === null),
    };
  }, [payload]);

  return (
    <div className="space-y-5 text-content">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-medium text-content-subtle">System overrides</p>
          <h2 className="mt-1 text-2xl font-bold text-content">Fleet diagnostics & emergency controls</h2>
        </div>
        <button
          type="button"
          onClick={() => void saveChanges()}
          disabled={isSaving || loadError !== ''}
          className="rounded-lg bg-brand-solid px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-solid-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSaving ? 'Saving...' : 'Save overrides'}
        </button>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-chart-danger/40 bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger">
          <p className="font-semibold">Live settings unavailable</p>
          <p className="mt-1">{loadError}</p>
          <p className="mt-1 text-xs text-chart-danger/80">
            The values below are built-in defaults, not the current configuration.
          </p>
        </div>
      ) : null}

      {unpersistedCount > 0 && loadError === '' ? (
        <div className="rounded-xl border border-chart-servicing/30 bg-chart-servicing/5 px-3 py-2 text-sm text-chart-servicing">
          {unpersistedCount} control{unpersistedCount === 1 ? ' has' : 's have'} never been saved and{' '}
          {unpersistedCount === 1 ? 'is' : 'are'} showing the built-in default.
        </div>
      ) : null}

      {saveMessage ? (
        <div
          className={`rounded-xl border px-3 py-2 text-sm ${
            saveMessage === 'Emergency controls saved successfully.'
              ? 'border-chart-collected/30 bg-chart-collected/10 text-chart-collected'
              : 'border-chart-danger/40 bg-chart-danger/10 text-chart-danger'
          }`}
        >
          {saveMessage}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-4 rounded-2xl border border-line bg-canvas p-5">
          {flags.map((flag) => (
            <div key={flag.key} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
              <div>
                <p className="font-semibold text-content">{flag.label}</p>
                <p className="mt-1 text-sm text-content-subtle">{flag.description}</p>
                {!flag.persisted ? (
                  <p className="mt-1 text-xs text-chart-servicing/80">Not yet configured &mdash; showing default.</p>
                ) : null}
              </div>

              <button
                type="button"
                aria-pressed={flag.value}
                aria-label={`${flag.label}: ${flag.value ? 'on' : 'off'}`}
                onClick={() => toggleFlag(flag.key)}
                className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${flag.value ? 'bg-chart-collected' : 'bg-surface-2'}`}
              >
                <span className={`inline-block h-5 w-5 rounded-full bg-surface shadow-sm transition ${flag.value ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/*
       * ── Telemetry ──────────────────────────────────────────────────────────
       * Replaces three gauges that read "Supabase DB latency 189ms" (bar at 72%),
       * "driver-docs bucket 67%" (bar at 67%) and "Active sockets 1,284" (bar at
       * 82%). None was measured.
       *
       * The percentages had no denominator. Supabase exposes no storage quota
       * through PostgREST, so "67% of quota" was a bar drawn against an imagined
       * ceiling, and a 100%-full bar would have meant nothing to the reader. The
       * latency bar had the same problem: 72% of what?
       *
       * So the bar is kept for latency, because there IS a real threshold to scale
       * against — the 1000ms above which this route itself raises a warning — and the
       * bar is labelled with that threshold so the scale is stated rather than
       * implied. Storage bytes and object counts are shown as figures, because
       * neither has a ceiling in this schema. Connections get a bar only once the
       * count and `max_connections` are both real.
       */}
      <div className="space-y-4 rounded-2xl border border-line bg-canvas p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-content-subtle">Database &amp; storage</p>
            <h3 className="mt-1 text-xl font-bold text-content">Telemetry gauges</h3>
          </div>
          <div className="flex items-center gap-2">
            {payload ? (
              <span className="text-xs text-content-muted">
                Read {new Date(payload.checkedAt).toLocaleTimeString()}
              </span>
            ) : null}
            <button
              type="button"
              onClick={refreshHealth}
              disabled={isHealthLoading}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-content transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
        </div>

        {healthError ? (
          <div className="rounded-xl border border-chart-danger/30 bg-chart-danger/5 px-3 py-2 text-xs text-chart-danger">
            <p className="font-semibold">The health check could not be read</p>
            <p className="mt-1">{healthError}</p>
            <p className="mt-1">
              {payload
                ? 'The figures below are from the last successful reading, not live.'
                : 'There is no previous reading, so no figure is shown rather than a placeholder one.'}
            </p>
          </div>
        ) : null}

        {!payload ? (
          <p className="rounded-xl border border-line bg-surface px-3 py-4 text-sm text-content-muted">
            {isHealthLoading
              ? 'Measuring database latency, storage and connection counts…'
              : 'No health reading is available, so no telemetry is shown.'}
          </p>
        ) : (
          <div className="space-y-3">
            {/* Latency — the one gauge with a real, stated scale. */}
            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-content-muted">Supabase DB round trip</span>
                <span
                  className={`font-semibold ${
                    payload.database.latencyMs === null
                      ? 'text-chart-danger'
                      : payload.database.latencyMs > 1000
                        ? 'text-chart-servicing'
                        : 'text-content'
                  }`}
                >
                  {payload.database.latencyMs === null ? 'unreachable' : `${payload.database.latencyMs} ms`}
                </span>
              </div>
              <div className="h-2.5 rounded-full bg-line">
                <div
                  className={`h-2.5 rounded-full ${
                    payload.database.latencyMs !== null && payload.database.latencyMs > 1000
                      ? 'bg-chart-servicing'
                      : 'bg-chart-blue'
                  }`}
                  style={{
                    // Capped at the route's own warning threshold, and the label
                    // below says so — the bar cannot silently run off its own scale.
                    width: `${Math.min(
                      ((payload.database.latencyMs ?? 0) / LATENCY_SCALE_MS) * 100,
                      100
                    )}%`,
                  }}
                />
              </div>
              <p className="mt-2 text-xs text-content-muted">
                Scaled against a {LATENCY_SCALE_MS / 1000}s ceiling, which is where this endpoint raises its own
                latency warning. Measured as <span className="font-mono">{payload.database.probe}</span>.
              </p>
            </div>

            {/* Connections — a real ratio once the RPC exists. */}
            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-content-muted">Postgres connections in use</span>
                <span
                  className={`font-semibold ${
                    payload.connections.available && (payload.connections.total ?? 0) / Math.max(payload.connections.maxConnections ?? 1, 1) >= 0.9
                      ? 'text-chart-danger'
                      : 'text-content'
                  }`}
                >
                  {payload.connections.available && payload.connections.total !== null
                    ? payload.connections.maxConnections !== null
                      ? `${payload.connections.total} / ${payload.connections.maxConnections}`
                      : String(payload.connections.total)
                    : 'not observable'}
                </span>
              </div>
              {payload.connections.available &&
              payload.connections.total !== null &&
              payload.connections.maxConnections !== null &&
              payload.connections.maxConnections > 0 ? (
                <>
                  <div className="h-2.5 rounded-full bg-line">
                    <div
                      className="h-2.5 rounded-full bg-chart-collected"
                      style={{
                        width: `${Math.min((payload.connections.total / payload.connections.maxConnections) * 100, 100)}%`,
                      }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-content-muted">
                    {payload.connections.active ?? 0} active, {payload.connections.idle ?? 0} idle, of a hard{' '}
                    {payload.connections.maxConnections}-connection ceiling. From pg_stat_activity; the connection
                    running this check is itself counted.
                  </p>
                </>
              ) : (
                <p className="text-xs text-content-muted">
                  {payload.connections.reason ??
                    'pg_stat_activity is not reachable through PostgREST, so this cannot be measured without the introspection migration.'}
                </p>
              )}
            </div>

            {/* Storage — figures, not a bar: there is no quota ceiling to divide by. */}
            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-content-muted">Stored objects</span>
                <span className="font-semibold text-content">
                  {storage.available ? storage.objectCount.toLocaleString() : 'unavailable'}
                </span>
              </div>
              <p className="text-xs text-content-muted">
                {storage.available
                  ? `${formatBytes(storage.sizeBytes)} across ${storage.buckets.length} bucket${storage.buckets.length === 1 ? '' : 's'}. No quota figure is exposed through PostgREST, so this is shown as an absolute rather than as a percentage of a ceiling that does not exist.`
                  : 'The storage inventory function is not available.'}
              </p>
            </div>

            {/* The bucket the old panel named, looked up by name rather than hardcoded. */}
            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-content-muted">driver-docs bucket</span>
                <span className="font-semibold text-content">
                  {storage.documents
                    ? `${storage.documents.objectCount.toLocaleString()} objects · ${formatBytes(storage.documents.sizeBytes)}`
                    : storage.available
                      ? 'bucket absent'
                      : 'unavailable'}
                </span>
              </div>
              {storage.visibilityUnknown ? (
                <p className="text-xs text-chart-servicing">
                  Bucket visibility was not reported by the inventory, so this panel cannot confirm any bucket is
                  private. See the Overview tab for the full inventory.
                </p>
              ) : (
                <p className="text-xs text-content-muted">
                  {!storage.documents
                    ? 'Named explicitly because it holds driver national IDs and licences.'
                    : storage.documents.isPublic === true
                      ? 'This bucket is PUBLIC — every object in it is readable by URL without a signature.'
                      : storage.documents.isPublic === false
                        ? 'Private, reached only through short-lived signed URLs.'
                        : 'Visibility not reported by the inventory.'}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-line bg-canvas p-5">
        <p className="text-sm font-medium text-content-subtle">Manual data patching</p>
        <h3 className="mt-1 text-xl font-bold text-content">Support override patch form</h3>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="block text-sm text-content-muted">
            Remittance record
            <input
              defaultValue="ASTAR-2048"
              className="mt-2 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-content outline-none focus:border-accent"
            />
          </label>

          <label className="block text-sm text-content-muted">
            Adjustment amount
            <input
              defaultValue="Ksh 12,500"
              className="mt-2 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-content outline-none focus:border-accent"
            />
          </label>

          <label className="block text-sm text-content-muted md:col-span-2">
            Driver verification document
            <input
              defaultValue="Document review stuck pending for C-2026-774"
              className="mt-2 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-content outline-none focus:border-accent"
            />
          </label>
        </div>

        <div className="mt-5 flex justify-end">
          <button type="button" className="rounded-lg border border-chart-collected/30 bg-chart-collected/10 px-4 py-2.5 text-sm font-semibold text-chart-collected">
            Apply patch / approve
          </button>
        </div>
      </div>
    </div>
  );
}