import React from 'react';
import { NextResponse } from 'next/server';
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer';

import SummaryReportTemplate from '@/pdf/SummaryReportTemplate';
import { buildSummaryInput, generateExecutiveSummary } from '@/lib/ai/summary';
import { isGroqConfigured } from '@/lib/ai/groq';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { parseDomain } from '@/lib/domain';
import { sanitiseScanResult } from '@/lib/reportPayload';
import { cacheExecutiveSummary, loadAssessmentForReport } from '@/lib/dataset/assessments';
import { createClientForRequest } from '@/lib/supabase/server';
import { TOOL_VERSION } from '@/lib/constants';
import type { ScanResult } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_PAYLOAD_BYTES = 2_000_000;

/**
 * The one-page plain-language summary.
 *
 * Mirrors `POST /api/report` in every structural respect — the same two ways
 * to ask, the same binding to a stored assessment for a signed-in caller, the
 * same sanitiser on the anonymous path, the same 30/hour ceiling. It is a
 * smaller document but not a cheaper one: it still costs a model call and a
 * render, and a second, more generous limit would simply be the way round the
 * first.
 *
 * Where it deliberately differs from every other AI surface in Klyro is what
 * happens when Groq is unavailable.
 *
 * A missing per-finding note costs a report one paragraph out of dozens, so it
 * degrades in silence. This document *is* the summary. Rendering it without
 * one would hand somebody a Klyro-branded page containing a score, a risk
 * level and no explanation — a document that looks official, says nothing, and
 * gives no clue that anything went wrong. So this endpoint fails visibly, with
 * a status and a reason, and produces no PDF at all.
 */
interface SummaryRequestBody {
  assessmentId?: string;
  result?: ScanResult;
}

function looksLikeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export async function POST(request: Request) {
  const limit = await consumeRateLimit(`report:${clientKey(request)}`, 30);
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded.' }, { status: 429 });
  }

  /*
   * Checked before anything else is done.
   *
   * There is no path from here to a document without a model, so spending a
   * database read and a sanitiser pass first would only delay the same answer.
   * 503 rather than 500: the deployment is missing a capability, which is a
   * true statement about the server and an actionable one for an operator.
   */
  if (!isGroqConfigured()) {
    return NextResponse.json(
      {
        error:
          'The plain-language summary is unavailable on this deployment because no summary generator is configured. The full report is unaffected and can be downloaded as usual.',
        code: 'SUMMARY_UNAVAILABLE',
      },
      { status: 503 },
    );
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_PAYLOAD_BYTES) {
    return NextResponse.json({ error: 'Scan result is too large to render.' }, { status: 413 });
  }

  let body: SummaryRequestBody;
  try {
    const text = await request.text();
    if (text.length > MAX_PAYLOAD_BYTES) {
      return NextResponse.json({ error: 'Scan result is too large to render.' }, { status: 413 });
    }
    body = JSON.parse(text) as SummaryRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  /* ---------------- Which assessment ---------------- */

  let result: ScanResult;
  /** Set only on the bound path; the anonymous one has nothing to cache to. */
  let assessmentId: string | null = null;
  let cached: string | null = null;
  let cachedAt: string | null = null;

  if (body.assessmentId !== undefined) {
    if (!looksLikeId(body.assessmentId)) {
      return NextResponse.json({ error: 'Invalid assessment id.' }, { status: 400 });
    }

    const supabase = createClientForRequest();
    if (!supabase) {
      return NextResponse.json(
        { error: 'Saved assessments are not available on this deployment.' },
        { status: 503 },
      );
    }

    const loaded = await loadAssessmentForReport(supabase, body.assessmentId);

    // One status for "no such assessment" and "not yours" — the read runs
    // under the caller's own credentials, so this route never learns the
    // difference. See `loadAssessmentForReport`.
    if (!loaded) {
      return NextResponse.json({ error: 'Assessment not found.' }, { status: 404 });
    }

    result = loaded.result;
    assessmentId = body.assessmentId;
    if (loaded.executiveSummary?.generated && loaded.executiveSummary.summary) {
      cached = loaded.executiveSummary.summary;
      cachedAt = loaded.executiveSummary.generatedAt;
    }
  } else {
    const parsed = parseDomain(
      typeof body.result?.domain === 'string' ? body.result.domain : '',
    );
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error ?? 'A valid domain is required.' }, { status: 400 });
    }

    const verdict = sanitiseScanResult(body.result, parsed.domain);
    if (!verdict.ok || !verdict.result) {
      return NextResponse.json({ error: verdict.error ?? 'Invalid scan result.' }, { status: 400 });
    }
    result = verdict.result;
  }

  /* ---------------- The summary ---------------- */

  let summary = cached;
  let generatedAt = cachedAt ?? new Date().toISOString();

  if (!summary) {
    const produced = await generateExecutiveSummary(buildSummaryInput(result));

    if (!produced.generated) {
      /*
       * The one place in Klyro where a model failure is the caller's problem.
       * `reason` carries the transport detail — a status code, a timeout — and
       * is safe to return: it describes Klyro's own dependency, not anything
       * about the domain being assessed.
       */
      return NextResponse.json(
        {
          error:
            'The plain-language summary could not be generated. Nothing about the assessment has changed, and the full report is unaffected.',
          code: 'SUMMARY_GENERATION_FAILED',
          reason: produced.reason,
        },
        { status: 502 },
      );
    }

    summary = produced.summary;
    generatedAt = produced.generatedAt;

    // Best effort, and only on the bound path. Awaited rather than fired off:
    // a serverless instance frozen the moment this response is returned would
    // otherwise drop the write and regenerate on every download.
    if (assessmentId) {
      await cacheExecutiveSummary(assessmentId, {
        summary,
        generated: true,
        generatedAt,
        toolVersion: TOOL_VERSION,
      });
    }
  }

  const buffer = await renderToBuffer(
    React.createElement(SummaryReportTemplate, {
      result,
      summary,
      generatedAt,
    }) as unknown as React.ReactElement<DocumentProps>,
  );

  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="klyro-summary-${result.domain}.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
