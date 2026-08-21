/**
 * The band of signals, running under the hero.
 *
 * Every entry is a record, header or endpoint one of the eleven modules
 * actually reads — checked against the check sources rather than assembled
 * from what sounds like security. That matters more than it looks: a marquee
 * of impressive-sounding acronyms on a product whose entire claim is "we only
 * report what we measured" would undercut the claim on the way past.
 *
 * Two identical runs sit in the track so translating it by exactly -50% lands
 * back where it started. The second run is `aria-hidden`; the first is a real
 * list, so a screen reader gets the inventory once and in order.
 */

const SIGNALS: [group: string, signal: string][] = [
  ['Email', 'v=spf1'],
  ['Email', '_dmarc'],
  ['Email', 'DKIM selectors'],
  ['TLS', 'certificate chain'],
  ['TLS', 'TLS 1.0 – 1.3'],
  ['TLS', 'key length'],
  ['DNS', 'DNSSEC'],
  ['DNS', 'CAA'],
  ['DNS', 'NS delegation'],
  ['Subdomains', 'certificate transparency'],
  ['Subdomains', 'crt.sh'],
  ['Headers', 'Strict-Transport-Security'],
  ['Headers', 'Content-Security-Policy'],
  ['Headers', 'X-Frame-Options'],
  ['Registration', 'RDAP'],
  ['Registration', 'transfer lock'],
  ['Cookies', 'SameSite'],
  ['CORS', 'Access-Control-Allow-Origin'],
  ['Public files', 'robots.txt'],
  ['Public files', 'security.txt'],
  ['Public files', 'sitemap.xml'],
];

function Run({ hidden = false }: { hidden?: boolean }) {
  return (
    <ul
      className="flex shrink-0 items-center gap-8 pr-8 sm:gap-10 sm:pr-10"
      aria-hidden={hidden || undefined}
    >
      {SIGNALS.map(([group, signal]) => (
        <li key={`${group}-${signal}`} className="flex shrink-0 items-baseline gap-2.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-seal-ink">
            {group}
          </span>
          <span className="whitespace-nowrap font-mono text-[12.5px] text-tx-2">{signal}</span>
        </li>
      ))}
    </ul>
  );
}

export default function SignalBand() {
  return (
    <section aria-label="Signals Klyro reads" className="border-y border-line py-4">
      {/* Paused on hover, so an entry can be read at rest rather than chased
          across the screen. Nothing in the band is focusable, so hover is the
          only way in — which is also why the band carries no links. */}
      <div className="marquee band-fade overflow-hidden">
        <div className="marquee-track flex w-max">
          <Run />
          <Run hidden />
        </div>
      </div>
    </section>
  );
}
