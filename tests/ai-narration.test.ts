import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groundingFactsFor } from '@/lib/ai/groundingFacts';
import { isNarratable, selectForNarration } from '@/lib/ai/narrate';
import type { CategoryResult, Finding, ScanResult, Severity } from '@/lib/types';

/*
 * The guardrail, not the prose.
 *
 * Nothing here asserts what the model says — that is not controllable and a
 * test that pinned it would be pinning the weather. What is controllable, and
 * what the feature's credibility actually rests on, is the closed set of facts
 * the model is handed: that it comes from this scan, that it contains nothing
 * the modules did not report, and that an empty set stops a narration being
 * attempted at all.
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
    recommendation: 'Do something.',
    evidence: { test: 't', observed: 'o', verification: 'v' },
    ...over,
  };
}

function category(over: Partial<CategoryResult> = {}): CategoryResult {
  return {
    key: 'emailSecurity',
    label: 'Email Security',
    score: 60,
    status: 'assessed',
    findings: [],
    summary: 's',
    details: [],
    durationMs: 0,
    ...over,
  } as CategoryResult;
}

function result(categories: CategoryResult[], findings: Finding[] = []): ScanResult {
  return {
    domain: 'example.test',
    industry: 'Technology',
    region: 'Global',
    compositeScore: 70,
    riskLevel: 'Moderate Risk',
    categoryScores: {},
    categories,
    findings,
    coverage: 1,
    scannedAt: new Date().toISOString(),
    toolVersion: 'test',
    persisted: false,
  };
}

describe('grounding facts', () => {
  it('reads from the category the scan actually produced', () => {
    const facts = groundingFactsFor(
      'emailSecurity',
      result([
        category({
          key: 'emailSecurity',
          facts: { spfQualifier: '-all', dmarcPolicy: null, dkimSelectors: ['s1', 's2'] },
        }),
      ]),
    );

    expect(facts.spfQualifier).toBe('-all');
    expect(facts.dmarcPolicy).toBeNull();
    expect(facts.dkimSelectorsFound).toBe('s1, s2');
  });

  it('returns nothing for a category the scan did not assess', () => {
    // An unavailable module has no observations. Narrating one would be
    // narrating a failure to look.
    expect(
      groundingFactsFor(
        'dns',
        result([category({ key: 'dns', status: 'unavailable', facts: { ipv4: ['1.2.3.4'] } })]),
      ),
    ).toEqual({});
  });

  it('returns nothing when the module ran but emitted no facts', () => {
    expect(groundingFactsFor('dns', result([category({ key: 'dns' })]))).toEqual({});
  });

  it('returns nothing for a category with no selector', () => {
    expect(groundingFactsFor('notARealCategory', result([category()]))).toEqual({});
  });

  it('omits fields the module did not report rather than passing them as null', () => {
    // A null in the prompt reads to a model as an observed absence. An absent
    // key reads as nothing at all, which is the truth.
    const facts = groundingFactsFor(
      'whois',
      result([category({ key: 'whois', facts: { registrar: 'Example Registrar' } })]),
    );

    expect(facts).toEqual({ registrar: 'Example Registrar' });
    expect('transferLocked' in facts).toBe(false);
  });

  it('never emits a key the module did not produce', () => {
    const emitted = { spfQualifier: '~all', spfLookups: 4, dmarcPolicy: 'none', dmarcPct: 100 };
    const facts = groundingFactsFor(
      'emailSecurity',
      result([category({ key: 'emailSecurity', facts: emitted })]),
    );

    // Every grounded value must trace back to something in `emitted`.
    const values = Object.values(facts);
    for (const value of values) {
      expect(Object.values(emitted)).toContain(value as never);
    }
  });

  it('summarises a long list instead of pasting the whole thing', () => {
    const facts = groundingFactsFor(
      'subdomains',
      result([
        category({
          key: 'subdomains',
          facts: { flagged: ['a.test', 'b.test', 'c.test', 'd.test', 'e.test'] },
        }),
      ]),
    );

    expect(String(facts.flaggedHostnames)).toContain('5 total');
    expect(String(facts.flaggedHostnames)).not.toContain('e.test');
  });
});

describe('which findings are narrated', () => {
  it('covers medium and above, and nothing below', () => {
    const tiers: [Severity, boolean][] = [
      ['critical', true],
      ['high', true],
      ['medium', true],
      ['low', false],
      ['info', false],
    ];
    for (const [severity, expected] of tiers) {
      expect(isNarratable(finding({ severity }))).toBe(expected);
    }
  });

  it('never selects an info or low finding', () => {
    const selected = selectForNarration([
      finding({ id: 'a', severity: 'info' }),
      finding({ id: 'b', severity: 'low' }),
      finding({ id: 'c', severity: 'high' }),
    ]);

    expect(selected.map((f) => f.id)).toEqual(['c']);
  });

  it('is capped, so a large estate cannot spend the whole scan budget', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      finding({ id: `f${i}`, severity: 'high' }),
    );
    expect(selectForNarration(many).length).toBeLessThanOrEqual(6);
  });

  it('takes the highest-priority findings first', () => {
    const selected = selectForNarration(
      [
        finding({ id: 'medium-low-conf', severity: 'medium', confidence: 'low' }),
        finding({ id: 'critical', severity: 'critical', confidence: 'high' }),
      ],
      1,
    );
    expect(selected[0].id).toBe('critical');
  });
});

describe('narration transport', () => {
  const original = process.env.GROQ_API_KEY;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = original;
    vi.unstubAllGlobals();
  });

  it('reports a missing key as a reason rather than an empty answer', async () => {
    delete process.env.GROQ_API_KEY;
    const { generateNarration } = await import('@/lib/ai/groq');

    const out = await generateNarration({
      category: 'dns',
      categoryLabel: 'DNS Configuration',
      severity: 'medium',
      observed: 'o',
      interpretation: 'i',
      relatedFacts: { dnssecValidating: false },
    });

    expect(out.generated).toBe(false);
    expect(out.narrative).toBeNull();
    expect(out.reason).toMatch(/not configured/i);
  });

  it('refuses to call the model at all with no grounding facts', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { generateNarration } = await import('@/lib/ai/groq');

    const out = await generateNarration({
      category: 'dns',
      categoryLabel: 'DNS Configuration',
      severity: 'medium',
      observed: 'o',
      interpretation: 'i',
      relatedFacts: {},
    });

    expect(out.generated).toBe(false);
    // The guarantee, not the request. A model handed an empty object still
    // writes fluent prose about the category in general, which is exactly the
    // ungrounded claim this feature must never make.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('turns an API failure into a reason and never throws', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const { generateNarration } = await import('@/lib/ai/groq');

    const out = await generateNarration({
      category: 'dns',
      categoryLabel: 'DNS Configuration',
      severity: 'medium',
      observed: 'o',
      interpretation: 'i',
      relatedFacts: { dnssecValidating: true },
    });

    expect(out).toMatchObject({ generated: false, narrative: null });
    expect(out.reason).toContain('500');
  });

  it('turns a thrown transport error into a reason and never throws', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    const { generateNarration } = await import('@/lib/ai/groq');

    await expect(
      generateNarration({
        category: 'dns',
        categoryLabel: 'DNS Configuration',
        severity: 'medium',
        observed: 'o',
        interpretation: 'i',
        relatedFacts: { dnssecValidating: true },
      }),
    ).resolves.toMatchObject({ generated: false });
  });

  it('stores a successful narration with its timestamp', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: '  A grounded note.  ' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const { generateNarration } = await import('@/lib/ai/groq');

    const out = await generateNarration({
      category: 'dns',
      categoryLabel: 'DNS Configuration',
      severity: 'medium',
      observed: 'o',
      interpretation: 'i',
      relatedFacts: { dnssecValidating: true },
    });

    expect(out.generated).toBe(true);
    expect(out.narrative).toBe('A grounded note.');
    expect(Date.parse(out.generatedAt ?? '')).not.toBeNaN();
  });

  it('treats the model’s own refusal sentinel as no context', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: 'NO_ADDITIONAL_CONTEXT' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const { generateNarration } = await import('@/lib/ai/groq');

    const out = await generateNarration({
      category: 'dns',
      categoryLabel: 'DNS Configuration',
      severity: 'medium',
      observed: 'o',
      interpretation: 'i',
      relatedFacts: { dnssecValidating: true },
    });

    expect(out.generated).toBe(false);
    expect(out.narrative).toBeNull();
  });
});

describe('narration survives the report sanitiser', () => {
  it('carries a generated note through, and drops a claimed one', async () => {
    const { sanitiseScanResult } = await import('@/lib/reportPayload');

    const verdict = sanitiseScanResult(
      {
        categories: [{ key: 'dns' }],
        findings: [
          { ...finding({ id: 'kept' }), aiContext: { narrative: 'Real note.', generated: true } },
          // `generated: false` with prose attached is a caller trying to have
          // it both ways. The text is dropped rather than relabelled.
          { ...finding({ id: 'dropped' }), aiContext: { narrative: 'Fake.', generated: false } },
        ],
      },
      'example.test',
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.result?.findings[0].aiContext?.narrative).toBe('Real note.');
    expect(verdict.result?.findings[1].aiContext).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Regressions from the 1.4.0 Groq outage
 * ------------------------------------------------------------------ */

