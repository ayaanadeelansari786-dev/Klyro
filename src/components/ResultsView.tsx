'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import BenchmarkChart from '@/components/BenchmarkChart';
import CheckMatrix from '@/components/CheckMatrix';
import { PageFooter, Wordmark } from '@/components/Chrome';
import ThemeToggle from '@/components/ThemeToggle';
import FindingsTable from '@/components/FindingsTable';
import InventoryPanel from '@/components/InventoryPanel';
import NetworkExposure from '@/components/NetworkExposure';
import NewsIntel from '@/components/NewsIntel';
import OrgPortfolio from '@/components/OrgPortfolio';
import OwnershipPanel, { type OwnershipContext } from '@/components/OwnershipPanel';
import RadarChart from '@/components/RadarChart';
import RelationshipPanel, { type ContextState } from '@/components/RelationshipPanel';
import ReportButton from '@/components/ReportButton';
import ScanProgress, { type ProgressModule } from '@/components/ScanProgress';
import ScoreMeter from '@/components/ScoreMeter';
import SubdomainTiers from '@/components/SubdomainTiers';
import TechnologyStack from '@/components/TechnologyStack';

import { benchmarkSentence } from '@/lib/benchmark';
import type { InternetDbFacts } from '@/lib/checks/internetdb';
import { CATEGORY_LABELS, CATEGORY_ORDER, COLORS, INDUSTRIES, REGIONS, SEVERITY_COLORS } from '@/lib/constants';
import { parseDomain } from '@/lib/domain';
import {
  countBySeverity,
  coverageCounts,
  explainLowCoverage,
  LOW_COVERAGE_THRESHOLD,
  prioritise,
} from '@/lib/scoring';
import type { BenchmarkResult, CategoryResult, ScanEvent, ScanResult } from '@/lib/types';
import type { PortfolioComparison } from '@/lib/dataset/portfolio';
import type { NewsIntelligence } from '@/lib/intel/types';

/**
 * `checking` covers the pre-flight window — the seconds between asking and the
 * server confirming the domain exists. It renders a single line rather than
 * the module list, so a mistyped domain never gets a progress bar it is not
 * going to finish.
 */
type Phase = 'idle' | 'checking' | 'scanning' | 'done' | 'error' | 'not-found';

