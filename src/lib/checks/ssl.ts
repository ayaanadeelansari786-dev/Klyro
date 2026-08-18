import { guardedLookup } from '../target';
import type { CategoryDetail, Finding } from '../types';
import {
  daysBetween,
  fetchJson,
  makeFinding,
  makeUnknown,
  type ModuleOutput,
  safeFetch,
  type ScoreComponent,
  scoreFromComponents,
  truncate,
} from './util';

const KEY = 'ssl' as const;

interface TlsProbe {
  reachable: boolean;
  /**
   * The server answered and rejected the handshake at the TLS layer — for a
   * version-capped probe that is a *refusal*, which is the desired outcome.
   * Distinct from `reachable: false` with `refused: false`, which means the
   * connection never got far enough to tell us anything.
   */
  refused: boolean;
  /** Transport-level detail, kept for the evidence string. */
  failure?: string;
  protocol: string | null;
  cipher: string | null;
  authorized: boolean;
  authorizationError?: string;
  issuer?: string;
  subject?: string;
  validFrom?: string;
  validTo?: string;
  altNames?: string[];
  chainLength?: number;
  /** Public key size in bits, as reported by OpenSSL. */
  keyBits?: number;
  /** Named curve for EC keys; absent for RSA. */
  keyCurve?: string;
  serialNumber?: string;
  fingerprint?: string;
}

/**
 * Errors that mean "this server will not speak that version", as opposed to
 * "something ate the connection". A timeout or a bare reset is deliberately
 * *not* in this list: plenty of load balancers drop a capped handshake without
 * an alert, and treating that as a refusal is how a probe failure turns into a
 * clean bill of health.
 */
const TLS_REFUSAL = /protocol|version|no ciphers|cipher mismatch|handshake failure|alert|unsupported|wrong version/i;

function classifyTlsError(err: NodeJS.ErrnoException): { refused: boolean; failure: string } {
  const detail = `${err.code ?? ''} ${err.message ?? ''}`.trim();
  const code = err.code ?? '';
  const refused =
    TLS_REFUSAL.test(detail) || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_');
  return { refused, failure: detail || 'connection failed' };
}

/** Certificate distinguished-name fields may repeat; take the first value. */
function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0] || undefined;
  return value || undefined;
}

/**
 * Opens a single TLS connection and reads the negotiated parameters. This is
 * the same handshake any browser performs — no probing beyond what a normal
 * visit does.
 */
async function tlsProbe(
  host: string,
  opts: { maxVersion?: 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3'; timeoutMs?: number } = {},
): Promise<TlsProbe> {
  const tls = await import('node:tls');
  const timeoutMs = opts.timeoutMs ?? 8_000;

  return new Promise<TlsProbe>((resolve) => {
    let settled = false;
    const done = (value: TlsProbe) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
      resolve(value);
    };

    const socket = tls.connect(
      {
        host,
        port: 443,
        servername: host,
        // Read the certificate even when it fails validation, so an expired or
        // mismatched cert produces a finding rather than an opaque failure.
        rejectUnauthorized: false,
        // This probe opens a socket directly rather than going through fetch,
        // so it does not inherit the guarded dispatcher. It gets the same
        // check at the same point in the connection instead.
        lookup: guardedLookup,
        ...(opts.maxVersion
          ? { minVersion: 'TLSv1' as const, maxVersion: opts.maxVersion }
          : {}),
      },
      () => {
        const cert = socket.getPeerCertificate(true);
        const chain: string[] = [];
        let node: typeof cert | undefined = cert;
        const seen = new Set<string>();
        while (node && node.fingerprint && !seen.has(node.fingerprint)) {
          seen.add(node.fingerprint);
          chain.push(node.fingerprint);
          node = node.issuerCertificate as typeof cert | undefined;
        }

        const cipherInfo = socket.getCipher();

        done({
          reachable: true,
          refused: false,
          protocol: socket.getProtocol(),
          cipher: cipherInfo?.name ?? null,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError
            ? String(socket.authorizationError)
            : undefined,
          // Node types DN fields as string | string[] (repeated RDNs).
          issuer: firstValue(cert?.issuer?.O) ?? firstValue(cert?.issuer?.CN),
          subject: firstValue(cert?.subject?.CN),
          validFrom: cert?.valid_from,
          validTo: cert?.valid_to,
          altNames: cert?.subjectaltname
            ? cert.subjectaltname.split(',').map((s) => s.trim().replace(/^DNS:/, ''))
            : undefined,
          chainLength: chain.length,
          keyBits: typeof cert?.bits === 'number' ? cert.bits : undefined,
          keyCurve: cert?.nistCurve ?? cert?.asn1Curve ?? undefined,
          serialNumber: cert?.serialNumber,
          fingerprint: cert?.fingerprint256,
        });
      },
    );

    socket.setTimeout(timeoutMs, () =>
      done({
        reachable: false,
        refused: false,
        failure: `no response within ${timeoutMs}ms`,
        protocol: null,
        cipher: null,
        authorized: false,
      }),
    );

    socket.on('error', (err: NodeJS.ErrnoException) => {
      const { refused, failure } = classifyTlsError(err);
      done({ reachable: false, refused, failure, protocol: null, cipher: null, authorized: false });
    });
  });
}

