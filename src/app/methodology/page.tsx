import type { Metadata } from 'next';
import Link from 'next/link';

import { PageFooter, SiteHeader } from '@/components/Chrome';
import { CATEGORY_LABELS, CATEGORY_ORDER, CATEGORY_WEIGHTS, TOOL_VERSION } from '@/lib/constants';

/**
 * The methodology page.
 *
 * `/scanner` answers "what did this thing just do to my server" for an
 * operator who found Klyro in a log. This answers "why should I believe the
 * document" for someone evaluating the output — a security team, a technical
 * reviewer on the buying side. They are different readers with different
 * questions, which is why this is a companion page and not a longer version of
 * that one.
 *
 * Everything structural here is read from the code it describes: the module
 * list from `CATEGORY_ORDER`, the weights from `CATEGORY_WEIGHTS`, the factor
 * tables from the same constants `prioritise()` uses. A methodology page that
 * describes arithmetic the software stopped doing is worse than no methodology
 * page, and the only way to prevent that is to stop retyping the numbers.
 */

export const metadata: Metadata = {
  title: 'Methodology — Klyro',
  description:
    'How Klyro writes findings, what its confidence levels mean, how the composite score is computed, which public sources it reads, and what it does not claim.',
};

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="border-t border-line pt-10">
      <p className="micro">{eyebrow}</p>
      <h2 className="mt-3 text-[20px] font-semibold tracking-tight text-tx">{title}</h2>
      <div className="mt-5 max-w-[70ch] space-y-4 text-[13.5px] leading-relaxed text-tx-2">
        {children}
      </div>
    </section>
  );
}

