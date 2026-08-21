/* eslint-disable jsx-a11y/alt-text */
import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

import { C, Header, ScoreDonut } from '@/pdf/ReportTemplate';
import { splitSummarySections, SUMMARY_SECTIONS } from '@/lib/ai/summary';
import { coverageCounts, explainLowCoverage, LOW_COVERAGE_THRESHOLD } from '@/lib/scoring';
import { TOOL_VERSION } from '@/lib/constants';
import type { ScanResult } from '@/lib/types';

/**
 * The one-page summary.
 *
 * A companion to the full report, not a shorter version of it. The full report
 * exists to be checked — it carries OBSERVED, INTERPRETATION, EVIDENCE and the
 * scoring arithmetic so a sceptical reader can follow every claim back to a
 * measurement. This document exists to be *read once*, by somebody who will
 * never open the other one, and who needs three things: whether the domain is
 * in reasonable shape, what the biggest concern is, and what happens next.
 *
 * It shares the full report's palette, fonts and score gauge deliberately. Two
 * documents from the same assessment arriving in the same email with different
 * typography would make both look unofficial.
 *
 * Everything it says about the domain comes from one `ScanResult` — the same
 * one the full report renders. Neither document can contradict the other,
 * because there is only one set of numbers.
 */

const s = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 56,
    paddingHorizontal: 52,
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: C.navy,
    backgroundColor: C.paper,
  },

  eyebrow: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: C.muted,
    letterSpacing: 1.3,
    marginBottom: 6,
  },

  title: { fontSize: 21, fontFamily: 'Helvetica-Bold', color: C.navy, marginBottom: 3 },
  domain: { fontFamily: 'Courier', fontSize: 12, color: C.navy },
  meta: { fontSize: 8, color: C.muted, marginTop: 4 },

  hero: { flexDirection: 'row', alignItems: 'center', marginTop: 22, marginBottom: 6 },
  heroRight: { flex: 1, paddingLeft: 26 },
  riskLine: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginBottom: 5 },
  heroNote: { fontSize: 9, lineHeight: 1.5, color: C.slate },

  /* The coverage caveat, above the score exactly as in the full report. */
  caveat: {
    backgroundColor: C.warnBg,
    borderLeftWidth: 3,
    borderLeftColor: C.warn,
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginTop: 18,
  },
  caveatLabel: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: C.warn,
    letterSpacing: 1,
    marginBottom: 4,
  },
  caveatBody: { fontSize: 9, lineHeight: 1.5, color: C.navy },

  sectionHeading: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: C.navy,
    marginTop: 20,
    marginBottom: 6,
  },
  prose: { fontSize: 10.5, lineHeight: 1.62, color: C.slate },
  lead: { fontSize: 10.5, lineHeight: 1.62, color: C.slate, marginTop: 18 },

  rule: { height: 1, backgroundColor: C.hairline, marginTop: 26 },

  provenance: {
    marginTop: 14,
    borderLeftWidth: 2,
    borderLeftColor: C.hairline,
    paddingLeft: 10,
  },
  provenanceText: { fontSize: 7.5, lineHeight: 1.5, color: C.muted },

  footer: {
    position: 'absolute',
    bottom: 26,
    left: 52,
    right: 52,
    borderTopWidth: 1,
    borderTopColor: C.hairline,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: { fontSize: 7.5, color: C.muted },
});

export interface SummaryReportProps {
  result: ScanResult;
  /** Prose from the model. Required — see the note in the route. */
  summary: string;
  generatedAt: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function SummaryReportTemplate({ result, summary, generatedAt }: SummaryReportProps) {
  const { lead, sections } = splitSummarySections(summary);
  const lowCoverage = result.coverage < LOW_COVERAGE_THRESHOLD;
  const counts = coverageCounts(result);

  /*
   * Any heading the model omitted is simply absent rather than rendered empty.
   * The order is fixed here, not taken from the model's output, so a document
   * cannot arrive with "What to do next" above "The short version".
   */
  const ordered = SUMMARY_SECTIONS.map((heading) => ({
    heading,
    body: sections.find((sec) => sec.heading === heading)?.body ?? '',
  })).filter((sec) => sec.body.length > 0);

  return (
    <Document
      title={`Klyro summary — ${result.domain}`}
      author="Klyro"
      subject={`Plain-language security assessment summary for ${result.domain}`}
    >
      <Page size="A4" style={s.page}>
        <Header domain={result.domain} title="PLAIN-LANGUAGE SUMMARY" />

        <View>
          <Text style={s.eyebrow}>EXTERNAL EXPOSURE ASSESSMENT</Text>
          <Text style={s.title}>What this assessment found</Text>
          <Text style={s.domain}>{result.domain}</Text>
          <Text style={s.meta}>
            Assessed {formatDate(result.scannedAt)} · {result.industry} · {result.region}
          </Text>
        </View>

        {/*
         * The caveat sits above the score, the same rule the full report and
         * the dashboard follow. A partly-completed assessment whose number is
         * read before its limits is a number that will be quoted out of
         * context, and this is the document most likely to be quoted.
         */}
        {lowCoverage && (
          <View style={s.caveat}>
            <Text style={s.caveatLabel}>ONLY PART OF THIS ASSESSMENT COULD BE COMPLETED</Text>
            <Text style={s.caveatBody}>
              {explainLowCoverage(result)} {counts.assessed} of {counts.total} checks completed, so
              the score below describes what could be reached rather than the whole domain.
            </Text>
          </View>
        )}

        <View style={s.hero}>
          <ScoreDonut score={result.compositeScore} size={116} />
          <View style={s.heroRight}>
            <Text style={s.riskLine}>{result.riskLevel}</Text>
            <Text style={s.heroNote}>
              Klyro assessed only what {result.domain} publishes to the open internet. Nothing was
              accessed, tested, or logged in to.
            </Text>
          </View>
        </View>

        {lead.length > 0 && <Text style={s.lead}>{lead}</Text>}

        {ordered.map((section) => (
          <View key={section.heading} wrap={false}>
            <Text style={s.sectionHeading}>{section.heading}</Text>
            <Text style={s.prose}>{section.body}</Text>
          </View>
        ))}

        <View style={s.rule} />

        <View style={s.provenance}>
          <Text style={s.provenanceText}>
            The three sections above were written by a language model from this assessment&apos;s own
            findings and measurements, on {formatDate(generatedAt)}. It was given no information
            about {result.domain} beyond what Klyro measured, and it did not set the score or the
            severity of any finding.
          </Text>
        </View>

        <View style={s.footer} fixed>
          <Text style={s.footerText}>
            A plain-language summary of Klyro&apos;s full assessment. For the findings, the
            methodology and the evidence behind each one, see the complete report.
          </Text>
          <Text style={s.footerText}>Klyro {TOOL_VERSION}</Text>
        </View>
      </Page>
    </Document>
  );
}

export default SummaryReportTemplate;
