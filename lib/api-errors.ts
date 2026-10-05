import { NextResponse } from 'next/server';

/**
 * Structured API failure responses.
 *
 * Why this exists: `supabase-js` does not throw when a query fails. It resolves
 * with `{ data: null, error }`. A route that does `data ?? []` therefore turns a
 * dead database into a cheerful `200` with an empty array, which the UI then
 * renders as "no data yet". That is the exact failure mode this module replaces:
 * every database error must surface as a non-2xx status with a stable code the
 * UI can branch on.
 */
export type ApiErrorCode =
  | 'database_schema_not_applied'
  | 'storage_bucket_not_found'
  | 'database_unreachable'
  | 'database_access_denied'
  | 'database_error'
  | 'invalid_request'
  | 'not_found'
  /**
   * The request was well-formed but the caller could not be authenticated —
   * a missing session, or a credential check that failed. Distinct from
   * `not_found` and from `invalid_request` so the UI can send the user to the
   * login screen rather than showing a validation message or an empty state.
   */
  | 'authentication_failed'
  | 'unexpected_error';

export type ApiErrorBody = {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    /** Underlying driver text. Only populated outside production. */
    detail?: string;
  };
};

/**
 * Postgres SQLSTATE codes that are worth distinguishing, because they mean
 * genuinely different things operationally:
 *
 *  42P01 undefined_table   the schema was never applied
 *  42501  insufficient_privilege  RLS rejected the statement
 *  08006 / 08003 connection_failure the database is unreachable
 */
const SCHEMA_MISSING = ['42P01', 'PGRST205'];
const ACCESS_DENIED = ['42501', 'PGRST301'];
const UNREACHABLE = ['08000', '08003', '08006', '57P01'];

const SCHEMA_MISSING_HINTS = [
  'does not exist',
  'could not find the table',
  'undefined table',
  'relation public.',
];

const UNREACHABLE_HINTS = [
  'fetch failed',
  'econnrefused',
  'enotfound',
  'econnreset',
  'etimedout',
  'network',
  'socket hang up',
  'terminated',
];

/**
 * A missing bucket is deliberately NOT treated as a missing schema. The schema
 * can be perfectly applied while the buckets were never created, which is the
 * failure mode where section 7 of baseline.sql could not attach. Telling the
 * operator to re-run the schema would send them down the wrong path, so this
 * gets its own code and message naming the buckets to create.
 */
const BUCKET_MISSING_CODES = ['nosuchbucket'];
const BUCKET_MISSING_HINTS = ['bucket not found', 'bucket notfound'];

const ACCESS_DENIED_HINTS = [
  'permission denied',
  'row-level security',
  'row level security',
  'violates row-level security policy',
];

/** Reads the numeric/string SQLSTATE and the human message off a PostgREST error. */
function readErrorParts(error: unknown): { code: string; message: string } {
  if (!error) {
    return { code: '', message: '' };
  }

  if (typeof error === 'string') {
    return { code: '', message: error };
  }

  if (error instanceof Error) {
    return { code: '', message: error.message };
  }

  const record = error as { code?: unknown; message?: unknown };

  return {
    code: typeof record.code === 'string' ? record.code : '',
    message: typeof record.message === 'string' ? record.message : '',
  };
}

function matches(code: string, message: string, codes: string[], hints: string[]) {
  const normalisedCode = code.toLowerCase();

  if (codes.some((entry) => normalisedCode.includes(entry.toLowerCase()))) {
    return true;
  }

  const normalisedMessage = message.toLowerCase();

  return hints.some((hint) => normalisedMessage.includes(hint.toLowerCase()));
}

/**
 * Maps a Supabase/PostgREST failure onto a stable, actionable code.
 *
 * Distinguishing "schema not applied" from "database down" matters in practice:
 * the first is a one-time deployment step, the second is an incident. Both are
 * 503, but they need different operator responses, and the operator only ever
 * sees the code we send.
 */
export function classifyDatabaseError(error: unknown): ApiErrorCode {
  const { code, message } = readErrorParts(error);

  // Checked before the schema case: the schema-not-applied hints include the
  // phrase "relation public.", which no bucket message contains, so there is no
  // overlap, but ordering it first keeps the intent readable.
  if (matches(code, message, BUCKET_MISSING_CODES, BUCKET_MISSING_HINTS)) {
    return 'storage_bucket_not_found';
  }

  if (matches(code, message, SCHEMA_MISSING, SCHEMA_MISSING_HINTS)) {
    return 'database_schema_not_applied';
  }

  if (matches(code, message, UNREACHABLE, UNREACHABLE_HINTS)) {
    return 'database_unreachable';
  }

  if (matches(code, message, ACCESS_DENIED, ACCESS_DENIED_HINTS)) {
    return 'database_access_denied';
  }

  return 'database_error';
}

