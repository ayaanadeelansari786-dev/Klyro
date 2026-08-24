# Changelog

All notable changes to Klyro are recorded here.

`TOOL_VERSION` in `src/lib/constants.ts` is written onto every stored
assessment, so a report can always be traced to the version that produced it.

## [1.14.0] — 2026-08-24

### Added

- **Administrators and owners can change a member's role**, from the members
  panel on the organisation page, and remove members. The roles have existed
  in the schema since organisations were added and there was no way to assign
  one — everybody who joined by code arrived a viewer and stayed a viewer.
- Only an owner can make another owner; an admin may manage everyone except
  owners. Both rules are the database's, not the route's, and both were
  verified against the live policy before shipping — as was the last-owner
  constraint trigger, whose own message is passed through rather than
  replaced because it names the fix.

### Fixed

- **Saving an assessment to an organisation appeared to do nothing for a
  viewer.** The scan form only offers organisations the reader may write to,
  and for a viewer that is none — so the "Save this assessment to" control
  was absent entirely and every scan was filed personally with no explanation
  anywhere. Absent read as broken. The form now names the organisations the
  reader belongs to, says saving starts at analyst, and points at the page
  where a role can be changed.
- The filing path itself was never at fault: `resolveOwner` files under an
  organisation correctly for an analyst and above, and has tests covering
  every rank. Confirmed against production data — every stored assessment was
  personal because the account running them holds `viewer`.
- The role route mishandled one of the two ways row-level security refuses. A
  USING clause *filters*, so a forbidden row returns zero rows; a WITH CHECK
  clause *raises*, as `42501`. On `organisation_members` both halves carry the
  same test, so an admin demoting an owner returns zero rows while an admin
  promoting anyone to owner raises — and the second was falling through to a
  generic failure that explained nothing. Found by testing each rule against
  the real policy rather than reading it.
- The members panel now states which rank saving to the organisation starts
  at. "Analyst" does not tell anyone that, and it is the single fact somebody
  choosing a role most needs.

## [1.13.0] — 2026-08-24

### Fixed

- **The account control no longer re-asks who is signed in on every
  navigation.** The header was rendered by each page rather than by a layout,
  so every click unmounted it and mounted a new one, which called
  `auth.getUser()` again and re-fetched the reader's organisations again. The
  name in the corner emptied and refilled on each page change, and the scan
  form's organisation dropdown repopulated with it. Nothing was slow in the
  sense of taking a long time — the same fast request was simply being made
  over and over, and each one was visible.
- The session now resolves once, in a `SessionProvider` mounted in the root
  layout, which survives client-side navigation. Verified in the browser:
  five consecutive in-app navigations with no page reload, and the account
  control painting its settled state rather than its pending one on arrival.
- `useMemberships` is now a two-line read from that provider instead of a
  second Supabase client with its own auth subscription.
- The auth client is still dynamically imported inside the provider's effect,
  so it stays out of every first-load bundle — the landing page remains
  statically prerendered at 114 kB, and `/methodology` and `/scanner` at
  99.9 kB rather than the ~170 kB a static import would have cost them.
- `/app` and `/org` now render a skeleton the instant a navigation starts.
  Both are `force-dynamic` and read two or three tables first, so a click
  used to do nothing visible at all until the whole response landed.
- The organisation pages ran their queries in sequence, with the join-code
  fetch gated on a role derived from the query before it — four round trips
  stacked end to end. They now run concurrently. The gate was never the
  boundary: `organisation_join_codes` has an admin-only policy and column
  grants that keep the hash from every client role, so a viewer gets zero
  rows from the database rather than zero rows from an `if`.

### Changed

- **One navigation bar, on every page, with the current page marked.** Four
  pages had each grown their own, with different subsets of links and the
  same destination named three different ways — "Your assessments",
  "Assessments", and nothing at all — depending on where you were standing.
  None of them showed where you were. There was no stable place to look, so
  every navigation started by reading the header to find out what it
  contained this time.
- The two organisation views are now tabs rather than a pair of asymmetric
  cross-links that renamed each other depending on the direction of travel.
  `/org/[id]` and `/org/[id]/activity` are the same organisation seen two
  ways, and the interface now says so. A breadcrumb back to `/org` replaces
  "All organisations" sitting among unrelated links.
- The report and rankings views carry their own compact header and offered
  the wordmark and nothing else — a reader who opened a result had no route
  back into the product and no way to tell which account it had been saved
  under. Both now carry the account control, and the account menu carries the
  primary navigation, which is what makes one control enough.
- The benchmark dataset is in the navigation. It was linked from a one-item
  `<nav>` on the landing page and from nowhere else, so it existed only for a
  reader standing on the home page and looking to the right of the wordmark.
- The header splits left and right — wordmark and navigation against account
  and theme — rather than crowding everything to the right of the wordmark.
- Below `lg` the navigation moves into the account menu rather than
  overflowing. Verified at 375, 768, 1024, and 1280: no horizontal overflow
  at any of them, and the four-item signed-in bar measures 373 px against
  949 px of available header at 1024.

### Added

- `tests/navigation.test.ts` pins the rules above, because every one of them
  broke silently: no page may compose its own `<nav>`, the header bar and the
  account menu must read the same list, the provider must live in the root
  layout, and no other component may hold an auth subscription. Two of these
  caught real defects on their first run — a surviving one-item bar on the
  landing page, and the fact that the benchmark dataset was unreachable from
  anywhere else.

