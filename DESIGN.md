# Klyro — visual system

Recorded so the direction does not have to be re-derived. Everything here is
implemented in `src/app/globals.css` (tokens), `tailwind.config.ts` (wiring),
`src/lib/emblem.ts` (the mark) and `src/components/VaultDial.tsx`.

## The argument

Klyro's product claim is that every finding traces back to something observed.
Its visual claim should be the same one, so the identity is borrowed from the
graphic tradition built entirely around being checkable: **security printing**.

A guilloché rosette is cut by a geometric lathe. It appears on banknotes,
diplomas and share certificates for one reason — the pattern is a strict
consequence of its parameters, so a forgery that is slightly wrong is visibly
wrong. That is precisely the argument Klyro makes about a scan, and it gives
the product a register that is *premium and verifiable* rather than *technical
and alarming*.

The register being avoided is the one every competitor occupies: near-black
ground, neon cyan or lime accent, terminal typography. Klyro was already
halfway into it — the old palette's `#00E676` / `#FF3D3D` / `#00E5FF` are that
genre exactly. Leaving it was most of the work.

## Colour

Values live as **space-separated RGB channels** in CSS custom properties, one
set per theme, and reach Tailwind through `rgb(var(--token) / <alpha-value>)`.
That form is load-bearing: the codebase uses opacity modifiers
(`bg-risk-warn/25`, `border-line/40`) throughout, and a token holding `#RRGGBB`
would make every one of them silently resolve to nothing.

| role | token | dark | light |
| --- | --- | --- | --- |
| page ground | `--ground` | `#0B0E14` | `#EEF0F3` |
| card | `--panel` | `#12161E` | `#FFFFFF` |
| raised | `--raised` | `#1C222C` | `#F6F7F9` |
| hairline | `--line` | `#232A36` | `#DFE3E9` |
| hairline, strong | `--line-strong` | `#313A49` | `#C6CCD6` |
| text | `--tx` | `#EDEFF3` | `#14171C` |
| text, secondary | `--tx-2` | `#99A1B0` | `#555D6A` |
| text, tertiary | `--tx-3` | `#848B9A` | `#656D7A` |

### The seal

One accent, and the only hue in the system that is not reporting risk. It is
rationed to the things that *certify* rather than warn: the mark, the dial's
index, and the one button the page exists for.

| token | dark | light | for |
| --- | --- | --- | --- |
| `--seal` | `#C9A227` | `#A6821D` | graphic weight — rings, rules, fills |
| `--seal-ink` | `#C9A227` | `#7A6217` | the seal carrying words |
| `--seal-dim` | `#D8B44A` | `#C2A044` | hover |
| `--on-seal` | `#0B0E14` | `#14171C` | text *on* the seal |

Three of these exist because of specific failures found by measurement:

- `--seal-ink` is separate because `#A6821D` clears 3:1 (fine for a ring) but
  only 3.60:1 on white — not enough to set type in.
- `--on-seal` is the one token that does **not** invert. It first followed
  `--ground`, which flips to near-white on paper and dropped the primary button
  to **3.14:1**.
- `--seal-dim` moves *away* from the ground in both themes rather than always
  darkening. A hover that darkens gold under dark ink measured **3.65:1**.

Final seal button contrast: dark 7.99 base / 9.70 hover, light 4.99 / 7.19.

### Risk

Solved, not picked. Each value is the least-saturated point on its hue that
still clears **4.6:1** against the lightest surface it is ever drawn on,
computed per theme. This is what let the palette leave the neon register
without any severity losing legibility.

| severity | dark | light |
| --- | --- | --- |
| critical | `#D9685B` | `#C73626` |
| high | `#CD7236` | `#A9541C` |
| medium | `#AA852D` | `#8B660E` |
| low | `#5191B8` | `#2D719C` |
| info | `#848A98` | `#646C7D` |

Two severities read slightly softer than the neons they replace on a dark card
(critical 5.43 → 5.06). Against that, every severity is now above the 4.5:1
floor **in both modes**, which the previous set could not claim — `info` sat at
3.60 and three tier styles were not rendering a colour at all.

## Type

Three families, each with one job.

- **Bodoni Moda** — titling only, above ~24px. A Didone, because the genre
  being borrowed from is set in Didones: flat unbracketed serifs and extreme
  stroke contrast are the engraved-plate look directly. Its hairlines vanish at
  small sizes, so nothing below a section heading uses it.