/** The JSON body of the nth fetch call, typed so tsc can see it. */
function sentBody(spy: { mock: { calls: unknown[][] } }, n: number): Record<string, unknown> {
  const init = spy.mock.calls[n]?.[1] as { body?: string } | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

describe('transport diagnostics', () => {
  const original = { key: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL, effort: process.env.GROQ_REASONING_EFFORT };

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    for (const [k, v] of [['GROQ_API_KEY', original.key], ['GROQ_MODEL', original.model], ['GROQ_REASONING_EFFORT', original.effort]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.unstubAllGlobals();
  });

  const narrate = async () => {
    const { generateNarration } = await import('@/lib/ai/groq');
    return generateNarration({
      category: 'dns', categoryLabel: 'DNS Configuration', severity: 'medium',
      observed: 'o', interpretation: 'i', relatedFacts: { dnssecValidating: true },
    });
  };

  it('carries the API error message, not just the status', async () => {
    /*
     * The regression that started this. A retired model returns 404, and
     * `Groq returned 404` alone is equally true of a typo in the override and
     * a wrong base URL — the body is what says which.
     */
    process.env.GROQ_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'The model `retired-model` does not exist or you do not have access to it.', code: 'model_not_found' } }),
      { status: 404, headers: { 'content-type': 'application/json' } })));

    const out = await narrate();
    expect(out.reason).toContain('404');
    expect(out.reason).toContain('does not exist');
  });

  it('names a starved token budget as such', async () => {
    // A reasoning model can spend every token thinking and return no content.
    // Reported as "empty completion", that sends the reader to the prompt when
    // the fix is one field.
    process.env.GROQ_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })));

    const out = await narrate();
    expect(out.reason).toMatch(/budget/i);
    expect(out.reason).toMatch(/finish_reason=length/);
  });

  it('sends the reasoning effort by default', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    delete process.env.GROQ_REASONING_EFFORT;
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'A note.' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);

    await narrate();
    const body = sentBody(fetchSpy, 0);
    expect(body.reasoning_effort).toBe('low');
    expect(body.model).toBe('openai/gpt-oss-120b');
  });

  it('drops the reasoning effort and retries when the model rejects it', async () => {
    // qwen3.6 accepts only `none` or `default`; compound rejects the field
    // outright. An override that suits one model must not hard-fail another.
    process.env.GROQ_API_KEY = 'test-key';
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: '`reasoning_effort` is not supported with this model' } }),
        { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValue(new Response(
        JSON.stringify({ choices: [{ message: { content: 'A note.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);

    const out = await narrate();
    expect(out.generated).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchSpy, 0).reasoning_effort).toBe('low');
    expect('reasoning_effort' in sentBody(fetchSpy, 1)).toBe(false);
  });

  it('stops sending it after one rejection, rather than paying twice per call', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: '`reasoning_effort` is not supported with this model' } }),
        { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValue(new Response(
        JSON.stringify({ choices: [{ message: { content: 'A note.' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);

    const { generateNarration } = await import('@/lib/ai/groq');
    const input = {
      category: 'dns', categoryLabel: 'DNS Configuration', severity: 'medium',
      observed: 'o', interpretation: 'i', relatedFacts: { dnssecValidating: true },
    };
    await generateNarration(input);   // 2 calls: rejected, then retried
    await generateNarration(input);   // 1 call: the field is not sent again
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 400 that has nothing to do with the effort field', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'context_length_exceeded' } }),
      { status: 400, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);

    const out = await narrate();
    expect(out.generated).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out.reason).toContain('context_length_exceeded');
  });
});
