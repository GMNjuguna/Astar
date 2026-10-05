/**
 * Analytics aggregation: turns raw table rows into chart and export shapes.
 *
 * Pure functions with no Supabase or React imports, so every rule here can be
 * asserted directly (see the verification notes in the task summary). The API
 * routes only fetch and delegate to this module; no aggregation is duplicated
 * client-side.
 *
 * ── Why totals are summed in JavaScript ────────────────────────────────────
 * PostgREST cannot `sum()` a `numeric` column, and adding an RPC for one
 * aggregate is not worth a migration. Every sum here is therefore computed in
 * JS over the fetched rows, which makes a row cap mandatory: past `AGGREGATE_ROW_CAP`
 * the numbers would be silently wrong. Callers get a `truncated` flag and must
 * surface it rather than presenting a partial total as a complete one.
 */

/** Same cap as lib/ai/tools.ts, for the same reason. */
export const AGGREGATE_ROW_CAP = 5000;

export type TimeRange = '7d' | '30d' | 'ytd';

export const TIME_RANGES: ReadonlyArray<{ value: TimeRange; label: string }> = [
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: 'ytd', label: 'YTD' },
];

export type BucketKind = 'day' | 'week' | 'month';

export type ResolvedRange = {
  range: TimeRange;
  start: Date;
  end: Date;
  bucket: BucketKind;
  /** Number of buckets the axis will contain, including empty ones. */
  bucketCount: number;
};

/**
 * Resolves a range to concrete UTC bounds and a bucket width.
 *
 * Everything is computed in UTC. Using the server's local zone would shift a
 * remittance recorded at 00:30 EAT into the previous bucket on one machine and
 * not another, so the same chart could disagree with the CSV exported from it.
 */
export function resolveTimeRange(range: TimeRange, now: Date = new Date()): ResolvedRange {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999)
  );

  if (range === '7d') {
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    start.setUTCHours(0, 0, 0, 0);

    return { range, start, end, bucket: 'day', bucketCount: 7 };
  }

  if (range === '30d') {
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 29);
    start.setUTCHours(0, 0, 0, 0);

    return { range, start, end, bucket: 'day', bucketCount: 30 };
  }

  // YTD: 1 January to today. Bucketed monthly, so a range covering 18 months
  // yields 18 columns rather than 540 unreadable ones.
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
  const months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - start.getUTCMonth()) +
    1;

  return { range, start, end, bucket: 'month', bucketCount: Math.max(1, months) };
}

/** Start of the ISO week (Monday) containing `date`, in UTC. */
function startOfIsoWeek(date: Date): Date {
  const copy = new Date(date);
  const day = (copy.getUTCDay() + 6) % 7;

  copy.setUTCDate(copy.getUTCDate() - day);
  copy.setUTCHours(0, 0, 0, 0);

  return copy;
}

/**
 * The bucket key a timestamp falls into.
 *
 * Weekly keys are the Monday date rather than a week number, because ISO week
 * numbering resets at the year boundary and `2026-01-01` can belong to week 53
 * of 2025 — which would sort incorrectly as a string.
 */