- **Archivo** — all UI and body text. Kept, and loaded with its `wdth` axis
  exposed: `.num`, `.wide` and `.narrow` set `font-stretch` against that axis,
  so a face without it would flatten every large figure on the site without
  raising an error.
- **IBM Plex Mono** — anything that is a literal measured value: hostnames,
  scores, weights, status codes.

`next/font` could not build Bodoni's metric-matched fallback: it normalises
the family to `bodoniModa` and its bundled capsize table stores it as
`bodoniModa11pt`, so the lookup missed and it logged `Failed to find font
override values`. That is not cosmetic — with `display: swap` and no
size-adjusted fallback the browser paints Times and then reflows, and measured
on the hero headline that reflow was a **25% height jump** on the largest text
on the page. The fallback is therefore built by hand in `globals.css`, from
that table's own numbers put through the same arithmetic Next uses. Measured
again afterwards: 0%.

The wordmark is Bodoni, uppercase, `letter-spacing: 0.22em`. The 0.15em first
sketched left the five letters reading as one dark block — Bodoni's caps carry
enough internal white that they needed opening further before they separated.

## The dial

A drum of eleven faces standing on a virtual cylinder. Each face is rotated
about X by its share of 360° and pushed out along Z by the radius; rotating the
parent by the negative of any face's angle brings that face to the front. That
one multiplication is the entire mechanism — no library, no geometry.

It is driven by an `IntersectionObserver` with a thin band across the middle of
the viewport, so it advances once per check as the reader moves down the ledger
beside it, rather than thrashing at a boundary or autoplaying.

**It is not in the hero, and that was a deliberate departure.** A hero is one
viewport tall, and eleven detents need real scroll distance to land as detents
rather than as a blur. The only ways to fit them into a hero are to autoplay
the rotation — ruled out — or to make the hero tall enough to push the domain
field under the fold — also ruled out, and the more damaging of the two, since
that field is the only thing on the page anyone has to find. Below the fold
there is as much runway as the ledger is long.

The metaphor is a dial being **read**, not a lock being picked. A combination
being cracked is the attacker's side of the story; this product is sold to the
defender.

Content comes from `CATEGORY_ORDER`, `CATEGORY_LABELS`, `CATEGORY_BLURBS` and
`CATEGORY_WEIGHTS`. There is no second list.

### Degradation

The drum is the illusion; the eleven names are the content, and the ledger
carries all of them as a plain `<ol>` at every width, with no JavaScript, in
every motion setting. The drum is hidden below `lg` and under
`prefers-reduced-motion` — not reimplemented as stacked cards, because that
would be the same eleven rows twice on one screen.

## The mark

`src/lib/emblem.ts` holds the geometry; the nav mark and the hero rosette
import it. Three concentric rings whose openings step around the centre — three
*aligned* circles read as a target, which is the wrong metaphor; three offset
ones read as tumblers to be brought into line. A radial index tick at twelve
o'clock makes it an instrument with a reading.

At hero size the full rosette is drawn as 30 rotated ellipses whose edges
interfere — which is how a lathe actually produces one, and costs a few hundred
bytes instead of a sampled path with a thousand points in it.

The favicon cannot import the module, so `tests/emblem-icon.test.ts`
regenerates it and compares against `src/app/icon.svg`. If that test fails
after an intentional change, write the generated string back to the file rather
than loosening the assertion.

## Theme

Dark-first. Bare `:root` carries the complete dark palette; light is the
override, in two places:

```
:root                                    dark — also the un-stamped default
@media (prefers-color-scheme: light)
  :root:not([data-theme='dark'])         light, following the OS
:root[data-theme='light']                light, chosen explicitly
```

The `:not([data-theme='dark'])` guard is what lets an explicit dark choice beat
a light OS. Without it the toggle only works one way.

`themeBootScript` runs in `<head>` before first paint and stamps the root only
when a choice is stored — with nothing stored the stylesheet is already correct,
so server and client markup stay identical. The toggle keeps following the OS
until the visitor overrides it, after which their choice holds.

## The PDF is not a theme

`src/pdf/ReportTemplate.tsx` carries its own fixed light palette and imports no
colour from `src/lib/constants.ts`. That separation is what made this pass
cheap: `COLORS` and `SEVERITY_COLORS` could be turned from hex literals into
`rgb(var(--token))` references, which every inline style and SVG presentation
attribute in the dashboard resolves automatically — about forty colour
assignments that followed the theme without being rewritten. A printed artifact
has no mode to follow, and `var()` resolves to nothing in the renderer.

