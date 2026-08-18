/* eslint-disable jsx-a11y/alt-text */
import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
  Svg,
  Rect,
  Circle,
  Path,
  Line,
} from '@react-pdf/renderer';

import {
  CATEGORY_BLURBS,
  CATEGORY_ORDER,
  MIN_BENCHMARK_SAMPLES,
  TOOL_VERSION,
} from '@/lib/constants';
import { benchmarkSentence, ordinal } from '@/lib/benchmark';
import { executiveHighlights, prioritise, ratingFor, weightPercent } from '@/lib/scoring';
import type {
  BenchmarkResult,
  CategoryResult,
  ConcernLevel,
  RelationshipAssessment,
  RiskTier,
  ScanResult,
  Severity,
  SubdomainResult,
} from '@/lib/types';
import type { NewsIntelligence } from '@/lib/intel/types';

/*
 * Host names, URLs and header values are never hyphenated.
 *
 * The default hyphenation broke evidence text across lines mid-token, so a
 * report said `static-stag-\ning.cloudflareinsights.co` and
 * `cloudflarein-\nsights.com`. In a security report the exact host name is
 * often the whole point of the finding, and a reader copying one of those out
 * of the PDF copies a name that does not exist. Ordinary prose still
 * hyphenates; anything carrying a dot, slash or colon is kept whole.
 */
Font.registerHyphenationCallback((word) => {
  if (!/[./:]/.test(word)) return [word];

  // A long URL still has to break somewhere. After a slash is the one place a
  // break cannot invent a different name, so long paths break there and host
  // names — which have no slash — stay in one piece.
  if (word.length > 48) {
    const parts = word.split(/(?<=\/)/g);
    if (parts.length > 1) return parts;
  }

  return [word];
});

/* ------------------------------------------------------------------ *
 * Palette — print-oriented: white paper, navy structure, cyan accents.
 * ------------------------------------------------------------------ */

const C = {
  navy: '#0A0E1A',
  slate: '#3B455C',
  muted: '#6B7590',
  hairline: '#DDE3EE',
  cyan: '#00A6C0',
  cyanLight: '#E1F7FB',
  good: '#00874A',
  goodBg: '#E6F6EE',
  warn: '#B37400',
  warnBg: '#FFF4E0',
  bad: '#C62222',
  badBg: '#FDEAEA',
  paper: '#FFFFFF',
  panel: '#F7F9FC',
} as const;

function toneFor(score: number): { fg: string; bg: string } {
  if (score >= 80) return { fg: C.good, bg: C.goodBg };
  if (score >= 60) return { fg: C.warn, bg: C.warnBg };
  return { fg: C.bad, bg: C.badBg };
}

/** How many discovered hosts landed in a given tier. */
function tierCount(hosts: SubdomainResult[], tier: RiskTier): number {
  return hosts.filter((h) => h.riskTier === tier).length;
}

const SEVERITY_STYLE: Record<Severity, { fg: string; bg: string; label: string }> = {
  critical: { fg: C.bad, bg: C.badBg, label: 'Critical' },
  high: { fg: '#C2410C', bg: '#FEEDE3', label: 'High' },
  medium: { fg: C.warn, bg: C.warnBg, label: 'Medium' },
  low: { fg: '#1C6FA8', bg: '#E7F1F9', label: 'Low' },
  info: { fg: C.muted, bg: '#F0F2F6', label: 'Info' },
};

/* ------------------------------------------------------------------ */

const s = StyleSheet.create({
  page: {
    backgroundColor: C.paper,
    paddingTop: 46,
    paddingBottom: 56,
    paddingHorizontal: 46,
    fontFamily: 'Helvetica',
    fontSize: 9.5,
    color: C.slate,
    // NOTE: do not set `lineHeight` here. An inherited lineHeight on the Page
    // stops absolutely-positioned `fixed` children (the footer) from being
    // laid out at all, so paragraph spacing is declared per text style below.
  },

  /* header / footer */
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    borderBottomWidth: 2,
    borderBottomColor: C.cyan,
    paddingBottom: 8,
    marginBottom: 20,
  },
  wordmark: { fontFamily: 'Helvetica-Bold', fontSize: 17, color: C.navy, letterSpacing: 1.2 },
  wordmarkSub: { fontSize: 8, color: C.muted, letterSpacing: 1.6, marginTop: 2 },
  headerMeta: { fontSize: 8, color: C.muted, textAlign: 'right' },
  footer: {
    position: 'absolute',
    bottom: 26,
    left: 46,
    right: 46,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: C.hairline,
    paddingTop: 7,
    fontSize: 7.5,
    color: C.muted,
  },

  /* typography */
  h1: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 20,
    lineHeight: 1.25,
    color: C.navy,
    marginBottom: 10,
  },
  h2: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
    lineHeight: 1.3,
    color: C.navy,
    marginBottom: 8,
    marginTop: 4,
  },
  eyebrow: {
    fontSize: 7.5,
    color: C.cyan,
    letterSpacing: 1.4,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 5,
  },
  body: { fontSize: 9.5, lineHeight: 1.55, color: C.slate, marginBottom: 8 },
  mono: { fontFamily: 'Courier', fontSize: 8.5, color: C.navy },

  /* panels */
  panel: {
    backgroundColor: C.panel,
    borderLeftWidth: 3,
    borderLeftColor: C.cyan,
    padding: 12,
    marginBottom: 14,
  },
  /** Paragraph text inside a panel. lineHeight must live on Text, not View. */
  panelBody: { fontSize: 9.5, lineHeight: 1.5, color: C.navy },

  /* subject block */
  subjectGrid: { flexDirection: 'row', marginBottom: 18, flexWrap: 'wrap' },
  subjectCell: { width: '25%', paddingRight: 10, marginBottom: 8 },
  subjectLabel: { fontSize: 7, color: C.muted, letterSpacing: 0.8, marginBottom: 2 },
  subjectValue: { fontSize: 10, color: C.navy, fontFamily: 'Helvetica-Bold' },

  /* score hero */
  hero: { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
  heroRight: { flex: 1, paddingLeft: 24 },
  riskPill: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 2,
    marginBottom: 8,
  },
  riskPillText: { fontSize: 10, fontFamily: 'Helvetica-Bold' },

  /* bullets */
  bullet: { flexDirection: 'row', marginBottom: 7 },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: C.cyan,
    marginTop: 4.5,
    marginRight: 8,
  },
  bulletText: { flex: 1, fontSize: 9.5, lineHeight: 1.5, color: C.slate },

  /* tables */
  table: { borderTopWidth: 1, borderTopColor: C.navy, marginTop: 4 },
  th: {
    flexDirection: 'row',
    backgroundColor: C.navy,
    paddingVertical: 6,
    paddingHorizontal: 7,
  },
  thText: {
    fontSize: 7.5,
    color: '#FFFFFF',
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.6,
  },
  tr: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: C.hairline,
    paddingVertical: 7,
    paddingHorizontal: 7,
  },
  trAlt: { backgroundColor: '#FAFBFD' },
  td: { fontSize: 8.5, lineHeight: 1.45, color: C.slate },
  tdStrong: { fontSize: 8.5, lineHeight: 1.35, color: C.navy, fontFamily: 'Helvetica-Bold' },

  scoreChip: {
    paddingVertical: 2,
    paddingHorizontal: 5,
    borderRadius: 2,
    alignSelf: 'flex-start',
  },
  scoreChipText: { fontSize: 8.5, fontFamily: 'Helvetica-Bold' },

  sevChip: {
    paddingVertical: 2,
    paddingHorizontal: 5,
    borderRadius: 2,
    alignSelf: 'flex-start',
  },
  sevChipText: { fontSize: 7.5, fontFamily: 'Helvetica-Bold' },

  /* findings — one block per finding rather than a table row, because the
     four-part structure does not fit in a column and squeezing it there is how
     the interpretation ends up standing in for the observation */
  findingBlock: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 0.5,
    borderTopColor: C.hairline,
  },
  findingHead: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 3 },
  findingTitle: {
    flex: 1,
    marginLeft: 6,
    fontSize: 9.5,
    lineHeight: 1.3,
    color: C.navy,
    fontFamily: 'Helvetica-Bold',
  },
  findingMeta: { fontSize: 7, color: C.muted, marginBottom: 4 },

  /* informational observations — listed rather than blocked out, because they
     carry no score impact and mostly record what the assessment could not see */
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 6,
    paddingTop: 5,
    borderTopWidth: 0.5,
    borderTopColor: C.hairline,
  },
  infoTitle: { fontSize: 8.5, lineHeight: 1.3, color: C.navy, fontFamily: 'Helvetica-Bold' },
  infoBody: { flex: 1, marginLeft: 6 },
  infoObserved: { fontSize: 7.5, lineHeight: 1.4, color: C.slate, marginTop: 1.5 },
  infoMeta: { fontSize: 6.5, color: C.muted, marginTop: 1.5 },
  findingField: { flexDirection: 'row', marginBottom: 2.5 },
  findingFieldLabel: {
    // Wide enough for RECOMMENDED ACTION, the longest label, which was being
    // hyphenated into "RECOMMENDED AC- TION" at 84.
    width: 96,
    fontSize: 6.5,
    letterSpacing: 0.5,
    color: C.muted,
    fontFamily: 'Helvetica-Bold',
    paddingTop: 0.5,
  },
  findingFieldValue: { flex: 1, fontSize: 8, lineHeight: 1.45, color: C.slate },

  /* chart */
  chartRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  chartLabel: { width: 120, fontSize: 9, color: C.navy },
  chartValue: { width: 30, fontSize: 9, fontFamily: 'Helvetica-Bold', textAlign: 'right' },

  /* methodology */
  methodItem: { flexDirection: 'row', marginBottom: 4 },
  methodKey: {
    width: 128,
    fontSize: 8.5,
    lineHeight: 1.4,
    color: C.navy,
    fontFamily: 'Helvetica-Bold',
  },
  methodVal: { flex: 1, fontSize: 8.5, lineHeight: 1.4, color: C.slate },

  disclaimer: {
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.hairline,
    padding: 12,
    marginTop: 14,
  },
});

