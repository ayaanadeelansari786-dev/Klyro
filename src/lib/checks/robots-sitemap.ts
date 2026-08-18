import type { CategoryDetail, Finding } from '../types';
import { fetchText, makeFinding, type ModuleOutput, plural, truncate } from './util';

const KEY = 'robotsSecurity' as const;

/**
 * Disallow entries worth reporting.
 *
 * Deliberately narrow. `/admin`, `/login` and `/api` are on almost every
 * robots.txt on the internet and are the first paths any attacker tries
 * regardless — listing them tells nobody anything. What is worth reporting is a
 * path that would not have been guessed: an internal tool name, a build
 * artefact, a customer-specific directory.
 */
const GUESSABLE_PATH = /^\/?(admin|administrator|login|signin|sign-in|account|accounts|api|graphql|wp-admin|wp-includes|wp-content|user|users|search|cart|checkout|profile)\/?$/i;

const NOTEWORTHY_PATH =
  /(\.git|\.env|\.svn|backup|dump|\.sql|\.bak|internal|intranet|private|confidential|staging|preprod|jenkins|jira|confluence|phpmyadmin|adminer|cpanel|debug|test-|tmp\/|upload)/i;

const NON_PRODUCTION_HOST = /(^|[.-])(staging|stage|dev|test|qa|uat|sandbox|preprod|internal|local)([.-]|\.)/i;

