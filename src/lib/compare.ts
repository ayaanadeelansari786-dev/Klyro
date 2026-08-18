/**
 * Comparison of two completed scans.
 *
 * This is deliberately *not* monitoring. Nothing reassesses on a schedule and
 * nothing runs unattended: two scans that already exist are diffed on request.
 *
 * The distinction matters for what may be claimed. Two point-in-time
 * observations support statements about the two points and nothing in between —
 * a finding absent from the later scan was not observed then, which is not the
 * same as having been fixed, and certainly not the same as having been fixed
 * on any particular date. Every output below is phrased to respect that, and
 * `limits` is rendered wherever a comparison is shown.
 */

import { CATEGORY_LABELS } from './constants';
import type {
  CategoryDelta,
  CategoryKey,
  Finding,
  ScanComparison,
  ScanResult,
  ScanSnapshotRef,
  SeverityChange,
} from './types';

function snapshotOf(scan: ScanResult): ScanSnapshotRef {
  return {
    domain: scan.domain,
    scannedAt: scan.scannedAt,
    compositeScore: scan.compositeScore,
    coverage: scan.coverage,
    toolVersion: scan.toolVersion || null,
  };
}

/** Host names a scan established, from whichever modules recorded them. */
function assetsOf(scan: ScanResult): Set<string> {
  const names = new Set<string>();

  if (scan.inventory) {
    for (const host of scan.inventory.hosts) names.add(host.host);
  }

  const subdomains = scan.categories.find((c) => c.key === 'subdomains');
  const live = subdomains?.facts?.liveHosts;
  if (Array.isArray(live)) {
    for (const host of live) if (typeof host === 'string') names.add(host);
  }

  return names;
}

/**
 * Which categories a scan actually assessed. A category that was unavailable
 * in one run and assessed in the other produces a null on one side rather than
 * a delta, because there is no measurement to subtract from.
 */
function categoryDeltas(baseline: ScanResult, current: ScanResult): CategoryDelta[] {
  const keys = new Set<CategoryKey>([
    ...baseline.categories.map((c) => c.key),
    ...current.categories.map((c) => c.key),
  ]);

  const scoreIn = (scan: ScanResult, key: CategoryKey): number | null => {
    const category = scan.categories.find((c) => c.key === key);
    return category && category.status === 'assessed' ? category.score : null;
  };

  return [...keys]
    .map((key) => {
      const from = scoreIn(baseline, key);
      const to = scoreIn(current, key);
      return {
        key,
        label: CATEGORY_LABELS[key] ?? key,
        from,
        to,
        delta: from !== null && to !== null ? to - from : null,
      };
    })
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || a.label.localeCompare(b.label));
}

/**
 * Diffs two scans of the same domain.
 *
 * Findings are matched on their id, which is derived from the finding's own
 * title rather than from a counter — that is what makes this deterministic
 * rather than a fuzzy text comparison.
 */
