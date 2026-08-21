/**
 * The model layer, and the guardrail around it.
 *
 * Klyro's whole claim is that it never asserts more than it observed. A
 * language model is the single largest threat to that claim, because it will
 * happily produce a confident sentence about a registrar it has never seen.
 * The defence here is not the prompt alone — prompts are advisory — it is that
 * the model is only ever handed a closed set of facts that this scan actually
 * produced, and that everything it returns is marked in the interface as
 * generated rather than measured.
 *
 * Three properties every caller depends on:
 *
 * - It never throws. A missing key, a timeout, a 500 from Groq and a malformed
 *   body all return the same discriminated failure.
 * - It never blocks. Callers are on a wall-clock budget; see `withDeadline`.
 * - It never invents the absence of a key. Not configured is reported as a
 *   reason, not silently treated as an empty answer.
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Overridable because model names on hosted inference services are retired
 * with some regularity — and this one was. `llama-3.3-70b-versatile` was
 * withdrawn, every call became a 404, and both features degraded to "no
 * context available", which is the one failure mode that looks like normal
 * operation. The default is now a model that exists; the override is what
 * makes the next retirement a one-line change rather than a deploy.
 */
const MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';

/**
 * How much silent deliberation the model may do before answering.
 *
 * This exists because reasoning tokens are billed against `max_tokens` on the
 * gpt-oss family, and at the default effort they consume the entire budget: a
 * finding note asking for four sentences produced 1,938 characters of
 * reasoning and *zero* characters of answer at 200, 500 and 800 tokens alike.
 * At `low` the same request settles in 155 tokens and answers properly.
 *
 * A string rather than a boolean, and overridable, because support for it is
 * not universal — `qwen3.6` accepts only `none` or `default`, and
 * `groq/compound` and `allam-2-7b` reject the field outright. Set it empty to
 * omit the field entirely.
 */
const REASONING_EFFORT = process.env.GROQ_REASONING_EFFORT ?? 'low';

/**
 * Set once a model has told us it will not accept `reasoning_effort`.
 *
 * Without this, every request would spend a wasted round trip discovering the
 * same thing — and narration issues up to six per scan, so a mismatched model
 * would double its own cost for the life of the process.
 */
let reasoningEffortRejected = false;

export interface GroqCallOptions {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  /** Low but not zero: at 0 the model repeats stock phrasing across findings. */
  temperature?: number;
}

export type GroqText =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export function isGroqConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

/**
 * One request, one place where every way it can fail is handled.
 *
 * The brief sketched this transport twice, once per feature. It is one
 * function instead: the timeout, the non-2xx branch, the empty-body branch and
 * the never-throw guarantee are exactly the parts that must not drift between
 * the two callers.
 */