export default function ResultsView() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const domainParam = searchParams.get('domain') ?? '';
  const industryParam = searchParams.get('industry') ?? '';
  const regionParam = searchParams.get('region') ?? '';
  const contextParam = searchParams.get('context') ?? '';
  /*
   * Which organisation to file this assessment under, carried from the form.
   *
   * Passed straight through without validation, deliberately: this is a claim
   * arriving in a URL and it is worth nothing here. `resolveOwner` re-checks
   * the membership against the caller's own session before the scan is filed
   * anywhere, and an id the reader does not belong to results in a personal
   * assessment plus a notice rather than an error.
   */
  const orgParam = searchParams.get('org') ?? '';

  const parsed = parseDomain(domainParam);
  const industry = (INDUSTRIES as readonly string[]).includes(industryParam) ? industryParam : null;
  const region = (REGIONS as readonly string[]).includes(regionParam) ? regionParam : null;
  const inputsValid = parsed.ok && Boolean(industry) && Boolean(region);

  // Optional, and never a reason to block the assessment: an unusable value in
  // the query string is simply dropped.
  const parsedContext = parseDomain(contextParam);
  const contextDomain =
    contextParam && parsedContext.ok && parsedContext.domain !== parsed.domain
      ? parsedContext.domain
      : null;

  const [phase, setPhase] = useState<Phase>('idle');
  const [modules, setModules] = useState<ProgressModule[]>([]);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState<{
    message: string;
    suggestion: string | null;
  } | null>(null);
  /**
   * Set when the assessment was filed somewhere other than the caller asked —
   * personally, because they named an organisation they cannot write to.
   * Surfaced rather than swallowed: a scan quietly landing in the wrong place
   * is worse than one that says where it went.
   */
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  /* What became of the save, as reported by the server — see `ScanEvent`. */
  const [saveState, setSaveState] = useState<'anonymous' | 'saved' | 'failed' | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // News is gathered separately from the scan: it is reported, never scored,
  // so it must not delay or influence the exposure result.
  const [news, setNews] = useState<NewsIntelligence | null>(null);
  const [ownership, setOwnership] = useState<OwnershipContext | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioComparison | null>(null);
  // Present only when a second domain was supplied. Arrives after `complete`,
  // since the two scans finish independently.
  const [context, setContext] = useState<ContextState | null>(null);

  // React 18 StrictMode double-invokes effects in dev; this guards the scan
  // from being launched twice for the same query.
  const startedFor = useRef<string | null>(null);

  const runScan = useCallback(async () => {
    setPhase('checking');
    setError(null);
    setNotFound(null);
    setResult(null);
    setBenchmark(null);
    setContext(contextDomain ? { domain: contextDomain, status: 'running', assessment: null } : null);
    setModules(
      CATEGORY_ORDER.map((key) => ({
        key,
        label: CATEGORY_LABELS[key],
        status: 'pending' as const,
      })),
    );

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          domain: parsed.domain,
          industry,
          region,
          contextDomain,
          orgId: orgParam || undefined,
        }),
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          code?: string;
          suggestion?: string | null;
        } | null;

        /*
         * A domain that does not resolve is a different screen from a scan
         * that failed. The reader mistyped something and needs to see the
         * name they typed and a way to correct it — not a "try again" button
         * that would repeat the same lookup with the same answer.
         */
        if (response.status === 422 && payload?.code === 'DOMAIN_NOT_FOUND') {
          setNotFound({
            message: payload.error ?? `${parsed.domain} does not resolve in DNS.`,
            suggestion: payload.suggestion ?? null,
          });
          setPhase('not-found');
          return;
        }

        throw new Error(payload?.error ?? 'The assessment could not be started.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handle = (event: ScanEvent) => {
        switch (event.type) {
          case 'start':
            // The stream opening is the proof that pre-flight passed, so this
            // is the moment the module list earns its place on screen.
            setPhase('scanning');
            setModules(
              event.modules.map((m) => ({ key: m.key, label: m.label, status: 'pending' as const })),
            );
            break;
          case 'module:running':
            setModules((prev) =>
              prev.map((m) => (m.key === event.key ? { ...m, status: 'running' } : m)),
            );
            break;
          case 'module:done':
            setModules((prev) =>
              prev.map((m) =>
                m.key === event.key
                  ? {
                      ...m,
                      status: event.result.status === 'assessed' ? 'complete' : 'failed',
                      score: event.result.status === 'assessed' ? event.result.score : undefined,
                    }
                  : m,
              ),
            );
            break;
          case 'complete':
            setResult(event.result);
            setBenchmark(event.benchmark);
            setSaveNotice(event.notice ?? null);
            setSaveState(event.saveState ?? null);
            setPhase('done');
            break;
          case 'context:running':
            setContext({ domain: event.domain, status: 'running', assessment: null });
            break;
          case 'context:done':
            setContext((prev) => ({
              domain: event.assessment?.yourDomain ?? prev?.domain ?? '',
              status: event.assessment ? 'done' : 'error',
              assessment: event.assessment,
              error: event.error,
            }));
            break;
          // The inventory rides along on the completed result; these events
          // exist so the progress view can say what is happening rather than
          // appearing to stall after the last module lands.
          case 'inventory:running':
          case 'inventory:done':
            break;
          case 'error':
            setError(event.message);
            setPhase('error');
            break;
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handle(JSON.parse(line) as ScanEvent);
          } catch {
            /* partial or malformed line — skip */
          }
        }
      }

      // If the stream ended without a terminal event, surface it rather than
      // leaving the user on a spinner forever.
      setPhase((current) => {
        if (current === 'scanning') {
          setError('The assessment ended unexpectedly. Please try again.');
          return 'error';
        }
        return current;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The assessment failed.');
      setPhase('error');
    }
  }, [parsed.domain, industry, region, contextDomain, orgParam]);

  useEffect(() => {
    if (!inputsValid) return;
    const signature = `${parsed.domain}|${industry}|${region}|${contextDomain ?? ''}|${orgParam}`;
    if (startedFor.current === signature) return;
    startedFor.current = signature;
    void runScan();
  }, [inputsValid, parsed.domain, industry, region, contextDomain, orgParam, runScan]);

  useEffect(() => {
    if (phase !== 'scanning') return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const orderedCategories = useMemo<CategoryResult[]>(() => {
    if (!result) return [];
    return CATEGORY_ORDER.map((key) => result.categories.find((c) => c.key === key)).filter(
      (c): c is CategoryResult => Boolean(c),
    );
  }, [result]);

  // Ranked by severity × confidence × exposure rather than severity alone, so
  // an inference from a host name cannot outrank a record read from DNS.
  const topFindings = useMemo(() => (result ? prioritise(result.findings, 5) : []), [result]);

  /* ---------------- Invalid inputs ---------------- */

  if (!inputsValid) {
    return (
      <Shell>
        <div className="panel mx-auto mt-16 max-w-lg p-8">
          <p className="micro">Cannot proceed</p>
          <h1 className="mt-3 text-[22px] font-semibold tracking-tight text-tx">
            Assessment details missing
          </h1>
          <p className="mt-3 text-[13px] leading-relaxed text-tx-2">
            {parsed.ok
              ? 'Select an industry and region before starting an assessment.'
              : (parsed.error ?? 'Enter a valid domain to assess.')}
          </p>
          <Link href="/" className="btn-primary mt-7">
            Start a new assessment
          </Link>
        </div>
      </Shell>
    );
  }

  /* ---------------- Domain does not resolve ---------------- */

  if (phase === 'not-found' && notFound) {
    return (
      <Shell domain={parsed.domain}>
        <div className="panel mx-auto mt-16 max-w-lg p-8">
          <p className="micro text-risk-warn">Not found</p>
          <h1 className="mt-3 text-[22px] font-semibold tracking-tight text-tx">
            <span className="font-mono">{parsed.domain}</span> does not resolve
          </h1>
          <p className="mt-3 text-[13px] leading-relaxed text-tx-2">{notFound.message}</p>
          <p className="mt-3 text-[12px] leading-relaxed text-tx-3">
            No assessment was run. Klyro checked for A and AAAA records and found neither, so there
            is no host here to observe — this is a statement about the name, not about anybody&apos;s
            security.
          </p>

          <div className="mt-7 flex flex-wrap gap-3">
            {notFound.suggestion && (
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams({
                    domain: notFound.suggestion as string,
                    industry: industry as string,
                    region: region as string,
                  });
                  if (contextDomain) next.set('context', contextDomain);
                  startedFor.current = null;
                  router.push(`/results?${next.toString()}`);
                }}
                className="btn-primary"
              >
                Assess <span className="font-mono">{notFound.suggestion}</span> instead
              </button>
            )}
            <Link href="/" className="btn-ghost">
              New assessment
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  /* ---------------- Error ---------------- */

  if (phase === 'error') {
    return (
      <Shell domain={parsed.domain}>
        <div className="panel mx-auto mt-16 max-w-lg p-8">
          <p className="micro text-risk-bad">Failed</p>
          <h1 className="mt-3 text-[22px] font-semibold tracking-tight text-tx">
            The assessment did not complete
          </h1>
          <p className="mt-3 text-[13px] leading-relaxed text-tx-2">{error}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                startedFor.current = null;
                void runScan();
              }}
              className="btn-primary"
            >
              Try again
            </button>
            <Link href="/" className="btn-ghost">
              New assessment
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  /* ---------------- Scanning ---------------- */

  /*
   * Pre-flight. One line, no module list — the scan has not been accepted yet,
   * and showing eleven pending rows for a domain that may not exist promises
   * work that will not happen.
   */
  if (phase === 'checking') {
    return (
      <Shell domain={parsed.domain}>
        <div className="mx-auto w-full max-w-3xl py-16">
          <p className="micro">Checking</p>
          <h1 className="mt-3 truncate font-mono text-[28px] leading-none tracking-tight text-tx sm:text-[34px]">
            {parsed.domain}
          </h1>
          <p className="mt-5 flex items-center gap-2.5 text-[12.5px] text-tx-2">
            <span
              className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-tx-2"
              aria-hidden="true"
            />
            Confirming the domain resolves before starting the assessment.
          </p>
        </div>
      </Shell>
    );
  }

  if (phase !== 'done' || !result) {
    return (
      <Shell domain={parsed.domain}>
        <ScanProgress
          domain={parsed.domain}
          modules={modules}
          elapsedSeconds={elapsed}
          contextDomain={context?.domain ?? null}
        />
      </Shell>
    );
  }

  /* ---------------- Dashboard ---------------- */

  const severityCounts = countBySeverity(result.findings.filter((f) => f.severity !== 'info'));
  const hasOwnership = Boolean(ownership?.known && ownership.vendor);

  // Structured module output, rendered directly rather than through `details`.
  const subdomains =
    result.categories.find((c) => c.key === 'subdomains')?.payload?.subdomains ?? null;
  const technologyProfile =
    result.categories.find((c) => c.key === 'technologies')?.payload?.technologyProfile ?? null;

  // `facts` rather than `payload`: internetdb predates `CategoryPayload` having
  // a typed slot of its own, and `facts` already carries everything the
  // section needs. Only rendered when the module actually produced a record —
  // `unavailable` (no A record, a reserved address, no Shodan record, or a
  // transport error) is left to the check matrix's own row, which already
  // states which of those applies rather than this section repeating it.
  const internetDbCategory = result.categories.find((c) => c.key === 'internetdb');
  const exposureFacts =
    internetDbCategory?.status === 'assessed'
      ? (internetDbCategory.facts as InternetDbFacts | undefined)
      : undefined;

  const sections = [
    { id: 'summary', label: 'Summary' },
    ...(context ? [{ id: 'context', label: 'Your context' }] : []),
    { id: 'checks', label: 'Checks' },
    ...(subdomains && subdomains.length > 0 ? [{ id: 'subdomains', label: 'Subdomains' }] : []),
    ...(technologyProfile ? [{ id: 'technology', label: 'Technology' }] : []),
    ...(exposureFacts ? [{ id: 'network-exposure', label: 'Network Exposure' }] : []),
    ...(result.inventory ? [{ id: 'inventory', label: 'Inventory' }] : []),
    ...(portfolio ? [{ id: 'portfolio', label: 'Portfolio' }] : []),
    { id: 'benchmark', label: 'Benchmark' },
    ...(hasOwnership ? [{ id: 'ownership', label: 'Ownership' }] : []),
    { id: 'findings', label: 'Findings' },
    { id: 'news', label: 'News' },
  ];

  return (
    <Shell
      domain={result.domain}
      rail={<SectionRail sections={sections} />}
      actions={
        <div className="flex items-center gap-2">
          <Link href="/" className="btn-ghost hidden px-3 py-2 text-[12.5px] sm:inline-flex">
            New
          </Link>
          {/*
            Three states, not two.

            Comparison reads saved assessments, so it is only offered when this
            one was saved. When it was not, the reason matters: an anonymous
            assessment is not stored at all — deliberately — and saying "sign
            in to keep this" is the difference between a missing feature and an
            explained one.
          */}
          {result.persisted ? (
            <Link
              href={`/compare?domain=${encodeURIComponent(result.domain)}`}
              className="btn-ghost hidden px-3 py-2 text-[12.5px] md:inline-flex"
            >
              Compare
            </Link>
          ) : saveState === 'failed' ? (
            /*
             * Signed in, and the write did not happen. Offering "Sign in to
             * save" here — which is what this did before the server started
             * reporting the outcome — is an instruction the reader has
             * already followed. The banner above carries the explanation;
             * this is only the state, and it is not a link because there is
             * nothing for the reader to click that would fix it.
             */
            <span
              title="This assessment was not stored. See the notice above."
              className="btn-ghost pointer-events-none hidden border-risk-warn/40 px-3 py-2 text-[12.5px] text-risk-warn md:inline-flex"
            >
              Not saved
            </span>
          ) : (
            <Link
              href="/login"
              title="Assessments run anonymously are not stored. Sign in to keep a history you can compare against."
              className="btn-ghost hidden px-3 py-2 text-[12.5px] md:inline-flex"
            >
              Sign in to save
            </Link>
          )}
          <ReportButton
            result={result}
            benchmark={benchmark}
            news={news}
            ownership={ownership}
            relationship={context?.assessment ?? null}
            variant="compact"
          />
        </div>
      }
    >
      {saveNotice && (
        <p
          role="status"
          className="mt-6 rounded border border-line bg-raised px-4 py-3 text-[12.5px] leading-relaxed text-tx-2"
        >
          {saveNotice}
        </p>
      )}

      {/* ---------- Summary ---------- */}
      <section
        id="summary"
        className="scroll-mt-[120px] animate-rise py-10 sm:py-12"
        style={{ animationDelay: '20ms' }}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <h1 className="font-mono text-[24px] leading-none tracking-tight text-tx sm:text-[30px]">
            {result.domain}
          </h1>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <span className="chip">{result.industry}</span>
          <span className="chip">{result.region}</span>
          <span className="chip normal-case tracking-normal">
            <time dateTime={result.scannedAt}>
              {new Date(result.scannedAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </time>
          </span>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px] lg:gap-6">
          <div>
            {/* Above the gauge, deliberately. Under this threshold the number
                below is more a statement about reach than about posture, and a
                reader who sees the score first has already drawn the wrong
                conclusion by the time they reach a footnote. */}
            {result.coverage < LOW_COVERAGE_THRESHOLD && (
              <div className="mb-6 rounded border border-risk-warn/40 bg-risk-warn/[0.07] p-4">
                <p className="text-[13px] font-medium text-risk-warn">
                  Only {Math.round(result.coverage * 100)}% of the assessment could be completed for
                  this domain.
                </p>
                <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-tx-2">
                  {explainLowCoverage(result)}
                </p>
              </div>
            )}

            {/*
             * The instrument. The one elevated surface on this screen — the
             * composite is the single object everything else on the page is
             * context for, and it is the only thing that gets the third
             * elevation level. The coverage line sits inside it rather than
             * below the fold of the card, because "how much of this reading
             * to trust" is part of reading the number, not a footnote to it.
             */}
            <div className="panel-elevated px-6 py-7 sm:px-9 sm:py-9">
              <ScoreMeter
                score={result.compositeScore}
                peerAverage={
                  benchmark && benchmark.totalScans > 0 ? benchmark.industryAverage : null
                }
              />

              <p className="mt-6 border-t border-line pt-4 text-[12px] text-tx-3">
                {coverageCounts(result).assessed} of {coverageCounts(result).total} checks completed
                {result.coverage < 0.999 && (
                  <> · {Math.round(result.coverage * 100)}% of scoring weight</>
                )}
              </p>
            </div>

            <p className="mt-7 max-w-2xl text-[13.5px] leading-relaxed text-tx-2">
              {benchmarkSentence(benchmark, result.compositeScore, result.domain)}
            </p>

            {/* The low-coverage case is handled by the banner above the gauge;
                this covers the ordinary shortfall that needs stating but not
                alarming about. */}
            {result.coverage < 0.999 && result.coverage >= LOW_COVERAGE_THRESHOLD && (
              <p className="mt-3 max-w-2xl text-[12px] leading-relaxed text-tx-3">
                Categories whose data sources were unavailable were excluded rather than counted
                against this domain.
              </p>
            )}
          </div>

          {/* Severity ledger — counts, not cards. Deliberately the quieter
              `.panel`, not `.panel-elevated`: one object on this screen gets
              the loudest surface, and it is the score, not the tally beside
              it. */}
          <div className="panel self-start">
            <p className="micro px-5 pt-4">Open findings</p>
            <ul className="mt-2">
              {(['critical', 'high', 'medium', 'low'] as const).map((severity) => {
                const count = severityCounts[severity];
                return (
                  <li
                    key={severity}
                    className="flex items-baseline justify-between gap-4 border-t border-line px-5 py-2.5 first:border-t-0"
                  >
                    <span className="flex items-center gap-2.5">
                      <span
                        className="h-[6px] w-[6px] rounded-full"
                        style={{
                          background: count > 0 ? SEVERITY_COLORS[severity] : COLORS.hairline,
                        }}
                        aria-hidden="true"
                      />
                      <span
                        className={`text-[12.5px] capitalize ${count > 0 ? 'text-tx-2' : 'text-tx-3'}`}
                      >
                        {severity}
                      </span>
                    </span>
                    <span
                      className="num text-[20px] font-semibold leading-none"
                      style={{ color: count > 0 ? SEVERITY_COLORS[severity] : undefined }}
                    >
                      <span className={count > 0 ? '' : 'text-tx-3'}>{count}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>

      {/* ---------- Buyer context ----------
           Placed above the vendor's own remediation list on purpose: a reader
           who supplied their own domain is deciding whether to sign, not
           fixing this estate. */}
      {context && (
        <section id="context" className="scroll-mt-[120px] pb-10">
          <RelationshipPanel state={context} />
        </section>
      )}

      {/* ---------- Priority actions ---------- */}
      {topFindings.length > 0 && (
        <section className="panel animate-rise overflow-hidden" style={{ animationDelay: '75ms' }}>
          <div className="px-5 py-5 sm:px-6">
            <p className="micro">Priority</p>
            <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
              What matters most
            </h2>
            <p className="mt-2 max-w-2xl text-[11.5px] leading-relaxed text-tx-3">
              Ranked by severity × confidence × exposure. The arithmetic is shown on each item, so
              nothing sits here on judgement alone — and a finding inferred from a host name cannot
              outrank one read out of a DNS record.
            </p>
          </div>

          <ol className="stagger">
            {topFindings.map(({ finding, rank, priority, rationale }) => (
              <li
                key={finding.id}
                className="grid gap-4 border-t border-line px-5 py-5 sm:grid-cols-[36px_minmax(0,1fr)] sm:px-6"
              >
                <span className="num text-[24px] font-semibold leading-none text-tx-3">
                  {String(rank).padStart(2, '0')}
                </span>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h3 className="text-[14px] font-semibold leading-snug text-tx">
                      {finding.title}
                    </h3>
                    <span
                      className="font-mono text-[9.5px] font-medium uppercase tracking-[0.14em]"
                      style={{ color: SEVERITY_COLORS[finding.severity] }}
                    >
                      {finding.severity}
                    </span>
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-tx-3">
                      {finding.confidence} conf.
                    </span>
                    <span className="font-mono text-[10.5px] text-tx-3">
                      {finding.categoryLabel}
                    </span>
                  </div>

                  <dl className="mt-3 max-w-3xl space-y-2.5">
                    <div>
                      <dt className="micro">Observed</dt>
                      <dd className="mt-1 text-[12.5px] leading-relaxed text-tx">
                        {finding.observed}
                      </dd>
                    </div>
                    <div>
                      <dt className="micro">Why it matters</dt>
                      <dd className="mt-1 text-[12.5px] leading-relaxed text-tx-2">
                        {finding.risk}
                      </dd>
                    </div>
                    <div>
                      <dt className="micro">What to do next</dt>
                      <dd className="mt-1 text-[12.5px] leading-relaxed text-tx">
                        {finding.recommendation}
                      </dd>
                    </div>
                  </dl>

                  <p className="mt-3 border-t border-line pt-2.5 font-mono text-[10.5px] leading-relaxed text-tx-3">
                    Ranked {priority}/100 · {rationale}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ---------- The checks ---------- */}
      <section
        id="checks"
        className="scroll-mt-[120px] animate-rise pt-10"
        style={{ animationDelay: '130ms' }}
      >
        <CheckMatrix categories={orderedCategories} />
      </section>

      {/* ---------- Subdomain exposure, tiered ---------- */}
      {subdomains && subdomains.length > 0 && (
        <section id="subdomains" className="scroll-mt-[120px] pt-10">
          <SubdomainTiers subdomains={subdomains} />
        </section>
      )}

      {/* ---------- Technology stack ---------- */}
      {technologyProfile && (
        <section id="technology" className="scroll-mt-[120px] pt-10">
          <TechnologyStack profile={technologyProfile} />
        </section>
      )}

      {/* ---------- Network exposure (Shodan InternetDB) ----------
           Placed last of the check-derived sections, same as internetdb's own
           position at the end of CATEGORY_ORDER: everything above this is
           something Klyro measured directly, and this is somebody else's
           record. */}
      {exposureFacts && (
        <section id="network-exposure" className="scroll-mt-[120px] pt-10">
          <NetworkExposure facts={exposureFacts} />
        </section>
      )}

      {/* ---------- Asset inventory — unscored ---------- */}
      {result.inventory && (
        <section id="inventory" className="scroll-mt-[120px] pt-10">
          <InventoryPanel inventory={result.inventory} />
        </section>
      )}

      {/* ---------- The organisation's own portfolio ----------
           Above the shared benchmark deliberately: it is the narrower and
           more certain of the two comparisons — a named set the reader
           assembled — and the benchmark's own copy refers back to it. */}
      {orgParam && (
        <section id="portfolio" className="scroll-mt-[120px] pt-10">
          <OrgPortfolio
            orgId={orgParam}
            domain={result.domain}
            industry={result.industry}
            score={result.compositeScore}
            onLoaded={setPortfolio}
          />
        </section>
      )}

      {/* ---------- Benchmark ---------- */}
      <section id="benchmark" className="scroll-mt-[120px] grid gap-4 pt-10 xl:grid-cols-2">
        <BenchmarkChart score={result.compositeScore} benchmark={benchmark} domain={result.domain} />
        <RadarChart categories={orderedCategories} benchmark={benchmark} />
      </section>

      {/* ---------- Ownership (renders only when the vendor is in the dataset) ---------- */}
      <section id="ownership" className="scroll-mt-[120px] pt-10 empty:pt-0">
        <OwnershipPanel domain={result.domain} onLoaded={setOwnership} />
      </section>

      {/* ---------- Findings ---------- */}
      <section
        id="findings"
        className="scroll-mt-[120px] animate-rise pt-10"
        style={{ animationDelay: '190ms' }}
      >
        <FindingsTable findings={result.findings} />
      </section>

      {/* ---------- News ---------- */}
      <section id="news" className="scroll-mt-[120px] pt-10">
        <NewsIntel domain={result.domain} onLoaded={setNews} />
      </section>

      {/* ---------- Report ---------- */}
      <section className="panel mt-10 flex flex-col gap-5 px-5 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <p className="micro">Executive report</p>
          <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
            Written for a board, not a security team
          </h2>
          <p className="mt-2 max-w-xl text-[12px] leading-relaxed text-tx-2">
            Executive summary, score breakdown, benchmark position, the full finding register and
            the methodology behind every number — no jargon assumed.
            {context?.assessment
              ? ` Includes the comparison against ${context.assessment.yourDomain}.`
              : ''}
          </p>
        </div>
        <ReportButton
          result={result}
          benchmark={benchmark}
          news={news}
          ownership={ownership}
          relationship={context?.assessment ?? null}
          className="shrink-0"
        />
      </section>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */

/** Anchor rail with scroll-spy — a long dashboard needs a table of contents. */
function SectionRail({ sections }: { sections: { id: string; label: string }[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');

  // Keyed on the id list rather than the array identity, which is rebuilt on
  // every render of the dashboard.
  const ids = sections.map((s) => s.id).join(',');

  useEffect(() => {
    const nodes = ids
      .split(',')
      .map((id) => document.getElementById(id))
      .filter((n): n is HTMLElement => Boolean(n));

    if (!nodes.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-118px 0px -68% 0px', threshold: 0 },
    );

    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [ids]);

  return (
    <nav className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto" aria-label="Sections">
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={active === section.id ? 'true' : undefined}
          className={`shrink-0 rounded px-2.5 py-1.5 text-[12px] transition-colors duration-150 ${
            active === section.id
              ? 'bg-raised text-tx'
              : 'text-tx-3 hover:text-tx-2'
          }`}
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}

function Shell({
  children,
  domain,
  actions,
  rail,
}: {
  children: React.ReactNode;
  domain?: string;
  actions?: React.ReactNode;
  rail?: React.ReactNode;
}) {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-ground/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center justify-between gap-5 px-5 sm:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <Wordmark />
            {domain && (
              <>
                <span className="hidden h-3 w-px bg-line-strong sm:block" aria-hidden="true" />
                <span className="hidden truncate font-mono text-[12.5px] text-tx-2 sm:block">
                  {domain}
                </span>
              </>
            )}
          </div>
          {/* `shrink-0`: without it a long domain in the left group compresses
              the controls instead of being truncated itself, which is the other
              half of how this cluster went missing. */}
          <div className="flex shrink-0 items-center gap-3 sm:gap-4">
            {actions}
            <ThemeToggle />
          </div>
        </div>

        {rail && (
          <div className="border-t border-line">
            <div className="mx-auto w-full max-w-[1180px] px-4 py-1.5 sm:px-7">{rail}</div>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1180px] px-5 pb-16 sm:px-8">
        {children}
        <PageFooter>
          This assessment uses publicly available information only. No systems were accessed,
          scanned for vulnerabilities, or tested.
        </PageFooter>
      </main>
    </>
  );
}
