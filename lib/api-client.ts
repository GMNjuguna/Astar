/**
 * Browser-side reader for the structured API failures produced by
 * `lib/api-errors.ts`.
 *
 * The server sends `{ ok: false, error: { code, message, detail? } }` with a
 * non-2xx status. Components previously did `const data = await response.json()`
 * without ever checking `response.ok`, so a 503 was indistinguishable from a
 * success and the UI silently kept its built-in sample values. Every call site
 * now goes through `fetchApiJson`, which either resolves with typed data or
 * returns the server's message for display.
 */

export type ApiFailure = {
  ok: false;
  code: string;
  message: string;
};

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/** Pulls the server's message out of a failure body, tolerating an empty body. */
async function extractFailure(response: Response): Promise<ApiFailure> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
      message?: unknown;
    };

    const code = typeof body?.error?.code === 'string' ? body.error.code : `http_${response.status}`;
    const message =
      typeof body?.error?.message === 'string'
        ? body.error.message
        : typeof body?.message === 'string'
          ? body.message
          : `Request failed with status ${response.status}.`;

    return { ok: false, code, message };
  } catch {
    // A proxy or an unhandled route can return HTML or nothing at all.
    return {
      ok: false,
      code: `http_${response.status}`,
      message: `Request failed with status ${response.status}.`,
    };
  }
}

/**
 * Performs a request and normalises the outcome.
 *
 * `fetch` only rejects on a network-level failure, which is caught and reported
 * with the same shape as a server error so callers have one branch.
 */
export async function fetchApiJson<T>(
  input: string,
  init?: RequestInit
): Promise<ApiResult<T>> {
  let response: Response;

  try {
    response = await fetch(input, init);
  } catch {
    return {
      ok: false,
      code: 'network_error',
      message: 'Could not reach the server. Check your connection and try again.',
    };
  }

  if (!response.ok) {
    return extractFailure(response);
  }

  try {
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return {
      ok: false,
      code: 'invalid_response',
      message: 'The server returned a response that could not be read as JSON.',
    };
  }
}