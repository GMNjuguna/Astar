import { NextResponse } from 'next/server';

import { badRequestResponse, databaseErrorResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import {
  ASSISTANT_FALLBACK_PROMPT_KEY as FALLBACK_PROMPT_KEY,
  ASSISTANT_PROMPT_KEYS as PROMPT_KEYS,
  ASSISTANT_SYSTEM_PROMPT_KEY as SYSTEM_PROMPT_KEY,
  DEFAULT_TEMPLATES,
  MAX_PROMPT_LENGTH,
} from '@/lib/ai/prompts';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['developer'];

/**
 * The prompt keys and bootstrap text live in `lib/ai/prompts.ts` because this
 * route writes them while `/api/ai-assistant` reads them. Keeping separate
 * literals here would mean a rename on one side silently orphans the other, and
 * the assistant would quietly fall back to its defaults with nothing failing.
 */

/**
 * Prompts land in the live assistant system message, so length is bounded and
 * non-string input is rejected rather than coerced into "[object Object]".
 */
function isUsablePrompt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_PROMPT_LENGTH;
}

/**
 * The chatbot session log is sample data, not a persisted table: there is no
 * table in supabase/baseline.sql that records assistant exchanges, so there is
 * nothing to read. It is returned with an explicit provenance marker so the UI
 * can label it instead of presenting it as observed traffic.
 */
const SAMPLE_HISTORY = [
  { id: 'chat-1', driver: 'Faith Achieng', tokens: 824, status: 'Healthy', summary: 'Trip summary for Nairobi route requested.', createdAt: '2026-09-18T08:20:00Z' },
  { id: 'chat-2', driver: 'Njeri Wanjiku', tokens: 1420, status: 'Flagged', summary: 'Driver queried payout policy and balance details.', createdAt: '2026-09-18T08:35:00Z' },
  { id: 'chat-3', driver: 'Moses Kamau', tokens: 510, status: 'Escalated', summary: 'Urgent schedule change request required manual review.', createdAt: '2026-09-18T08:41:00Z' },
];

/** `system_config.value` is jsonb; the prompt text is stored as `{ prompt }`. */
function readPrompt(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    if (typeof record.prompt === 'string' && record.prompt.trim()) {
      return record.prompt;
    }
  }

  return null;
}

export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const { data, error } = await auth.supabase
    .from('system_config')
    .select('key, value, updated_at')
    .in('key', PROMPT_KEYS);

  if (error) {
    return databaseErrorResponse(error, 'read chatbot prompt templates');
  }

  const rows = (data ?? []) as Array<{ key: string; value: unknown; updated_at: string | null }>;
  const stored = new Map(rows.map((row) => [row.key, row]));

  const systemRow = stored.get(SYSTEM_PROMPT_KEY);
  const fallbackRow = stored.get(FALLBACK_PROMPT_KEY);

  return NextResponse.json({
    ok: true,
    history: SAMPLE_HISTORY,
    /** Tells the UI these rows are illustrative, not recorded traffic. */
    historySource: 'sample_data',
    templates: {
      systemPrompt: readPrompt(systemRow?.value) ?? DEFAULT_TEMPLATES.systemPrompt,
      fallbackPrompt: readPrompt(fallbackRow?.value) ?? DEFAULT_TEMPLATES.fallbackPrompt,
    },
    /** False while either prompt is still the bootstrap default. */
    fullyConfigured: systemRow !== undefined && fallbackRow !== undefined,
    updatedAt: systemRow?.updated_at ?? null,
  });
}

export async function PATCH(request: Request) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  let payload: { templates?: { systemPrompt?: unknown; fallbackPrompt?: unknown } };

  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return badRequestResponse('Request body must be valid JSON.');
  }

  const submitted = payload.templates;

  if (!submitted || typeof submitted !== 'object') {
    return badRequestResponse('No prompt templates supplied.');
  }

  if (!isUsablePrompt(submitted.systemPrompt)) {
    return badRequestResponse('systemPrompt must be a non-empty string no longer than 8000 characters.');
  }

  if (!isUsablePrompt(submitted.fallbackPrompt)) {
    return badRequestResponse('fallbackPrompt must be a non-empty string no longer than 8000 characters.');
  }

  const systemPrompt = submitted.systemPrompt.trim();
  const fallbackPrompt = submitted.fallbackPrompt.trim();
  const timestamp = new Date().toISOString();

  // Both prompts go in one round trip via the upsert's multi-row form. Separate
  // upserts could half-apply: if the second failed, the operator would have a
  // new system prompt with the old fallback and no way to tell from the UI.
  const { error } = await auth.supabase.from('system_config').upsert(
    [
      { key: SYSTEM_PROMPT_KEY, value: { prompt: systemPrompt }, updated_at: timestamp },
      { key: FALLBACK_PROMPT_KEY, value: { prompt: fallbackPrompt }, updated_at: timestamp },
    ],
    { onConflict: 'key' }
  );

  if (error) {
    return databaseErrorResponse(error, 'save chatbot prompt templates');
  }

  return NextResponse.json({
    ok: true,
    templates: { systemPrompt, fallbackPrompt },
    updatedBy: auth.profile.id,
    updatedAt: timestamp,
  });
}