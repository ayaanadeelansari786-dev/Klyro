import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSummaryInput,
  buildSummaryPrompt,
  buildSummarySystemPrompt,
  LOW_COVERAGE_INSTRUCTION,
  needsCoverageCaveat,
  splitSummarySections,
  SUMMARY_SECTIONS,
} from '@/lib/ai/summary';
import type { CategoryResult, Finding, ScanResult } from '@/lib/types';

/*
 * What is testable about a generated document.
 *
 * Not the prose: the model's compliance with the system prompt cannot be
 * asserted without a live call, and a test that tried would be asserting a
 * vendor's behaviour. What *is* under Klyro's control, and is what the
 * feature's honesty depends on, is the input — that the model is handed the
 * top findings and nothing else, that a partly-assessed domain triggers the
 * caveat instruction, and that whatever comes back is laid out in a fixed
 * order rather than the order the model happened to use.
 */

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: over.id ?? `f-${Math.random().toString(36).slice(2, 8)}`,
    category: 'emailSecurity',
    categoryLabel: 'Email Security',
    title: 'A finding',
    severity: 'medium',
    confidence: 'high',
    asset: 'example.test',
    observed: 'Observed something.',
    interpretation: 'Which indicates something.',
    risk: 'Which could lead to something.',
    recommendation: 'Publish a policy.',
    evidence: { test: 't', observed: 'o', verification: 'v' },
    ...over,
  };
}

function result(over: Partial<ScanResult> = {}): ScanResult {
  return {
    domain: 'example.test',
    industry: 'Technology',
    region: 'Global',
    compositeScore: 72,
    riskLevel: 'Moderate Risk',
    categoryScores: {},
    categories: [
      { key: 'dns', label: 'DNS', score: 80, status: 'assessed', findings: [], summary: '', details: [], durationMs: 0 },
    ] as CategoryResult[],
    findings: [],
    coverage: 1,
    scannedAt: new Date().toISOString(),
    toolVersion: 'test',
    persisted: false,
    ...over,
  };
}

describe('summary input', () => {
  it('passes only the top findings, not the whole register', () => {
    const findings = Array.from({ length: 20 }, (_, i) =>
      finding({ id: `f${i}`, severity: 'medium' }),
    );
    expect(buildSummaryInput(result({ findings })).topFindings.length).toBeLessThanOrEqual(5);
  });

  it('carries the recommendation already on file', () => {
    // Rule 2's third part must draw on a real recommendation. Without one in
    // the input, "what to do next" is the one place the prompt would push the
    // model into inventing something.
    const input = buildSummaryInput(
      result({ findings: [finding({ severity: 'high', recommendation: 'Rotate the key.' })] }),
    );
    expect(input.topFindings[0].recommendation).toBe('Rotate the key.');
  });

  it('carries the domain, score, risk level and coverage unchanged', () => {
    const input = buildSummaryInput(result({ compositeScore: 41, coverage: 0.82 }));
    expect(input).toMatchObject({
      domain: 'example.test',
      compositeScore: 41,
      riskLevel: 'Moderate Risk',
      coverage: 0.82,
    });
  });

  it('drops informational findings, which prioritise already excludes', () => {
    const input = buildSummaryInput(
      result({ findings: [finding({ severity: 'info' }), finding({ severity: 'high' })] }),
    );
    expect(input.topFindings).toHaveLength(1);
    expect(input.topFindings[0].severity).toBe('high');
  });
});

describe('the low-coverage caveat', () => {
  it('is not attached when the assessment completed', () => {
    const input = buildSummaryInput(result({ coverage: 0.95 }));
    expect(needsCoverageCaveat(input)).toBe(false);
    expect(buildSummarySystemPrompt(input)).not.toContain(LOW_COVERAGE_INSTRUCTION);
  });

  it('is attached when coverage is below the threshold', () => {
    const input = buildSummaryInput(result({ coverage: 0.36 }));
    expect(needsCoverageCaveat(input)).toBe(true);
    expect(buildSummarySystemPrompt(input)).toContain(LOW_COVERAGE_INSTRUCTION);
  });

  it('tells the model to lead with it, before the score', () => {
    expect(LOW_COVERAGE_INSTRUCTION).toMatch(/first paragraph/i);
    expect(LOW_COVERAGE_INSTRUCTION).toMatch(/before anything about the score/i);
  });

  it('gives the model the reason, not just the number', () => {
    const input = buildSummaryInput(
      result({
        coverage: 0.36,
        categories: [
          { key: 'dns', label: 'DNS', score: 70, status: 'assessed', findings: [], summary: '', details: [], facts: { ipv4: [], ipv6: [] }, durationMs: 0 },
          { key: 'headers', label: 'Headers', score: 0, status: 'unavailable', findings: [], summary: '', details: [], durationMs: 0 },
        ] as CategoryResult[],
      }),
    );
    expect(input.coverageExplanation).toBeTruthy();
    expect(buildSummaryPrompt(input)).toContain('Why coverage is limited');
  });

  it('says so plainly when there is nothing above informational', () => {
    const prompt = buildSummaryPrompt(buildSummaryInput(result({ findings: [] })));
    // Better than an empty list, which the model reads as an omission and
    // fills in.
    expect(prompt).toContain('No findings above informational severity');
  });
});

