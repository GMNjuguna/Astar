/**
 * Manager dashboard overview: the executive chat thread.
 *
 * ── Why the remittance, fleet and stats projections were removed ─────────────
 * This route previously returned four arrays that did not correspond to their
 * tables. Concretely, for every row it emitted:
 *
 *   driver:     'Driver record'    — the literal string, not a join to `profiles`
 *   target:     'Ksh 20,000'       — a constant, on every row
 *   vehicle:    'Assigned vehicle' — the literal string, not a join to `cars`
 *   insurance:  'PST-STATUS'       — a constant; the schema has no insurance
 *                                  table, column or expiry date of any kind
 *   nextService: today             — `new Date()`, which reads as a real service
 *                                  date and is always today
 *   id:         id.slice(0, 5)     — truncated, so two different vehicles could
 *                                  render the same React key
 *
 * And `stats` computed `Fleet health` as `Math.max(90, 98 - (fleetRows.length > 5 ? 1 : 0))`
 * — a percentage that is 97% or 90% no matter what condition any vehicle is in.
 * It read as a measured uptime figure and depended on nothing.
 *
 * The manager dashboard's revenue and fleet panels now read `/api/analytics`,
 * which performs the `profiles` and `cars` joins for real names, plates, models
 * and rates, and reports the row cap when one was hit. Fabricated numbers have
 * been deleted here rather than left in place, because an endpoint that invents
 * data is a trap for the next caller: it returns HTTP 200 with plausible values,
 * so nothing signals that the figures are fiction.
 *
 * `payouts` and `maintenance` are kept because they are honest projections over
 * real columns. They are capped at 10 rows each; the cap is a deliberate bound on
 * an unbounded read, not a silent total, and neither array is presented as a
 * complete record by any current caller.
 */
import { NextResponse } from 'next/server';

import { databaseErrorResponse, firstError, unexpectedErrorResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['manager'];

type Row = Record<string, any>;

/** `HH:MM` in the server's locale, matching the chat panel's existing format. */
function formatClock(value: unknown): string {
  const date = new Date(String(value ?? ''));

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  // `force-dynamic` above guarantees this executes per request. Previously this
  // route was statically prerendered, so the response was frozen at build time
  // and could never return live data.
  //
  // Every table this route reads is reachable for a manager under RLS, so it uses
  // the request-scoped client rather than the service-role key:
  //
  //   driver_payouts       manager_can_manage_payouts
  //   vehicle_maintenance  manager_can_manage_vehicle_maintenance
  //   messages             driver_manage_own_messages (scoped below)
  //
  // `profiles`, `daily_remittances` and `cars` are no longer read here at all.
  // They were only read to feed the deleted projections, and paying three round
  // trips per request for rows nothing returns would be a tax on a chat endpoint.
  // `driverCount` comes from a `profiles` head-count, which is the one genuine
  // cross-table figure left, and it is a count-only query with no rows returned.
  //
  // The service-role client previously had to be used here because no manager
  // policy existed on `daily_remittances`. That policy now ships in
  // supabase/baseline.sql, so no RLS bypass is required and a compromised
  // manager session cannot reach rows beyond what these policies allow.
  const supabase = auth.supabase;

  try {
    const [driverCountResult, payoutResult, maintenanceResult, messageResult] =
      await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'driver'),
        supabase.from('driver_payouts').select('*').order('created_at', { ascending: false }).limit(10),
        supabase.from('vehicle_maintenance').select('*').order('created_at', { ascending: false }).limit(10),
        // Scoped to the caller. Under RLS a manager can only ever see messages
        // they sent or received, so the filter here matches what the policy
        // already permits rather than widening access. No manager-wide policy
        // exists on `messages` by design.
        supabase
          .from('messages')
          .select('id, sender_id, receiver_id, content, created_at')
          .or(`sender_id.eq.${auth.user.id},receiver_id.eq.${auth.user.id}`)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);

    // `supabase-js` resolves with `{ data: null, error }` rather than throwing,
    // so nothing here would have surfaced a failure. Previously the errors were
    // never read at all: a missing table produced `data ?? []`, which rendered
    // as a dashboard full of zeroes that looked exactly like a quiet week.
    const queryError = firstError([driverCountResult, payoutResult, maintenanceResult, messageResult]);

    if (queryError) {
      return databaseErrorResponse(queryError, 'load manager dashboard overview');
    }

    const payoutRows = (payoutResult.data ?? []) as Row[];
    const maintenanceRows = (maintenanceResult.data ?? []) as Row[];
    const messageRows = (messageResult.data ?? []) as Row[];

    const driverCount = driverCountResult.count ?? 0;

    const payouts = payoutRows.map((row) => ({
      id: String(row.id),
      driverId: String(row.driver_id),
      /**
       * Left as the raw id rather than a fabricated name. Resolving it means
       * joining `profiles`, and until a caller needs the name on this row an
       * unused join is a cost with no reader — whereas `'Driver record'` was a
       * claim that a name had been looked up when it had not.
       */
      amount: Number(row.amount ?? 0),
      type: String(row.payout_type ?? ''),
      status: String(row.status ?? ''),
      createdAt: row.created_at ?? null,
    }));

    const maintenance = maintenanceRows.map((row) => ({
      id: String(row.id),
      vehicleRegistration: row.vehicle_registration ?? null,
      issueSummary: row.issue_summary ?? '',
      /**
       * An estimate, not a spend. The schema has no actual-cost column, so
       * `estimated_cost` is the cost of work quoted, which for an open record is
       * for work that definitively has not happened.
       */
      estimatedCost: Number(row.estimated_cost ?? 0),
      priority: String(row.priority ?? ''),
      status: String(row.status ?? ''),
      createdAt: row.created_at ?? null,
    }));

    // Live messages, previously two hardcoded strings merged in unconditionally
    // so the panel showed the same conversation on every request.
    const messages = messageRows.map((row) => ({
      id: String(row.id),
      // Derived from the session rather than echoed, so a row written by anyone
      // else is labelled as the other party.
      sender: row.sender_id === auth.user.id ? 'manager' : 'ceo',
      content: String(row.content ?? ''),
      createdAt: formatClock(row.created_at),
    }));

    return NextResponse.json({
      /**
       * Real and counted, and deliberately not a percentage.
       *
       * The previous `stats` array included a `Fleet health` figure derived from
       * `Math.max(90, 98 - (fleetRows.length > 5 ? 1 : 0))` — always 97% or 90%,
       * independent of any vehicle's condition. It has been removed rather than
       * relabelled, because there is no honest version of it: the schema records
       * per-vehicle status and maintenance records, not a health score, and
       * averaging those into a single number would hide the one vehicle that is
       * off the road behind a fleet that is 95% fine.
       */
      driverCount,

      payouts,
      maintenance,
      messages,

      /**
       * Lets the UI tell "queried successfully, nothing on file" from a fault.
       * Both states used to render identically — an empty array and an array of
       * invented rows looked alike on screen.
       */
      empty: {
        payouts: payouts.length === 0,
        maintenance: maintenance.length === 0,
        messages: messages.length === 0,
      },
    });
  } catch (error) {
    return unexpectedErrorResponse(
      `load manager dashboard overview: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}