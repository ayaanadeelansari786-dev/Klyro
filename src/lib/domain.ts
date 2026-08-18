/** Domain normalisation + validation shared by the form and every API route. */

const DOMAIN_RE =
  /^(?=.{1,253}$)(?!-)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Whitespace, or a C0/DEL control character. */
function hasControlCharacter(host: string): boolean {
  if (/\s/.test(host)) return true;
  return [...host].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

/** Anything outside ASCII — an internationalised name, in practice. */
function hasNonAscii(host: string): boolean {
  return [...host].some((char) => (char.codePointAt(0) ?? 0) > 127);
}

export interface DomainParseResult {
  ok: boolean;
  domain: string;
  error?: string;
}

/**
 * Strips scheme, credentials, port, path, query and a leading `www.`, then
 * validates the remainder as a registrable host name. IP literals are rejected
 * — several checks (certificate transparency, WHOIS/RDAP, email policy) are
 * only meaningful for domains.
 */
export function parseDomain(input: string): DomainParseResult {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, domain: '', error: 'Enter a domain to assess.' };

  let host = raw.toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  host = host.replace(/^[^/@]*@/, ''); // userinfo
  host = host.split('/')[0].split('?')[0].split('#')[0];
  host = host.replace(/:\d+$/, ''); // port
  host = host.replace(/\.$/, ''); // root label
  host = host.replace(/^www\./, '');

  if (!host) return { ok: false, domain: '', error: 'Enter a valid domain.' };

  /*
   * Whitespace and control characters are refused first, with their own
   * message. They used to fall through to the IPv6 branch below — a pasted
   * `example.com\r\nHeader: value` contains a colon, so the reader was told to
   * stop entering an IP address they had not entered.
   */
  if (hasControlCharacter(host)) {
    return {
      ok: false,
      domain: '',
      error: 'A domain cannot contain spaces, line breaks or control characters.',
    };
  }

  if (IPV4_RE.test(host) || host.includes(':')) {
    return { ok: false, domain: host, error: 'Enter a domain name, not an IP address.' };
  }

  /*
   * Internationalised names are not supported. They are perfectly valid
   * domains, so "that does not look like a valid domain" was simply untrue —
   * and the ASCII form of the same name is accepted today, which makes this
   * something the reader can act on.
   */
  if (hasNonAscii(host)) {
    return {
      ok: false,
      domain: host,
      error:
        'Klyro does not yet assess internationalised domain names. Enter the punycode form of the name, which begins xn--.',
    };
  }

  if (host.includes('_')) {
    return { ok: false, domain: host, error: 'Domains cannot contain underscores.' };
  }

  if (!host.includes('.')) {
    return { ok: false, domain: host, error: 'Enter a full domain, for example acme.com.' };
  }

  if (!DOMAIN_RE.test(host)) {
    return { ok: false, domain: host, error: 'That does not look like a valid domain.' };
  }

  return { ok: true, domain: host };
}

/* ------------------------------------------------------------------ *
 * Registrable domain (eTLD+1)
 *
 * Used to decide whether two host names belong to the same operator —
 * `gwa.fe.bosch.de` and `gwa2.fe.bosch.de` do; `ns1.example.com` and
 * `ns-1.awsdns-01.net` do not.
 *
 * This is a heuristic, not the Public Suffix List. The PSL is roughly 15,000
 * entries maintained by Mozilla, updated continuously, and shipping it means
 * shipping a dependency that goes stale. What is here instead is the set of
 * two-label suffixes common enough to matter, plus a stated limitation
 * wherever a conclusion rests on it.
 *
 * The failure mode the list exists to prevent: without it, `ns1.example.co.uk`
 * and `ns1.other.co.uk` both reduce to `co.uk` and two unrelated operators are
 * reported as one. Callers that cannot tolerate that ambiguity should check
 * `registrableDomainIsCertain` first.
 * ------------------------------------------------------------------ */

/**
 * Second-level suffixes under which names are registered directly.
 *
 * Deliberately not exhaustive. Additions are cheap; a wrong entry is not, so
 * this holds only suffixes where registration at the third label is the rule
 * rather than an exception.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
  // Australia / New Zealand
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  // Japan / Korea / China / India / Singapore / Hong Kong
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'ad.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 're.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'edu.in',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk',
  // Americas
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar',
  'com.co', 'net.co', 'org.co', 'gov.co',
  // Europe / Middle East / Africa
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'co.il', 'org.il', 'net.il', 'gov.il', 'ac.il',
  'com.ua', 'com.pl', 'net.pl', 'org.pl', 'gov.pl',
  'com.ru', 'net.ru', 'org.ru',
  'com.es', 'org.es', 'gob.es', 'edu.es',
  'com.pt', 'com.gr', 'com.cy', 'com.mt',
  // Gulf
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa',
  'co.ae', 'net.ae', 'org.ae', 'gov.ae', 'ac.ae', 'sch.ae',
  'com.qa', 'net.qa', 'org.qa', 'gov.qa', 'edu.qa',
  'com.kw', 'com.bh', 'com.om', 'com.jo', 'com.lb', 'com.eg',
]);

/**
 * The registrable name a host sits under — `fe.bosch.de` → `bosch.de`.
 *
 * Returns the input unchanged when it has too few labels to reduce. Never
 * throws: a malformed name yields a lowercased best effort rather than an
 * exception, because every caller is classifying rather than validating.
 */
export function registrableDomain(host: string): string {
  const name = (host ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!name || !name.includes('.')) return name;

  const labels = name.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Whether the reduction above is safe to draw a conclusion from.
 *
 * False when the name ends in a two-label suffix that is *not* in the list but
 * looks like one — a two-letter country code preceded by a short generic label
 * — because that is exactly the case the heuristic gets wrong. Callers report
 * the ambiguity rather than the conclusion.
 */
export function registrableDomainIsCertain(host: string): boolean {
  const labels = (host ?? '').trim().toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return true;

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return true;

  const [secondLevel, tld] = labels.slice(-2);
  const looksLikeUnlistedPublicSuffix =
    tld.length === 2 && /^(com|net|org|edu|gov|co|ac|or|ne|go|gob|govt|nom|ltd|web|info)$/.test(secondLevel);

  return !looksLikeUnlistedPublicSuffix;
}

/** Convenience wrapper for API routes: returns the domain or throws a message. */
export function requireDomain(input: string | null): string {
  const parsed = parseDomain(input ?? '');
  if (!parsed.ok) throw new Error(parsed.error ?? 'Invalid domain.');
  return parsed.domain;
}