## [1.12.0] — 2026-08-24

### Added

- **A vendor is now ranked against the organisation's whole portfolio, not
  only its own industry.** The portfolio panel carries two switchable sets:
  the vendor's industry, and every domain the organisation has assessed
  regardless of sector. The industry set is the sharper comparison and leads
  when it has anything in it — but it is empty for the first vendor in every
  new industry, which early on is most of them, and a buyer with a
  three-sector supplier list was being shown "first of one" while a
  nine-vendor ranking existed and went unmentioned.
- Both rankings come from one query, split in memory rather than fetched
  twice. A test asserts the fetch is never filtered by industry, because that
  is invisible in the output and would otherwise regress silently.
- The mixed set labels each peer's industry and says plainly what it costs:
  sectors differ in what they typically expose, so a low position there can
  reflect the industry as much as the vendor. Neither set is described as a
  percentile — the shared benchmark's thirty-domain floor exists precisely to
  keep that word attached to a claim that can support it.
- **Owners can delete an organisation**, from the settings page. Verified
  against the live database under simulated row-level security before
  shipping: a viewer's delete removes 0 rows, an owner's removes 1, and the
  organisation's assessments and member rows go to 0 with it.
- The confirmation states the cascade in counts the reader can check against
  the page they are standing on — *n* saved assessments, for every member,
  not just for them — and requires typing the organisation's name. The
  cascade is the real design problem here: `assessments.owner_org_id` is
  `on delete cascade` and the table's check constraint requires exactly one
  of `owner_user_id` / `owner_org_id`, so there is no option to orphan the
  assessments to whoever ran them. An interface calling this "delete an
  organisation" is not describing what it does.
- Anonymised rows already contributed to the shared benchmark corpus survive
  the delete and the panel says so — they carry no organisation reference by
  design and cannot be traced back.

### Changed

- The activity dashboard is now linked from `/org` and `/app`, for every
  member at every role. The visibility itself was never restricted —
  `assessments` grants read to `app.is_org_member`, verified again here — but
  the only route to the page was the organisation settings page, so a viewer
  who had no reason to open settings had no way to find it.

### Security

- The delete route re-tests nothing in TypeScript. Authorisation is the
  DELETE policy on `organisations` (`app.has_org_role(id, 'owner')`), the
  route runs as the caller, and a non-owner deletes no rows whatever they
  post. The typed-name confirmation is a guard against a mis-click, not
  against an attacker, and is described as such in the code. A test asserts
  the route contains no role check of its own, so a future edit cannot
  quietly add a second copy of the rule that is free to disagree with the
  first.

## [1.11.0] — 2026-08-23

### Added

- **A per-organisation activity dashboard** at `/org/[orgId]/activity`: the
  member roster with each person's scan count, and every assessment filed
  under the organisation — score, domain, industry, region, timestamp, and
  who ran it. Linked from the organisation settings page.
- Open to any member, not just owners or admins: `assessments` already grants
  every member read access to everything their organisation owns, and `/app`
  has shown a colleague's scans since that policy was written. Restricting
  this specific view would be a page pretending to a boundary the database
  does not enforce.
- `created_by` is resolved against the member roster already fetched for the
  page rather than via a second embedded query. `assessments` has two
  columns referencing `auth.users` (`owner_user_id` and `created_by`), and
  `profiles.id` references the same table — asking PostgREST to embed
  `profiles` through `created_by` is genuinely ambiguous between the two.
  Verified directly against the database (two foreign keys to `auth.users`
  confirmed) before writing the workaround, and the workaround itself
  verified end to end under simulated RLS before shipping: seeded a real
  organisation, two members, two assessments with different creators, ran
  the page's exact queries as the row-level-security-restricted member would,
  confirmed correct attribution, then cleaned up.

## [1.10.1] — 2026-08-23

### Fixed

- **Light theme text was too faint.** The secondary and tertiary inks were a
  near-mirror of the dark ramp, landing at 5.82:1 and 4.51:1 on the light
  ground. Both cleared the 4.5:1 floor and both were hard to read — the floor
  marks where text is definitely wrong, not where it becomes comfortable, and
  `--tx-3` carries 11px metadata across the whole dashboard. Now 7.24:1 and
  5.82:1, with the hierarchy unchanged.
- **"Sign in to save" was shown to readers who were already signed in.** The
  dashboard had only `result.persisted` to go on, which is false both for an
  anonymous scan and for a signed-in scan whose write failed, so a
  misconfigured deployment told the reader to do the one thing they had
  already done. The scan stream now reports the outcome (`anonymous`,
  `saved`, `failed`); a failed save shows "Not saved" and a banner explaining
  that the deployment is missing the credentials to store assessments, rather
  than a link that would not have helped.

## [1.10.0] — 2026-08-23

### Accounts you can see, and leave

- The header now says who is signed in. `AccountMenu` sits inside the shared
  `SiteHeader`, so every page carries it: signed out it offers sign-in and
  create-account, signed in it shows the account's name and email — the
  question a person with a work and a personal login is actually asking — plus
  links to their assessments and organisations.
- **Sign out now exists.** It did not, anywhere in the tree, at any point
  before this release. A person could sign in and had no way back out.
- Resolved in the browser rather than on the server, so the landing page keeps
  its static prerender. Subscribed to `onAuthStateChange` rather than read
  once, so signing out in another tab does not leave a header naming somebody
  who is no longer there.