## Focus, and what the cascade did to it

Every colour pairing in this document was checked by walking the rendered DOM
and computing each element's contrast against its own effective background, in
both themes, at 1280px and 380px. That found three things taste would not have:
the primary button at 3.14:1 on paper, its hover at 3.65:1 on ink, and
`--tx-3` at 4.23:1 on a dark card. All three are fixed above.

It also found that the domain field — the one control the landing page exists
for — had **no visible keyboard focus state at all**. The base stylesheet has
always carried a `:focus-visible` outline rule, but `focus:outline-none` on the
field is a utility, and utilities beat base in Tailwind's layer order, so the
outline resolved to `2px solid transparent`. A base-layer rule is not a
guarantee; it is a default that any utility can quietly outrank.

Focus rings are therefore explicit, as `focus-visible:` utilities, on the two
scan inputs, `.field`, `.btn` (and so every variant), and the theme toggle.
They are drawn in `--seal-ink` rather than plain white so they read on paper.

## What could not be verified here

The drum's rotation is driven by an `IntersectionObserver`. In a headless
session the browser tab reports `visibilityState: "hidden"`, and a hidden tab
delivers no IntersectionObserver callbacks, no `scroll` events and no
`requestAnimationFrame` — so the scroll interaction cannot be exercised, and
switching it to a scroll listener would not change that.

What was verified instead: the drum's transform mechanism, by setting
`--dial-turn` directly and confirming that for each index the intended face
lands at maximum Z; and the arithmetic underneath it, in
`tests/vault-dial.test.ts`. The interaction itself still wants a human to look
at it once.

---

# The landing pass

A second pass over the home page, briefed as: fix the alignment, take the
liveliness of gsap.com, the material of glassmorphism and the restraint of
Apple's interfaces, and give the page more to say.

## What was pushed back on, and what replaced it

The three references do not point the same way. gsap.com is a playground —
its whole thesis is that the page itself is the demo. Apple's surfaces are
the opposite: near-silent, with one material doing all the work.
Glassmorphism as it is usually shipped is neither, it is a lilac gradient
behind a blurred card.

Taking all three literally would have produced the fourth thing, which is a
generic 2024 SaaS page, on a product whose entire pitch is that it is not
generic. So each was taken for the specific thing it is good at:

- **From gsap.com** — the *rhythm*. Sections that arrive rather than being
  already there, a rail that draws itself, a band that runs. Not the whimsy;
  a security assessment that is playful about itself is a security assessment
  nobody signs off.
- **From Apple** — the *material discipline*. One glass, one accent, one
  radius, and everything else neutral.
- **From glassmorphism** — the actual physics, which is the part usually
  skipped. See below.

## Glass, and why it is glazing here

A blurred panel over an opaque background is an expensive way to draw a
rectangle: `backdrop-filter` has nothing to filter. The effect only means
anything when something is *behind* it.

Klyro already had that something — the ruled ledger ground on `body`, and the
guilloché rosette. So the rosette moved from beside the scan form to behind
it, and the form became the pane. What comes through is lacework at 20px of
blur, which is a certificate under glass in a frame. That is the one reading
of "glassmorphism" this product could have taken without becoming a different
product.

The fill is high — 0.66 on ink, 0.74 on paper. Apple's real materials are
much more opaque than the imitations of them, and this page carries findings:
measured through the composite, body text on glass sits at 16.1:1 in dark and
17.4:1 in light, and the dimmest supporting text at 5.4:1 and 5.0:1.

| Token | Dark | Light |
| --- | --- | --- |
| `--glass` / `--glass-alpha` | `18 22 30` @ 0.66 | `255 255 255` @ 0.74 |
| `--glass-edge` @ alpha | white @ 0.10 | white @ 0.95 |
| `--sheen` @ alpha | white @ 0.07 | **seal** @ 0.13 |
| `--shade` @ alpha | `0 0 0` @ 0.55 | `78 88 108` @ 0.22 |

Two of those are not simple inversions:

- **The sheen is gold on paper.** A white specular highlight on a white pane
  is invisible. The seal is the one warm value the system owns, so the
  pointer highlight in light mode is a gold bloom.
- **The shadow is a cool grey on paper, not black.** Pure black under a white
  card reads as dirt rather than as depth.

The lit edge (`.glass::before`) is a gradient ring produced by masking a
1px-padded box against its own content box — bright at the top-left arris and
gone by 46%, which is how light actually falls on an edge, and how you get a
*partial* border without four elements.

