/**
 * Fleet vehicle rules, shared by the fleet page and the vehicle API routes.
 *
 * Mirrors the column constraints in baseline.sql section 2 (`year`, `daily_rate`,
 * `status`), plus the two rules the database cannot express: what counts as a
 * registration number, and which fields a caller is allowed to change.
 */

/** Mirrors `public.car_status`. */
export const VEHICLE_STATUSES = ['active', 'servicing', 'inactive'] as const;

export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const VEHICLE_STATUS_LABELS: Record<VehicleStatus, string> = {
  active: 'Active',
  servicing: 'Servicing',
  inactive: 'Inactive',
};

/**
 * Pill classes per status.
 *
 * Deliberately the same token pairings already used by the remittance and
 * document status pills (`components/driver/daily-ledger-summary.tsx`,
 * `components/driver/document-management-hub.tsx`): a `/10` or `/5` wash of the
 * status hue, the full-strength hue as the text, and a `/30` border. Reusing
 * those exact combinations means these pills inherit an audited contrast pairing
 * instead of introducing a new one, and there is no fourth colour to re-check on
 * the next theme change.
 *
 * `inactive` uses no hue at all -- it is the absence of activity, not a fourth
 * state that needs its own alarm colour.
 */
export const VEHICLE_STATUS_TONES: Record<VehicleStatus, string> = {
  active: 'bg-chart-collected/10 text-chart-collected border-chart-collected/30',
  servicing: 'bg-chart-servicing/5 text-chart-servicing border-chart-servicing/30',
  inactive: 'bg-surface-2 text-content-muted border-line',
};

/** Shared pill chrome, so every status pill matches the ones already in the app. */
export const VEHICLE_STATUS_PILL =
  'rounded-full border px-3 py-1 text-xs font-semibold';

export function isVehicleStatus(value: unknown): value is VehicleStatus {
  return typeof value === 'string' && (VEHICLE_STATUSES as readonly string[]).includes(value);
}

/**
 * Bounds mirror the `check (year between 2000 and 2100)` constraint.
 *
 * The upper bound is the constraint's own, not an editorial guess: accepting a
 * year the database will refuse would turn a clear field error into a 503.
 */
export const MIN_VEHICLE_YEAR = 2000;
export const MAX_VEHICLE_YEAR = 2100;

/** A sane ceiling for a Kenyan daily rental, used only to catch typos. */
export const MAX_DAILY_RATE = 1_000_000;

export type VehicleFieldErrors = Partial<
  Record<'registrationNumber' | 'model' | 'year' | 'dailyRate' | 'status', string>
>;

export type VehicleWritableFields = {
  registration_number: string;
  model: string;
  year: number;
  daily_rate: number;
  status: VehicleStatus;
};

/** A PATCH carries a subset; the type says so, instead of every field optional. */
export type VehiclePatchFields = Partial<VehicleWritableFields>;

export type VehicleValidationResult =
  | { ok: true; value: VehiclePatchFields }
  | { ok: false; errors: VehicleFieldErrors };

/**
 * Normalises a registration number.
 *
 * Uppercased and stripped of whitespace and hyphens, then reassembled with a
 * single space before the final three characters (`KDA 123A`). Kenyan plates are
 * written in several styles by hand -- `KDA 123A`, `kda123a`, `KDA-123A` -- and
 * `registration_number` is `unique`, so without normalisation the same physical
 * plate could be entered twice as two different vehicles. Comparing normalised
 * values is the only way the uniqueness constraint can do its job.
 */
export function normalizeRegistrationNumber(value: string): string {
  const collapsed = value.replace(/[\s-]+/g, '').toUpperCase();

  if (collapsed.length <= 3) {
    return collapsed;
  }

  const suffix = collapsed.slice(-3);
  const prefix = collapsed.slice(0, -3).replace(/(.{2})(?=.)/g, '$1 ');

  return `${prefix} ${suffix}`.trim();
}

/**
 * Accepts the collapsed form only.
 *
 * A loose pattern like `[A-Z]{2}\s?\d{3}\s?[A-Z]?` would reject legitimate
 * commercial plates (trailers and lorries carry formats this does not cover)
 * while still accepting the common typo, so the check is deliberately minimal:
 * letters and digits must be present, and nothing may remain that could indicate
 * the caller sent free text. The unique constraint is what actually stops
 * duplicates; this only catches "this is not a plate".
 */
