/**
 * Technology profile.
 *
 * What the site says it runs on, and whose code it loads. Both halves are read
 * from one response to the home page plus DNS records the scan already needs,
 * so this module adds a single request to the assessment.
 *
 * The scoring rationale is worth stating, because "we detected React" is not a
 * security finding and must never be presented as one. Three things here do
 * bear on exposure:
 *
 * - **Third-party script hosts.** Every external host the page loads script
 *   from is a party that can change what executes in a visitor's browser. That
 *   is a supply chain, and its size is a fact about the site rather than about
 *   the vendors in it.
 * - **Versions the target published about itself.** A `Server` header naming a
 *   build tells an outsider which advisories to read. Klyro reports the
 *   disclosure, never a vulnerability: it does not know whether the version is
 *   patched, and a backported fix leaves the banner unchanged.
 * - **Edge and abuse protection.** A CDN or bot-management layer is directly
 *   observable and materially changes what an outsider can do cheaply.
 *
 * Everything else in the profile is inventory. It is reported, and it is not
 * scored.
 *
 * Where a signal could not be read at all, its component is dropped and the
 * remainder rescaled rather than being scored as a failure — the same rule the
 * rest of the product follows. An unknown must never cost a domain points.
 */

import type {
  CategoryDetail,
  DetectedTechnology,
  Finding,
  TechnologyCategory,
  TechnologyProfile,
} from '../types';
import { PRIMARY_BODY_BYTES, cookieNamesFrom, metaGeneratorOf, readCapped } from './probe';
import {
  answersOfType,
  dnsQuery,
  makeFinding,
  type ModuleOutput,
  plural,
  safeFetch,
  scoreFromComponents,
  type ScoreComponent,
  txtValues,
} from './util';

const KEY = 'technologies' as const;

/* ------------------------------------------------------------------ *
 * Header signals
 * ------------------------------------------------------------------ */

interface HeaderRule {
  header: string;
  match?: RegExp;
  name: string;
  category: TechnologyCategory;
  /** Names the field this rule fills on the profile, when it fills one. */
  slot?: 'webServer' | 'cdn' | 'applicationFramework';
  version?: RegExp;
}

const HEADER_RULES: HeaderRule[] = [
  // Edge and CDN
  { header: 'cf-ray', name: 'Cloudflare', category: 'infrastructure', slot: 'cdn' },
  { header: 'x-amz-cf-id', name: 'Amazon CloudFront', category: 'infrastructure', slot: 'cdn' },
  { header: 'x-akamai-request-id', name: 'Akamai', category: 'infrastructure', slot: 'cdn' },
  { header: 'x-akamai-transformed', name: 'Akamai', category: 'infrastructure', slot: 'cdn' },
  { header: 'x-vercel-id', name: 'Vercel', category: 'infrastructure', slot: 'cdn' },
  { header: 'x-netlify-request-id', name: 'Netlify', category: 'infrastructure', slot: 'cdn' },
  { header: 'x-nf-request-id', name: 'Netlify', category: 'infrastructure', slot: 'cdn' },
  { header: 'x-fastly-request-id', name: 'Fastly', category: 'infrastructure', slot: 'cdn' },
  { header: 'x-azure-ref', name: 'Azure Front Door', category: 'infrastructure', slot: 'cdn' },
  { header: 'x-served-by', match: /cache-/i, name: 'Fastly', category: 'infrastructure', slot: 'cdn' },

  // Caching layers
  { header: 'x-varnish', name: 'Varnish', category: 'infrastructure' },
  { header: 'x-cache', name: 'Edge cache', category: 'infrastructure' },

  // Web servers
  { header: 'server', match: /nginx/i, name: 'nginx', category: 'infrastructure', slot: 'webServer', version: /nginx\/([\d.]+)/i },
  { header: 'server', match: /apache/i, name: 'Apache httpd', category: 'infrastructure', slot: 'webServer', version: /apache\/([\d.]+)/i },
  { header: 'server', match: /microsoft-iis/i, name: 'Microsoft IIS', category: 'infrastructure', slot: 'webServer', version: /iis\/([\d.]+)/i },
  { header: 'server', match: /litespeed/i, name: 'LiteSpeed', category: 'infrastructure', slot: 'webServer' },
  { header: 'server', match: /caddy/i, name: 'Caddy', category: 'infrastructure', slot: 'webServer' },
  { header: 'server', match: /^cloudflare/i, name: 'Cloudflare', category: 'infrastructure', slot: 'cdn' },
  { header: 'server', match: /awselb/i, name: 'AWS Elastic Load Balancing', category: 'infrastructure', slot: 'cdn' },
  { header: 'server', match: /gws|gse/i, name: 'Google Web Server', category: 'infrastructure', slot: 'webServer' },

  // Application frameworks and languages
  { header: 'x-powered-by', match: /express/i, name: 'Express', category: 'infrastructure', slot: 'applicationFramework' },
  { header: 'x-powered-by', match: /php/i, name: 'PHP', category: 'infrastructure', slot: 'applicationFramework', version: /php\/?\s*([\d.]+)/i },
  { header: 'x-powered-by', match: /asp\.net/i, name: 'ASP.NET', category: 'infrastructure', slot: 'applicationFramework' },
  { header: 'x-powered-by', match: /next\.js/i, name: 'Next.js', category: 'frontend', slot: 'applicationFramework' },
  { header: 'x-aspnet-version', name: 'ASP.NET', category: 'infrastructure', slot: 'applicationFramework', version: /([\d.]+)/ },
  { header: 'x-nextjs-cache', name: 'Next.js', category: 'frontend', slot: 'applicationFramework' },
  { header: 'x-rails-request-id', name: 'Ruby on Rails', category: 'infrastructure', slot: 'applicationFramework' },
  { header: 'x-drupal-cache', name: 'Drupal', category: 'frontend' },
  { header: 'x-shopify-stage', name: 'Shopify', category: 'frontend' },
];

