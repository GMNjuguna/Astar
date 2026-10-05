/**
 * Log a maintenance job against a specific vehicle.
 *
 * ── Why this takes a car id instead of a registration string ────────────────
 * The previous maintenance POST wrote `vehicle_registration` from whatever the
 * caller typed, with nothing checking that string against the fleet. A log could
 * therefore exist for a plate that was never in the fleet, or spelled slightly
 * differently from the car's actual plate -- in which case the fleet page's
 * normalised join would not find it, and the log would be invisible.
 *
 * Deriving the registration from the car row removes that whole class of mistake:
 * the log is written from a value the fleet already agrees on, and the join
 * cannot miss.
 */
import { NextResponse } from 'next/server';

import {
  badRequestResponse,
  databaseErrorResponse,
  notFoundResponse,
  unexpectedErrorResponse,
} from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['manager', 'ceo', 'developer'];

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRIORITIES = ['high', 'medium', 'low'] as const;

const MAX_ISSUE_LENGTH = 400;

function parseCost(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return 0;
  }

  const parsed = Number(String(value).replace(/[^\d.-]/g, ''));

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) {
    return null;
  }

  return Math.round(parsed * 100) / 100;
}

export async function POST(request: Request, context: { params: { id: string } }) {
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
      return badRequestResponse('Send a JSON object with the maintenance details.');
    }

    body = parsed as Record<string, unknown>;
  } catch {
    return badRequestResponse('Send a JSON object with the maintenance details.');
  }

  const issueSummary = String(body.issue_summary ?? '').trim();

  if (!issueSummary) {
    return badRequestResponse('Describe the issue so the log is readable later.');
  }

  if (issueSummary.length > MAX_ISSUE_LENGTH) {
    return badRequestResponse(`Keep the issue under ${MAX_ISSUE_LENGTH} characters.`);
  }

  const priority = String(body.priority ?? 'medium').toLowerCase();

  if (!(PRIORITIES as readonly string[]).includes(priority)) {
    return badRequestResponse(`Priority must be one of: ${PRIORITIES.join(', ')}.`);
  }

  const estimatedCost = parseCost(body.estimated_cost);

  if (estimatedCost === null) {
    return badRequestResponse('Estimated cost must be a positive number.');
  }

  // The registration comes from the fleet, never from the request.
  const { data: car, error: carError } = await auth.supabase
    .from('cars')
    .select('id, registration_number')
    .eq('id', id)
    .maybeSingle();

  if (carError) {
    return databaseErrorResponse(carError, 'load vehicle');
  }

  if (!car) {
    return notFoundResponse('That vehicle does not exist, so the log cannot be attached to it.');
  }

  const { data, error } = await auth.supabase
    .from('vehicle_maintenance')
    .insert({
      vehicle_registration: car.registration_number,
      issue_summary: issueSummary,
      estimated_cost: estimatedCost,
      priority: priority as (typeof PRIORITIES)[number],
      status: 'open',
    })
    .select('id, vehicle_registration, issue_summary, estimated_cost, priority, status, created_at')
    .single();

  if (error) {
    return databaseErrorResponse(error, 'log maintenance');
  }

  return NextResponse.json({ ok: true, log: data }, { status: 201 });
}