/* ------------------------------------------------------------------ *
 * SVG helpers
 * ------------------------------------------------------------------ */

/** Arc path for the donut gauge, drawn clockwise from 12 o'clock. */
function arcPath(cx: number, cy: number, r: number, fraction: number): string {
  const clamped = Math.max(0.0001, Math.min(0.9999, fraction));
  const angle = clamped * Math.PI * 2;
  const endX = cx + r * Math.sin(angle);
  const endY = cy - r * Math.cos(angle);
  const largeArc = clamped > 0.5 ? 1 : 0;
  return `M ${cx} ${cy - r} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY}`;
}

function ScoreDonut({ score, size = 132 }: { score: number; size?: number }) {
  const tone = toneFor(score);
  const r = size / 2 - 11;
  const cx = size / 2;
  const cy = size / 2;

  return (
    <View style={{ width: size, height: size, position: 'relative' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle cx={cx} cy={cy} r={r} stroke={C.hairline} strokeWidth={11} fill="none" />
        <Path
          d={arcPath(cx, cy, r, score / 100)}
          stroke={tone.fg}
          strokeWidth={11}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            fontSize: 38,
            lineHeight: 1,
            fontFamily: 'Helvetica-Bold',
            color: C.navy,
          }}
        >
          {score}
        </Text>
        <Text style={{ fontSize: 7.5, lineHeight: 1.2, color: C.muted, letterSpacing: 1, marginTop: 4 }}>
          OUT OF 100
        </Text>
      </View>
    </View>
  );
}

