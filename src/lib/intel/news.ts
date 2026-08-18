import { fetchText } from '../checks/util';
import type { Severity } from '../types';
import type {
  NewsEventType,
  NewsIntelligence,
  NewsItem,
  NewsVerification,
  PublisherTier,
} from './types';

/**
 * Company news intelligence, sourced from Google News RSS.
 *
 * Google News is an aggregator, not a publisher: it surfaces headlines from
 * outlets of wildly varying quality, including press-release wires where the
 * subject company is the author. This module therefore never treats "it
 * appeared in the news" as a fact — every item carries the outlet, its tier,
 * and whether any independent outlet corroborated it.
 */

const SOURCE_NAME = 'Google News RSS';

/* ------------------------------------------------------------------ *
 * Brand derivation
 * ------------------------------------------------------------------ */

/** Suffixes where the registrable label sits one level further left. */
const MULTIPART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.au', 'net.au', 'org.au',
  'co.nz', 'co.za', 'com.br', 'com.mx', 'com.sg', 'com.tr',
  'co.jp', 'co.kr', 'co.in', 'com.cn', 'com.hk',
  'ae.org', 'com.sa', 'com.eg', 'com.qa', 'com.kw', 'com.bh',
]);

/**
 * Best-effort company name from a domain. This is a guess, and the report says
 * so — searching news for the wrong name is the main way this module could
 * attribute another company's incident to the wrong vendor.
 */
export function deriveBrand(domain: string): { brand: string; derivedFrom: string } {
  const parts = domain.split('.');
  if (parts.length < 2) return { brand: domain, derivedFrom: 'domain name' };

  const lastTwo = parts.slice(-2).join('.');
  const label = MULTIPART_SUFFIXES.has(lastTwo) ? parts[parts.length - 3] : parts[parts.length - 2];

  const brand = (label ?? parts[0])
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return { brand, derivedFrom: `the registrable label in ${domain}` };
}

/* ------------------------------------------------------------------ *
 * Publisher credibility
 * ------------------------------------------------------------------ */

const ESTABLISHED = [
  'reuters', 'associated press', 'ap news', 'bbc', 'financial times', 'wall street journal',
  'bloomberg', 'the guardian', 'new york times', 'washington post', 'cnbc', 'the economist',
  'sky news', 'npr', 'cbs news', 'abc news', 'nbc news', 'cnn', 'al jazeera', 'the times',
  'the telegraph', 'the independent', 'forbes', 'fortune', 'business insider', 'axios',
  'the national', 'gulf news', 'khaleej times', 'arab news', 'zawya', 'the hindu',
];

const SPECIALIST = [
  'krebs on security', 'bleepingcomputer', 'the record', 'securityweek', 'dark reading',
  'the register', 'ars technica', 'wired', 'techcrunch', 'infosecurity', 'the hacker news',
  'cybersecurity dive', 'cyberscoop', 'zdnet', 'help net security', 'security affairs',
  'the verge', 'engadget', 'silicon', 'computer weekly', 'itpro', 'infoworld',
  'banking dive', 'american banker', 'finextra', 'the fintech times',
];

/** Press-release distribution. The company writes these; they are not reporting. */
const WIRES = [
  'pr newswire', 'prnewswire', 'business wire', 'businesswire', 'globenewswire',
  'accesswire', 'einpresswire', 'prweb', 'newsfile', 'newswire', 'openpr', 'issuewire',
];