## Alignment

This was the brief's first complaint and it had a specific cause: the hero's
two columns had nothing in common to line up on. The left column began with a
10px eyebrow at y=0. The right began with a panel whose own first label sat a
border plus 24 points of padding lower. Every attempt to fix that by nudging
one column toward the other made it worse, because the columns were being
aligned to *each other* rather than to a shared reference.

There is now a shared reference: one rail spans the full grid — eyebrow left,
summary right — closed by a hairline, and both columns start beneath it.
Measured, the headline and the scan panel now share a top to within a
sub-pixel at every width tested. No magic offsets are involved.

Three more alignment defects, all of the same family — a number standing in
for a measurement:

1. **The hero statistics** were a `flex-wrap` row with `gap-x-12`, so each
   figure was sized to its own content and "11", "20–45s" and "0" began at
   three arbitrary positions that moved whenever the copy did. They are now
   an equal three-column grid. The rules above them are the alignment device:
   three segments of equal width are what make three figures of unequal width
   read as one set.
2. **The checks ledger** pushed each description across with `ml-[30px]` — a
   guess at the rendered width of a two-digit mono numeral plus its gap. It
   agreed with the title's left edge by coincidence, and would have stopped
   agreeing the moment the mono face fell back. The row is a
   `[2.25rem_1fr_auto]` grid now, and the description shares the title's
   column.
3. **The headline steps down at `lg` and back up at `xl`**, which looks wrong
   written out and is right on screen. `lg` is where the single column splits
   in two and the headline loses 40% of its measure in one breakpoint; held
   at 62px it set five lines of one-and-a-half words each in a 369px column.

Section header rows also moved from `items-baseline` to `items-end`. Baseline
alignment between a 36px Didone and a 12.5px note puts the note's first line
on the heading's baseline and leaves it floating at the top of a two-line
block.

## Motion, and the library that was not added

Everything animated here is one `IntersectionObserver`, one `pointermove`
handler and one `scroll` handler, all rAF-coalesced, in
`src/components/motion.tsx`. That is roughly the subset of GSAP this page
would have used, at none of the weight and with no second animation runtime
to reason about alongside React's. `tests/home-page.test.ts` asserts no
animation library is in the dependency tree, so this stays a decision rather
than a drift.

The point at which a library *would* earn its place is scroll-**scrubbed**
timelines — an element whose progress is bound to scroll position rather than
merely triggered by it. Nothing here needs that. If something does later,
ScrollTrigger is the answer and this note is the reason.

Three details worth keeping:

- **One observer, not one per element.** Around thirty nodes reveal on this
  page; thirty observers is thirty sets of intersection bookkeeping per
  scroll. Each target unobserves itself on firing, because a reveal is a
  one-way door — re-animating on the way back up is what makes a page feel
  cheap.
- **The hidden state is gated on `.js`**, set by the pre-paint boot script
  that already existed for the theme. Without that gate, scripting off means
  a column of permanently invisible sections. This is the single most common
  way a scroll-reveal pass breaks a page, and it breaks it silently.
- **Reduced motion is honoured twice.** The stylesheet removes the hidden
  state outright rather than merely shortening the transition, and the sheen
  and parallax hooks check `matchMedia` themselves — they write inline
  styles, which no media query can undo.

## What was added to the page, and where it came from

The brief asked for more context. Every claim added is a copy of something
that already exists elsewhere in the tree, and `tests/home-page.test.ts` pins
each copy to its source:

| Section | Source of truth |
| --- | --- |
| Signal band | the record and header names the check modules actually read |
| How it runs | `CATEGORY_ORDER`, and the real 20–45s observed range |
| Anatomy of a finding | verbatim from `src/lib/checks/email-security.ts` |
| Reading the number | `riskLevelFor`, `ratingFor`, `riskColorFor` |
| Boundaries | the scanner disclosure at `/scanner` |

Two of these are worth expanding on.

**The finding is shown instead of a dashboard screenshot.** Every product in
this category shows a screenshot. A screenshot proves nothing about the
writing, and the writing *is* the product: Klyro's claim is that it keeps what
it measured, what that indicates, and what could follow apart from one
another, and never merges them into a single confident sentence. That is only
demonstrable by showing the four fields separately. The copy is quoted from
the module rather than written for the page, and the domain is `example.com`
— the reserved documentation domain — so the example cannot be mistaken for a
real assessment of a real company. The limitation field sits permanently
below the tabs rather than behind one, because a caveat a reader has to click
to find is a caveat the product does not really mean.