export async function callGroq(options: GroqCallOptions): Promise<GroqText> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ok: false, reason: 'GROQ_API_KEY is not configured' };

  const send = (withEffort: boolean) =>
    fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens,
        ...(withEffort ? { reasoning_effort: REASONING_EFFORT } : {}),
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });

  try {
    const useEffort = Boolean(REASONING_EFFORT) && !reasoningEffortRejected;
    let res = await send(useEffort);

    /*
     * One retry, only for the one thing worth retrying.
     *
     * Support for `reasoning_effort` varies by model and the value that is
     * legal varies too, so an override that is right for the default model can
     * be a hard 400 for another. Rather than make the operator discover that
     * the way this bug was discovered, the field is dropped and the request is
     * repeated once — after which the process stops sending it at all.
     */
    if (useEffort && res.status === 400) {
      const body = await res.clone().text();
      if (body.includes('reasoning_effort')) {
        reasoningEffortRejected = true;
        res = await send(false);
      }
    }

    if (!res.ok) {
      /*
       * The status alone is not enough to act on. `Groq returned 404` is true
       * of a retired model, a typo in the override and a wrong base URL alike,
       * and the body says which — this one read `The model
       * llama-3.3-70b-versatile does not exist`. It reaches the summary
       * endpoint's `reason` field, so the next failure of this kind diagnoses
       * itself.
       */
      const detail = await res.text().catch(() => '');
      let message = detail.slice(0, 300);
      try {
        message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        /* Not JSON. The truncated body is still better than nothing. */
      }
      return {
        ok: false,
        reason: `Groq returned ${res.status}${message ? `: ${message}` : ''}`,
      };
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = data.choices?.[0];
    const text = choice?.message?.content?.trim();

    if (!text) {
      /*
       * `length` here means the budget was spent without an answer arriving,
       * which on a reasoning model means it was spent thinking. Named
       * separately because "empty completion" sent somebody looking at the
       * prompt when the fix was one field.
       */
      return {
        ok: false,
        reason:
          choice?.finish_reason === 'length'
            ? `Groq spent its ${options.maxTokens}-token budget without producing an answer (finish_reason=length); raise max_tokens or lower GROQ_REASONING_EFFORT`
            : 'Groq returned an empty completion',
      };
    }

    return { ok: true, text };
  } catch (error) {
    // Includes the abort from `AbortSignal.timeout`, DNS failure, and a body
    // that is not JSON. None of them is worth distinguishing to a caller whose
    // only option is to carry on without the text.
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Groq request failed: ${reason}` };
  }
}

/* ------------------------------------------------------------------ *
 * Per-finding context
 * ------------------------------------------------------------------ */

export interface NarrationInput {
  category: string;
  categoryLabel: string;
  severity: string;
  observed: string;
  interpretation: string;
  /** Facts this same scan produced. The model may use nothing else. */
  relatedFacts: Record<string, unknown>;
}

/** The sentinel the model is told to emit when it has nothing to add. */
const NO_CONTEXT = 'NO_ADDITIONAL_CONTEXT';

export const FINDING_SYSTEM_PROMPT = `You write a short contextual note (2-4 sentences, under 80 words) that follows a security finding in a report read by non-technical readers (finance, procurement, executives).

Rules, all mandatory:
1. You may ONLY use facts given to you in the input. Never invent a specific detail — no fabricated dates, numbers, company facts, or technical specifics not provided.
2. Give the honest RANGE of explanations for an ambiguous finding, not one asserted answer. If multiple explanations are plausible, name them and say what would distinguish them.
3. If related facts from the same scan are provided, use them to narrow the range — cite them explicitly ("Klyro also found X, which suggests...").
4. Never contradict or soften the severity already assigned. Your job is added context, not a second opinion on risk level.
5. Never use the words "hacked", "breach", "attack" unless the original finding text already uses them.
6. Write in third person, plain English, no jargon beyond what the original finding already used.
7. If you don't have enough grounding facts to say anything beyond restating the finding, output exactly: ${NO_CONTEXT}`;

export function buildFindingPrompt(input: NarrationInput): string {
  return `Finding category: ${input.categoryLabel}
Severity: ${input.severity}
Observed: ${input.observed}
Interpretation: ${input.interpretation}
Related facts from this same scan: ${JSON.stringify(input.relatedFacts, null, 2)}

Write the contextual note now.`;
}

export interface AiContext {
  narrative: string | null;
  generated: boolean;
  /** Present when `generated` is false. Never shown to a reader. */
  reason?: string;
  generatedAt?: string;
}

export async function generateNarration(
  input: NarrationInput,
  timeoutMs = 8_000,
): Promise<AiContext> {
  /*
   * No facts, no note.
   *
   * Checked here rather than left to rule 7, because rule 7 is a request and
   * this is a guarantee. A model handed an empty object still produces
   * fluent-sounding text about the category in general, and general text about
   * a category is exactly the ungrounded claim this feature must not make.
   */
  if (Object.keys(input.relatedFacts).length === 0) {
    return { narrative: null, generated: false, reason: 'No grounding facts for this category' };
  }

  const result = await callGroq({
    system: FINDING_SYSTEM_PROMPT,
    user: buildFindingPrompt(input),
    // Measured: 155 tokens for a real finding at `low` reasoning effort. 200
    // was the original guess and left no margin — a slightly longer set of
    // grounding facts would have run the budget out and produced nothing,
    // which is indistinguishable from having nothing to say.
    maxTokens: 400,
    timeoutMs,
  });

  if (!result.ok) return { narrative: null, generated: false, reason: result.reason };

  if (result.text === NO_CONTEXT || result.text.includes(NO_CONTEXT)) {
    return { narrative: null, generated: false, reason: 'Model reported no additional context' };
  }

  return { narrative: result.text, generated: true, generatedAt: new Date().toISOString() };
}