interface CrtRecord {
  issuer_name?: string;
  not_before?: string;
  not_after?: string;
  common_name?: string;
  name_value?: string;
}

/**
 * The smallest key size still considered adequate, per NIST SP 800-57 and the
 * CA/Browser Forum baseline requirements. RSA below 2048 and EC below 256 have
 * not been issuable by a public CA for years, so seeing one implies a private
 * or very old certificate.
 */
const MIN_RSA_BITS = 2048;
const MIN_EC_BITS = 256;

export async function checkSsl(domain: string): Promise<ModuleOutput> {
  const findings: Finding[] = [];
  const details: CategoryDetail[] = [];

  const probe = await tlsProbe(domain);
  let probedHost = domain;

  // Fall back to certificate transparency when the host refuses connections
  // (firewalled, apex not served, or web presence lives on www only).
  let ctRecord: CrtRecord | null = null;
  if (!probe.reachable) {
    const wwwProbe = await tlsProbe(`www.${domain}`);
    if (wwwProbe.reachable) {
      Object.assign(probe, wwwProbe);
      probedHost = `www.${domain}`;
    } else {
      const records = await fetchJson<CrtRecord[]>(
        `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json&exclude=expired`,
        { headers: { accept: 'application/json' } },
        12_000,
      );
      if (records?.length) {
        ctRecord = records
          .filter((r) => r.not_after)
          .sort(
            (a, b) => new Date(b.not_after as string).getTime() - new Date(a.not_after as string).getTime(),
          )[0];
      }
    }
  }

  if (!probe.reachable && !ctRecord) {
    throw new Error('No TLS service answered on port 443 and no certificate records were found.');
  }

  const source = probe.reachable ? 'live TLS handshake' : 'certificate transparency logs';

  const now = new Date();
  const validToRaw = probe.validTo ?? ctRecord?.not_after;
  const validTo = validToRaw ? new Date(validToRaw) : null;
  const daysToExpiry = validTo && !Number.isNaN(validTo.getTime()) ? daysBetween(now, validTo) : null;

  const issuer = probe.issuer ?? ctRecord?.issuer_name ?? 'Unknown';
  const subject = probe.subject ?? ctRecord?.common_name ?? domain;
  const altNames = probe.altNames ?? (ctRecord?.name_value ? ctRecord.name_value.split('\n') : []);

  /* ---------------- Validity ---------------- */

  const certValid = probe.reachable ? probe.authorized : daysToExpiry !== null && daysToExpiry > 0;

  if (probe.reachable && !probe.authorized) {
    const reason = probe.authorizationError ?? 'unknown validation error';
    const isExpiry = /expired/i.test(reason);
    const isMismatch = /altnames|hostname|mismatch/i.test(reason);
    const isSelfSigned = /self[- ]signed|unable to (get|verify)/i.test(reason);

    findings.push(
      makeFinding(KEY, {
        title: 'Certificate does not validate against the public trust stores',
        severity: 'high',
        confidence: 'high',
        asset: `${probedHost}:443`,
        observed: `A TLS handshake with ${probedHost} completed, but certificate verification failed with: ${reason}. Certificate subject: ${subject}, issued by ${issuer}.`,
        interpretation: isExpiry
          ? 'The certificate presented is past its notAfter date. Every mainstream browser and HTTPS client rejects an expired certificate outright.'
          : isMismatch
            ? `The certificate presented does not list ${probedHost} among its subject alternative names. This is what a client sees during a genuine interception attempt, so clients cannot distinguish it from one.`
            : isSelfSigned
              ? 'The certificate is not chained to a certificate authority in the public trust stores, either because it is self-signed or because the intermediate certificates were not sent.'
              : 'The certificate cannot be verified against the public trust stores, so clients cannot establish that the server is who it claims to be.',
        risk:
          'Browsers present a full-page interstitial before the site can be reached, and non-browser clients — mobile applications, payment integrations, API consumers — generally refuse the connection with no way for a user to proceed. Users who are trained to click through such warnings will also click through a real interception.',
        recommendation: isExpiry
          ? 'Renew the certificate and put automated renewal in place with an alert that fires on failure rather than on expiry.'
          : isMismatch
            ? `Reissue the certificate with ${probedHost} in the subject alternative names, or serve this host from wherever the correct certificate is installed.`
            : 'Install the full chain supplied by the certificate authority, including intermediates, and confirm with an external checker that the chain resolves.',
        evidence: {
          test: `TLS handshake with ${probedHost}:443, certificate verified against the Node.js root store`,
          observed: reason,
          expected: 'A certificate chaining to a trusted root, in date, covering this host name',
          verification: 'Verification was performed by OpenSSL against the bundled Mozilla root store, the same set browsers use.',
          limitation:
            'Trust stores differ slightly between platforms. A chain that fails here fails for most clients, but the exact set is not identical everywhere.',
        },
        scoreImpact: 25,
      }),
    );
  }

  if (daysToExpiry !== null) {
    if (daysToExpiry <= 0 && !probe.reachable) {
      findings.push(
        makeFinding(KEY, {
          title: 'The most recent certificate on record has expired',
          severity: 'medium',
          confidence: 'medium',
          asset: domain,
          observed: `No TLS service answered on ${domain}:443 or www.${domain}:443. The most recent unexpired certificate found in transparency logs expired ${Math.abs(daysToExpiry)} days ago, on ${validTo?.toDateString()}.`,
          interpretation:
            'Nothing is serving HTTPS on this domain, and the newest certificate that was ever logged for it has passed its expiry date. The likely readings are a decommissioned host, a name that never served web traffic, or a service that has lapsed.',
          risk:
            'If anything is still expected to be served here, clients reach either nothing or a certificate error. If the domain is genuinely retired, there is no risk from this — but a retired domain still resolving is worth confirming.',
          recommendation:
            'Confirm whether this domain is meant to serve a website. If it is, renew and reinstall. If it is not, consider removing the address records so the state is unambiguous.',
          evidence: {
            test: `TLS connection attempted to ${domain}:443 and www.${domain}:443; certificate transparency queried for unexpired certificates`,
            observed: `No TLS response; newest logged certificate expired ${validTo?.toDateString()}`,
            expected: 'A live TLS service, or no certificate history at all',
            verification: 'Two host names were attempted before falling back to transparency logs.',
            limitation:
              'Transparency logs record issuance, not deployment. A certificate in the log may never have been installed anywhere, and one installed today may not yet appear.',
          },
        }),
      );
    } else if (daysToExpiry > 0 && daysToExpiry <= 14) {
      findings.push(
        makeFinding(KEY, {
          title: 'Certificate expires within two weeks',
          severity: 'medium',
          confidence: 'high',
          asset: `${probedHost}:443`,
          observed: `The certificate served by ${probedHost} expires on ${validTo?.toDateString()}, in ${daysToExpiry} days.`,
          interpretation:
            'Renewal is due imminently. Most certificates are renewed automatically, in which case this is expected and no action follows; where renewal is manual, this is the window in which it has to happen.',
          risk:
            'If renewal has not been arranged, the site becomes unreachable behind a browser interstitial the moment the certificate lapses, with no grace period and no gradual degradation.',
          recommendation:
            'Confirm automated renewal is configured and has run successfully, and set an alert on renewal failure rather than on approaching expiry.',
          evidence: {
            test: `Certificate notAfter read from the live handshake with ${probedHost}`,
            observed: `notAfter = ${validTo?.toUTCString()}`,
            expected: 'More than 30 days remaining, with automated renewal in place',
            verification: 'Read from the certificate the server actually presented, not from a log.',
          },
          scoreImpact: 9,
        }),
      );
    } else if (daysToExpiry > 14 && daysToExpiry <= 30) {
      findings.push(
        makeFinding(KEY, {
          title: 'Certificate expires within 30 days',
          severity: 'low',
          confidence: 'high',
          asset: `${probedHost}:443`,
          observed: `The certificate served by ${probedHost} expires on ${validTo?.toDateString()}, in ${daysToExpiry} days.`,
          interpretation:
            'Renewal falls due within the month. For the 90-day certificates most automated issuers produce, this is the normal point in the cycle at which renewal happens.',
          risk:
            'None while renewal is automated and working. Where it is manual, this is the last comfortable window before the expiry becomes urgent.',
          recommendation: 'Verify the renewal process runs automatically and alerts a monitored address on failure.',
          evidence: {
            test: `Certificate notAfter read from the live handshake with ${probedHost}`,
            observed: `notAfter = ${validTo?.toUTCString()}`,
            expected: 'Automated renewal well before this point',
            verification: 'Read from the certificate the server actually presented.',
          },
          scoreImpact: 4,
        }),
      );
    }
  }

  /* ---------------- Key strength ---------------- */

  const keyBits = probe.keyBits ?? null;
  const isEc = Boolean(probe.keyCurve);
  const keyFloor = isEc ? MIN_EC_BITS : MIN_RSA_BITS;
  const keyStrong = keyBits === null ? null : keyBits >= keyFloor;

  if (keyStrong === false) {
    findings.push(
      makeFinding(KEY, {
        title: 'Certificate public key is below current minimum strength',
        severity: 'medium',
        confidence: 'high',
        asset: `${probedHost}:443`,
        observed: `The certificate presents a ${keyBits}-bit ${isEc ? `EC (${probe.keyCurve})` : 'RSA'} public key.`,
        interpretation:
          `The CA/Browser Forum baseline requirements set a floor of ${keyFloor} bits for ${isEc ? 'elliptic curve' : 'RSA'} keys in publicly trusted certificates. A key below that floor indicates either a private certificate authority or a certificate predating the requirement.`,
        risk:
          'Undersized keys have a materially lower cost to break than the standard assumes. Some client libraries and operating system policies already refuse them, which presents as unexplained connection failures on a subset of clients.',
        recommendation: `Reissue with a key of at least ${keyFloor} bits — ${isEc ? 'P-256 or stronger' : 'RSA 2048 or stronger'}.`,
        evidence: {
          test: `Public key parameters read from the certificate presented by ${probedHost}`,
          observed: `${keyBits} bits${probe.keyCurve ? `, curve ${probe.keyCurve}` : ', RSA'}`,
          expected: `At least ${keyFloor} bits`,
          verification: 'Read from the live handshake by OpenSSL.',
        },
        scoreImpact: 8,
      }),
    );
  }

  /* ---------------- Protocol version ---------------- */

  /*
   * Three states, not two. This used to read `legacyTlsSupported =
   * legacy.reachable`, so a probe that timed out or was dropped by a WAF —
   * which is common on the second connection from one IP — was recorded as
   * "legacy refused" and awarded full marks. A failed measurement must never
   * improve a score.
   */
  type LegacyState = 'accepted' | 'refused' | 'unknown';
  let legacyState: LegacyState = 'unknown';
  let legacyEvidence = 'not probed';

  if (probe.reachable) {
    const negotiated = probe.protocol ?? '';
    if (negotiated === 'TLSv1' || negotiated === 'TLSv1.1') {
      legacyState = 'accepted';
      legacyEvidence = `negotiated ${negotiated} on an unconstrained handshake`;
      findings.push(
        makeFinding(KEY, {
          title: 'Server negotiates a retired TLS version by default',
          severity: 'high',
          confidence: 'high',
          asset: `${probedHost}:443`,
          observed: `An unconstrained handshake — one that offered every version up to TLS 1.3 — settled on ${negotiated}. Cipher: ${probe.cipher ?? 'not reported'}.`,
          interpretation:
            `${negotiated} was deprecated by RFC 8996 in 2021 and removed from all mainstream browsers. A server that selects it when TLS 1.2 and 1.3 were both offered is not configured to support them.`,
          risk:
            'These versions permit cipher suites and constructions with known weaknesses, and are excluded by PCI DSS. More immediately, current browsers refuse to connect at all, so this configuration breaks the site for ordinary visitors as well as weakening it.',
          recommendation:
            'Enable TLS 1.2 and 1.3 on the web server or load balancer and set the minimum accepted version to 1.2.',
          evidence: {
            test: `TLS handshake with ${probedHost}:443 offering all versions`,
            observed: `Negotiated ${negotiated}`,
            expected: 'TLS 1.2 or 1.3',
            verification: 'The client offered the full modern range, so the selection was the server\'s.',
          },
          scoreImpact: 17,
        }),
      );
    } else {
      // Modern handshake succeeded — check whether legacy is *also* accepted.
      const legacy = await tlsProbe(probedHost, { maxVersion: 'TLSv1.1', timeoutMs: 8_000 });

      if (legacy.reachable) {
        legacyState = 'accepted';
        legacyEvidence = `handshake succeeded with maxVersion TLSv1.1 (negotiated ${legacy.protocol})`;
        findings.push(
          makeFinding(KEY, {
            title: 'Server still accepts TLS 1.0 or 1.1 when asked',
            severity: 'medium',
            confidence: 'high',
            asset: `${probedHost}:443`,
            observed: `The default handshake negotiated ${probe.protocol}. A second handshake capped at TLS 1.1 also succeeded, negotiating ${legacy.protocol}.`,
            interpretation:
              'Modern clients get a modern connection, but the server has not disabled the retired versions — it will use them for any client that offers nothing better.',
            risk:
              'Any client that negotiates down, whether an old device or an attacker manipulating the handshake, gets a connection using constructions retired by RFC 8996. This is also an explicit PCI DSS failure for any environment in scope.',
            recommendation: 'Set the minimum TLS version to 1.2 on the web server, CDN or load balancer.',
            evidence: {
              test: `Second TLS handshake with ${probedHost}:443, capped at maxVersion TLSv1.1`,
              observed: `Handshake completed, negotiated ${legacy.protocol}`,
              expected: 'A protocol_version alert refusing the handshake',
              verification: 'Both the unconstrained and the capped handshake completed, so this is a positive observation rather than an inference from a failure.',
            },
            scoreImpact: 17,
          }),
        );
      } else if (legacy.refused) {
        legacyState = 'refused';
        legacyEvidence = `server rejected a TLSv1.1-capped handshake (${legacy.failure})`;
      } else {
        legacyState = 'unknown';
        legacyEvidence = legacy.failure ?? 'the capped handshake produced no answer';
        findings.push(
          makeUnknown(KEY, {
            title: 'Legacy TLS support could not be determined',
            asset: `${probedHost}:443`,
            observed: `A handshake capped at TLS 1.1 neither completed nor produced a TLS alert: ${legacyEvidence}. The connection was dropped rather than refused, which many load balancers and rate limiters do without explanation.`,
            wouldHaveShown:
              'A completed handshake would have shown that TLS 1.0/1.1 are still accepted; a protocol_version alert would have shown they are refused.',
            recommendation:
              'Re-run the assessment, or confirm the minimum TLS version directly with whoever operates the load balancer or CDN.',
            evidence: {
              test: `TLS handshake with ${probedHost}:443 capped at maxVersion TLSv1.1`,
              observed: legacyEvidence,
              expected: 'Either a completed handshake or a protocol_version alert',
              verification: 'The error was classified against a list of TLS-layer refusal signatures; it matched none of them, so it was treated as a transport failure rather than a refusal.',
              limitation:
                'A dropped connection is indistinguishable from rate limiting. This component was excluded from the score rather than credited or penalised.',
            },
          }),
        );
      }
    }
  }

  const modernOnly = legacyState === 'refused';

  /* ---------------- Chain ---------------- */

  const chainOk = probe.reachable ? (probe.chainLength ?? 0) >= 2 : Boolean(ctRecord);
  if (probe.reachable && (probe.chainLength ?? 0) < 2) {
    findings.push(
      makeFinding(KEY, {
        title: 'Server sends the leaf certificate without its intermediates',
        severity: 'medium',
        confidence: 'high',
        asset: `${probedHost}:443`,
        observed: `The server presented a chain of ${probe.chainLength ?? 0} certificate(s). A publicly trusted certificate normally arrives with at least one intermediate above it.`,
        interpretation:
          'The intermediate certificate linking the leaf to a trusted root is not being sent. Desktop browsers usually recover by fetching it from the URL in the certificate\'s authority information access extension, which masks the problem.',
        risk:
          'Clients that do not perform that fetch — many mobile SDKs, most server-to-server HTTP libraries, several payment integrations — cannot build a path to a trusted root and refuse the connection. The failure is intermittent by client type, which makes it hard to diagnose from the server side.',
        recommendation:
          'Install the full chain file (leaf plus intermediates) supplied by the certificate authority, and verify with an external checker that the chain resolves without relying on client-side fetching.',
        evidence: {
          test: `Certificate chain walked from the leaf presented by ${probedHost} up through issuerCertificate links`,
          observed: `Chain depth ${probe.chainLength ?? 0}`,
          expected: 'Depth of 2 or more',
          verification: 'Counted from the chain the server sent, with fingerprint deduplication to avoid counting a self-referencing root twice.',
        },
        scoreImpact: 15,
      }),
    );
  }

  /* ---------------- HTTPS reachability ---------------- */

  if (!probe.reachable) {
    findings.push(
      makeFinding(KEY, {
        title: 'No HTTPS service answered on this domain',
        severity: 'medium',
        confidence: 'high',
        asset: `${domain}:443`,
        observed: `TLS connections to ${domain}:443 and www.${domain}:443 both failed: ${probe.failure ?? 'no response'}. Certificate details below were read from public transparency logs instead.`,
        interpretation:
          'Nothing is serving HTTPS at either name. The common readings are a domain used only for email or branding, a website served from a different host name entirely, or a firewall that blocks connections from unknown sources.',
        risk:
          'If a website is expected here, visitors reach nothing. If the domain is genuinely not web-facing, no exposure follows — but the certificates in the transparency log below were issued for something, and that something is worth accounting for.',
        recommendation:
          'If this domain should serve a website, enable HTTPS on it. If it exists only for email or branding, a redirect to the main site over HTTPS makes the intent explicit.',
        evidence: {
          test: `TLS connection attempted to ${domain}:443, then www.${domain}:443`,
          observed: probe.failure ?? 'no response within the timeout',
          expected: 'A completed TLS handshake',
          verification: 'Two host names were attempted before this conclusion was drawn.',
          limitation:
            'Klyro connects from a cloud network. A host that filters unfamiliar sources may be reachable from elsewhere and simply refused this connection.',
        },
        scoreImpact: 19,
      }),
    );
  }

  /* ---------------- Certificate intelligence ---------------- */

  details.push(
    { label: 'Issuer', value: issuer, mono: true, tone: certValid ? 'good' : 'bad' },
    { label: 'Subject', value: subject, mono: true },
    {
      label: 'Names covered',
      value: altNames.length
        ? `${altNames.length}: ${truncate(altNames.slice(0, 6).join(', '), 140)}`
        : 'Not read',
      mono: true,
    },
    {
      label: 'Valid from',
      value: probe.validFrom ?? ctRecord?.not_before ?? 'Unknown',
      mono: true,
    },
    {
      label: 'Expires',
      value: validTo ? `${validTo.toDateString()} (${daysToExpiry} days)` : 'Unknown',
      mono: true,
      tone: daysToExpiry === null ? 'neutral' : daysToExpiry > 30 ? 'good' : daysToExpiry > 0 ? 'warn' : 'bad',
    },
    {
      label: 'Public key',
      value: keyBits ? `${keyBits}-bit ${probe.keyCurve ? `EC (${probe.keyCurve})` : 'RSA'}` : 'Not read',
      mono: true,
      tone: keyStrong === null ? 'neutral' : keyStrong ? 'good' : 'warn',
    },
    { label: 'Serial number', value: probe.serialNumber ?? 'Not read', mono: true },
    { label: 'SHA-256 fingerprint', value: probe.fingerprint ? truncate(probe.fingerprint, 60) : 'Not read', mono: true },
    {
      label: 'Protocol negotiated',
      value: probe.protocol ?? 'Not reachable',
      mono: true,
      tone: modernOnly ? 'good' : probe.reachable ? 'warn' : 'bad',
    },
    { label: 'Cipher suite', value: probe.cipher ?? 'Not negotiated', mono: true },
    {
      label: 'Legacy TLS 1.0/1.1',
      value:
        legacyState === 'accepted'
          ? 'Accepted'
          : legacyState === 'refused'
            ? 'Refused'
            : `Could not be determined — ${legacyEvidence}`,
      tone: legacyState === 'accepted' ? 'bad' : legacyState === 'refused' ? 'good' : 'neutral',
    },
    { label: 'Chain depth', value: String(probe.chainLength ?? 0), mono: true, tone: chainOk ? 'good' : 'warn' },
    { label: 'Data source', value: source === 'live TLS handshake' ? `Live TLS handshake with ${probedHost}` : 'Certificate transparency logs — no live service answered' },
  );

  /* ---------------- Plain HTTP availability ---------------- */

  const httpRes = await safeFetch(`http://${domain}/`, { method: 'HEAD', redirect: 'manual' }, 6_000);
  if (httpRes && httpRes.status >= 200 && httpRes.status < 300) {
    findings.push(
      makeFinding(KEY, {
        title: 'Site returns content over plain HTTP without redirecting',
        severity: 'medium',
        confidence: 'high',
        asset: `http://${domain}/`,
        observed: `A HEAD request to http://${domain}/ with redirects disabled returned ${httpRes.status}, not a 3xx redirect to HTTPS.`,
        interpretation:
          'The server answers unencrypted requests with content rather than moving the client to the encrypted version. Some sites do this deliberately for a health-check path; doing it at the site root is normally an oversight.',
        risk:
          'Any request that starts on HTTP — a typed address, an old bookmark, a link in an email — is readable and modifiable by anyone between the visitor and the server. Content injected into that response executes with the site\'s origin.',
        recommendation:
          'Return a 301 from every http:// URL to its https:// equivalent, then enable HSTS so browsers stop making the plain request in the first place.',
        evidence: {
          test: `HEAD http://${domain}/ with redirect following disabled`,
          observed: `${httpRes.status} ${httpRes.statusText}`,
          expected: '301 or 308 with a Location header on https://',
          verification: 'Redirects were disabled so the first response is observed directly rather than inferred from where the client landed.',
        },
        scoreImpact: 0,
      }),
    );
  }

  /* ---------------- Score ---------------- */

  const expiryScore =
    daysToExpiry === null ? 10 : daysToExpiry > 30 ? 25 : daysToExpiry > 14 ? 16 : daysToExpiry > 0 ? 8 : 0;

  const { score, coverage, breakdown } = scoreFromComponents([
    {
      label: 'Certificate validates',
      value: certValid ? 20 : 0,
      max: 20,
      note: probe.reachable
        ? certValid
          ? 'The chain presented verified against the public root store.'
          : `Verification failed: ${probe.authorizationError ?? 'unknown error'}`
        : certValid
          ? 'No live service; the newest logged certificate is still in date.'
          : 'No live service, and the newest logged certificate has expired.',
    },
    {
      label: 'Time to expiry',
      value: expiryScore,
      max: 25,
      known: daysToExpiry !== null,
      note:
        daysToExpiry === null
          ? 'No expiry date could be read, so this component was dropped.'
          : `${daysToExpiry} days remaining.`,
    },
    {
      label: 'Protocol versions',
      value: !probe.reachable ? 6 : legacyState === 'accepted' ? 8 : 25,
      max: 25,
      // An unreachable host is a real observation; a dropped legacy probe is not.
      known: !probe.reachable || legacyState !== 'unknown',
      note: !probe.reachable
        ? 'No TLS service answered, which is itself the observation.'
        : legacyState === 'accepted'
          ? 'TLS 1.0 or 1.1 is still accepted.'
          : legacyState === 'refused'
            ? 'A TLS 1.1-capped handshake was refused with a TLS-layer alert.'
            : 'The legacy probe was dropped rather than refused, so this component was excluded rather than credited.',
    },
    {
      label: 'Chain completeness',
      value: chainOk ? 20 : 8,
      max: 20,
      note: chainOk
        ? `Chain depth ${probe.chainLength ?? 0} — intermediates are being sent.`
        : 'Only the leaf certificate was sent.',
    },
    {
      label: 'Key strength',
      value: keyStrong === false ? 2 : 10,
      max: 10,
      known: keyBits !== null,
      note:
        keyBits === null
          ? 'No key parameters were read (no live handshake), so this component was dropped.'
          : `${keyBits}-bit ${probe.keyCurve ? `EC (${probe.keyCurve})` : 'RSA'} key, against a floor of ${keyFloor} bits.`,
    },
  ] satisfies ScoreComponent[]);

  if (coverage < 0.999) {
    details.push({
      label: 'Assessed weight',
      value: `${Math.round(coverage * 100)}% — what could not be measured was excluded, not counted against the domain`,
      tone: 'neutral',
    });
  }

  const summary = !probe.reachable
    ? 'No live HTTPS service was reachable; certificate details were read from public transparency logs.'
    : certValid && modernOnly
      ? `A valid certificate from ${issuer} is in place, legacy TLS is refused, and it expires in ${daysToExpiry} days.`
      : certValid
        ? `A valid certificate from ${issuer} is in place, expiring in ${daysToExpiry} days.`
        : `The certificate presented by ${probedHost} does not validate.`;

  const facts = {
    issuer,
    subject,
    protocol: probe.protocol,
    cipher: probe.cipher,
    keyBits,
    keyCurve: probe.keyCurve ?? null,
    validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString() : null,
    altNames: altNames.slice(0, 50),
    altNameCount: altNames.length,
    serialNumber: probe.serialNumber ?? null,
    legacyTls: legacyState,
  };

  return {
    score,
    summary,
    findings,
    details,
    scoreBreakdown: breakdown,
    moduleCoverage: coverage,
    facts,
  };
}
