/**
 * Analytics aggregation for the CEO and Manager dashboards.
 *
 * ── Why one route and not `/api/analytics/ceo` + `/api/analytics/manager` ───
 * Both roles read the same three tables, and RLS grants both roles identical
 * access to all of them (`ceos_manage_all_cars` / `managers_read_company_cars`,
 * `ceo_manage_all_remittances` / `managers_read_all_remittances`,
 * `manager_can_manage_vehicle_maintenance`). Two routes would therefore be
 * byte-identical duplicates with different paths, and a future divergence
 * between them would be invisible. One route, one role list, one aggregation
 * path. Access control is still enforced by `authorizeRole` before any query
 * runs, and again by RLS on every read.
 *
 * ── Why no service-role client ─────────────────────────────────────────────
 * Aggregating "all company revenue" would be convenient via the service-role key,
 * but it would also make this route a full-table read that ignores who is asking.
 * Every query here runs on the caller's own request-scoped client, so the
 * policies above are what actually bound the data.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { badRequestResponse, databaseErrorResponse, firstError } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import {
  AGGREGATE_ROW_CAP,
  buildCollectionPerformance,
  buildDerivedDriverByCar,
  buildDriverAverages,
  buildFleetStatus,
  buildMaintenanceSummary,
  buildRevenueTrend,
  resolveTimeRange,
  type CarRow,
  type MaintenanceRow,
  type RemittanceRow,
  type TimeRange,
} from '@/lib/analytics';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['ceo', 'manager'];

const VALID_RANGES: TimeRange[] = ['7d', '30d', 'ytd'];

export async function GET(request: NextRequest) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const requested = request.nextUrl.searchParams.get('range') ?? '30d';

  if (!VALID_RANGES.includes(requested as TimeRange)) {
    return badRequestResponse(
      `"range" must be one of: ${VALID_RANGES.join(', ')}. Received "${requested}".`
    );
  }

  const range = requested as TimeRange;
  const resolved = resolveTimeRange(range);

  // The three reads are independent, so they are issued together. Each is capped
  // at AGGREGATE_ROW_CAP + 1: fetching one extra row is what makes "exactly at
  // the cap" distinguishable from "truncated", without a second count query.
  const cap = AGGREGATE_ROW_CAP + 1;

  const [remittanceResult, carResult, maintenanceResult, driverResult] = await Promise.all([
    auth.supabase
      .from('daily_remittances')
      .select('id, driver_id, car_id, amount, status, payment_reference, payment_date, created_at')
      .gte('created_at', resolved.start.toISOString())
      .order('created_at', { ascending: true })
      .limit(cap),
    auth.supabase
      .from('cars')
      .select('id, registration_number, model, year, status, daily_rate')
      .order('registration_number', { ascending: true })
      .limit(cap),
    auth.supabase
      .from('vehicle_maintenance')
      .select('id, vehicle_registration, issue_summary, estimated_cost, priority, status, created_at')
      .gte('created_at', resolved.start.toISOString())
      .order('created_at', { ascending: false })
      .limit(cap),
    // Names only, to label the remittance export. No emails, phones or roles:
    // an export is a file that leaves the application's access controls.
    auth.supabase
      .from('profiles')
      .select('id, full_name')
      .eq('role', 'driver')
      .limit(cap),
  ]);

  const queryError = firstError([remittanceResult, carResult, maintenanceResult, driverResult]);

  if (queryError) {
    return databaseErrorResponse(queryError, 'load dashboard analytics');
  }

  const remittanceRows = (remittanceResult.data ?? []) as RemittanceRow[];
  const carRows = (carResult.data ?? []) as CarRow[];
  const maintenanceRows = (maintenanceResult.data ?? []) as MaintenanceRow[];
  const driverRows = (driverResult.data ?? []) as Array<{ id: string; full_name: string | null }>;

  // `cars` is a current-state table, not a historical one: it is not date
  // filtered, so it is capped on its own. Only `truncated` flags the time-series
  // sources, where a missing row would change a total.
  const remittanceTruncated = remittanceRows.length > AGGREGATE_ROW_CAP;
  const maintenanceTruncated = maintenanceRows.length > AGGREGATE_ROW_CAP;
  const carsTruncated = carRows.length > AGGREGATE_ROW_CAP;

  const remittances = remittanceTruncated ? remittanceRows.slice(0, AGGREGATE_ROW_CAP) : remittanceRows;
  const maintenance = maintenanceTruncated
    ? maintenanceRows.slice(0, AGGREGATE_ROW_CAP)
    : maintenanceRows;
  const cars = carsTruncated ? carRows.slice(0, AGGREGATE_ROW_CAP) : carRows;

  const driverNames = new Map(driverRows.map((driver) => [driver.id, driver.full_name]));
  const derivedDriver = buildDerivedDriverByCar(cars, remittances);

  const revenueBuckets = buildRevenueTrend(remittances, resolved);
  const fleetSlices = buildFleetStatus(cars);
  const maintenanceSummary = buildMaintenanceSummary(maintenance);

  const carLabels = new Map(cars.map((car) => [car.id, car.registration_number]));

  return NextResponse.json({
    ok: true,
    range,
    window: {
      start: resolved.start.toISOString(),
      end: resolved.end.toISOString(),
      bucket: resolved.bucket,
    },
    truncated: {
      remittances: remittanceTruncated,
      maintenance: maintenanceTruncated,
      cars: carsTruncated,
      rowCap: AGGREGATE_ROW_CAP,
    },
    revenue: {
      buckets: revenueBuckets,
      collection: buildCollectionPerformance(remittances),
      drivers: buildDriverAverages(remittances),
      /**
       * No target series is returned.
       *
       * The schema has no revenue target: `daily_remittances` carries no target
       * column, and `driver_onboarding_queue.daily_remittance_target` is a
       * per-candidate onboarding field that is null for everyone who did not
       * arrive through the new-driver form. Synthesising a target from
       * `cars.daily_rate` would invent a budget nobody set and draw it on a
       * financial chart as though they had.
       */
      targetAvailable: false,
      targetUnavailableReason:
        'No revenue target is stored in the database, so actual remittances cannot be compared against a target.',
    },
    fleet: {
      slices: fleetSlices,
      total: cars.length,
      /**
       * Sum of `daily_rate` across all vehicles, not just active ones. It is the
       * fleet's bookable value if every vehicle were earning, and is labelled as
       * such in the UI so it is not read as current revenue.
       */
      totalDailyRate: cars.reduce((sum, car) => sum + Number(car.daily_rate ?? 0), 0),
    },
    maintenance: maintenanceSummary,
    exports: {
      remittances: remittances.map((row) => ({
        id: row.id,
        driverId: row.driver_id,
        driverName: driverNames.get(row.driver_id) ?? null,
        vehicleRegistration: carLabels.get(row.car_id) ?? null,
        amount: Number(row.amount ?? 0),
        status: row.status,
        paymentReference: row.payment_reference,
        paymentDate: row.payment_date,
        recordedAt: row.created_at,
      })),
      fleet: cars.map((car) => ({
        id: car.id,
        registrationNumber: car.registration_number,
        model: car.model,
        year: car.year,
        status: car.status,
        dailyRate: Number(car.daily_rate ?? 0),
        /**
         * Derived from the newest remittance filed against this vehicle.
         * Named `derived…` rather than `assignedDriver` because nothing in the
         * database records an assignment — see buildDerivedDriverByCar.
         */
        derivedDriverId: derivedDriver.get(car.id)?.driverId ?? null,
        derivedDriverAt: derivedDriver.get(car.id)?.at ?? null,
      })),
      maintenance: maintenance.map((row) => ({
        id: row.id,
        vehicleRegistration: row.vehicle_registration,
        issueSummary: row.issue_summary,
        estimatedCost: Number(row.estimated_cost ?? 0),
        priority: row.priority,
        status: row.status,
        recordedAt: row.created_at,
      })),
    },
    empty: {
      remittances: remittances.length === 0,
      cars: cars.length === 0,
      maintenance: maintenance.length === 0,
    },
  });
}