const REGISTRATION_SHAPE = /^[A-Z0-9]{4,12}$/;

/**
 * Validates a create-or-replace vehicle payload.
 *
 * `partial` is for PATCH: when true, an absent field is left alone rather than
 * being reported as missing, so a status-only change does not have to resend the
 * model. An explicitly *present but empty* field is still an error in both modes
 * -- that is a cleared input, not an omitted one.
 */
export function validateVehicleInput(
  input: Record<string, unknown>,
  { partial = false }: { partial?: boolean } = {}
): VehicleValidationResult {
  const errors: VehicleFieldErrors = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;

  // --- registration number ---
  let registrationNumber = '';
  if (has('registration_number')) {
    const raw = String(input.registration_number ?? '').trim();
    registrationNumber = normalizeRegistrationNumber(raw);

    if (!registrationNumber) {
      errors.registrationNumber = 'Registration number is required.';
    } else if (!REGISTRATION_SHAPE.test(registrationNumber.replace(/\s/g, ''))) {
      errors.registrationNumber = 'Use a plate like KDA 123A -- letters and digits only.';
    }
  } else if (!partial) {
    errors.registrationNumber = 'Registration number is required.';
  }

  // --- model ---
  let model = '';
  if (has('model')) {
    model = String(input.model ?? '').trim();

    if (!model) {
      errors.model = 'Model is required.';
    } else if (model.length > 80) {
      errors.model = 'Model must be 80 characters or fewer.';
    }
  } else if (!partial) {
    errors.model = 'Model is required.';
  }

  // --- year ---
  let year = 0;
  if (has('year')) {
    const parsed = Number(input.year);

    if (!Number.isInteger(parsed)) {
      errors.year = 'Year must be a whole number.';
    } else if (parsed < MIN_VEHICLE_YEAR || parsed > MAX_VEHICLE_YEAR) {
      errors.year = `Year must be between ${MIN_VEHICLE_YEAR} and ${MAX_VEHICLE_YEAR}.`;
    } else {
      year = parsed;
    }
  } else if (!partial) {
    errors.year = 'Year is required.';
  }

  // --- daily rate ---
  let dailyRate = 0;
  if (has('daily_rate')) {
    // Accepts "4500" and "4,500" and "Ksh 4,500" alike; the form and any pasted
    // value go through here so the page does not have to agree on a format.
    const parsed = Number(String(input.daily_rate).replace(/[^\d.-]/g, ''));

    if (!Number.isFinite(parsed)) {
      errors.dailyRate = 'Daily rate must be a number.';
    } else if (parsed < 0) {
      errors.dailyRate = 'Daily rate cannot be negative.';
    } else if (parsed > MAX_DAILY_RATE) {
      errors.dailyRate = `Daily rate cannot exceed ${MAX_DAILY_RATE.toLocaleString()}.`;
    } else {
      // Two decimals, matching numeric(10,2). Rounded here rather than letting
      // Postgres truncate, so what the manager typed is what gets stored.
      dailyRate = Math.round(parsed * 100) / 100;
    }
  } else if (!partial) {
    errors.dailyRate = 'Daily rate is required.';
  }

  // --- status ---
  let status: VehicleStatus = 'active';
  if (has('status')) {
    if (!isVehicleStatus(input.status)) {
      errors.status = `Status must be one of: ${VEHICLE_STATUSES.join(', ')}.`;
    } else {
      status = input.status;
    }
  } else if (!partial) {
    // Defaults client-side too, so an omitted status is explicit rather than
    // depending on the column default.
    status = 'active';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      // Each field is omitted rather than sent as `undefined` when it was absent.
      // That distinction is what makes this safe for PATCH: PostgREST turns an
      // explicit `undefined` into a null assignment, which would wipe the
      // registration number on a status-only change.
      ...(has('registration_number') ? { registration_number: registrationNumber } : {}),
      ...(has('model') ? { model } : {}),
      ...(has('year') ? { year } : {}),
      ...(has('daily_rate') ? { daily_rate: dailyRate } : {}),
      ...(has('status') ? { status } : {}),
    },
  };
}