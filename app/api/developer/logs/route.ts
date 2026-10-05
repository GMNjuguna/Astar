/**
 * System logs derived from real database timestamps.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `/api/developer/audit` returned five literal entries: a "Daily remittance sync
 * completed successfully" with `records: 48, total_amount: 18420`, a Daraja
 * callback failing signature validation with `result_code: 1032`, "Replica lag
 * increased to 3.4s", a prompt template refreshed to "v2.4.1", and a Paystack
 * retry queue exceeding threshold. Each carried a `stackTrace` and a
 * `statusCode`.
 *
 * None of it was observed, and most of it described systems this application does
 * not have:
 *
 *   - No payment provider is integrated. There is no webhook endpoint, so
 *     "Validation failure on callback signature" and "Retry queue exceeded
 *     threshold" describe infrastructure that has never existed here.
 *   - `ai-assistant` v2.4.1 was a string in a component, not a deployed version.
 *   - Replica lag is not exposed by PostgREST and was not measured.
 *   - The stack traces — "Webhook signature mismatch at verifySignature() ->
 *     reject()", "Queue drain failure; retry_max_exceeded" — named functions that
 *     do not exist in this codebase.
 *
 * A fabricated stack trace is worse than a fabricated number, because a stack trace
 * is the one artefact an operator trusts without checking. So this route returns
 * only columns that exist, and severity is derived by stated rules rather than
 * asserted.
 *
 * ── What a real system log would need ──────────────────────────────────────
 * There is no audit-log or event table in `supabase/baseline.sql`. Everything below
 * is therefore reconstructed from `created_at` / `reviewed_at` / `updated_at`
 * columns on operational tables. That is a genuine, useful signal — it is when
 * rows appeared and what state they are in — but it is not an event log: it
 * cannot show an action that changed nothing, and it has no before/after. The
 * payload sets `derivedFromRowTimestamps: true` and the UI labels it, so nobody
 * reads this as a complete audit trail.
 *
 * ── Severity rules, stated rather than implied ─────────────────────────────
 *   ERROR  overdue remittances (money past due), rejected onboarding candidates,
 *          suspended profiles, an account registered with a privileged role.
 *   WARN   remittances still pending beyond the grace window, candidates awaiting
 *          manual review, open maintenance, queue entries never reviewed.
 *   INFO   ordinary activity: a new account, a new vehicle, a paid remittance.
 *
 * The privileged-role check is the one that matters most: a `developer` or `ceo`
 * profile appearing in the recent-accounts stream is a security event, and the
 * panel should say so rather than file it as routine INFO.
 */
import { NextResponse } from 'next/server';

import { authorizeRole } from '@/lib/auth';
import type { DeveloperLogsPayload, LogSeverity, SystemLogEntry } from '@/types/developer-health';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['developer'];

/** Rows read per source. Bounded so the endpoint cannot become a table dump. */
const PER_SOURCE_LIMIT = 12;

/**
 * Grace window before an unpaid remittance stops being merely pending.
 *
 * Daily remittances are filed per day, so anything unpaid two days after it was
 * recorded has stopped being a normal settlement delay.
 */
const PENDING_GRACE_DAYS = 2;

/** Candidates sitting in the queue with no decision, in days. */
const STALE_QUEUE_DAYS = 3;

/** Roles that must never appear on a self-registered account. */
const PRIVILEGED_ROLES = new Set(['developer', 'ceo', 'manager']);

/**
 * A selected row, as this route sees it.
 *
 * Deliberately loose: each source selects a different column set, so a shared
 * interface would either be a union of six shapes or a lie about which columns
 * exist. Read sites coerce with `String(...)`/`Number(...)` and re-derive
 * nullability from the actual value, which is why the logs panel can never show
 * "undefined" the way a spread of a typed row into a loosely typed payload can.
 */
type Row = Record<string, unknown>;

function daysSince(iso: string, now: number): number {
  const at = new Date(iso).getTime();

  if (Number.isNaN(at)) {
    return 0;
  }

  return (now - at) / 86_400_000;
}

function severityRank(severity: LogSeverity): number {
  return severity === 'ERROR' ? 0 : severity === 'WARN' ? 1 : 2;
}

/**
 * Trims a row to the fields worth showing.
 *
 * Explicit field lists, never a spread of the row: `profiles` and
 * `driver_onboarding_queue` carry national IDs, driving licence numbers, setup
 * links and phone numbers. A log panel is copied and pasted, and a payload dump
 * would put those into whatever the operator pastes it into.
 */