describe('the three sections', () => {
  it('asks for exactly the headings the layout renders', () => {
    for (const heading of SUMMARY_SECTIONS) {
      expect(buildSummarySystemPrompt(buildSummaryInput(result()))).toContain(heading);
    }
  });

  it('splits clean output into its three parts', () => {
    const { sections } = splitSummarySections(
      `The short version\nIt is in reasonable shape.\n\n` +
        `The biggest thing to know\nOne thing stands out.\n\n` +
        `What to do next\nPublish a policy.`,
    );
    expect(sections.map((s) => s.heading)).toEqual([...SUMMARY_SECTIONS]);
    expect(sections[2].body).toBe('Publish a policy.');
  });

  it('tolerates markdown and numbering around the headings', () => {
    // The model complies with the headings but decorates them, and a document
    // that renders as one wall of text because of two asterisks would be a
    // silly way to lose it.
    const { sections } = splitSummarySections(
      `**1. The short version:**\nFine.\n## The biggest thing to know\nThis.\n*What to do next*\nThat.`,
    );
    expect(sections.map((s) => s.heading)).toEqual([...SUMMARY_SECTIONS]);
    expect(sections[0].body).toBe('Fine.');
  });

  it('keeps anything before the first heading as a lead paragraph', () => {
    // Under the low-coverage instruction this is where the caveat lands.
    const { lead, sections } = splitSummarySections(
      `Only part of this assessment could be completed.\n\nThe short version\nLimited picture.`,
    );
    expect(lead).toBe('Only part of this assessment could be completed.');
    expect(sections).toHaveLength(1);
  });

  it('does not invent a section the model omitted', () => {
    const { sections } = splitSummarySections(`The short version\nFine.`);
    expect(sections).toHaveLength(1);
  });
});

describe('summary generation', () => {
  const original = process.env.GROQ_API_KEY;

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    if (original === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = original;
    vi.unstubAllGlobals();
  });

  it('fails with a reason when no key is configured', async () => {
    delete process.env.GROQ_API_KEY;
    const { generateExecutiveSummary } = await import('@/lib/ai/summary');
    const out = await generateExecutiveSummary(buildSummaryInput(result()));

    expect(out.generated).toBe(false);
    expect(out.summary).toBeNull();
    if (!out.generated) expect(out.reason).toMatch(/not configured/i);
  });

  it('fails with a reason on an API error rather than returning empty prose', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 429 })));
    const { generateExecutiveSummary } = await import('@/lib/ai/summary');
    const out = await generateExecutiveSummary(buildSummaryInput(result()));

    expect(out.generated).toBe(false);
    if (!out.generated) expect(out.reason).toContain('429');
  });

  it('returns the prose and a timestamp on success', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'The short version\nFine.' } }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const { generateExecutiveSummary } = await import('@/lib/ai/summary');
    const out = await generateExecutiveSummary(buildSummaryInput(result()));

    expect(out.generated).toBe(true);
    if (out.generated) expect(Date.parse(out.generatedAt)).not.toBeNaN();
  });
});

/* ------------------------------------------------------------------ *
 * The route
 * ------------------------------------------------------------------ */

const consumeRateLimit = vi.fn();
const loadAssessmentForReport = vi.fn();
const cacheExecutiveSummary = vi.fn(async (..._args: unknown[]) => undefined);
const renderToBuffer = vi.fn(async (..._args: unknown[]) => Buffer.from('%PDF-1.4 fake'));

vi.mock('@/lib/rateLimit', () => ({
  clientKey: () => '203.0.113.9',
  consumeRateLimit: (...args: unknown[]) => consumeRateLimit(...args),
}));