### Assessments can be filed to an organisation

`resolveOwner` has accepted an `orgId` since organisations were added, and
nothing in the interface ever sent one. Every scan a member ran was therefore
filed personally — invisible to their colleagues, and absent from the
portfolio below. The scan form now asks, defaulting to the reader's
organisation, and offers only memberships that may actually write: a viewer
picking their organisation would have had the scan bounced back to personal
with a notice, which is a worse way to learn the same thing.

### A vendor against the others you have assessed

A new section on the results page ranks the domain being assessed against the
other vendors the same organisation has assessed in the same industry —
"Third of seven Technology vendors Acme has assessed" — with every peer named
and scored beneath it.

It is deliberately **not** a second benchmark. The shared corpus refuses to
publish a percentile under `MIN_BENCHMARK_SAMPLES` domains because a
percentile is a claim about an industry; an organisation will have assessed
three vendors, or eight. So this states a position within a named set the
reader assembled themselves, which is true at any pool size because nothing is
being inferred — and the copy says so, pointing at the shared benchmark as the
industry comparison. A portfolio of one reports that rather than "first of
one".

Read through the caller's own client, so the policy on `assessments` decides
what is in the pool. A non-member gets an empty portfolio rather than a
refusal, which is the same shape a member with nothing assessed yet gets.

### Also

- History rows name the organisation an assessment belongs to instead of the
  word "organisation". The page already listed colleagues' assessments — the
  policy allows it and the query is unscoped — but a member of two
  organisations could not tell which was which.
- The pointer-tracked sheen is gone from the four glazed surfaces it sat on. It
  read as a hover glow rather than as glass catching light, which is the
  opposite of what it was built for. `useSheen` and its tokens are deleted
  rather than left unused.
- The landing page's validation strip is withdrawn, and its component deleted.
  `/methodology` remains the place that record is kept.
- Network Exposure has its own dashboard section, alongside Subdomains and
  Technology, listing each recorded port as its own row rather than folding
  them into one sentence. Port classification moved to
  `src/lib/checks/ports.ts` so the dashboard and the check module read one
  table; importing it from `internetdb.ts` would have pulled Node's `dns` into
  the browser bundle.
- Deferring the auth client kept the first-load bundle where it was: adding it
  to the shared header cost about seventy kilobytes on every page, including
  two static documents that will never ask who is signed in.

## [1.9.0] — 2026-08-22

### Results dashboard: hierarchy, depth, and motion

Presentation-layer pass over the results dashboard and landing page. Nothing
in scan logic, scoring, or the database changed.

- A third elevation tier, `.panel-elevated`, reserved for exactly one object
  per screen — the composite score, now `clamp(96px, 15vw, 168px)` (was
  capped at 124px) and wrapped with its coverage line in the new surface. A
  `.readout` primitive exists for the next recessed data reading.
- `CheckMatrix` rows now expand below a score of 80 — larger type, the row's
  worst finding surfaced inline — while healthy rows stay compact. Also
  expands `internetdb` on any real finding regardless of score: a single
  open remote-access port only costs 15 points, which kept Network Exposure
  reading "healthy" while a genuine, named, third-party-observed finding sat
  in a one-line row easy to miss. Severity and category order are untouched.
- `FindingsTable` rebuilt from a flat table into three densities: critical
  and high render as tinted, elevated cards; medium keeps its previous
  weight; low and info collapse behind a single "N low-severity
  observations" toggle. The previous column-sort control is gone — severity
  is the layout now, not something to sort away from.
- `FindingDetail`'s "what this cannot establish" line is now the one line in
  the component set in quiet italic tertiary ink, matching the rest of the
  hierarchy: Observed and Recommendation stay primary, Interpretation and
  Risk stay secondary.
- Orchestrated page-load entrance (score → priority → matrix → findings) and
  a `ScanProgress` module list that staggers in and replays a row's
  completion state on change.
- Fixed a reduced-motion gap that predates this release: the stylesheet
  zeroed `animation-duration` but never `animation-delay`, so a staggered
  element still sat invisible for its full delay under
  `prefers-reduced-motion` before an instant animation played it in.
- Landing page gained `ValidationStrip`, quoting three rows — one "held up,"
  two "Klyro was wrong" — from a new shared `src/lib/validations.ts`, which
  `/methodology`'s "Track record" table now reads from as well rather than
  carrying its own copy.
- A barely-perceptible grain texture (2% alpha, capped inside the SVG filter
  itself) added to the page ground.

Network Exposure (Shodan InternetDB) was verified already fully registered:
present in `CATEGORY_ORDER` and `CATEGORY_WEIGHTS` at 8%, wired into the
module registry, rendering in the exposure matrix and findings register, and
printing its own page in the PDF. See `DESIGN.md` for the full reasoning
behind every change in this release.

## [1.8.0] — 2026-08-21

### Added

- Three starting legal documents — Terms of Service, Privacy Policy, and
  Acceptable Use Policy — served as static files at `public/legal/`, so they
  are reachable at `/legal/TERMS_OF_SERVICE.md`, `/legal/PRIVACY_POLICY.md`
  and `/legal/ACCEPTABLE_USE_POLICY.md`. Linked from the footer on every page
  and from a new section on `/methodology`. **These are drafts for legal
  review, not documents to publish as-is** — every file carries that status in
  its own first line, and `tests/legal-docs.test.ts` asserts the banner is
  still there.
