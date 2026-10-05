/**
 * Fleet listing and vehicle creation.
 *
 * ── Why the roles are manager + ceo + developer ─────────────────────────────
 * The fleet is operational data that all three roles legitimately need to see and
 * correct. The previous `['manager']` meant a CEO or developer opening this page
 * got a 403 rather than a read-only view, which is the wrong outcome: a founder
 * who cannot see the fleet will assume it is broken rather than that it is
 * restricted. Every write is additionally gated by an RLS policy on `cars`, so
 * this list is a convenience, not the security boundary.
 *
 * ── Why maintenance is joined in application code ───────────────────────────
 * `vehicle_maintenance.vehicle_registration` is free text with no foreign key to
 * `cars`. Rows written by hand or by the older maintenance-only POST used
 * whatever spacing the operator typed, so a PostgREST embed on
 * `cars.registration_number = vehicle_maintenance.vehicle_registration` would
 * silently drop every row whose spelling differs. Both sides are normalised
 * through {@link normalizeRegistrationNumber} before comparison, which matches
 * legacy rows written as `kda123a` too.
 *
 * ── Why the assigned driver is derived, not stored ──────────────────────────
 * `cars` has no `assigned_driver_id`. The only place the pairing exists is
 * `daily_remittances`, which records a driver remitting against a specific car.
 * The most recent remittance per car is therefore the best available signal for
 * who is currently driving it. It is a derivation and is labelled as one in the
 * UI, because no column in the schema states it.
 */
import { NextResponse } from 'next/server';

import {
  badRequestResponse,
  databaseErrorResponse,
  firstError,
  notFoundResponse,
  unexpectedErrorResponse,
} from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import { normalizeRegistrationNumber, validateVehicleInput } from '@/lib/vehicles';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['manager', 'ceo', 'developer'];

type CarRow = {
  id: string;
  registration_number: string;
  model: string;
  year: number;
  status: 'active' | 'servicing' | 'inactive';
  daily_rate: number;
  created_at: string;
};

type RemittanceRow = {
  car_id: string;
  driver_id: string;
  status: 'pending' | 'paid' | 'overdue';
  amount: number;
  created_at: string;
};

type MaintenanceRow = {
  id: string;
  vehicle_registration: string;
  issue_summary: string;
  estimated_cost: number;
  priority: 'high' | 'medium' | 'low';
  status: 'open' | 'scheduled' | 'completed';
  created_at: string;
};

export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const [carsResult, remittancesResult, maintenanceResult] = await Promise.all([
      auth.supabase
        .from('cars')
        .select('id, registration_number, model, year, status, daily_rate, created_at')
        .order('registration_number', { ascending: true }),
      // Newest first so the first row seen for a car is the current assignment.
      auth.supabase
        .from('daily_remittances')
        .select('car_id, driver_id, status, amount, created_at')
        .order('created_at', { ascending: false })
        .limit(500),
      auth.supabase
        .from('vehicle_maintenance')
        .select(
          'id, vehicle_registration, issue_summary, estimated_cost, priority, status, created_at'
        )
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    const queryError = firstError([carsResult, remittancesResult, maintenanceResult]);

    if (queryError) {
      return databaseErrorResponse(queryError, 'load the fleet');
    }

    const cars = (carsResult.data ?? []) as CarRow[];
    const remittances = (remittancesResult.data ?? []) as RemittanceRow[];
    const maintenance = (maintenanceResult.data ?? []) as MaintenanceRow[];

    // --- derived: current driver per car ---
    const currentDriverByCar = new Map<string, RemittanceRow>();

    for (const row of remittances) {
      if (!currentDriverByCar.has(row.car_id)) {
        currentDriverByCar.set(row.car_id, row);
      }
    }

    // One extra query for the names, rather than a nested embed per remittance
    // row: the driver ids come from a derived set, so there is no single parent
    // column to embed against.
    const driverIds = [...new Set([...currentDriverByCar.values()].map((row) => row.driver_id))];
    const driversById = new Map<string, { full_name: string | null; phone: string | null }>();

    if (driverIds.length > 0) {
      const { data: driverRows, error: driverError } = await auth.supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', driverIds);

      if (driverError) {
        return databaseErrorResponse(driverError, 'load assigned drivers');
      }

      for (const row of (driverRows ?? []) as Array<{
        id: string;
        full_name: string | null;
        phone: string | null;
      }>) {
        driversById.set(row.id, { full_name: row.full_name, phone: row.phone });
      }
    }

    // --- derived: maintenance per car, matched on the normalised plate ---
    const maintenanceByRegistration = new Map<string, MaintenanceRow[]>();

    for (const row of maintenance) {
      const key = normalizeRegistrationNumber(row.vehicle_registration);

      const existing = maintenanceByRegistration.get(key);
      if (existing) {
        existing.push(row);
      } else {
        maintenanceByRegistration.set(key, [row]);
      }
    }

    const vehicles = cars.map((car) => {
      const assignment = currentDriverByCar.get(car.id);
      const driver = assignment ? driversById.get(assignment.driver_id) : undefined;
      const logs = maintenanceByRegistration.get(normalizeRegistrationNumber(car.registration_number)) ?? [];
      const openLogs = logs.filter((log) => log.status !== 'completed');

      return {
        id: car.id,
        registrationNumber: car.registration_number,
        model: car.model,
        year: car.year,
        status: car.status,
        dailyRate: Number(car.daily_rate ?? 0),
        createdAt: car.created_at,
        assignedDriver: assignment
          ? {
              id: assignment.driver_id,
              fullName: driver?.full_name ?? null,
              phone: driver?.phone ?? null,
              /** From the most recent remittance, not from a column. */
              since: assignment.created_at,
              lastRemittanceStatus: assignment.status,
              lastRemittanceAmount: Number(assignment.amount ?? 0),
            }
          : null,
        maintenance: {
          /** Unfiltered, newest first -- the full log, not just what is open. */
          logs,
          openCount: openLogs.length,
          /** Total of open work only. Completed work is history, not a liability. */
          openEstimatedCost: openLogs.reduce((sum, log) => sum + Number(log.estimated_cost ?? 0), 0),
        },
      };
    });

    const summary = {
      total: vehicles.length,
      active: vehicles.filter((vehicle) => vehicle.status === 'active').length,
      servicing: vehicles.filter((vehicle) => vehicle.status === 'servicing').length,
      inactive: vehicles.filter((vehicle) => vehicle.status === 'inactive').length,
      unassigned: vehicles.filter((vehicle) => vehicle.assignedDriver === null).length,
      openMaintenance: vehicles.reduce((sum, vehicle) => sum + vehicle.maintenance.openCount, 0),
    };

    return NextResponse.json({
      ok: true,
      vehicles,
      summary,
      /**
       * Distinguishes "no vehicles yet" from "the list failed to load", which a
       * bare empty array cannot express.
       */
      empty: { vehicles: vehicles.length === 0 },
    });
  } catch {
    return unexpectedErrorResponse('load the fleet');
  }
}

