/**
 * Live Supabase health for the Developer System Portal.
 *
 * ── What replaced what ──────────────────────────────────────────────────────
 * The portal previously rendered four invented summary cards — "API latency
 * 132ms", "Active accounts 248", "Webhook failures 2", "System status Healthy" —
 * plus three progress bars at 94%, 87% and 96% labelled "Infrastructure health",
 * "Driver verification pipeline" and "Payment webhook integrity", and a panel of
 * three "active incidents" describing a Daraja callback failure, a Daraja retry
 * queue overflow and an AI prompt rollback.
 *
 * None of it was measured. Worse, it was actively misleading in a way a plain
 * fake number is not:
 *
 *   - "Webhook failures: 2" described Daraja and Paystack callbacks, but no
 *     payment provider is wired to this application. There is no webhook endpoint,
 *     so the count could never be non-zero and its being 2 was not a coincidence.
 *   - "All services nominal" was hardcoded. It would have read that way through
 *     a total database outage, which is the exact moment it matters.
 *   - "Payment webhook integrity 96%" looked like a measured success rate with no
 *     denominator behind it.
 *
 * ── Why some measurements are reported as unavailable rather than guessed ────
 * RLS policy counts and bucket inventories live in `pg_catalog` and the `storage`
 * schema respectively. Neither is exposed through PostgREST, and a service-role
 * key bypasses RLS but not the schema allowlist, so there is no client-side path
 * to them at all. Rather than substitute a plausible number, this route reports
 * them as unavailable and names the migration that fixes it. See
 * `supabase/migrations/20261005_developer_health_introspection.sql`.
 *
 * ── Why `user_preferences` is labelled `caller`-scoped without the RPC ──────
 * The schema grants a developer NO policy on `user_preferences` — deliberately,
 * since notification preferences are nobody else's business. So a count read
 * through this session's client returns the developer's own row and nothing else.
 * Reporting "1" for a table that holds one row per account would be the most
 * plausible-looking wrong number in the whole panel, so the scope is carried in
 * the payload and rendered as such. With the migration applied the same number
 * becomes `authoritative`.
 *
 * ── Why this uses the caller's own client, never the service-role key ───────
 * `authorizeRole` has already established the caller is a developer; the queries
 * below then run under that developer's own RLS scope. The one measurement that
 * genuinely needs to escape RLS is delegated to the SQL function, which
 * re-checks `is_role('developer')` internally rather than trusting this route.
 */
import { NextResponse } from 'next/server';

import { databaseErrorResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import type {
  ConnectionStatus,
  CountScope,
  DatabaseStatus,
  DeveloperHealthPayload,
  HealthSeverity,
  RlsStatus,
  StorageBucketStatus,
  StorageStatus,
  TableCount,
} from '@/types/developer-health';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['developer'];

/** The buckets the application depends on. Missing any of them is a finding. */
const REQUIRED_BUCKETS = ['driver-credentials', 'driver-docs', 'avatars'] as const;

const MIGRATION_HINT =
  'Run supabase/migrations/20261005_developer_health_introspection.sql in the Supabase SQL editor.';

/**
 * `pg_policies` and `storage.buckets` are not in the exposed-schema list, so
 * PostgREST answers an unknown relation or function with a specific code. That
 * code is how "the migration has not been applied" is distinguished from a real
 * failure — otherwise a first-run health check would report a database outage.
 */
function isMissingIntrospection(error: { code?: string; message?: string } | null): boolean {
  if (!error) {
    return false;
  }

  return error.code === 'PGRST202' || /developer_(rls_policy_counts|storage_inventory|table_counts)/.test(error.message ?? '');
}

type Json = Record<string, unknown>;

/**
 * Unwraps an RPC result into the value the caller actually wants.
 *
 * ── The bug this replaces ──────────────────────────────────────────────────
 * The previous version looked at the first row, and if it had more than one key it
 * returned that single row and threw the rest away. That is correct for
 * `returns jsonb` (one column) and badly wrong for `returns table (...)` (many
 * columns, one row per bucket): the array of three bucket rows collapsed to the
 * first one, `.buckets` was then `undefined`, and the panel reported
 * "disagree on the response shape" and refused to show a correct answer it was
 * already holding.
 *
 * The distinction is the number of keys, not the type of the value:
 *
 *   `[{ developer_table_counts: {...} }]`      one key  -> the jsonb inside
 *   `[{ developer_storage_inventory: [...] }]`  one key  -> the array inside
 *   `[{ bucket_id, object_count, ... }, ...]`   many keys -> a tabular result;
 *                                                       the ARRAY is the answer
 *   `{ anything }`                             not an array -> the object itself
 *   `null`                                     -> null
 *
 * Returns the value un-narrowed on purpose: two of the three functions return an
 * object and one returns an array of rows, and a single return type that lies to
 * one of them is how the shape mismatch happened in the first place.
 */
function unwrapJsonRpc(data: unknown): Json | unknown[] | null {
  let value: unknown = data;

  // PostgREST nests a function's result under its name, so a `returns table`
  // arrives as `[{ fn_name: [row, row] }]`. Descend through that wrapper — but
  // only while the wrapper has exactly one key whose value is a container, so a
  // genuinely single-column tabular row like `{ bucket_id: 'avatars' }` (a string
  // value) is left alone.
  for (let depth = 0; depth < 3; depth += 1) {
    if (!Array.isArray(value)) {
      break;
    }

    const keys = Object.keys(value[0] as Json);

    if (keys.length !== 1) {
      break;
    }

    const inner = (value[0] as Json)[keys[0]];

    if (typeof inner !== 'object' || inner === null) {
      break;
    }

    value = inner;
  }

  if (value === null || value === undefined) {
    return null;
  }

  return Array.isArray(value) || typeof value === 'object' ? (value as Json | unknown[]) : null;
}

/**
 * Reads the first present key from a row.
 *
 * The inventory function has been written against two different shapes over the
 * life of this endpoint — a `jsonb` object keyed `objectCount`/`sizeBytes`, and a
 * `returns table` row keyed `object_count`/`total_bytes`. Rather than pin one and
 * break on the other, each field accepts both spellings. Silently defaulting
 * instead would be worse than either: a missing `object_count` defaulting to 0
 * renders as "this bucket is empty", which is the same lie the count itself was
 * replacing.
 */
function readField(row: Json, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      return row[key];
    }
  }

  return undefined;
}

function readFirstNumber(row: Json, ...keys: string[]): number | null {
  const value = readField(row, ...keys);

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  // Postgres `bigint` arrives as a JSON number, but a count that has been cast to
  // text somewhere in the pipeline arrives as a string. Neither is a reason to
  // drop the figure.
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readFirstBoolean(row: Json, ...keys: string[]): boolean | null {
  const value = readField(row, ...keys);

  if (typeof value === 'boolean') {
    return value;
  }

  // Some clients stringify booleans. 't'/'f' and 'true'/'false' both appear.
  if (value === 't' || value === 'true') {
    return true;
  }

  if (value === 'f' || value === 'false') {
    return false;
  }

  // Deliberately null, never false. See `StorageBucketStatus.isPublic`.
  return null;
}

function readFirstString(row: Json, ...keys: string[]): string | null {
  const value = readField(row, ...keys);

  return typeof value === 'string' && value !== '' ? value : null;
}

function readFirstStringArray(row: Json, ...keys: string[]): string[] | null {
  const value = readField(row, ...keys);

  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null;
}

/**
 * Extracts the array of bucket rows from an already-unwrapped RPC result.
 *
 * Returns `null` only when the shape is genuinely unrecognised, so the caller can
 * report "unavailable" instead of "the project has no buckets" — the
 * available-and-empty reading that would raise three false MISSING-bucket errors
 * and send an operator to fix storage that is fine.
 */
function readBucketRows(value: Json | unknown[] | null): unknown[] | null {
  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value;
  }

  // The `jsonb` object form: `{ buckets: [...] }`.
  if (Array.isArray(value.buckets)) {
    return value.buckets;
  }

  return null;
}