- All three documents cross-link the other two by their served path;
  `tests/legal-docs.test.ts` asserts each of the three references the other
  two, so a rename does not quietly break an internal link the way it would
  in prose nobody re-reads.

### Corrected against what the product actually does

The brief this was built from assumed several things about the system that
are not accurate, and copying them into a document meant to state facts would
have made it wrong on day one:

- **Anonymous scans are not stored at all.** `assessments` rows require an
  owning user or organisation; a scan run without signing in streams its
  result to the browser and leaves nothing in the database. The brief's "scans
  are stored indefinitely" is true only of signed-in scans, and only those are
  described that way.
- **The rate-limit window is roughly one hour, not seven days.** `RATE_LIMIT_
  WINDOW_MS` is 3,600,000ms; an IP address is not retained in any separate log
  beyond that window.
- **A live user's scan does not currently feed the benchmark pool.**
  `insertBenchmarkSample` is called only from the admin seeding endpoint. The
  `benchmark_opt_in` column exists and defaults to off, but no live scan path
  reads it yet. The Privacy Policy describes this as a dormant, off-by-default
  capability rather than an active one — stating it as active would have been
  wrong the moment someone checked.
- **Accounts genuinely exist and hold an email and a password**, via Supabase
  Auth, in a schema Klyro's own application code cannot read. The brief's "we
  do not store email addresses" is false for signed-in users and is not
  repeated here.
- **No analytics vendor is integrated.** The brief assumed Vercel Analytics;
  it is not in `package.json`. The Privacy Policy says plainly that none is
  currently used, and commits to naming one if that changes, rather than
  describing a vendor that was never wired in.
- **No self-service data-deletion control exists in the product.** Access and
  deletion requests are described as handled by contact, because that is what
  is actually built; the brief implied a self-service flow.
- **The Network Exposure check's own boundary is stated precisely**,
  consistent with `/scanner` and `/methodology`: Klyro does not connect to any
  port that check reports on. It reads a third party's (Shodan's) prior,
  undated record and says so in the Terms rather than folding it into "passive
  Shodan queries" as if it were the same category of action as the other
  eleven checks.

### Fixed, before first publish

Four follow-up corrections, made before any of this was committed or
deployed:

- The Privacy Policy's "Report contents" bullet described what a stored
  assessment contains without restating, in that bullet, that an anonymous
  scan is never stored at all — true elsewhere in the document, but a reader
  who only reads that one bullet would not have seen it. It now says so
  locally.
- The Privacy Policy never claimed benchmark population from live scans as an
  active use, correctly, since no code path does that yet — but it also never
  said so. Silence and "not yet active" read the same to a reader scanning a
  bullet list; the document now states the inactive status explicitly rather
  than leaving it to be inferred from an absence.
- The Terms of Service's Data Handling summary described where a scan itself
  is or is not stored but never mentioned an account's own email address. It
  now states plainly that an email is retained only for account holders, and
  that credentials and confidential data from a scanned domain are not
  stored — a fact the Privacy Policy already carried, brought into the
  Terms' own summary rather than left implicit in a cross-reference.
- The Network Exposure (Shodan) item already stated the record carries no
  published date and is never presented at direct-observation confidence; it
  now also says the concrete, lay-reader version of that — the record may be
  weeks or months old and should not be relied on as current — rather than
  requiring the reader to draw that conclusion themselves.

### Notes for operators

- Every bracketed placeholder — organisation legal name, governing
  jurisdiction, dispute venue, and a dedicated privacy/legal contact address —
  is a genuine business or legal decision this session could not make. The
  scanner's existing abuse contact (`abuse@klyro.security`) is referenced as
  the only real address configured in the product today; it is not proposed
  as the permanent legal contact.
- A lawyer has not reviewed these documents. They are a complete, internally
  consistent starting point, not a substitute for that review.

## [1.7.0] — 2026-08-21

### Added

- **Network Exposure**, a twelfth check, reading Shodan's free public
  InternetDB. It reports the ports, reverse-DNS names and vulnerability
  identifiers Shodan already holds for the address a domain publishes at its
  apex. No key, no quota, one HTTPS request, measured at 330–430ms.

#### It is the only module that measures nothing

Every other check reads a public source or connects to the domain itself. This
one reads a third party's record and reports what it says, and the report is
built so those two things cannot be confused:

- Every finding states in its evidence that **Klyro did not connect** to any of
  these ports and performed no scan of the address.
- **No finding is rated at high confidence.** InternetDB publishes no crawl
  date for a record, so an entry may be from this morning or from years ago and
  the API gives no way to tell. That is a stated limitation, which is what the
  medium level means. The attributed-CVE finding is rated *low* confidence:
  those identifiers are inferred by a third party from a service banner, not
  from a test, and Klyro verifies none of them.
- Its exposure factor in the ranking formula is 0.55, below what the same ports
  observed directly would earn, because Klyro has not established that the
  weakness is still present.
- `/scanner` gains a section naming the one request that goes to Shodan rather
  than to the operator, and `/methodology` names this module as the exception
  to its own provenance claim rather than leaving the claim overstated.

#### Two decisions that keep it usable

- **Ports every host answers on are not flagged.** 80, 443, 53, the mail ports,
  and Cloudflare's 2052–2096 / 8443 / 8880 block are treated as expected.
  Without that, cloudflare.com alone produces nine findings — its record lists
  ten ports — and every Cloudflare-fronted domain in the corpus would carry an
  identical page of noise. With it, that scan produces one.