/** A table that scrolls inside itself rather than widening the page. */
function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="!mt-6 overflow-x-auto rounded border border-line">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line bg-raised/60">
            {head.map((cell) => (
              <th
                key={cell}
                className="px-4 py-2.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] text-tx-3"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line last:border-b-0">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="px-4 py-3 align-top text-[12.5px] leading-relaxed text-tx-2"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One field of a finding, shown with the rule that governs what may go in it. */
function Field({
  name,
  rule,
  example,
}: {
  name: string;
  rule: string;
  example: string;
}) {
  return (
    <div className="border-t border-line py-5 first:border-t-0 first:pt-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-seal-ink">{name}</p>
      <p className="mt-2.5 text-[13.5px] leading-relaxed text-tx">{rule}</p>
      <p className="mt-3 border-l-2 border-line pl-4 text-[12.5px] leading-relaxed text-tx-3">
        {example}
      </p>
    </div>
  );
}

/**
 * The data sources, one row per module.
 *
 * `source` and `confirmed` are the parts a reviewer is actually checking, and
 * `confirmed` is deliberately not a tick everywhere — three modules read a
 * single source and say so, because a page that claimed corroboration
 * everywhere would be the first thing to fall apart under scrutiny.
 */
const SOURCES: Record<
  (typeof CATEGORY_ORDER)[number],
  { source: string; confirmed: string }
> = {
  emailSecurity: {
    source: 'DNS over HTTPS — Google and Cloudflare, alternating',
    confirmed: 'Yes — an empty answer is re-asked of a second resolver before absence is reported',
  },
  ssl: {
    source: 'A live TLS handshake with the host, reading the presented chain',
    confirmed: 'Single observation — the chain is read directly, so there is nothing to corroborate',
  },
  dns: {
    source: 'DNS over HTTPS — Google and Cloudflare, alternating',
    confirmed: 'Yes — absence is confirmed against a second resolver, and NXDOMAIN needs a quorum',
  },
  headers: {
    source: 'One HTTPS request to the apex, reading response headers',
    confirmed: 'Single observation — a header is present in the response or it is not',
  },
  subdomains: {
    source: 'Certificate transparency logs via crt.sh, falling back to CertSpotter',
    confirmed: 'Two independent log aggregators; discovered hosts are then resolved before being reported live',
  },
  exposedPaths: {
    source: 'HEAD requests to a fixed, published path list, preceded by two random-path controls',
    confirmed: 'Yes — the controls establish how the site answers for something that does not exist',
  },
  whois: {
    source: 'RDAP via rdap.org and rdap.net, plus the registry’s own endpoint where one exists',
    confirmed: 'Yes — the bootstrap answer is checked against the registry directly, because the two mirrors proxy the same source',
  },
  cookies: {
    source: 'Set-Cookie headers on the pre-authentication response',
    confirmed: 'Single observation — attributes are read from the header as sent',
  },
  cors: {
    source: 'A GET and an OPTIONS carrying an origin that does not exist',
    confirmed: 'Yes — two request shapes, because a policy can differ between simple and preflighted requests',
  },
  robotsSecurity: {
    source: 'Direct requests for /robots.txt, /sitemap.xml and /.well-known/security.txt',
    confirmed: 'Single observation — the file is served or it is not',
  },
  internetdb: {
    source: 'Shodan InternetDB — a third-party record, not a Klyro measurement',
    confirmed: 'Not corroborated, and not measured — see the note below the table',
  },
  technologies: {
    source: 'The homepage response — title, headers, asset paths, cookie names — plus the domain’s own DNS records',
    confirmed: 'Corroborated where a second signal exists; a single weak signal is reported at lower confidence',
  },
};

const VALIDATIONS: {
  domain: string;
  against: string;
  finding: string;
  result: string;
  outcome: 'match' | 'fixed';
}[] = [
  {
    domain: 'boschaishield.com',
    against: 'RIPE RDAP, Verisign RDAP, third-party WHOIS',
    finding: 'Domain expiry 8 September 2026, transfer lock active',
    result: 'Three-way match. Klyro correct; a commercial rating service was reporting stale data.',
    outcome: 'match',
  },
  {
    domain: 'about.gitlab.com',
    against: 'Independent DNS',
    finding: 'A brand name in a page title is not evidence that the software is deployed',
    result: 'Fixed. A single weak signal no longer produces a high-confidence identification.',
    outcome: 'fixed',
  },
  {
    domain: 'netflix.com',
    against: 'Live DNS',
    finding: 'Route 53 across four TLDs is one operator, not four',
    result: 'Fixed. Addresses are resolved to their operating network before being counted.',
    outcome: 'fixed',
  },
  {
    domain: 'emiratesnbd.ae',
    against: 'Live DNS',
    finding: 'NOERROR with an empty answer is not NXDOMAIN',
    result: 'Fixed. Existence is decided by the DNS response code, not by whether a record was returned.',
    outcome: 'fixed',
  },
  {
    domain: 'boschaishield.com',
    against: 'A commercial rating service',
    finding: 'Registration data current at the moment of the scan',
    result: 'Klyro queries RDAP live; a cached third-party result was weeks behind.',
    outcome: 'match',
  },
];

export default function MethodologyPage() {
  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-8">
      <SiteHeader>
        <nav className="flex items-center gap-6">
          <Link
            href="/scanner"
            className="text-[12.5px] text-tx-2 transition-colors duration-150 hover:text-tx"
          >
            Scanner disclosure
          </Link>
          <span className="micro hidden sm:inline">Methodology</span>
        </nav>
      </SiteHeader>

      <div className="max-w-[64ch] py-14 lg:py-20">
        <p className="micro">Klyro {TOOL_VERSION}</p>
        <h1 className="wide mt-6 text-balance text-[38px] font-semibold leading-[0.98] tracking-[-0.03em] text-tx sm:text-[50px]">
          How to check our work.
        </h1>
        <p className="mt-7 text-[15px] leading-relaxed text-tx-2">
          Klyro produces a number and a set of findings about a domain it has never been given
          access to. That is only worth reading if the reasoning is inspectable, so this page states
          the rules the findings are written under, the arithmetic behind the score, every source
          the assessment draws on, and the things Klyro does not attempt to know.
        </p>
        <p className="mt-4 text-[13.5px] leading-relaxed text-tx-3">
          If you arrived from a log line and want to know what the scanner requested,{' '}
          <Link href="/scanner" className="text-seal-ink underline underline-offset-2">
            the scanner disclosure
          </Link>{' '}
          is the page for that.
        </p>
      </div>

      <div className="space-y-14">
        <Section id="findings" eyebrow="Structure" title="How a finding is written">
          <p>
            Every finding has the same six fields, in the same order, and each one exists to keep a
            different kind of claim from leaking into the others. The separation is the point: a
            reader who distrusts every conclusion in the report should still be able to accept the
            first field, and a reader who accepts all of it should still know where the evidence
            stops.
          </p>

          <div className="!mt-7 rounded border border-line bg-panel px-6 py-5">
            <Field
              name="Observed"
              rule="What was measured, with no inference attached. No service name, no cause, no consequence — only the reading."
              example="“A TXT query for example.com returned no record beginning with v=spf1. Absence was confirmed against a second resolver before being reported.”"
            />
            <Field
              name="Interpretation"
              rule="What the observation reasonably indicates. This is where a record becomes a meaning, and it is kept separate so the step is visible rather than assumed."
              example="“The domain does not declare which servers are authorised to send mail using it in the envelope sender. Receiving servers therefore have no SPF result to evaluate.”"
            />
            <Field
              name="Risk if that holds"
              rule="What could follow — the only field written in the conditional voice, and the only one describing something that has not happened. It is named for its condition so it cannot be read as a report of an incident."
              example="“With no SPF record and no DKIM signature, a DMARC policy has nothing to pass, so enforcement cannot be introduced without first breaking legitimate mail.”"
            />
            <Field
              name="Recommended action"
              rule="The shortest path out, specific enough to act on, and drawn from the observation rather than from a generic checklist."
              example="“Publish an SPF record listing the legitimate sending services and ending in -all. Confirm the full list of senders first — marketing platforms and ticketing systems are the ones usually missed.”"
            />
            <Field
              name="Evidence"
              rule="The test performed, what came back, what a correct configuration would have returned, and how the observation was corroborated. Enough to repeat the check by hand."
              example="“Test: DNS TXT query for example.com, filtered for records starting v=spf1. Expected: a single v=spf1 record ending in -all. Verification: answered by two independent resolvers.”"
            />
            <Field
              name="Cannot establish"
              rule="What this test does not show. Rendered wherever it exists, never behind a control the reader has to find — a caveat you have to click for is a caveat the product does not mean."
              example="“SPF authenticates the envelope sender, not the From address a recipient sees. Its absence is not by itself proof that mail can be forged convincingly.”"
            />
          </div>

          <p>
            There is a seventh case, which is a finding that reports a failed measurement. It is
            constructed separately and is always informational, always says explicitly that no
            conclusion is drawn, and never counts against the score. An unknown is not a finding.
          </p>
        </Section>

        <Section id="confidence" eyebrow="Evidence" title="What the confidence levels mean">
          <p>
            Confidence is recorded on every finding and is never defaulted, because a default would
            let a module publish an inference at the same standing as a direct reading.
          </p>

          <Table
            head={['Level', 'What it means', 'Multiplier']}
            rows={[
              [
                <span key="h" className="font-medium text-tx">
                  High
                </span>,
                'Directly observed and corroborated against a second source.',
                <span key="hm" className="font-mono tabular-nums">
                  ×1
                </span>,
              ],
              [
                <span key="m" className="font-medium text-tx">
                  Medium
                </span>,
                'Directly observed, with a stated limitation on what the observation can support.',
                <span key="mm" className="font-mono tabular-nums">
                  ×0.75
                </span>,
              ],
              [
                <span key="l" className="font-medium text-tx">
                  Low
                </span>,
                'Inferred from indirect signal — a hostname convention, a single weak marker.',
                <span key="lm" className="font-mono tabular-nums">
                  ×0.5
                </span>,
              ],
            ]}
          />

          <p>
            Three consequences follow, and they are the reason the level is recorded at all. A
            low-confidence finding never uses severe language, because the language would be
            carrying more certainty than the evidence. Missing data is excluded from scoring rather
            than counted against the domain — a source that would not answer says nothing about the
            target. And the share of the assessment that actually completed is reported on the
            dashboard and on the report&rsquo;s first page, so a partial scan is never presented as
            a full one.
          </p>
        </Section>

        <Section id="scoring" eyebrow="Arithmetic" title="How the score is computed">
          <p>
            The composite is the weighted average of the {CATEGORY_ORDER.length} category scores,
            each out of 100. The weights are fixed, published below, and sum to 1.
          </p>
          <p>
            When a module cannot be assessed — an upstream source is down, a host does not answer —
            its category is dropped and the remaining weights are renormalised over what is left.
            The alternative, scoring the missing module as zero, would mean a busy certificate
            transparency log made a domain look worse than it is. Coverage records how much of the
            intended weight actually contributed and is always reported alongside the number.
          </p>
          <p>
            Findings are ranked by a product of three factors, and the arithmetic is printed against
            each one in the report so it can be checked rather than taken:
          </p>

          <div className="!mt-5 overflow-x-auto rounded border border-line bg-panel px-5 py-4">
            <p className="whitespace-nowrap font-mono text-[12.5px] text-tx">
              severity × confidence × exposure = priority
            </p>
          </div>

          <p>
            Severity is how much of the stated consequence follows if the interpretation holds
            (critical 100, high 70, medium 45, low 20, informational 0). Confidence is the
            multiplier in the table above. Exposure is how directly an outsider can act on the
            weakness — email spoofing and an open administrative path need nothing but an internet
            connection; a missing Referrer-Policy needs a visitor to click an external link first.
            A finding rendered in the report carries its own line of that arithmetic, naming each
            factor and the product.
          </p>

          <Table
            head={['Check', 'Weight']}
            rows={CATEGORY_ORDER.map((key) => [
              <span key={key} className="text-tx">
                {CATEGORY_LABELS[key]}
              </span>,
              <span key={`${key}-w`} className="font-mono tabular-nums">
                {Math.round(CATEGORY_WEIGHTS[key] * 100)}%
              </span>,
            ])}
          />
        </Section>

        <Section id="sources" eyebrow="Provenance" title="Where the data comes from">
          <p>
            Eleven of the twelve modules read a public source or the domain itself, at the moment
            you ask. Nothing is bought, and nothing is served from a cache of somebody else&rsquo;s
            crawl — which is why a Klyro finding is current when it is produced rather than as of
            whenever a third party last looked.
          </p>
          <p>
            The right-hand column matters more than it looks. Where a finding asserts that something
            is <em>absent</em>, absence has to be established rather than assumed from one silent
            answer, so DNS and RDAP re-ask a second, independent source before reporting it. Where a
            module reads a single source, the column says so plainly instead of implying a
            corroboration that does not happen.
          </p>

          <Table
            head={['Check', 'Source', 'Absence confirmed against a second source?']}
            rows={CATEGORY_ORDER.map((key) => [
              <span key={key} className="whitespace-nowrap text-tx">
                {CATEGORY_LABELS[key]}
              </span>,
              SOURCES[key].source,
              SOURCES[key].confirmed,
            ])}
          />

          <p>
            <span className="font-medium text-tx">Network Exposure is the exception</span>, and it
            is worth stating plainly rather than burying in the table. That module measures nothing:
            it reads Shodan&rsquo;s InternetDB, a free public summary of what Shodan&rsquo;s own
            crawlers have seen on an address, and reports what that database holds. Klyro opens no
            connection to any port on the target and performs no scan of it. InternetDB publishes no
            crawl date for a record, so the age of an entry is unknown and unknowable from the API —
            an observation could be from this morning or from two years ago. Every finding the module
            produces says so, none is rated at high confidence, and its findings ask the reader to
            confirm against their own inventory rather than to act on the record. It is enrichment,
            not measurement, and the report does not blur the two.
          </p>
          <p>
            Two context panels draw on sources outside the scored modules: recent public reporting
            on the organisation, via the Google News RSS feed, and the operator behind each address
            in the asset inventory, via Team Cymru&rsquo;s public BGP-to-ASN service over DNS.
            Neither contributes to the score. Both are labelled where they appear.
          </p>
        </Section>

        <Section id="validation" eyebrow="Track record" title="Findings checked against outside sources">
          <p>
            The claims below were verified against sources Klyro does not control. Two confirmed
            that Klyro was right where another tool was not; three found Klyro wrong and produced a
            change to how a whole class of finding is generated. Both kinds are listed, because a
            validation record that only contains successes is a marketing page.
          </p>

          <Table
            head={['Domain', 'Checked against', 'Finding', 'Result']}
            rows={VALIDATIONS.map((v) => [
              <span key="d" className="whitespace-nowrap font-mono text-[12px] text-tx">
                {v.domain}
              </span>,
              v.against,
              v.finding,
              <span key="r">
                <span
                  className={`mr-2 font-mono text-[9.5px] uppercase tracking-[0.12em] ${
                    v.outcome === 'match' ? 'text-risk-good' : 'text-seal-ink'
                  }`}
                >
                  {v.outcome === 'match' ? 'Confirmed' : 'Corrected'}
                </span>
                {v.result}
              </span>,
            ])}
          />

          <p className="!mt-7">
            <span className="font-medium text-tx">The registration check held up three ways.</span>{' '}
            Klyro reported an expiry date and an active transfer lock for boschaishield.com. Queried
            independently against RIPE&rsquo;s RDAP service, Verisign&rsquo;s registry endpoint and a
            third-party WHOIS lookup, all three agreed with Klyro and disagreed with a commercial
            rating service that was reporting older data. This is the practical difference between
            querying a registry when asked and serving a result from a crawl: registration facts
            change on a date, and a cache is wrong from that date until it refreshes.
          </p>

          <p>
            <span className="font-medium text-tx">A brand name in a page title proved nothing.</span>{' '}
            An early version treated the appearance of a software name in a page&rsquo;s title as
            evidence that the software was deployed. On about.gitlab.com that is a company writing
            its own name, not a deployment. The lesson generalised past that one case: a single weak
            marker now yields a lower-confidence finding with its limitation stated, rather than a
            confident claim built on one string.
          </p>

          <p>
            <span className="font-medium text-tx">
              Four name servers were one provider, not four.
            </span>{' '}
            Netflix publishes DNS across several top-level domains, and counting the delegations
            made a single provider look like four independent ones — which inverts the finding,
            because concentration and diversity are opposite risks. Addresses are now resolved to
            the network that operates them before anything is counted, so the inventory reports
            operators rather than names.
          </p>

          <p>
            <span className="font-medium text-tx">An empty answer is not a missing domain.</span>{' '}
            emiratesnbd.ae answered NOERROR with no records at its apex, and an early check read
            that as the domain not existing. It exists — it simply publishes no address there,
            which is normal for a name used for mail or redirection. Existence is now decided by the
            DNS response code, confirmed across resolvers, rather than by whether a record came
            back. Reading it the other way would have refused real domains in order to catch typos.
          </p>
        </Section>

        <Section id="limits" eyebrow="Boundaries" title="What Klyro does not claim">
          <p>
            The list below is not a roadmap and not an apology. Every item is something Klyro
            deliberately does not do, and the reason each finding is defensible is that none of them
            is quietly implied anywhere in the output.
          </p>

          <ul className="!mt-5 space-y-2.5">
            {[
              'No network sensor data. Klyro observes nothing inside any network, and has no telemetry from any host.',
              'No darknet or paste-site monitoring. Nothing here indicates whether credentials for a domain have appeared for sale anywhere.',
              'No compromised-host detection. Klyro cannot see whether a system has been accessed by anyone else, and never suggests that it can.',
              'No breach-outcome correlation. A score is not a probability of an incident. Klyro measures configuration that is publicly observable; it does not model what follows from it.',
              'A one-time snapshot, not continuous monitoring. Every assessment describes the moment it ran. Nothing is watched between scans, and no alerting exists.',
              'No authenticated or internal surface. Klyro sees exactly what an anonymous visitor sees, which is a real ceiling on what any finding can mean.',
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <span aria-hidden="true" className="mt-[7px] h-px w-3 shrink-0 bg-line-strong" />
                <span className="text-[12.5px] leading-relaxed text-tx-2">{line}</span>
              </li>
            ))}
          </ul>

          <p className="!mt-6">
            What remains after all of that is the property worth having: every claim in a Klyro
            report traces to a signal any competent reviewer can go and observe for themselves, with
            the request stated and the limitation printed beside it. A narrower claim that survives
            checking is worth more than a broad one that does not.
          </p>
        </Section>
      </div>

      <PageFooter />
    </main>
  );
}
