import { NextResponse } from 'next/server';

import { badRequestResponse, databaseErrorResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['manager'];

export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const { data, error } = await auth.supabase
      .from('driver_payouts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return databaseErrorResponse(error, 'load driver payouts');
    }

    const payoutRows = (data ?? []) as Array<Record<string, any>>;

    return NextResponse.json({
      payouts: payoutRows.map((payout) => ({
        id: `P-${String(payout.id).slice(0, 5).toUpperCase()}`,
        driver: 'Driver record',
        amount: `Ksh ${Number(payout.amount ?? 0).toLocaleString()}`,
        type: String(payout.payout_type ?? 'Commission'),
        status: String(payout.status ?? 'Queued').replace(/^./, (value) => value.toUpperCase()),
      })),
      /** Distinguishes "queried fine, nothing queued" from a failed load. */
      empty: { payouts: payoutRows.length === 0 },
    });
  } catch {
    return databaseErrorResponse(new Error('payouts request failed unexpectedly'), 'load driver payouts');
  }
}

export async function POST(request: Request) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const body = await request.json();
    const { driver, driverId, amount, type } = body as { driver?: string; driverId?: string; amount?: string; type?: string };

    if (!amount || !type) {
      return badRequestResponse('Missing payout details.');
    }

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return badRequestResponse('Payout amount must be a positive number.');
    }

    let resolvedDriverId = driverId ?? null;

    if (!resolvedDriverId && driver) {
      const { data: profileMatch, error: profileLookupError } = await auth.supabase
        .from('profiles')
        .select('id')
        .ilike('full_name', `%${driver}%`)
        .limit(1)
        .maybeSingle();

      // Previously this error was discarded, so a failed lookup looked like "no
      // such driver" and the manager was told to fix their input when the real
      // cause was an unreachable or unapplied database.
      if (profileLookupError) {
        return databaseErrorResponse(profileLookupError, `resolve driver profile "${driver}"`);
      }

      resolvedDriverId = profileMatch?.id ?? null;
    }

    if (!resolvedDriverId) {
      return badRequestResponse('A driver profile is required before payout processing.');
    }

    // RLS-scoped write. NOTE: no status escalation check yet — a manager can
    // currently queue any payout_type for any driver. See the audit follow-ups.
    const { data, error } = await auth.supabase
      .from('driver_payouts')
      .insert({
        driver_id: resolvedDriverId,
        amount: numericAmount,
        payout_type: type,
        status: 'queued',
      })
      .select()
      .single();

    if (error) {
      return databaseErrorResponse(error, 'insert driver_payouts record');
    }

    return NextResponse.json({
      success: true,
      payout: {
        id: `P-${String(data?.id ?? Date.now()).slice(0, 5).toUpperCase()}`,
        driver: driver ?? 'Driver record',
        amount: `Ksh ${Number(data?.amount ?? numericAmount).toLocaleString()}`,
        type: String(data?.payout_type ?? type),
        status: 'Queued',
      },
      message: `Payout queued for ${driver ?? 'the selected driver'}.`,
    });
  } catch {
    return NextResponse.json({ success: false, message: 'Unable to process payment. Please retry.' }, { status: 500 });
  }
}