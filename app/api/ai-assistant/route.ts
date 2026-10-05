/**
 * Fleet assistant endpoint.
 *
 * Request flow:
 *   1. Authorise the caller and resolve their `profiles` row (carries the role).
 *   2. Re-read the system and fallback prompts from `system_config` on *every*
 *      request — no cache, so a prompt saved in the Developer portal takes effect
 *      on the next message.
 *   3. Route the question to live query tools and run them on the caller's own
 *      RLS-scoped client.
 *   4. Build the system prompt with a role directive appended.
 *   5. Call the language model if one is configured; otherwise answer from the
 *      retrieved figures directly.
 *
 * Row visibility is RLS's job, not this route's — see `lib/ai/tools.ts` for the
 * per-table policy map and why a driver cannot retrieve fleet-wide rows.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { badRequestResponse, databaseErrorResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import { composeGroundedReply } from '@/lib/ai/grounded-reply';
import { ASSISTANT_SYSTEM_PROMPT_KEY, loadAssistantPrompts } from '@/lib/ai/prompts';
import { runAssistantTools, selectTools, type ToolName } from '@/lib/ai/tools';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['ceo', 'manager', 'driver', 'developer'];

const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY_TURNS = 6;
const LLM_TIMEOUT_MS = 12000;

type HistoryTurn = { role: 'user' | 'assistant'; text: string };

/** Roles whose RLS policies expose other people's records. */
const FLEET_WIDE_ROLES = new Set(['ceo', 'manager', 'developer']);

/**
 * Distinguishes a real key from a placeholder.
 *
 * `OPENAI_API_KEY` ships in `.env.example` with a filler value, and a filled-in
 * placeholder would otherwise trigger a live network call on every message,
 * burn the timeout, and silently fall through — making an unconfigured
 * deployment look slow rather than unconfigured.
 */
function isConfiguredLlmKey(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }

  const key = raw.trim();

  if (key.length < 20) {
    return false;
  }

  return !/^(your|replace|changeme|placeholder|todo|xxx+|sk-xxx)/i.test(key);
}

function sanitizeHistory(value: unknown): HistoryTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (turn): turn is HistoryTurn =>
        Boolean(turn) &&
        typeof turn === 'object' &&
        (turn as HistoryTurn).role !== undefined &&
        typeof (turn as HistoryTurn).text === 'string'
    )
    .map((turn): HistoryTurn => ({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      // Reuse the user-message cap so a client cannot smuggle an unbounded
      // prompt payload past it by routing text through `history`.
      text: turn.text.slice(0, MAX_MESSAGE_LENGTH),
    }))
    .slice(-MAX_HISTORY_TURNS);
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  let payload: { message?: unknown; history?: unknown };

  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return badRequestResponse('Request body must be valid JSON.');
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : '';

  if (!message) {
    return badRequestResponse('A "message" string is required.');
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return badRequestResponse(`Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }

  const history = sanitizeHistory(payload.history);
  const scope = {
    role: auth.profile.role,
    driverId: auth.profile.id,
    driverName: auth.profile.full_name,
    fleetWide: FLEET_WIDE_ROLES.has(auth.profile.role),
  };

  // --- prompts: fresh read, every request -----------------------------------
  const promptLoad = await loadAssistantPrompts(auth.supabase);

  if (!promptLoad.ok) {
    // A genuine database failure must not silently degrade to the bootstrap
    // prompt, which would let an operator believe their saved prompt is in use.
    return databaseErrorResponse(promptLoad.error, 'read assistant system prompt');
  }

  const prompts = promptLoad.prompts;

  // --- live data -------------------------------------------------------------
  const tools = selectTools(message, scope);
  const toolRun = await runAssistantTools(auth.supabase, scope, tools);

  if (!toolRun.ok) {
    return databaseErrorResponse(toolRun.error, 'query fleet data for the assistant');
  }

  const results = toolRun.results;
  const grounded = composeGroundedReply(results, prompts);

  const context = {
    role: scope.role,
    driverName: scope.driverName,
    scope: scope.fleetWide ? 'fleet-wide' : 'own records only',
    findings: results.map((result) => ({
      area: result.tool,
      summary: result.summary,
      facts: result.facts,
      caveat: result.caveat ?? null,
    })),
  };

  // --- model call ------------------------------------------------------------
  let reply = grounded.reply;
  let llm: 'answered' | 'not_configured' | 'error' = 'not_configured';

  if (isConfiguredLlmKey(process.env.OPENAI_API_KEY)) {
    const generated = await generateReply({
      apiKey: process.env.OPENAI_API_KEY as string,
      systemPrompt: prompts.systemPrompt,
      fallbackPrompt: prompts.fallbackPrompt,
      message,
      history,
      context,
    });

    if (generated) {
      reply = generated;
      llm = 'answered';
    } else {
      // The model was reachable in configuration but produced nothing usable.
      // Keep the grounded answer rather than an apology, but mark it so the
      // failure is visible in the response instead of only in the server log.
      llm = 'error';
    }
  }

  return NextResponse.json({
    reply,
    ok: true,
    /** How the reply was produced. Lets the UI label an unconfigured assistant. */
    llm,
    /** True when the text contains figures read from the database this request. */
    dataGrounded: grounded.dataGrounded,
    scope: { role: scope.role, fleetWide: scope.fleetWide },
    toolsRun: tools as ToolName[],
    /**
     * `database` means the operator's saved prompt was used. `default` means the
     * bootstrap text was used — either because nothing is configured yet or
     * because RLS hid the rows from this role. `mixed` is a half-populated table.
     */
    promptSource: prompts.source,
    promptKey: ASSISTANT_SYSTEM_PROMPT_KEY,
    /**
     * Truncated digest of the prompt actually used. Changes as soon as the
     * operator edits the prompt, which is how prompt propagation is verified
     * without exposing the prompt text itself.
     */
    promptSha: prompts.promptSha,
    promptUpdatedAt: prompts.updatedAt,
    caveats: grounded.caveats,
  });
}

type GenerateArgs = {
  apiKey: string;
  systemPrompt: string;
  fallbackPrompt: string;
  message: string;
  history: HistoryTurn[];
  context: Record<string, unknown>;
};

/**
 * Calls the chat completions API, returning `null` on any failure.
 *
 * Deliberately total: an unreachable or erroring model must not take down the
 * assistant, because the retrieved figures are already a usable answer.
 */
async function generateReply(args: GenerateArgs): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: args.systemPrompt },
          ...args.history.map((turn) => ({ role: turn.role, content: turn.text })),
          {
            role: 'user',
            content:
              `Live data retrieved for this question:\n${JSON.stringify(args.context, null, 2)}\n\n` +
              `If this data does not answer the question, say so and follow this instruction: ${args.fallbackPrompt}`,
          },
        ],
        temperature: 0.4,
        max_tokens: 400,
      }),
    });

    if (!response.ok) {
      // Intentionally not surfaced to the caller: the body can echo prompt text
      // and provider internals. The status is enough to diagnose from the logs.
      console.error('[ai-assistant] model call failed', { status: response.status });
      return null;
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return body.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    console.error('[ai-assistant] model call threw', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}