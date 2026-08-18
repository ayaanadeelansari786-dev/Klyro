import React from 'react';
import { NextResponse } from 'next/server';
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer';

import ReportTemplate from '@/pdf/ReportTemplate';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { parseDomain } from '@/lib/domain';
import { sanitiseScanResult } from '@/lib/reportPayload';
import { loadAssessmentForReport } from '@/lib/dataset/assessments';
import { createClientForRequest } from '@/lib/supabase/server';
import type { BenchmarkResult, RelationshipAssessment, ScanResult } from '@/lib/types';
import type { NewsIntelligence } from '@/lib/intel/types';
import type { OwnershipReportContext } from '@/pdf/ReportTemplate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** A full scan result with inventory runs to roughly 100 kB; this is ample. */
const MAX_PAYLOAD_BYTES = 2_000_000;

/**
 * Two ways to ask for a report.
 *
 * `assessmentId` is the bound path: the server fetches what Klyro actually
 * measured from its own database, and nothing the caller sends can change a
 * score, a finding or a date. This is what a signed-in user gets, and it is
 * the path that makes "a Klyro report says what Klyro found" a true statement
 * rather than an aspiration.
 *
 * `result` is the anonymous path, and it stays. Klyro's whole proposition
 * without an account is that a scan runs in full and leaves nothing behind —
 * there is no stored row to bind to, by design. `sanitiseScanResult` narrows
 * what can be rendered to something assessment-shaped; it cannot establish
 * that the assessment happened, and does not claim to.
 *
 * `news`, `ownership` and `relationship` come from the request in both cases.
 * None of the three is stored on the assessment, and none contributes to the
 * score. They are passed through exactly as before this change.
 */
interface ReportRequestBody {
  assessmentId?: string;
  result?: ScanResult;
  benchmark?: BenchmarkResult | null;
  news?: NewsIntelligence | null;
  ownership?: OwnershipReportContext | null;
  relationship?: RelationshipAssessment | null;
}

/** A UUID, checked before it reaches a query. */
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

  // A scan result is large but bounded. Reading an unbounded body into memory
  // before looking at it is its own denial-of-service.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: 'Scan result is too large to render.' },
      { status: 413 },
    );
  }

  let body: ReportRequestBody;
  try {
    const text = await request.text();
    if (text.length > MAX_PAYLOAD_BYTES) {
      return NextResponse.json({ error: 'Scan result is too large to render.' }, { status: 413 });
    }
    body = JSON.parse(text) as ReportRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  /* ---------------- Which report is being asked for ---------------- */

  let result: ScanResult;
  let benchmark: BenchmarkResult | null;
  // Only ever true on the bound path: an anonymous scan is not stored, so
  // there is nothing for it to have contributed.
  let contributesToBenchmark = false;

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

    /*
     * One status for both "no such assessment" and "not yours".
     *
     * The read runs under the caller's own credentials, so a row belonging to
     * somebody else does not come back at all — this route never learns the
     * difference, and could not report it if it wanted to. That is the
     * intended design rather than a limitation: answering 403 for an
     * assessment the caller may not read would confirm that an assessment
     * with that id exists, which is a disclosure about a domain and an
     * organisation they were never shown.
     */
    if (!loaded) {
      return NextResponse.json(
        { error: 'That assessment could not be found.' },
        { status: 404 },
      );
    }

    result = loaded.result;
    benchmark = loaded.benchmark;
    contributesToBenchmark = loaded.contributesToBenchmark;
  } else {
    const parsed = parseDomain((body.result?.domain as string | undefined) ?? '');
    if (!parsed.ok) {
      return NextResponse.json({ error: 'Scan result has an invalid domain.' }, { status: 400 });
    }

    /*
     * The anonymous path. The scan lives in browser state, so this endpoint
     * cannot verify that the payload came from a real assessment. What it can
     * do is refuse to render anything that is not shaped like one — see
     * `sanitiseScanResult`, which rebuilds the object field by field rather
     * than trusting what arrives.
     */
    const verdict = sanitiseScanResult(body.result, parsed.domain);
    if (!verdict.ok || !verdict.result) {
      return NextResponse.json({ error: verdict.error ?? 'Invalid scan result.' }, { status: 400 });
    }

    result = verdict.result;
    benchmark = body.benchmark ?? null;
  }

  /* ---------------- Render ---------------- */

  try {
    // ReportTemplate renders a <Document>; the renderer's signature is typed
    // against DocumentProps rather than the component's own props.
    const element = React.createElement(ReportTemplate, {
      result,
      benchmark,
      news: body.news ?? null,
      ownership: body.ownership ?? null,
      relationship: body.relationship ?? null,
      contributesToBenchmark,
    }) as unknown as React.ReactElement<DocumentProps>;

    const buffer = await renderToBuffer(element);

    // Built from values that are either sanitised or came out of Klyro's own
    // database, so neither the domain nor the date can carry quotes or
    // newlines into the Content-Disposition header.
    const filename = `klyro-assessment-${result.domain}-${result.scannedAt.slice(0, 10)}.pdf`;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(buffer.length),
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'Report generation failed.',
        detail: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