/* ------------------------------------------------------------------ *
 * Script signals
 *
 * Matched against the `src` of every <script> tag in the captured markup, plus
 * a handful of inline markers where a product has no external script host.
 * ------------------------------------------------------------------ */

interface ScriptRule {
  pattern: RegExp;
  name: string;
  category: TechnologyCategory;
  /** Fills the named profile slot when this is the strongest match. */
  slot?: 'jsFramework' | 'cssFramework';
}

const SCRIPT_RULES: ScriptRule[] = [
  // Frontend libraries
  { pattern: /\bjquery\b/i, name: 'jQuery', category: 'frontend', slot: 'jsFramework' },
  { pattern: /\breact(-dom)?[.@\-/]/i, name: 'React', category: 'frontend', slot: 'jsFramework' },
  { pattern: /\bvue([.@\-/]|\.min)/i, name: 'Vue', category: 'frontend', slot: 'jsFramework' },
  { pattern: /\bangular([.@\-/]|\.min)/i, name: 'Angular', category: 'frontend', slot: 'jsFramework' },
  { pattern: /\/_next\/static\//i, name: 'Next.js', category: 'frontend', slot: 'jsFramework' },
  { pattern: /\/_nuxt\//i, name: 'Nuxt', category: 'frontend', slot: 'jsFramework' },
  { pattern: /\bsvelte\b/i, name: 'Svelte', category: 'frontend', slot: 'jsFramework' },
  { pattern: /\bbootstrap\b/i, name: 'Bootstrap', category: 'frontend', slot: 'cssFramework' },
  { pattern: /\btailwind\b/i, name: 'Tailwind CSS', category: 'frontend', slot: 'cssFramework' },

  // Analytics
  { pattern: /google-analytics\.com|\/gtag\/js|googletagmanager\.com/i, name: 'Google Analytics or Tag Manager', category: 'analytics' },
  { pattern: /static\.hotjar\.com/i, name: 'Hotjar', category: 'analytics' },
  { pattern: /clarity\.ms/i, name: 'Microsoft Clarity', category: 'analytics' },
  { pattern: /segment\.(com|io)|cdn\.segment/i, name: 'Segment', category: 'analytics' },
  { pattern: /mixpanel/i, name: 'Mixpanel', category: 'analytics' },
  { pattern: /amplitude/i, name: 'Amplitude', category: 'analytics' },

  // Marketing
  { pattern: /js\.hs-scripts\.com|js\.hsforms\.net|hubspot/i, name: 'HubSpot', category: 'marketing' },
  { pattern: /connect\.facebook\.net/i, name: 'Meta Pixel', category: 'marketing' },
  { pattern: /snap\.licdn\.com/i, name: 'LinkedIn Insight', category: 'marketing' },
  { pattern: /marketo/i, name: 'Marketo', category: 'marketing' },

  // Payment
  { pattern: /js\.stripe\.com|stripe\.com\/v\d/i, name: 'Stripe', category: 'payment' },
  { pattern: /paypal\.com\/sdk|paypalobjects/i, name: 'PayPal', category: 'payment' },
  { pattern: /braintree/i, name: 'Braintree', category: 'payment' },
  { pattern: /checkout\.adyen\.com/i, name: 'Adyen', category: 'payment' },

  // Customer support
  { pattern: /widget\.intercom\.io|intercomcdn/i, name: 'Intercom', category: 'support' },
  { pattern: /js\.driftt\.com|drift\.com/i, name: 'Drift', category: 'support' },
  { pattern: /zdassets\.com|zendesk/i, name: 'Zendesk', category: 'support' },
  { pattern: /freshchat|freshdesk/i, name: 'Freshdesk', category: 'support' },
  { pattern: /client\.crisp\.chat/i, name: 'Crisp', category: 'support' },

  // Security and resilience
  { pattern: /recaptcha/i, name: 'Google reCAPTCHA', category: 'security' },
  { pattern: /hcaptcha/i, name: 'hCaptcha', category: 'security' },
  { pattern: /challenges\.cloudflare\.com|turnstile/i, name: 'Cloudflare Turnstile', category: 'security' },
  { pattern: /browser\.sentry-cdn\.com|js\.sentry-cdn\.com/i, name: 'Sentry', category: 'security' },
  { pattern: /datadog|dd-rum/i, name: 'Datadog RUM', category: 'security' },
];

/**
 * Libraries whose *published* version is past its upstream end of life.
 *
 * Only consulted when a version was read out of a script URL. Klyro does not
 * guess a version from behaviour, and it does not claim a vulnerability — an
 * end-of-life major release is a supportability fact, and the finding says so.
 */
const END_OF_LIFE: { name: string; applies: (version: string) => boolean; note: string }[] = [
  {
    name: 'jQuery',
    applies: (v) => Number(v.split('.')[0]) < 3,
    note: 'jQuery 1.x and 2.x stopped receiving upstream fixes in 2016.',
  },
  {
    name: 'Angular',
    applies: (v) => Number(v.split('.')[0]) === 1,
    note: 'AngularJS 1.x reached its end of life in January 2022 and receives no upstream fixes.',
  },
  {
    name: 'Vue',
    applies: (v) => Number(v.split('.')[0]) === 2,
    note: 'Vue 2 reached its end of life in December 2023.',
  },
  {
    name: 'Bootstrap',
    applies: (v) => Number(v.split('.')[0]) < 4,
    note: 'Bootstrap 3 and earlier receive no upstream fixes.',
  },
];

/* ------------------------------------------------------------------ *
 * DNS-derived services
 * ------------------------------------------------------------------ */

const MAIL_PROVIDERS: { pattern: RegExp; name: string }[] = [
  { pattern: /google\.com|googlemail\.com|_spf\.google\.com/i, name: 'Google Workspace' },
  { pattern: /outlook\.com|protection\.outlook\.com|microsoft/i, name: 'Microsoft 365' },
  { pattern: /pphosted\.com|proofpoint/i, name: 'Proofpoint' },
  { pattern: /mimecast/i, name: 'Mimecast' },
  { pattern: /barracuda/i, name: 'Barracuda' },
  { pattern: /messagelabs|symanteccloud/i, name: 'Symantec Email Security' },
  { pattern: /zoho/i, name: 'Zoho Mail' },
  { pattern: /amazonses|amazonaws\.com/i, name: 'Amazon SES' },
  { pattern: /sendgrid/i, name: 'SendGrid' },
  { pattern: /mailgun/i, name: 'Mailgun' },
];

const HOSTING_PROVIDERS: { pattern: RegExp; name: string }[] = [
  { pattern: /amazonaws\.com|elasticbeanstalk|cloudfront\.net/i, name: 'Amazon Web Services' },
  { pattern: /azurewebsites\.net|azureedge\.net|trafficmanager\.net/i, name: 'Microsoft Azure' },
  { pattern: /googleapis\.com|googlehosted|appspot\.com|ghs\.google/i, name: 'Google Cloud' },
  { pattern: /cloudflare\.net|cdn\.cloudflare/i, name: 'Cloudflare' },
  { pattern: /vercel-dns|vercel\.app/i, name: 'Vercel' },
  { pattern: /netlify/i, name: 'Netlify' },
  { pattern: /herokudns|herokuapp/i, name: 'Heroku' },
  { pattern: /fastly/i, name: 'Fastly' },
  { pattern: /akamai|akadns|edgekey|edgesuite/i, name: 'Akamai' },
  { pattern: /wpengine|wordpress\.com/i, name: 'WordPress hosting' },
  { pattern: /shopify/i, name: 'Shopify' },
];

/** TXT verification records name services an organisation has enrolled in. */
const VERIFICATION_RECORDS: { pattern: RegExp; name: string }[] = [
  { pattern: /^google-site-verification=/i, name: 'Google Search Console' },
  { pattern: /^facebook-domain-verification=/i, name: 'Meta Business' },
  { pattern: /^atlassian-domain-verification=/i, name: 'Atlassian' },
  { pattern: /^docusign=/i, name: 'DocuSign' },
  { pattern: /^ZOOM_verify_/i, name: 'Zoom' },
  { pattern: /^stripe-verification=/i, name: 'Stripe' },
  { pattern: /^adobe-idp-site-verification=|^adobe-sign-verification=/i, name: 'Adobe' },
  { pattern: /^slack-domain-verification=/i, name: 'Slack' },
  { pattern: /^miro-verification=/i, name: 'Miro' },
  { pattern: /^dropbox-domain-verification=/i, name: 'Dropbox' },
  { pattern: /^apple-domain-verification=/i, name: 'Apple Business' },
  { pattern: /^onetrust-domain-verification=/i, name: 'OneTrust' },
  { pattern: /^workplace-domain-verification=/i, name: 'Workplace' },
  { pattern: /^mongodb-site-verification=/i, name: 'MongoDB Atlas' },
  { pattern: /^citrix-verification-code=/i, name: 'Citrix' },
];

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

/** Every `src` on a script tag, plus stylesheet hrefs, in document order. */
export function assetUrlsFrom(markup: string): string[] {
  const urls: string[] = [];
  const script = /<script[^>]+src\s*=\s*["']([^"']{1,400})["']/gi;
  const link = /<link[^>]+href\s*=\s*["']([^"']{1,400})["'][^>]*>/gi;

  for (let m = script.exec(markup); m; m = script.exec(markup)) urls.push(m[1]);
  for (let m = link.exec(markup); m; m = link.exec(markup)) {
    if (/rel\s*=\s*["']?stylesheet/i.test(m[0])) urls.push(m[1]);
  }
  return urls;
}

/**
 * A version read out of an asset URL — `jquery-3.6.0.min.js`,
 * `/ajax/libs/jquery/1.12.4/`, `vue@2.6.14`.
 *
 * Returns null rather than guessing. A library loaded from `/js/app.js` has no
 * readable version, and reporting one would be an invention.
 */
export function versionFromUrl(url: string, library: string): string | null {
  const escaped = library.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!escaped) return null;
  const pattern = new RegExp(`${escaped}[^a-z0-9]{0,3}v?(\\d+\\.\\d+(?:\\.\\d+)?)`, 'i');
  const match = pattern.exec(url.replace(/[^a-zA-Z0-9./@_-]/g, ''));
  return match ? match[1] : null;
}

/** Hosts that are not this domain — the parties whose code the page executes. */
export function externalHostsFrom(urls: string[], domain: string): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    if (url.startsWith('/') || url.startsWith('#') || url.startsWith('data:')) continue;
    let host: string;
    try {
      host = new URL(url, `https://${domain}/`).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host || host === domain || host.endsWith(`.${domain}`)) continue;
    hosts.add(host);
  }
  return [...hosts].sort();
}

/* ------------------------------------------------------------------ */

export async function checkTechnologies(domain: string): Promise<ModuleOutput> {
  const findings: Finding[] = [];
  const details: CategoryDetail[] = [];

  // Redirects are followed here, unlike the subdomain probe: the target is the
  // domain the operator asked about, and an apex that bounces to `www` is the
  // same site rather than a different one.
  const res = await safeFetch(
    `https://${domain}/`,
    { method: 'GET', redirect: 'follow', headers: { accept: 'text/html,*/*;q=0.8' } },
    9_000,
  );

  if (!res) {
    throw new Error(
      'The home page did not respond over HTTPS, so no technology profile could be built.',
    );
  }

  const markup = await readCapped(res, PRIMARY_BODY_BYTES, 9_000);
  const bodyRead = markup.length > 0;

  const detected: DetectedTechnology[] = [];
  const profile: TechnologyProfile = {
    domain,
    webServer: null,
    cdn: null,
    applicationFramework: null,
    jsFramework: null,
    cssFramework: null,
    analytics: [],
    marketing: [],
    payment: [],
    customerSupport: [],
    security: [],
    emailProvider: null,
    hostingProvider: null,
    otherServices: [],
    thirdPartyScriptHosts: [],
    versionsDisclosed: [],
    allDetected: [],
    limits: [],
  };

  const add = (tech: DetectedTechnology) => {
    if (detected.some((t) => t.name === tech.name && t.category === tech.category)) return;
    detected.push(tech);
  };

  /* ---------------- Headers ---------------- */

  for (const rule of HEADER_RULES) {
    const value = res.headers.get(rule.header);
    if (value === null) continue;
    if (rule.match && !rule.match.test(value)) continue;

    const version = rule.version ? (rule.version.exec(value)?.[1] ?? null) : null;
    add({
      name: rule.name,
      category: rule.category,
      version,
      evidence: `Response header \`${rule.header}: ${value.slice(0, 100)}\``,
      confidence: 'high',
      ...(version ? { note: 'The version was published by the server itself.' } : {}),
    });

    if (version) {
      profile.versionsDisclosed.push({
        name: rule.name,
        version,
        evidence: `${rule.header}: ${value.slice(0, 100)}`,
      });
    }

    if (rule.slot && !profile[rule.slot]) {
      profile[rule.slot] = version ? `${rule.name} ${version}` : rule.name;
    }
  }

  const cookieNames = cookieNamesFrom(res.headers);

  /* ---------------- Markup ---------------- */

  const assetUrls = bodyRead ? assetUrlsFrom(markup) : [];
  const externalHosts = externalHostsFrom(assetUrls, domain);
  profile.thirdPartyScriptHosts = externalHosts;

  const outdated: { name: string; version: string; note: string; url: string }[] = [];
  let versionsReadable = 0;

  if (bodyRead) {
    const generator = metaGeneratorOf(markup);
    if (generator) {
      const version = /(\d+(?:\.\d+)+)/.exec(generator)?.[1] ?? null;
      const name = generator.replace(/\s*\d+(?:\.\d+)+.*$/, '').trim() || generator;
      add({
        name,
        category: 'frontend',
        version,
        evidence: `<meta name="generator" content="${generator.slice(0, 80)}">`,
        confidence: 'high',
      });
      if (version) {
        profile.versionsDisclosed.push({
          name,
          version,
          evidence: `<meta name="generator" content="${generator.slice(0, 80)}">`,
        });
      }
    }

    for (const rule of SCRIPT_RULES) {
      const hit = assetUrls.find((url) => rule.pattern.test(url)) ?? (rule.pattern.test(markup) ? '' : null);
      if (hit === null || hit === undefined) continue;

      const version = hit ? versionFromUrl(hit, rule.name.split(' ')[0]) : null;
      if (version) versionsReadable += 1;

      add({
        name: rule.name,
        category: rule.category,
        version,
        evidence: hit ? `asset URL \`${hit.slice(0, 120)}\`` : 'identifying marker in the page markup',
        confidence: hit ? 'high' : 'medium',
      });

      if (rule.slot && !profile[rule.slot]) {
        profile[rule.slot] = version ? `${rule.name} ${version}` : rule.name;
      }

      if (version) {
        const eol = END_OF_LIFE.find((e) => e.name === rule.name && e.applies(version));
        if (eol) outdated.push({ name: rule.name, version, note: eol.note, url: hit });
      }
    }
  }

  for (const tech of detected) {
    if (tech.category === 'analytics') profile.analytics.push(tech.name);
    if (tech.category === 'marketing') profile.marketing.push(tech.name);
    if (tech.category === 'payment') profile.payment.push(tech.name);
    if (tech.category === 'support') profile.customerSupport.push(tech.name);
    if (tech.category === 'security') profile.security.push(tech.name);
  }

  // Bot management is visible in a cookie name as often as in a script tag.
  if (cookieNames.some((n) => /^__cf_bm$/i.test(n))) {
    add({
      name: 'Cloudflare Bot Management',
      category: 'security',
      version: null,
      evidence: 'cookie named `__cf_bm`',
      confidence: 'high',
    });
    profile.security.push('Cloudflare Bot Management');
  }
  // Akamai's bot manager is only ever visible as a cookie — it sets no script
  // tag and no header of its own. Missing it reported large estates behind
  // Akamai as having no abuse protection at all.
  if (cookieNames.some((n) => /^bm_sz$|^ak_bmsc$|^_abck$/i.test(n))) {
    add({
      name: 'Akamai Bot Manager',
      category: 'security',
      version: null,
      evidence: 'cookie named for an Akamai bot-management session',
      confidence: 'high',
    });
    profile.security.push('Akamai Bot Manager');
  }
  if (cookieNames.some((n) => /^incap_ses|^visid_incap/i.test(n))) {
    add({
      name: 'Imperva',
      category: 'security',
      version: null,
      evidence: 'cookie named for an Imperva session',
      confidence: 'high',
    });
    profile.security.push('Imperva');
  }

  /* ---------------- DNS-derived services ---------------- */

  const [mx, txt, cname] = await Promise.all([
    dnsQuery(domain, 'MX', { confirmAbsence: false }),
    dnsQuery(domain, 'TXT', { confirmAbsence: false }),
    dnsQuery(`www.${domain}`, 'CNAME', { confirmAbsence: false }),
  ]);

  const mxHosts = answersOfType(mx, 'MX').map((a) => a.data.toLowerCase());
  const txtRecords = txtValues(txt);
  const cnameTargets = answersOfType(cname, 'CNAME').map((a) => a.data.toLowerCase());

  const spf = txtRecords.find((r) => /^v=spf1/i.test(r)) ?? '';
  const mailEvidence = [...mxHosts, spf].join(' ');
  const mailProvider = MAIL_PROVIDERS.find((p) => p.pattern.test(mailEvidence));
  if (mailProvider) {
    profile.emailProvider = mailProvider.name;
    add({
      name: mailProvider.name,
      category: 'email',
      version: null,
      evidence: mxHosts.length ? `MX record \`${mxHosts[0].slice(0, 90)}\`` : `SPF record \`${spf.slice(0, 90)}\``,
      confidence: 'high',
    });
  }

  const hostingEvidence = [...cnameTargets, res.headers.get('server') ?? '', profile.cdn ?? ''].join(' ');
  const hostingProvider = HOSTING_PROVIDERS.find((p) => p.pattern.test(hostingEvidence));
  if (hostingProvider) {
    profile.hostingProvider = hostingProvider.name;
    add({
      name: hostingProvider.name,
      category: 'infrastructure',
      version: null,
      evidence: cnameTargets.length
        ? `CNAME for www.${domain} pointing at \`${cnameTargets[0].slice(0, 90)}\``
        : 'response headers naming the provider',
      confidence: cnameTargets.length ? 'high' : 'medium',
    });
  }

  for (const record of txtRecords) {
    const service = VERIFICATION_RECORDS.find((v) => v.pattern.test(record));
    if (!service || profile.otherServices.includes(service.name)) continue;
    profile.otherServices.push(service.name);
    add({
      name: service.name,
      category: 'other',
      version: null,
      evidence: `TXT verification record \`${record.slice(0, 60)}…\``,
      confidence: 'high',
    });
  }

  profile.allDetected = detected;

  /* ---------------- Findings ---------------- */

  for (const item of outdated) {
    findings.push(
      makeFinding(KEY, {
        title: `${item.name} ${item.version} is past its upstream end of life`,
        severity: 'medium',
        confidence: 'medium',
        asset: domain,
        observed: `The home page loads ${item.name} version ${item.version}, read from the asset URL \`${item.url.slice(0, 140)}\`.`,
        interpretation: `${item.note} The version was read from the file name the site publishes, which is how the library is normally versioned but is not proof of what the file contains.`,
        risk: 'Software that no longer receives upstream fixes accumulates publicly documented defects with no supported route to a patch. No specific defect was tested for, and nothing here establishes that this site is exploitable.',
        recommendation: `Move to a supported major version of ${item.name}. Where the upgrade is disruptive, confirm whether the vendor or distribution supplying this build is backporting fixes.`,
        evidence: {
          test: `GET https://${domain}/, first ${Math.round(PRIMARY_BODY_BYTES / 1024)}KB of the response scanned for script and stylesheet URLs`,
          observed: item.url.slice(0, 200),
          expected: `A supported major version of ${item.name}`,
          verification: 'The version was read out of the published asset path. No request was made to the asset itself and its contents were not inspected.',
          limitation:
            'A file name is not a guarantee of contents. A backported fix leaves the version in the path unchanged, and a build pipeline can rename anything.',
        },
      }),
    );
  }

  if (profile.versionsDisclosed.length > 0) {
    const list = profile.versionsDisclosed.map((v) => `${v.name} ${v.version}`).join(', ');
    findings.push(
      makeFinding(KEY, {
        title: 'Software versions are published in the response',
        severity: 'low',
        confidence: 'high',
        asset: domain,
        observed: `The site publishes its own version numbers: ${list}.`,
        interpretation:
          'The server states which build it runs. This is a default in most software rather than a decision, and it is read directly from the response rather than inferred.',
        risk: 'A stated version tells an outsider which advisories apply without them having to probe for it. It removes a step of reconnaissance; it does not create a weakness, and Klyro did not test whether this build is affected by anything.',
        recommendation:
          'Suppress version tokens at the edge — `server_tokens off` in nginx, `ServerTokens Prod` in Apache, or removing the `X-Powered-By` header at the load balancer.',
        evidence: {
          test: `GET https://${domain}/ and inspection of the response headers and generator tag`,
          observed: profile.versionsDisclosed.map((v) => v.evidence).join(' | ').slice(0, 400),
          expected: 'Response headers that name the software without its build number, or omit it',
          verification: 'Read directly from the response. No inference was involved.',
          limitation:
            'A published version can be inaccurate — banners are editable and proxies rewrite them. Klyro reports what was stated, not what is running.',
        },
      }),
    );
  }

  if (externalHosts.length >= 10) {
    findings.push(
      makeFinding(KEY, {
        title: 'The home page loads code from many external hosts',
        severity: externalHosts.length >= 20 ? 'medium' : 'low',
        confidence: 'high',
        asset: domain,
        observed: `${plural(externalHosts.length, 'external host')} supply script or stylesheet resources to the home page: ${externalHosts.slice(0, 12).join(', ')}${externalHosts.length > 12 ? ` (+${externalHosts.length - 12} more)` : ''}.`,
        interpretation:
          'Each of these is a separate party whose code executes in a visitor\'s browser on this domain. The count is a fact about the page; it says nothing about how well any individual vendor is run.',
        risk: 'Anyone able to change what one of these hosts serves can change what runs for every visitor. This is the mechanism behind card-skimming compromises, where the site itself was never breached. Klyro did not assess any of these vendors.',
        recommendation:
          'Apply Subresource Integrity to third-party scripts that support it, and restrict `script-src` in the Content-Security-Policy to the hosts that genuinely need to run code. Remove tags no team currently owns.',
        evidence: {
          test: `GET https://${domain}/, first ${Math.round(PRIMARY_BODY_BYTES / 1024)}KB scanned for script and stylesheet sources`,
          observed: externalHosts.slice(0, 20).join(', '),
          expected: 'A small set of external code suppliers, each with a named owner',
          verification: 'Hosts were taken from the markup as published. No request was made to any of them.',
          limitation:
            'Only the first 50KB of the home page was read, and scripts injected later by other scripts are not visible to it. The real count is at least this and may be higher.',
        },
      }),
    );
  }

  findings.push(
    makeFinding(KEY, {
      title: 'Technology profile of the public site',
      severity: 'info',
      confidence: 'high',
      asset: domain,
      observed:
        detected.length > 0
          ? `${plural(detected.length, 'technology', 'technologies')} identified: ${detected.slice(0, 12).map((t) => (t.version ? `${t.name} ${t.version}` : t.name)).join(', ')}${detected.length > 12 ? ` (+${detected.length - 12} more)` : ''}.`
          : 'Nothing in the response, the markup or the DNS records identified the software behind this site.',
      interpretation:
        'An inventory of what the site declares about itself. It carries no score on its own — knowing that a site runs a particular framework is reconnaissance, not a weakness.',
      risk: 'None follows from the inventory itself. The scored parts of this category are the supply chain size, the versions published, and whether an edge or abuse-protection layer is present.',
      recommendation:
        'No action from this observation. It is here so a reader can see what the assessment was working from.',
      evidence: {
        test: `GET https://${domain}/ plus MX, TXT and CNAME lookups`,
        observed: detected.map((t) => `${t.name} (${t.evidence})`).join(' | ').slice(0, 1_500),
        verification: 'Every entry carries the exact header, asset URL, cookie name or DNS record it was read from.',
        limitation:
          'Identification is passive and best-effort. Software behind a proxy that strips its headers, or loaded after the first 50KB of markup, is invisible here. Absence from this list is not evidence of absence.',
      },
    }),
  );

  /* ---------------- Details ---------------- */

  details.push(
    { label: 'Web server', value: profile.webServer ?? 'Not stated in the response', mono: true },
    { label: 'CDN or edge', value: profile.cdn ?? 'None identified', mono: true, tone: profile.cdn ? 'good' : 'neutral' },
    { label: 'Application framework', value: profile.applicationFramework ?? 'Not stated', mono: true },
    { label: 'Frontend', value: [profile.jsFramework, profile.cssFramework].filter(Boolean).join(' · ') || 'None identified', mono: true },
    { label: 'Email provider', value: profile.emailProvider ?? 'Not identified from MX or SPF', mono: true },
    { label: 'Hosting', value: profile.hostingProvider ?? 'Not identified', mono: true },
    {
      label: 'External code suppliers',
      value: externalHosts.length ? `${externalHosts.length}: ${externalHosts.slice(0, 8).join(', ')}` : 'None on the home page',
      mono: true,
      tone: externalHosts.length >= 20 ? 'warn' : 'neutral',
    },
    {
      label: 'Abuse protection',
      value: profile.security.length ? profile.security.join(', ') : 'None identified',
      tone: profile.security.length ? 'good' : 'neutral',
    },
    {
      label: 'Versions published',
      value: profile.versionsDisclosed.length
        ? profile.versionsDisclosed.map((v) => `${v.name} ${v.version}`).join(', ')
        : 'None',
      mono: true,
      tone: profile.versionsDisclosed.length ? 'warn' : 'good',
    },
    { label: 'Third-party services from DNS', value: profile.otherServices.join(', ') || 'None identified', mono: true },
    {
      label: 'What this cannot see',
      value:
        'Identification is passive, from one response to the home page. Software behind a proxy that removes its headers, or loaded by later scripts, does not appear. Nothing here establishes that a listed technology is vulnerable — no version was probed and no exploit was attempted.',
      tone: 'neutral',
    },
  );

  profile.limits = [
    'The profile is built from one GET to the home page plus MX, TXT and CNAME lookups. Nothing was probed, and no version was verified against the software actually running.',
    `Only the first ${Math.round(PRIMARY_BODY_BYTES / 1024)}KB of the home page was read, so resources injected by later scripts are not counted.`,
    'A technology appearing here is not a claim that it is out of date or vulnerable. Where an end-of-life version is reported, the version was read from a published asset path rather than from the file itself.',
  ];

  /* ---------------- Score ---------------- */

  const components: ScoreComponent[] = [
    {
      label: 'Library versions in support',
      value: outdated.length === 0 ? 30 : Math.max(0, 30 - outdated.length * 15),
      max: 30,
      // Nothing to judge unless a version was actually readable. Awarding the
      // points for an unreadable version would reward obscurity; deducting
      // them would punish a site for minifying its asset names.
      known: versionsReadable > 0,
      note:
        versionsReadable > 0
          ? outdated.length === 0
            ? `${plural(versionsReadable, 'library version')} were readable from asset paths and none is past its upstream end of life.`
            : `${plural(outdated.length, 'library')} past upstream end of life: ${outdated.map((o) => `${o.name} ${o.version}`).join(', ')}.`
          : 'No library version could be read from the published asset paths, so this component was dropped rather than assumed either way.',
    },
    {
      label: 'Size of the external code supply chain',
      value: externalHosts.length < 10 ? 20 : externalHosts.length < 20 ? 12 : externalHosts.length < 30 ? 6 : 0,
      max: 20,
      known: bodyRead,
      note: bodyRead
        ? `${plural(externalHosts.length, 'external host')} supply code to the home page. Fewer than ten scores full marks; the deduction grows with the count.`
        : 'The home page returned no readable body, so the supply chain could not be counted.',
    },
    {
      label: 'CDN or edge layer',
      value: profile.cdn ? 20 : 0,
      max: 20,
      note: profile.cdn
        ? `${profile.cdn} identified from the response headers.`
        : 'No CDN or edge layer was identifiable from the response headers. Absence of a header is weaker evidence than presence of one.',
    },
    {
      label: 'Bot and abuse protection',
      value: profile.security.length > 0 ? 15 : 0,
      max: 15,
      known: bodyRead,
      note: profile.security.length
        ? `Identified: ${profile.security.join(', ')}.`
        : 'No CAPTCHA, challenge or bot-management layer was identifiable from the home page. Protection applied only to sign-in or checkout pages would not be visible here.',
    },
    {
      label: 'Version disclosure',
      value: profile.versionsDisclosed.length === 0 ? 15 : Math.max(0, 15 - profile.versionsDisclosed.length * 8),
      max: 15,
      note:
        profile.versionsDisclosed.length === 0
          ? 'No build number was published in the response headers or the generator tag.'
          : `${plural(profile.versionsDisclosed.length, 'version')} published: ${profile.versionsDisclosed.map((v) => `${v.name} ${v.version}`).join(', ')}.`,
    },
  ];

  const { score, coverage, breakdown } = scoreFromComponents(components);

  const summary =
    detected.length === 0
      ? 'Nothing in the response identified the software behind this site, so this category reports an empty profile rather than a clean one.'
      : `${plural(detected.length, 'technology', 'technologies')} identified from the response and DNS records, with ${plural(externalHosts.length, 'external host')} supplying code to the home page${profile.versionsDisclosed.length ? ` and ${plural(profile.versionsDisclosed.length, 'version')} published in the response` : ''}.`;

  return {
    score,
    summary,
    findings,
    details,
    scoreBreakdown: breakdown,
    moduleCoverage: coverage,
    facts: {
      technologies: detected.map((t) => t.name),
      externalHosts,
      versionsDisclosed: profile.versionsDisclosed.map((v) => `${v.name} ${v.version}`),
      cdn: profile.cdn,
      emailProvider: profile.emailProvider,
      hostingProvider: profile.hostingProvider,
    },
    payload: { technologyProfile: profile },
  };
}