- **Only host names inside the assessed domain are named.** InternetDB returns
  every name whose reverse DNS points at an address, and on a shared address
  most belong to strangers: 1.1.1.1 comes back with a school district and a
  university, 8.8.8.8 with an unrelated marketing host. Listing those under a
  vendor's assessment would tell the reader nothing about that vendor and would
  print somebody else's internal-looking host names into a document about a
  third party. Names outside the domain are counted — the count is how you tell
  a dedicated address from a shared one — and nothing more is said about them.

#### Caching and the hourly ceiling

Shodan's record is cached in memory for an hour, keyed by address, and each
address is allowed 100 lookups an hour as a backstop. Two things about that are
worth writing down.

**The cache holds the raw record, not the finished findings.** Caching the
findings by address is the obvious version and it is wrong in a way that would
be hard to notice: the findings depend on the domain as well as the address —
which host names belong to the assessed domain and which belong to strangers —
and a CDN address serves hundreds of domains. Cache findings by address and the
second domain on a shared address inherits the first one's host-name split, so
one customer's report names another customer's hosts. What genuinely is a
property of the address is Shodan's record, so that is what is stored.
`tests/internetdb.test.ts` scores two domains on one address and asserts
neither report contains the other's names.

**An error is never cached.** A record and a "no record" are stable statements
about an address and hold for an hour; a 502 is a statement about Shodan at
that instant, and caching it would take the module out for an hour on the
strength of one bad second.

The ceiling's window is real — it resets an hour after it opens. It is also
honestly a backstop rather than a rate limiter: it is keyed by target address,
so a scan of a hundred different domains is a hundred different keys, and with
the cache in front of it reaching 100 for one address needs 100 cache misses in
an hour. Both maps are bounded at 500 entries. In-memory means per-instance and
per-deploy on Vercel, which is fine for what this is protecting against.

#### Scoring

Weight 0.08, with the eleven existing weights multiplied by 0.92 so the set
still sums to 1.0, written out as explicit constants. Category score is 100
less 25 per data-store port, 15 per remote-access port, 10 per administrative
web surface and 20 for a non-empty vulnerability list, floored at 0.

Host names carry **no** penalty, which departs from the brief. A name inside
the assessed domain resolving to its own address is the ordinary shape of a
website, and where such a name is worth flagging the Subdomain Exposure module
already finds it from certificate transparency, tiers it and scores it —
penalising it here would charge one asset to two categories. A name belonging
to somebody else on a shared address is not the assessed domain's doing at all.

### Fixed

- The cached lookup briefly called itself instead of the transport, and the
  module went on calling the uncached path — an infinite recursion that
  typechecked cleanly and that no test would have reached, because the module
  was still bypassing it. Caught by reading the call sites after the edit
  rather than by the suite.
- A domain absent from Shodan's index would have scored 0 at full weight.
  `computeComposite` filters on a category's `status` and never reads
  `moduleCoverage`, so returning a low coverage does not drop a module from the
  composite — it contributes its score at full weight anyway. The three
  no-data paths now throw, which produces a genuine `unavailable` category and
  renormalises the remaining weights. Caught by rewriting the tests to assert
  the composite that comes out rather than the field going in; the first
  version of those tests checked `moduleCoverage === 0` and passed while the
  bug was live.

### Notes

- Klyro sends one request per scan to `internetdb.shodan.io` carrying only the
  IP address. Blocking Klyro does not remove an address from Shodan, which runs
  its own scanners and publishes its own opt-out.
- The self-performed TCP port module remains withdrawn. This does not revive
  it: reading a public record is not the same act as opening a connection, and
  the disclosure keeps the two apart.

## [1.6.0] — 2026-08-21

### Added

- `/methodology` — a public companion to the scanner disclosure, written for
  technical evaluators rather than for operators reading a log line. It states
  the six fields every finding is written under and why each exists, what the
  three confidence levels mean and what follows from them, the composite
  arithmetic and the severity × confidence × exposure ranking, every public
  source each module reads, the record of findings checked against outside
  sources, and an explicit list of what Klyro does not attempt to know.
  Linked from the site footer and from `/scanner`.
- The module and weight tables on that page are rendered from `CATEGORY_ORDER`
  and `CATEGORY_WEIGHTS`, and the factor values are asserted against
  `scoring.ts` by `tests/methodology-page.test.ts`. A methodology page that
  describes arithmetic the software stopped doing is worse than none, and the
  only durable fix is to stop retyping the numbers.
- `scripts/seed-benchmark.ts`, run with `npm run seed:benchmark`. It reports
  each pool's distinct-domain count against `MIN_BENCHMARK_SAMPLES` before
  making a single request, because the pool is deduplicated by domain and a
  short pool is a dataset gap that no amount of re-seeding will close.

### Fixed

- The results header's download buttons were positioned outside the viewport.
  `ReportButton` renders a ~106px block and it was being dropped into the
  sticky header, a fixed 56px row with `items-center`; the overflow went above
  a header pinned to `top: 0`. Measured at 1920px both buttons sat at
  `top: -25px`; at 380px the first was at `top: -117px`. It now has a `compact`
  variant built to the row's height, collapsing to an overflow menu below `lg`,
  with failures rendered in an anchored `role="alert"` so a failed download
  cannot push the cluster back out of the row.
