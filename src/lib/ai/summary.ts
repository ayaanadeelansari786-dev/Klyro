import { LOW_COVERAGE_THRESHOLD, explainLowCoverage, prioritise } from '@/lib/scoring';
import type { ScanResult } from '@/lib/types';

import { callGroq } from './groq';

/**
 * The plain-language summary.
 *
 * Built from the same `ScanResult` the full report renders, never from a
 * re-scan and never from a different query. That is what makes it impossible
 * for the two documents to contradict each other: they are two views of one
 * dataset, and the short one is a projection of the long one rather than a
 * second opinion about the same domain.
 *
 * Unlike the per-finding notes, this one fails loudly. A finding without its
 * note loses a paragraph among many; a summary document without its summary
 * has nothing left in it, and handing someone a blank page under Klyro's
 * letterhead is worse than telling them the generator was unavailable.
 */

/** The three headings the model is required to produce, in order. */
export const SUMMARY_SECTIONS = [
  'The short version',
  'The biggest thing to know',
  'What to do next',
] as const;

export const SUMMARY_SYSTEM_PROMPT = `You write a one-page plain-language summary of a security assessment for someone with zero technical background — a finance director, a procurement lead, someone reading this once and moving on.

Rules, all mandatory:
1. Use ONLY the domain, score, risk level, coverage, and findings given to you. Never invent a company fact, a statistic, a date, or a technical detail not in the input.
2. Structure your output in exactly three short parts, each 2-4 sentences, each introduced by its heading on its own line, exactly as written here:
${SUMMARY_SECTIONS.map((h) => `   ${h}`).join('\n')}
   - "${SUMMARY_SECTIONS[0]}" — is this domain in reasonable shape or not, in one plain sentence, then why.
   - "${SUMMARY_SECTIONS[1]}" — the single highest-priority finding, explained with zero jargon. If there is no significant finding, say so plainly instead of manufacturing concern.
   - "${SUMMARY_SECTIONS[2]}" — one or two concrete next steps, taken directly from the recommended actions already present in the findings. Do not invent a recommendation not already implied by the findings.
3. Never use words like "hacked," "breach," "attacked," "vulnerable to attackers" unless a finding's own severity is Critical or High and its own text already implies that level of concern.
4. No jargon: no "DMARC," "SPF," "DNSSEC," "CSP" as bare acronyms — describe what they do in one plain clause if you need to mention them at all, or just describe the underlying concern without naming the mechanism.
5. Total length under 220 words. This is read once, quickly — brevity is the point.
6. Do not restate the numeric score. The reader has already seen it; focus on meaning, not on repeating numbers.`;

/**
 * The extra instruction a partly-assessed domain gets.
 *
 * Separated from the base prompt rather than always present, because an
 * instruction about low coverage that arrives on every scan is one the model
 * starts applying to scans that do not have the problem — it begins hedging a
 * complete assessment. It is appended only when it is true.
 */
export const LOW_COVERAGE_INSTRUCTION = `IMPORTANT: coverage for this assessment is below 60%. Your first paragraph must say plainly, before anything about the score or the findings, that only part of the assessment could be completed, and give the reason supplied in the input. Do not present the score as a full picture of this domain.`;

export interface SummaryInput {
  domain: string;
  compositeScore: number;
  riskLevel: string;
  coverage: number;
  /** Why coverage is low. Only set when it is. */
  coverageExplanation?: string;
  topFindings: {
    category: string;
    severity: string;
    observed: string;
    interpretation: string;
    recommendation: string;
  }[];
}

/**
 * The scoped input the model sees.
 *
 * Only the highest-priority findings, ranked by the existing severity ×
 * confidence × exposure logic. Passing the whole register would bury the one
 * finding the reader needs and invite the model to pick something else as the
 * headline.
 */
export function buildSummaryInput(result: ScanResult, limit = 5): SummaryInput {
  const ranked = prioritise(result.findings, limit);

  return {
    domain: result.domain,
    compositeScore: result.compositeScore,
    riskLevel: result.riskLevel,
    coverage: result.coverage,
    coverageExplanation:
      result.coverage < LOW_COVERAGE_THRESHOLD ? explainLowCoverage(result) : undefined,
    topFindings: ranked.map((p) => ({
      category: p.finding.categoryLabel,
      severity: p.finding.severity,
      observed: p.finding.observed,
      interpretation: p.finding.interpretation,
      // Carried so rule 2's third part has something real to draw on. Without
      // it the model has to invent a next step, which is the one place this
      // prompt would otherwise push it into making something up.
      recommendation: p.finding.recommendation,
    })),
  };
}