function publisherTier(publisher: string): PublisherTier {
  const p = publisher.toLowerCase();
  if (WIRES.some((w) => p.includes(w))) return 'wire';
  if (ESTABLISHED.some((e) => p.includes(e))) return 'established';
  if (SPECIALIST.some((s) => p.includes(s))) return 'specialist';
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * Query set
 * ------------------------------------------------------------------ */

interface QuerySpec {
  eventType: NewsEventType;
  terms: string;
}

const QUERIES: QuerySpec[] = [
  {
    eventType: 'security',
    terms: '(breach OR hacked OR ransomware OR cyberattack OR "data leak" OR "security incident" OR vulnerability)',
  },
  {
    eventType: 'legal',
    terms: '(lawsuit OR fined OR fine OR investigation OR regulator OR settlement OR "class action" OR probe)',
  },
  {
    eventType: 'operational',
    terms: '(outage OR downtime OR "service disruption" OR "system failure" OR offline)',
  },
  {
    eventType: 'corporate',
    terms: '(layoffs OR acquisition OR merger OR acquires OR "steps down" OR resigns OR "chief executive" OR funding OR bankruptcy)',
  },
];

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

interface Rule {
  pattern: RegExp;
  classification: string;
  severity: Severity;
}

/** Ordered — the first match wins, so the most serious patterns come first. */
const RULES: Rule[] = [
  { pattern: /\b(data breach|breached|breach of)\b/i, classification: 'Data breach', severity: 'critical' },
  { pattern: /\bransomware\b/i, classification: 'Ransomware', severity: 'critical' },
  { pattern: /\b(data leak|leaked|exposed database|exposed records)\b/i, classification: 'Data exposure', severity: 'high' },
  { pattern: /\b(hacked|cyberattack|cyber attack|compromised)\b/i, classification: 'Cyberattack', severity: 'high' },
  { pattern: /\b(fined|fine of|penalty|penalties)\b/i, classification: 'Fine or penalty', severity: 'high' },
  { pattern: /\b(class action|sued|lawsuit)\b/i, classification: 'Litigation', severity: 'medium' },
  { pattern: /\b(investigation|investigating|probe|regulator|watchdog)\b/i, classification: 'Regulatory scrutiny', severity: 'medium' },
  { pattern: /\b(vulnerability|flaw|zero.day|exploit|patch)\b/i, classification: 'Vulnerability disclosure', severity: 'medium' },
  { pattern: /\b(outage|downtime|offline|disruption|failure)\b/i, classification: 'Service disruption', severity: 'medium' },
  { pattern: /\b(bankrupt|insolven|administration|wind down|winding down)\b/i, classification: 'Financial distress', severity: 'high' },
  { pattern: /\b(layoff|lay off|job cuts|redundanc)\b/i, classification: 'Workforce reduction', severity: 'low' },
  { pattern: /\b(steps down|resigns|departs|new chief executive|new ceo|appoints)\b/i, classification: 'Leadership change', severity: 'low' },
  { pattern: /\b(acquires|acquisition|merger|acquired by|takeover)\b/i, classification: 'M&A activity', severity: 'info' },
  { pattern: /\b(raises|funding|series [a-f]\b|valuation)\b/i, classification: 'Funding', severity: 'info' },
];

/**
 * Headlines that use incident vocabulary while reporting no incident.
 *
 * "How to survive a ransomware attack: Acme's CISO explains" matches the
 * ransomware rule perfectly and is not an incident involving Acme. Classifying
 * it as one attributes a critical event to a company on the strength of its
 * security team giving an interview, which is the single worst failure mode
 * available to this module. Where a headline reads as commentary, the story is
 * kept and shown, but the incident classification is withheld.
 */
const ADVISORY_PATTERN =
  /\b(how to|what to do|guide to|tips?|best practice|lessons?|explains?|explainer|opinion|analysis|survey|report finds|study finds|research (finds|shows)|webinar|podcast|interview|predictions?|outlook|trends?|top \d+|q&a|why (you|your|companies|businesses)|prevent(ing)?|protect(ing)? (your|against)|avoid(ing)?|preparing for|readiness)\b/i;

function classify(title: string, eventType: NewsEventType): { classification: string; severity: Severity } {
  const advisory = ADVISORY_PATTERN.test(title);

  for (const rule of RULES) {
    if (rule.pattern.test(title)) {
      if (advisory) {
        // The vocabulary matched; the framing says it is commentary. Report
        // the story, withhold the claim.
        return { classification: 'Commentary or guidance', severity: 'info' };
      }
      return { classification: rule.classification, severity: rule.severity };
    }
  }
  /*
   * No rule matched. The search terms are broad OR-groups, so appearing in the
   * security query proves nothing about the article — a partnership
   * announcement can surface there. Assigning it a security severity on that
   * basis would be inventing a risk signal, so unmatched stories are recorded
   * as general coverage with no severity claim.
   */
  void eventType;
  return { classification: 'General coverage', severity: 'info' };
}

/* ------------------------------------------------------------------ *
 * RSS parsing
 * ------------------------------------------------------------------ */

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();

const stripCdata = (s: string) => s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');

const tag = (block: string, name: string): string | null => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decodeEntities(stripCdata(m[1])) : null;
};

interface RawItem {
  title: string;
  link: string;
  publisher: string;
  pubDate: string | null;
}