- The header's control cluster had no `shrink-0`, so a long domain in the left
  group compressed it rather than truncating itself.
- `tests/vault-dial.test.ts` asserted `CATEGORY_ORDER.length === 11` under the
  name "no second list to drift" — itself a hardcoded count. It now asserts the
  invariant: the order and the weight table describe the same set, and the
  weights partition the composite. `tests/coverage-banner.test.ts` pins the
  "N of N checks completed" banner to the module registry for the same reason.

### Withdrawn before release

- The network port exposure module built for this release is not shipping,
  pending legal review. It has been removed in full: the module, its two test
  files, the twelfth category and its weight, the PDF page, and the dashboard
  card. The eleven original weights are restored verbatim rather than
  renormalised in place, and sum to 1.0.
- The disclosure copy it required has been reverted with it. `/scanner` states
  "No port scanning" again, the landing page's boundary list matches, and all
  three footers are back to passive-only language — which is accurate for the
  eleven modules that are shipping.

## [1.5.0] — 2026-08-20

### Changed

- Landing page rebuilt: glazed surfaces, scroll-driven motion, and four new
  sections that say what the product does rather than asserting that it is
  good. `DESIGN.md` carries the reasoning, including what was taken from each
  of the three references the brief named and what was deliberately not.
- The scan panel is now glass over the guilloché rather than an opaque card.
  That is the whole argument for the material here — `backdrop-filter` over an
  opaque background is an expensive way to draw a rectangle, so the rosette
  moved behind the panel and comes through it as a wash. Fill stays high
  (0.66 dark, 0.74 light): body text on glass measures 16.1:1 and 17.4:1, the
  dimmest supporting text 5.4:1 and 5.0:1.
- The header floats and glazes once the page has scrolled under it, and is
  fully transparent at rest. A bar that is frosted from first paint is
  frosting a background that is already its own colour.

### Added

- A band of the records, headers and endpoints the checks actually read,
  running edge to edge under the hero. Every entry is traceable to a check
  module, and the test suite enforces that — a marquee of things the product
  does not read is a lie set in a nice font.
- "What a finding looks like": the four fields of a real finding, quoted
  verbatim from the email-security module, with its limitation permanently on
  screen rather than behind a tab. Shown instead of a dashboard screenshot,
  because a screenshot proves nothing about the writing and the writing is the
  product. The domain is `example.com`, the reserved documentation domain.
- "Reading the number": a draggable composite whose band, rating and colour
  come from `riskLevelFor`, `ratingFor` and `riskColorFor` — the same three
  functions that label every real assessment — so the landing page cannot
  disagree with the report.
- "What Klyro does not do", on the landing page rather than only at
  `/scanner`. It is the first question anyone senior asks about a tool that
  assesses a third party, and answering it in the footer in eleven point grey
  is answering it too quietly. Every line is pinned to the disclosure.
- `src/components/motion.tsx`: one shared IntersectionObserver, a
  pointer-tracked sheen and a scroll parallax, all rAF-coalesced and all
  yielding to `prefers-reduced-motion` in the handlers as well as in the
  stylesheet. No animation library was added, and a test asserts none appears.
- `tests/home-page.test.ts` — 39 tests pinning every claim the page makes to
  its source. It caught "the eleven checks" hardcoded in the score-band copy
  on its first run.

### Fixed

- Hero alignment. The two columns had nothing in common to line up on: the
  left began with a 10px eyebrow at y=0, the right with a panel whose first
  label sat a border and 24 points of padding lower. A rail now spans the grid
  and both columns hang from the hairline under it, sharing a top to within a
  sub-pixel at every width.
- The hero statistics were a wrapping flex row, so three figures of unequal
  width began at three arbitrary positions that moved with the copy. They are
  an equal three-column grid now.
- The checks ledger pushed each description across with `ml-[30px]`, a guess
  at the rendered width of a two-digit mono numeral plus its gap. It agreed
  with the title's left edge by coincidence and would have stopped agreeing
  the moment the mono face fell back. Both now share a grid column.
- The headline held 62px into the `lg` breakpoint, where the column splits and
  loses 40% of its measure — five lines of one-and-a-half words each in 369px.
  It steps down at `lg` and back up at `xl`.
- Section header rows aligned a 36px Didone to a 12.5px note on their
  baselines, which left the note floating at the top of a two-line block.
- The submit button's spinner was drawn in `--ground`, which inverts to
  near-white on paper and made it vanish against the gold. It follows
  `--on-seal`, the one token that does not invert.

### Notes

- Scroll reveals are gated behind a `.js` class set by the existing pre-paint
  boot script. With scripting off nothing hides — which is the failure mode a
  reveal pass usually ships with, silently.
- The PDF is untouched. It keeps its own fixed print palette, as before.

## [1.4.1] — 2026-08-20

### Fixed

- Both AI features were failing on every call. Groq had retired
  `llama-3.3-70b-versatile`, so every request returned 404 `model_not_found`.
  The summary endpoint reported it honestly and the per-finding notes degraded
  in silence, exactly as each was designed to — but the default model now names
  one that exists, and `GROQ_MODEL` remains the override for the next time a
  provider retires one.
- Token budgets were sized for a model that does not think out loud. Reasoning
  tokens count against `max_tokens` on the gpt-oss family, and at the default
  effort they consumed the entire allowance: a finding note produced 1,938
  characters of reasoning and no answer at 200, 500 and 800 tokens alike, and
  the summary returned none of its three sections at 350. Requests now send
  `reasoning_effort` (default `low`, overridable via `GROQ_REASONING_EFFORT`),
  and the budgets are set from measurement — 400 for a note, which uses 155,
  and 700 for a summary, which uses 442.
