# Klyro

External exposure assessment for enterprise security teams. Enter a domain, pick an industry and region, and get a passive reconnaissance assessment with a composite score, industry benchmarking, and a downloadable executive PDF written for non-technical readers.

Add your own company's domain and the report gains a section written from your side of the contract — where this vendor falls behind the standard you already hold yourself to, and which upstream providers the two of you would lose at the same moment.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

The app runs at `http://localhost:3000` and works immediately — Supabase is optional (see below).

## Configuration

Copy `.env.example` to `.env.local` and fill it in. The two `NEXT_PUBLIC_` Supabase values are enough to scan and benchmark; accounts and organisations additionally need the service-role key and a join-code pepper. Neither of those carries the `NEXT_PUBLIC_` prefix, and that is load-bearing — the prefix is what tells Next.js to inline a value into the browser bundle.

Then apply the migrations in `supabase/migrations/`, in numerical order — `supabase db push`, or paste each file into the SQL editor. They are idempotent. See [supabase/README.md](supabase/README.md).

> **Apply `0002_revoke_public_writes.sql` first, and on its own.** Any deployment still running the baseline schema lets the anon key — which ships in the browser bundle by definition — insert benchmark rows for any domain and rewrite any vendor's ownership record. It depends on nothing after it.

**Supabase is optional for scanning** — without it Klyro runs every check and produces the full report, it simply skips storing results. It is **required for the benchmark dataset**, rankings, historical tracking and ownership analysis.

## The benchmark dataset

144 curated vendors across all 18 industries, re-scanned on demand. Every run is kept, so scores can be tracked over time rather than replaced.

```bash
node scripts/seed.mjs
```

Seeds the whole dataset (~4–5 minutes at concurrency 3). Parent companies are seeded first, so that when a subsidiary is assessed its parent's scan already exists to measure against. Useful flags:

```bash
node scripts/seed.mjs --only okta.com,auth0.com --concurrency 4 --label run-2026-08-13
```