function BarChart({
  rows,
  width = 320,
}: {
  rows: { label: string; value: number; color: string }[];
  width?: number;
}) {
  const barHeight = 16;
  return (
    <View>
      {rows.map((row) => (
        <View key={row.label} style={s.chartRow}>
          <Text style={s.chartLabel}>{row.label}</Text>
          <Svg width={width} height={barHeight}>
            <Rect x={0} y={0} width={width} height={barHeight} fill={C.panel} />
            <Rect
              x={0}
              y={0}
              width={Math.max(1, (row.value / 100) * width)}
              height={barHeight}
              fill={row.color}
            />
            <Line x1={0} y1={barHeight} x2={width} y2={barHeight} stroke={C.hairline} strokeWidth={1} />
          </Svg>
          <Text style={{ ...s.chartValue, color: row.color }}> {row.value}</Text>
        </View>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

/** One labelled line of a finding block. */
function FindingField({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.findingField}>
      <Text style={s.findingFieldLabel}>{label}</Text>
      <Text style={s.findingFieldValue}>{value}</Text>
    </View>
  );
}

function Header({ domain, title }: { domain: string; title: string }) {
  return (
    <View style={s.headerRow} fixed>
      <View>
        <Text style={s.wordmark}>KLYRO</Text>
        <Text style={s.wordmarkSub}>EXTERNAL EXPOSURE ASSESSMENT</Text>
      </View>
      <View>
        <Text style={s.headerMeta}>{title}</Text>
        <Text style={{ ...s.headerMeta, fontFamily: 'Courier', color: C.navy }}>{domain}</Text>
      </View>
    </View>
  );
}

function Footer({ domain, scannedAt }: { domain: string; scannedAt: string }) {
  return (
    <View style={s.footer} fixed>
      <Text>
        Klyro v{TOOL_VERSION} · {domain} · {new Date(scannedAt).toISOString().slice(0, 10)}
      </Text>
      <Text
        render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Plain-English explanations per category
 * ------------------------------------------------------------------ */

/**
 * One sentence per category for a non-technical reader.
 *
 * Third person throughout, and phrased as what was or was not observed. The
 * subject of a Klyro assessment is usually a supplier under evaluation rather
 * than the reader's own estate, so "your email can be spoofed" was addressing
 * the wrong party — and it asserted an outcome the check does not establish.
 * These describe the measurement; the findings carry the reasoning.
 */
/**
 * Names which registry locks are set, from the score breakdown lines the
 * registration module publishes. Falls back to a neutral sentence when the
 * registry published no status codes at all.
 */
function registrationLockSentence(category: CategoryResult): string {
  const lines = category.scoreBreakdown ?? [];
  const held = (label: string) => {
    const line = lines.find((l) => l.label === label);
    return line ? { assessed: line.assessed, set: line.value > 0 } : null;
  };

  const transfer = held('Transfer lock');
  const update = held('Update lock');
  const del = held('Deletion lock');

  if (!transfer || !transfer.assessed) {
    return 'The registry publishes no status codes for this domain, so its lock state could not be read.';
  }

  const set = [
    transfer.set ? 'transfer' : null,
    update?.set ? 'update' : null,
    del?.set ? 'deletion' : null,
  ].filter(Boolean) as string[];

  if (set.length === 3) return 'Transfer, update and deletion locks are all enabled at the registry.';
  if (set.length === 0) return 'No transfer, update or deletion lock is enabled at the registry.';
  return `${set.join(' and ')} lock${set.length === 1 ? ' is' : 's are'} enabled at the registry; the ${
    ['transfer', 'update', 'deletion'].filter((l) => !set.includes(l)).join(' and ')
  } lock${3 - set.length === 1 ? ' is' : 's are'} not.`;
}

function plainExplanation(category: CategoryResult): string {
  if (category.status === 'unavailable') {
    return 'This area could not be checked because a public data source did not respond. It was excluded from the score rather than counted against the domain.';
  }

  const good = category.score >= 80;

  switch (category.key) {
    case 'emailSecurity':
      return good
        ? 'The domain publishes email authentication records that instruct receiving servers to reject messages failing authentication.'
        : 'The published email authentication records stop short of instructing receiving servers to reject messages that fail authentication.';
    case 'ssl':
      return good
        ? 'A valid, current certificate is in place and the server negotiates modern encryption.'
        : 'The certificate or the encryption settings on this domain need attention — see the findings for which.';
    case 'dns':
      return good
        ? 'The domain records are published with the protections that make them harder to tamper with and easier to keep resolving.'
        : 'The domain records are missing hardening measures such as signing, issuance restriction, or nameserver redundancy.';
    case 'headers':
      return good
        ? 'The site instructs visiting browsers to switch on their built-in protections.'
        : 'The site is not sending some of the response headers that switch on browser-level protections.';
    case 'subdomains':
      return good
        ? 'The host names attached to this domain in public certificate records carry no naming that suggests internal or non-production systems.'
        : 'Public certificate records contain host names whose naming suggests internal or non-production systems, and those names resolve today.';
    case 'exposedPaths':
      return good
        ? 'No administrative or developer path was content-confirmed as reachable from the internet.'
        : 'One or more administrative or developer paths were content-confirmed as answering requests from the internet.';
    case 'whois':
      /*
       * The one category where a clean result deserves to be named rather than
       * summarised. "Strong" tells a reader nothing about which of the three
       * registry locks is actually set, and the difference between one lock
       * and three is the difference between a domain that can be repointed
       * through a registrar account and one that cannot.
       *
       * Built from the score breakdown rather than from `facts`, because the
       * breakdown survives the report payload sanitiser and `facts` does not.
       */
      return `${registrationLockSentence(category)} ${
        good
          ? 'The registration is also well within its term and its contact details are not published.'
          : 'Remaining term or contact privacy still need attention — see the findings.'
      }`;
    case 'cookies':
      return good
        ? 'The cookies issued before sign-in carry their protective attributes.'
        : 'Some cookies issued before sign-in are missing protective attributes.';
    case 'cors':
      return good
        ? 'The site root does not permit other websites to read authenticated responses from it.'
        : 'The site root permits other websites to read its responses under conditions worth reviewing.';
    case 'robotsSecurity':
      return good
        ? 'A route for reporting security issues is published, and the public metadata files reveal nothing unexpected.'
        : 'There is no published route for reporting a vulnerability, or the public metadata files name paths worth reviewing.';
    default:
      return category.summary;
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

export interface OwnershipReportContext {
  known: boolean;
  vendor?: {
    display_name: string;
    legal_name: string | null;
    ownership_type: string;
    parent_name: string | null;
    ultimate_parent_name: string | null;
    ownership_source: string | null;
    ownership_confidence: string;
    lei: string | null;
  };
  assessment?: {
    linkage_verdict: string;
    vendor_score: number | null;
    parent_score: number | null;
    narrative: string;
    evidence: {
      signals?: { label: string; shared: boolean | null; vendorValue: string; parentValue: string }[];
    };
  } | null;
}

export interface ReportProps {
  result: ScanResult;
  benchmark: BenchmarkResult | null;
  news?: NewsIntelligence | null;
  ownership?: OwnershipReportContext | null;
  /** Present only when the reader supplied their own domain for comparison. */
  relationship?: RelationshipAssessment | null;
  /**
   * True when the organisation this assessment was filed under contributes to
   * the shared corpus. Stated in the report because a reader comparing against
   * a benchmark is entitled to know whether this assessment is also in it.
   */
  contributesToBenchmark?: boolean;
}

const CONCERN_STYLE: Record<ConcernLevel, { fg: string; bg: string; label: string }> = {
  high: { fg: C.bad, bg: C.badBg, label: 'Act on this' },
  medium: { fg: C.warn, bg: C.warnBg, label: 'Raise it' },
  low: { fg: '#1C6FA8', bg: '#E7F1F9', label: 'Note it' },
  note: { fg: C.muted, bg: '#F0F2F6', label: 'Your side' },
};

const LINKAGE_LABEL: Record<string, string> = {
  integrated: 'Runs on parent infrastructure',
  partially_integrated: 'Partly on parent infrastructure',
  independent: 'Operates independent infrastructure',
  unknown: 'Linkage could not be established',
};

const VERIFICATION_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
  corroborated: { fg: C.good, bg: C.goodBg, label: 'Corroborated' },
  'single-source': { fg: C.warn, bg: C.warnBg, label: 'Single source' },
  'vendor-issued': { fg: C.muted, bg: '#F0F2F6', label: 'Vendor-issued' },
};

export function ReportTemplate({
  result,
  benchmark,
  news,
  ownership,
  relationship,
  contributesToBenchmark = false,
}: ReportProps) {
  const hasOwnership = Boolean(ownership?.known && ownership.vendor?.parent_name);
  const highlights = executiveHighlights(result);
  const tone = toneFor(result.compositeScore);
  const scannedDate = new Date(result.scannedAt);

  // Section numbers are derived rather than written in, because two of the
  // sections are conditional and a hardcoded "SECTION 03" goes wrong the first
  // time one of them is absent.
  // Structured module output. Both sections are conditional: a scan whose
  // subdomain or technology module failed prints neither rather than an empty
  // page claiming nothing was found.
  const subdomains =
    result.categories.find((c) => c.key === 'subdomains')?.payload?.subdomains ?? [];
  const technologyProfile =
    result.categories.find((c) => c.key === 'technologies')?.payload?.technologyProfile ?? null;

  // Only the top two tiers reach the PDF. The dashboard carries every host;
  // a printed report listing eighty is a directory, not an assessment.
  const upperTierHosts = subdomains
    .filter((h) => h.riskTier === 'critical' || h.riskTier === 'high')
    .slice(0, 22);

  const sectionIds = [
    ...(relationship ? ['relationship'] : []),
    'breakdown',
    ...(subdomains.length > 0 ? ['subdomains'] : []),
    ...(technologyProfile ? ['technology'] : []),
    'benchmark',
    'findings',
    ...(result.inventory ? ['inventory'] : []),
    ...(news ? ['news'] : []),
    'methodology',
  ];
  const sectionNo = (id: string) => String(sectionIds.indexOf(id) + 1).padStart(2, '0');

  // Ranked by severity × confidence × exposure. The factors are printed with
  // each item so a reader can check the ordering rather than take it.
  const ranked = prioritise(result.findings, 5);

  const ordered = CATEGORY_ORDER.map((key) => result.categories.find((c) => c.key === key)).filter(
    (c): c is CategoryResult => Boolean(c),
  );

  const materialFindings = result.findings.filter((f) => f.severity !== 'info');
  // Each finding is a block rather than a row now, so fewer fit before the
  // section stops being readable. The dashboard carries the full register.
  const findingsForTable = materialFindings.slice(0, 14);

  /*
   * Informational findings are separated from the scored ones, not discarded.
   *
   * They used to be filtered out of the report entirely and nothing said so,
   * which meant the dashboard showed ten findings and the PDF described four.
   * Worse, most of them are the scope statements — "cookie review covers the
   * pre-login response only", "cross-origin review covers the site root only"
   * — so the artefact that leaves the building was the one missing the limits
   * on its own claims. They are listed compactly rather than blocked out in
   * full: they carry no score impact and their observation is the whole point.
   */
  const infoFindings = result.findings.filter((f) => f.severity === 'info');
  const infoForList = infoFindings.slice(0, 12);

  return (
    <Document
      title={`Klyro External Exposure Assessment — ${result.domain}`}
      author="Klyro"
      subject={`External exposure assessment for ${result.domain}`}
      creator="Klyro"
      producer="Klyro"
    >
      {/* ---------------- Page 1 — Executive Summary ---------------- */}
      <Page size="A4" style={s.page}>
        <Header domain={result.domain} title="Executive Summary" />

        <Text style={s.eyebrow}>EXECUTIVE SUMMARY</Text>
        <Text style={s.h1}>External Exposure Assessment</Text>
        <Text style={{ ...s.body, marginBottom: 16 }}>
          This report summarises what an outsider can learn about {result.domain} using only
          publicly available information — the same starting point an attacker would use.
        </Text>

        <View style={s.subjectGrid}>
          <View style={s.subjectCell}>
            <Text style={s.subjectLabel}>DOMAIN</Text>
            <Text style={s.subjectValue}>{result.domain}</Text>
          </View>
          <View style={s.subjectCell}>
            <Text style={s.subjectLabel}>INDUSTRY</Text>
            <Text style={s.subjectValue}>{result.industry}</Text>
          </View>
          <View style={s.subjectCell}>
            <Text style={s.subjectLabel}>REGION</Text>
            <Text style={s.subjectValue}>{result.region}</Text>
          </View>
          <View style={s.subjectCell}>
            <Text style={s.subjectLabel}>ASSESSED</Text>
            <Text style={s.subjectValue}>
              {scannedDate.toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </Text>
          </View>
        </View>

        <View style={s.hero}>
          <ScoreDonut score={result.compositeScore} />
          <View style={s.heroRight}>
            <View style={{ ...s.riskPill, backgroundColor: tone.bg }}>
              <Text style={{ ...s.riskPillText, color: tone.fg }}>{result.riskLevel.toUpperCase()}</Text>
            </View>
            <Text style={{ fontSize: 10, color: C.slate, lineHeight: 1.6 }}>
              Klyro assessed {ordered.filter((c) => c.status === 'assessed').length} categories of
              public exposure across DNS, certificates, email authentication, web configuration and
              domain registration. The composite score weights each category by the practical damage
              a weakness there would cause.
            </Text>
          </View>
        </View>

        <Text style={s.h2}>What matters most</Text>
        {ranked.length > 0 ? (
          <View style={{ marginBottom: 14 }}>
            <Text style={{ fontSize: 7.5, color: C.muted, lineHeight: 1.5, marginBottom: 6 }}>
              Ranked by severity × confidence × exposure. The arithmetic is printed with each item,
              so a finding inferred from a host name cannot outrank one read out of a DNS record.
            </Text>
            {ranked.map(({ finding, rank, priority, rationale }) => (
              <View key={finding.id} style={{ marginBottom: 8 }}>
                <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: C.navy }}>
                  {String(rank).padStart(2, '0')} · {finding.title}
                </Text>
                <Text style={{ fontSize: 8, lineHeight: 1.45, color: C.slate, marginTop: 1.5 }}>
                  {finding.risk}
                </Text>
                <Text style={{ fontSize: 6.5, lineHeight: 1.4, color: C.muted, marginTop: 1.5 }}>
                  RANKED {priority}/100 — {rationale}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={{ marginBottom: 14 }}>
            {highlights.map((line, i) => (
              <View key={i} style={s.bullet}>
                <View style={s.bulletDot} />
                <Text style={s.bulletText}>{line}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={s.panel}>
          <Text style={{ fontSize: 7.5, color: C.cyan, letterSpacing: 1.2, fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>
            BENCHMARK
          </Text>
          <Text style={s.panelBody}>{benchmarkSentence(benchmark, result.compositeScore, result.domain)}</Text>
        </View>

        <View style={{ flexDirection: 'row', marginTop: 2 }}>
          {(['critical', 'high', 'medium', 'low'] as Severity[]).map((sev) => {
            const count = materialFindings.filter((f) => f.severity === sev).length;
            const style = SEVERITY_STYLE[sev];
            return (
              <View
                key={sev}
                style={{
                  flex: 1,
                  backgroundColor: style.bg,
                  paddingVertical: 8,
                  paddingHorizontal: 10,
                  marginRight: sev === 'low' ? 0 : 8,
                }}
              >
                <Text style={{ fontSize: 18, fontFamily: 'Helvetica-Bold', color: style.fg }}>
                  {count}
                </Text>
                <Text style={{ fontSize: 7.5, color: style.fg, letterSpacing: 0.8 }}>
                  {style.label.toUpperCase()}
                </Text>
              </View>
            );
          })}
        </View>

        <Footer domain={result.domain} scannedAt={result.scannedAt} />
      </Page>

      {/* ---------------- Your exposure through this vendor ----------------
           First section after the summary, because a reader who supplied their
           own domain is deciding whether to sign rather than fixing this
           estate. Reported, never scored — the composite above belongs to the
           domain it was measured on. */}
      {relationship && (
        <Page size="A4" style={s.page}>
          <Header domain={result.domain} title="Your Exposure" />

          <Text style={s.eyebrow}>SECTION {sectionNo('relationship')}</Text>
          <Text style={{ ...s.h1, fontSize: 16 }}>
            What This Vendor Means For {relationship.yourDomain}
          </Text>
          <Text style={s.body}>
            {relationship.yourDomain} was assessed with the same {CATEGORY_ORDER.length} checks, then compared against{' '}
            {relationship.vendorDomain}. This section reports where the vendor falls short of the
            standard you already hold yourself to, and which upstream providers the two of you would
            lose at the same moment.
          </Text>

          {/* Two scores side by side: the section only exists because they differ. */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              borderWidth: 1,
              borderColor: C.hairline,
              padding: 14,
              marginBottom: 14,
            }}
          >
            {[
              { label: 'YOUR SCORE', value: relationship.yourScore, domain: relationship.yourDomain },
              {
                label: 'THIS VENDOR',
                value: relationship.vendorScore,
                domain: relationship.vendorDomain,
              },
            ].map((stat, i) => (
              <View key={stat.label} style={{ width: 130, marginLeft: i === 1 ? 22 : 0 }}>
                <Text
                  style={{ fontSize: 26, fontFamily: 'Helvetica-Bold', color: toneFor(stat.value).fg }}
                >
                  {stat.value}
                </Text>
                <Text style={{ fontSize: 6.5, color: C.muted, letterSpacing: 0.8, marginTop: 2 }}>
                  {stat.label}
                </Text>
                <Text style={{ fontSize: 7, fontFamily: 'Courier', color: C.slate, marginTop: 2 }}>
                  {stat.domain}
                </Text>
              </View>
            ))}

            <View style={{ flex: 1, paddingLeft: 18 }}>
              <Text style={{ fontSize: 10, lineHeight: 1.45, color: C.navy, fontFamily: 'Helvetica-Bold' }}>
                {relationship.headline}
              </Text>
              {relationship.sharedDependencies.length > 0 && (
                <Text style={{ fontSize: 8, color: C.muted, marginTop: 5 }}>
                  Shared upstream:{' '}
                  {relationship.sharedDependencies
                    .map((d) => `${d.label.toLowerCase()} (${d.provider})`)
                    .join(' · ')}
                </Text>
              )}
            </View>
          </View>

          <View style={s.panel}>
            <Text style={s.panelBody}>{relationship.narrative}</Text>
            {relationship.yourCoverage < 0.999 && (
              <Text style={{ fontSize: 8.5, lineHeight: 1.45, color: C.warn, marginTop: 6 }}>
                {Math.round(relationship.yourCoverage * 100)}% of the scoring weight could be
                assessed on {relationship.yourDomain}. Checks that could not be measured on both
                domains are excluded from the comparison entirely rather than counted either way.
              </Text>
            )}
          </View>

          {relationship.concerns.length > 0 && (
            <>
              <Text style={s.h2}>Carry these into the conversation</Text>
              <View style={s.table}>
                <View style={s.th} fixed>
                  <Text style={{ ...s.thText, width: '12%' }}>PRIORITY</Text>
                  <Text style={{ ...s.thText, width: '26%' }}>CONCERN</Text>
                  <Text style={{ ...s.thText, width: '34%' }}>WHAT IT MEANS FOR YOU</Text>
                  <Text style={{ ...s.thText, width: '28%' }}>WHAT TO DO</Text>
                </View>

                {relationship.concerns.map((concern, i) => {
                  const style = CONCERN_STYLE[concern.level];
                  return (
                    <View
                      key={concern.id}
                      style={i % 2 === 1 ? { ...s.tr, ...s.trAlt } : s.tr}
                      wrap={false}
                    >
                      <View style={{ width: '12%', paddingRight: 5 }}>
                        <View style={{ ...s.sevChip, backgroundColor: style.bg }}>
                          <Text style={{ ...s.sevChipText, color: style.fg, fontSize: 6.5 }}>
                            {style.label}
                          </Text>
                        </View>
                      </View>
                      <Text style={{ ...s.tdStrong, width: '26%', paddingRight: 6 }}>
                        {concern.title}
                      </Text>
                      <Text style={{ ...s.td, width: '34%', paddingRight: 6 }}>{concern.detail}</Text>
                      <Text style={{ ...s.td, width: '28%' }}>{concern.watchFor}</Text>
                    </View>
                  );
                })}
              </View>
            </>
          )}

          {relationship.gaps.length > 0 && (
            <>
              <Text style={{ ...s.h2, marginTop: 16 }}>Where the two of you diverge</Text>
              <View style={s.table}>
                <View style={s.th}>
                  <Text style={{ ...s.thText, width: '46%' }}>CHECK</Text>
                  <Text style={{ ...s.thText, width: '18%' }}>YOU</Text>
                  <Text style={{ ...s.thText, width: '18%' }}>VENDOR</Text>
                  <Text style={{ ...s.thText, width: '18%' }}>DIFFERENCE</Text>
                </View>
                {relationship.gaps.map((gap, i) => (
                  <View
                    key={gap.key}
                    style={i % 2 === 1 ? { ...s.tr, ...s.trAlt } : s.tr}
                    wrap={false}
                  >
                    <Text style={{ ...s.tdStrong, width: '46%' }}>{gap.label}</Text>
                    <Text
                      style={{ ...s.td, width: '18%', color: toneFor(gap.yourScore).fg }}
                    >
                      {gap.yourScore}
                    </Text>
                    <Text
                      style={{ ...s.td, width: '18%', color: toneFor(gap.vendorScore).fg }}
                    >
                      {gap.vendorScore}
                    </Text>
                    <Text
                      style={{
                        ...s.td,
                        width: '18%',
                        fontFamily: 'Helvetica-Bold',
                        color: gap.delta > 0 ? C.bad : C.muted,
                      }}
                    >
                      {gap.delta > 0 ? `−${gap.delta}` : `+${Math.abs(gap.delta)}`}
                    </Text>
                  </View>
                ))}
              </View>
              <Text style={{ fontSize: 7.5, color: C.muted, marginTop: 6 }}>
                Difference is stated from the vendor&apos;s side: a negative number is how far they
                sit behind you on that check. Only differences of 20 points or more are listed.
              </Text>
            </>
          )}

          <View style={{ ...s.disclaimer, marginTop: 16 }} wrap={false}>
            <Text style={{ fontFamily: 'Helvetica-Bold', color: C.navy, fontSize: 9, marginBottom: 4 }}>
              What this comparison cannot see
            </Text>
            {relationship.limits.map((limit, i) => (
              <View key={i} style={{ flexDirection: 'row', marginBottom: 3 }}>
                <Text style={{ fontSize: 8, color: C.muted, marginRight: 5 }}>·</Text>
                <Text style={{ fontSize: 8, lineHeight: 1.45, color: C.slate, flex: 1 }}>{limit}</Text>
              </View>
            ))}
          </View>

          <Footer domain={result.domain} scannedAt={result.scannedAt} />
        </Page>
      )}

      {/* ---------------- Page 2 — Score Breakdown ---------------- */}
      <Page size="A4" style={s.page}>
        <Header domain={result.domain} title="Score Breakdown" />

        <Text style={s.eyebrow}>SECTION {sectionNo('breakdown')}</Text>
        <Text style={{ ...s.h1, fontSize: 16 }}>Score Breakdown</Text>
        <Text style={s.body}>
          Each category is scored out of 100 and weighted according to how much real-world risk it
          carries. Explanations below are written for a non-technical reader.
        </Text>

        <View style={s.table}>
          <View style={s.th}>
            <Text style={{ ...s.thText, width: '26%' }}>CATEGORY</Text>
            <Text style={{ ...s.thText, width: '10%' }}>SCORE</Text>
            <Text style={{ ...s.thText, width: '13%' }}>RATING</Text>
            <Text style={{ ...s.thText, width: '51%' }}>WHAT THIS MEANS</Text>
          </View>

          {ordered.map((category, i) => {
            const t = toneFor(category.score);
            const unavailable = category.status === 'unavailable';
            return (
              <View key={category.key} style={i % 2 === 1 ? { ...s.tr, ...s.trAlt } : s.tr} wrap={false}>
                <View style={{ width: '26%', paddingRight: 6 }}>
                  <Text style={s.tdStrong}>{category.label}</Text>
                  <Text style={{ fontSize: 7, color: C.muted }}>
                    weight {weightPercent(category.key)}
                  </Text>
                </View>
                <View style={{ width: '10%' }}>
                  {unavailable ? (
                    <Text style={{ ...s.td, color: C.muted }}>n/a</Text>
                  ) : (
                    <View style={{ ...s.scoreChip, backgroundColor: t.bg }}>
                      <Text style={{ ...s.scoreChipText, color: t.fg }}>{category.score}</Text>
                    </View>
                  )}
                </View>
                <Text
                  style={{
                    ...s.td,
                    width: '13%',
                    color: unavailable ? C.muted : t.fg,
                    fontFamily: 'Helvetica-Bold',
                  }}
                >
                  {unavailable ? 'Not assessed' : ratingFor(category.score)}
                </Text>
                <Text style={{ ...s.td, width: '51%', paddingRight: 2 }}>
                  {plainExplanation(category)}
                </Text>
              </View>
            );
          })}
        </View>

        <View style={{ ...s.panel, marginTop: 18 }}>
          <Text style={{ fontSize: 9, lineHeight: 1.5, color: C.slate }}>
            <Text style={{ fontFamily: 'Helvetica-Bold', color: C.navy }}>How the composite is built: </Text>
            each assessed category contributes its score multiplied by the weight shown above.
            {result.coverage < 0.999
              ? ` ${Math.round(result.coverage * 100)}% of the total weighting could be assessed in this run; the remaining categories were excluded and the weights renormalised, so an unavailable data source never reduces the score.`
              : ` All ${ordered.length} categories were assessed in this run.`}
          </Text>
        </View>

        {hasOwnership && ownership?.vendor && (
          <View wrap={false}>
            <Text style={{ ...s.h2, marginTop: 14 }}>Corporate ownership</Text>
            <View
              style={{
                borderWidth: 1,
                borderColor: C.hairline,
                borderLeftWidth: 3,
                borderLeftColor: C.navy,
                padding: 12,
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={{ fontSize: 11, fontFamily: 'Helvetica-Bold', color: C.navy }}>
                    Part of {ownership.vendor.parent_name}
                  </Text>
                  <Text style={{ fontSize: 8, color: C.muted, marginTop: 2 }}>
                    {ownership.vendor.legal_name ? `${ownership.vendor.legal_name} · ` : ''}
                    recorded as {ownership.vendor.ownership_type.replace('_', ' ')} · ownership{' '}
                    {ownership.vendor.ownership_confidence}
                    {ownership.vendor.lei ? ` · LEI ${ownership.vendor.lei}` : ''}
                  </Text>
                </View>

                {ownership.assessment?.parent_score != null &&
                  ownership.assessment?.vendor_score != null && (
                    <View style={{ flexDirection: 'row' }}>
                      {[
                        { label: 'THIS VENDOR', value: ownership.assessment.vendor_score },
                        { label: 'PARENT', value: ownership.assessment.parent_score },
                      ].map((stat, i) => (
                        <View key={stat.label} style={{ marginLeft: i === 1 ? 14 : 0, alignItems: 'flex-end' }}>
                          <Text
                            style={{
                              fontSize: 15,
                              fontFamily: 'Helvetica-Bold',
                              color: toneFor(stat.value).fg,
                            }}
                          >
                            {stat.value}
                          </Text>
                          <Text style={{ fontSize: 6.5, color: C.muted, letterSpacing: 0.6 }}>
                            {stat.label}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
              </View>

              {ownership.assessment && (
                <>
                  <Text
                    style={{
                      fontSize: 7.5,
                      fontFamily: 'Helvetica-Bold',
                      color: C.cyan,
                      letterSpacing: 0.8,
                      marginBottom: 4,
                    }}
                  >
                    {(LINKAGE_LABEL[ownership.assessment.linkage_verdict] ?? '').toUpperCase()}
                  </Text>
                  <Text style={{ fontSize: 8.5, lineHeight: 1.5, color: C.slate }}>
                    {ownership.assessment.narrative}
                  </Text>

                  {(ownership.assessment.evidence?.signals ?? []).length > 0 && (
                    <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: C.hairline, paddingTop: 6 }}>
                      {(ownership.assessment.evidence.signals ?? []).map((sig) => (
                        <View key={sig.label} style={{ flexDirection: 'row', marginBottom: 2 }}>
                          <Text style={{ width: '26%', fontSize: 7.5, color: C.navy }}>{sig.label}</Text>
                          <Text style={{ width: '32%', fontSize: 7, fontFamily: 'Courier', color: C.slate }}>
                            {sig.vendorValue}
                          </Text>
                          <Text style={{ width: '32%', fontSize: 7, fontFamily: 'Courier', color: C.muted }}>
                            {sig.parentValue}
                          </Text>
                          <Text
                            style={{
                              width: '10%',
                              fontSize: 7.5,
                              fontFamily: 'Helvetica-Bold',
                              color: sig.shared ? C.good : C.muted,
                            }}
                          >
                            {sig.shared ? 'shared' : 'separate'}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </>
              )}

              <Text style={{ fontSize: 7, color: C.muted, marginTop: 8 }}>
                Ownership is reported as context, not as credit. The parent&apos;s reputation is
                never applied to this vendor&apos;s score — only the infrastructure overlap measured
                above is treated as evidence.
                {ownership.vendor.ownership_source
                  ? ` Sourced from ${ownership.vendor.ownership_source}.`
                  : ''}
              </Text>
            </View>
          </View>
        )}

        <Footer domain={result.domain} scannedAt={result.scannedAt} />
      </Page>

      {/* ---------------- Subdomain Exposure ----------------
           Only the upper tiers print. The counts line states the whole estate
           so the reader can see what was left out rather than assuming the
           table is the estate. */}
      {subdomains.length > 0 && (
        <Page size="A4" style={s.page}>
          <Header domain={result.domain} title="Subdomain Exposure" />

          <Text style={s.eyebrow}>SECTION {sectionNo('subdomains')}</Text>
          <Text style={{ ...s.h1, fontSize: 16 }}>Subdomain Exposure</Text>
          <Text style={s.body}>
            Klyro discovered {subdomains.length} resolving host name
            {subdomains.length === 1 ? '' : 's'} for {result.domain} through public certificate
            transparency logs.{' '}
            {upperTierHosts.length === 0
              ? 'None of them returned anything placing it in the critical or high tier.'
              : `${tierCount(subdomains, 'critical')} fell into the critical tier and ${tierCount(subdomains, 'high')} into the high tier. Those are listed below; the remainder appear in the dashboard.`}
          </Text>

          {upperTierHosts.length === 0 ? (
            <View style={{ ...s.panel, marginTop: 14 }}>
              <Text style={{ fontSize: 9.5, lineHeight: 1.5, color: C.slate }}>
                No high-risk subdomains were identified. The host names that resolve are consistent
                with ordinary public-facing services, and none of the responses identified
                administrative, build or database software.
              </Text>
            </View>
          ) : (
            <View style={s.table}>
              <View style={s.th}>
                <Text style={{ ...s.thText, width: '30%' }}>HOSTNAME</Text>
                <Text style={{ ...s.thText, width: '9%' }}>STATUS</Text>
                <Text style={{ ...s.thText, width: '15%' }}>PLATFORM</Text>
                <Text style={{ ...s.thText, width: '11%' }}>TIER</Text>
                <Text style={{ ...s.thText, width: '35%' }}>WHAT WAS OBSERVED</Text>
              </View>

              {upperTierHosts.map((host, i) => {
                const style = SEVERITY_STYLE[host.riskTier];
                return (
                  <View
                    key={host.hostname}
                    style={i % 2 === 1 ? { ...s.tr, ...s.trAlt } : s.tr}
                    wrap={false}
                  >
                    <Text style={{ ...s.td, width: '30%', paddingRight: 6, fontSize: 8 }}>
                      {host.hostname}
                    </Text>
                    <Text style={{ ...s.td, width: '9%' }}>
                      {host.statusCode ?? (host.unreachableReason === 'timed-out' ? 'timeout' : '—')}
                    </Text>
                    <Text style={{ ...s.td, width: '15%', paddingRight: 4, fontSize: 8 }}>
                      {host.detectedPlatform
                        ? host.platformConfirmed
                          ? host.detectedPlatform
                          : `${host.detectedPlatform} (unconfirmed)`
                        : 'Not identified'}
                    </Text>
                    <View style={{ width: '11%' }}>
                      <View style={{ ...s.scoreChip, backgroundColor: style.bg }}>
                        <Text style={{ ...s.scoreChipText, color: style.fg }}>{style.label}</Text>
                      </View>
                    </View>
                    <Text style={{ ...s.td, width: '35%', paddingRight: 2, fontSize: 8 }}>
                      {host.riskReason}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}

          <View style={{ ...s.panel, marginTop: 16 }}>
            <Text style={{ fontSize: 8.5, lineHeight: 1.5, color: C.slate }}>
              <Text style={{ fontFamily: 'Helvetica-Bold', color: C.navy }}>How this was measured: </Text>
              each host received at most one GET to its root, with redirects unfollowed and the
              response read up to 8KB. Software names come from what the response published about
              itself — a page title, an asset path, a cookie name or a header — all of which can be
              edited, proxied or removed. Klyro did not authenticate to any of these systems, so a
              host described as reachable is not a host described as unprotected. A wildcard
              certificate may cover additional subdomains that never appear in public certificate
              logs, so this list is incomplete by an unknown amount.
            </Text>
          </View>
        </Page>
      )}

      {/* ---------------- Technology Profile ---------------- */}
      {technologyProfile && (
        <Page size="A4" style={s.page}>
          <Header domain={result.domain} title="Technology Profile" />

          <Text style={s.eyebrow}>SECTION {sectionNo('technology')}</Text>
          <Text style={{ ...s.h1, fontSize: 16 }}>Technology Profile</Text>
          <Text style={s.body}>
            What {result.domain} declares about the software it runs, and which outside companies
            supply code to its home page. Everything here was read from one response plus the
            domain&rsquo;s own DNS records.
          </Text>

          <View style={{ flexDirection: 'row', marginTop: 14 }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={s.h2}>Infrastructure</Text>
              {[
                ['Web server', technologyProfile.webServer],
                ['CDN or edge', technologyProfile.cdn],
                ['Hosting', technologyProfile.hostingProvider],
                ['Email provider', technologyProfile.emailProvider],
              ].map(([label, value]) => (
                <View
                  key={label as string}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    borderBottomWidth: 1,
                    borderBottomColor: C.hairline,
                    paddingVertical: 5,
                  }}
                >
                  <Text style={{ fontSize: 8.5, color: C.muted }}>{label}</Text>
                  <Text style={{ fontSize: 8.5, color: C.navy, fontFamily: 'Helvetica-Bold' }}>
                    {value || 'Not stated'}
                  </Text>
                </View>
              ))}
            </View>

            <View style={{ flex: 1, paddingLeft: 10 }}>
              <Text style={s.h2}>Application</Text>
              {[
                ['Framework', technologyProfile.applicationFramework],
                ['JavaScript', technologyProfile.jsFramework],
                ['Styling', technologyProfile.cssFramework],
                [
                  'Versions published',
                  technologyProfile.versionsDisclosed.length
                    ? technologyProfile.versionsDisclosed
                        .map((v) => `${v.name} ${v.version}`)
                        .join(', ')
                    : 'None',
                ],
              ].map(([label, value]) => (
                <View
                  key={label as string}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    borderBottomWidth: 1,
                    borderBottomColor: C.hairline,
                    paddingVertical: 5,
                  }}
                >
                  <Text style={{ fontSize: 8.5, color: C.muted }}>{label}</Text>
                  <Text
                    style={{
                      fontSize: 8.5,
                      color: C.navy,
                      fontFamily: 'Helvetica-Bold',
                      maxWidth: '65%',
                      textAlign: 'right',
                    }}
                  >
                    {value || 'Not stated'}
                  </Text>
                </View>
              ))}
            </View>
          </View>

          <Text style={{ ...s.h2, marginTop: 16 }}>Third-party integrations</Text>
          {(
            [
              ['Analytics', technologyProfile.analytics],
              ['Marketing', technologyProfile.marketing],
              ['Payment', technologyProfile.payment],
              ['Customer support', technologyProfile.customerSupport],
              ['Security', technologyProfile.security],
              ['From DNS records', technologyProfile.otherServices],
            ] as [string, string[]][]
          )
            .filter(([, items]) => items.length > 0)
            .map(([label, items]) => (
              <View
                key={label}
                style={{
                  flexDirection: 'row',
                  borderBottomWidth: 1,
                  borderBottomColor: C.hairline,
                  paddingVertical: 5,
                }}
              >
                <Text style={{ fontSize: 8.5, color: C.muted, width: '25%' }}>{label}</Text>
                <Text style={{ fontSize: 8.5, color: C.slate, width: '75%' }}>
                  {[...new Set(items)].join(', ')}
                </Text>
              </View>
            ))}

          {technologyProfile.thirdPartyScriptHosts.length > 0 && (
            <View
              style={{
                marginTop: 16,
                borderWidth: 1,
                borderColor: C.hairline,
                borderLeftWidth: 3,
                borderLeftColor: C.cyan,
                padding: 12,
              }}
            >
              <Text style={{ fontSize: 10, fontFamily: 'Helvetica-Bold', color: C.navy }}>
                {technologyProfile.thirdPartyScriptHosts.length} external host
                {technologyProfile.thirdPartyScriptHosts.length === 1 ? '' : 's'} supply code to
                this site
              </Text>
              <Text style={{ fontSize: 9, lineHeight: 1.5, color: C.slate, marginTop: 5 }}>
                In plain terms: this website loads code from{' '}
                {technologyProfile.thirdPartyScriptHosts.length} different external{' '}
                {technologyProfile.thirdPartyScriptHosts.length === 1 ? 'company' : 'companies'}. If
                any one of them is compromised, what runs in a visitor&rsquo;s browser on this
                domain changes — without this site being breached at all. That is the mechanism
                behind card-skimming incidents where the retailer was never touched. Klyro assessed
                none of these suppliers, and their presence is not itself a fault.
              </Text>
              <Text style={{ fontSize: 7.5, color: C.muted, marginTop: 6 }}>
                {technologyProfile.thirdPartyScriptHosts.slice(0, 18).join(' · ')}
                {technologyProfile.thirdPartyScriptHosts.length > 18
                  ? ` · +${technologyProfile.thirdPartyScriptHosts.length - 18} more`
                  : ''}
              </Text>
            </View>
          )}

          <View style={{ ...s.panel, marginTop: 14 }}>
            <Text style={{ fontSize: 8.5, lineHeight: 1.5, color: C.slate }}>
              <Text style={{ fontFamily: 'Helvetica-Bold', color: C.navy }}>Limits: </Text>
              {technologyProfile.limits.join(' ')}
            </Text>
          </View>
        </Page>
      )}

      {/* ---------------- Page 3 — Industry Benchmark ---------------- */}
      <Page size="A4" style={s.page}>
        <Header domain={result.domain} title="Industry Benchmark" />

        <Text style={s.eyebrow}>SECTION {sectionNo('benchmark')}</Text>
        <Text style={{ ...s.h1, fontSize: 16 }}>Industry Benchmark</Text>
        <Text style={s.body}>
          This domain compared against other {result.industry} domains assessed by Klyro
          {benchmark && benchmark.scope === 'industry-region' ? ` in ${result.region}` : ''}.
        </Text>

        {benchmark && benchmark.totalScans > 0 ? (
          <>
            <View style={{ marginTop: 10, marginBottom: 8 }}>
              <BarChart
                rows={[
                  { label: 'This domain', value: result.compositeScore, color: toneFor(result.compositeScore).fg },
                  { label: 'Industry average', value: benchmark.industryAverage, color: C.cyan },
                  { label: 'Industry best', value: benchmark.industryBest, color: C.navy },
                ]}
              />
            </View>

            <View style={s.panel}>
              <Text
                style={{
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: C.navy,
                  fontFamily: 'Helvetica-Bold',
                  marginBottom: 4,
                }}
              >
                {benchmark.percentileRank !== null
                  ? `You rank in the ${ordinal(benchmark.percentileRank)} percentile of ${benchmark.industry} domains assessed by Klyro in ${benchmark.region}.`
                  : 'No percentile ranking — the comparison pool is too small to rank against.'}
              </Text>
              <Text style={{ fontSize: 9, lineHeight: 1.5, color: C.slate }}>
                {benchmarkSentence(benchmark, result.compositeScore, result.domain)}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', marginBottom: 16 }}>
              {[
                { label: 'PEER DOMAINS', value: String(benchmark.totalScans) },
                { label: 'MEDIAN', value: String(benchmark.industryMedian) },
                { label: 'AVERAGE', value: String(benchmark.industryAverage) },
                { label: 'BEST', value: String(benchmark.industryBest) },
              ].map((stat, i) => (
                <View
                  key={stat.label}
                  style={{
                    flex: 1,
                    borderWidth: 1,
                    borderColor: C.hairline,
                    padding: 10,
                    marginRight: i === 3 ? 0 : 8,
                  }}
                >
                  <Text style={{ fontSize: 16, fontFamily: 'Helvetica-Bold', color: C.navy }}>
                    {stat.value}
                  </Text>
                  <Text style={{ fontSize: 7, color: C.muted, letterSpacing: 0.8 }}>{stat.label}</Text>
                </View>
              ))}
            </View>

            {Object.keys(benchmark.categoryAverages).length > 0 && (
              <>
                <Text style={s.h2}>Category comparison</Text>
                <View style={s.table}>
                  <View style={s.th}>
                    <Text style={{ ...s.thText, width: '40%' }}>CATEGORY</Text>
                    <Text style={{ ...s.thText, width: '20%' }}>YOUR SCORE</Text>
                    <Text style={{ ...s.thText, width: '20%' }}>PEER AVERAGE</Text>
                    <Text style={{ ...s.thText, width: '20%' }}>DIFFERENCE</Text>
                  </View>
                  {ordered
                    .filter((c) => c.status === 'assessed' && benchmark.categoryAverages[c.key] !== undefined)
                    .map((category, i) => {
                      const peer = benchmark.categoryAverages[category.key];
                      const delta = category.score - peer;
                      return (
                        <View
                          key={category.key}
                          style={i % 2 === 1 ? { ...s.tr, ...s.trAlt } : s.tr}
                          wrap={false}
                        >
                          <Text style={{ ...s.tdStrong, width: '40%' }}>{category.label}</Text>
                          <Text style={{ ...s.td, width: '20%' }}>{category.score}</Text>
                          <Text style={{ ...s.td, width: '20%' }}>{peer}</Text>
                          <Text
                            style={{
                              ...s.td,
                              width: '20%',
                              color: delta > 0 ? C.good : delta < 0 ? C.bad : C.muted,
                              fontFamily: 'Helvetica-Bold',
                            }}
                          >
                            {delta > 0 ? `+${delta}` : String(delta)}
                          </Text>
                        </View>
                      );
                    })}
                </View>
              </>
            )}
          </>
        ) : (
          <View style={{ ...s.panel, marginTop: 16 }}>
            <Text
              style={{
                fontSize: 11,
                lineHeight: 1.4,
                color: C.navy,
                fontFamily: 'Helvetica-Bold',
                marginBottom: 5,
              }}
            >
              Benchmark data is being collected.
            </Text>
            <Text style={{ fontSize: 9.5, lineHeight: 1.5, color: C.slate }}>
              Your scan contributes to building this dataset. Once at least {MIN_BENCHMARK_SAMPLES}{' '}
              {result.industry} domains in {result.region} have been assessed, this page will show
              your position against them, including per-category comparisons and a percentile
              ranking. Note that the pool is a sample of domains submitted to Klyro, not a
              representative survey of the industry.
            </Text>
          </View>
        )}

        {contributesToBenchmark && (
          <Text style={{ fontSize: 7.5, color: C.muted, lineHeight: 1.5, marginTop: 14 }}>
            This organisation contributes to the benchmark pool. Scores appear in the pool
            anonymised by industry and region; domain names are not attributed.
          </Text>
        )}

        <Footer domain={result.domain} scannedAt={result.scannedAt} />
      </Page>

      {/* ---------------- Page 4 — Detailed Findings ---------------- */}
      <Page size="A4" style={s.page}>
        <Header domain={result.domain} title="Detailed Findings" />

        <Text style={s.eyebrow}>SECTION {sectionNo('findings')}</Text>
        <Text style={{ ...s.h1, fontSize: 16 }}>Detailed Findings</Text>
        <Text style={s.body}>
          {materialFindings.length === 0
            ? `No scored findings were identified from public sources during this assessment.${
                infoFindings.length > 0
                  ? ` ${infoFindings.length} informational observation${infoFindings.length === 1 ? ' is' : 's are'} listed below.`
                  : ''
              }`
            : `${materialFindings.length} scored finding${materialFindings.length === 1 ? '' : 's'}, ordered by severity. Each separates what Klyro measured from what that measurement indicates, and states what the test cannot establish.${
                infoFindings.length > 0
                  ? ` ${infoFindings.length} informational observation${infoFindings.length === 1 ? '' : 's'} follow${infoFindings.length === 1 ? 's' : ''}.`
                  : ''
              }`}
        </Text>

        {findingsForTable.map((finding) => {
          const style = SEVERITY_STYLE[finding.severity];
          return (
            <View key={finding.id} style={s.findingBlock} wrap={false}>
              <View style={s.findingHead}>
                <View style={{ ...s.sevChip, backgroundColor: style.bg }}>
                  <Text style={{ ...s.sevChipText, color: style.fg }}>{style.label}</Text>
                </View>
                <Text style={s.findingTitle}>{finding.title}</Text>
              </View>

              <Text style={s.findingMeta}>
                {finding.categoryLabel} · {finding.confidence} confidence · {finding.asset}
              </Text>

              <FindingField label="OBSERVED" value={finding.observed} />
              <FindingField label="INTERPRETATION" value={finding.interpretation} />
              <FindingField label="RISK IF THAT HOLDS" value={finding.risk} />
              <FindingField label="RECOMMENDED ACTION" value={finding.recommendation} />
              <FindingField
                label="EVIDENCE"
                value={`Test: ${finding.evidence.test}. Observed: ${finding.evidence.observed}.${
                  finding.evidence.expected ? ` Expected: ${finding.evidence.expected}.` : ''
                } Verification: ${finding.evidence.verification}`}
              />
              {finding.evidence.limitation && (
                <FindingField label="CANNOT ESTABLISH" value={finding.evidence.limitation} />
              )}
            </View>
          );
        })}

        {materialFindings.length > findingsForTable.length && (
          <Text style={{ fontSize: 8, color: C.muted, marginTop: 10 }}>
            Showing the {findingsForTable.length} highest-severity findings of{' '}
            {materialFindings.length}. The full register is available in the Klyro dashboard.
          </Text>
        )}

        {infoFindings.length > 0 && (
          <View style={{ marginTop: 18 }} break={findingsForTable.length > 3}>
            <Text style={s.eyebrow}>INFORMATIONAL OBSERVATIONS</Text>
            <Text style={{ ...s.body, marginBottom: 2 }}>
              {infoFindings.length} further observation{infoFindings.length === 1 ? ' was' : 's were'}{' '}
              recorded. {infoFindings.length === 1 ? 'It carries' : 'They carry'} no score impact and{' '}
              {infoFindings.length === 1 ? 'is' : 'are'} not a weakness:{' '}
              {infoFindings.length === 1 ? 'it is' : 'most are'} a statement of what this assessment
              could and could not establish, which bounds what the rest of this report claims.
            </Text>

            {infoForList.map((finding) => (
              <View key={finding.id} style={s.infoRow} wrap={false}>
                <View style={{ ...s.sevChip, backgroundColor: SEVERITY_STYLE.info.bg }}>
                  <Text style={{ ...s.sevChipText, color: SEVERITY_STYLE.info.fg, fontSize: 6.5 }}>
                    INFO
                  </Text>
                </View>
                <View style={s.infoBody}>
                  <Text style={s.infoTitle}>{finding.title}</Text>
                  <Text style={s.infoObserved}>{finding.observed}</Text>
                  <Text style={s.infoMeta}>
                    {finding.categoryLabel} · {finding.confidence} confidence
                  </Text>
                </View>
              </View>
            ))}

            {infoFindings.length > infoForList.length && (
              <Text style={{ fontSize: 8, color: C.muted, marginTop: 8 }}>
                Showing {infoForList.length} of {infoFindings.length}. The full register is
                available in the Klyro dashboard.
              </Text>
            )}
          </View>
        )}

        <Footer domain={result.domain} scannedAt={result.scannedAt} />
      </Page>

      {/* ---------------- Asset inventory — recorded, not scored ---------------- */}
      {result.inventory && (
        <Page size="A4" style={s.page}>
          <Header domain={result.domain} title="Asset Inventory" />

          <Text style={s.eyebrow}>SECTION {sectionNo('inventory')}</Text>
          <Text style={{ ...s.h1, fontSize: 16 }}>Asset &amp; Exposure Inventory</Text>
          <Text style={s.body}>
            Host names attached to this domain, the addresses they resolve to, the networks
            announcing those addresses, and the software the site declares about itself. This
            section is recorded and deliberately excluded from the exposure score — every quantity
            in it measures how large an organisation is rather than how exposed it is.
          </Text>

          <View style={{ flexDirection: 'row', marginBottom: 14 }}>
            {[
              { label: 'HOST NAMES', value: result.inventory.hosts.length },
              {
                label: 'ADDRESSES',
                value: new Set(result.inventory.hosts.flatMap((h) => h.addresses)).size,
              },
              { label: 'NETWORKS', value: result.inventory.networks.length },
              { label: 'TECHNOLOGIES', value: result.inventory.technologies.length },
            ].map((stat, i, all) => (
              <View
                key={stat.label}
                style={{
                  flex: 1,
                  backgroundColor: C.panel,
                  paddingVertical: 8,
                  paddingHorizontal: 10,
                  marginRight: i === all.length - 1 ? 0 : 8,
                }}
              >
                <Text style={{ fontSize: 18, fontFamily: 'Helvetica-Bold', color: C.navy }}>
                  {stat.value}
                </Text>
                <Text style={{ fontSize: 7, color: C.muted, letterSpacing: 0.8 }}>{stat.label}</Text>
              </View>
            ))}
          </View>

          {result.inventory.networks.length > 0 && (
            <>
              <Text style={s.h2}>Announcing networks</Text>
              <View style={s.table}>
                <View style={s.th}>
                  <Text style={{ ...s.thText, width: '34%' }}>OPERATOR</Text>
                  <Text style={{ ...s.thText, width: '14%' }}>ASN</Text>
                  <Text style={{ ...s.thText, width: '26%' }}>PREFIX</Text>
                  <Text style={{ ...s.thText, width: '12%' }}>COUNTRY</Text>
                  <Text style={{ ...s.thText, width: '14%' }}>HOSTS</Text>
                </View>
                {result.inventory.networks.slice(0, 12).map((network, i) => (
                  <View
                    key={network.asn}
                    style={i % 2 === 1 ? { ...s.tr, ...s.trAlt } : s.tr}
                    wrap={false}
                  >
                    <Text style={{ ...s.tdStrong, width: '34%', paddingRight: 6 }}>
                      {network.asName}
                    </Text>
                    <Text style={{ ...s.td, width: '14%' }}>AS{network.asn}</Text>
                    <Text style={{ ...s.td, width: '26%' }}>{network.prefix}</Text>
                    <Text style={{ ...s.td, width: '12%' }}>{network.countryCode}</Text>
                    <Text style={{ ...s.td, width: '14%' }}>
                      {
                        result.inventory!.hosts.filter((h) => h.asns.includes(network.asn)).length
                      }
                    </Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {result.inventory.hosts.length > 0 && (
            <>
              <Text style={{ ...s.h2, marginTop: 14 }}>Host names</Text>
              <Text style={{ ...s.body, marginBottom: 6 }}>
                Resolved during this assessment. The naming column records what a host name
                suggests, never what the system behind it was confirmed to be.
              </Text>
              <View style={s.table}>
                <View style={s.th}>
                  <Text style={{ ...s.thText, width: '34%' }}>HOST</Text>
                  <Text style={{ ...s.thText, width: '24%' }}>ADDRESSES</Text>
                  <Text style={{ ...s.thText, width: '24%' }}>REVERSE DNS</Text>
                  <Text style={{ ...s.thText, width: '18%' }}>NAMING</Text>
                </View>
                {result.inventory.hosts.slice(0, 24).map((host, i) => (
                  <View
                    key={host.host}
                    style={i % 2 === 1 ? { ...s.tr, ...s.trAlt } : s.tr}
                    wrap={false}
                  >
                    <Text style={{ ...s.tdStrong, width: '34%', paddingRight: 6 }}>{host.host}</Text>
                    <Text style={{ ...s.td, width: '24%', paddingRight: 6 }}>
                      {host.addresses.slice(0, 2).join(', ')}
                      {host.addresses.length > 2 ? ` +${host.addresses.length - 2}` : ''}
                    </Text>
                    <Text style={{ ...s.td, width: '24%', paddingRight: 6 }}>
                      {host.reverseDns[0] ?? '—'}
                    </Text>
                    <Text style={{ ...s.td, width: '18%' }}>
                      {host.namingSuggests ? `suggests ${host.namingSuggests}` : '—'}
                    </Text>
                  </View>
                ))}
              </View>
              {result.inventory.hosts.length > 24 && (
                <Text style={{ fontSize: 8, color: C.muted, marginTop: 6 }}>
                  Showing 24 of {result.inventory.hosts.length} resolved host names. The full
                  inventory is available in the Klyro dashboard.
                </Text>
              )}
            </>
          )}

          {result.inventory.technologies.length > 0 && (
            <>
              <Text style={{ ...s.h2, marginTop: 14 }}>Software identified</Text>
              <View style={s.table}>
                <View style={s.th}>
                  <Text style={{ ...s.thText, width: '26%' }}>TECHNOLOGY</Text>
                  <Text style={{ ...s.thText, width: '14%' }}>VERSION</Text>
                  <Text style={{ ...s.thText, width: '14%' }}>CONFIDENCE</Text>
                  <Text style={{ ...s.thText, width: '46%' }}>EVIDENCE</Text>
                </View>
                {result.inventory.technologies.slice(0, 16).map((tech, i) => (
                  <View
                    key={`${tech.name}-${i}`}
                    style={i % 2 === 1 ? { ...s.tr, ...s.trAlt } : s.tr}
                    wrap={false}
                  >
                    <Text style={{ ...s.tdStrong, width: '26%', paddingRight: 6 }}>{tech.name}</Text>
                    <Text style={{ ...s.td, width: '14%' }}>{tech.version ?? 'not stated'}</Text>
                    <Text style={{ ...s.td, width: '14%' }}>{tech.confidence}</Text>
                    <Text style={{ ...s.td, width: '46%' }}>{tech.evidence}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          <Text style={{ ...s.h2, marginTop: 14 }}>What this inventory cannot see</Text>
          {result.inventory.limits.map((limit, i) => (
            <View key={i} style={s.bullet}>
              <View style={s.bulletDot} />
              <Text style={s.bulletText}>{limit}</Text>
            </View>
          ))}

          <Footer domain={result.domain} scannedAt={result.scannedAt} />
        </Page>
      )}

      {/* ---------------- Company news — reported, not scored ---------------- */}
      {news && (
        <Page size="A4" style={s.page}>
          <Header domain={result.domain} title="Company News" />

          <Text style={s.eyebrow}>SECTION {sectionNo('news')}</Text>
          <Text style={{ ...s.h1, fontSize: 16 }}>Company News &amp; Events</Text>
          <Text style={s.body}>
            Public coverage of {news.brand}, classified by event type. This section is reported and
            deliberately excluded from the exposure score — the volume of coverage a company
            attracts reflects its size far more than its risk.
          </Text>

          {news.status !== 'ok' || news.items.length === 0 ? (
            <View style={s.panel}>
              <Text style={{ fontSize: 9.5, lineHeight: 1.5, color: C.navy }}>
                {news.status !== 'ok'
                  ? 'News coverage could not be retrieved at the time of this assessment. This reflects source availability, not an absence of events.'
                  : `No matching coverage was found for "${news.brand}". This is not evidence of a clean record — most organisations attract no press coverage, and many incidents are never reported publicly.`}
              </Text>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: 'row', marginBottom: 14 }}>
                {[
                  { label: 'STORIES', value: String(news.items.length) },
                  { label: 'CORROBORATED', value: String(news.corroboratedCount) },
                  { label: 'SECURITY', value: String(news.counts.security) },
                  { label: 'LEGAL', value: String(news.counts.legal) },
                ].map((stat, i) => (
                  <View
                    key={stat.label}
                    style={{
                      flex: 1,
                      borderWidth: 1,
                      borderColor: C.hairline,
                      padding: 9,
                      marginRight: i === 3 ? 0 : 8,
                    }}
                  >
                    <Text style={{ fontSize: 15, fontFamily: 'Helvetica-Bold', color: C.navy }}>
                      {stat.value}
                    </Text>
                    <Text style={{ fontSize: 6.5, color: C.muted, letterSpacing: 0.7 }}>
                      {stat.label}
                    </Text>
                  </View>
                ))}
              </View>

              <View style={s.table}>
                <View style={s.th} fixed>
                  <Text style={{ ...s.thText, width: '13%' }}>DATE</Text>
                  <Text style={{ ...s.thText, width: '17%' }}>EVENT</Text>
                  <Text style={{ ...s.thText, width: '40%' }}>HEADLINE</Text>
                  <Text style={{ ...s.thText, width: '18%' }}>SOURCE</Text>
                  <Text style={{ ...s.thText, width: '12%' }}>STATUS</Text>
                </View>

                {news.items.slice(0, 20).map((item, i) => {
                  const vs = VERIFICATION_STYLE[item.verification] ?? VERIFICATION_STYLE['single-source'];
                  const sev = SEVERITY_STYLE[item.severity] ?? SEVERITY_STYLE.info;
                  return (
                    <View
                      key={item.id}
                      style={i % 2 === 1 ? { ...s.tr, ...s.trAlt } : s.tr}
                      wrap={false}
                    >
                      <Text style={{ ...s.td, width: '13%', fontFamily: 'Courier', fontSize: 7.5 }}>
                        {item.publishedAt ? item.publishedAt.slice(0, 10) : 'unknown'}
                      </Text>
                      <View style={{ width: '17%', paddingRight: 5 }}>
                        <Text style={{ ...s.td, color: sev.fg, fontFamily: 'Helvetica-Bold', fontSize: 7.5 }}>
                          {item.classification}
                        </Text>
                        {item.subjectConfidence === 'mentioned' && (
                          <Text style={{ fontSize: 6.5, color: C.muted, marginTop: 1 }}>
                            mention only
                          </Text>
                        )}
                      </View>
                      <Text style={{ ...s.td, width: '40%', paddingRight: 6, fontSize: 8 }}>
                        {item.title}
                      </Text>
                      <View style={{ width: '18%', paddingRight: 5 }}>
                        <Text style={{ ...s.td, fontSize: 7.5 }}>{item.publisher}</Text>
                        {item.corroboratingPublishers.length > 0 && (
                          <Text style={{ fontSize: 6.5, color: C.muted, marginTop: 1 }}>
                            +{item.corroboratingPublishers.length} more
                          </Text>
                        )}
                      </View>
                      <View style={{ width: '12%' }}>
                        <View style={{ ...s.sevChip, backgroundColor: vs.bg }}>
                          <Text style={{ ...s.sevChipText, color: vs.fg, fontSize: 6.5 }}>
                            {vs.label}
                          </Text>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>

              {news.items.length > 20 && (
                <Text style={{ fontSize: 8, color: C.muted, marginTop: 8 }}>
                  Showing the 20 most significant of {news.items.length} stories.
                </Text>
              )}
            </>
          )}

          <View style={{ ...s.disclaimer, marginTop: 16 }} wrap={false}>
            <Text
              style={{ fontFamily: 'Helvetica-Bold', color: C.navy, fontSize: 9, marginBottom: 4 }}
            >
              Limits of this section
            </Text>
            {news.blindSpots.map((spot, i) => (
              <View key={i} style={{ flexDirection: 'row', marginBottom: 3 }}>
                <Text style={{ fontSize: 8, color: C.muted, marginRight: 5 }}>·</Text>
                <Text style={{ fontSize: 8, lineHeight: 1.45, color: C.slate, flex: 1 }}>
                  {spot}
                </Text>
              </View>
            ))}
            <Text style={{ fontSize: 7.5, color: C.muted, marginTop: 6 }}>
              Searched &quot;{news.brand}&quot; via {news.sourceName} on{' '}
              {new Date(news.retrievedAt).toISOString().slice(0, 10)}. &quot;Corroborated&quot; means
              two or more independent outlets carried the story; &quot;single source&quot; means one
              outlet only and the claim is not independently confirmed.
            </Text>
          </View>

          <Footer domain={result.domain} scannedAt={result.scannedAt} />
        </Page>
      )}

      {/* ---------------- Methodology ---------------- */}
      <Page size="A4" style={s.page}>
        <Header domain={result.domain} title="Methodology" />

        <Text style={s.eyebrow}>SECTION {sectionNo('methodology')}</Text>
        <Text style={{ ...s.h1, fontSize: 16 }}>Methodology</Text>

        <Text style={s.body}>
          This assessment is a passive reconnaissance exercise. It gathers what is already published
          about {result.domain} — public DNS records, certificate transparency logs, domain
          registration data, and the responses the web server gives to ordinary browser requests —
          and interprets it the way an attacker performing initial research would.
        </Text>
        <Text style={s.body}>
          Nothing in this process attempts to gain access, guess credentials, or exploit a weakness.
          Every request Klyro makes is one a search engine crawler or an ordinary visitor could make.
          No port scanning, service enumeration or version probing was performed.
        </Text>

        <Text style={s.h2}>How findings are written</Text>
        <Text style={s.body}>
          Every finding separates what Klyro measured from what that measurement indicates. OBSERVED
          states the measurement and nothing more. INTERPRETATION states what it reasonably
          indicates. RISK states what could follow if that reading is correct, and is the only part
          describing something that has not happened. EVIDENCE records the test, the observed and
          expected values, how the observation was corroborated, and what the test cannot establish.
        </Text>
        <Text style={s.body}>
          Confidence is reported separately from severity, because how serious a weakness would be
          and how certain Klyro is that it exists are independent questions. High confidence means
          directly observed and corroborated; medium means directly observed with a stated
          limitation; low means inferred from indirect signal such as a naming convention, and never
          carries severe language. Anything that could not be established is reported as such and
          excluded from the score rather than counted against the domain.
        </Text>

        <Text style={s.h2}>What was checked</Text>
        <View style={{ marginBottom: 12 }}>
          {ordered.map((category) => (
            <View key={category.key} style={s.methodItem} wrap={false}>
              <Text style={s.methodKey}>{category.label}</Text>
              <Text style={s.methodVal}>
                {CATEGORY_BLURBS[category.key]}{' '}
                <Text style={{ color: C.muted }}>(weight {weightPercent(category.key)})</Text>
              </Text>
            </View>
          ))}
        </View>

        <Text style={s.h2}>Scoring</Text>
        <Text style={s.body}>
          Each category returns a score from 0 to 100, built from named components whose arithmetic
          is shown in the score breakdown for that category. A component that could not be observed
          is dropped and the remainder rescaled, so an unreachable data source lowers the reported
          coverage rather than the score. The composite is the weighted average of every category
          that could be assessed, renormalised the same way. Scores of 80 and above are reported as
          Low Risk, 60 to 79 as Moderate Risk, and below 60 as High Risk.
        </Text>
        <Text style={s.body}>
          The order of &quot;what matters most&quot; is arithmetic rather than judgement: severity ×
          confidence × exposure, with the multipliers printed against each item. Exposure is a
          per-category constant reflecting how directly an outsider can act on the weakness. The
          effect is that a finding inferred from a host name cannot outrank one read out of a DNS
          record at the same severity.
        </Text>

        <Text style={s.h2}>Sources</Text>
        <View style={{ marginBottom: 12 }}>
          {[
            [
              'Public DNS',
              'Google and Cloudflare DNS-over-HTTPS resolvers. Absence of a record is confirmed against a second resolver before it is reported, and a lookup that fails is treated as unknown rather than as an absent record.',
            ],
            ['Certificate transparency', 'crt.sh and CertSpotter, unexpired certificates only. Every host name discovered is resolved before being reported.'],
            ['Live TLS handshake', 'A standard TLS connection to port 443, as any browser performs'],
            ['Domain registration', 'RDAP — the registries\' structured successor to WHOIS'],
            ['Web configuration', 'Ordinary HTTP requests to the site and its published metadata files'],
            ['Network attribution', 'Team Cymru\'s public routing-table interface, which names the operator announcing an address block rather than its occupant'],
            ...(news
              ? [['Company news', 'Google News RSS, classified by rule and attributed to the reporting outlet'] as [string, string]]
              : []),
            ...(relationship
              ? [
                  [
                    'Reader\'s own domain',
                    `${relationship.yourDomain} was assessed with the same ${CATEGORY_ORDER.length} modules so the two composites are comparable. It was not scored against this vendor, ranked, stored, or added to any benchmark pool.`,
                  ] as [string, string],
                ]
              : []),
          ].map(([key, value]) => (
            <View key={key} style={s.methodItem} wrap={false}>
              <Text style={s.methodKey}>{key}</Text>
              <Text style={s.methodVal}>{value}</Text>
            </View>
          ))}
        </View>

        <View style={s.disclaimer} wrap={false}>
          <Text style={{ fontFamily: 'Helvetica-Bold', color: C.navy, fontSize: 9.5, marginBottom: 4 }}>
            Disclaimer
          </Text>
          <Text style={{ fontSize: 9, lineHeight: 1.5, color: C.slate }}>
            This assessment uses publicly available information only. No systems were accessed or
            tested. Findings reflect what was observable at the time of the scan and are not a
            substitute for a penetration test, a configuration review, or an internal security audit.
            The absence of a finding is not a guarantee that no weakness exists.
          </Text>
        </View>

        <View style={{ marginTop: 16, flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 8, color: C.muted }}>
            Assessment run {scannedDate.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}
          </Text>
          <Text style={{ fontSize: 8, color: C.muted }}>Klyro version {result.toolVersion}</Text>
        </View>

        <Footer domain={result.domain} scannedAt={result.scannedAt} />
      </Page>
    </Document>
  );
}

export default ReportTemplate;