- `reasoning_effort` is dropped and the request retried once when a model
  rejects the field, and not sent again afterwards. Support is not universal —
  `qwen3.6` accepts only `none` or `default`, `groq/compound` and `allam-2-7b`
  reject it outright — so hard-coding it would have turned a working
  `GROQ_MODEL` override into a hard 400, which is the same brittleness that
  caused the outage above.
- Failures now say what went wrong. A non-2xx carries the API's own message
  rather than the bare status, so `Groq returned 404` reads `Groq returned 404:
  The model ... does not exist`; and a response that spends its budget without
  answering is reported as that, rather than as an empty completion. The
  summary button shows the reason it was already being sent — it had been
  displaying only the sentence and discarding the diagnosis.

### Notes for operators

- Do not point `GROQ_MODEL` at `groq/compound` or `groq/compound-mini`. They
  are agentic systems with built-in web search, and a model that can browse
  would introduce facts Klyro never measured — which is the one thing the
  grounding design exists to prevent.

## [1.4.0] — 2026-08-20

### Added

- Grounded context on findings. A short note, written by a language model, now
  follows the highest-priority findings on the dashboard and in the full
  report. The model is handed a closed set of facts that this scan's own
  modules produced and nothing else — no outside knowledge, no other scan, no
  fact Klyro did not measure. Where a category produced no facts, no note is
  attempted at all: a model given an empty object still writes fluent prose
  about the category in general, and general prose about a category is exactly
  the ungrounded claim this feature must never make.
- A one-page plain-language summary, as a second PDF alongside the full report.
  Three sections — the short version, the biggest thing to know, what to do
  next — written for a reader who will open it once and never open the full
  document. Generated from the same stored `ScanResult` the full report
  renders, so the two cannot contradict each other; there is one set of
  numbers and the short document is a projection of the long one.
- `POST /api/report/summary`, mirroring the full report endpoint: bound to a
  stored assessment for a signed-in caller, sanitised on the anonymous path,
  and sharing the same 30/hour ceiling rather than getting a softer one for
  being a smaller document.
- Migration 0009: `assessments.executive_summary`, cached so a second download
  costs no second model call. Writable only by the service role — enforced in
  the append-only trigger, because a column the trigger did not name would let
  an account holder write any sentence and have Klyro render it as its own
  assessment of a third party. Covered by `tests/db/executive-summary.test.ts`.

### Notes on how the AI layer fails

- Per-finding notes degrade in silence. No key configured, a timeout, a bad
  status, a model that declines — all produce the same recorded reason and no
  rendered section. A scan is never blocked, slowed past its budget, or failed
  by them.
- The summary endpoint does the opposite and fails visibly, with 503 when no
  generator is configured and 502 when generation fails. A missing note costs a
  report one paragraph among dozens; a summary document with no summary is a
  Klyro-branded page carrying a score and no explanation, which is worse than
  an honest error.
- Generation is bounded. Only the top few findings of medium severity or above
  are narrated, concurrently, inside a wall-clock budget — the scan route has
  sixty seconds and has already spent twenty to forty-five of them, so an
  unbounded pass would kill the function after the scan succeeded but before
  the result was stored.
- Set `GROQ_API_KEY` to enable both. Without it the product behaves exactly as
  it did before this release, except that the summary button reports why it
  cannot help.

## [1.3.0] — 2026-08-19

### Changed

- Visual identity rebuilt around security printing — the guilloché rosette,
  the engraved plate, the seal — rather than the near-black-and-neon register
  every tool in this category shares. One accent (a certification gold, rationed
  to the mark, the dial index and the primary action), one titling face
  (Bodoni Moda, a Didone, used only above 24px), and the existing Archivo and
  IBM Plex Mono kept for everything that is read or measured.
- The eleven checks are now indexed by a rotary dial: a CSS-3D drum that turns
  to whichever check the reader has scrolled to. It sits beside the ledger
  rather than in the hero, because eleven detents need more scroll distance
  than a hero has, and the alternatives were to autoplay it or to push the
  domain field under the fold. See `DESIGN.md`.
- Scan limit raised from 10 to 30 per hour. Ten was sized against abuse and
  never against use; a procurement reader walking a supplier list had spent it
  before lunch. Every place that states the number reads it from the constant.

### Added

- Dark and light modes, remembered in `localStorage` and following
  `prefers-color-scheme` until the visitor overrides it. A pre-paint script
  stamps the root only when a choice is stored, so there is no flash of the
  wrong theme and no hydration mismatch.
- Every colour is now a token with a value per theme. `COLORS` and
  `SEVERITY_COLORS` became `rgb(var(--token))` references, so the inline styles
  and SVG attributes throughout the dashboard follow the theme without being
  rewritten. The PDF is untouched and keeps its own fixed print palette.
- `DESIGN.md`, recording the token system and the reasoning.

### Fixed

- Severity colours are now solved against a contrast floor rather than picked,
  per theme. Every severity clears 4.5:1 in both modes, which the previous set
  did not — `info` sat at 3.60.