**The score bands are draggable, and derive from the scoring functions.** A
hardcoded "80+ is low risk" on a landing page is a second source of truth
that goes stale the first time the thresholds are tuned, and goes stale
silently, in the one place a prospective customer is looking. The cost is
`@/lib/scoring` in the client bundle; it is pure arithmetic over constants
with no server dependency, and the guarantee is worth the kilobytes. The
first run of the test written to enforce this caught "the eleven checks"
sitting in that section's own copy.

## Two defects found on the way

- **The severity badge failed contrast on paper.** A 10% fill of its own hue
  under the label put `risk-high` at 4.46:1 in light mode. The fix was not a
  new colour: the dashboard renders severity as coloured text with no fill,
  and matching it puts the badge at 5.11:1 *and* makes the example look like
  the product. An invented component was the bug.
- **The finding-anatomy tabs scrolled horizontally on mobile with the
  scrollbar suppressed**, hiding the fourth tab behind a gesture nothing on
  screen suggested — and the fourth tab is the recommendation. They wrap now.

Also fixed in passing: the submit button's spinner was drawn in `--ground`,
which inverts to near-white on paper and made it disappear against the gold.
It follows `--on-seal` now, the one token that does not invert.

## What could not be verified here, again

Same limitation as the first pass, and it now covers more. A headless tab
reports `visibilityState: "hidden"` and delivers no `IntersectionObserver`
callbacks, no `scroll` events and no `requestAnimationFrame` — so the scroll
reveals, the parallax, the marquee's progress and the header's glaze-on-scroll
cannot be watched here.

What was verified instead, by measurement:

- The reveal rules resolve correctly and both transitions register as
  `running` when `data-reveal="in"` is set — the mechanism is sound; only the
  trigger is unobservable.
- The header's glazed state, read with transitions disabled, resolves to the
  full glass treatment and the resting state to fully transparent.
- Layout at 375, 1013, 1280 and 1389: no horizontal overflow at any width,
  hero columns sharing a top, three stat columns on an even pitch, and the
  marquee's two runs at identical widths so `-50%` loops seamlessly.
- Contrast across both themes for every text-on-glass pair.

The feel of it — whether the reveals land at the right moment, whether the
marquee is too fast — still wants a human to look at it once.

---

# The header, and a slot that was the wrong size

The top-right controls on the results page were reported as clipped or hidden.
They were neither. `ReportButton` renders a ~106px block — two buttons on a
row, then a caption explaining how the summary relates to the full report — and
it was being passed straight into the results header's `actions` slot, which is
a fixed 56px row (`h-14`) with `items-center`. Centring a 106px child in a 56px
box overflows 25px in each direction, and the top 25px of a header pinned to
`top: 0` is off the screen.

Measured before the fix:

| Viewport | "Download report" | Visible |
| --- | --- | --- |
| 1920px | `top: -25px`, `bottom: 17px` | 17 of 42px |
| 380px | `top: -117px`, `bottom: -56px` | none |

Three plausible causes were checked and ruled out, because each would have led
somewhere different: nothing in the header chain had `overflow: hidden`,
nothing was absolutely positioned, and no stacking context was involved — the
vault dial's `transform-style: preserve-3d` is on the landing page and never
shares a document with this header. The bug was reusing a full-size block in a
slot sized for a single control, which is why it looked like three different
bugs depending on the width it was seen at.

`ReportButton` now has two variants. `full` is unchanged and stays in the
section. `compact` is built to the height of the row it lives in: fixed 34px
controls, no captions, `shrink-0`, and an overflow menu below `lg`.

Two decisions inside that are worth recording:

- **The theme toggle stays out of the menu.** The brief grouped it with the two
  downloads. It is 58×30 and still fits beside the wordmark at 380px, and
  putting a two-state control behind a menu makes it harder to reach on exactly
  the screens where people flip it most. What does not fit is two labelled
  download buttons, so those are what collapse.
- **Failures are anchored, not in flow.** A paragraph rendered in the cluster
  would push it back out of a fixed-height header the moment a download failed
  — the original bug, reappearing only after something else had already gone
  wrong. Errors render in an absolutely positioned `role="alert"` instead.