export async function checkRobotsSecurity(domain: string): Promise<ModuleOutput> {
  const findings: Finding[] = [];
  const details: CategoryDetail[] = [];

  const base = `https://${domain}`;

  const [robots, securityTxt, securityTxtRoot, sitemap] = await Promise.all([
    fetchText(`${base}/robots.txt`, { redirect: 'follow' }, 8_000),
    fetchText(`${base}/.well-known/security.txt`, { redirect: 'follow' }, 8_000),
    fetchText(`${base}/security.txt`, { redirect: 'follow' }, 8_000),
    fetchText(`${base}/sitemap.xml`, { redirect: 'follow' }, 8_000),
  ]);

  if (!robots && !securityTxt && !sitemap) {
    throw new Error('The site did not respond to requests for its public metadata files.');
  }

  /* ---------------- security.txt ---------------- */

  const securityDoc =
    securityTxt && securityTxt.status === 200 && /contact:/i.test(securityTxt.text)
      ? { doc: securityTxt, path: '/.well-known/security.txt' }
      : securityTxtRoot && securityTxtRoot.status === 200 && /contact:/i.test(securityTxtRoot.text)
        ? { doc: securityTxtRoot, path: '/security.txt' }
        : null;

  const hasSecurityTxt = securityDoc !== null;
  let securityScore = 0;
  let securityNote = '';

  if (securityDoc) {
    securityScore = 40;
    securityNote = `Published at ${securityDoc.path} with a Contact field.`;
    const expiresMatch = /^expires:\s*(.+)$/im.exec(securityDoc.doc.text);
    const expires = expiresMatch ? new Date(expiresMatch[1].trim()) : null;

    if (!expires || Number.isNaN(expires.getTime())) {
      securityScore = 32;
      securityNote = `Published at ${securityDoc.path}, but with no valid Expires field.`;
      findings.push(
        makeFinding(KEY, {
          title: 'security.txt has no valid Expires field',
          severity: 'info',
          confidence: 'high',
          asset: `${base}${securityDoc.path}`,
          observed: `${base}${securityDoc.path} returned 200 with a Contact field, but no parseable \`Expires:\` line.`,
          interpretation:
            'RFC 9116 makes Expires a required field. Its absence means a researcher reading the file cannot tell whether the contact details are still current.',
          risk:
            'A researcher who finds a genuine issue may conclude the file is abandoned and either give up or disclose publicly instead of privately. This is a reduction in the chance of getting a report, not an exposure.',
          recommendation: 'Add an `Expires:` field set roughly a year ahead, and diarise the renewal.',
          evidence: {
            test: `GET ${base}${securityDoc.path}, parsed for the Expires field per RFC 9116`,
            observed: 'Contact field present; Expires field absent or unparseable',
            expected: 'An Expires field with a future date',
            verification: 'The file was fetched directly and parsed line by line.',
          },
          scoreImpact: 8,
        }),
      );
    } else if (expires.getTime() < Date.now()) {
      securityScore = 24;
      securityNote = `Published at ${securityDoc.path}, but the Expires date has passed.`;
      findings.push(
        makeFinding(KEY, {
          title: 'security.txt has passed its stated expiry',
          severity: 'low',
          confidence: 'high',
          asset: `${base}${securityDoc.path}`,
          observed: `The file declares \`Expires: ${expires.toISOString()}\`, which is in the past.`,
          interpretation:
            'RFC 9116 states that a file past its expiry should not be relied upon. The published contact route is formally stale, whether or not the address still works.',
          risk:
            'A researcher following the standard will treat the contact as invalid. Reports may go to a general inbox instead, or not at all.',
          recommendation:
            'Update the Expires field and confirm the contact address still reaches whoever handles security reports.',
          evidence: {
            test: `GET ${base}${securityDoc.path}, Expires field parsed and compared to the current date`,
            observed: `Expires: ${expires.toDateString()}`,
            expected: 'A future date',
            verification: 'Compared against the scan timestamp.',
          },
          scoreImpact: 16,
        }),
      );
    }

    const contact = /^contact:\s*(.+)$/im.exec(securityDoc.doc.text)?.[1]?.trim();
    details.push({
      label: 'Security contact',
      value: contact ? truncate(contact, 80) : 'Present',
      mono: true,
      tone: 'good',
    });
  } else {
    securityNote = 'No security.txt with a Contact field at either standard location.';
    findings.push(
      makeFinding(KEY, {
        title: 'No published route for reporting a security issue',
        severity: 'low',
        confidence: 'high',
        asset: domain,
        observed: `Neither ${base}/.well-known/security.txt nor ${base}/security.txt returned a 200 response containing a Contact field.`,
        interpretation:
          'There is no machine-readable route for an outside researcher to report a vulnerability. There may well be a human route — a security page, a bug bounty programme listed elsewhere — that this check does not see.',
        risk:
          'Reports that would otherwise reach a security team go to sales or support inboxes, where they are commonly ignored. Researchers who cannot find a contact within a reasonable effort sometimes publish instead.',
        recommendation:
          'Publish `/.well-known/security.txt` with a monitored `Contact:` address and an `Expires:` date, per RFC 9116. It takes minutes.',
        evidence: {
          test: `GET ${base}/.well-known/security.txt and ${base}/security.txt`,
          observed: `${securityTxt?.status ?? 'no response'} and ${securityTxtRoot?.status ?? 'no response'} respectively; no Contact field found`,
          expected: 'A 200 response containing at least a Contact field',
          verification: 'Both locations named in RFC 9116 were tried.',
          limitation:
            'A security contact published only on a web page, or a bug bounty listing on a third-party platform, would not be detected by this check.',
        },
        scoreImpact: 40,
      }),
    );
    details.push({ label: 'Security contact', value: 'Not published at either standard location', tone: 'warn' });
  }

  /* ---------------- robots.txt ---------------- */

  let robotsScore = 30;
  let robotsNote = 'No robots.txt published, which discloses nothing.';
  const robotsAvailable = robots?.status === 200 && robots.text.trim().length > 0;
  const noteworthy: string[] = [];
  let disallowedCount = 0;

  if (robotsAvailable) {
    const disallowed = [...robots.text.matchAll(/^\s*disallow:\s*(\S+)/gim)]
      .map((m) => m[1].trim())
      .filter((p) => p && p !== '/');
    disallowedCount = disallowed.length;

    for (const path of disallowed) {
      if (GUESSABLE_PATH.test(path)) continue;
      if (NOTEWORTHY_PATH.test(path)) noteworthy.push(path);
    }

    robotsNote = `${disallowed.length} disallow rules, ${noteworthy.length} of which name paths that would not have been guessed.`;

    if (noteworthy.length > 0) {
      robotsScore = Math.max(18, 30 - noteworthy.length * 3);
      findings.push(
        makeFinding(KEY, {
          title: 'robots.txt names paths that would not otherwise be guessable',
          severity: 'info',
          confidence: 'medium',
          asset: `${base}/robots.txt`,
          observed: `${base}/robots.txt contains ${disallowed.length} Disallow rules. ${noteworthy.length} name paths outside the common set: ${noteworthy.slice(0, 10).join(', ')}.`,
          interpretation:
            'robots.txt is a public file by design, and listing paths in it is its intended use. Common entries like /admin or /login reveal nothing — every attacker tries those first anyway. The entries above are less predictable, so the file is the shortest route to knowing they exist.',
          risk:
            'This shortens reconnaissance rather than creating an exposure. If the paths listed are properly protected, nothing follows from their being named. If any is reachable without authentication, robots.txt is where an attacker would find it first.',
          recommendation:
            'Check that each of these paths enforces access control on its own. Where a path only needs to stay out of search results, use a `noindex` response header on the page rather than naming it in a public file.',
          evidence: {
            test: `GET ${base}/robots.txt, Disallow directives extracted and filtered against a list of universally common paths`,
            observed: noteworthy.slice(0, 12).join(', '),
            expected: 'Either no robots.txt, or entries limited to paths an attacker would try regardless',
            verification: 'Commonly listed paths were filtered out first, so the reported set excludes entries that disclose nothing.',
            limitation:
              'Klyro did not request any of these paths as part of this check, so their access control was not tested here.',
          },
          scoreImpact: 30 - robotsScore,
        }),
      );
    }

    details.push(
      {
        label: 'robots.txt',
        value: `${disallowed.length} Disallow rules`,
        mono: true,
        tone: noteworthy.length ? 'warn' : 'good',
      },
      {
        label: 'Less predictable paths named',
        value: noteworthy.length ? noteworthy.slice(0, 8).join(', ') : 'None',
        mono: true,
        tone: noteworthy.length ? 'warn' : 'good',
      },
    );
  } else {
    robotsScore = 26;
    details.push({ label: 'robots.txt', value: 'Not published', tone: 'neutral' });
  }

  /* ---------------- sitemap.xml ---------------- */

  let sitemapScore = 30;
  let sitemapNote = 'No sitemap.xml published.';
  const sitemapAvailable = sitemap?.status === 200 && sitemap.text.includes('<');
  const nonProductionUrls: string[] = [];
  let sitemapUrlCount = 0;

  if (sitemapAvailable) {
    const urls = [...sitemap.text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
    sitemapUrlCount = urls.length;

    for (const url of urls) {
      try {
        const host = new URL(url).hostname;
        if (NON_PRODUCTION_HOST.test(host)) nonProductionUrls.push(url);
      } catch {
        /* malformed entry, ignore */
      }
    }

    sitemapNote = `${urls.length} URLs listed, ${nonProductionUrls.length} on hosts whose names suggest non-production.`;

    if (nonProductionUrls.length > 0) {
      sitemapScore = 18;
      findings.push(
        makeFinding(KEY, {
          title: 'Sitemap submits non-production host names to search engines',
          severity: 'low',
          confidence: 'low',
          asset: `${base}/sitemap.xml`,
          observed: `${nonProductionUrls.length} of ${urls.length} <loc> entries point at host names containing staging, dev, test or similar: ${nonProductionUrls.slice(0, 5).join(', ')}.`,
          interpretation:
            'The naming of these hosts suggests non-production environments, and a sitemap actively asks search engines to crawl and index whatever it lists. The inference rests on the host name alone — Klyro did not request any of these URLs and cannot confirm what runs on them.',
          risk:
            'Where a host genuinely is a test environment, it often carries production-like data with weaker access control, and indexing makes it discoverable without any reconnaissance at all. Where the naming is coincidental, nothing follows.',
          recommendation:
            'Confirm what these hosts serve. If they are non-production, remove them from the sitemap, require authentication, and request removal from the search indexes they have already reached.',
          evidence: {
            test: `GET ${base}/sitemap.xml, <loc> host names matched against a non-production naming pattern`,
            observed: nonProductionUrls.slice(0, 8).join(', '),
            expected: 'Only production host names in a public sitemap',
            verification: 'Not verified beyond the name — this is a naming-based inference and is reported at low confidence for that reason.',
            limitation:
              'Klyro did not request these URLs. A host called "staging" may be a production marketing page; the name is the only signal used here.',
          },
          scoreImpact: 12,
        }),
      );
    }

    details.push(
      {
        label: 'sitemap.xml',
        value: `${urls.length} URLs listed`,
        mono: true,
        tone: nonProductionUrls.length ? 'warn' : 'good',
      },
      ...(nonProductionUrls.length
        ? [
            {
              label: 'Non-production host names',
              value: truncate(nonProductionUrls.join(', '), 180),
              mono: true,
              tone: 'warn' as const,
            },
          ]
        : []),
    );
  } else {
    sitemapScore = 26;
    details.push({ label: 'sitemap.xml', value: 'Not published', tone: 'neutral' });
  }

  details.push({
    label: 'Scope of this check',
    value:
      'Four well-known files at their standard locations. No path enumeration was performed and none of the paths named in these files was requested.',
    tone: 'neutral',
  });

  const score = securityScore + robotsScore + sitemapScore;

  const scoreBreakdown = [
    { label: 'Vulnerability disclosure route', value: securityScore, max: 40, assessed: true, note: securityNote },
    { label: 'robots.txt disclosure', value: robotsScore, max: 30, assessed: true, note: robotsNote },
    { label: 'sitemap.xml contents', value: sitemapScore, max: 30, assessed: true, note: sitemapNote },
  ];

  const summary = hasSecurityTxt
    ? `A security contact is published${noteworthy.length ? `, and robots.txt names ${plural(noteworthy.length, 'less predictable path')}` : ' and the public metadata files disclose nothing unusual'}.`
    : `No security contact is published${noteworthy.length ? `, and robots.txt names ${plural(noteworthy.length, 'less predictable path')}` : ''}.`;

  const facts = {
    securityTxt: hasSecurityTxt,
    robotsDisallowCount: disallowedCount,
    sitemapUrlCount,
    nonProductionUrls: nonProductionUrls.slice(0, 20),
  };

  return { score, summary, findings, details, scoreBreakdown, facts };
}
