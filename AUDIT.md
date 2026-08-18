# Klyro — Comprehensive Project Audit

*Generated: 2026-08-17 · Tool version 1.0.0*

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture & Stack](#2-architecture--stack)
3. [Check Modules](#3-check-modules)
4. [Scoring Engine](#4-scoring-engine)
5. [Database Schema](#5-database-schema)
6. [PDF Report Structure](#6-pdf-report-structure)
7. [Frontend Components](#7-frontend-components)
8. [API Routes](#8-api-routes)
9. [Test Coverage](#9-test-coverage)
10. [Documentation](#10-documentation)
11. [Known Limitations](#11-known-limitations)
12. [Security & Compliance](#12-security--compliance)
13. [Configuration & Secrets](#13-configuration--secrets)
14. [Performance & Scalability](#14-performance--scalability)
15. [Deployment & Operations](#15-deployment--operations)
16. [Version & Change Log](#16-version--change-log)
17. [Validation & Cross-Checks](#17-validation--cross-checks)
18. [Next Steps & Roadmap](#18-next-steps--roadmap)

---

## 1. Project Overview

Klyro is a web-based vendor security assessment platform. It assesses publicly observable security posture across eleven categories, produces a 0-100 composite score, and renders the result as a branded PDF report. The product's primary market is vendor due diligence in the GCC / Middle East region.

**Core design constraints:**

- Every claim is grounded in a directly observable signal. Nothing is inferred from timing, absence, or behaviour that the target cannot reproduce.
- Modules that cannot complete drop out; the remaining weights renormalise. An upstream source that is temporarily down never drags down a domain's score.
- Cookie values are never captured. A session token belonging to whoever the target last served is not Klyro's to record.
- "Reaching a page" is never presented as "bypassing authentication." The distinction between reachable and unauthenticated is load-bearing, especially for tools like Jenkins and Grafana that answer 200 on their sign-in pages.

**Supported industries:** Banking & Finance, Insurance, Real Estate, Retail & E-commerce, Healthcare, Education, Government, Telecom, Oil & Gas, Logistics & Transport, Hospitality & Tourism, Technology, Construction, Manufacturing, Media & Entertainment, Legal Services, Automotive, Food & Beverage.

**Supported regions:** UAE, Saudi Arabia, GCC, Middle East, Global.

---

## 2. Architecture & Stack

### Runtime

| Layer | Technology | Version |
|---|---|---|
| Framework | Next.js (App Router) | ^14.2.0 |
| Language | TypeScript | ^5.5.0 |
| React | react / react-dom | ^18.3.1 |
| Styling | Tailwind CSS | ^3.4.4 |
| PDF generation | @react-pdf/renderer | ^4.0.0 |
| Database | Supabase (PostgreSQL + GoTrue auth) | @supabase/supabase-js ^2.45.0 |
| SSR auth | @supabase/ssr | ^0.12.4 |
| Testing | Vitest | ^2.1.9 |

### Deployment target

Next.js running on Vercel (Node.js runtime, not Edge). All server routes set `export const runtime = 'nodejs'` explicitly.

### Directory structure

```
src/
  app/
    api/
      scan/           POST — streams NDJSON assessment events
      report/         POST — renders PDF from scan result
      checks/         Individual per-module debug endpoints
      benchmark/      GET — pool statistics
      compare/        GET — two-scan diff
      org/            Organisation CRUD and join-code routes
      rankings/       GET — leaderboard
      intel/          news/ and ownership/ enrichment panels
      admin/seed/     Protected seeding route
    results/          Dashboard page (client component)
    scanner/          Disclosure page
    compare/          Side-by-side comparison view
    org/[orgId]/      Organisation portfolio
    rankings/         Leaderboard view
    login/ signup/    Auth pages
  components/         Dashboard UI components
  lib/
    checks/           The 11 check modules + orchestration
    intel/            Inventory, news, relationship, ownership
    auth/             Context resolution, join-code, organisations
    dataset/          Supabase read/write helpers
    supabase/         Client/server/service clients and config
    scoring.ts        Composite calculation and finding sort
    constants.ts      Weights, labels, colours
    types.ts          All shared TypeScript interfaces
    reportPayload.ts  Payload sanitiser (untrusted → safe shapes)
    rateLimit.ts      In-memory rate limiter and concurrency gate
    benchmark.ts      Pool queries and percentile logic
  pdf/
    ReportTemplate.tsx  @react-pdf/renderer document tree
tests/                Unit + DB integration tests
supabase/migrations/  8 SQL migrations
```

### Data flow

```
Browser POST /api/scan
  → rate limit check
  → target screening (name + DNS)
  → concurrent module run (4 at once, NDJSON stream per module)
  → inventory build (from resolved names)
  → composite score + benchmark lookup
  → persist (if user/org owner; anonymous scans not stored)
  → context scan (optional, buyer's own domain)
  → stream closes

Browser POST /api/report
  → payload sanitiser (untrusted browser state → typed shapes)
  → @react-pdf/renderer → PDF buffer → response
```

---

## 3. Check Modules

Weights sum to 1.0. Execution order (most material first):

| # | Key | Label | Weight | Timeout |
|---|---|---|---|---|
| 1 | `emailSecurity` | Email Security | 0.13 | 14 s |
| 2 | `ssl` | SSL/TLS Certificate | 0.13 | 20 s |
| 3 | `dns` | DNS Configuration | 0.10 | 14 s |
| 4 | `headers` | HTTP Security Headers | 0.12 | 14 s |
| 5 | `subdomains` | Subdomain Exposure | 0.12 | 32 s |
| 6 | `exposedPaths` | Exposed Paths | 0.10 | 22 s |
| 7 | `whois` | Domain Registration | 0.06 | 14 s |
| 8 | `cookies` | Cookie Security | 0.05 | 14 s |
| 9 | `cors` | CORS Policy | 0.05 | 14 s |
| 10 | `robotsSecurity` | Robots & Security.txt | 0.04 | 14 s |
| 11 | `technologies` | Technology Profile | 0.10 | 16 s |

**Global orchestration:** 4 modules run concurrently. The orchestrator hard-caps the full scan at `maxDuration = 60` seconds (Vercel limit).

---

### 3.1 DNS Configuration (`dns`)

**Sources:** Google DoH (`dns.google`) and Cloudflare DoH (`cloudflare-dns.com`) — every absence is confirmed at both resolvers before being reported.

**Records queried:** A, AAAA, NS, MX, TXT, DS, DNSKEY, SOA, CNAME, CAA.

**Scoring components:**

| Component | Max | Notes |
|---|---|---|
| DNSSEC | 20 | DS + DNSKEY present and AD bit set |
| CAA records | 20 | One or more valid CAA `issue`/`issuewild` tags |
| Nameserver resilience | 20 | ≥2 operators; 16/20 for a single operator |
| TTL consistency | 20 | Warning at extreme spread; info at minor spread |
| Lame/dangling CNAMEs | 20 | Deducted per dangling target |

**Nameserver operator grouping:** `dnsOperatorOf()` — imported from `tiering.ts` — checks `DNS_PROVIDER_FAMILIES` first (14 named providers, e.g. Route 53 pattern `awsdns-\d+\.[a-z.]+` → "Amazon Route 53"), then falls back to `registrableDomain()`. This ensures a Route 53 zone using `awsdns-*.com/.net/.org/.co.uk` is counted as one operator, not four.

**IPv6:** Queries apex and `www.{domain}` for AAAA separately. Absence is reported as an info-level finding. IPv6 is not scored.

---

### 3.2 Subdomain Exposure (`subdomains`)

**Discovery source:** Certificate Transparency logs via `crt.sh`.

**Liveness budget:** up to 140 hosts resolved (A + AAAA); unresolved names are excluded from findings and the score.

**HTTP probe budget:** up to 30 hosts probed with GET (not HEAD). Priority ordering:

| Priority | Name classes |
|---|---|
| 0 (first) | admin, cicd, data |
| 1 | nonprod, remote |
| 2 | unclassified |
| 3 (last) | public (www, mail, cdn, …) |

**Per-host fingerprinting** (via `probe.ts`):

- Body capped at 8 KB (`SUBDOMAIN_BODY_BYTES`).
- 5-second deadline (`PROBE_TIMEOUT_MS`), 8 concurrent probes (`PROBE_CONCURRENCY`).
- Cookie names extracted (values never captured), capped at 12.
- Platform identification via 38 `PLATFORM_RULES` (25 with `sensitive: true`).
- `PlatformStrength`: `'strong'` = product-specific cookie / header / application-shell marker; `'weak'` = brand name in title or plain markup. Only `strong` identifications can raise a host's tier.
- `looksLikeSignIn()` checks 401/403, `WWW-Authenticate`, redirect path, title keywords, and `<input type=password>` in markup.
- `unreachableReason: 'timed-out' | 'no-response' | 'not-probed' | null` — hosts beyond the 30-probe budget are marked `not-probed` and never presented as facts about the target.

**Risk tiering** (via `tiering.ts`):

| Tier | Condition |
|---|---|
| critical | Strong platform ID + 200 + no login prompt detected |
| high | Strong platform ID + answered any status, OR named for admin/cicd/data + answered |
| medium | Nonprod-named + answered; OR admin-named + 4xx; OR beyond HTTP budget + sensitive name |
| low | Public-facing host; any answered host not fitting above |
| info | Unclassified, unreachable, or beyond budget without a sensitive name |

**Scoring:**

| Tier | Base penalty | Scale factor (per extra host) |
|---|---|---|
| critical | 30 pts | +15% per host beyond first (max 6 extra) |
| high | 12 pts | +15% |
| medium | 5 pts | +15% |
| low | 1 pt | +15% |
| info | 0 pts | — |

Total penalty capped at 85 points (no estate can score < 15 on subdomains alone).

---

### 3.3 SSL/TLS Certificate (`ssl`)

**Sources:** Live TLS handshake + certificate transparency logs (`crt.sh`).

**Scoring components:** Certificate validity (expiry, days remaining), cipher suite, protocol version, HSTS presence (checked via headers module integration), CT log status, issuer / CA trust, SAN coverage.

---

### 3.4 HTTP Security Headers (`headers`)

**Source:** Single GET to domain root.

**Evaluated headers:** `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`. Each is scored individually; a missing header is a finding, not silence.

---

### 3.5 Email Security (`emailSecurity`)

**Sources:** MX, SPF (TXT), DMARC (TXT at `_dmarc.`), DKIM (sampled common selectors), MTA-STS, DANE (TLSA).

**Key logic:** SPF strictness (`-all` vs `~all` vs `+all`); DMARC policy strength (`reject` > `quarantine` > `none`); DMARC `pct` value; subdomain policy. DKIM is sampled — absence is reported as not-provable, not as a finding.

---

### 3.6 Domain Registration (`whois`)

**Sources:** RDAP bootstrap (rdap.org), RDAP mirror (rdap.net), and registry-direct endpoints for known TLDs:

| TLD | Registry | Endpoint |
|---|---|---|
| .com / .net | Verisign | rdap.verisign.com |
| .org | Public Interest Registry | rdap.publicinterestregistry.org |
| .info / .io | Identity Digital | rdap.identitydigital.services |

**EPP status parsing** (`parseLockStatus()`): handles both space-separated form (`client transfer prohibited`) and camelCase form (`clientTransferProhibited`). Exported for testing.

**Lock scoring:**

| Component | Max |
|---|---|
| Transfer lock | 25 |
| Update lock | 15 |
| Deletion lock | 15 |
| Registry status clear of holds | 15 |
| Expiry (days remaining) | 30 |
| Privacy / registrant redaction | 20 |
| DNSSEC delegation signed | 10 |
| Domain age | 10 |
| *Total normalised to 100* | |

**Hold-state ceiling:** If `clientHold`, `serverHold`, `redemptionPeriod`, or `pendingDelete` is present, the category score is capped at 30 regardless of lock scores. Rationale: a domain on hold could stop resolving at any moment; averaging the hold against four green components would report it as well-managed.

**Enterprise registrar bonus:** Post-normalisation `+10`, capped at 100. Recognised registrars include CSC Corporate Domains, MarkMonitor, SafeBrands, Tucows, Securecore, and similar. An unlisted registrar costs nothing; this is strictly a bonus, never a penalty in disguise. `example.com` (IANA) scores 100 without the bonus (tested explicitly).

**Cross-verification confidence:**
- `'high'` — corroborated by a registry-direct endpoint without conflict.
- `'medium'` — second source was unreachable, or two bootstrap mirrors agreed (not independent corroboration).
- Conflict finding (low severity) raised when status or expiry disagrees between sources.

---

### 3.7 Exposed Paths (`exposedPaths`)

**Source:** Targeted GET requests to known administrative and developer path patterns.

**Categories probed:** Debug endpoints, admin consoles, API documentation, backup files, development artefacts, `.git` metadata, `.env` files, package manifests. Findings are raised only on definitive positive responses (200 with matching content) — a 404 is never a finding.

---

### 3.8 Cookie Security (`cookies`)

**Source:** GET to domain root; `Set-Cookie` response headers.

**Attributes checked per cookie:** `Secure`, `HttpOnly`, `SameSite` value, `__Host-` / `__Secure-` prefix. Cookie names are recorded; values are never captured. Only pre-auth cookies (issued before any sign-in flow) are evaluated — Klyro makes one request and cannot traverse a login flow.

---

### 3.9 CORS Policy (`cors`)

**Source:** OPTIONS and GET to domain root with a test `Origin` header.

**Logic:** Reflects-any-origin (`*` or echoing the request origin), `Access-Control-Allow-Credentials: true` combined with wildcard origin (the dangerous combination), and overly broad allowed-methods lists.

---

### 3.10 Robots & Security.txt (`robotsSecurity`)

**Sources:** `/robots.txt` and `/.well-known/security.txt`.

**Evaluated:** `security.txt` presence, required fields (`Contact`, `Expires`), GPG signature, `Encryption` field; `robots.txt` presence and whether it enumerates internal paths (which provides a map of the estate rather than protecting it).

---

### 3.11 Technology Profile (`technologies`)

**Source:** Single GET to domain root (50 KB body cap), plus MX, TXT, and CNAME records already resolved by other modules.

**Detection surfaces:**

- **Response headers** (`HEADER_RULES`): CDN presence (Cloudflare, CloudFront, Akamai, Vercel, Netlify, Fastly, Azure Front Door), web server (`Server` header), framework (`X-Powered-By`, `X-Generator`).
- **Script tags** (`SCRIPT_RULES`): jQuery, React, Vue, Angular, Next.js, Svelte, Bootstrap, Tailwind, Google Analytics/GTM, Hotjar, Microsoft Clarity, HubSpot, Meta Pixel, Stripe, PayPal, Intercom, Drift, Zendesk, reCAPTCHA, hCaptcha, Cloudflare Turnstile, Sentry, Datadog RUM, and more.
- **Cookie names**: Akamai Bot Manager (`bm_sz`, `ak_bmsc`, `_abck`).
- **MX records** (`MAIL_PROVIDERS`): Google Workspace, Microsoft 365, Proofpoint, Mimecast, etc.
- **TXT records** (`VERIFICATION_RECORDS`): Google Search Console, Meta Business, Atlassian, DocuSign, Zoom, Stripe, Adobe, Slack, Miro, Dropbox, Apple Business, OneTrust, MongoDB Atlas.
- **Hosting** (`HOSTING_PROVIDERS`): AWS, Azure, GCP, Cloudflare, Vercel, Netlify, Heroku, Fastly, Akamai.
- **End-of-life table** (`END_OF_LIFE`): jQuery < 3, AngularJS 1.x, Vue 2, Bootstrap < 4.

**Scoring components:**

| Component | Max | Assessed when |
|---|---|---|
| Library versions in support | 30 | At least one version readable from asset paths |
| External code supply chain size | 20 | Body was readable |
| CDN / edge layer | 20 | Always |
| Bot and abuse protection | 15 | Body was readable |
| Version disclosure | 15 | Always |

Unreadable components are dropped and the remainder rescaled. An empty profile (nothing detected) is reported honestly rather than scored as a pass.

---

## 4. Scoring Engine

**File:** `src/lib/scoring.ts`

### Composite calculation

```
compositeScore = Σ (score_i × weight_i) / Σ weight_i
```

Only modules with `status === 'assessed'` contribute. `coverage` = `Σ weight_i` of assessed modules, reported in the dashboard and stored alongside the score. A domain that does not resolve lands around 0.27 coverage, which is below the `MIN_CONTEXT_COVERAGE = 0.6` threshold for buyer comparisons.

### Risk levels

| Range | Label |
|---|---|
| ≥ 80 | Low Risk |
| 60–79 | Moderate Risk |
| < 60 | High Risk |

### Ratings (used in executive summary)

| Range | Label |
|---|---|
| ≥ 90 | Strong |
| 80–89 | Good |
| 60–79 | Fair |
| 40–59 | Weak |
| < 40 | Critical |

### Finding priority

`prioritise()` in `scoring.ts` ranks findings 1-based by a weighted combination of severity, confidence, and exposure. Used for the executive highlights on the first PDF page.

### Benchmark

`MIN_BENCHMARK_SAMPLES = 30` distinct domains (not scans) before a pool is considered meaningful. Scope fallback: `industry-region` → `industry` → `global` → `none`. Computed at scan time and stored with the assessment; a reprinted report shows the benchmark as it was, not a recomputed one.

---

## 5. Database Schema

**8 migrations**, applied in order.

### Core tables (migration 0001)

```sql
vendors (
  id uuid PK,
  domain text UNIQUE,
  display_name, legal_name, industry, region, hq_country,
  ownership_type CHECK IN ('independent','subsidiary','division',
                           'joint_venture','acquired','unknown'),
  parent_name, parent_domain, ultimate_parent_name,
  ownership_source, ownership_source_url,
  ownership_confidence CHECK IN ('confirmed','reported','inferred','unknown'),
  ownership_note, lei,
  is_parent_entity boolean,
  created_at, updated_at
)

scan_results (
  id uuid PK,
  domain, industry, region,
  composite_score integer CHECK (0..100),
  category_scores jsonb,
  findings jsonb,
  scan_metadata jsonb,
  vendor_id uuid FK→vendors,
  risk_level, coverage numeric, tool_version, run_label,
  scanned_at timestamptz
)

ownership_assessments (
  id uuid PK,
  vendor_id uuid FK→vendors CASCADE,
  vendor_domain, parent_domain, parent_name,
  shares_nameservers, shares_mail_provider,
  shares_tls_issuer, shares_registrar boolean,
  linkage_signals integer,
  linkage_verdict CHECK IN ('integrated','partially_integrated','independent','unknown'),
  vendor_score, parent_score, score_delta integer,
  narrative text, evidence jsonb,
  assessed_at timestamptz
)
```

**Views:** `latest_scans` (DISTINCT ON domain), `score_trend` (LAG window), `vendor_leaderboard` (ranked with ownership and movement), `industry_summary`.

All three tables have `security_invoker = on` on the views. Public reads; all writes go through the service role.

### Auth / account tables (migrations 0003–0008)

```sql
profiles (
  id uuid PK FK→auth.users CASCADE,
  display_name text,
  created_at, updated_at
)
-- Populated by trigger on_auth_user_created (SECURITY DEFINER).

organisations (
  id uuid PK,
  name text CHECK (1..120 chars),
  slug text UNIQUE (expression index, lower()),
  benchmark_opt_in boolean DEFAULT false,
  created_by uuid FK→auth.users,
  created_at, updated_at
)

organisation_members (
  org_id uuid FK→organisations CASCADE,
  user_id uuid FK→auth.users CASCADE,
  role org_role ENUM('viewer','analyst','admin','owner'),
  invited_by uuid,
  joined_at timestamptz,
  PRIMARY KEY (org_id, user_id)
)
-- Trigger on_organisation_created creates owner row (SECURITY DEFINER).
-- Constraint trigger on_member_change_assert_owner prevents last-owner removal.

join_codes (
  id uuid PK,
  org_id uuid FK→organisations CASCADE,
  role org_role,
  max_uses integer,
  use_count integer DEFAULT 0,
  expires_at timestamptz,
  revoked boolean DEFAULT false,
  token_hash text UNIQUE,   -- HMAC-SHA256 under KLYRO_JOIN_CODE_PEPPER
  created_by uuid FK→auth.users,
  created_at timestamptz
)

assessments (
  id uuid PK,
  user_id uuid FK→auth.users,
  org_id uuid FK→organisations,
  domain, industry, region,
  composite_score, category_scores jsonb, findings jsonb,
  categories jsonb,           -- full CategoryResult[], including payload
  coverage numeric, tool_version, risk_level,
  benchmark_scope, benchmark_data jsonb,
  scanned_at timestamptz
)

benchmark_samples (
  id uuid PK,
  org_id uuid FK→organisations,
  domain, industry, region,
  composite_score, category_scores jsonb,
  coverage numeric, tool_version,
  sampled_at timestamptz
)

organisation_vendors (
  org_id uuid FK→organisations CASCADE,
  domain text,
  display_name text,
  PRIMARY KEY (org_id, domain)
)
```

### Row-level security summary

| Table | Anon reads | Authenticated writes |
|---|---|---|
| `vendors`, `scan_results`, `ownership_assessments` | ✅ public | ❌ revoked (service role only) |
| `profiles` | ❌ (self + co-members via `app.shares_org_with`) | ✅ own row |
| `organisations` | ❌ (members only) | ✅ admin/owner |
| `organisation_members` | ❌ (members only) | ✅ admin adds members |
| `join_codes` | ❌ (members only) | ✅ admin creates |
| `assessments` | ❌ (owner or org member) | ✅ server via service role |
| `benchmark_samples` | ❌ (server only) | ✅ server via service role |

**Membership helper functions** (`app.is_org_member`, `app.has_org_role`, `app.org_role_of`, `app.shares_org_with`) — all `SECURITY DEFINER` with empty `search_path`, to break the recursive-policy problem. Revoked from `anon`.

---

## 6. PDF Report Structure

**Renderer:** `@react-pdf/renderer` v4. File: `src/pdf/ReportTemplate.tsx`.

**Palette:** White paper, navy (`#0A0E1A`) structure, cyan (`#00A6C0`) accents. Print-oriented; no screen-only colours.

**Hyphenation override:** URLs and host names are never mid-word hyphenated. Long paths break after `/`.

**Pages:**

| Page | Key | Condition |
|---|---|---|
| 1 | Executive Summary | Always |
| — | Buyer Comparison (appended to p.1) | When `relationship` present |
| 2 | Score Breakdown | Always |
| — | Subdomain Exposure | When `subdomains.length > 0` |
| — | Technology Profile | When `technologyProfile` present |
| 3 | Industry Benchmark | Always (shows "insufficient data" if pool < 30) |
| 4 | Detailed Findings | Always |
| — | Additional Finding pages | When findings overflow one page |
| — | Ownership panel | When ownership data present |

**Section IDs** are derived at render time (not hard-coded integers), so conditional pages do not create numbering gaps.

**Key rendering helpers:**
- `registrationLockSentence()` — reads lock flags from `scoreBreakdown` to name specifically which locks are set.
- `plainExplanation()` — per-category prose explanation that calls `registrationLockSentence()` for `whois`.
- `tierCount()` — counts hosts per `RiskTier` in the subdomain exposure page.

---

## 7. Frontend Components

| File | Role |
|---|---|
| `ResultsView.tsx` | Main dashboard; orchestrates the NDJSON scan stream, wires all panels |
| `ScanForm.tsx` | Domain / industry / region inputs, optional buyer context domain |
| `ScanProgress.tsx` | Module-by-module progress bar during the scan |
| `FindingsTable.tsx` | Sortable, filterable findings list |
| `FindingDetail.tsx` | Expandable finding card (observed / interpretation / risk / recommendation / evidence) |
| `CheckMatrix.tsx` | Per-category score grid |
| `ScoreMeter.tsx` | Composite score donut |
| `RadarChart.tsx` | SVG radar — custom-built; recharts was removed in an earlier session |
| `SubdomainTiers.tsx` | Collapsible tier sections (critical+high open by default); status badges; platform pills (dashed border + `?` for unconfirmed); shows redirectTarget, serverHeader, poweredBy, authType, cookieNames |
| `TechnologyStack.tsx` | Pill groups by category with coloured dots; external supplier count; "What this cannot see" section |
| `BenchmarkChart.tsx` | Benchmark pool bar |
| `RelationshipPanel.tsx` | Buyer comparison concerns and gaps |
| `InventoryPanel.tsx` | Asset inventory hosts and networks |
| `InventoryGraph.tsx` | Network graph visualisation |
| `NewsIntel.tsx` | Threat news intelligence panel |
| `OwnershipPanel.tsx` | Parent linkage signals |
| `CompareView.tsx` | Two-scan diff view |
| `RankingsView.tsx` | Leaderboard |
| `OrgManager.tsx` | Organisation settings, member list, join-code management |
| `JoinCodePanel.tsx` | Join-code creation and revocation |
| `AuthPanel.tsx` | Sign-in / sign-up forms |
| `Chrome.tsx` | App shell (nav, theme, auth state) |
| `ReportButton.tsx` | Triggers PDF generation via POST /api/report |

---

## 8. API Routes

| Method | Path | Auth required | Purpose |
|---|---|---|---|
| POST | `/api/scan` | Optional | Stream NDJSON assessment for a domain |
| POST | `/api/report` | None | Render PDF from sanitised scan result |
| GET | `/api/benchmark` | None | Pool statistics for industry/region |
| GET | `/api/compare` | None | Diff two scan result IDs |
| GET | `/api/rankings` | None | Leaderboard from `vendor_leaderboard` view |
| GET | `/api/checks/dns` | None | Debug: run DNS module only |
| GET | `/api/checks/ssl` | None | Debug: run SSL module only |
| GET | `/api/checks/headers` | None | Debug: run headers module only |
| GET | `/api/checks/email-security` | None | Debug: run email security module only |
| GET | `/api/checks/exposed-paths` | None | Debug: run exposed-paths module only |
| GET | `/api/checks/cookies` | None | Debug: run cookies module only |
| GET | `/api/checks/cors` | None | Debug: run CORS module only |
| GET | `/api/checks/robots-sitemap` | None | Debug: run robots module only |
| GET | `/api/checks/subdomains` | None | Debug: run subdomains module only |
| GET | `/api/checks/whois` | None | Debug: run WHOIS module only |
| GET | `/api/intel/news` | None | Threat news for a domain |
| GET | `/api/intel/ownership` | None | Parent linkage assessment |
| POST | `/api/org` | Auth | Create organisation |
| GET | `/api/org/[orgId]` | Auth (member) | Organisation details |
| POST | `/api/org/[orgId]/code` | Auth (admin) | Create join code |
| POST | `/api/org/join` | Auth | Join via code |
| POST | `/api/admin/seed` | `KLYRO_ADMIN_TOKEN` | Seed vendor/scan data |

---

## 9. Test Coverage

### Unit tests — 407 tests, 19 files

| File | Tests | What it covers |
|---|---|---|
| `email-security.test.ts` | 24 | SPF/DMARC/DKIM/MTA-STS/DANE parsing and scoring |
| `fingerprinting.test.ts` | 66 | Cookie capture (names only), body reading, markup extraction, platform ID (incl. GitLab regression), sign-in detection, name classification, risk tiering (all tier paths + budget/timeout distinction), tier grouping, asset/version extraction |
| `target-guard.test.ts` | 51 | Domain screening, private IP rejection, malformed inputs |
| `auth-context.test.ts` | 10 | Owner resolution, org membership, anonymous fallback |
| `hardening.test.ts` | 17 | Security header assessment |
| `client-boundary.test.ts` | 9 | No server code leaks into the client bundle |
| `benchmark.test.ts` | 32 | Pool statistics, percentile, scope fallback |
| `cookies.test.ts` | 11 | Secure/HttpOnly/SameSite attribute coverage |
| `scanner-disclosure.test.ts` | 11 | User-Agent format, disclosure page URL |
| `join-code.test.ts` | 10 | HMAC generation and verification |
| `voice.test.ts` | 30 | Report copy tone (third-person, no overstatement) |
| `dns-resolver.test.ts` | 7 | DoH query handling, absence confirmation |
| `news-classification.test.ts` | 5 | Threat-news category assignment |
| `ssrf-live.test.ts` | 5 | SSRF guard — internal addresses refused |
| `dns-module.test.ts` | 26 | Full DNS module (Route 53 multi-TLD grouping, self-hosted vs managed, IPv6 absence, healthy zone scores 100) |
| `registration.test.ts` | 33 | EPP parsing (both formats), registrable domain, lock scoring, hold cap, registrar recognition, cross-verification confidence |
| `compare.test.ts` | — | Scan diff logic |
| `scoring.test.ts` | — | Composite and coverage |
| `http-checks.test.ts` | — | CORS and headers |

### Database integration tests — 106 tests, 6 files

All hit a local Supabase instance with real RLS policies enforced.

| File | Tests | What it covers |
|---|---|---|
| `verification-queries.test.ts` | 22 | View correctness, benchmark pool queries |
| `public-writes.test.ts` | 13 | Anon and authenticated can not insert/update/delete core tables |
| `asset-comparison.test.ts` | 8 | Two-scan diff against stored rows |
| `join-codes.test.ts` | 15 | Code creation, use, expiry, revocation; one-time use enforcement |
| `organisations.test.ts` | 22 | CRUD, role enforcement, last-owner guard, co-member profile reads |
| `assessment-isolation.test.ts` | 26 | Users only read their own assessments; org members read the org's |

### Test infrastructure

- `tests/helpers/dns.ts` — `stubFetch()` replaces global fetch with a fixture table. Unfixtured DNS questions return NXDOMAIN (honest absence); unfixtured HTTP throws (surfaces test gaps).
- `vitest.db.config.ts` — separate config for DB tests; skipped when no local Supabase is running.

---

## 10. Documentation

### Inline documentation

All public interfaces in `src/lib/types.ts` carry TSDoc explaining the invariant behind each field, especially where the name alone would be misleading (e.g., the distinction between `not-probed` and `timed-out` in `unreachableReason`).

The three probe rules (signal-only, names-not-values, reachable ≠ unauthenticated) are stated as a module-level comment in `probe.ts` rather than scattered across the implementation.

`rateLimit.ts` documents the three failure modes it covers (per-identity windowing, bucket-cap against map exhaustion, concurrency gate) and explicitly names the weakness left open (rotating-address bypass of the identity limit).

`reportPayload.ts` states the design limitation: without server-side scan storage, the sanitiser narrows forged reports to plausible-looking content rather than eliminating forgery entirely.

### Scanner disclosure page

`src/app/scanner/page.tsx` — public page describing what Klyro probes, how:
- One GET to the host root per subdomain (not HEAD).
- Body read capped at 8 KB.
- Cookie values discarded; names only.
- "Not treated as bypassing authentication."
- User-Agent carries `+{NEXT_PUBLIC_SITE_URL}/scanner`.

---

## 11. Known Limitations

### Persistent rate limiting

The in-memory rate limiter (`src/lib/rateLimit.ts`) resets on every deploy and does not coordinate across serverless instances. An attacker who observes the reset can burst a second window immediately after. The fix — a shared store (Redis or Upstash) keyed by IP — is stated in the code comment but deferred.

### Team Cymru UNSPECIFIED fallback

The inventory module (`src/lib/intel/inventory.ts`) uses Team Cymru's public DNS TXT interface for network attribution. When Team Cymru returns `UNSPECIFIED`, the host's network is unknown. There is no secondary BGP data source for the fallback case.

### Per-subdomain path probing

Each subdomain currently receives one GET to its root. The exposed-paths module (which probes the primary domain) is not run against each subdomain — a staging environment that exposes `/admin/` at `staging.example.com/admin/` would not be flagged by the paths module. This is a budget and scope decision, not a technical limitation.

### Benchmark pool is not open for public contribution

`benchmark_opt_in` exists on `organisations` but nothing reads it yet. The benchmark corpus is seeded data only. Anonymous scan results are not stored (by design). Contribution from authenticated scans requires `benchmark_opt_in = true` for the owning organisation, which is not yet wired.

### No monitoring / reassessment schedule

Klyro is point-in-time only. There is no watcher that reassesses domains on a schedule, and no alerting when a score changes. The comparison view is manual (the user re-runs and diffs).

### Internationalised domain names (IDNs)

`src/lib/domain.ts` rejects IDNs and asks the user to enter the punycode form. No automatic ACE conversion.

### PDF binding to stored scans

`POST /api/report` accepts the scan result from browser state and sanitises it, but cannot verify it against a stored row. A sufficiently determined caller can construct a report with different scores (still subject to type and range constraints). The real fix requires binding the report endpoint to a stored assessment ID.

### `registrableDomainIsCertain()` false for exotic ccSLD patterns

`registrableDomain()` handles ~70 known two-label suffixes (co.uk, com.au, co.jp, …). For unlisted two-letter-country + generic patterns, `registrableDomainIsCertain()` returns `false` and the nameserver operator diversity result is reported with a caveat rather than as a fact.

---

## 12. Security & Compliance

### Attack surface

**SSRF:** `screenTarget()` resolves the domain and rejects any result that points to RFC 1918 / RFC 4193 / loopback / link-local addresses before any module runs. `safeFetch()` in `util.ts` repeats this check at connect time. `ssrf-live.test.ts` covers 5 live rejection cases.

**Injection:** No SQL is constructed from user input. All Supabase writes go through the typed JS client or the service role. The report sanitiser (`reportPayload.ts`) validates every field to a typed shape with length ceilings before the PDF renderer sees it.

**Cookie values:** `cookieNamesFrom()` in `probe.ts` splits `Set-Cookie` on the first `=` and discards everything after. Tested by `fingerprinting.test.ts` ("values never survive").

**XSS in PDFs:** @react-pdf/renderer renders to a PDF buffer server-side. There is no HTML string interpolation path.

**Secret exposure:** Server-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, `KLYRO_JOIN_CODE_PEPPER`, `KLYRO_ADMIN_TOKEN`) are never prefixed `NEXT_PUBLIC_`. `client-boundary.test.ts` asserts they do not appear in the client bundle.

**Join codes:** Stored as `HMAC-SHA256(code, KLYRO_JOIN_CODE_PEPPER)` — the database never holds the raw code. Changing the pepper invalidates all existing codes.

**RLS defence in depth:** Migration 0002 both drops the permissive insert policies and revokes the underlying grants. A future migration that accidentally adds a permissive policy would need to restore the grant before writes could proceed.

**Rate limiting:** 10 scans per IP per hour. A scan also consumes a token from a concurrency gate of 6 simultaneous scans per process. The report endpoint has a separate limit of 30 per IP per hour.

**Content-Length guard:** The report endpoint checks `content-length` before reading the body and enforces a 2 MB ceiling.

**Scan slot leak prevention:** The concurrency gate's `release()` is idempotent. It is called from both `finally` (normal completion or error) and `cancel` (client disconnection mid-stream).

### Privacy stance

- Anonymous scans produce no stored rows. Nothing is left behind after an unauthenticated assessment.
- Authenticated scans are visible only to the owner user and members of the named organisation (RLS-enforced).
- The public benchmark tables (`vendors`, `scan_results`, `ownership_assessments`) contain publicly observable facts about public domains.
- Profiles expose only `display_name` to co-members; email addresses remain in `auth.users` (GoTrue schema, not accessible to application code).

---

## 13. Configuration & Secrets

All configuration is via environment variables.

| Variable | Required | Server-only | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | No | No | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | No | No | Supabase anonymous (public) key |
| `SUPABASE_SERVICE_ROLE_KEY` | No | **Yes** | Bypasses RLS; must never be in client bundle |
| `KLYRO_JOIN_CODE_PEPPER` | No | **Yes** | HMAC key for join codes; ≥32 random chars |
| `KLYRO_ADMIN_TOKEN` | No | **Yes** | Guards the seed endpoint |
| `NEXT_PUBLIC_SITE_URL` | No | No | Canonical origin; appears in the scanner User-Agent |
| `NEXT_PUBLIC_SCANNER_CONTACT` | No | No | `abuse@` address in the User-Agent |

Without `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`, Klyro runs in fully anonymous mode: every check runs, every report generates, but nothing is stored and no benchmarks are shown.

---

## 14. Performance & Scalability

### Wall-clock budget per scan

| Phase | Budget |
|---|---|
| Module concurrency | 4 modules at once |
| Slowest individual module (subdomains) | 32 s |
| Vercel function ceiling | 60 s |
| Typical scan on a well-configured domain | ~18–22 s |

### HTTP probe concurrency

8 concurrent probes to subdomains (`PROBE_CONCURRENCY`). Each probe has a 5 s deadline (`PROBE_TIMEOUT_MS`) and reads at most 8 KB (`SUBDOMAIN_BODY_BYTES`).

### Memory

Scan results are held in memory for the duration of the stream only. Nothing is cached between requests (intentional: results must be fresh). The rate-limit map is capped at 20,000 entries with insertion-order eviction.

### Concurrency gate

6 simultaneous scans per process (`MAX_CONCURRENT_SCANS`). Returns HTTP 503 with `Retry-After: 60` when exhausted.

### PDF rendering

Synchronous in the Node.js process; typically 2–3 s for a full report. Does not share the scan concurrency gate.

### Benchmarks and leaderboard

Aggregation is done at query time from `vendor_leaderboard` and `industry_summary` views. No materialised views; acceptable for the current scale of the corpus.

---

## 15. Deployment & Operations

### Recommended platform

Vercel (Node.js runtime). The `maxDuration = 60` on scan and report routes requires a Vercel Pro or Enterprise plan.

### Local development

```bash
npm install
npx supabase start         # requires Docker
npx supabase db reset      # applies all 8 migrations
cp .env.example .env.local # fill in local Supabase credentials
npm run dev
```

### Running tests

```bash
# Unit tests (no database required)
npx vitest run

# DB integration tests (requires local Supabase running)
npx vitest run --config vitest.db.config.ts
```

### Seeding benchmark data

```
POST /api/admin/seed
Authorization: Bearer <KLYRO_ADMIN_TOKEN>
Body: { "domains": ["acme.com", ...] }
```

The seed route is idempotent. It inserts into `vendors` and `scan_results` only; it never touches `assessments`, which is the private authenticated table.

### Health signal

`activeScanCount()` in `rateLimit.ts` is exported for a future health endpoint. Currently there is no `/health` route.

### Logging

No structured logging framework. Next.js writes request logs; module errors surface as `type: 'error'` events in the NDJSON stream.

---

## 16. Version & Change Log

**Current version:** `1.0.0` (recorded as `TOOL_VERSION` in `constants.ts`, stored on every assessment row).

The comment on `CATEGORY_WEIGHTS` notes: scores from before the technology-module rebalance are not directly comparable to scores after it. `toolVersion` is recorded on every assessment, and the comparison view reads it.

### Notable milestones (chronological)

| Task | Change |
|---|---|
| Baseline | 10-module scanner with anonymous scan, PDF, benchmark |
| Auth / orgs | profiles, organisations, join_codes, assessments, benchmark_samples (migrations 0003–0008) |
| Public write removal | Migration 0002: revoke anon INSERT on core benchmark tables |
| Recharts removal | Custom SVG radar replaced recharts; no charting library dependency |
| Subdomain fingerprinting | `probe.ts`, `tiering.ts`; subdomains module rewritten; 38 platform rules; `PlatformStrength` |
| Risk tiering | `RiskTier`, `tierSubdomain()`, `SubdomainTiers.tsx` |
| Technology profile | `technologies.ts` (11th category); `TechnologyStack.tsx` |
| Domain Registration enhancements | EPP parsing, enterprise registrar bonus, cross-verification, hold cap |
| DNS resilience | `DNS_PROVIDER_FAMILIES`, Route 53 grouping fix, nameserver diversity, IPv6 info finding |

---

## 17. Validation & Cross-Checks

### Validated domains (live, at time of implementation)

| Domain | Validation point |
|---|---|
| `boschaishield.com` | Registration 66 (was 62); CSC Corporate Domains bonus recognised; `clientTransferProhibited` parsed; cross-verified against Verisign RDAP; Bosch self-hosted nameservers (bosch.de) correctly counted as 1 operator |
| `netflix.com` | Route 53 shown as 1 operator (not 4) |
| `github.com` | Route 53 + NS1 shown as 2 operators |
| `example.com` | Registration 100 without enterprise bonus (confirms bonus is truly additive) |

### Key test assertions that guard design decisions

| Assertion | Test file | Why it matters |
|---|---|---|
| Cookie values never survive | `fingerprinting.test.ts` | Privacy; enforced by test, not by care |
| `not-probed` ≠ `timed-out` | `fingerprinting.test.ts` | Budget limit must not be reported as a fact about the target |
| Weak platform ID never raises tier | `fingerprinting.test.ts` | GitLab regression — every page has "GitLab" in its title |
| Unlisted registrar scores 100 | `registration.test.ts` | Enterprise bonus must not be a penalty in disguise |
| Hold cap ≤ 30 | `registration.test.ts` | A domain on hold averaging with green locks would be misleading |
| Two bootstrap mirrors are not independent corroboration | `registration.test.ts` | Confidence `'medium'` unless registry-direct is reached |
| Anon cannot insert into `scan_results` | `public-writes.test.ts` | Benchmark integrity |
| Route 53 multi-TLD = 1 operator | `dns-module.test.ts` | Accurate diversity reporting |
| Healthy zone scores 100 | `dns-module.test.ts` | Regression — fixture updated to use two distinct operator domains |

---

## 18. Next Steps & Roadmap

### High priority

1. **Persistent rate limiting** — move the rate-limit map to a shared store (Redis / Upstash) so it survives redeploys and coordinates across Vercel instances.

2. **Report binding** — tie `POST /api/report` to a stored `assessments` row by ID. This closes the report-forgery surface entirely and removes the need for the client-side payload sanitiser.

3. **Team Cymru UNSPECIFIED fallback** — add a secondary BGP data source (e.g., RIPE STAT, BGPView) when Team Cymru returns no result.

### Medium priority

4. **Benchmark contribution** — wire `benchmark_opt_in` on `organisations`; allow authenticated org scans to contribute to `benchmark_samples`.

5. **Per-subdomain path probing** — extend exposed-paths checks to the top-N critical/high-tier subdomains discovered by the subdomains module.

6. **Monitoring / reassessment schedule** — add a cron-driven reassessment for watched domains with delta alerting via email or webhook.

7. **Health endpoint** — expose `activeScanCount()` and rate-limit bucket fill at `/api/health` for uptime monitoring.

### Low priority / polish

8. **IDN support** — automatic punycode conversion in `parseDomain()` so internationalised names work without requiring the user to know the ACE form.

9. **`registrableDomainIsCertain()` coverage** — extend `MULTI_LABEL_SUFFIXES` to additional ccSLDs so operator diversity for lesser-known country zones reports with higher confidence.

10. **Materialised benchmark views** — as the corpus grows, pre-compute `industry_summary` on a schedule rather than aggregating at query time.

---

*End of audit document.*