function parseRss(xml: string): RawItem[] {
  const blocks = xml.split('<item>').slice(1);
  const items: RawItem[] = [];

  for (const block of blocks) {
    const rawTitle = tag(block, 'title');
    const link = tag(block, 'link');
    if (!rawTitle || !link) continue;

    // Google News formats titles as "Headline - Publisher".
    const sourceTag = tag(block, 'source');
    let title = rawTitle;
    let publisher = sourceTag ?? '';

    if (!publisher) {
      const split = rawTitle.lastIndexOf(' - ');
      if (split > 20) {
        title = rawTitle.slice(0, split).trim();
        publisher = rawTitle.slice(split + 3).trim();
      }
    } else if (rawTitle.endsWith(` - ${publisher}`)) {
      title = rawTitle.slice(0, rawTitle.length - publisher.length - 3).trim();
    }

    items.push({
      title,
      link,
      publisher: publisher || 'Unknown outlet',
      pubDate: tag(block, 'pubDate'),
    });
  }

  return items;
}

/* ------------------------------------------------------------------ *
 * Deduplication + corroboration
 * ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'is', 'as', 'at', 'by',
  'with', 'from', 'after', 'over', 'its', 'has', 'have', 'says', 'said', 'new',
]);

function significantTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Outlets rewrite the same event in very different words — "fined £21m after
 * customers used No 10 as an address" and "fined $28 million by UK regulator
 * for inadequate controls" are one story. Matching on an exact token signature
 * misses that entirely and reports a heavily-corroborated event as several
 * uncorroborated ones, which understates confidence in exactly the findings
 * that matter most.
 */
const SIMILARITY_THRESHOLD = 0.3;
const SAME_EVENT_WINDOW_DAYS = 12;

function isSameStory(
  a: { tokens: Set<string>; classification: string; time: number | null },
  b: { tokens: Set<string>; classification: string; time: number | null },
): boolean {
  if (a.classification !== b.classification) return false;

  if (a.time !== null && b.time !== null) {
    const days = Math.abs(a.time - b.time) / 86_400_000;
    if (days > SAME_EVENT_WINDOW_DAYS) return false;
  }

  return jaccard(a.tokens, b.tokens) >= SIMILARITY_THRESHOLD;
}

/** Keywords that mark the event being reported, used for subject detection. */
const EVENT_KEYWORD =
  /\b(breach|breached|hacked|ransomware|cyberattack|leak|leaked|exposed|fined|fine|lawsuit|sued|investigation|probe|outage|downtime|vulnerability|exploit|layoff|acquires|acquisition|resigns)\w*/i;

/**
 * Decides whether the organisation is the subject of the headline or merely
 * named in it. The test is positional: a headline about the company almost
 * always names it before the event, while a headline about someone else's
 * incident names the victim first and the vendor later ("Retailer breached
 * via Vendor SSO").
 */
function subjectConfidenceFor(title: string, brand: string): 'primary' | 'mentioned' {
  const lower = title.toLowerCase();
  const brandIndex = lower.indexOf(brand.toLowerCase());
  if (brandIndex === -1) return 'mentioned';
  if (brandIndex <= 3) return 'primary';

  const match = EVENT_KEYWORD.exec(title);
  if (!match) return 'primary';

  return brandIndex < match.index ? 'primary' : 'mentioned';
}

/** Most authoritative outlet in a cluster becomes the item's attribution. */
const TIER_RANK: Record<PublisherTier, number> = {
  established: 0,
  specialist: 1,
  unknown: 2,
  wire: 3,
};

/* ------------------------------------------------------------------ *
 * Module
 * ------------------------------------------------------------------ */

const BLIND_SPOTS = [
  'Only English-language coverage indexed by Google News is searched. Incidents reported solely in local-language or trade press may not appear.',
  'Many security incidents are never reported publicly at all, and those that are often surface months after the event.',
  'Company names are inferred from the domain. A vendor trading under a different name, or one sharing a name with a larger organisation, may return incomplete or mismatched results.',
  'Absence of coverage is not evidence of a clean record — it frequently just means the organisation is small enough not to be newsworthy.',
  'Classification is derived from the headline, not from the article body. A headline is a compressed and sometimes misleading summary, so treat every label here as a pointer to read the source rather than as a determination.',
];

