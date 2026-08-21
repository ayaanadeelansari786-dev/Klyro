import { prioritise } from '@/lib/scoring';
import type { Finding, ScanResult, Severity } from '@/lib/types';

import { generateNarration, isGroqConfigured, type AiContext } from './groq';
import { groundingFactsFor } from './groundingFacts';

/**
 * Narration for a completed scan, inside a budget.
 *
 * The brief asked for a note on every finding of medium severity or above.
 * Taken literally that is unbounded: a domain with a large estate produces
 * fifteen or more, and fifteen sequential calls at an eight-second timeout is
 * two minutes of wall clock on a route whose `maxDuration` is sixty seconds —
 * and which has already spent twenty to forty-five of them scanning. The
 * failure would not be a slow report; it would be the function being killed
 * after the scan completed but before the result was persisted or sent.
 *
 * So three limits, all of them about the scan surviving rather than about
 * cost:
 *
 * - Only the highest-priority findings are narrated, ranked by the existing
 *   severity × confidence × exposure logic. A note on the fourteenth finding
 *   is not read.
 * - They run concurrently, in a small pool.
 * - The whole pass is bounded by wall clock. When the budget is gone the
 *   remaining findings are left un-narrated with a recorded reason, which is
 *   the same shape as any other failure and renders as nothing.
 *
 * Nothing here can fail the scan. Every path returns findings.
 */

/** Severities worth a note. `low` and `info` are skipped — see the brief. */
const NARRATED_SEVERITIES: Severity[] = ['critical', 'high', 'medium'];

/** How many findings may carry a note, at most. */
const MAX_NARRATED = 6;

/** How many Groq requests are in flight at once. */
const CONCURRENCY = 3;

/** Wall clock for the whole pass, well inside what the scan route has left. */
const TOTAL_BUDGET_MS = 9_000;

/** Ceiling for any single request; shortened when less budget remains. */
const PER_CALL_TIMEOUT_MS = 7_000;

export function isNarratable(finding: Finding): boolean {
  return NARRATED_SEVERITIES.includes(finding.severity);
}

/**
 * Which findings get a note, in order.
 *
 * `prioritise` already drops `info` and ranks by consequence; this narrows
 * further to medium and above and takes the top few.
 */
export function selectForNarration(findings: Finding[], limit = MAX_NARRATED): Finding[] {
  return prioritise(findings, findings.length)
    .map((p) => p.finding)
    .filter(isNarratable)
    .slice(0, limit);
}

/**
 * Returns a copy of `result` whose findings carry `aiContext` where one was
 * produced. The input is not mutated: `findings` is also referenced from
 * `categories[].findings`, and editing in place would put the note in two
 * places that are separately serialised.
 */
export async function narrateFindings(result: ScanResult): Promise<ScanResult> {
  if (!isGroqConfigured()) return result;

  const selected = selectForNarration(result.findings);
  if (selected.length === 0) return result;

  const startedAt = Date.now();
  const contexts = new Map<string, AiContext>();
  const queue = [...selected];

  async function worker() {
    for (;;) {
      const finding = queue.shift();
      if (!finding) return;

      const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      if (remaining <= 500) {
        contexts.set(finding.id, {
          narrative: null,
          generated: false,
          reason: 'Narration budget for this scan was exhausted',
        });
        continue;
      }

      const facts = groundingFactsFor(finding.category, result);

      contexts.set(
        finding.id,
        await generateNarration(
          {
            category: finding.category,
            categoryLabel: finding.categoryLabel,
            severity: finding.severity,
            observed: finding.observed,
            interpretation: finding.interpretation,
            relatedFacts: facts,
          },
          Math.min(PER_CALL_TIMEOUT_MS, remaining),
        ),
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));

  const withContext = (finding: Finding): Finding => {
    const context = contexts.get(finding.id);
    return context ? { ...finding, aiContext: context } : finding;
  };

  return {
    ...result,
    findings: result.findings.map(withContext),
    // The same findings are reachable through their category, and the PDF
    // reads them from there. Both copies have to carry the note or the
    // dashboard and the report disagree about what was generated.
    categories: result.categories.map((category) => ({
      ...category,
      findings: category.findings.map(withContext),
    })),
  };
}