The seeding endpoint (`POST /api/admin/seed`) is guarded by `KLYRO_ADMIN_TOKEN` and skips the public rate limiter. Browse the result at [`/rankings`](http://localhost:3000/rankings).

### Schema

| Table / view | Holds | Readable by |
| --- | --- | --- |
| `vendors` | Canonical registry: domain, industry, region, ownership, LEI, provenance | everyone |
| `benchmark_samples` | The corpus: domain, score, industry, date. No findings, no owner | everyone |
| `ownership_assessments` | Measured parent-influence analysis, versioned like evidence | everyone |
| `vendor_leaderboard` | Current score, previous score, delta, industry + overall rank | everyone |
| `industry_summary` | Per-industry vendor count, average, median, range | everyone |
| `score_trend` | Run-over-run movement per domain | everyone |
| `assessments` | The full saved snapshot: categories, findings, evidence, inventory, benchmark | its owner, or its organisation's members |
| `assessment_hosts` | One row per discovered host — what makes an asset diff possible | via the parent assessment |
| `organisations`, `organisation_members` | Who belongs where, and with what role | members |
| `organisation_join_codes` | HMAC of each code, never the code | admins — minus the hash column |
| `organisation_vendors` | An organisation's own label for a supplier | members |
| `profiles` | Display name per account | self and colleagues |
| `scan_results` | Superseded by `benchmark_samples` in 0007. Read-only; nothing writes here | everyone |

The public corpus and private assessments are **separate tables, not one table with a
policy**. Row level security is per row and not per column, so "everyone may read these
five fields and members may read all of them" is not something a policy can express — and
approximating it with column grants would make every future column private by
forgetfulness rather than by design. A leak of `benchmark_samples` discloses what a public
leaderboard already discloses.

### Corporate ownership

Ownership is resolved from three tiers, in order of authority:

1. **Curated facts** in `src/lib/dataset/vendors.ts`, each with a named source.
2. **GLEIF** — the Global LEI Foundation's parent relationships, filed with regulators. Agreement raises confidence to `confirmed`.
3. **Wikidata** — cross-check only, and only when the entity's own published website matches the domain being assessed.

Disagreements are recorded as conflicts for human review, never silently resolved.

**A parent's reputation is never transferred to a subsidiary's score.** Instead Klyro measures how much infrastructure the two actually share — DNS hosting, email platform, certificate authority, registrar — and reports what that does and does not imply:

| Verdict | Meaning |
| --- | --- |
| `integrated` | Runs on the parent's stack; group standards plausibly apply |
| `partially_integrated` | Some services migrated, others did not — the common post-acquisition pattern |
| `independent` | Runs its own stack; the parent's programme is not visibly applied here |

A worked example from the dataset: **Bosch Building Technologies scores 53 (High Risk) while its parent Bosch scores 89** — a 36-point gap, despite sharing DNS, certificate authority and registrar. Being owned by a well-governed group did not make the subsidiary's own posture good, and the report says so explicitly.

## What it checks

Ten passive modules, all using free public sources with no API keys. Each returns a score out of 100 plus findings written in plain English.

| Category | Weight | Sources |
| --- | --- | --- |
| Email Security (SPF/DKIM/DMARC) | 15% | DNS over HTTPS |
| SSL/TLS Certificate | 15% | Live TLS handshake, certificate transparency |
| DNS Configuration | 12% | DNS over HTTPS: DNSSEC validation state, CAA, wildcard detection, nameserver resolution |
| HTTP Security Headers | 12% | Ordinary HTTPS request |
| Subdomain Exposure | 12% | crt.sh + CertSpotter, then DNS resolution of every host found |
| Exposed Paths | 10% | HEAD/GET probes with content verification |
| Domain Registration | 8% | RDAP |
| Cookie Security | 6% | `Set-Cookie` on first response |
| CORS Policy | 6% | Cross-origin probe |
| Robots & Security.txt | 4% | `robots.txt`, `security.txt`, `sitemap.xml` |

Composite score = weighted average of every category that could be assessed. Modules whose upstream source is unavailable are excluded and the remaining weights renormalised, so a flaky third party never lowers a domain's score — the report states the coverage achieved.

**The same rule applies inside a module.** `scoreFromComponents()` drops any component that could not be observed and rescales the rest, so an unreachable DNSSEC probe, a dropped TLS handshake or an unconfirmable DKIM selector reduces confidence rather than the score. Each affected module reports its own assessed weight.

Risk bands: **80–100** Low Risk · **60–79** Moderate Risk · **0–59** High Risk.

Every category publishes a **score breakdown** — each component, the points it earned out of the
points available, and a sentence explaining why. Components that could not be measured are shown
struck through and marked `excluded`. A score nobody can take apart is a score nobody has a reason
to accept.

### How findings are written

Every finding separates four things, and the separation is enforced by the type rather than by
convention:

| Field | Question it answers |
| --- | --- |
| `observed` | What did Klyro actually measure? No inference. A reader who distrusts everything else should still be able to accept this sentence. |
| `interpretation` | What does that observation reasonably indicate? |
| `risk` | What could follow **if** that reading is right? Conditional voice — the only field describing something that has not happened. |
| `recommendation` | What should be done about it? |
| `evidence` | The test performed, the observed value, the expected value, how it was corroborated, and what the test **cannot** establish. |

Alongside severity, every finding carries a **confidence** — reported separately, because how bad a
thing would be and how sure we are that it is true are independent questions:

- **high** — directly observed and corroborated (second resolver, content signature, protocol-level confirmation).
- **medium** — directly observed, with a stated limitation on what the observation covers.
- **low** — inferred from weak signal such as a naming convention. Never carries severe language.

There is deliberately no `unknown` confidence. Something that cannot be established does not become
a finding: `makeUnknown()` produces an `info` item whose `risk` field says explicitly that none is
being claimed, and the corresponding score component is dropped rather than failed.

### What matters most

`prioritise()` ranks findings by **severity × confidence × exposure** and prints the arithmetic
next to each item. Exposure is a per-category constant reflecting how directly an outsider can act
on the weakness — email spoofing and an open admin path need nothing but an internet connection;
a `robots.txt` disclosure needs everything else to have already gone wrong. The practical effect is
that a finding inferred from a host name can never outrank one read out of a DNS record at the same
severity, and the reader can check the ordering rather than take it.

### Asset inventory (recorded, never scored)

Organisation → host name → address → announced network → running software, assembled from names the
scan already established. Free and keyless throughout: DNS over HTTPS for addresses and reverse
lookups, [Team Cymru's public DNS interface](https://team-cymru.com/community-services/ip-asn-mapping/)
for network attribution, and the HTTP response the header check already fetched for technology
fingerprinting.

It carries no weight in the composite and never will — every quantity in it measures how large an
organisation is rather than how exposed it is. Technology versions appear only where the target
published one; nothing is inferred from behaviour, and nothing here establishes that a listed
technology is vulnerable.

### Scan comparison

`/compare?domain=…` diffs two completed scans: new findings, findings no longer observed, severity
changes, per-category deltas, and host names that appeared or disappeared. Matching is on finding
id, which is derived from the finding's own title rather than a counter, so the diff is
deterministic rather than a fuzzy text comparison. Every scan is already kept, so this needs no new
storage — it reads `scan_results` and writes nothing.

This is **not** monitoring. Nothing reassesses on a schedule. Two point-in-time observations support
statements about the two points and nothing between them, and the comparison says so in four ways:

- A finding absent from the later scan is "no longer observed", never "fixed".
- A category unavailable in either run produces a **null delta**, not a number — subtracting from a
  measurement that was never taken would manufacture a 90-point improvement out of a failed module.
- Coverage movement between the runs is stated with both figures.
- A **tool-version boundary** is called out. Finding ids derive from finding titles, which is what
  makes the diff deterministic and also what makes it useless across a release that reworded
  anything: every old finding reads as resolved and every new one as new. Comparing a pre-rewrite
  run of `monzo.com` against a current one reports 9 no longer observed and 12 new, and the first
  line of the limits block explains that this is the version, not the domain.

## Hardening

Klyro takes a host name from an anonymous visitor and makes server-side requests to it. That is a
server-side request forgery primitive unless it is constrained, and a security product with an SSRF
in it is not a security product. Three layers, in `src/lib/target.ts`:

1. **Name screening.** Suffixes reserved by RFC 6761/8375/9476 plus the private-use ones —
   `.local`, `.internal`, `.corp`, `.lan`, `.home.arpa`, `.test`, `.invalid`, `.onion` — are
   refused before any DNS is spent. `internal-api.monzo.com` is unaffected: only a whole reserved
   *suffix* counts, not a label that happens to contain the word.
2. **Pre-flight resolution.** The target is resolved and refused if **any** address is in a
   reserved range. `parseDomain` already rejects IP literals; this catches the public domain
   deliberately pointed inward. Verified live: `localtest.me` is refused with
   *"resolves to 127.0.0.1, which is loopback"*.
3. **Connect-time enforcement**, which is the layer that actually holds. A guarded `dns.lookup`
   runs on every connection and every redirect hop, so a record that answers publicly for the
   pre-flight check and privately a moment later still cannot be reached. The TLS probe opens a
   socket directly rather than through `fetch`, so it takes the same lookup.

**Redirects are followed one hop at a time** rather than handed to undici, because undici follows
the chain internally and never surfaces the intermediate URLs — a scanned site answering
`302 Location: http://10.0.0.1/` would otherwise be followed with nothing getting a look at where
it pointed. Each hop is re-checked, non-HTTP schemes are refused, and the chain is capped at five.

`tests/ssrf-live.test.ts` is the only test in the suite that opens real sockets, deliberately: it
stands up a listener on loopback holding a string no public host would return, then tries to reach
it the five ways an attacker would. It caught the gap that made the guard worth writing twice —
undici's `connect.lookup` hook never fires for an IP literal, so the dispatcher alone blocked
`http://localhost:PORT/` and let `http://127.0.0.1:PORT/` straight through.

Alongside that:

- **Concurrency gate.** The per-identity limit permits ten scans an hour *each*, so a burst from a
  modest number of addresses is entirely within the rules and still enough to exhaust the instance.
  Six concurrent scans, released on stream cancellation so a client navigating away mid-scan does
  not leak capacity for the life of the process.
- **Bounded limiter.** The sweep previously ran once per window, so an hour of requests from
  rotating addresses grew the map without bound. Now swept on a short interval with a hard entry
  cap, and the identity taken from `x-forwarded-for` is length-capped.
- **Report payload validation.** `POST /api/report` renders client-supplied JSON into a
  Klyro-branded PDF, and the scan lives in browser state so the endpoint cannot verify it came from
  a real assessment. `sanitiseScanResult()` rebuilds the object field by field — unknown properties
  dropped, enums checked, strings clamped, collections capped — so the endpoint cannot be used as a
  general-purpose "render my text under Klyro's letterhead" service. Binding a report to a stored
  scan is the real fix and needs the database.

## Accounts and organisations

Optional, and deliberately so. An assessment runs identically signed in or signed out; what
an account adds is that the result is kept.

**Anonymous assessments are not stored at all.** Not in the corpus, not in a private table
with a null owner. A row with no owner matches no policy, which makes it invisible until
some future mistake makes it visible to everyone — and a visitor scanning a domain has not
consented to publishing that the domain was scanned, or what it scored. The scan streams
back in full and nothing is left behind. The consequence is that comparison needs an
account, and the results page says so rather than hiding the button.

**A saved assessment is personal or organisational — never both, never neither.** That is a
check constraint (`num_nonnulls(owner_user_id, owner_org_id) = 1`), not a convention.

**Roles** are `viewer` < `analyst` < `admin` < `owner`, declared in that order so that
`role >= 'admin'` is a native Postgres comparison and the policies read as English. Viewers
read; analysts also run assessments for the organisation; admins manage members and the
join code; owners can additionally delete the organisation. An organisation always keeps at
least one owner — a constraint trigger refuses the delete that would strand it.

**Join codes are credentials and are treated as such.** Ten characters from an alphabet with
no `O`/`0`/`I`/`1`/`L`, about 49 bits. Stored as HMAC-SHA256 under a server-side pepper, so
the database never holds anything usable and one compromise cannot yield both halves. The
plaintext exists once, in the response that creates it; there is no endpoint that returns an
existing code and adding one would defeat the design. Every failure to redeem — unknown,
expired, revoked, exhausted — returns the same message, because distinguishing them tells
someone probing codes which guesses were close.

**Contributing to the benchmark is not automatic.** `assessments.contributes_to_benchmark`
defaults to false and nothing sets it. The corpus is the seeded dataset plus whatever the
admin seeding route adds, which is what keeps it controlled. Running a scan no longer grows
it.

### The client boundary

Four ways to reach Supabase, and the choice is always explicit:

| Module | Rights | Used for |
| --- | --- | --- |
| `supabase/browser` | anon, in the browser | auth UI only |
| `supabase/public` | anon, no session | the corpus, the registry, the rankings views |
| `supabase/server` | the caller's own | every user-scoped read; RLS decides |
| `supabase/service` | bypasses RLS | writing assessments, verifying join codes, creating organisations |

`getSupabase()` — a module-level cached client — is gone. It was safe only because it was
anonymous and stateless: in a long-lived server process the module is evaluated once and
shared by every concurrent request, so a client carrying a session would run as whichever
user's token was attached last. The symptom is users intermittently seeing each other's
data under load. `supabase/server` therefore constructs a client per request and must never
be memoised. `supabase/service` starts with `import 'server-only'`, so importing it from a
client component is a build error rather than a key in the bundle.

Authorisation is never done in middleware. Middleware sees cookies, not permissions, so a
check there tests whether a token exists rather than what it permits; `/app` and `/org` are
reachable while signed out and render an empty state, because the database returned nothing.

### Identifying the scanner

Klyro announces itself in every outbound request:

```
Mozilla/5.0 (compatible; KlyroExposureScanner/1.0.0; +https://klyro.security/scanner)
```

That URL is the convention a site operator relies on when an unfamiliar client turns up in their
logs, and it only works if it resolves. It used to 404. `/scanner` is now a page written for that
reader rather than for a customer: what Klyro is, the complete request surface, what it deliberately
does not do, and three copy-paste rules that block it.

Two details keep it honest rather than decorative:

- **The origin follows the deployment.** `NEXT_PUBLIC_SITE_URL` feeds the User-Agent, so a Klyro
  running anywhere else does not advertise a page on a domain it does not control.
- **The probe list is generated from the check that performs it.** `PROBE_MANIFEST` is derived from
  the same array `checkExposedPaths` iterates, so a path added to the scanner appears on the
  published page in the same commit. `tests/scanner-disclosure.test.ts` holds that, along with the
  requirement that the page disclose the one request that is not a GET or HEAD — the single
  introspection POST to `/graphql` — and the TLS handshake that deliberately offers TLS 1.0/1.1,
  which is the entry in a log most likely to be mistaken for an attack.

On `robots.txt`: Klyro fetches it as evidence, not as instruction, and the page says so plainly
rather than implying an opt-out that does not exist. A one-off assessment initiated by a named
person is not a crawl. The User-Agent rules are the answer, and they need nothing from us.

### Intelligence modules (reported, never scored)

Separate from the scored checks. These report what third parties have published about the
organisation rather than what Klyro observed about the domain, and they are deliberately excluded
from the composite — coverage volume tracks company size far more than company risk.

| Module | Source | Notes |
| --- | --- | --- |
| Company news & events | Google News RSS | Free, keyless. Clustered across outlets, classified by event type, each item carrying its outlet, that outlet's tier, and whether any independent outlet corroborated it. |

Every intelligence item is labelled **corroborated** (two or more independent outlets),
**single-source**, or **vendor-issued** (a press-release wire — the company is the author). Stories
that name the organisation but appear to be about someone else are marked **mention only**, so a
customer's breach is never filed as the vendor's.

**Customer reviews are not included.** Trustpilot, G2, Capterra, Reddit and Glassdoor all return
`403` to automated requests and prohibit scraping. Adding a sentiment score would require licensing
an official API; anything else would produce exactly the unverifiable data this tool exists to
avoid.

### Buyer context (optional)

The scan form takes a second, optional domain: the organisation *running* the assessment. Supply it
and Klyro assesses both domains with the same ten modules, then reports what the vendor's posture
means for that specific buyer.

Two things become measurable only once both sides are known:

| Reported | Why it needs both domains |
| --- | --- |
| **Standards gaps** | A gap is only meaningful against a standard. A vendor scoring 62 on headers is unremarkable beside a buyer scoring 58, and is a conversation beside one scoring 95. Divergences of 20 points or more are listed, in both directions. |
| **Concentration** | Two organisations sharing a DNS host, email platform, certificate authority or registrar fail together. That is invisible in either report alone — it is a property of the pair, not a weakness in either party — and it is what a continuity plan gets wrong, because the plan assumes you can reach your supplier during your own incident. |

A third concern is raised from the vendor's side alone but only matters to a buyer: when the
vendor's sender authentication is weak, mail claiming to come from them can be forged, and the
buyer's own DMARC policy does nothing about it — it governs the buyer's name, not the vendor's.
That is the vendor-invoice fraud pattern, and it is aimed at the reader's finance team.

Constraints, all deliberate:

- The comparison **never moves the vendor's score.** A second party's evidence has no business
  changing a number measured on the vendor's domain.
- The buyer's domain is **not scored against the vendor, ranked, persisted, or added to any
  benchmark pool.** `persist()` in `api/scan/route.ts` only ever writes the target.
- The buyer scan runs the **same ten modules** — a composite built from a different set of weights
  would not be comparable — and runs *alongside* the target scan rather than after it, so it costs
  concurrency rather than wall time. A paired scan of two domains completes in roughly 12 seconds.
- It costs a **second rate-limit token.** Running out drops the comparison and says so, rather than
  failing the assessment the user actually asked for.
- Where the vendor is ahead of the buyer, that is reported too. A comparison that only ran in one
  direction would not be worth reading.
- The buyer's domain must clear `MIN_CONTEXT_COVERAGE` (60% of scoring weight) before any
  comparison is published. A domain that does not resolve still produces a composite — around 21
  from the two modules that answer — and reporting that as "your score" would invent the standard
  the vendor is then judged against. Below the floor the section says so and the vendor's
  assessment is untouched. Above it but below 100%, the coverage achieved is stated.

### Scope

Passive reconnaissance only. Klyro reads published data and makes the same requests an ordinary browser or search-engine crawler would. It does not port scan, brute force, guess credentials, or exploit anything.

## Architecture

```
src/
├── app/
│   ├── page.tsx                 Landing page + scan form
│   ├── results/page.tsx         Dashboard (streams progress, then renders)
│   ├── compare/page.tsx         Diff of two stored assessments of one domain
│   ├── scanner/page.tsx         Operator disclosure — the page the User-Agent points at
│   ├── app/page.tsx             Saved assessment history
│   ├── org/                     Organisations: create, join, members, join code
│   ├── login/, signup/          Optional accounts
│   └── api/
│       ├── scan/route.ts        Orchestrator — NDJSON progress stream
│       ├── checks/*/route.ts    Ten single-module endpoints (debugging)
│       ├── intel/news/route.ts  Company news intelligence
│       ├── benchmark/route.ts   Industry/region comparison
│       ├── compare/route.ts     Read-only diff of two stored scans, scoped by RLS
│       ├── org/route.ts         List and create organisations
│       ├── org/join/route.ts    Redeem a join code
│       ├── org/[orgId]/code/    Issue and revoke join codes
│       └── report/route.ts      PDF generation
├── components/                  Dashboard UI
├── lib/
│   ├── checks/                  The ten scored check modules + shared utilities
│   ├── intel/                   Intelligence modules (reported, not scored)
│   │   ├── inventory.ts         Asset graph: host → address → ASN, plus technology fingerprinting
│   │   ├── linkage.ts           Parent-influence: shared-infrastructure measurement
│   │   └── relationship.ts      Buyer context: gaps + concentration against your own domain
│   ├── dataset/history.ts       Reads past scans back for comparison
│   ├── scoring.ts               Weights, normalisation, composite, prioritisation
│   ├── compare.ts               Manual diff of two completed scans
│   ├── benchmark.ts             Percentile ranking with pool fallbacks
│   ├── target.ts                Address guard — reserved suffixes, ranges, connect-time lookup
│   ├── site.ts                  Deployment origin, so the scanner's +URL resolves
│   ├── auth/
│   │   ├── context.ts           Turns a claimed org id into verified ownership
│   │   ├── joinCode.ts          Generation, normalisation, peppered hashing
│   │   └── organisations.ts     Create, rotate, revoke, join — service-role work
│   ├── supabase/
│   │   ├── browser.ts           anon, auth UI only
│   │   ├── public.ts            anon, no session — the public corpus
│   │   ├── server.ts            per request, the caller's own rights
│   │   └── service.ts           bypasses RLS; `import 'server-only'`
│   ├── dataset/assessments.ts   Writing the full snapshot + host rows
│   ├── reportPayload.ts         Rebuilds an untrusted scan result before it reaches the PDF
│   └── rateLimit.ts             In-memory limiter + scan concurrency gate
├── middleware.ts                Session refresh only — never authorisation
├── pdf/ReportTemplate.tsx       Executive report
└── tests/
    ├── *.test.ts                Unit suite, network stubbed
    └── db/                      Real Postgres via PGlite: RLS, isolation, roles
```

Check logic lives in `src/lib/checks/` and is imported directly by the orchestrator — the `/api/checks/*` routes are thin wrappers over the same functions, so a single module can be run in isolation:

```bash
curl "http://localhost:3000/api/checks/email-security?domain=example.com"
```

`POST /api/scan` streams newline-delimited JSON events (`start`, `module:running`, `module:done`, `complete`) so the dashboard can show live per-module progress. A full scan typically completes in 2–15 seconds depending on how quickly the certificate transparency logs respond.

### Benchmarking

`getBenchmark()` uses the tightest pool with enough samples: industry+region, then industry, then global. Pools below `MIN_BENCHMARK_SAMPLES` (30) are flagged `insufficientData` and the UI says so rather than presenting a weak comparison as authoritative.

## Design system

**Hue is reserved for risk.** Every neutral in `tailwind.config.ts` is a step on one graphite
ramp (`ground` → `panel` → `raised` → `line` → `line-strong`, text `tx` / `tx-2` / `tx-3`), and the
only saturated tokens are `risk.*`. Chrome — buttons, links, focus rings, active states — is paper
white. This is why a red row reads as urgent: nothing else on the page competes for that attention.
Adding a brand accent colour would undo it.

- **Type**: Archivo loaded with its `wdth` axis exposed, so `.wide` (125%) sets the large figures
  and `.num` (118%) the smaller ones. IBM Plex Mono carries scores, domains, and the `.micro`
  labels. Never hardcode a font family — use `font-sans` / `font-mono`.
- **The exposure matrix** ranks checks by *points lost from the composite* — renormalised weight ×
  shortfall from 100. The column sums to `100 − composite`, so the ordering is arithmetic rather
  than editorial, and a mediocre score on a heavy check correctly outranks a terrible score on a
  light one. All ten rows are single-line by design so they fit one screen without scrolling.
- Any `border-t`/`border-l` needs an explicit `border-line`; Tailwind's default border colour is
  light grey and will hairline-flash on this ground.

## Notes for maintainers

- **PDF layout**: do not set `lineHeight` on a `<Page>` or on any `<View>` in `ReportTemplate.tsx`. An inherited `lineHeight` prevents absolutely-positioned `fixed` children (the footer and page numbers) from being laid out at all. Put `lineHeight` on `<Text>` styles only.
- **`sr-only` inside a horizontal scroller** needs `relative` on that scroller. `sr-only` is
  `position: absolute`, so without a containing block it escapes the `overflow-x-auto` wrapper and
  widens the whole document on narrow viewports — it looks like a table bug but is not.
- **`ScoreMeter` never trusts `requestAnimationFrame` alone.** A backgrounded tab suspends its frame
  loop, which would leave the headline score reading `0`. The component short-circuits to the final
  value when the document is hidden and keeps a `setTimeout` backstop. Showing a wrong score is far
  worse than showing it unanimated.
- **Both charts are hand-drawn SVG**, not a chart library — that is what keeps `/results` at ~111 kB
  first-load JS and stops the benchmark and profile panels from inheriting a library's default
  legends and tooltips.
- **A failed lookup is not an absent record.** `dnsQuery` returns a `DnsResult`
  whose `resolved` flag separates "a resolver answered" from "nobody answered".
  Every caller must treat `resolved: false` as unknown. This is not a style
  preference: when the two were indistinguishable, a rate-limited query
  published *"No DMARC policy published"* at critical severity, and a failed
  DNSSEC probe published *"DNSSEC is not enabled"*, about domains that had both.
- **Two resolvers, and absence is confirmed against the second.** Google and
  Cloudflare are rotated so neither carries every scan, and an empty or
  NXDOMAIN answer is re-asked before it becomes a finding — a stale negative
  cache at one provider is exactly how a correctly configured domain gets told
  its records are missing. A positive from either beats a negative from the
  other. Quad9 was tried and dropped: its JSON API is on port 5053, which is
  filtered often enough that rotating into it just burned the module's deadline.
  Only add a third resolver that answers on 443.
- **Finding ids are derived from the finding, not from a counter.** `makeFinding`
  hashes the title, so the same issue on the same domain gets the same id on
  every scan. Without that, two runs cannot be diffed and the product can never
  say which findings were fixed. `buildCategory` suffixes any collision.
- **A failed measurement must never improve a score.** `ssl.ts` distinguishes a
  TLS protocol-version rejection from a dropped connection, because the old
  `legacyTlsSupported = legacy.reachable` awarded full marks whenever the
  legacy-probe timed out — which load balancers cause routinely on a second
  connection from one IP.
- **Certificate transparency is a history, not an inventory.** `subdomains.ts`
  excludes expired certificates and then *resolves* every host it found before
  counting or flagging it. A name certified in 2019 for a system retired in 2020
  is not attack surface. Hosts that cannot be resolved are excluded from both
  findings and score rather than assumed either way.
- **Subdomain penalties saturate per class.** Five staging hosts are the same
  finding as one at slightly larger scale, not five times the finding. Charging
  linearly per host drove any organisation with a normal number of internal
  names to zero.
- **`provider()` needs a family table.** Reducing a host to its registrable domain works for most
  operators but splits the big ones: Route 53 hands `awsdns-07.org` to one zone and
  `awsdns-52.com` to the next, and Google Workspace answers on both `google.com` and
  `googlemail.com`. Without `PROVIDER_FAMILIES` in `intel/linkage.ts`, two domains hosted side by
  side on AWS report as sharing nothing — a false negative in the concentration analysis, which is
  worse than a missing feature because the panel states it positively. Add families explicitly;
  never pattern-guess, because merging two genuinely separate operators is the worse error.
- **Report section numbers are derived, not written.** Two of the PDF's sections are conditional, so
  `sectionNo()` in `ReportTemplate.tsx` indexes a list built from what is actually present. A
  hardcoded `SECTION 03` goes wrong the first time a section is absent.
- **Exposed paths**: a 200 response is not treated as a finding until the body matches a signature for that resource, and a 403 is reported as *correctly blocked* rather than exposed. Sites that serve user-named content from the root (code hosts, wikis) are detected and their findings reduced in severity.
- **Rate limiting** is in-process and resets on redeploy. Swap `lib/rateLimit.ts` for Redis or a Supabase table if you need it to hold across instances.
- **Authorisation is the database's job, not a route's.** Every user-scoped read goes through `supabase/server`, which carries the caller's session, so row level security decides what comes back. There is deliberately no `.eq('owner_user_id', auth.uid())` alongside those queries: an application-level filter over a policy-protected table looks safer and is less safe, because it suggests the filtering happens in TypeScript and invites someone to simplify the policy away later.
- **`/api/compare` was an IDOR.** It took a domain, read every stored scan of it, and returned them — correct when every scan was anonymous and public, a disclosure of one customer's supplier analysis to another the moment assessments gained owners. Unusually easy to exploit, too: the identifier was not a UUID to guess but a company name to type. It now requires a session and reads through the caller's own client.
- **Anonymous scans persist nothing.** Not even a row with a null owner. Such a row matches no policy, which makes it invisible right up until a mistake makes it visible to everyone.

### Claims the code deliberately refuses to make

These are not oversights — reverting them would reintroduce statements Klyro cannot support:

- **DNSSEC absence is not evidence of tampering.** The finding states that the zone is unsigned and
  that DNS answers are therefore not cryptographically authenticated. It does not describe an
  attacker redirecting customers, because none was observed and none was looked for. Severity `low`.
- **A wildcard certificate is a configuration characteristic, not a vulnerability.** It is reported
  at `info` with no score penalty, and the reason it is reported at all is that it *reduces* what
  the subdomain section can see — names behind a wildcard never reach the transparency logs.
- **`Access-Control-Allow-Origin: *` on public content is the correct configuration.** It costs 5
  points and is reported at `info`. Origin reflection combined with credentials is the finding that
  matters, and even that says explicitly that no user-specific response was proven reachable.
- **A hostname is never called "internal".** Everything the subdomain module infers from a name is
  phrased as *the name suggests*, reported at `low` confidence, and raised to `medium` only when an
  HTTPS probe confirms something answers there. Naming alone can never support a `critical` rating.
- **A missing `X-XSS-Protection` header is not a weakness.** The filter it controlled was removed
  from Chrome in 2019 and never existed in Firefox; its absence is the modern correct state. It is
  excluded from scoring entirely, and only a *harmful* value produces an `info` note.
- **`robots.txt` naming `/admin` discloses nothing.** Universally common paths are filtered out
  before the finding is generated, since every attacker tries them regardless. Only genuinely
  unpredictable entries are reported, at `info`, as shortening reconnaissance rather than as an
  exposure.
- **A path is never reported because it returned 200.** Two randomly generated paths calibrate
  against catch-all routing, a redirect landing on the site root or another host discounts the body
  as evidence, and the body must match a content signature. `401`, `403` and `200` are reported as
  three different things — a `403` on `/.env` is recorded as a *positive* observation.
- **Cookie and CORS results are scoped explicitly.** Both only ever see an unauthenticated
  homepage; the cookies and cross-origin policies that carry real risk sit behind a login or on an
  API host. Each emits an `info` finding stating what was not covered.
- **`HttpOnly` is not scored when no session cookie was visible.** The cookie module states that
  session cookies are issued after sign-in and are invisible to it, then used to score as though it
  had seen them — a site setting one locale-preference cookie lost two thirds of the category for
  the cookie working as intended. The component is now dropped as unmeasured.
- **Unconfirmable DKIM costs nothing.** Selectors are free-form strings, so the
  probe list can only prove presence. It used to award 12 of 25 points for the
  uncertainty, which still marked down every organisation using a custom
  selector; the component is now excluded from the score entirely and reported
  as a question to put to the vendor.
- **A `redirect=` SPF record is a valid record.** It hands evaluation to another
  domain, whose default rule becomes the effective one, so the redirect is
  followed rather than reported as "no explicit default rule". `sap.com`
  publishes exactly `v=spf1 redirect=_spf.sap.com` and scores 100.
- **An SPF lookup count that hit the traversal ceiling is reported as a lower
  bound.** A hard "exceeds the RFC 7208 limit" finding is only published when
  the walk actually completed; a truncated one says "at least N" and is scored
  as a warning, because asserting a standards breach from a number the code
  knows it did not finish computing is not a finding.
- **One domain, one vote in the benchmark.** `scan_results` keeps every run by
  design, so a pool built from raw rows counted a domain once per scan and gave
  a re-seeded vendor thirty times the weight of a real peer. `latestPerDomain()`
  reduces to the most recent scan each, and drops the domain being assessed so
  it is not ranked against itself.
- **Percentiles are only published for a like-for-like pool at or above `MIN_BENCHMARK_SAMPLES`
  (30 distinct domains).** Broader fallback pools still supply an average for context but never a rank — ranking a
  bank against a mixed global pool would be a fabricated statistic. The pool is always described as
  "domains assessed by Klyro", never as "companies in your industry".
- **The buyer comparison never claims to know impact.** Klyro cannot see what data a vendor holds
  for you, which of your systems it connects to, or how much of your operation depends on it — and
  those are what decide whether a vendor incident becomes yours. The section states its own limits
  on every render, and a shared provider is always reported as concentration rather than as a
  criticism of either party.
- **Unmatched news stories get no severity.** The search terms are broad `OR` groups, so appearing
  in the security query proves nothing; unclassified items are recorded as general coverage at
  `info`.
- **A headline using incident vocabulary is not an incident.** "How to survive a ransomware attack:
  Acme's CISO explains" matches the ransomware rule perfectly. Where a headline reads as commentary
  or guidance, the story is still shown but the incident classification is withheld.
- **A comparison between two scans reports "no longer observed", never "fixed".** Two point-in-time
  observations say nothing about the interval between them, and a finding can disappear because a
  module failed rather than because anything changed.
- **A degraded certificate-transparency harvest is reported as unassessed, not as a clean result.**
  When both rich CT queries fail, the fallback returns the apex certificate only — enough to keep
  the scan moving, and nothing at all about the estate. The module used to carry on and report "2
  host names found, none of them sensitive" for a score of 100, which is absence of evidence
  presented as evidence of absence on the one category where the estate *is* the subject. Observed
  live: two scans of `cloudflare.com` twenty minutes apart scored 100 and 51 on this category,
  the difference being entirely whether crt.sh answered. The category is now dropped from the
  composite and the rest renormalised, which is what the coverage figure exists to report.
- **A withheld percentile gives the reason that actually applies.** There are two: too few domains,
  and a pool that is large but mixed. The sentence used to give the size reason in both cases, so a
  151-domain global pool was described in the same sentence as being "below the 30-domain
  threshold" — a claim the reader could see was false from the figure next to it.
- **An empty host-name diff is not reported as an unchanged estate.** Stored assessments keep scores
  and findings, not the host names discovered, so a comparison read back from the dataset cannot
  diff the estate at all. The section simply did not render, which reads as "nothing changed". It
  now says the data was not retained.
- **Informational findings appear in the PDF.** They were filtered out of the report and nothing
  said so, which meant the dashboard showed ten findings and the PDF described four. The six it
  dropped were mostly the scope statements — *cookie review covers the pre-login response only*,
  *cross-origin review covers the site root only* — so the artefact that leaves the building was
  the one missing the limits on its own claims. They are listed compactly, under their own heading,
  stated as carrying no score impact.
- **Host names are never hyphenated in the report.** react-pdf's default hyphenation broke evidence
  text mid-token, producing `cloudflarein-sights.com` and `static-stag-ing.cloudflareinsights.co`.
  In a security report the exact host name is frequently the whole finding, and a reader copying one
  out of the PDF copies a name that does not exist. Tokens containing a dot, slash or colon are kept
  whole; long URLs break after a slash, which cannot invent a different name.

- **An assessment is append-only once written.** Deleting your own is reasonable; editing it is not. A trigger refuses any change to the observation — score, findings, evidence, inventory, timestamp, owner — because a report exported from an edited assessment carries Klyro's name over numbers Klyro never measured.
- **A join code failure never says which kind of failure.** Unknown, expired, revoked and exhausted all return one message. Distinguishing them tells someone probing codes which guesses were close, and a search with feedback is a different problem from a search without it.
- **An organisation always keeps an owner.** The last owner cannot leave or demote themselves. Without that, an organisation reaches a state where nobody can rotate its join code, manage its members or delete it, and recovery means editing the database by hand.
- **A member removed from an organisation loses access immediately.** Visibility is evaluated per query rather than granted at join time, so there is no cached membership to expire.

### Voice

Third person throughout, and enforced by `tests/voice.test.ts`. Klyro is used far more often to
assess a supplier than the reader's own estate, so copy reading *"your email can be spoofed"* was
addressing the wrong party — in a procurement setting it makes the report look as though it were
about whoever is holding it. The one place second person is correct is the buyer-context panel,
where the reader supplied their own domain and "you" genuinely means them.

## Testing

```bash
npm test        # unit — network stubbed, milliseconds
npm run test:db # database — real Postgres, real policies
npm run test:all
```

### The database suite

`npm run test:db` boots [PGlite](https://pglite.dev) — Postgres 18 compiled to WebAssembly,
running in process — creates the `auth` schema and the `anon` / `authenticated` /
`service_role` roles that Supabase supplies, replays every file in `supabase/migrations/`,
and then attacks the result. No Docker, and the policies are enforced by Postgres rather
than asserted against a mock.

84 tests covering: cross-user reads by id and by domain, cross-organisation reads, host rows
read around their parent assessment, role escalation in both directions, an admin trying to
demote or remove the owner, the last owner stranding an organisation, direct membership
inserts, forged and edited assessments, the one-owner constraint, join code expiry,
revocation, rotation and reuse, the hash column being unreadable even to admins, asset
diffing across two persisted assessments, and a full snapshot surviving a round trip.

Two things in the harness matter more than they look:

- It applies Supabase's **default privileges** before running the migrations. Without them
  every unauthorised query would fail with "permission denied" and the suite would pass
  while proving nothing about the policies.
- `public-writes.test.ts` includes a **control** that runs the baseline alone and asserts the
  forged write *succeeds*. Reproducing the vulnerability is what shows the other assertions
  are observing the fix rather than an artefact of the harness.

One distinction the suite had to learn the hard way: row level security **filters** on UPDATE
and DELETE rather than refusing. An update whose USING clause excludes every candidate row
is not an error — it is a successful statement that changed nothing. Four tests originally
asserted an exception and "failed" against policies that were working correctly. Expecting
an exception there produces a test that passes whether or not the policy exists, so
`affectsNothing()` requires a RETURNING clause and checks the row count instead.

### The unit suite

271 tests across sixteen files, covering the matrix that matters: every SPF default rule including
`redirect=`, duplicate records and lookup-limit truncation; every DMARC policy including `sp=` and
`pct=`; DKIM found and unfindable; resolver success, NXDOMAIN, empty answer and total failure;
DNSSEC signed, broken, unsigned and undeterminable; CAA present, absent and unreachable; wildcard
DNS; nameserver resolution; CORS wildcard, reflection, credentials and combinations; CSP nonce
handling and wildcard scoping; `frame-ancestors` as a substitute for `X-Frame-Options`; path probes
returning 200, 401, 403, 404 and SPA catch-alls; redirect discounting; cookie attribute weighting;
benchmark deduplication, percentile arithmetic and sample thresholds; prioritisation ordering; scan
comparison including the coverage-moved, version-boundary, discovery-volume and unrecorded-asset
warnings; reserved suffixes, reserved address ranges and IPv4-mapped IPv6; embedded newlines and
internationalised names in the domain parser; rate limiting and the concurrency gate; report payload
sanitisation; the scanner disclosure page matching the scanner; and report voice.

Every test drives a stubbed `fetch` except `ssrf-live.test.ts`, which needs real sockets to prove
what it proves. Nothing else reaches the network, so the suite does not fail on someone else's bad
day — and an unstubbed request throws rather than silently exercising the "upstream unavailable"
path.

The suite has earned its keep twice:

- It caught the `LOOKUP_MECHANISMS` regex matching the `a` in `-all`, which charged every SPF
  record one DNS lookup it does not use and compounded through each nested `include:`.
- It caught the address guard passing IP literals, because undici skips DNS resolution when there
  is no name to resolve — which meant the first version of the guard blocked `localhost` and let
  `127.0.0.1` through.

Two more defects came out of reading real output rather than from the suite, and now have tests
holding them: the benchmark sentence giving the wrong reason for withholding a percentile, and the
PDF quietly dropping every informational finding.

## Scripts

```bash
npm run dev        # development server
npm run build      # production build
npm run start      # serve the production build
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # vitest, single run
npm run test:watch # vitest, watch mode
```
