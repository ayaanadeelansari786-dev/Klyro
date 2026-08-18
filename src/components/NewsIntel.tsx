'use client';

import { useEffect, useState } from 'react';

import { SEVERITY_COLORS } from '@/lib/constants';
import type { NewsIntelligence, NewsItem } from '@/lib/intel/types';

const EVENT_LABELS: Record<string, string> = {
  security: 'Security',
  legal: 'Legal & regulatory',
  operational: 'Operational',
  corporate: 'Corporate',
};

const CREDIBILITY_LABELS: Record<string, string> = {
  established: 'Established newsroom',
  specialist: 'Specialist trade press',
  wire: 'Press-release wire',
  unknown: 'Unrecognised outlet',
};

const CREDIBILITY_CLASS: Record<string, string> = {
  established: 'text-tx',
  specialist: 'text-tx',
  wire: 'text-risk-warn',
  unknown: 'text-tx-3',
};

function VerificationBadge({ item }: { item: NewsItem }) {
  const map = {
    corroborated: {
      label: 'Corroborated',
      title: `Reported independently by ${item.corroboratingPublishers.length + 1} outlets`,
      cls: 'border-risk-good/40 text-risk-good',
    },
    'single-source': {
      label: 'Single source',
      title: 'Reported by one outlet only — not independently confirmed',
      cls: 'border-risk-warn/40 text-risk-warn',
    },
    'vendor-issued': {
      label: 'Vendor-issued',
      title: 'Press release distributed by the company itself — not journalism',
      cls: 'border-line text-tx-3',
    },
  }[item.verification];

  return (
    <span
      title={map.title}
      className={`inline-flex items-center rounded border px-1.5 py-[2px] font-mono text-[9.5px]
        font-medium uppercase tracking-[0.1em] ${map.cls}`}
    >
      {map.label}
    </span>
  );
}