/**
 * Creates a vehicle.
 *
 * `company_id` is deliberately not sent. The column is nullable and has never
 * been populated -- there is no `companies` table and no code that reads it --
 * so sending a fabricated uuid would look like real tenancy data in the table
 * and make a later migration harder. See the `cars` table comment in
 * baseline.sql section 2.
 */
export async function POST(request: Request) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  let body: Record<string, unknown>;

  try {
    const parsed: unknown = await request.json();

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return badRequestResponse('Send a JSON object with the vehicle details.');
    }

    body = parsed as Record<string, unknown>;
  } catch {
    return badRequestResponse('Send a JSON object with the vehicle details.');
  }

  const validation = validateVehicleInput(body);

  if (!validation.ok) {
    return NextResponse.json(
      { ok: false, error: 'invalid_vehicle', message: 'Check the highlighted fields.', errors: validation.errors },
      { status: 400 }
    );
  }

  // Checked before insert so the manager gets "that plate is already on the
  // fleet" pointed at the field, rather than a raw Postgres 23505 whose text
  // ("duplicate key value violates unique constraint cars_registration_number_key")
  // says nothing about which of their own values collided. Compared against the
  // normalised form, because the unique index is on the raw column and
  // normalisation is what keeps one physical plate from being entered twice.
  const registrationNumber = validation.value.registration_number as string;
  const { data: existing, error: lookupError } = await auth.supabase
    .from('cars')
    .select('id, registration_number')
    .limit(500);

  if (lookupError) {
    return databaseErrorResponse(lookupError, 'check for a duplicate registration number');
  }

  const clash = ((existing ?? []) as Array<{ id: string; registration_number: string }>).find(
    (row) => normalizeRegistrationNumber(row.registration_number) === registrationNumber
  );

  if (clash) {
    return NextResponse.json(
      {
        ok: false,
        error: 'duplicate_registration',
        message: `${registrationNumber} is already on the fleet.`,
        errors: { registrationNumber: `${registrationNumber} is already in the fleet.` },
      },
      { status: 409 }
    );
  }

  const { data, error } = await auth.supabase
    .from('cars')
    .insert({
      registration_number: registrationNumber,
      model: validation.value.model as string,
      year: validation.value.year as number,
      daily_rate: validation.value.daily_rate as number,
      status: validation.value.status,
    })
    .select('id, registration_number, model, year, status, daily_rate, created_at')
    .single();

  if (error) {
    // A 23505 here means the duplicate slipped past the check above -- a
    // concurrent insert, or a spelling that normalises differently than expected.
    // Reported as a conflict rather than a generic failure for the same reason.
    if (/23505|duplicate key/i.test(`${(error as { code?: string }).code ?? ''} ${error.message}`)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'duplicate_registration',
          message: `${registrationNumber} is already on the fleet.`,
          errors: { registrationNumber: `${registrationNumber} is already in the fleet.` },
        },
        { status: 409 }
      );
    }

    return databaseErrorResponse(error, 'create vehicle');
  }

  if (!data) {
    return notFoundResponse('The vehicle could not be read back after being created.');
  }

  const created = data as CarRow;

  return NextResponse.json(
    {
      ok: true,
      vehicle: {
        id: created.id,
        registrationNumber: created.registration_number,
        model: created.model,
        year: created.year,
        status: created.status,
        dailyRate: Number(created.daily_rate ?? 0),
        createdAt: created.created_at,
        assignedDriver: null,
        maintenance: { logs: [], openCount: 0, openEstimatedCost: 0 },
      },
    },
    { status: 201 }
  );
}