export function compareScans(baseline: ScanResult, current: ScanResult): ScanComparison {
  const baselineById = new Map<string, Finding>(baseline.findings.map((f) => [f.id, f]));
  const currentById = new Map<string, Finding>(current.findings.map((f) => [f.id, f]));

  const newFindings: Finding[] = [];
  const severityChanges: SeverityChange[] = [];
  let unchangedCount = 0;

  for (const [id, finding] of currentById) {
    const previous = baselineById.get(id);
    if (!previous) {
      newFindings.push(finding);
    } else if (previous.severity !== finding.severity) {
      severityChanges.push({ finding, from: previous.severity, to: finding.severity });
    } else {
      unchangedCount += 1;
    }
  }

  const resolvedFindings = [...baselineById.entries()]
    .filter(([id]) => !currentById.has(id))
    .map(([, finding]) => finding);

  const baselineAssets = assetsOf(baseline);
  const currentAssets = assetsOf(current);

  const newAssets = [...currentAssets].filter((h) => !baselineAssets.has(h)).sort();
  const removedAssets = [...baselineAssets].filter((h) => !currentAssets.has(h)).sort();

  /*
   * The most important caveat is coverage. A category that failed to assess in
   * one of the two runs takes all of its findings with it, and those would
   * otherwise read as "resolved" or "new" when nothing about the domain
   * changed at all.
   */
  const coverageMoved = Math.abs(current.coverage - baseline.coverage) > 0.01;

  /*
   * How many host names each run discovered, which is the single largest
   * source of apparent movement in this product.
   *
   * Two runs of the same domain nine minutes apart moved Subdomain Exposure by
   * 39 points, entirely because one of them reached crt.sh and the other fell
   * back to a slower source. The reader deserves that stated next to the
   * number rather than having to infer it. The threshold is proportional so a
   * couple of genuinely new host names does not trigger it.
   */
  const discoveryFloor = Math.min(baselineAssets.size, currentAssets.size);
  const discoveryGap = Math.abs(currentAssets.size - baselineAssets.size);
  const discoveryMoved = discoveryGap > Math.max(3, discoveryFloor * 0.25);

  /*
   * Neither run carries a host list.
   *
   * A stored assessment keeps its scores and findings, not the host names it
   * discovered, so a comparison read back from the dataset cannot diff the
   * estate. The host-name section simply did not render in that case, which
   * reads as "nothing changed" — the one reading that is not supported.
   */
  const assetsUnrecorded = baselineAssets.size === 0 && currentAssets.size === 0;
  const unavailableEither = [...baseline.categories, ...current.categories]
    .filter((c) => c.status === 'unavailable')
    .map((c) => c.label);

  /*
   * Finding ids are derived from finding titles, which is what makes this diff
   * deterministic — and also what makes it useless across a version boundary.
   * Rewording a finding changes its id, so every finding in the older run
   * reads as resolved and every finding in the newer one as new. A reader
   * seeing "9 no longer observed, 12 new" has no way to tell that apart from
   * genuine movement unless the comparison says so.
   */
  const versionsDiffer =
    Boolean(baseline.toolVersion) &&
    Boolean(current.toolVersion) &&
    baseline.toolVersion !== current.toolVersion;
  const versionUnknown = !baseline.toolVersion || !current.toolVersion;
  const churnLooksTotal =
    unchangedCount === 0 && severityChanges.length === 0 && newFindings.length > 0;

  const limits = [
    ...(versionsDiffer
      ? [
          `The two runs were produced by different versions of Klyro (${baseline.toolVersion} and ${current.toolVersion}). Findings are matched by an identifier derived from their wording, so a finding that was reworded between versions appears once as no longer observed and once as new. Treat the counts below as unreliable across this boundary.`,
        ]
      : []),
    ...(versionUnknown && churnLooksTotal
      ? [
          'Every finding differs between the two runs and no version was recorded for at least one of them. That pattern usually means the two were produced by different versions of Klyro rather than that the domain changed completely — confirm before reading anything into the counts.',
        ]
      : []),
    'These are two point-in-time observations. Nothing is known about the state of the domain between them, and no claim is made about when any change happened.',
    'A finding present in the earlier scan and absent from the later one was not observed the second time. That is consistent with it having been fixed, and also with the check not reaching the same conclusion — confirm before reporting anything as remediated.',
    ...(coverageMoved
      ? [
          `Assessment coverage differs between the two runs (${Math.round(baseline.coverage * 100)}% then, ${Math.round(current.coverage * 100)}% now). Findings can appear or disappear purely because a module reached a data source in one run and not the other.`,
        ]
      : []),
    ...(unavailableEither.length > 0
      ? [
          `${[...new Set(unavailableEither)].join(', ')} could not be assessed in at least one of the two runs, so any change involving ${unavailableEither.length === 1 ? 'that category' : 'those categories'} may reflect the check rather than the domain.`,
        ]
      : []),
    ...(assetsUnrecorded
      ? [
          'Neither assessment retained the host names it discovered, so no comparison of the estate is possible here. The absence of a host-name section below means the data was not kept, not that the estate was unchanged. Where subdomain exposure moved, compare the two assessments directly.',
        ]
      : [
          'Host names come from certificate transparency, which lags issuance and revocation. An asset appearing or disappearing here reflects the log, not necessarily the estate.',
        ]),
    ...(discoveryMoved
      ? [
          `The two runs discovered different numbers of host names (${baselineAssets.size} then, ${currentAssets.size} now). Certificate transparency queries are not guaranteed to return the same set twice — a log that answers slowly returns less — so a change in subdomain exposure of this size is at least as likely to be the query as the estate.`,
        ]
      : []),
  ];

  return {
    baseline: snapshotOf(baseline),
    current: snapshotOf(current),
    scoreDelta: current.compositeScore - baseline.compositeScore,
    newFindings,
    resolvedFindings,
    severityChanges,
    unchangedCount,
    categoryDeltas: categoryDeltas(baseline, current),
    newAssets,
    removedAssets,
    limits,
  };
}

/** One sentence describing the change, for a heading. */
export function comparisonHeadline(comparison: ScanComparison): string {
  const { scoreDelta, newFindings, resolvedFindings } = comparison;

  const direction =
    scoreDelta > 0 ? `up ${scoreDelta} points` : scoreDelta < 0 ? `down ${Math.abs(scoreDelta)} points` : 'unchanged';

  const parts = [
    resolvedFindings.length > 0
      ? `${resolvedFindings.length} finding${resolvedFindings.length === 1 ? '' : 's'} no longer observed`
      : null,
    newFindings.length > 0
      ? `${newFindings.length} new finding${newFindings.length === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean);

  return parts.length > 0
    ? `Score ${direction}: ${parts.join(', ')}.`
    : `Score ${direction}, with no change to the set of findings.`;
}
