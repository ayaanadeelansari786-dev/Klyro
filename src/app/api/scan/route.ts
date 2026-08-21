import { NextResponse } from 'next/server';

import { CHECKS, CHECK_ORDER, MODULE_MANIFEST, timeoutFor } from '@/lib/checks';
import { dnsQuery, runModule } from '@/lib/checks/util';
import { narrateFindings } from '@/lib/ai/narrate';
import { getBenchmark } from '@/lib/benchmark';
import { INDUSTRIES, MIN_CONTEXT_COVERAGE, RATE_LIMIT_MAX, REGIONS } from '@/lib/constants';
import { parseDomain } from '@/lib/domain';
import { buildInventory } from '@/lib/intel/inventory';
import { assessRelationship, type PostureSnapshot } from '@/lib/intel/relationship';
import { acquireScanSlot, clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { buildScanResult, computeComposite } from '@/lib/scoring';
import { preflightDomainCheck, screenName, screenTarget } from '@/lib/target';
import { resolveOwner, type OwnerContext } from '@/lib/auth/context';
import {
  contributeToBenchmark,
  shouldContributeToBenchmark,
  storeAssessment,
} from '@/lib/dataset/assessments';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';
import type { BenchmarkResult, CategoryResult, ScanEvent, ScanResult } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** How many check modules run at once. Keeps wall time near 20s without
 *  hammering any single upstream source. */
const CONCURRENCY = 4;

interface ScanRequestBody {
  domain?: string;
  industry?: string;
  region?: string;
  /**
   * Optional. The domain of the organisation *running* the assessment, used to
   * report what the vendor's posture means for them specifically. It is never
   * scored, ranked or stored — see `persist` below, which only ever writes the
   * target.
   */
  contextDomain?: string;
  /**
   * Optional. Which organisation to file the assessment under. A claim, not a
   * fact: `resolveOwner()` verifies membership through the caller's own
   * credentials before it becomes ownership.
   */
  orgId?: string;
}

/**
 * Saves a completed assessment, if it belongs to anybody.
 *
 * Anonymous scans persist nothing — no assessment row, and no benchmark
 * sample. That is a deliberate change from the previous behaviour, where every
 * scan by every visitor was written to a world-readable table. Two reasons:
 * an ownerless row matches no policy, so it is only ever one mistake away from
 * being exposed to everyone; and an anonymous visitor scanning a domain is not
 * consent to publish that the domain was scanned, or what it scored.
 *
 * The scan itself is unaffected. It runs in full and streams back in full.
 * What changes is that nothing is left behind.
 *
 * Failure here is swallowed on purpose. Twenty seconds of network work has
 * already produced a complete, correct assessment; losing the ability to save
 * it should cost the user the save, not the result.
 */
async function persist(
  result: ScanResult,
  benchmark: BenchmarkResult | null,
  owner: OwnerContext,
): Promise<ScanResult> {
  if (!owner.userId && !owner.orgId) return result;

  try {
    // Decided before the insert so the stored row records it from the moment
    // it exists. False for every personal assessment and for every
    // organisation that has not switched this on — see the function.
    const contributes = await shouldContributeToBenchmark(owner.orgId, result.domain)
      .catch(() => false);

    const stored = await storeAssessment(result, benchmark, owner, contributes);
    if (!stored) return result;

    if (contributes) {
      /*
       * Non-fatal, and separately so.
       *
       * The assessment is already written and is complete on its own. Losing
       * the benchmark sample costs the shared corpus one row; surfacing that
       * as an error would cost the user a scan they successfully ran, over a
       * side effect they did not ask about and cannot act on.
       */
      await contributeToBenchmark(stored.id, result).catch(() => undefined);
    }

    return { ...result, id: stored.id, persisted: true };
  } catch {
    return result;
  }
}

/** Runs every module with bounded concurrency, reporting each as it lands. */
async function runAllChecks(
  domain: string,
  onStart?: (key: (typeof CHECK_ORDER)[number]) => void,
  onDone?: (result: CategoryResult) => void,
): Promise<CategoryResult[]> {
  const queue = [...CHECK_ORDER];
  const results: CategoryResult[] = [];

  async function worker() {
    for (;;) {
      const key = queue.shift();
      if (!key) return;
      onStart?.(key);
      const result = await runModule(key, CHECKS[key], domain, timeoutFor(key));
      results.push(result);
      onDone?.(result);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Restore the declared order regardless of completion order.
  return CHECK_ORDER.map((key) => results.find((r) => r.key === key)).filter(
    (r): r is CategoryResult => Boolean(r),
  );
}

/**
 * The reader's own domain, assessed the same way as the target.
 *
 * It has to be the same ten modules: a composite built from a different set of
 * weights is not comparable to the target's, and the whole point of this scan
 * is the comparison. It runs alongside the target scan rather than after it, so
 * it costs concurrency rather than wall time, and it is deliberately silent —
 * the progress UI belongs to the domain the user asked about.
 */
async function runContextScan(domain: string): Promise<PostureSnapshot | null> {
  const categories = await runAllChecks(domain);
  const { compositeScore, coverage } = computeComposite(categories);

  // Too little of the domain could be measured to treat the result as a
  // standard. See MIN_CONTEXT_COVERAGE — a domain that does not resolve still
  // produces a composite, and publishing it would invent a posture.
  if (coverage < MIN_CONTEXT_COVERAGE) return null;

  return { domain, compositeScore, coverage, categories };
}

export async function POST(request: Request) {
  let body: ScanRequestBody;
  try {
    body = (await request.json()) as ScanRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const parsed = parseDomain(body.domain ?? '');
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const industry = (INDUSTRIES as readonly string[]).includes(body.industry ?? '')
    ? (body.industry as string)
    : null;
  const region = (REGIONS as readonly string[]).includes(body.region ?? '')
    ? (body.region as string)
    : null;

  if (!industry || !region) {
    return NextResponse.json(
      { error: 'Select a valid industry and region.' },
      { status: 400 },
    );
  }

  /*
   * The free half of the target screening runs before the rate limit.
   *
   * `screenName` is a suffix comparison with no DNS behind it, so refusing
   * `jira.corp` here costs nothing and — more to the point — does not spend
   * one of the caller's ten scans on a request that was never going to run.
   * The resolving half stays *after* the limit, deliberately: it issues DNS
   * queries, and an unlimited path to those would make Klyro a query relay.
   */
  const nameScreening = screenName(parsed.domain);
  if (!nameScreening.ok) {
    return NextResponse.json({ error: nameScreening.error }, { status: 400 });
  }

  const limit = await consumeRateLimit(`scan:${clientKey(request)}`);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Scan limit reached (${RATE_LIMIT_MAX} per hour). Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
      },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  /*
   * Who this scan will belong to, decided here and not later.
   *
   * Both `getCurrentUser()` and the membership check read request cookies,
   * which are only available inside the request's async context. The scan
   * itself runs inside a streaming callback that continues after the response
   * has begun, where that context is no longer reliably attached — so the
   * identity is resolved now, while the request is still a request, and the
   * result is carried into the stream as a plain value.
   *
   * A signed-out visitor resolves to ANONYMOUS and nothing is stored.
   */
  const sessionClient = createClientForRequest();
  const user = await getCurrentUser();
  const owner = await resolveOwner(sessionClient, user, body.orgId ?? null);

  const domain = parsed.domain;

  /*
   * Refuse targets that are not on the public internet before any module runs.
   *
   * `parseDomain` rejects IP literals and bare host names; this rejects a
   * well-formed public domain whose records point inward. The connect-time
   * guard in `safeFetch` and the TLS probe covers the case where the answer
   * changes between here and the request.
   */
  const screening = await screenTarget(domain, (name, type) =>
    dnsQuery(name, type, { confirmAbsence: false }),
  );
  if (!screening.ok) {
    return NextResponse.json({ error: screening.error }, { status: 400 });
  }

  /*
   * Does the domain exist at all?
   *
   * A name with no address is a typo, not a posture. Left to run, it produces
   * eleven modules that each fail to reach anything and a report that says
   * almost nothing — twenty seconds spent to communicate "you mistyped it",
   * badly. This answers the same question in about two.
   *
   * `screening.addresses` is handed through rather than re-resolved: the call
   * above already asked for exactly the A and AAAA records this needs, so a
   * domain that does exist adds no DNS work and no latency here. Only a name
   * that resolves to nothing pays for the variant probes, which is the right
   * place for that cost to land.
   */
  const preflight = await preflightDomainCheck(
    domain,
    (name, type) => dnsQuery(name, type, { confirmAbsence: false }),
    screening.addresses,
  );

  if (!preflight.exists) {
    /*
     * Give the token back.
     *
     * This is the one rejection in the handler that costs a token without a
     * scan having been attempted, and it is also the one a person hits by
     * mistake rather than by intent. Ten tokens an hour is generous for
     * assessments and thin for typing: a handful of fumbled names would
     * otherwise lock someone out before they had run a single scan.
     *
     * Deliberately not extended to the rejections around it. `screenTarget`
     * above refuses a domain that resolves inward, which is a request that was
     * correctly stopped and is not free to repeat — a refundable refusal is a
     * refusal an attacker can issue indefinitely. The token spent there is the
     * cost of having asked.
     *
     * Non-fatal: `refund` swallows its own failures, so a limiter that is
     * unreachable at this moment costs the caller one token and changes
     * nothing about the answer below.
     */
    await limit.refund();

    return NextResponse.json(
      {
        code: 'DOMAIN_NOT_FOUND',
        error: preflight.suggestion
          ? `${domain} does not resolve in DNS. Did you mean ${preflight.suggestion}?`
          : `${domain} does not resolve in DNS. Check the spelling, or confirm the domain is registered and active.`,
        suggestion: preflight.suggestion ?? null,
      },
      { status: 422 },
    );
  }

  /* ---------------- Optional buyer context ---------------- */

  const contextRaw = (body.contextDomain ?? '').trim();
  const contextParsed = contextRaw ? parseDomain(contextRaw) : null;

  let contextDomain: string | null = null;
  let contextError: string | null = null;

  if (contextParsed) {
    if (!contextParsed.ok) {
      contextError = contextParsed.error ?? 'That does not look like a valid domain.';
    } else if (contextParsed.domain === domain) {
      contextError = 'The comparison domain is the same as the domain being assessed.';
    } else if (
      !(
        await screenTarget(contextParsed.domain, (name, type) =>
          dnsQuery(name, type, { confirmAbsence: false }),
        )
      ).ok
    ) {
      // The second domain is a second scan target and gets the same screening.
      contextError = `${contextParsed.domain} is not a host on the public internet, so no comparison was run.`;
    } else {
      // A context scan is a second full assessment, so it costs a second token
      // rather than riding along free. Running out degrades the feature instead
      // of failing the request the user actually asked for.
      const contextLimit = await consumeRateLimit(`scan:${clientKey(request)}`);
      if (contextLimit.allowed) contextDomain = contextParsed.domain;
      else contextError = 'Scan limit reached, so the comparison was skipped.';
    }
  }

  /*
   * The per-identity limit permits ten scans an hour each, so a burst from a
   * handful of addresses is within the rules and still enough to exhaust the
   * instance. This gate is the backstop, and it is taken *after* the target
   * screening so a rejected target never occupies a slot.
   */
  const slot = await acquireScanSlot();
  if (!slot.granted) {
    return NextResponse.json(
      {
        error:
          'Klyro is running the maximum number of concurrent assessments. This is a capacity limit rather than a limit on you — try again in a minute.',
      },
      { status: 503, headers: { 'retry-after': '60' } },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ScanEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };

      try {
        send({ type: 'start', domain, modules: MODULE_MANIFEST });

        // Started before the target scan is awaited so the two overlap. The
        // catch is attached here rather than at the await: a rejection that
        // arrives while the target scan is still running would otherwise be
        // unhandled.
        const contextTask = contextDomain
          ? runContextScan(contextDomain).catch(() => null)
          : null;

        if (contextDomain) send({ type: 'context:running', domain: contextDomain });

        const categories = await runAllChecks(
          domain,
          (key) => send({ type: 'module:running', key }),
          (result) => send({ type: 'module:done', key: result.key, result }),
        );

        // The inventory is assembled from names the modules already
        // established, so it runs after them. It is unscored, and a failure
        // costs the report a section rather than a number.
        send({ type: 'inventory:running' });
        const inventory = await buildInventory(domain, categories).catch(() => null);
        send({ type: 'inventory:done', inventory });

        let result = buildScanResult({ domain, industry, region }, categories, inventory);

        /*
         * Generated context, before the assessment is stored rather than
         * after.
         *
         * Not a preference — `assessments` carries an append-only trigger that
         * refuses any update altering `findings`, so a note written after the
         * insert could never be saved. Writing it here means it is part of the
         * row from the moment the row exists, which is also what makes it
         * survive to a report printed months later.
         *
         * Bounded and non-fatal: see `narrateFindings`. A scan that reaches
         * this line has already done all its real work, and losing the notes
         * must cost the reader some commentary rather than the assessment.
         */
        send({ type: 'ai:running' });
        result = await narrateFindings(result).catch(() => result);
        send({ type: 'ai:done' });

        // The benchmark is computed before the assessment is stored, not
        // after: it is part of what gets stored. A report reprinted next year
        // should show the comparison it was written with rather than one
        // recomputed against a corpus that has moved since.
        const benchmark = await getBenchmark(industry, region, result.compositeScore, domain);
        result = await persist(result, benchmark, owner);

        // The target's report is complete and is sent now; the comparison
        // arrives when it arrives, the way the news and ownership panels do.
        send({ type: 'complete', result, benchmark, notice: owner.notice });

        if (contextTask) {
          const snapshot = await contextTask;
          send(
            snapshot
              ? { type: 'context:done', assessment: assessRelationship(result, snapshot) }
              : {
                  type: 'context:done',
                  assessment: null,
                  error:
                    `Too few checks could reach a public source for ${contextDomain} to compare it against this vendor — most often that means the domain does not resolve. ` +
                    `A comparison drawn from a partial scan would invent a standard rather than measure one, so none is shown. The assessment above is unaffected.`,
                },
          );
        } else if (contextError) {
          send({ type: 'context:done', assessment: null, error: contextError });
        }
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : 'The assessment failed unexpectedly.',
        });
      } finally {
        closed = true;
        // Awaited rather than fired and forgotten: the release is a network
        // call now, and a serverless instance frozen the moment this stream
        // closes would otherwise leak the slot until the stale sweep reclaims
        // it ninety seconds later.
        await slot.release();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    // A client that navigates away mid-scan cancels the stream. Without this
    // the slot is never returned and the instance loses capacity permanently.
    async cancel() {
      await slot.release();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