export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const supabase = auth.supabase;
  const now = Date.now();

  // ── Per-source reads ──────────────────────────────────────────────────────
  // Issued together, and each one's latency measured independently so one slow
  // table is not attributed to another.
  //
  // `latencyMs` on a log row was previously a hand-written number (184ms, 410ms,
  // 236ms) attached to a row that did not exist. Here the same field carries the
  // measured round trip of the query that actually produced the entry, so the
  // column means something.
  type SourceRead = { name: string; latencyMs: number; rows: Row[]; error: string | null };

  /**
   * Awaits one query and records its measured round trip.
   *
   * Typed against the minimal `{ data, error }` shape rather than
   * `Promise<T>`: `supabase-js` gives every `.select()` chain a different response
   * type, so a generic over the promise inferred a union of all six and the
   * result stopped being assignable to anything useful.
   */
  async function read(
    name: string,
    work: PromiseLike<{ data: unknown; error: { message: string } | null }>
  ): Promise<SourceRead> {
    const startedAt = performance.now();

    try {
      const { data, error } = await work;

      return {
        name,
        latencyMs: Math.round(performance.now() - startedAt),
        // `data` is null when the query failed, which must not become one invented
        // row, and is never an object for these single-table selects.
        rows: Array.isArray(data) ? (data as Row[]) : [],
        error: error ? error.message : null,
      };
    } catch (error) {
      return {
        name,
        latencyMs: Math.round(performance.now() - startedAt),
        rows: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    const [profiles, cars, remittances, queue, maintenance, config] = await Promise.all([
      read(
        'profiles',
        supabase
          .from('profiles')
          .select('id, full_name, role, status, created_at')
          .order('created_at', { ascending: false })
          .limit(PER_SOURCE_LIMIT)
      ),
      read(
        'cars',
        supabase
          .from('cars')
          .select('id, registration_number, model, year, status, created_at')
          .order('created_at', { ascending: false })
          .limit(PER_SOURCE_LIMIT)
      ),
      read(
        'daily_remittances',
        supabase
          .from('daily_remittances')
          .select('id, driver_id, car_id, amount, status, created_at, payment_date, payment_reference')
          .order('created_at', { ascending: false })
          .limit(PER_SOURCE_LIMIT)
      ),
      read(
        'driver_onboarding_queue',
        supabase
          .from('driver_onboarding_queue')
          .select('id, full_name, status, verification_status, created_at, reviewed_at, rejection_reason')
          .order('created_at', { ascending: false })
          .limit(PER_SOURCE_LIMIT)
      ),
      read(
        'vehicle_maintenance',
        supabase
          .from('vehicle_maintenance')
          .select('id, vehicle_registration, issue_summary, estimated_cost, priority, status, created_at')
          .order('created_at', { ascending: false })
          .limit(PER_SOURCE_LIMIT)
      ),
      read(
        'system_config',
        // `key`, not `id`: `system_config`'s primary key is `key` (it is a single
        // global key/value space). Selecting `id` is a 400 from PostgREST, which
        // would have made this one source report an error while the other five
        // succeeded.
        supabase
          .from('system_config')
          .select('key, updated_at')
          .order('updated_at', { ascending: false })
          .limit(1)
      ),
    ]);

    const logs: SystemLogEntry[] = [];
    const sources: DeveloperLogsPayload['sources'] = [];

    const push = (source: SourceRead, build: (row: Row) => SystemLogEntry | null) => {
      sources.push({ name: source.name, latencyMs: source.latencyMs, rows: source.rows.length });

      if (source.error) {
        logs.push({
          id: `error:${source.name}`,
          timestamp: new Date().toISOString(),
          source: source.name,
          severity: 'ERROR',
          message: `Could not read ${source.name}: ${source.error}`,
          payload: { table: source.name, error: source.error },
          queryLatencyMs: source.latencyMs,
        });

        return;
      }

      for (const row of source.rows) {
        const entry = build(row);

        if (entry) {
          logs.push(entry);
        }
      }
    };

    // Recent accounts. A privileged role here is a security event, not routine.
    push(profiles, (row) => {
      const role = String(row.role ?? '');
      const status = String(row.status ?? '');
      const createdAt = String(row.created_at ?? '');
      const fullName = row.full_name === null ? null : String(row.full_name);

      // The name is included because a security event needs an identity, and the
      // actor is the first thing an operator looks for. The id is included for the
      // same reason. Nothing else about the account is.
      const payload: Record<string, unknown> = { role, status };

      if (PRIVILEGED_ROLES.has(role)) {
        return {
          id: `profile:${String(row.id)}`,
          timestamp: createdAt,
          source: 'profiles',
          severity: 'ERROR',
          message: `Account "${fullName ?? String(row.id)}" holds the privileged role "${role}".`,
          payload,
          queryLatencyMs: profiles.latencyMs,
        };
      }

      if (status === 'suspended') {
        return {
          id: `profile:${String(row.id)}`,
          timestamp: createdAt,
          source: 'profiles',
          severity: 'ERROR',
          message: `Account "${fullName ?? String(row.id)}" is suspended.`,
          payload,
          queryLatencyMs: profiles.latencyMs,
        };
      }

      if (status === 'pending') {
        return {
          id: `profile:${String(row.id)}`,
          timestamp: createdAt,
          source: 'profiles',
          severity: 'WARN',
          message: `Account "${fullName ?? String(row.id)}" registered and is still awaiting approval.`,
          payload,
          queryLatencyMs: profiles.latencyMs,
        };
      }

      return {
        id: `profile:${String(row.id)}`,
        timestamp: createdAt,
        source: 'profiles',
        severity: 'INFO',
        message: `New account registered: "${fullName ?? String(row.id)}".`,
        payload,
        queryLatencyMs: profiles.latencyMs,
      };
    });

    // New vehicles. `cars` has no `updated_at`, so status changes cannot appear
    // here -- only rows as they were created. The UI says so.
    push(cars, (row) => {
      const createdAt = String(row.created_at ?? '');
      const status = String(row.status ?? '');

      return {
        id: `car:${String(row.id)}`,
        timestamp: createdAt,
        source: 'cars',
        severity: 'INFO',
        message: `Vehicle ${String(row.registration_number ?? '')} (${String(row.model ?? '')} ${String(row.year ?? '')}) added to the fleet with status "${status}".`,
        payload: {
          registrationNumber: row.registration_number ?? null,
          model: row.model ?? null,
          year: row.year ?? null,
          status,
          // Named explicitly so the limitation is in the data, not only in a
          // comment: `cars` has no `updated_at`, so this panel cannot show edits.
          updateTracking: 'none — cars has no updated_at column',
        },
        queryLatencyMs: cars.latencyMs,
      };
    });

    // Remittances. The only source with money attached, so the strictest rules.
    push(remittances, (row) => {
      const createdAt = String(row.created_at ?? '');
      const status = String(row.status ?? '');
      const amount = Number(row.amount ?? 0);
      const age = daysSince(createdAt, now);

      const payload: Record<string, unknown> = {
        driverId: row.driver_id ?? null,
        carId: row.car_id ?? null,
        amount,
        status,
        paymentDate: row.payment_date ?? null,
        paymentReference: row.payment_reference ?? null,
        ageDays: Math.round(age * 10) / 10,
      };

      if (status === 'overdue') {
        return {
          id: `remittance:${String(row.id)}`,
          timestamp: createdAt,
          source: 'daily_remittances',
          severity: 'ERROR',
          message: `Remittance of ${amount.toLocaleString()} is OVERDUE.`,
          payload,
          queryLatencyMs: remittances.latencyMs,
        };
      }

      if (status === 'pending' && age > PENDING_GRACE_DAYS) {
        return {
          id: `remittance:${String(row.id)}`,
          timestamp: createdAt,
          source: 'daily_remittances',
          severity: 'WARN',
          message: `Remittance of ${amount.toLocaleString()} has been pending for ${Math.round(age)} days.`,
          payload,
          queryLatencyMs: remittances.latencyMs,
        };
      }

      return {
        id: `remittance:${String(row.id)}`,
        timestamp: createdAt,
        source: 'daily_remittances',
        severity: 'INFO',
        message: `Remittance of ${amount.toLocaleString()} recorded with status "${status}".`,
        payload,
        queryLatencyMs: remittances.latencyMs,
      };
    });

    // Onboarding decisions. `reviewed_at` is a real update timestamp, so status
    // changes genuinely are observable here — unlike `cars`.
    push(queue, (row) => {
      const status = String(row.status ?? '');
      const verification = String(row.verification_status ?? '');
      const reviewedAt = row.reviewed_at === null ? null : String(row.reviewed_at);
      const createdAt = String(row.created_at ?? '');
      // A decided event is timestamped by when it was decided; an undecided one by
      // when it was submitted, so the entry sits at the right point in time.
      const timestamp = reviewedAt ?? createdAt;
      const age = daysSince(timestamp, now);

      const payload: Record<string, unknown> = {
        status,
        verificationStatus: verification,
        // `full_name` is a name the manager typed in; the national ID and licence
        // number in the same row are deliberately not selected.
        reviewedAt,
        ageDays: Math.round(age * 10) / 10,
      };

      if (status === 'rejected') {
        return {
          id: `queue:${String(row.id)}`,
          timestamp,
          source: 'driver_onboarding_queue',
          severity: 'ERROR',
          message: `Onboarding candidate rejected: ${row.rejection_reason ?? 'no reason recorded'}.`,
          payload,
          queryLatencyMs: queue.latencyMs,
        };
      }

      if (status === 'pending' && age > STALE_QUEUE_DAYS) {
        return {
          id: `queue:${String(row.id)}`,
          timestamp,
          source: 'driver_onboarding_queue',
          severity: 'WARN',
          message: `Candidate has waited ${Math.round(age)} days for a decision and still has none.`,
          payload,
          queryLatencyMs: queue.latencyMs,
        };
      }

      if (status === 'pending') {
        return {
          id: `queue:${String(row.id)}`,
          timestamp,
          source: 'driver_onboarding_queue',
          severity: 'INFO',
          message: `Candidate awaiting review (${verification === 'auto_verified' ? 'auto-verified' : 'manual review required'}).`,
          payload,
          queryLatencyMs: queue.latencyMs,
        };
      }

      return {
        id: `queue:${String(row.id)}`,
        timestamp,
        source: 'driver_onboarding_queue',
        severity: 'INFO',
        message: `Candidate marked "${status}".`,
        payload,
        queryLatencyMs: queue.latencyMs,
      };
    });

    push(maintenance, (row) => {
      const createdAt = String(row.created_at ?? '');
      const status = String(row.status ?? '');
      const priority = String(row.priority ?? '');
      const age = daysSince(createdAt, now);

      const payload: Record<string, unknown> = {
        vehicleRegistration: row.vehicle_registration ?? null,
        priority,
        status,
        estimatedCost: row.estimated_cost ?? null,
        ageDays: Math.round(age * 10) / 10,
        // Estimates, not spend. The schema has no actual-cost column.
        costBasis: 'estimated_cost — a quote, not an incurred cost',
      };

      if (status !== 'completed') {
        return {
          id: `maintenance:${String(row.id)}`,
          timestamp: createdAt,
          source: 'vehicle_maintenance',
          severity: priority === 'high' ? 'WARN' : 'INFO',
          message: `${priority}-priority maintenance on ${String(row.vehicle_registration ?? 'vehicle')}: ${String(row.issue_summary ?? '')} (${status}).`,
          payload,
          queryLatencyMs: maintenance.latencyMs,
        };
      }

      return {
        id: `maintenance:${String(row.id)}`,
        timestamp: createdAt,
        source: 'vehicle_maintenance',
        severity: 'INFO',
        message: `Maintenance completed on ${String(row.vehicle_registration ?? 'vehicle')}.`,
        payload,
        queryLatencyMs: maintenance.latencyMs,
      };
    });

    push(config, (row) => ({
      id: `config:${String(row.key)}`,
      timestamp: String(row.updated_at ?? ''),
      source: 'system_config',
      severity: 'INFO',
      message: `System configuration "${String(row.key ?? '')}" was written.`,
      payload: {
        key: row.key ?? null,
        // The name only. The `value` column holds the whole chatbot prompt and
        // feature-flag payload; a log line is the wrong place for it, and it is
        // readable in full from Fleet Controls.
        valueOmitted: 'config values are shown in Fleet Controls, not in the event stream',
      },
      queryLatencyMs: config.latencyMs,
    }));

    logs.sort((a, b) => {
      const bySeverity = severityRank(a.severity) - severityRank(b.severity);

      if (bySeverity !== 0) {
        return bySeverity;
      }

      // Most recent first within a severity.
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    const payload: DeveloperLogsPayload = {
      logs: logs.slice(0, 60),
      sources,
      checkedAt: new Date().toISOString(),
      derivedFromRowTimestamps: true,
    };

    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Internal Server Error',
        code: 'logs_query_failed',
        message: `Could not read system events: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }

}