import { NextResponse } from 'next/server';

import { badRequestResponse, databaseErrorResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import { FEATURE_FLAG_DEFINITIONS, FEATURE_FLAG_KEYS } from '@/lib/feature-flags';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['developer'];

/**
 * Reads the live value of a single flag.
 *
 * `system_config.value` is jsonb and is written as `{ enabled: boolean }` by the
 * POST handler, but the column is free-form jsonb, so older or hand-edited rows
 * may hold a bare boolean or `{ value: ... }`. All three shapes are accepted;
 * anything unrecognised falls back to the definition's bootstrap default so a
 * malformed row cannot silently disable a safety control.
 */
function readFlagValue(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    if (typeof record.enabled === 'boolean') {
      return record.enabled;
    }

    if (typeof record.value === 'boolean') {
      return record.value;
    }
  }

  return defaultValue;
}

export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  // `developers_manage_system_config` grants a developer SELECT on this table,
  // so no service-role bypass is required and RLS still guards the read.
  const { data, error } = await auth.supabase
    .from('system_config')
    .select('key, value, updated_at')
    .in('key', FEATURE_FLAG_KEYS);

  // A failure here must not fall back to the code defaults: that is precisely
  // the bug this route had, where a dead database rendered as a healthy-looking
  // set of flags and toggles appeared to save and then silently reverted.
  if (error) {
    return databaseErrorResponse(error, 'read system_config feature flags');
  }

  const rows = (data ?? []) as Array<{ key: string; value: unknown; updated_at: string | null }>;

  const stored = new Map(rows.map((row) => [row.key, row]));

  const flags = FEATURE_FLAG_DEFINITIONS.map((definition) => {
    const row = stored.get(definition.key);

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      value: readFlagValue(row?.value, definition.defaultValue),
      // Lets the UI distinguish "operator set this to false" from "never saved,
      // currently showing the bootstrap default" and offer to initialise.
      persisted: row !== undefined,
      updatedAt: row?.updated_at ?? null,
    };
  });

  return NextResponse.json({
    ok: true,
    flags,
    /** False until every flag has a row. Drives the "not yet configured" hint. */
    fullyConfigured: flags.every((flag) => flag.persisted),
  });
}

export async function POST(request: Request) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  let payload: { flags?: Array<{ key: string; value: unknown }> };

  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return badRequestResponse('Request body must be valid JSON.');
  }

  const submitted = Array.isArray(payload.flags) ? payload.flags : [];

  if (submitted.length === 0) {
    return badRequestResponse('No flags supplied.');
  }

  const unknownKeys = submitted
    .map((flag) => flag.key)
    .filter((key): key is string => typeof key === 'string')
    .filter((key) => !FEATURE_FLAG_KEYS.includes(key));

  if (unknownKeys.length > 0) {
    // Silently ignoring them would leave the operator believing a control was
    // saved when it was discarded.
    return badRequestResponse(`Unknown flag keys: ${unknownKeys.join(', ')}.`);
  }

  const invalid = submitted.filter((flag) => typeof flag.value !== 'boolean');

  if (invalid.length > 0) {
    return badRequestResponse('Every flag value must be a boolean.');
  }

  // Validation above has established both fields, so re-widening them keeps the
  // rest of the handler free of casts.
  const accepted = submitted as Array<{ key: string; value: boolean }>;

  const timestamp = new Date().toISOString();

  // Uses the request-scoped client so writes are enforced by the
  // `developers_manage_system_config` RLS policy. The former service-role
  // client bypassed RLS entirely and is intentionally gone from this route.
  const results = await Promise.all(
    accepted.map(async (flag) => {
      const { error } = await auth.supabase.from('system_config').upsert(
        {
          key: flag.key,
          value: { enabled: flag.value },
          updated_at: timestamp,
        },
        { onConflict: 'key' }
      );

      return { key: flag.key, error };
    })
  );

  const failed = results.filter((result) => result.error);

  if (failed.length > 0) {
    return databaseErrorResponse(failed[0].error, `save flag "${failed[0].key}"`);
  }

  // Re-read so the response reflects what is actually stored rather than echoing
  // the request, which would hide a coercion or a trigger that altered a value.
  const { data, error: readError } = await auth.supabase
    .from('system_config')
    .select('key, value, updated_at')
    .in('key', FEATURE_FLAG_KEYS);

  if (readError) {
    return databaseErrorResponse(readError, 'verify saved system_config flags');
  }

  const stored = new Map(
    ((data ?? []) as Array<{ key: string; value: unknown; updated_at: string | null }>).map((row) => [row.key, row])
  );

  const flags = FEATURE_FLAG_DEFINITIONS.map((definition) => {
    const row = stored.get(definition.key);

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      value: readFlagValue(row?.value, definition.defaultValue),
      persisted: row !== undefined,
      updatedAt: row?.updated_at ?? null,
    };
  });

  return NextResponse.json({ ok: true, flags });
}