/** Describes a payload for the "we disagree on the shape" message. */
function describeShape(value: Json | unknown[] | null): string {
  if (value === null) {
    return 'nothing';
  }

  if (Array.isArray(value)) {
    return value.length === 0
      ? 'an empty array'
      : `an array of ${value.length} row(s) keyed ${Object.keys(value[0] as Json).join(', ') || '(none)'}`;
  }

  return `an object keyed ${Object.keys(value).join(', ') || '(none)'}`;
}

/**
 * Unwraps a single-column `jsonb` RPC result into a keyed map.
 *
 * A separate entry point from `unwrapJsonRpc` because the three callers want
 * different things: two want a map of named values, and one wants an array of
 * rows. Reusing one function for both is what made the storage parser report a
 * shape mismatch on a well-formed answer.
 */
function unwrapJsonMap(data: unknown): Json | null {
  const unwrapped = unwrapJsonRpc(data);

  if (unwrapped === null || Array.isArray(unwrapped)) {
    return null;
  }

  return unwrapped;
}

/**
 * Tables to count, with the scope a developer actually gets under RLS.
 *
 * `scope` is not a guess — it is the policy that governs it:
 *   profiles             `profiles_developer_bypass`       -> every row
 *   cars                 `developers_manage_all_cars`      -> every row
 *   daily_remittances    `developer_bypass_remittances`    -> every row
 *   user_preferences     owner-only, by design              -> the caller's row
 *
 * `table` is a literal union rather than `string` because `supabase-js` narrows
 * `.from()` to known keys. Widening it to `string` would need the client cast to
 * `any`, which would throw away the type check on every other `.from()` in the
 * codebase along with it.
 */
const COUNT_TARGETS: ReadonlyArray<{
  table: 'profiles' | 'cars' | 'daily_remittances' | 'user_preferences';
  scope: CountScope;
  note: string | null;
}> = [
  { table: 'profiles', scope: 'all', note: null },
  { table: 'cars', scope: 'all', note: null },
  { table: 'daily_remittances', scope: 'all', note: null },
  {
    table: 'user_preferences',
    scope: 'caller',
    note: 'Scoped to your own row: no developer bypass policy exists on user_preferences, and that absence is deliberate.',
  },
];