Verified at 1920 / 1440 / 1024 / 768 / 380 in both themes, on the production
build as well as in dev: every control sits inside the 0–56px row, no
horizontal overflow, menu items at 7.1:1 dark and 6.4:1 light. The menu answers
Escape by closing and returning focus to its trigger, moves focus to the first
item on open, cycles with arrows, and closes on outside click. Header tab order
is wordmark → downloads → theme toggle → section rail.

# A claim with nothing holding it up

A module was built for this release that opened TCP connections to a fixed list
of ports. It has been withdrawn pending legal review, and the code is gone —
but one thing it exposed is worth keeping, because it will recur.

`/scanner` said, verbatim, "No port scanning. Only HTTP and HTTPS on their
standard ports." The landing page repeated it. Three separate footers — site,
results page, and the PDF's own disclaimer — said "No systems are accessed,
scanned for vulnerabilities, or tested."

All four became false the moment the module landed, and **the entire test suite
stayed green**, because nothing tied those sentences to the code they
described. A product whose single claim is that it never asserts more than it
observed had started doing something its own disclosure denied, and no
automated check noticed.

The module is gone and the copy is accurate again. The lesson is not: a
promise about behaviour needs the same treatment as a number about behaviour.
The landing page's check count is pinned to `CATEGORY_ORDER`; the coverage
banner is pinned to the module registry; the methodology page's weights and
factor tables are pinned to `scoring.ts`. The boundary claims deserve the same
kind of tie, and the next module that crosses one should fail a test rather
than a reading.

---

# Hierarchy, spent where the meaning is

A pass over the results dashboard and the landing page, briefed against a
specific complaint: every card carried the same padding, the same border, the
same type size, so a critical finding and an info observation were
distinguishable only by a small colour change, and the eye had nowhere to
land. Read literally, "add hierarchy" is instructions to make some things
bigger. Read correctly, it is instructions to make the *page's own severity
model* — which already exists in `scoring.ts` and the `Severity` type — show
up as physical space instead of stopping at a colour. Everything below is one
rule applied in three places, not three separate decisions.

**The rule.** Visual weight tracks what the number or the severity already
says, never an editorial judgement layered on top. A category at 32 is bigger
than one at 95 because `riskColorFor` already called it `bad`; a critical
finding is louder than an info one because `SEVERITY_ORDER` already ranks it
first. Nothing here introduces a second scale — every threshold used below
already existed in `scoring.ts` or `constants.ts` before this pass, and is
imported rather than restated.

## A third elevation level, spent on one thing at a time

The system already had three steps on the neutral ramp — `--ground`,
`--panel`, `--raised` — but `--raised` was doing double duty as both "a card
worth more attention" and "the hover state of an ordinary row," which is why
nothing on the page read as more important than anything else: the one token
that could have carried emphasis was busy being a hover effect.

`.panel-elevated` (`globals.css`) claims `--raised` for the first job
exclusively — a stronger hairline (`--line-strong` instead of `--line`) and a
real cast shadow in place of `panel`'s 1px inset — and it is used in exactly
one place on the results dashboard: the composite score. Not the severity
ledger beside it, not a category card, not a finding. One elevated object per
screen is the point; a second one would have cancelled the first the same way
the old uniform padding did. The findings register gets its own loud
treatment lower down, and deliberately does *not* reach for this class — see
below.

`.readout` is the second new primitive: a recessed surface (inset shadow, on
`--ground`) for a value rather than a container — a hostname, a score, a
status code. Nothing currently ships in it, but it exists for the next place
a raw measurement needs to read as an instrument reading rather than a slot
a card fills.

The body ground also gained a fourth background layer: a `feTurbulence` grain
tile, alpha capped at 2% *inside the SVG filter itself* rather than as a CSS
opacity on the layer, because `background-image` has no per-layer opacity —
only the element does, and the element already carries three other layers.
It is the cheapest lever against "flat" there is: it costs one more
`background-image` entry and changes nothing else.

## The score, made to be the loudest thing on the screen

`ScoreMeter`'s figure grew from `clamp(76px, 12vw, 124px)` to
`clamp(96px, 15vw, 168px)` — at 1920px it now sets at its full 168px, where it
previously topped out at 124px regardless of viewport. It sits inside the new
`.panel-elevated`, with the coverage line ("12 of 12 checks completed") folded
inside the same surface rather than left as a caption below it, because how
much of the domain the number is based on is part of reading the number, not
a footnote to it. The risk band was already inside `ScoreMeter` itself and
needed no change — it was already adjacent, just easy to miss beside a
smaller figure.

The severity ledger stays on `.panel`, not `.panel-elevated`, on purpose. It
is real information and earns a normal card; it does not earn the one surface
reserved for the single object the whole page is about.

