'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { useSheen } from '@/components/motion';
import { CATEGORY_ORDER, INDUSTRIES, REGIONS } from '@/lib/constants';
import { parseDomain } from '@/lib/domain';

export default function ScanForm() {
  const router = useRouter();

  /* Glazed, so the guilloché behind the hero passes under it; the sheen tracks
     the pointer across the glass. See the glass rules in globals.css. */
  const panelRef = useSheen<HTMLFormElement>();

  const [domain, setDomain] = useState('');
  const [industry, setIndustry] = useState<string>(INDUSTRIES[0]);
  const [region, setRegion] = useState<string>(REGIONS[0]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Optional second domain: the organisation doing the assessing. Collapsed by
  // default so the form still reads as one question.
  const [contextOpen, setContextOpen] = useState(false);
  const [context, setContext] = useState('');
  const [contextError, setContextError] = useState<string | null>(null);

  const preview = useMemo(() => {
    const parsed = parseDomain(domain);
    return parsed.ok ? parsed.domain : null;
  }, [domain]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseDomain(domain);

    if (!parsed.ok) {
      setError(parsed.error ?? 'Enter a valid domain.');
      return;
    }

    const params = new URLSearchParams({
      domain: parsed.domain,
      industry,
      region,
    });

    // An empty optional field is simply not used; a filled-in invalid one is a
    // mistake worth stopping for rather than silently dropping.
    const contextRaw = context.trim();
    if (contextOpen && contextRaw) {
      const parsedContext = parseDomain(contextRaw);
      if (!parsedContext.ok) {
        setContextError(parsedContext.error ?? 'Enter a valid domain.');
        return;
      }
      if (parsedContext.domain === parsed.domain) {
        setContextError('This is the same domain you are assessing.');
        return;
      }
      params.set('context', parsedContext.domain);
    }

    setError(null);
    setContextError(null);
    setSubmitting(true);

    router.push(`/results?${params.toString()}`);
  }

  return (
    <form ref={panelRef} onSubmit={handleSubmit} className="glass sheen w-full" noValidate>
      {/* Domain — the command line of the product, sized accordingly. */}
      <div className="px-6 pb-5 pt-6 sm:px-8 sm:pt-7">
        <label htmlFor="domain" className="micro block">
          Target domain
        </label>
        <input
          id="domain"
          name="domain"
          type="text"
          autoComplete="url"
          spellCheck={false}
          autoCapitalize="none"
          placeholder="acme.com"
          value={domain}
          onChange={(e) => {
            setDomain(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'domain-error' : 'domain-hint'}
          className="mt-3 w-full border-0 bg-transparent p-0 font-mono text-[26px] leading-none
            tracking-tight text-tx outline-none placeholder:text-tx-3 sm:text-[32px]
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal-ink"
        />

        <div className="mt-4 min-h-[18px]">
          {error ? (
            <p id="domain-error" className="text-[12.5px] text-risk-bad">
              {error}
            </p>
          ) : preview && preview !== domain.trim().toLowerCase() ? (
            <p id="domain-hint" className="text-[12.5px] text-tx-3">
              Resolves to <span className="font-mono text-tx">{preview}</span>
            </p>
          ) : (
            <p id="domain-hint" className="text-[12.5px] text-tx-3">
              Protocols, paths and <span className="font-mono text-tx-2">www</span> are stripped
              automatically.
            </p>
          )}
        </div>
      </div>

      <div className="rule" />

      {/* Optional buyer context. Collapsed, because the product is one
          question; expanded, because that question has a better answer when it
          knows who is asking. */}
      {contextOpen ? (
        <div className="px-6 py-6 sm:px-8">
          <div className="flex items-baseline justify-between gap-4">
            <label htmlFor="context" className="micro block">
              Your organisation
            </label>
            <button
              type="button"
              onClick={() => {
                setContextOpen(false);
                setContext('');
                setContextError(null);
              }}
              className="text-[11.5px] text-tx-3 transition-colors duration-150 hover:text-tx"
            >
              Remove
            </button>
          </div>

          <input
            id="context"
            name="context"
            type="text"
            autoComplete="url"
            spellCheck={false}
            autoCapitalize="none"
            placeholder="your-company.com"
            value={context}
            onChange={(e) => {
              setContext(e.target.value);
              if (contextError) setContextError(null);
            }}
            aria-invalid={Boolean(contextError)}
            aria-describedby={contextError ? 'context-error' : 'context-hint'}
            className="mt-3 w-full border-0 border-b border-line bg-transparent px-0 pb-2.5 font-mono
              text-[18px] leading-none tracking-tight text-tx outline-none placeholder:text-tx-3
              focus:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal-ink"
          />

          {contextError ? (
            <p id="context-error" className="mt-3 text-[12px] text-risk-bad">
              {contextError}
            </p>
          ) : (
            <p
              id="context-hint"
              className="mt-3 max-w-lg text-[11.5px] leading-relaxed text-tx-3"
            >
              Assessed the same way, then compared — where this vendor falls behind the standard you
              hold yourself to, and which providers the two of you would lose at the same moment.
              Your domain is never scored, ranked, or stored.
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setContextOpen(true)}
          className="flex w-full items-start gap-3.5 px-6 py-5 text-left transition-colors
            duration-150 hover:bg-tx/[0.035] sm:px-8"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="mt-[3px] shrink-0 text-tx-3"
          >
            <path
              d="M8 3.5v9M3.5 8h9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="text-[13px] text-tx">Assess this vendor against your own company</span>
              <span className="chip">optional</span>
            </span>
            <span className="mt-1.5 block max-w-lg text-[11.5px] leading-relaxed text-tx-3">
              Adds a section written from your side of the contract: what this vendor&apos;s exposure
              means for you specifically.
            </span>
          </span>
        </button>
      )}

      <div className="rule" />

      <div className="grid gap-6 px-6 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-8">
        <div>
          <label htmlFor="industry" className="micro block">
            Industry
          </label>
          <select
            id="industry"
            name="industry"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            className="field mt-2.5 cursor-pointer appearance-none bg-[length:11px]
              bg-[right_0.9rem_center] bg-no-repeat pr-10"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8' fill='none'%3E%3Cpath d='M1 1.5 6 6.5l5-5' stroke='%239AA1AD' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
            }}
          >
            {INDUSTRIES.map((item) => (
              <option key={item} value={item} className="bg-panel">
                {item}
              </option>
            ))}
          </select>
        </div>

        {/* Five regions — cheaper to hit than a dropdown. */}
        <div>
          <span className="micro block">Region</span>
          <div className="mt-2.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Region">
            {REGIONS.map((item) => {
              const active = region === item;
              return (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setRegion(item)}
                  className={`rounded border px-3 py-2 text-[12.5px] transition-colors duration-150 ${
                    active
                      ? 'border-tx bg-tx text-ground'
                      : 'border-line bg-raised text-tx-2 hover:border-line-strong hover:text-tx'
                  }`}
                >
                  {item}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rule" />

      <div className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p className="order-2 text-[11.5px] leading-relaxed text-tx-3 sm:order-1 sm:max-w-xs">
          {CATEGORY_ORDER.length} passive checks, most scans in 20 to 45 seconds. Public sources and
          ordinary web requests only.
        </p>
        <button
          type="submit"
          disabled={submitting}
          className="btn-seal order-1 w-full px-7 py-3 text-[14px] sm:order-2 sm:w-auto"
        >
          {submitting ? (
            <>
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-seal-on/30 border-t-seal-on" />
              Starting
            </>
          ) : (
            <>
              Run assessment
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 8h9.5M9 4.5 12.5 8 9 11.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </>
          )}
        </button>
      </div>
    </form>
  );
}
