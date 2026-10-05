/**
 * Single-vehicle update and deletion.
 *
 * Split from `app/api/manager/vehicles/route.ts` so the list route stays a list
 * route, and so the destructive path has its own file -- the difference in care
 * between "edit a rate" and "delete a vehicle" is worth making visible.
 *
 * ── Why DELETE is refused for a vehicle with remittances ────────────────────
 * `daily_remittances.car_id` is `on delete cascade`. Deleting a car that has
 * remittance history therefore does not fail and does not warn -- it silently
 * destroys the driver's payment record, and those rows are the evidence a
 * remittance dispute is settled with. RLS cannot prevent this: by the time the
 * DELETE is authorised the dependent rows are already going. So the check is here,
 * before the statement is issued, and the error names the blocker so the manager
 * knows what to do about it (set the car to `inactive` instead).
 */
import { NextResponse } from 'next/server';

import {
  badRequestResponse,
  databaseErrorResponse,
  notFoundResponse,
  unexpectedErrorResponse,
} from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import { normalizeRegistrationNumber, validateVehicleInput } from '@/lib/vehicles';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['manager', 'ceo', 'developer'];

/**
 * Shape check before the id reaches PostgREST.
 *
 * A malformed uuid makes the driver return a 22P02 invalid-input error, which
 * `databaseErrorResponse` would classify as a 503 -- telling the caller the
 * database is broken when the real problem is their request. Rejecting it here
 * keeps the status codes meaningful.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, context: { params: { id: string } }) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const { id } = context.params;

  if (!UUID_SHAPE.test(id)) {
    return badRequestResponse('That vehicle id is not valid.');
  }

  let body: Record<string, unknown>;

  try {
    const parsed: unknown = await request.json();

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return badRequestResponse('Send a JSON object with the fields to change.');
    }

    body = parsed as Record<string, unknown>;
  } catch {
    return badRequestResponse('Send a JSON object with the fields to change.');
  }

  // `partial: true`, so a status-only change does not have to resend the model
  // and rate -- and, more importantly, so absent fields are omitted from the
  // update rather than sent as null.
  const validation = validateVehicleInput(body, { partial: true });

  if (!validation.ok) {
    return NextResponse.json(
      { ok: false, error: 'invalid_vehicle', message: 'Check the highlighted fields.', errors: validation.errors },
      { status: 400 }
    );
  }

  if (Object.keys(validation.value).length === 0) {
    return badRequestResponse('No recognised fields to update. Send at least one of: status, daily_rate, model, year, registration_number.');
  }

  // Changing the plate needs the same duplicate check as creating, for the same
  // reason: the unique index is on the raw column, and two spellings of one
  // physical plate would otherwise be allowed.
  if (validation.value.registration_number) {
    const nextRegistration = validation.value.registration_number;
    const { data: existing, error: lookupError } = await auth.supabase
      .from('cars')
      .select('id, registration_number')
      .neq('id', id)
      .limit(500);

    if (lookupError) {
      return databaseErrorResponse(lookupError, 'check for a duplicate registration number');
    }

    const clash = ((existing ?? []) as Array<{ id: string; registration_number: string }>).find(
      (row) => normalizeRegistrationNumber(row.registration_number) === nextRegistration
    );

    if (clash) {
      return NextResponse.json(
        {
          ok: false,
          error: 'duplicate_registration',
          message: `${nextRegistration} is already on the fleet.`,
          errors: { registrationNumber: `${nextRegistration} is already in the fleet.` },
        },
        { status: 409 }
      );
    }
  }

  const { data, error } = await auth.supabase
    .from('cars')
    .update(validation.value)
    .eq('id', id)
    .select('id, registration_number, model, year, status, daily_rate, created_at')
    .maybeSingle();

  if (error) {
    return databaseErrorResponse(error, 'update vehicle');
  }

  if (!data) {
    // Either the id does not exist, or it exists and this caller's roles cannot
    // update it. Both are reported the same way on purpose: distinguishing them
    // would confirm the existence of a row the caller is not allowed to see.
    return notFoundResponse('That vehicle does not exist, or you do not have permission to change it.');
  }

  const updated = data as {
    id: string;
    registration_number: string;
    model: string;
    year: number;
    status: 'active' | 'servicing' | 'inactive';
    daily_rate: number;
    created_at: string;
  };

  return NextResponse.json({
    ok: true,
    vehicle: {
      id: updated.id,
      registrationNumber: updated.registration_number,
      model: updated.model,
      year: updated.year,
      status: updated.status,
      dailyRate: Number(updated.daily_rate ?? 0),
      createdAt: updated.created_at,
    },
    /** Lets the page confirm what actually changed without refetching the list. */
    changed: Object.keys(validation.value),
  });
}

export async function DELETE(_request: Request, context: { params: { id: string } }) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const { id } = context.params;

  if (!UUID_SHAPE.test(id)) {
    return badRequestResponse('That vehicle id is not valid.');
  }

  // Confirm the car exists and is visible before counting its dependents, so a
  // bad id does not come back as "this car has remittances".
  const { data: car, error: carError } = await auth.supabase
    .from('cars')
    .select('id, registration_number')
    .eq('id', id)
    .maybeSingle();

  if (carError) {
    return databaseErrorResponse(carError, 'load vehicle');
  }

  if (!car) {
    return notFoundResponse('That vehicle does not exist.');
  }

  // ── the dependency check ──
  const { count, error: countError } = await auth.supabase
    .from('daily_remittances')
    .select('id', { count: 'exact', head: true })
    .eq('car_id', id);

  if (countError) {
    return databaseErrorResponse(countError, 'check vehicle remittance history');
  }

  if ((count ?? 0) > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: 'vehicle_has_remittances',
        message: `${car.registration_number} has ${count} remittance ${
          count === 1 ? 'record' : 'records'
        }. Deleting it would erase that payment history, so it cannot be deleted. Set it to Inactive instead.`,
        dependency: { table: 'daily_remittances', carId: id, count },
      },
      { status: 409 }
    );
  }

  const { error: deleteError } = await auth.supabase.from('cars').delete().eq('id', id);

  if (deleteError) {
    return databaseErrorResponse(deleteError, 'delete vehicle');
  }

  // Maintenance rows reference the plate as free text, so they are not cascaded
  // and cannot be counted by a foreign-key check. Cleaned up here by the same
  // normalised match the list route uses, or a deleted car would leave its
  // service history attached to nothing.
  const { data: orphanLogs } = await auth.supabase
    .from('vehicle_maintenance')
    .select('id, vehicle_registration')
    .limit(500);

  const target = normalizeRegistrationNumber(car.registration_number);
  const orphans = ((orphanLogs ?? []) as Array<{ id: string; vehicle_registration: string }>).filter(
    (log) => normalizeRegistrationNumber(log.vehicle_registration) === target
  );

  if (orphans.length > 0) {
    const { error: orphanError } = await auth.supabase
      .from('vehicle_maintenance')
      .delete()
      .in(
        'id',
        orphans.map((log) => log.id)
      );

    if (orphanError) {
      // The car is already gone at this point, so this cannot be rolled back.
      // Reported rather than swallowed: the rows are unreachable from the UI now
      // and need a human to remove them.
      return NextResponse.json(
        {
          ok: true,
          deleted: true,
          vehicleId: id,
          warnings: [
            `${car.registration_number} was deleted, but ${orphans.length} maintenance ${
              orphans.length === 1 ? 'log' : 'logs'
            } could not be removed and now reference a vehicle that no longer exists.`,
          ],
        },
        { status: 200 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    deleted: true,
    vehicleId: id,
    removedMaintenanceLogs: orphans.length,
  });
}