- Three subdomain tier styles and four technology-category dots named colours
  that were not in the theme (`bg-bad`, `bg-warn`, `bg-cyan`, `bg-good`), so
  they had been rendering with no colour at all. The tier styles are restored
  against real tokens; the category dots, which are `aria-hidden` decoration
  inside groups that already name the category, became one neutral bullet.
- The domain field had no visible keyboard focus state: `focus:outline-none`
  won the cascade over the base `:focus-visible` rule. Focus rings are now
  explicit on the field, both scan inputs, every button and the theme toggle.
- Layout shift on the hero headline. `next/font` could not find Bodoni Moda in
  its metrics table, so it emitted no size-adjusted fallback and the headline
  reflowed by 25% of its height when the webfont swapped in. The fallback face
  is now built by hand from the same numbers Next would have used.
- Primary button contrast on paper. Its foreground followed `--ground`, which
  inverts to near-white in light mode and dropped the button to 3.14:1.

## [1.2.0] — 2026-08-18

### Fixed

- Pre-scan DNS validation now catches non-existent domains before launching a
  scan, with TLD-variant suggestions (e.g. `.ae` → `.com`) for common typos.
  Existence is decided by the DNS response code, not by the presence of an A
  record: a delegated zone that publishes no address at its apex — a domain
  used only for mail, or only to redirect — exists and is assessed normally.
  Deciding it the other way would have refused real domains to catch a typo.
- The progress screen no longer appears for a domain that fails the check.
  A mistyped name gets a named answer and a one-click correction in well under
  two seconds, rather than a module list it was never going to finish.
- Low-coverage scans (no web server, WAF-blocked, unreadable DNS) now show an
  explanatory banner above the score, naming the specific reason fewer checks
  could complete rather than leaving the reader to interpret a bare number.
- Coverage is now always visible as "X of 11 checks completed", not only when
  it is low.
- Combined email authentication finding no longer overstates the gap when SPF
  `-all` is present but DMARC is absent. It now separates envelope-sender
  protection (SPF, which was working and was being denied) from visible
  From-header protection (DMARC, which is the actual gap), and recommends the
  shorter path from `-all` rather than restating work already done. Severity,
  confidence and scoring are unchanged — the gap is real, only the language
  was wrong.
- A domain that does not resolve no longer costs a scan token. The limiter
  still runs *ahead* of DNS — an unlimited path to the resolver would make
  Klyro a query relay, and that ordering is not moving — so the token is
  spent and then returned once the name is found not to exist. Deliberately
  narrow: a target refused by the SSRF screen is not refunded, because a
  refusal that is free to repeat is one an attacker can issue indefinitely.
  The refund is idempotent and silent; a limiter that is unreachable at that
  moment costs one token and changes nothing about the answer.
- Scan time estimate updated to the observed range (20–45s); the landing page
  check count is now derived from the module list rather than hardcoded, which
  is how it came to read "10" after the eleventh module was added.

## [1.1.0] — 2026-08-18

### Fixed

- Rate limiting is now persistent across Vercel instances and redeploys
  (Upstash Redis, sliding window). Falls back to the previous in-memory
  limiter when Redis credentials are not configured, which is what local
  development uses — that fallback is a supported mode, not a stub. A Redis
  call that fails at runtime falls back the same way rather than failing the
  request.
- The concurrent-scan gate is now a deployment-wide ceiling rather than a
  per-instance one, held in a Redis sorted set with a stale-entry sweep so a
  function killed mid-scan cannot consume a slot permanently. Slots are taken
  through a single Lua script, so two instances cannot both pass the check.
- Report endpoint now fetches from the stored assessment when `assessmentId`
  is provided, binding the PDF to what Klyro actually measured. The read runs
  under the caller's own credentials, so the row-level security policy on
  `assessments` decides who may render what. The anonymous path is unchanged.
- Seeding wrote only to `scan_results`, which nothing has read since migration
  0007 moved the corpus to `benchmark_samples`. Seeded vendors now reach the
  pool the benchmark is actually computed from.

### Added

- Benchmark opt-in: organisations can contribute anonymised scan scores to the
  industry comparison pool. Off by default, toggle on the organisation page,
  admin or owner only — enforced by the database policy, not by the route.
- One sample per organisation per domain per day, so a domain watched closely
  cannot stand in for a pool of peers.
- Onboarding prompt for benchmark opt-in after creating an organisation.
  Both answers dismiss it; neither blocks anything.
- "Verified report" label on the PDF download button when the report will be
  built from a saved assessment rather than from page state.
- Contribution note on the Industry Benchmark page of the PDF, shown only when
  the assessment was in fact contributed.
- `PATCH /api/org/[orgId]`, carrying exactly one writable field.
- Database tests covering who may change `benchmark_opt_in`, and covering the
  corpus the pool statistics are read from.
- This file.

### Changed

- `consumeRateLimit`, `acquireScanSlot` and `activeScanCount` are now async,
  because the shared counters live over HTTP. Every call site was already
  inside an async handler; the names and return shapes are unchanged.

### Notes for operators

- Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in production.
  Without them the deployment runs on the in-memory limiter, where the
  effective limit is the configured one multiplied by the number of warm
  instances.
- No migration is required for this release. `organisations.benchmark_opt_in`
  and `assessments.contributes_to_benchmark` already existed and were unread;
  this version reads them.

## [1.0.0]

Initial release. Eleven check modules, weighted composite scoring with
coverage renormalisation, PDF reporting, accounts and organisations with
row-level security, and a seeded benchmark corpus.