## The category matrix responds to the data instead of a template

`CheckMatrix` already sorted checks by points lost rather than by name, which
was already better than twelve identical cards — but every row still rendered
at the same height regardless of what it had to say. `EXPAND_BELOW = 80`
(matching `riskColorFor`'s own "good" cut, so the row's size and its colour
never disagree) now splits rows in two:

- **Below 80, or `unavailable`** — larger type (15px vs 13.5px), more padding,
  and the row's worst finding surfaced inline as a second line, positioned by
  `col-start-2 col-span-4` on the same grid the header uses rather than a
  guessed indent (the same lesson `ml-[30px]` taught on the landing page's
  checks ledger, applied here before it could repeat).
- **80 and above** — the original compact single line, made slightly quieter
  by contrast rather than by any change of its own.

A check that scored below the line but raised no severity finding above
`info` (a coverage shortfall rather than a weakness — `technologies` scoring
71 with an empty findings list, in one live scan checked during this pass)
still gets the larger type and padding without a second line. That is
correct rather than an edge case slipping through: the row is still saying
"look here," just without a specific finding to quote.

## The findings register, read at three densities

The single biggest change. The previous `FindingsTable` was one `<table>`
where severity was a difference of a few pixels of coloured text — a domain
with one critical finding and fourteen low-severity ones rendered as fifteen
visually identical rows.

Severity now buys space, in three tiers:

- **Critical and high** render as individual elevated cards — a 3px coloured
  left edge, a ~5% tint of the same hue behind the whole card, and the
  largest title type in the register (15.5px). Deliberately *not*
  `.panel-elevated`: that class is reserved for the one object per screen
  described above, and a findings list can carry several loud cards at once
  without contradicting it. The distinction is real: elevation says "the one
  thing this page is about," a tinted edge says "pay attention to this one
  among several."
- **Medium** renders at the weight the entire table used to render at —
  unchanged, because medium was already the right default; only the
  extremes needed to move.
- **Low and info** collapse into one row — "N low-severity observations" —
  behind a single click, at the highest density in the register (12px type,
  2px vertical padding). Filtering to exactly `Low` or `Info` opens the group
  automatically, because a reader who asked for those severities specifically
  asked to see them, and the collapse is a default for the *unfiltered*
  register, not a rule about the severities themselves.

**What this cost, and why it was worth it.** The previous table's
column-sort control (severity / finding / check, each independently
sortable) is gone. Once severity is the layout rather than a column, a
"sorted by title, ignoring severity" view no longer makes sense to offer —
it would be a control that actively undoes the hierarchy the rest of the
component just built. The severity filter chips stay, and are still the way
to see one tier in isolation.

Inside `FindingDetail`, the same rule reaches one level deeper: the
"cannot establish" limitation line — previously styled identically to every
other evidence row — is now the one line in the whole component set in
italic tertiary ink (`quiet` prop on `EvidenceRow`). Observed and
Recommendation were already primary ink, Interpretation and Risk already
secondary; the limitation is the only field that describes a boundary rather
than a fact, and it is now the only one that reads like a caveat.

## Motion, orchestrated once and then reused

The results dashboard's entrance is four `animate-rise` calls at increasing
delay — summary (20ms), priority actions (75ms), the check matrix (130ms),
the findings register (190ms) — rather than a scroll-triggered reveal, since
the whole dashboard is already in the viewport the moment it mounts. `.stagger`
(30ms per row, already used for the priority-findings list) now also drives
`ScanProgress`'s module list on its own mount, and a completed or failed
module's score cell remounts on its own status change (`key={module.status}`)
so it replays the same rise animation exactly once, at the moment a reader's
eye is already on that row because it just changed.

A new `.stagger-lg` (55ms per step, `globals.css`) exists for future
page-level sequences with a handful of large sections rather than many short
rows — `.stagger`'s 30ms steps are tuned for the latter and would make a
four-section sequence feel sluggish rather than crisp.

**A real gap this pass found and closed, not introduced by it.** The
reduced-motion block zeroed `animation-duration` and `transition-duration`
but never `animation-delay` — so an element staggered 190ms out still opened
at its animation's `0%` state (`opacity: 0`) and sat invisible for that whole
delay before an now-instant animation played. `[data-reveal]` was already
immune, because its reduced-motion override drops the hidden state outright
rather than trusting the animation timeline at all. Every `.stagger` /
`.stagger-lg` / `animate-rise` usage — including the ones already shipping
before this pass — was not. `animation-delay: 0s !important` closes it for
all of them at once, in the same universal selector that already zeroes
duration.

