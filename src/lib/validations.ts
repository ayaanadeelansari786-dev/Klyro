/**
 * Findings checked against outside sources.
 *
 * Single source of truth for `/methodology`'s "Track record" table and the
 * landing page's validation strip, which quotes a short subset of the same
 * rows. It used to live only in the methodology page; pulled out so the
 * landing page can cite the identical claim rather than a paraphrase of it —
 * see `tests/home-page.test.ts` for the pin.
 */
export interface Validation {
  domain: string;
  against: string;
  finding: string;
  result: string;
  outcome: 'match' | 'fixed';
}

export const VALIDATIONS: Validation[] = [
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