export function bucketStart(date: Date, kind: BucketKind): Date {
  if (kind === 'day') {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  if (kind === 'week') {
    return startOfIsoWeek(date);
  }

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function advance(date: Date, kind: BucketKind): Date {
  const next = new Date(date);

  if (kind === 'day') {
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (kind === 'week') {
    next.setUTCDate(next.getUTCDate() + 7);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }

  return next;
}

/** Short axis label. Kept terse because 30 buckets have to fit. */
export function bucketLabel(date: Date, kind: BucketKind): string {
  if (kind === 'month') {
    return date.toLocaleDateString('en-KE', { month: 'short', timeZone: 'UTC' });
  }

  return date.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Full label used in the tooltip, where there is room for the year. */
export function bucketFullLabel(date: Date, kind: BucketKind): string {
  if (kind === 'month') {
    return date.toLocaleDateString('en-KE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  if (kind === 'week') {
    return `Week of ${date.toLocaleDateString('en-KE', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })}`;
  }

  return date.toLocaleDateString('en-KE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// ── Row shapes (only the columns the analytics actually read) ───────────────

export type RemittanceRow = {
  id: string;
  driver_id: string;
  car_id: string;
  amount: number | string | null;
  status: 'pending' | 'paid' | 'overdue';
  payment_reference: string | null;
  payment_date: string | null;
  created_at: string;
};

export type CarRow = {
  id: string;
  registration_number: string;
  model: string;
  year: number;
  status: 'active' | 'servicing' | 'inactive';
  daily_rate: number | string | null;
};

export type MaintenanceRow = {
  id: string;
  vehicle_registration: string;
  issue_summary: string;
  estimated_cost: number | string | null;
  priority: 'high' | 'medium' | 'low';
  status: 'open' | 'scheduled' | 'completed';
  created_at: string;
};

export function toNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    // PostgREST returns `numeric` as a string, sometimes quoted.
    const parsed = Number(value.replace(/,/g, ''));

    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

// ── Revenue ─────────────────────────────────────────────────────────────────

export type RevenueBucket = {
  key: string;
  label: string;
  fullLabel: string;
  start: string;
  /** Amount on remittances marked paid. */
  collected: number;
  /** Amount billed regardless of status — pending and overdue included. */
  billed: number;
  entries: number;
  drivers: number;
  overdue: number;
};

/**
 * Builds the revenue trend, including empty buckets.
 *
 * Empty buckets are emitted rather than skipped because a line chart that
 * silently joins two weeks apart is visually indistinguishable from a chart of
 * two weeks that genuinely had no activity. A zero reads as zero.
 *
 * `created_at` is the date axis, not `payment_date`: `payment_date` is nullable
 * and is null for every unpaid remittance, so bucketing on it would move
 * outstanding money out of the period entirely and understate revenue.
 */
export function buildRevenueTrend(
  rows: RemittanceRow[],
  resolved: ResolvedRange
): RevenueBucket[] {
  const buckets: RevenueBucket[] = [];
  const index = new Map<string, RevenueBucket>();

  for (let cursor = new Date(resolved.start); cursor <= resolved.end; cursor = advance(cursor, resolved.bucket)) {
    const bucket: RevenueBucket = {
      key: cursor.toISOString().slice(0, 10),
      label: bucketLabel(cursor, resolved.bucket),
      fullLabel: bucketFullLabel(cursor, resolved.bucket),
      start: cursor.toISOString(),
      collected: 0,
      billed: 0,
      entries: 0,
      drivers: 0,
      overdue: 0,
    };

    buckets.push(bucket);
    index.set(bucket.key, bucket);
  }

  const driverSets = new Map<string, Set<string>>();

  for (const row of rows) {
    const at = new Date(row.created_at);

    if (Number.isNaN(at.getTime())) {
      continue;
    }

    const key = bucketStart(at, resolved.bucket).toISOString().slice(0, 10);
    const bucket = index.get(key);

    if (!bucket) {
      // Outside the resolved window, which can happen for a YTD range if the
      // database clock is ahead of the request. Skipped rather than clamped
      // into the nearest bucket, which would invent a data point.
      continue;
    }

    const amount = toNumber(row.amount);

    bucket.billed += amount;
    bucket.entries += 1;

    if (row.status === 'paid') {
      bucket.collected += amount;
    } else if (row.status === 'overdue') {
      bucket.overdue += amount;
    }

    const drivers = driverSets.get(key);

    if (drivers) {
      drivers.add(row.driver_id);
    } else {
      driverSets.set(key, new Set([row.driver_id]));
    }
  }

  for (const bucket of buckets) {
    bucket.drivers = driverSets.get(bucket.key)?.size ?? 0;
  }

  return buckets;
}

export type CollectionPerformance = {
  billed: number;
  collected: number;
  pending: number;
  overdue: number;
  /** Collected / billed as a percentage, or null when nothing was billed. */
  collectionRate: number | null;
  paidEntries: number;
  overdueEntries: number;
  entries: number;
};

export function buildCollectionPerformance(rows: RemittanceRow[]): CollectionPerformance {
  let billed = 0;
  let collected = 0;
  let pending = 0;
  let overdue = 0;
  let paidEntries = 0;
  let overdueEntries = 0;

  for (const row of rows) {
    const amount = toNumber(row.amount);

    billed += amount;

    if (row.status === 'paid') {
      collected += amount;
      paidEntries += 1;
    } else if (row.status === 'overdue') {
      overdue += amount;
      overdueEntries += 1;
    } else {
      pending += amount;
    }
  }

  return {
    billed,
    collected,
    pending,
    overdue,
    // Null rather than 0 when nothing was billed: "0% collection rate" reads as
    // a failure, when the truthful statement is that there is nothing to collect.
    collectionRate: billed > 0 ? (collected / billed) * 100 : null,
    paidEntries,
    overdueEntries,
    entries: rows.length,
  };
}

export type DriverAverages = {
  /** Distinct drivers with at least one remittance in the window. */
  activeDrivers: number;
  totalBilled: number;
  averagePerDriver: number | null;
  averagePerEntry: number | null;
};

/**
 * Average earnings per driver.
 *
 * "Active driver" is defined here as a driver with at least one remittance in
 * the selected window. It is deliberately not derived from `profiles.status`,
 * which exists but is unpopulated for every account created before this column
 * was added, so a status-based count would report zero drivers on a database
 * that plainly has remitters.
 */
export function buildDriverAverages(rows: RemittanceRow[]): DriverAverages {
  const drivers = new Set<string>();
  let total = 0;

  for (const row of rows) {
    drivers.add(row.driver_id);
    total += toNumber(row.amount);
  }

  const count = drivers.size;

  return {
    activeDrivers: count,
    totalBilled: total,
    averagePerDriver: count > 0 ? total / count : null,
    averagePerEntry: rows.length > 0 ? total / rows.length : null,
  };
}

// ── Fleet ───────────────────────────────────────────────────────────────────

export type FleetSlice = {
  status: CarRow['status'];
  label: string;
  count: number;
  share: number;
};

/**
 * Vehicle availability, by the statuses that actually exist.
 *
 * The schema's `car_status` enum has exactly three values: active, servicing and
 * inactive. There is no `idle` and no `decommissioned` — an "idle" vehicle is
 * recorded as `inactive`, and nothing distinguishes one from a written-off one.
 * Buckets are therefore the three real values. Inventing two more would mean
 * splitting a single enum value by some rule the database does not record, and
 * the split would be indistinguishable from noise.
 */
export function buildFleetStatus(cars: CarRow[]): FleetSlice[] {
  const labels: Record<CarRow['status'], string> = {
    active: 'In service',
    servicing: 'In maintenance',
    inactive: 'Idle / out of service',
  };

  const order: CarRow['status'][] = ['active', 'servicing', 'inactive'];
  const counts = new Map<CarRow['status'], number>();

  for (const car of cars) {
    counts.set(car.status, (counts.get(car.status) ?? 0) + 1);
  }

  const total = cars.length;

  return order.map((status) => {
    const count = counts.get(status) ?? 0;

    return {
      status,
      label: labels[status],
      count,
      share: total > 0 ? (count / total) * 100 : 0,
    };
  });
}

// ── Maintenance ─────────────────────────────────────────────────────────────

export type MaintenanceGroup = {
  key: string;
  count: number;
  totalEstimated: number;
};

export type RecurringRepair = {
  vehicleRegistration: string;
  occurrences: number;
  totalEstimated: number;
  /** Share of all maintenance records for this vehicle. */
  share: number;
};

export type MaintenanceSummary = {
  records: number;
  totalEstimated: number;
  openRecords: number;
  byVehicle: MaintenanceGroup[];
  byPriority: MaintenanceGroup[];
  byStatus: MaintenanceGroup[];
  /** Vehicles with more than one record — the "recurring" signal. */
  recurring: RecurringRepair[];
  highestSingleEstimate: number;
};

/**
 * Maintenance cost roll-up.
 *
 * Every figure is from `estimated_cost`. There is no actual-cost column in the
 * schema, so calling any of this "spend" would overstate certainty — these are
 * quotes for work that may not have been done, and open records are estimates
 * for work that definitively has not happened.
 */
export function buildMaintenanceSummary(rows: MaintenanceRow[]): MaintenanceSummary {
  const byVehicle = new Map<string, { count: number; total: number }>();
  const byPriority = new Map<string, { count: number; total: number }>();
  const byStatus = new Map<string, { count: number; total: number }>();

  let totalEstimated = 0;
  let openRecords = 0;
  let highestSingleEstimate = 0;

  for (const row of rows) {
    const cost = toNumber(row.estimated_cost);

    totalEstimated += cost;
    highestSingleEstimate = Math.max(highestSingleEstimate, cost);

    if (row.status !== 'completed') {
      openRecords += 1;
    }

    const bump = (map: Map<string, { count: number; total: number }>, key: string) => {
      const current = map.get(key);

      if (current) {
        current.count += 1;
        current.total += cost;
      } else {
        map.set(key, { count: 1, total: cost });
      }
    };

    // Free text as written, trimmed. `issue_summary` is the only description
    // the schema stores; there is no service-type column to group by.
    bump(byVehicle, row.vehicle_registration.trim() || 'Unspecified vehicle');
    bump(byPriority, row.priority);
    bump(byStatus, row.status);
  }

  const toGroups = (map: Map<string, { count: number; total: number }>): MaintenanceGroup[] =>
    [...map.entries()]
      .map(([key, value]) => ({ key, count: value.count, totalEstimated: value.total }))
      .sort((a, b) => b.totalEstimated - a.totalEstimated || a.key.localeCompare(b.key));

  const totalRecords = rows.length;

  return {
    records: rows.length,
    totalEstimated,
    openRecords,
    byVehicle: toGroups(byVehicle),
    byPriority: toGroups(byPriority),
    byStatus: toGroups(byStatus),
    recurring: [...byVehicle.entries()]
      .filter(([, value]) => value.count > 1)
      .map(([key, value]) => ({
        vehicleRegistration: key,
        occurrences: value.count,
        totalEstimated: value.total,
        share: totalRecords > 0 ? (value.count / totalRecords) * 100 : 0,
      }))
      .sort((a, b) => b.occurrences - a.occurrences || b.totalEstimated - a.totalEstimated),
    highestSingleEstimate,
  };
}

/**
 * The vehicle with the most recent remittance against it, per car.
 *
 * `cars` has no `driver_id` and nothing anywhere links a driver to a vehicle
 * except `daily_remittances.car_id`. A driver is therefore inferred from the most
 * recent remittance filed against that vehicle — which reflects who most recently
 * used it, not who is contractually assigned. The export column is named to say
 * so, and this must not be presented as an assignment record.
 */
export function buildDerivedDriverByCar(
  cars: CarRow[],
  remittances: RemittanceRow[]
): Map<string, { driverId: string; at: string }> {
  const latest = new Map<string, { driverId: string; at: string }>();

  for (const row of remittances) {
    const at = new Date(row.created_at);

    if (Number.isNaN(at.getTime())) {
      continue;
    }

    const existing = latest.get(row.car_id);

    if (!existing || at.getTime() > new Date(existing.at).getTime()) {
      latest.set(row.car_id, { driverId: row.driver_id, at: row.created_at });
    }
  }

  // `cars` is accepted so the caller can be sure every returned key is a real
  // vehicle; entries for cars outside the caller's RLS scope are dropped.
  const known = new Set(cars.map((car) => car.id));
  const result = new Map<string, { driverId: string; at: string }>();

  for (const [carId, value] of latest) {
    if (known.has(carId)) {
      result.set(carId, value);
    }
  }

  return result;
}