function Row({ item }: { item: NewsItem }) {
  const color = SEVERITY_COLORS[item.severity];
  const date = item.publishedAt
    ? new Date(item.publishedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'Date unknown';

  return (
    <li className="relative border-t border-line px-5 py-4 sm:px-6">
      <span
        className="absolute inset-y-0 left-0 w-[2px]"
        style={{ background: color }}
        aria-hidden="true"
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className="font-mono text-[9.5px] font-medium uppercase tracking-[0.12em]"
          style={{ color }}
        >
          {item.classification}
        </span>
        <span className="font-mono text-[10.5px] text-tx-3">{date}</span>
        <VerificationBadge item={item} />
        {item.subjectConfidence === 'mentioned' && (
          <span
            title="This organisation is named in the headline but may not be the subject of the story"
            className="inline-flex items-center rounded border border-line px-1.5 py-[2px] font-mono
              text-[9.5px] font-medium uppercase tracking-[0.1em] text-tx-3"
          >
            Mention only
          </span>
        )}
      </div>

      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 block max-w-3xl text-[13.5px] font-medium leading-snug text-tx
          underline-offset-[3px] transition-colors duration-150 hover:underline"
      >
        {item.title}
      </a>

      <p className="mt-1.5 text-[11.5px] text-tx-3">
        <span className={CREDIBILITY_CLASS[item.credibility]}>{item.publisher}</span>
        {' — '}
        {CREDIBILITY_LABELS[item.credibility]}
        {item.corroboratingPublishers.length > 0 && (
          <>
            {'; also '}
            {item.corroboratingPublishers.slice(0, 3).join(', ')}
            {item.corroboratingPublishers.length > 3
              ? ` +${item.corroboratingPublishers.length - 3}`
              : ''}
          </>
        )}
      </p>
    </li>
  );
}

export default function NewsIntel({
  domain,
  onLoaded,
}: {
  domain: string;
  onLoaded?: (news: NewsIntelligence | null) => void;
}) {
  const [news, setNews] = useState<NewsIntelligence | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [filter, setFilter] = useState<string>('all');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/intel/news?domain=${encodeURIComponent(domain)}`);
        if (!res.ok) throw new Error('failed');
        const data = (await res.json()) as NewsIntelligence;
        if (cancelled) return;
        setNews(data);
        setState(data.status === 'ok' ? 'ready' : 'error');
        onLoaded?.(data);
      } catch {
        if (cancelled) return;
        setState('error');
        onLoaded?.(null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // onLoaded is intentionally excluded — it is a callback, not a data input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  const items = news?.items ?? [];
  const filtered = filter === 'all' ? items : items.filter((i) => i.eventType === filter);
  const visible = showAll ? filtered : filtered.slice(0, 8);

  return (
    <section className="panel overflow-hidden">
      <div className="px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="micro">Company news &amp; events</p>
            <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
              What has been reported about this company
            </h2>
            <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-tx-2">
              Public coverage, classified by event type.{' '}
              <span className="text-tx">Reported, not scored</span> — headline volume tracks how
              large a company is far more than how risky it is, so none of it moves the score above.
            </p>
          </div>

          {state === 'ready' && news && (
            <div className="text-right">
              <div className="num text-[30px] font-semibold leading-none text-tx">
                {items.length}
              </div>
              <div className="micro mt-2">stories</div>
            </div>
          )}
        </div>

        {state === 'ready' && news && (
          <div className="mt-5 flex flex-wrap gap-1.5">
            {(['all', 'security', 'legal', 'operational', 'corporate'] as const)
              .filter(
                (key) => key === 'all' || (news.counts[key as keyof typeof news.counts] ?? 0) > 0,
              )
              .map((key) => {
                const count =
                  key === 'all' ? items.length : news.counts[key as keyof typeof news.counts];
                const active = filter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setFilter(key);
                      setShowAll(false);
                    }}
                    className={`inline-flex items-center gap-2 rounded border px-2.5 py-1.5 text-[11.5px]
                      transition-colors duration-150 ${
                        active
                          ? 'border-tx-2 bg-raised text-tx'
                          : 'border-line text-tx-2 hover:border-line-strong hover:text-tx'
                      }`}
                  >
                    {key === 'all' ? 'All' : EVENT_LABELS[key]}
                    <span className="font-mono text-[10.5px] text-tx-3 tabular-nums">{count}</span>
                  </button>
                );
              })}
          </div>
        )}
      </div>

      {state === 'loading' && (
        <div className="flex items-center gap-3 border-t border-line px-5 py-6 text-[12.5px] text-tx-2 sm:px-6">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-tx-2" />
          Searching public news sources
        </div>
      )}

      {state === 'error' && (
        <p className="border-t border-line px-5 py-6 text-[12.5px] leading-relaxed text-tx-2 sm:px-6">
          News coverage could not be retrieved. This is a source availability problem, not an
          indication that no events have occurred.
        </p>
      )}

      {state === 'ready' && items.length === 0 && (
        <p className="border-t border-line px-5 py-6 text-[12.5px] leading-relaxed text-tx-2 sm:px-6">
          No matching coverage was found for{' '}
          <span className="font-mono text-tx">{news?.brand}</span>. This is not evidence of a clean
          record — most organisations are simply not covered by the press, and many incidents are
          never reported publicly.
        </p>
      )}

      {state === 'ready' && items.length > 0 && (
        <>
          <ul>
            {visible.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ul>

          {filtered.length > visible.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full border-t border-line px-6 py-3 text-[12px] font-medium text-tx-2
                transition-colors duration-150 hover:bg-raised hover:text-tx"
            >
              Show {filtered.length - visible.length} more
            </button>
          )}
        </>
      )}

      {news && (
        <div className="border-t border-line bg-raised/50 px-5 py-5 sm:px-6">
          <p className="micro">What this section cannot see</p>
          <ul className="mt-3 space-y-1.5">
            {news.blindSpots.map((spot, i) => (
              <li key={i} className="flex gap-2.5 text-[11.5px] leading-relaxed text-tx-2">
                <span className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-tx-3" />
                <span>{spot}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-tx-3">
            Searched <span className="font-mono text-tx-2">{news.brand}</span> (inferred from{' '}
            {news.brandDerivedFrom}) via {news.sourceName} on{' '}
            {new Date(news.retrievedAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
            {news.mentionOnlyCount > 0 && <>; {news.mentionOnlyCount} marked as mention-only</>}
          </p>
        </div>
      )}
    </section>
  );
}
