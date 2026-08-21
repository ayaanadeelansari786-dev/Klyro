import type { Metadata } from 'next';
import Link from 'next/link';

import { PageFooter, SiteHeader } from '@/components/Chrome';
import { PROBE_MANIFEST } from '@/lib/checks/exposed-paths';
import { MAX_HTTP_PROBES, MAX_LIVENESS_PROBES } from '@/lib/checks/subdomains';
import { USER_AGENT } from '@/lib/checks/util';
import { RATE_LIMIT_MAX, TOOL_VERSION } from '@/lib/constants';
import { SCANNER_CONTACT } from '@/lib/site';

/**
 * The page the scanner's User-Agent points at.
 *
 * The reader here is not a customer. It is whoever operates a site Klyro
 * contacted, reading their access log some hours later and deciding whether
 * the traffic was an attack. Everything on the page is written for that
 * decision: what was requested, why, what was deliberately not requested, and
 * how to make it stop without having to ask anyone.
 *
 * The probe list is imported from the check that performs it rather than
 * retyped, so the published list cannot drift from the requests actually made.
 */

export const metadata: Metadata = {
  title: 'KlyroExposureScanner — About this traffic',
  description:
    'What the Klyro exposure scanner requests, why, what it never does, and how to block it.',
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

/** A copyable rule an operator can paste without editing. */
function Recipe({ label, code }: { label: string; code: string }) {
  return (
    <div className="rounded border border-line bg-raised">
      <p className="micro border-b border-line px-4 py-2.5">{label}</p>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[11.5px] leading-relaxed text-tx-2">
        {code}
      </pre>
    </div>
  );
}

export default function ScannerPage() {
  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-8">
      <SiteHeader>
        <nav className="flex items-center gap-6">
          <Link
            href="/"
            className="text-[12.5px] text-tx-2 transition-colors duration-150 hover:text-tx"
          >
            Klyro
          </Link>
          <span className="micro hidden sm:inline">Scanner disclosure</span>
        </nav>
      </SiteHeader>

      <div className="max-w-[64ch] py-14 lg:py-20">
        <p className="micro">KlyroExposureScanner {TOOL_VERSION}</p>
        <h1 className="wide mt-6 text-balance text-[38px] font-semibold leading-[0.98] tracking-[-0.03em] text-tx sm:text-[50px]">
          You are probably here from a log line.
        </h1>
        <p className="mt-7 text-[15px] leading-relaxed text-tx-2">
          Klyro is an external exposure assessment tool. Someone entered a domain you operate into
          it, and it made a set of ordinary HTTP requests to that domain to measure what the domain
          publishes to the open internet. This page lists every request it makes, states what it
          does not do, and gives you a rule that stops it.
        </p>
        <p className="mt-4 text-[13.5px] leading-relaxed text-tx-3">
          If your question is about the output rather than the traffic — how findings are written,
          what the confidence levels mean, how the score is computed —{' '}
          <Link href="/methodology" className="text-seal-ink underline underline-offset-2">
            the methodology page
          </Link>{' '}
          is the companion to this one.
        </p>
      </div>

      {/* Identity — the one thing to match against the log line. */}
      <section className="panel overflow-hidden">
        <p className="micro border-b border-line px-6 py-3">Identifying the traffic</p>
        <div className="px-6 py-5">
          <pre className="overflow-x-auto font-mono text-[12px] leading-relaxed text-tx">
            {USER_AGENT}
          </pre>
        </div>
        <dl className="grid grid-cols-1 border-t border-line sm:grid-cols-3">
          {[
            ['Trigger', 'A person submitting the domain. Nothing is scheduled or recurring.'],
            ['Method', 'Standard HTTP requests to published endpoints. No port scanning.'],
            ['Ceiling', `${RATE_LIMIT_MAX} scans per hour per source, enforced server-side.`],
          ].map(([term, detail], i) => (
            <div
              key={term}
              className={`px-6 py-4 ${i < 2 ? 'border-b border-line sm:border-b-0 sm:border-r' : ''}`}
            >
              <dt className="micro">{term}</dt>
              <dd className="mt-2 text-[12.5px] leading-relaxed text-tx-2">{detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mt-14 space-y-14">
        <Section id="what" eyebrow="Why the requests happened" title="What Klyro is doing">
          <p>
            Klyro assesses the external security posture of a domain from outside it — the
            certificate it presents, whether its mail can be spoofed, which host names it has
            published in certificate transparency logs, which security headers it sets, and whether
            well-known administrative paths answer to the public internet. It produces a score and a
            report.
          </p>
          <p>
            It is typically run by an organisation assessing a supplier before or during a
            commercial relationship, or by a security team assessing its own estate. It runs once,
            when a person asks it to. There is no crawler, no schedule, and no revisit.
          </p>
        </Section>

        <Section id="requests" eyebrow="The full request surface" title="Exactly what was requested">
          <p>
            This is the complete surface. Everything below is a read — GET, HEAD or the OPTIONS
            preflight a browser sends on its own — with one exception noted at the end. Nothing here
            asks the site to do anything it would not do for an ordinary visitor.
          </p>

          <ul className="!mt-6 space-y-3 border-t border-line pt-5">
            {[
              [
                'The home page',
                'Two or three GET requests to the apex, to read response headers, cookies set before sign-in, and the first 50KB of HTML — which is scanned for the script and stylesheet sources that identify the software and the third-party services in use.',
              ],
              [
                'Plain HTTP',
                'One HEAD to http:// to see whether it redirects to https://.',
              ],
              [
                'TLS handshakes',
                'Up to three connections to port 443, which end once the certificate and negotiated cipher have been read. One of them deliberately offers only TLS 1.0 and 1.1, to establish whether obsolete protocol versions are still accepted — if you see a client offering old TLS in your logs, that is this, and a refusal is the result Klyro wants.',
              ],
              [
                'A cross-origin preflight',
                'One OPTIONS and one GET carrying an Origin header, to read the site’s CORS policy from its own response headers.',
              ],
              [
                'Public metadata files',
                'GET requests for /robots.txt, /sitemap.xml, /.well-known/security.txt and /security.txt — the four files published specifically to be read.',
              ],
              [
                `${PROBE_MANIFEST.length} well-known paths`,
                `A HEAD to each of the paths listed below, on the apex host only, preceded by two HEAD requests to randomly named paths to learn how the site answers for something that does not exist. A path whose status suggests it exists gets one follow-up GET to see what is actually there.`,
              ],
              [
                'Published host names',
                `Host names come from certificate transparency logs, which are third-party records — reading them touches nothing of yours. Up to ${MAX_LIVENESS_PROBES} are then resolved in DNS, and up to ${MAX_HTTP_PROBES} of those receive one GET to the host root (“/”, nothing deeper). Redirects are not followed: where a host redirects, Klyro records the Location header and stops.`,
              ],
              [
                'What is read from a response',
                'At most the first 8KB of a discovered host’s response, and only to identify the software: the <title> tag, markers such as an asset path or a framework signature, the Server, X-Powered-By, Via and WWW-Authenticate headers, and the names of any cookies set. Cookie values are split off and discarded before anything is recorded — only names are kept.',
              ],
            ].map(([term, detail]) => (
              <li key={term} className="grid gap-1 sm:grid-cols-[190px_1fr] sm:gap-6">
                <p className="text-[12.5px] font-medium text-tx">{term}</p>
                <p className="text-[12.5px] leading-relaxed text-tx-2">{detail}</p>
              </li>
            ))}
          </ul>

          <p className="!mt-8">
            The single exception is <code className="font-mono text-[12.5px] text-tx">/graphql</code>
            . If that path answers at all, Klyro sends one POST containing the introspection query{' '}
            <code className="font-mono text-[12.5px] text-tx">{'{__schema{types{name}}}'}</code>,
            which asks a GraphQL server to describe its own schema. It is a read, it changes nothing,
            and it is sent to no other path. Production GraphQL servers are normally configured to
            refuse it.
          </p>
        </Section>

        <Section id="paths" eyebrow="Published in full" title={`The ${PROBE_MANIFEST.length} probed paths`}>
          <p>
            This list is generated from the scanner’s own configuration, so it is the list of paths
            actually requested rather than a description of them. Each is requested once, with HEAD,
            against the apex host. A 404 is a perfectly good answer and the expected one for most
            sites.
          </p>
        </Section>

        <div className="panel overflow-hidden">
          <div className="grid grid-cols-1 sm:grid-cols-2">
            {PROBE_MANIFEST.map((probe, i) => (
              <div
                key={probe.path}
                className={`border-line px-5 py-3.5 ${i % 2 === 0 ? 'sm:border-r' : ''} ${
                  i > 0 ? 'border-t' : ''
                } ${i === 1 ? 'sm:border-t-0' : ''}`}
              >
                <p className="font-mono text-[12px] text-tx">{probe.path}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-tx-3">
                  {probe.label} — expected: {probe.expected}
                </p>
              </div>
            ))}
          </div>
        </div>

        <Section id="never" eyebrow="Boundaries" title="What Klyro does not do">
          <ul className="!mt-5 space-y-2.5">
            {[
              'No credentials are ever submitted. No login is attempted, no password is guessed, and no session is established.',
              'No payloads are sent. Nothing is injected, fuzzed, or malformed, and no vulnerability is triggered or confirmed by exploitation.',
              'No port scanning. Only HTTP and HTTPS on their standard ports, to host names the domain itself has published.',
              'No enumeration. The path list above is fixed and short; directories are not brute forced and host names are not guessed.',
              'No state is changed. Every request is a read. Nothing is created, modified or deleted, and nothing is uploaded.',
              'No authenticated or internal surface is touched. Klyro sees only what any anonymous visitor sees.',
              'No cookie values are recorded. Set-Cookie is split at the first “=” and only the name is kept, so a session belonging to whoever the host last served is never captured.',
              'Reaching a page is not treated as bypassing it. Where a response carries the marks of a sign-in requirement, the report says the system is reachable — not that it is accessible without authentication.',
              'Nothing is retained beyond the assessment. Response bodies are read to classify a result and are not stored or published.',
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <span aria-hidden="true" className="mt-[7px] h-px w-3 shrink-0 bg-line-strong" />
                <span className="text-[12.5px] leading-relaxed text-tx-2">{line}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="block" eyebrow="If you want it to stop" title="Blocking Klyro">
          <p>
            Klyro identifies itself honestly in every request, which means you can block it with a
            single User-Agent rule and no cooperation from us. Any of these takes effect immediately
            and permanently.
          </p>

          <div className="!mt-6 space-y-3">
            <Recipe
              label="nginx"
              code={'if ($http_user_agent ~* "KlyroExposureScanner") {\n    return 403;\n}'}
            />
            <Recipe
              label="Apache"
              code={
                'SetEnvIfNoCase User-Agent "KlyroExposureScanner" block_klyro\nRequire all granted\nRequire not env block_klyro'
              }
            />
            <Recipe
              label="Cloudflare WAF — custom rule expression"
              code={'(http.user_agent contains "KlyroExposureScanner")   →   Block'}
            />
          </div>

          <p className="!mt-8">
            A word on <code className="font-mono text-[12.5px] text-tx">robots.txt</code>: Klyro
            fetches it, but as evidence rather than as instruction. It is read to check whether the
            file discloses paths that would otherwise be unknown, and it does not govern whether the
            assessment proceeds. That is a deliberate position — robots.txt is a convention for
            crawlers indexing content, and a one-off assessment initiated by a named person is not a
            crawl — but it means robots.txt will not stop this traffic. The User-Agent rules above
            will.
          </p>
        </Section>

        <Section id="authorisation" eyebrow="Where we stand" title="Authorisation and abuse">
          <p>
            Everything Klyro reads is published by the domain being assessed or by a third-party
            transparency log. It does not require authorisation in the sense that a penetration test
            does, because it does not do anything a penetration test does. It is nevertheless
            possible to use any assessment tool to annoy someone, and Klyro is rate limited to{' '}
            {RATE_LIMIT_MAX} scans per hour per source with a hard ceiling on concurrent scans for
            that reason.
          </p>
          <p>
            If this traffic caused a problem, or you want the domains you operate excluded, write to{' '}
            <a
              href={`mailto:${SCANNER_CONTACT}`}
              className="text-tx underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-tx"
            >
              {SCANNER_CONTACT}
            </a>{' '}
            with the domain and a log excerpt. Blocking by User-Agent is faster and does not depend
            on us acting, so do that first if the traffic is live.
          </p>
        </Section>
      </div>

      <PageFooter>
        This page is generated from the scanner’s own configuration. The path list and User-Agent
        above are the ones in the running build, version {TOOL_VERSION}.
      </PageFooter>
    </main>
  );
}
