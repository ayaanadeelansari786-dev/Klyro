# Terms of Service

**Status: draft for internal and legal review. Not yet approved for reliance by users or counterparties. Bracketed items — `[Organisation]`, `[Jurisdiction]` — are placeholders and must be filled in and reviewed by a lawyer before this document is treated as binding.**

Last updated: [date]

## Preamble

Klyro is a passive security assessment tool provided by **[Organisation]** ("Klyro," "we," "us"). These Terms govern access to and use of the Klyro service, including the web application at `klyro-alpha-gold.vercel.app` (and, when live, `klyro.security`) and the API it exposes (together, the "Service").

By submitting a domain, creating an account, or otherwise using the Service, you agree to these Terms. If you are using the Service on behalf of an organisation, you represent that you have authority to bind that organisation, and "you" refers to that organisation.

## 1. Service Description

Klyro performs **passive reconnaissance only**. Every check reads a public data source or makes an ordinary, unauthenticated request to the domain you submit; nothing in the Service attempts to authenticate to a target system, exploit a vulnerability, brute-force credentials, or access a system Klyro has not been given permission to read from the open internet.

As of this version, the Service runs twelve checks against a submitted domain:

1. Email Security (SPF, DKIM, DMARC, read from DNS)
2. SSL/TLS Certificate (a live TLS handshake with the host)
3. DNS Configuration (DNSSEC, CAA, name-server delegation)
4. HTTP Security Headers (read from one response to the domain's home page)
5. Subdomain Exposure (host names discovered via public certificate transparency logs)
6. Exposed Paths (requests to a short, fixed, publicly documented list of paths)
7. Domain Registration (RDAP/WHOIS)
8. Cookie Security (attributes on cookies set before sign-in)
9. CORS Policy
10. Robots & Security.txt
11. Technology Profile (read from the home page response and DNS)
12. Network Exposure — **not a scan Klyro performs.** This check reads Shodan's free public InternetDB, a third-party record of what Shodan's own scanners have separately observed about the address your domain resolves to, reflecting Shodan's own prior observations and automated scanning rather than any reconnaissance Klyro performed itself. Klyro does not open a connection to any port listed by this check. Because the record is a third party's and carries no published date — it may be weeks or months old, and should not be relied on as a statement of what is open today — findings from it are never presented at the same confidence as a direct observation, and every such finding says so.

The exact set of requests each check makes, and what it does not do, is published at `/scanner` and `/methodology`, which this document incorporates by reference and which control if there is ever a conflict between the plain-language summary above and the technical description there.

**Klyro does not:** attempt to authenticate to any system; exploit or attempt to exploit a vulnerability; scan ports itself (the Network Exposure check reads a third party's prior record instead of connecting); access an internal or private network; or treat reaching an unauthenticated response as evidence that a system has no authentication requirement at all.

Findings describe what was observable at the moment a scan ran. They are a snapshot, not continuous monitoring, and nothing in the Service watches a domain over time or alerts on change unless a specific feature says otherwise.

## 2. User Responsibilities

You are responsible for having a legitimate basis to assess any domain you submit — ownership, operation, or the domain owner's consent. You will not use the Service to assess a domain you do not own or operate without that consent. You will not use the Service for any unlawful purpose. If you hold an account, you are responsible for keeping your credentials confidential and for activity that occurs under your account.

## 3. Acceptable Use

Use of the Service is also governed by the [Acceptable Use Policy](/legal/ACCEPTABLE_USE_POLICY.md), which prohibits, among other things: unauthorised scanning, competitive espionage or use of findings to plan a social-engineering or targeted attack, attempts to circumvent rate limits, bulk scraping of reports, and redistributing or altering findings in a way that misrepresents them. A violation of the Acceptable Use Policy is a violation of these Terms.

## 4. Intellectual Property

The Service, its methodology, and the software that produces a report are Klyro's property. A report the Service generates for you — the specific PDF or on-screen result describing a specific domain at a specific time — is yours to keep and use. You do not acquire rights in the underlying tool, checks, or scoring methodology by receiving a report. You may not reproduce, modify, or redistribute Klyro's findings at scale, or represent Klyro's output as your own work product, without written permission.

## 5. Data Handling

This section is a summary; the [Privacy Policy](/legal/PRIVACY_POLICY.md) is the authoritative statement of what is collected and retained, and controls if the two differ.

- **A scan run without an account is not stored on our servers.** The result streams to your browser; nothing about the domain, the findings, or your IP address is retained afterward beyond the ordinary web-server logs generated by the request.
- **A scan run while signed in is stored** against your account or organisation, and is retained until you or your organisation requests its deletion.
- Your email address is retained only if you hold an account, to support sign-in and access to your stored reports. We do not store credentials, system access details, or confidential information read from a scanned domain.
- Report PDFs are generated at the moment of download and are not stored on disk after they are sent to you.
- Industry benchmark comparisons are currently built from a reference dataset Klyro curates and populates itself, not from other users' live scans. An organisation-level setting exists to opt in to contributing its own scans to that pool in future; it is off by default and, as of this version, is not yet connected to any live scan.

## 6. Limitation of Liability

The Service is provided **"as is"** and **"as available,"** without warranty of any kind, express or implied, including without limitation warranties of accuracy, completeness, merchantability, or fitness for a particular purpose. A finding, a score, or the absence of a finding is not a guarantee about the security of any domain.

Klyro's methodology depends on public data sources it does not control — DNS resolvers, certificate transparency logs, domain registries, and Shodan's InternetDB among them — and on the target's own servers answering truthfully. We do not warrant the accuracy, completeness, or timeliness of any third-party source a check reads from, and a finding's own "cannot establish" language, where present, states the specific limits of what that finding supports.

To the maximum extent permitted by applicable law, Klyro will not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of profits, revenue, data, or business opportunity, arising from: your use of or reliance on a finding; a third-party data source's inaccuracy or unavailability; unauthorised access to your account resulting from your own failure to safeguard credentials; or your misrepresentation of a Klyro finding to a third party. Klyro's total liability for any claim arising from the Service will not exceed the fees you paid for the Service in the twelve months before the claim arose, or, for the free tier of the Service, [a fixed sum or service credit — to be set; there is currently no paid tier in the product].

Nothing in this section limits liability that cannot lawfully be limited, including for our own gross negligence, wilful misconduct, or fraud, under [Jurisdiction] law.

## 7. Indemnification

You agree to indemnify and hold Klyro harmless from claims, damages, and reasonable expenses (including legal fees) arising from your use of the Service in violation of these Terms, your lack of authority to assess a domain you submitted, or your misrepresentation of a Klyro finding to a third party.

## 8. Termination

We may suspend or terminate access to the Service for any user or organisation that violates these Terms or the Acceptable Use Policy, or as required by law, with notice where feasible and immediate action where the violation poses a risk to the Service or to a third party. On termination, access to your stored scans and reports may be suspended; where reasonably practicable and not prohibited by law, we will give you an opportunity to export data before deletion.

## 9. Changes to These Terms

We may update these Terms from time to time. Material changes will be reflected by an updated "Last updated" date above; continued use of the Service after a change is posted constitutes acceptance of the revised Terms.

## 10. Governing Law

These Terms are governed by the laws of **[Jurisdiction]**, without regard to its conflict-of-laws principles. Any dispute arising from these Terms or the Service will be subject to the exclusive jurisdiction of the courts of **[Jurisdiction]**.

## 11. Contact

Questions about these Terms: **[legal contact email — currently only `abuse@klyro.security` is configured in the product, for scanner-related abuse reports; a dedicated legal/privacy address should be set up before this document is published]**.