export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const supabase = auth.supabase;
  const startedAt = performance.now();

  /**
   * The latency probe.
   *
   * A head-count against `profiles` is the closest thing to `SELECT 1` that
   * PostgREST offers: one round trip, `Limit 1`, no rows transferred. It is named
   * in the response so a reader can tell what was actually timed rather than
   * assuming a literal `SELECT 1` ran.
   */
  const probe = supabase.from('profiles').select('id', { head: true, count: 'exact' }).limit(1);
  const probeStartedAt = performance.now();
  const { error: probeError } = await probe;
  const latencyMs = performance.now() - probeStartedAt;

  const database: DatabaseStatus = {
    reachable: probeError === null,
    // `performance.now()` is monotonic, so this cannot go backwards under clock
    // adjustment the way `Date.now()` deltas can.
    latencyMs: probeError === null ? Math.round(latencyMs) : null,
    probe: 'SELECT count(*) FROM profiles (head, Limit 1) via PostgREST',
    error: probeError ? probeError.message : null,
  };

  /**
   * The authoritative counts, when the migration has been applied.
   *
   * A missing function is not an error: it means the route falls back to
   * RLS-scoped counting, which is less accurate for one table but still real
   * data. Failing the whole health check over it would make this panel useless
   * on a project that has not run the migration yet.
   */
  let authoritativeCounts: Json | null = null;
  let introspectionMissing = false;

  try {
    const { data, error } = await supabase.rpc('developer_table_counts');

    if (error) {
      introspectionMissing = isMissingIntrospection(error);
    } else {
      authoritativeCounts = unwrapJsonMap(data);
    }
  } catch {
    introspectionMissing = true;
  }

  const tables: TableCount[] = await Promise.all(
    COUNT_TARGETS.map(async ({ table, scope, note }) => {
      // Prefer the RLS-bypassing function's number when it exists: it is the same
      // figure for every table and it does not depend on which policies happen to
      // be applied today.
      if (authoritativeCounts && typeof authoritativeCounts[table] === 'number') {
        return {
          table,
          count: Number(authoritativeCounts[table]),
          scope: 'authoritative' as const,
          note: null,
          error: null,
        };
      }

      try {
        const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });

        return {
          table,
          // PostgREST returns `count: null` when the count could not be produced
          // at all, which must not become a rendered 0.
          count: typeof count === 'number' ? count : null,
          scope,
          note,
          error: error ? error.message : null,
        };
      } catch (error) {
        return {
          table,
          count: null,
          scope,
          note,
          error: error instanceof Error ? error.message : 'The count query threw.',
        };
      }
    })
  );

  // ── RLS policy count ──────────────────────────────────────────────────────
  //
  // `storage` and `rls` are both declared before this section for a reason that is
  // easy to get wrong: the storage section has an early return that calls
  // `finish()`, and `finish()` reads both. Measuring the policy count first means
  // `rls` is always assigned by the time that path runs, so the shape-mismatch
  // branch reports a complete payload instead of throwing on `rls.available`.
  //
  // `storage` is declared here rather than in its own section purely so it sits
  // beside `rls`; it is still only ever assigned by the storage section.
  let storage: StorageStatus;
  let rls: RlsStatus;
  let connections: ConnectionStatus;

  try {
    const { data, error } = await supabase.rpc('developer_rls_policy_counts');
    const row = error ? null : unwrapJsonMap(data);

    if (error || !row) {
      rls = {
        available: false,
        policyCount: null,
        publicPolicies: null,
        storagePolicies: null,
        reason: error
          ? `${error.message} ${MIGRATION_HINT}`
          : `The policy-count function returned no rows. ${MIGRATION_HINT}`,
      };
    } else {
      rls = {
        available: true,
        policyCount: readFirstNumber(row, 'total'),
        publicPolicies: readFirstNumber(row, 'public'),
        storagePolicies: readFirstNumber(row, 'storage'),
        reason: null,
      };
    }
  } catch (error) {
    rls = {
      available: false,
      policyCount: null,
      publicPolicies: null,
      storagePolicies: null,
      reason: `${error instanceof Error ? error.message : 'The policy count query threw.'} ${MIGRATION_HINT}`,
    };
  }

  // ── Database connections ──────────────────────────────────────────────────
  //
  // `pg_stat_activity` and `pg_settings.max_connections` are `pg_catalog` views and
  // are not in PostgREST's exposed-schema list, so this needs
  // `developer_connection_counts()`. A service-role key would not help: it bypasses
  // RLS but not the schema allowlist.
  //
  // Until that function is applied this reports unavailable with the reason, which
  // is what replaced the Fleet Controls panel's hardcoded "Active sockets: 1,284".
  // That number was not a stale reading — there was never any code that could
  // produce it, so there was nothing to re-measure, only something to stop
  // asserting.
  try {
    const { data, error } = await supabase.rpc('developer_connection_counts');
    const row = error ? null : unwrapJsonMap(data);

    if (error || !row) {
      connections = {
        available: false,
        total: null,
        active: null,
        idle: null,
        maxConnections: null,
        reason: error ? `${error.message} ${MIGRATION_HINT}` : `The connection function returned no rows. ${MIGRATION_HINT}`,
      };
    } else {
      connections = {
        available: true,
        total: readFirstNumber(row, 'total', 'total_connections'),
        active: readFirstNumber(row, 'active'),
        idle: readFirstNumber(row, 'idle'),
        maxConnections: readFirstNumber(row, 'maxConnections', 'max_connections'),
        reason: null,
      };
    }
  } catch (error) {
    connections = {
      available: false,
      total: null,
      active: null,
      idle: null,
      maxConnections: null,
      reason: `${error instanceof Error ? error.message : 'The connection query threw.'} ${MIGRATION_HINT}`,
    };
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  try {
    const { data, error } = await supabase.rpc('developer_storage_inventory');
    const raw: Json | unknown[] | null = error ? null : unwrapJsonRpc(data);

    if (error || !raw) {
      storage = {
        available: false,
        buckets: [],
        missing: [...REQUIRED_BUCKETS],
        reason: error
          ? `${error.message} ${MIGRATION_HINT}`
          : `The storage inventory function returned no rows. ${MIGRATION_HINT}`,
      };
    } else {
      // Accepts both shapes the function has used: a `jsonb` object keyed
      // `objectCount`/`sizeBytes`, and a `returns table` row keyed
      // `bucket_id`/`object_count`/`total_bytes`.
      const bucketList = readBucketRows(raw);

      if (bucketList === null) {
        storage = {
          available: false,
          buckets: [],
          missing: [...REQUIRED_BUCKETS],
          reason: `The storage inventory function returned ${describeShape(raw)} — neither a row array nor an object with a "buckets" key. The function and this route disagree on the response shape.`,
        };

        return finish();
      }

      const buckets: StorageBucketStatus[] = bucketList
        .filter((item): item is Json => typeof item === 'object' && item !== null)
        .map((bucket) => {
          // `bucket_id` is the canonical key; `name` is the older spelling and is
          // kept as an alias because a bucket's id and name are the same string in
          // Supabase, so either one identifies it for the REQUIRED_BUCKETS check.
          const name = readFirstString(bucket, 'bucket_id', 'name', 'id') ?? '';

          return {
            id: name,
            name,
            isPublic: readFirstBoolean(bucket, 'public', 'is_public'),
            fileSizeLimit: readFirstNumber(bucket, 'fileSizeLimit', 'file_size_limit'),
            allowedMimeTypes: readFirstStringArray(bucket, 'allowedMimeTypes', 'allowed_mime_types'),
            objectCount: readFirstNumber(bucket, 'objectCount', 'object_count') ?? 0,
            sizeBytes: readFirstNumber(bucket, 'sizeBytes', 'total_bytes', 'size_bytes') ?? 0,
            updatedAt: readFirstString(bucket, 'updatedAt', 'updated_at'),
          };
        })
        .filter((bucket) => bucket.name !== '');

      const present = new Set(buckets.map((bucket) => bucket.name));

      storage = {
        available: true,
        buckets,
        missing: REQUIRED_BUCKETS.filter((name) => !present.has(name)),
        reason: null,
      };
    }
  } catch (error) {
    storage = {
      available: false,
      buckets: [],
      missing: [...REQUIRED_BUCKETS],
      reason: `${error instanceof Error ? error.message : 'The storage query threw.'} ${MIGRATION_HINT}`,
    };
  }

  // ── Findings ──────────────────────────────────────────────────────────────
  /**
   * Turns whatever has been measured so far into the response.
   *
   * Shared by the normal path and the one early return in the storage section,
   * so those do not each have to re-derive the findings, the overall severity
   * and the payload shape. Deriving them twice is how the two paths drift
   * apart and one of them starts reporting a different health than the other.
   *
   * Declared rather than assigned to a `const` so the storage section can call it
   * above its definition point.
   */
  function finish(): NextResponse {
    // ── Findings ──────────────────────────────────────────────────────────────
    // Only conditions that are actually checked. There is deliberately no
    // "webhook failures" or "replica lag" finding, because neither can be
    // observed: no payment provider is integrated and replica lag is not exposed.
    const findings: DeveloperHealthPayload['findings'] = [];

    if (!database.reachable) {
      findings.push({
        severity: 'error',
        message: `The database did not answer the latency probe: ${database.error ?? 'unknown error'}`,
      });
    } else if (database.latencyMs !== null && database.latencyMs > 1000) {
      findings.push({
        severity: 'warn',
        message: `Database round trip took ${database.latencyMs}ms. Above 1000ms is unusual for a head-count.`,
      });
    }

    for (const table of tables) {
      if (table.error) {
        findings.push({ severity: 'error', message: `Could not count ${table.table}: ${table.error}` });
      } else if (table.count === null) {
        findings.push({
          severity: 'warn',
          message: `${table.table} returned no count. The row count is unknown, not zero.`,
        });
      }
    }

    if (!storage.available) {
      findings.push({
        severity: 'warn',
        message: 'Storage buckets could not be inspected. Driver documents and face photos may be unreachable.',
      });
    } else {
      for (const name of storage.missing) {
        findings.push({
          severity: 'error',
          message: `The "${name}" bucket does not exist. Uploads addressed to it will fail with NoSuchBucket.`,
        });
      }

      // A public bucket is the most serious thing this panel can report: driver
      // national IDs and face photos would be readable by anyone holding the URL.
      for (const bucket of storage.buckets) {
        // `=== true`, not truthiness: `null` means "not reported", and treating it as
        // true would raise a security finding against a bucket that may well be
        // private.
        if (bucket.isPublic === true) {
          findings.push({
            severity: 'error',
            message: `The "${bucket.name}" bucket is PUBLIC. Everything in it is readable by URL without a signature.`,
          });
        }

        if (bucket.allowedMimeTypes !== null && bucket.allowedMimeTypes.length === 0) {
          findings.push({
            severity: 'warn',
            message: `The "${bucket.name}" bucket allows no MIME types, so every upload to it will be rejected.`,
          });
        }
      }
    }

    if (!rls.available) {
      findings.push({
        severity: 'warn',
        message: 'RLS policy count unavailable. This is a visibility gap in the panel, not evidence that policies are missing.',
      });
    } else if (rls.policyCount === 0) {
      findings.push({
        severity: 'error',
        message: 'Zero RLS policies are active. Every table would be world-readable if anon keys are in use.',
      });
    } else if (rls.storagePolicies === 0) {
      findings.push({
        severity: 'error',
        message: 'Zero storage policies are active, so driver documents and face photos are unprotected.',
      });
    }

    if (storage.buckets.some((bucket) => bucket.isPublic === null)) {
      // A coverage gap, not a fault. The inventory function did not report bucket
      // visibility, so this panel cannot confirm that driver documents and face
      // photos are private. Saying nothing would be indistinguishable from having
      // checked and finding them private, which is the failure this panel exists to
      // avoid.
      findings.push({
        severity: 'warn',
        message:
          'The storage inventory did not report bucket visibility, so this check cannot confirm the driver-docs, driver-credentials and avatars buckets are private.',
      });
    }

    if (!connections.available) {
      findings.push({
        severity: 'warn',
        message:
          'Database connection counts are unavailable. pg_stat_activity is not reachable through PostgREST, so connection pressure cannot be observed.',
      });
    } else if (connections.total !== null && connections.maxConnections !== null && connections.maxConnections > 0) {
      // Only computed when there is a real denominator. A ratio needs both ends, and
      // inventing a ceiling would produce a bar that means nothing.
      const usedShare = (connections.total / connections.maxConnections) * 100;

      if (usedShare >= 90) {
        findings.push({
          severity: 'error',
          message: `${connections.total} of ${connections.maxConnections} Postgres connections in use (${usedShare.toFixed(0)}%). New connections will be refused.`,
        });
      } else if (usedShare >= 70) {
        findings.push({
          severity: 'warn',
          message: `${connections.total} of ${connections.maxConnections} Postgres connections in use (${usedShare.toFixed(0)}%).`,
        });
      }
    }

    if (introspectionMissing && storage.available === false) {
      // Both branches already produced findings; this one only notes the shared
      // cause, so an operator is not sent looking for two separate faults.
      findings.push({
        severity: 'warn',
        message: 'Row counts are RLS-scoped and catalog data is unavailable until the introspection migration is applied.',
      });
    }

    const overall: HealthSeverity = findings.some((finding) => finding.severity === 'error')
      ? 'error'
      : findings.length > 0
        ? 'warn'
        : 'ok';

    const payload: DeveloperHealthPayload = {
      checkedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAt),
      database,
      tables,
      storage,
      rls,
      connections,
      overall,
      findings: findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)),
    };

    // A probe failure is the one case that must not look like a healthy 200. The
    // rest are reported inside the payload with their own severity, because a
    // missing bucket is a finding about the project, not a fault in this route.
    if (!database.reachable) {
      return databaseErrorResponse({ message: database.error ?? 'The database probe failed.' }, 'probe Supabase');
    }

    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  }

  return finish();
}