const MESSAGES: Record<ApiErrorCode, string> = {
  database_schema_not_applied:
    'The database schema has not been applied to this Supabase project. Run supabase/baseline.sql, then retry.',
  storage_bucket_not_found:
    'A required private storage bucket does not exist. Create the driver-docs and driver-credentials buckets (section 7 of supabase/baseline.sql), then retry.',
  database_unreachable: 'The database is unreachable. Check the Supabase project status and your connection settings.',
  database_access_denied: 'This account is not permitted to read or write the requested records.',
  database_error: 'The database rejected the request. See the server log for the underlying cause.',
  invalid_request: 'The request was malformed or incomplete.',
  not_found: 'The requested record does not exist.',
  // Generic on purpose. `unauthorizedResponse` is called with a specific message
  // where one is safe to show; this is the fallback for a caller that passes none,
  // and it must not imply which part of the credential was wrong.
  authentication_failed: 'Your session could not be verified. Please sign in again.',
  unexpected_error: 'The server hit an unexpected error while handling this request.',
};

const STATUS: Record<ApiErrorCode, number> = {
  // Access denied is an authorization outcome, so 403 is the truthful status.
  // Everything else means a dependency we need is not working right now.
  database_access_denied: 403,
  invalid_request: 400,
  not_found: 404,
  // 401 rather than 403: the caller is not identified, not identified-and-
  // forbidden. The distinction is what tells the UI to send someone to sign in
  // instead of showing them a permissions message they cannot act on.
  authentication_failed: 401,
  storage_bucket_not_found: 503,
  database_schema_not_applied: 503,
  database_unreachable: 503,
  database_error: 503,
  unexpected_error: 500,
};

/**
 * Raw Postgres and PostgREST messages can name tables, columns and constraint
 * definitions. That is invaluable while developing and is more than an
 * authenticated internal portal needs to expose in production, so the detail is
 * withheld there while the code and message still explain the failure.
 */
function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Builds the failure response for a failed database operation.
 *
 * `context` names the operation, e.g. `'read system_config'`, so the message
 * is specific enough to act on without opening the server log.
 */
export function databaseErrorResponse(error: unknown, context: string): NextResponse<ApiErrorBody> {
  const code = classifyDatabaseError(error);

  return NextResponse.json<ApiErrorBody>(
    {
      ok: false,
      error: {
        code,
        message: MESSAGES[code],
        ...(isProduction() ? {} : { detail: `${context}: ${readErrorParts(error).message || String(error)}` }),
      },
    },
    { status: STATUS[code] }
  );
}

/**
 * Builds the failure response for a thrown exception that is not a database
 * error, e.g. a malformed request body.
 */
export function unexpectedErrorResponse(context: string, status = 500): NextResponse<ApiErrorBody> {
  return NextResponse.json<ApiErrorBody>(
    {
      ok: false,
      error: {
        code: 'unexpected_error',
        message: MESSAGES.unexpected_error,
        ...(isProduction() ? {} : { detail: context }),
      },
    },
    { status }
  );
}

/**
 * A validation/usage failure: the request itself is wrong, not the server.
 * Kept separate from the codes above so the UI can treat it as "fix your input"
 * rather than "something is broken".
 */
export function badRequestResponse(message: string, detail?: string): NextResponse<ApiErrorBody> {
  return NextResponse.json<ApiErrorBody>(
    {
      ok: false,
      error: {
        code: 'invalid_request',
        message,
        ...(detail && !isProduction() ? { detail } : {}),
      },
    },
    { status: 400 }
  );
}

/**
 * The caller could not be authenticated.
 *
 * Distinct from `badRequestResponse` on purpose. A wrong password is not a
 * malformed request: the payload was fine, the caller simply failed to prove who
 * they are. The UI branches on the status to send the user back to sign-in
 * rather than to highlight a form field, and the message stays vague so the
 * response cannot be used to enumerate which accounts exist.
 */
export function unauthorizedResponse(
  message: string,
  code: ApiErrorCode = 'authentication_failed'
): NextResponse<ApiErrorBody> {
  return NextResponse.json<ApiErrorBody>(
    {
      ok: false,
      error: { code, message },
    },
    { status: 401 }
  );
}

/**
 * A write that matched no row. Distinct from a write failure: the database
 * worked, the target simply is not there (deleted row, wrong id, or RLS filtered
 * the row out of scope). 404 keeps "you asked for something that is not there"
 * distinct from 403 "you may not touch that".
 */
export function notFoundResponse(message: string): NextResponse<ApiErrorBody> {
  return NextResponse.json<ApiErrorBody>(
    {
      ok: false,
      error: { code: 'not_found', message },
    },
    { status: 404 }
  );
}

/**
 * Returns the first error found across a set of parallel query results.
 *
 * The dashboard routes fan out several queries with `Promise.all`. Without this,
 * a single missing table would silently blank one panel while the rest rendered
 * normally, which reads to the operator as "no data" rather than "broken".
 */
export function firstError(results: Array<{ error: unknown } | null | undefined>): unknown {
  for (const result of results) {
    if (result?.error) {
      return result.error;
    }
  }

  return null;
}