/** True when the summary must lead with the coverage caveat. */
export function needsCoverageCaveat(input: SummaryInput): boolean {
  return input.coverage < LOW_COVERAGE_THRESHOLD;
}

export function buildSummarySystemPrompt(input: SummaryInput): string {
  return needsCoverageCaveat(input)
    ? `${SUMMARY_SYSTEM_PROMPT}\n\n${LOW_COVERAGE_INSTRUCTION}`
    : SUMMARY_SYSTEM_PROMPT;
}

export function buildSummaryPrompt(input: SummaryInput): string {
  const findings = input.topFindings.length
    ? input.topFindings
        .map(
          (f, i) =>
            `${i + 1}. [${f.severity}] ${f.category}: ${f.observed} — ${f.interpretation} ` +
            `Recommended action already on file: ${f.recommendation}`,
        )
        .join('\n')
    : 'No findings above informational severity were recorded.';

  const coverageLine = input.coverageExplanation
    ? `\nWhy coverage is limited: ${input.coverageExplanation}`
    : '';

  return `Domain: ${input.domain}
Composite score: ${input.compositeScore}/100
Risk level: ${input.riskLevel}
Coverage: ${Math.round(input.coverage * 100)}%${coverageLine}

Top findings (already ranked by priority):
${findings}

Write the three-part summary now.`;
}

export type SummaryResult =
  | { summary: string; generated: true; generatedAt: string }
  | { summary: null; generated: false; reason: string };

export async function generateExecutiveSummary(
  input: SummaryInput,
  timeoutMs = 10_000,
): Promise<SummaryResult> {
  const result = await callGroq({
    system: buildSummarySystemPrompt(input),
    user: buildSummaryPrompt(input),
    /*
     * Measured against the real prompt: at 350 the response stopped on
     * `length` having produced none of the three sections; at 600 it stopped
     * on its own having used 442. The gap between those two numbers is the
     * whole reason this is not set to the length of the document — the model
     * spends tokens before it starts writing, and the answer is the last thing
     * to arrive, so a budget sized to the prose truncates the final section.
     * "What to do next" is the section a reader acts on, and it is the one
     * that disappears.
     */
    maxTokens: 700,
    timeoutMs,
  });

  if (!result.ok) return { summary: null, generated: false, reason: result.reason };

  return { summary: result.text, generated: true, generatedAt: new Date().toISOString() };
}

/**
 * Splits the model's prose into the three parts the layout expects.
 *
 * Tolerant on purpose. The model is asked for three exact headings and mostly
 * complies, but it also likes markdown bold and numbered prefixes, and a
 * summary that renders as one wall of text because of two asterisks would be a
 * silly way to lose the document. Anything before the first recognised heading
 * is kept as a lead paragraph rather than discarded — under the low-coverage
 * instruction that is where the caveat lands.
 */
export function splitSummarySections(
  text: string,
): { lead: string; sections: { heading: string; body: string }[] } {
  const lines = text.split('\n');
  const sections: { heading: string; body: string[] }[] = [];
  const lead: string[] = [];

  const headingOf = (line: string): string | null => {
    const stripped = line.replace(/[*_#>]/g, '').replace(/^\s*\d+[.)]\s*/, '').trim();
    const bare = stripped.replace(/[:.]$/, '').trim().toLowerCase();
    return SUMMARY_SECTIONS.find((h) => h.toLowerCase() === bare) ?? null;
  };

  for (const line of lines) {
    const heading = headingOf(line);
    if (heading) {
      sections.push({ heading, body: [] });
      continue;
    }
    const clean = line.replace(/^[*_#>\s]+|[*_]+$/g, '').trimEnd();
    if (!clean.trim()) continue;
    if (sections.length === 0) lead.push(clean);
    else sections[sections.length - 1].body.push(clean);
  }

  return {
    lead: lead.join(' ').trim(),
    sections: sections.map((s) => ({ heading: s.heading, body: s.body.join(' ').trim() })),
  };
}