vi.mock('@/lib/dataset/assessments', () => ({
  loadAssessmentForReport: (...args: unknown[]) => loadAssessmentForReport(...args),
  cacheExecutiveSummary: (...args: unknown[]) => cacheExecutiveSummary(...args),
}));

vi.mock('@/lib/supabase/server', () => ({ createClientForRequest: () => ({}) }));

vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => renderToBuffer(...args),
  Document: 'Document',
  Page: 'Page',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (x: unknown) => x },
  Font: { register: () => undefined, registerHyphenationCallback: () => undefined },
  Svg: 'Svg',
  Rect: 'Rect',
  Circle: 'Circle',
  Path: 'Path',
  Line: 'Line',
}));

function summaryRequest(body: unknown) {
  return new Request('https://klyro.test/api/report/summary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ANON_RESULT = {
  domain: 'example.test',
  industry: 'Technology',
  region: 'Global',
  compositeScore: 72,
  riskLevel: 'Moderate Risk',
  coverage: 1,
  categories: [{ key: 'dns' }],
  findings: [],
  scannedAt: new Date().toISOString(),
  toolVersion: 'test',
};

describe('POST /api/report/summary', () => {
  const original = process.env.GROQ_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    consumeRateLimit.mockResolvedValue({ allowed: true, remaining: 29, retryAfterSeconds: 0, refund: async () => undefined });
    process.env.GROQ_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (original === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = original;
    vi.unstubAllGlobals();
  });

  it('refuses with a clear status when no generator is configured', async () => {
    delete process.env.GROQ_API_KEY;
    const { POST } = await import('@/app/api/report/summary/route');
    const response = await POST(summaryRequest({ result: ANON_RESULT }));

    // A summary PDF with no summary has no reason to exist, so this is the one
    // AI surface that does not degrade silently.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'SUMMARY_UNAVAILABLE' });
    expect(renderToBuffer).not.toHaveBeenCalled();
  });

  it('returns a non-200 rather than a broken PDF when generation fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    const { POST } = await import('@/app/api/report/summary/route');
    const response = await POST(summaryRequest({ result: ANON_RESULT }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'SUMMARY_GENERATION_FAILED' });
    expect(renderToBuffer).not.toHaveBeenCalled();
  });

  it('renders a PDF on the anonymous path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: 'The short version\nFine.' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const { POST } = await import('@/app/api/report/summary/route');
    const response = await POST(summaryRequest({ result: ANON_RESULT }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    // Nothing to cache to: an anonymous scan is never stored.
    expect(cacheExecutiveSummary).not.toHaveBeenCalled();
  });

  it('renders from the stored assessment and caches the result', async () => {
    loadAssessmentForReport.mockResolvedValue({
      result: { ...ANON_RESULT, categories: [], findings: [] },
      benchmark: null,
      orgId: null,
      contributesToBenchmark: false,
      executiveSummary: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: 'The short version\nFine.' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const { POST } = await import('@/app/api/report/summary/route');
    const response = await POST(
      summaryRequest({ assessmentId: '11111111-2222-3333-4444-555555555555' }),
    );

    expect(response.status).toBe(200);
    expect(cacheExecutiveSummary).toHaveBeenCalledTimes(1);
  });

  it('reuses a cached summary without calling the model again', async () => {
    loadAssessmentForReport.mockResolvedValue({
      result: { ...ANON_RESULT, categories: [], findings: [] },
      benchmark: null,
      orgId: null,
      contributesToBenchmark: false,
      executiveSummary: {
        summary: 'The short version\nAlready written.',
        generated: true,
        generatedAt: new Date().toISOString(),
      },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { POST } = await import('@/app/api/report/summary/route');
    const response = await POST(
      summaryRequest({ assessmentId: '11111111-2222-3333-4444-555555555555' }),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cacheExecutiveSummary).not.toHaveBeenCalled();
  });

  it('answers 404 for an assessment the caller may not read', async () => {
    loadAssessmentForReport.mockResolvedValue(null);
    const { POST } = await import('@/app/api/report/summary/route');
    const response = await POST(
      summaryRequest({ assessmentId: '11111111-2222-3333-4444-555555555555' }),
    );
    expect(response.status).toBe(404);
  });

  it('shares the report ceiling rather than getting a softer one of its own', async () => {
    consumeRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 60, refund: async () => undefined });
    const { POST } = await import('@/app/api/report/summary/route');
    const response = await POST(summaryRequest({ result: ANON_RESULT }));

    expect(response.status).toBe(429);
    expect(consumeRateLimit).toHaveBeenCalledWith('report:203.0.113.9', 30);
  });
});
