/**
 * System-prompt configuration for the fleet assistant.
 *
 * Single source of truth for the `system_config` keys. The Developer portal
 * (`app/api/developer/chatbot/route.ts`) owns *writing* them and the assistant
 * route owns *reading* them, so the key strings must not be duplicated in both
 * files — a rename on one side would silently orphan the other.
 *
 * Prompts are re-read from the database on **every** assistant request. There is
 * deliberately no cache and no module-level memo: the operator's expectation
 * after saving a prompt in the Developer portal is that the very next message
 * behaves differently, and any caching layer would break that guarantee.
 */
import { createHash } from 'node:crypto';

import type { AppRole, RequestScopedClient } from '@/lib/auth';

export const ASSISTANT_SYSTEM_PROMPT_KEY = 'chatbot.system_prompt';
export const ASSISTANT_FALLBACK_PROMPT_KEY = 'chatbot.fallback_prompt';
export const ASSISTANT_PROMPT_KEYS = [ASSISTANT_SYSTEM_PROMPT_KEY, ASSISTANT_FALLBACK_PROMPT_KEY];

export const MAX_PROMPT_LENGTH = 8000;

/**
 * Bootstrap prompts, used only until an operator saves. Once a row exists the
 * database value is authoritative and these are not consulted for that field.
 *
 * Each field falls back independently: a half-populated table yields a mix of
 * operator text and bootstrap text rather than discarding both.
 */
export const DEFAULT_TEMPLATES = {
  systemPrompt:
    'You are Astar Travel AI support. Help drivers with route changes, payments, remittances, and compliance guidance. Keep answers concise and policy-aware.',
  fallbackPrompt:
    'If the answer is uncertain, direct the driver to the relevant support channel and ask for a follow-up.',
};

/**
 * Per-role scope directive injected alongside the operator's system prompt.
 *
 * This is a second layer, not the only one. Row-level scoping is enforced by
 * RLS on the query itself, so a driver physically cannot retrieve fleet-wide
 * rows; this directive exists so the *narrative* also respects that boundary —
 * without it the model could be handed a driver-only query and still answer as
 * if it had company-wide visibility, or offer to "check with the fleet" and then
 * have nothing to report.
 */
const ROLE_DIRECTIVES: Record<AppRole, string> = {
  driver: [
    'SCOPE: You are speaking to a driver. Every figure you report comes from that driver\'s own records only.',
    'Never state or estimate fleet-wide totals, other drivers\' earnings, or company-wide compliance figures.',
    'If asked about fleet-level information, state plainly that drivers only see their own records and name the role that can answer.',
  ].join(' '),
  manager: [
    'SCOPE: You are speaking to a fleet manager. Report figures across the fleet.',
    'Cover fleet status, remittance collection, driver onboarding, document verification and maintenance.',
    'Do not speculate beyond the data supplied; say which figures are unavailable instead of estimating them.',
  ].join(' '),
  ceo: [
    'SCOPE: You are speaking to the CEO. You have company-wide visibility.',
    'Lead with totals and notable outliers across revenue, remittance status, fleet composition, document compliance and maintenance exposure.',
  ].join(' '),
  developer: [
    'SCOPE: You are speaking to a developer/administrator with full platform visibility.',
    'You may report raw counts, data-quality problems and configuration state.',
  ].join(' '),
  suspended: [
    'SCOPE: This account is suspended. Do not report operational data.',
    'Explain that access is suspended and direct the user to an administrator.',
  ].join(' '),
};

export type PromptSource = 'database' | 'default' | 'mixed';

export type LoadedPrompts = {
  /** Effective system prompt: operator text plus the role directive. */
  systemPrompt: string;
  /** Operator text only, without the injected directive. */
  operatorPrompt: string;
  fallbackPrompt: string;
  /**
   * Where each field came from.
   *
   * Surfaced in the API response because an empty `system_config` does not
   * raise an error under RLS — a non-developer caller whose policy denies the
   * read simply receives zero rows. Without this marker that silent fallback is
   * indistinguishable from "no prompt has been configured yet".
   */
  source: PromptSource;
  /**
   * Truncated SHA-256 of the operator prompt actually used.
   *
   * This is the verification handle for prompt changes: after an operator saves
   * a new prompt, the next assistant response carries a different digest,
   * proving the value was re-read from the database rather than served from a
   * constant. The digest is one-way, so it exposes nothing about the text.
   */
  promptSha: string;
  /** `updated_at` of the system prompt row, or null when it does not exist. */
  updatedAt: string | null;
};

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

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Builds the full system prompt for one request.
 *
 * The role directive is appended rather than prepended so the operator's own
 * text leads. Someone editing prompts in the Developer portal should see their
 * instructions take priority, with the scope guard acting as a floor.
 */
export function buildSystemPrompt(operatorPrompt: string, role: AppRole): string {
  const directive = ROLE_DIRECTIVES[role];

  if (!directive) {
    return operatorPrompt;
  }

  return `${operatorPrompt.trim()}\n\n${directive}`;
}

export type PromptLoadResult =
  | { ok: true; prompts: LoadedPrompts }
  | { ok: false; error: unknown };

/**
 * Reads both prompt rows using the caller's own client, so RLS applies.
 *
 * An RLS-denied read returns an empty result set, not an error — which is why
 * this function distinguishes two very different failures:
 *
 * - Rows absent or unusable → `ok: true` with the bootstrap default. This is the
 *   documented graceful degradation, and `source` records it.
 * - A real query failure (table missing, schema not applied, network down) →
 *   `ok: false`. That must not degrade to defaults, because a plausible answer
 *   built on an unreadable database is exactly the silent-failure mode this
 *   codebase was hardened to eliminate.
 */
export async function loadAssistantPrompts(supabase: RequestScopedClient): Promise<PromptLoadResult> {
  const { data, error } = await supabase
    .from('system_config')
    .select('key, value, updated_at')
    .in('key', ASSISTANT_PROMPT_KEYS);

  if (error) {
    return { ok: false, error };
  }

  const rows = (data ?? []) as Array<{ key: string; value: unknown; updated_at: string | null }>;
  const stored = new Map(rows.map((row) => [row.key, row]));

  const systemRow = stored.get(ASSISTANT_SYSTEM_PROMPT_KEY);
  const fallbackRow = stored.get(ASSISTANT_FALLBACK_PROMPT_KEY);

  const storedSystem = readPrompt(systemRow?.value);
  const storedFallback = readPrompt(fallbackRow?.value);

  const operatorPrompt = storedSystem ?? DEFAULT_TEMPLATES.systemPrompt;
  const fallbackPrompt = storedFallback ?? DEFAULT_TEMPLATES.fallbackPrompt;

  const source: PromptSource =
    storedSystem && storedFallback
      ? 'database'
      : storedSystem || storedFallback
        ? 'mixed'
        : 'default';

  return {
    ok: true,
    prompts: {
      systemPrompt: operatorPrompt,
      operatorPrompt,
      fallbackPrompt,
      source,
      promptSha: digest(operatorPrompt),
      updatedAt: systemRow?.updated_at ?? null,
    },
  };
}