export async function getNewsIntelligence(domain: string): Promise<NewsIntelligence> {
  const { brand, derivedFrom } = deriveBrand(domain);
  const retrievedAt = new Date().toISOString();

  const base: NewsIntelligence = {
    domain,
    brand,
    brandDerivedFrom: derivedFrom,
    retrievedAt,
    sourceName: SOURCE_NAME,
    status: 'ok',
    items: [],
    counts: { security: 0, legal: 0, operational: 0, corporate: 0 },
    corroboratedCount: 0,
    mentionOnlyCount: 0,
    blindSpots: BLIND_SPOTS,
  };

  const responses = await Promise.all(
    QUERIES.map(async (spec) => {
      const q = `"${brand}" ${spec.terms}`;
      const url =
        `https://news.google.com/rss/search?q=${encodeURIComponent(q)}` +
        `&hl=en-US&gl=US&ceid=US:en`;
      const res = await fetchText(url, { redirect: 'follow' }, 12_000);
      return { spec, res };
    }),
  );

  if (responses.every((r) => !r.res || r.res.status !== 200)) {
    return {
      ...base,
      status: 'unavailable',
      error: 'The news source did not respond.',
    };
  }

  // Collect, filtering to stories that actually name the brand — Google News
  // returns loosely-related results, and misattributing another company's
  // breach would be the worst failure this module could produce.
  const brandNeedle = brand.toLowerCase();

  interface Candidate {
    raw: RawItem;
    eventType: NewsEventType;
    classification: string;
    severity: Severity;
    tokens: Set<string>;
    time: number | null;
  }

  const candidates: Candidate[] = [];

  for (const { spec, res } of responses) {
    if (!res || res.status !== 200) continue;
    for (const raw of parseRss(res.text)) {
      if (!raw.title.toLowerCase().includes(brandNeedle)) continue;

      const tokens = significantTokens(raw.title);
      if (tokens.size === 0) continue;

      const { classification, severity } = classify(raw.title, spec.eventType);
      const parsedDate = raw.pubDate ? Date.parse(raw.pubDate) : NaN;

      candidates.push({
        raw,
        eventType: spec.eventType,
        classification,
        severity,
        tokens,
        time: Number.isNaN(parsedDate) ? null : parsedDate,
      });
    }
  }

  // Greedy clustering: each candidate joins the first cluster describing the
  // same event, otherwise starts its own.
  interface Cluster {
    members: Candidate[];
    publishers: Set<string>;
  }

  const clusters: Cluster[] = [];

  for (const candidate of candidates) {
    const existing = clusters.find((c) => isSameStory(candidate, c.members[0]));
    if (existing) {
      existing.members.push(candidate);
      existing.publishers.add(candidate.raw.publisher);
    } else {
      clusters.push({ members: [candidate], publishers: new Set([candidate.raw.publisher]) });
    }
  }

  const items: NewsItem[] = [];
  let index = 0;

  for (const cluster of clusters) {
    // Attribute the story to its most authoritative outlet, and prefer that
    // outlet's headline — wire copy and aggregator rewrites are usually worse.
    const representative = [...cluster.members].sort(
      (a, b) => TIER_RANK[publisherTier(a.raw.publisher)] - TIER_RANK[publisherTier(b.raw.publisher)],
    )[0];

    const publishers = [...cluster.publishers];
    const others = publishers.filter((p) => p !== representative.raw.publisher);
    const independent = publishers.filter((p) => publisherTier(p) !== 'wire');
    const credibility = publisherTier(representative.raw.publisher);

    let verification: NewsVerification;
    if (credibility === 'wire' && independent.length === 0) {
      verification = 'vendor-issued';
    } else if (independent.length >= 2) {
      verification = 'corroborated';
    } else {
      verification = 'single-source';
    }

    // Earliest date in the cluster is closest to the event itself.
    const times = cluster.members.map((m) => m.time).filter((t): t is number => t !== null);
    const publishedAt = times.length ? new Date(Math.min(...times)).toISOString() : null;

    index += 1;
    items.push({
      id: `news-${index}`,
      title: representative.raw.title,
      publisher: representative.raw.publisher,
      url: representative.raw.link,
      publishedAt,
      eventType: representative.eventType,
      classification: representative.classification,
      severity: representative.severity,
      credibility,
      verification,
      subjectConfidence: subjectConfidenceFor(representative.raw.title, brand),
      corroboratingPublishers: others,
    });
  }

  const severityRank: Record<Severity, number> = {
    critical: 0, high: 1, medium: 2, low: 3, info: 4,
  };

  // Stories genuinely about this organisation rank above ones that merely
  // name it, then by severity, then by recency.
  items.sort((a, b) => {
    if (a.subjectConfidence !== b.subjectConfidence) {
      return a.subjectConfidence === 'primary' ? -1 : 1;
    }
    const bySeverity = severityRank[a.severity] - severityRank[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bt - at;
  });

  const trimmed = items.slice(0, 40);

  const counts = { security: 0, legal: 0, operational: 0, corporate: 0 };
  for (const item of trimmed) counts[item.eventType] += 1;

  return {
    ...base,
    items: trimmed,
    counts,
    corroboratedCount: trimmed.filter((i) => i.verification === 'corroborated').length,
    mentionOnlyCount: trimmed.filter((i) => i.subjectConfidence === 'mentioned').length,
  };
}
