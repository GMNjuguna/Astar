/**
 * Deterministic reply composer.
 *
 * Used when no language model is configured, and as the safety net when a
 * configured model fails. It exists because the assistant should not degrade to
 * a single hardcoded paragraph: with the query tools in place, real figures are
 * available, and presenting them directly is more useful — and more honest —
 * than pretending a model answered.
 *
 * This is also where the operator's *fallback* prompt becomes visible to end
 * users. It is appended only when the data could not answer the question, which
 * is precisely the situation it was written for: a control that changes nothing
 * is indistinguishable from a broken one.
 */
import type { LoadedPrompts } from '@/lib/ai/prompts';
import type { ToolResult } from '@/lib/ai/tools';

/**
 * A tool result counts as "substantive" when it actually reports something. All
 * counts and sums being zero means the question is unanswerable from the data,
 * which is a different situation from having answered it with zeroes.
 */
function isSubstantive(result: ToolResult): boolean {
  const facts = result.facts;

  const numericValues = Object.entries(facts)
    .filter(([, value]) => typeof value === 'number')
    .map(([, value]) => value as number);

  if (numericValues.length === 0) {
    // No numbers at all (e.g. a list-only result). Treat as substantive.
    return true;
  }

  return numericValues.some((value) => value > 0);
}

export type GroundedReply = {
  reply: string;
  /** True when the text quotes figures read from the database. */
  dataGrounded: boolean;
  caveats: string[];
};

export function composeGroundedReply(results: ToolResult[], prompts: LoadedPrompts): GroundedReply {
  const caveats = results.map((result) => result.caveat).filter((value): value is string => Boolean(value));
  const substantive = results.filter(isSubstantive);

  if (substantive.length === 0) {
    const lines = [
      'I could not find any matching records for that question.',
      'There is nothing on file for the areas you asked about yet, so I would rather tell you that than quote a number I cannot stand behind.',
      '',
      prompts.fallbackPrompt,
    ];

    if (caveats.length > 0) {
      lines.push('', `Note: ${caveats.join(' ')}`);
    }

    return { reply: lines.join('\n').trim(), dataGrounded: false, caveats };
  }

  const lines = substantive.map((result) => result.summary);

  if (results.length > substantive.length) {
    const empty = results.filter((result) => !isSubstantive(result)).map((result) => result.summary);
    lines.push(...empty);
  }

  if (caveats.length > 0) {
    lines.push('', `Note: ${caveats.join(' ')}`);
  }

  return { reply: lines.join('\n').trim(), dataGrounded: true, caveats };
}