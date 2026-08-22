# Privacy Policy

**Status: draft for internal and legal review. Not yet approved for reliance by users. Bracketed items are placeholders and must be confirmed before this document is published.** This policy is written to match what the Klyro service actually does as of this version; if the product changes, this document must change with it rather than the other way around.

Last updated: [date]

## 1. Introduction

This policy explains what data Klyro collects when you use the Service, why, how long it is kept, and what your options are. It is written to be checkable: where a claim below describes something the software does, that is because it is what the software does, not an aspiration. It should be read alongside the [Terms of Service](/legal/TERMS_OF_SERVICE.md) and the [Acceptable Use Policy](/legal/ACCEPTABLE_USE_POLICY.md), which govern the Service this policy describes.

## 2. Information We Collect

**Domain names you submit for assessment.** If you run a scan without signing in, the domain is used only to produce the result shown to you; it is not written to our database. If you run a scan while signed in, the domain and the full result (scores, findings, and supporting detail) are stored against your account or your organisation, so the assessment can be revisited and compared later.

**Your IP address.** Read from the request to enforce per-address rate limits (a rolling one-hour window) and to apply the same reserved-address and abuse protections the scan engine itself uses. It is held only for the life of that rate-limiting window and is not written to a separate log or retained beyond it.

**Account credentials, if you create an account.** Email address and password are handled by our authentication provider (Supabase Auth) in a data store our own application code does not have direct read access to; we do not see or store your password in any form. A separate, minimal profile record — a display name, and nothing else — is created so other members of your organisation can see who they are working with.

**Organisation data, if you create or join one.** An organisation's name, a join code (stored as a salted hash, never in plain text, and revocable), and a benchmark-contribution preference that defaults to off.

**Report contents.** Findings are stored only for authenticated users. If you run a scan without signing in, the result exists only for the browser session that produced it — it is not written to our database and will not appear in any later report, comparison, or benchmark. A stored (signed-in) assessment includes the findings the Service generated — what was observed about the target domain — and, for signed-in reports, any optional context you supplied about your own organisation for a buyer-side comparison. We do not ask for and do not knowingly store passwords, credentials, or confidential information belonging to a third party as part of a scan; the scan itself only reads what the target domain already publishes to any visitor.

**Browser data.** Klyro does not currently use any third-party analytics or tracking service. Standard web-server request logs (as any host retains) are the only browsing-related data collected. A visitor's theme preference (light or dark) is stored in their own browser's local storage and is never sent to us. If an analytics tool is added in future, this policy will be updated to name it and describe what it collects before it is deployed.

## 3. How We Use Your Data

- To run the checks you request and produce a report.
- To let you and your organisation revisit and compare stored assessments.
- To enforce rate limits and protect the Service from abuse.
- To improve the accuracy of individual checks (for example, correcting a check that produced a wrong or misleading finding).

We do not sell your data. We do not share stored assessments with anyone outside your organisation, and row-level access controls in our database enforce that boundary at the data layer, not only in application code.

**Populating industry benchmarks from your own scans is not one of the uses above, on purpose.** That capability is still being built: an organisation-level opt-in setting exists for it and defaults to off, but as of this version no live scan is connected to it, so nothing you run today feeds a benchmark pool. See Section 4 for what the benchmark pools are actually built from in the meantime.

### Where a scan's own facts leave our infrastructure

Two features send a closed, factual subset of a scan's own findings to a third-party language model provider (Groq), when that integration is configured:

- A short contextual note attached to selected findings.
- A one-page plain-language summary of the full report.

Both are built from a fixed set of facts the scan itself already produced — never credentials, never personal data, never anything about you as the person running the scan — and the model is instructed, and the calling code enforces, that it may not introduce a fact outside that set. If this integration is not configured, both features are silently absent and no data is sent anywhere.

## 4. Data Retention

- **Anonymous scans (no account signed in): not retained.** The result is produced and returned to your browser; nothing about the scan is written to our database.
- **Signed-in scans: retained until deletion is requested**, by you or by your organisation, as described in Section 7.
- **IP addresses:** held only for the current rate-limiting window (approximately one hour), then gone. We do not keep a longer-term log of which address ran which scan.
- **Account and organisation data:** retained while the account or organisation is active; deleted on request, subject to Section 7.
- **Report PDFs:** generated at download time and not stored on disk afterward.
- **Industry benchmark data:** the comparison pools published on the Service are currently built from a reference dataset we curate and populate ourselves — real, public domains we have chosen and scanned — not from other customers' live activity. An organisation can opt in to having its own scans considered for inclusion in a future version of this pool; that setting is off by default and, as of this version, does not yet do anything, because no live code path reads it. If and when it is activated, only aggregate statistics (averages, percentiles, sample counts) are ever exposed publicly — never a list of which domains are in a pool or their individual scores.

## 5. Third-Party Data Sources

To produce a finding, Klyro reads from public sources it does not operate: DNS resolvers operated by Google and Cloudflare; public certificate transparency logs (crt.sh and CertSpotter); domain registries, reached through RDAP (via rdap.org, rdap.net, and, where available, the registry's own endpoint); a direct TLS handshake and ordinary HTTP requests to the domain you submit; Google's public News RSS feed, for recent public reporting about an organisation; Team Cymru's public BGP-to-ASN lookup service; and Shodan's free InternetDB, for the Network Exposure check described in the [Terms of Service](/legal/TERMS_OF_SERVICE.md).

We do not control these sources, are not responsible for their accuracy or their own privacy practices, and a finding that depends on one says so in the finding itself. `/methodology` lists, for every check, which of these sources it reads and whether an absence is confirmed against a second source before being reported.

## 6. Data Security

Traffic to the Service is encrypted in transit (HTTPS). Stored data is held in Supabase, encrypted at rest, behind row-level security policies scoped to the account or organisation that owns a given record — a policy enforced by the database itself, not only by application code. Join codes are never stored in a form that could be read back out; only a salted hash is kept. We do not run penetration tests against customer data, and access to production data is limited to what operating the Service requires.

## 7. Your Rights

You can ask what data we hold about your account or your organisation's stored scans, and you can ask us to delete it. As of this version, both are handled by request rather than by a self-service control in the product — contact us using the address in Section 9 and we will act on a verified request. If you are subject to GDPR, the UAE's PDPL, or another privacy law that grants specific rights (access, correction, portability, objection), the same contact point is where to exercise them; we will respond within the timeframe that law requires.

Because a benchmark-contribution setting exists at the organisation level and defaults to off, there is no opt-out to exercise for an organisation that has not turned it on. An organisation that later opts in can turn it back off through the same setting.

## 8. Changes to This Policy

We may update this policy as the Service changes. The "Last updated" date above will change with it; continued use of the Service after an update constitutes acceptance of the revised policy. A change that meaningfully expands what we collect or how we use it will be called out plainly, not folded into a routine update.

## 9. Contact

Privacy inquiries: **[dedicated privacy contact — currently only `abuse@klyro.security` is configured in the product; set up a dedicated address before publishing]**.