## The landing page: mostly already there

Read against the brief's four asks — a dominant hero input, a live stat
strip, the checks presented densely with real weights, a sample finding shown
in full, a validation strip — the first four were already built in an earlier
pass (`Hero`, the stat grid, `SignalBand` + the checks ledger, `FindingAnatomy`).
The one gap was the validation strip. `ValidationStrip` (`components/home/`)
quotes three rows — one "held up," two "Klyro was wrong" — from the same
`VALIDATIONS` array `/methodology`'s "Track record" table reads, pulled out to
`src/lib/validations.ts` so neither page can drift from the other; both kinds
of outcome are shown on purpose, for the same reason the methodology page
lists both. `tests/home-page.test.ts` pins the import, not a copy.

**Withdrawn, and the code is gone with it** — the same call made about the
port-exposure module earlier in this document, for the same reason: a landing
page is not the room to volunteer the times the product was wrong. That
argument belongs to `/methodology`, read by someone already deciding whether
to trust the output, not to the front door every visitor lands on first.
`ValidationStrip.tsx` is deleted rather than left importable-but-unused.
`src/lib/validations.ts` stays — `/methodology`'s own Track record table
reads from it and always did — so the extraction that let the two pages share
one array was not wasted, only the landing page's use of it.

---

# The sheen, removed

The pointer-tracked specular highlight (`useSheen`, `.sheen`, the four glazed
surfaces it sat on — the scan form, the three how-it-works cards, the finding
anatomy panel, the closing CTA) is gone. It read as a hover glow rather than
as glass catching light, which was the opposite of the effect it was built
for. `useSheen` is deleted from `motion.tsx` rather than left unused, the
`.sheen` rules and the `--sheen` / `--sheen-alpha` tokens are gone from
`globals.css` in all three theme blocks, and every panel that carried the
class now reads `glass` alone — the blur, the lit edge and the cast shadow
are what the material actually was; the pointer-follow was the one part of it
that had turned into decoration. `tests/home-page.test.ts`'s reduced-motion
guard count drops from two handlers to the one (`useParallax`) still writing
an inline style outside the `[data-reveal]` mechanism.

---

# Network exposure gets its own section

The port findings from Shodan InternetDB were readable but not *findable* —
one combined finding ("Shodan records administrative ports as open on this
address: 22, 3389") sitting in the risk register next to twenty-two others,
and a matrix row that, after the earlier expansion fix, surfaced that same
sentence inline. Both were technically present; neither read as its own
place to look, the way Subdomains, Technology and Inventory do. `Network
Exposure` (`NetworkExposure.tsx`) is now a section of its own, in the rail
between Technology and Inventory — mirroring `internetdb`'s own position at
the tail of `CATEGORY_ORDER` — with each notable port as its own row rather
than folded into one sentence.

**Why the port tables moved to their own file.** `internetdb.ts` (the check
module) imports `dnsQuery` and `safeFetch` from `./util`, which reach for
Node's `dns` module and server-only network primitives. `NetworkExposure.tsx`
is a `'use client'` component — importing `classifyPort` or `serviceFor`
directly from `internetdb.ts` would have pulled the whole module, Node
built-ins included, into the browser bundle. `CRITICAL_PORTS` /
`REMOTE_PORTS` / `ADMIN_WEB_PORTS` / `EXPECTED_PORTS` / `classifyPort` /
`serviceFor` moved to `src/lib/checks/ports.ts`, which has no I/O and no
server-only dependency; `internetdb.ts` now imports them from there and
re-exports them for anything still reaching for them through the module
(its own test file does). One table, read by both sides, instead of the
dashboard keeping a second copy to drift from the module's.

The section reads `category.facts` — typed now as `InternetDbFacts`, exported
from `internetdb.ts` as a type. A type-only import is erased before anything
ships to the browser, so naming the shape where it is produced costs the
client bundle nothing, and `NetworkExposure.tsx` and the module cannot
silently disagree about what `facts` contains the way an inline `Record<string,
unknown>` cast on both ends could.

It renders only when `internetdb`'s status is `'assessed'`. The unavailable
cases — no A record, a reserved address, no Shodan record, a transport error
— are left to the check matrix's own row, which already states which one
applies; duplicating that here would be a second place for the explanation
to go stale against the first.
