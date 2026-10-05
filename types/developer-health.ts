/**
 * Response shapes for the Developer System Portal's live health endpoints.
 *
 * ── Why `unavailable` exists rather than a null ─────────────────────────────
 * Three of the things this portal is asked to report are not reachable through
 * PostgREST at any privilege level: `pg_policies` is a `pg_catalog` view, and
 * `storage.buckets` / `storage.objects` live in the `storage` schema, neither of
 * which is in the exposed-schema list. A service-role key bypasses RLS but not
 * the schema allowlist, so there is no client-side way around it.
 *
 * The honest options are therefore "report it" or "say it cannot be reported".
 * A bare `null` is not enough, because `null` reads as a bug rather than as a
 * design constraint, and a `0` would be a lie -- zero policies and "could not
 * count the policies" are opposites, and an operator acting on the first would
 * conclude their data is unprotected. So every optional measurement carries the
 * reason it is missing and, where a specific migration fixes it, the name of
 * that migration.
 */

/** Whether a number covers the whole table or only rows the caller can see. */
export type CountScope =
  /** RLS grants the developer every row, so this is the true count. */
  | 'all'
  /**
   * RLS limits the caller to their own rows, so this is NOT the table's size.
   * Rendering it without this flag would report "1" for a table holding 200.
   */
  | 'caller'
  /** Bypassed RLS by `developer_table_counts()`, so authoritative. */
  | 'authoritative';

export type TableCount = {
  table: string;
  count: number | null;
  scope: CountScope;
  /** Why this is scoped rather than total. Null when `scope` is authoritative. */
  note: string | null;
  /** Set when the count could not be read at all. */
  error: string | null;
};

export type StorageBucketStatus = {
  id: string;
  name: string;
  /**
   * Whether the bucket is publicly readable, or `null` when the inventory did not
   * report it.
   *
   * `null` is load-bearing, not a placeholder. Every bucket in this schema must be
   * private, and a `true` here means driver documents and face photos are world
   * readable by URL — the most serious finding this panel can report. That makes
   * the *absence* of the field dangerous: an inventory that reports only
   * `bucket_id`, `object_count` and `total_bytes` would coerce to `false` and the
   * panel would print "private" beside every bucket, confidently asserting a
   * security property it had not checked. Unknown must render as unknown.
   */
  isPublic: boolean | null;
  /** Per-file cap in bytes, or null when unreported or unlimited. */
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
  objectCount: number;
  sizeBytes: number;
  updatedAt: string | null;
};

export type StorageStatus = {
  /** False when Storage could not be inspected at all. */
  available: boolean;
  buckets: StorageBucketStatus[];
  /** Named buckets the application requires, which were not found. */
  missing: string[];
  /**
   * Present when `available` is false. Says which migration to run, because
   * "storage unavailable" with no next step is the least actionable state an
   * operational panel can be in.
   */
  reason: string | null;
};

export type RlsStatus = {
  available: boolean;
  policyCount: number | null;
  /** Counts split by schema, so a storage-policy drop is distinguishable. */
  publicPolicies: number | null;
  storagePolicies: number | null;
  reason: string | null;
};

export type DatabaseStatus = {
  reachable: boolean;
  /**
   * Round-trip milliseconds for a real query, measured with `performance.now()`
   * around the awaited call. Null when the probe threw, in which case
   * `reachable` is false.
   */
  latencyMs: number | null;
  /**
   * What was actually timed. A head-count against `profiles` is not literally
   * `SELECT 1`, and naming the query is what lets an operator tell a healthy 8ms
   * from a healthy 8ms on a query that scans nothing.
   */
  probe: string;
  error: string | null;
};

export type HealthSeverity = 'ok' | 'warn' | 'error';

/**
 * Postgres backend connection counts, read from `pg_stat_activity`.
 *
 * ── Why this needs an RPC and is reported as unavailable until one runs ──────
 * `pg_stat_activity` and `pg_settings` are `pg_catalog` views. Neither is in
 * PostgREST's exposed-schema list, so there is no `.from('pg_stat_activity')` at
 * any privilege level. This is the reason the Fleet Controls panel cannot show a
 * live connection count today, and the reason it shows "not observable" instead of
 * the 1,284 it used to.
 *
 * ── Why this is the one telemetry gauge worth a bar ──────────────────────────
 * `max_connections` is a real ceiling and a real denominator: approaching it is
 * how a Supabase project actually falls over, and PostgREST surfaces that as a
 * connection-timeout error rather than as anything a reader could diagnose from
 * the error text. Connection count is therefore a genuine ratio, unlike row counts
 * or bucket bytes, which have no target in this schema and so get figures rather
 * than bars.
 */
export type ConnectionStatus = {
  available: boolean;
  /** Every backend, including the one running this query. */
  total: number | null;
  /** Backends whose `state` is `active`. */
  active: number | null;
  /** Backends whose `state` is `idle`. */
  idle: number | null;
  /** From `pg_settings.max_connections`. The denominator for the bar. */
  maxConnections: number | null;
  reason: string | null;
};

export type DeveloperHealthPayload = {
  checkedAt: string;
  /** How long the whole check took, so a slow panel is explicable. */
  durationMs: number;
  database: DatabaseStatus;
  tables: TableCount[];
  storage: StorageStatus;
  rls: RlsStatus;
  connections: ConnectionStatus;
  /** Worst severity across every check. Drives the header badge. */
  overall: HealthSeverity;
  /** Human-readable findings, worst first. Empty when nothing is wrong. */
  findings: Array<{ severity: HealthSeverity; message: string }>;
};

export type LogSeverity = 'INFO' | 'WARN' | 'ERROR';

export type SystemLogEntry = {
  id: string;
  timestamp: string;
  /** The table or subsystem the event was read from. */
  source: string;
  severity: LogSeverity;
  message: string;
  /** Real columns from the row that produced this entry. Never invented. */
  payload: Record<string, unknown>;
  /**
   * Measured round-trip for the query that produced this source's rows, in ms.
   * Null when it was not separately measured.
   */
  queryLatencyMs: number | null;
};

export type DeveloperLogsPayload = {
  logs: SystemLogEntry[];
  /** Sources actually queried, with their measured latency. */
  sources: Array<{ name: string; latencyMs: number; rows: number }>;
  checkedAt: string;
  /**
   * Always true. There is no audit-log table in this schema, so these entries are
   * derived from row timestamps rather than read from an event log, and the UI
   * says so. Kept as a field so a future real log table can flip it without a
   * breaking change.
   */
  derivedFromRowTimestamps: true;
};