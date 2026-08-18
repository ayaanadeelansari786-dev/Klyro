import { beforeEach, describe, expect, it } from 'vitest';

import { compareScans } from '@/lib/compare';
import { assessmentFromRow, attachRecordedHosts, type AssessmentRow } from '@/lib/dataset/history';

import { createTestDb, type TestDb } from './harness';

/**
 * New and removed assets, computed from persisted data.
 *
 * This is the capability the old schema could not support at all. Host names
 * were never stored, so `compareScans` always saw two empty sets and reported
 * no asset movement — and because the comparison UI hides that section when
 * both sides are empty, the absence read as "the estate did not change", which
 * is the one conclusion the data did not support.
 *
 * The test runs the real query the compare route runs, against real rows,
 * through the real diff.
 */

let db: TestDb;

beforeEach(async () => {
  if (db) await db.close();
  db = await createTestDb();
});

const COLUMNS =
  'id, owner_user_id, owner_org_id, domain, industry, region, composite_score, risk_level, ' +
  'coverage, tool_version, scanned_at, category_scores, categories, findings, inventory, benchmark';

async function storeWithHosts(
  user: string,
  domain: string,
  scannedAt: string,
  hosts: string[],
  score = 80,
): Promise<string> {
  const [row] = await db.asService().query<{ id: string }>(
    `insert into assessments
       (owner_user_id, created_by, domain, industry, region, composite_score,
        coverage, tool_version, scanned_at, findings, categories)
     values ($1::uuid, $1::uuid, $2, 'Technology', 'Global', $3, 1.0, '1.0.0', $4::timestamptz,
             '[]'::jsonb, '[]'::jsonb)
     returning id`,
    [user, domain, score, scannedAt],
  );

  for (const host of hosts) {
    await db
      .asService()
      .query(
        `insert into assessment_hosts (assessment_id, host, addresses, asns, network_looked_up)
         values ($1, $2, $3, $4, true)`,
        [row.id, host, ['203.0.113.7'], ['13335']],
      );
  }

  return row.id;
}

/** The exact read the compare route performs, as the given user. */
async function loadForCompare(user: string, ids: string[]): Promise<AssessmentRow[]> {
  const rows = await db
    .asUser(user)
    .query<AssessmentRow>(`select ${COLUMNS} from assessments where id = any($1::uuid[])`, [ids]);

  const hostRows = await db
    .asUser(user)
    .query<{ assessment_id: string; host: string }>(
      `select assessment_id, host from assessment_hosts where assessment_id = any($1::uuid[])`,
      [ids],
    );

  const byAssessment = new Map<string, string[]>();
  for (const row of hostRows) {
    byAssessment.set(row.assessment_id, [...(byAssessment.get(row.assessment_id) ?? []), row.host]);
  }

  return rows.map((row) => ({ ...row, __hosts: byAssessment.get(row.id) ?? [] }) as AssessmentRow);
}

function toScan(row: AssessmentRow & { __hosts?: string[] }) {
  return attachRecordedHosts(assessmentFromRow(row), row.__hosts);
}

describe('asset diffing across two persisted assessments', () => {
  it('reports host names that appeared and disappeared', async () => {
    const user = await db.createUser();

    const first = await storeWithHosts(user, 'vendor.test', '2026-01-01T00:00:00Z', [
      'www.vendor.test',
      'mail.vendor.test',
      'old.vendor.test',
    ]);
    const second = await storeWithHosts(user, 'vendor.test', '2026-02-01T00:00:00Z', [
      'www.vendor.test',
      'mail.vendor.test',
      'staging.vendor.test',
    ]);

    const rows = await loadForCompare(user, [first, second]);
    const baseline = toScan(rows.find((r) => r.id === first)!);
    const current = toScan(rows.find((r) => r.id === second)!);

    const diff = compareScans(baseline, current);

    expect(diff.newAssets).toEqual(['staging.vendor.test']);
    expect(diff.removedAssets).toEqual(['old.vendor.test']);
  });

  it('reports no movement when the estate held still', async () => {
    const user = await db.createUser();
    const hosts = ['www.vendor.test', 'api.vendor.test'];

    const first = await storeWithHosts(user, 'vendor.test', '2026-01-01T00:00:00Z', hosts);
    const second = await storeWithHosts(user, 'vendor.test', '2026-02-01T00:00:00Z', hosts);

    const rows = await loadForCompare(user, [first, second]);
    const diff = compareScans(
      toScan(rows.find((r) => r.id === first)!),
      toScan(rows.find((r) => r.id === second)!),
    );

    expect(diff.newAssets).toEqual([]);
    expect(diff.removedAssets).toEqual([]);
    // And the limit about host names never having been recorded must not fire,
    // because this time they were.
    expect(diff.limits.join(' ')).not.toMatch(/Neither assessment retained the host names/);
  });

  it('still warns when neither assessment recorded any hosts', async () => {
    const user = await db.createUser();
    const first = await storeWithHosts(user, 'vendor.test', '2026-01-01T00:00:00Z', []);
    const second = await storeWithHosts(user, 'vendor.test', '2026-02-01T00:00:00Z', []);

    const rows = await loadForCompare(user, [first, second]);
    const diff = compareScans(
      toScan(rows.find((r) => r.id === first)!),
      toScan(rows.find((r) => r.id === second)!),
    );

    expect(diff.limits.join(' ')).toMatch(/Neither assessment retained the host names/);
  });

  it('flags a large swing in discovery volume rather than calling it estate growth', async () => {
    const user = await db.createUser();
    const many = Array.from({ length: 40 }, (_, i) => `h${i}.vendor.test`);

    const first = await storeWithHosts(user, 'vendor.test', '2026-01-01T00:00:00Z', many.slice(0, 3));
    const second = await storeWithHosts(user, 'vendor.test', '2026-02-01T00:00:00Z', many);

    const rows = await loadForCompare(user, [first, second]);
    const diff = compareScans(
      toScan(rows.find((r) => r.id === first)!),
      toScan(rows.find((r) => r.id === second)!),
    );

    expect(diff.limits.join(' ')).toMatch(/different numbers of host names \(3 then, 40 now\)/);
  });
});

describe('asset diffing respects ownership', () => {
  it('gives another user nothing to diff', async () => {
    const alice = await db.createUser();
    const bob = await db.createUser();

    const first = await storeWithHosts(alice, 'vendor.test', '2026-01-01T00:00:00Z', ['a.vendor.test']);
    const second = await storeWithHosts(alice, 'vendor.test', '2026-02-01T00:00:00Z', ['b.vendor.test']);

    // Bob knows both ids. The read is still empty, so there is nothing for the
    // route to diff — the protection is in the query, not in a later check.
    const rows = await loadForCompare(bob, [first, second]);
    expect(rows).toEqual([]);
  });

  it('does not leak host names of an assessment the caller cannot read', async () => {
    const alice = await db.createUser();
    const bob = await db.createUser();
    const scan = await storeWithHosts(alice, 'vendor.test', '2026-01-01T00:00:00Z', [
      'internal-secret.vendor.test',
    ]);

    const leaked = await db
      .asUser(bob)
      .query(`select host from assessment_hosts where assessment_id = $1`, [scan]);

    expect(leaked).toEqual([]);
  });

  it('lets an organisation member diff the organisation’s assessments', async () => {
    const owner = await db.createUser();
    const analyst = await db.createUser();

    const [org] = await db
      .asService()
      .query<{ id: string }>(
        `insert into organisations (name, slug, created_by) values ('Acme', 'acme', $1) returning id`,
        [owner],
      );
    await db
      .asService()
      .query(`insert into organisation_members (org_id, user_id, role) values ($1, $2, 'analyst')`, [
        org.id,
        analyst,
      ]);

    const ids: string[] = [];
    for (const [when, hosts] of [
      ['2026-01-01T00:00:00Z', ['a.supplier.test']],
      ['2026-02-01T00:00:00Z', ['a.supplier.test', 'b.supplier.test']],
    ] as const) {
      const [row] = await db.asService().query<{ id: string }>(
        `insert into assessments
           (owner_org_id, created_by, domain, industry, region, composite_score,
            coverage, tool_version, scanned_at, findings, categories)
         values ($1::uuid, $2::uuid, 'supplier.test', 'Technology', 'Global', 70, 1.0, '1.0.0',
                 $3::timestamptz, '[]'::jsonb, '[]'::jsonb)
         returning id`,
        [org.id, owner, when],
      );
      for (const host of hosts) {
        await db
          .asService()
          .query(`insert into assessment_hosts (assessment_id, host) values ($1, $2)`, [row.id, host]);
      }
      ids.push(row.id);
    }

    const rows = await loadForCompare(analyst, ids);
    expect(rows).toHaveLength(2);

    const diff = compareScans(
      toScan(rows.find((r) => r.id === ids[0])!),
      toScan(rows.find((r) => r.id === ids[1])!),
    );
    expect(diff.newAssets).toEqual(['b.supplier.test']);
  });
});

describe('the full snapshot survives a round trip', () => {
  it('returns categories, findings and inventory as they went in', async () => {
    const user = await db.createUser();

    const categories = [
      {
        key: 'dns',
        label: 'DNS Configuration',
        score: 88,
        status: 'assessed',
        findings: [],
        summary: 'Two resolvers agreed.',
        details: [{ label: 'Nameservers', value: 'ns1.test, ns2.test' }],
        scoreBreakdown: [{ label: 'DNSSEC', value: 0, max: 20, assessed: true, note: 'unsigned' }],
        durationMs: 412,
      },
    ];
    const findings = [
      {
        id: 'f-1',
        category: 'dns',
        categoryLabel: 'DNS Configuration',
        title: 'The zone is unsigned',
        severity: 'low',
        confidence: 'high',
        asset: 'vendor.test',
        observed: 'No DS record was returned by either resolver.',
        interpretation: 'DNS answers are not cryptographically authenticated.',
        risk: 'A tampered answer could not be detected by a validating resolver.',
        recommendation: 'Sign the zone.',
        evidence: { test: 'DS lookup', observed: 'NODATA', verification: 'Two resolvers agreed.' },
      },
    ];
    const inventory = {
      domain: 'vendor.test',
      hosts: [
        {
          host: 'www.vendor.test',
          origin: 'certificate-transparency',
          addresses: ['203.0.113.7'],
          reverseDns: ['edge.example.net'],
          asns: ['13335'],
          networkLookedUp: true,
          namingSuggests: null,
        },
      ],
      networks: [
        {
          asn: '13335',
          asName: 'CLOUDFLARENET',
          prefix: '203.0.113.0/24',
          countryCode: 'US',
          registry: 'arin',
          address: '203.0.113.7',
        },
      ],
      technologies: [
        { name: 'nginx', category: 'server', version: null, confidence: 'high', evidence: 'Server header' },
      ],
      unresolvedHosts: 2,
      limits: ['Wildcard certificates hide names from transparency logs.'],
      collectedAt: '2026-01-01T00:00:00Z',
    };

    const [row] = await db.asService().query<{ id: string }>(
      `insert into assessments
         (owner_user_id, created_by, domain, industry, region, composite_score, risk_level,
          coverage, tool_version, scanned_at, category_scores, categories, findings, inventory, benchmark)
       values ($1::uuid, $1::uuid, 'vendor.test', 'Technology', 'Global', 88, 'Low Risk', 0.92,
               '1.0.0', now(), $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb)
       returning id`,
      [
        user,
        JSON.stringify({ dns: 88 }),
        JSON.stringify(categories),
        JSON.stringify(findings),
        JSON.stringify(inventory),
        JSON.stringify({ industry: 'Technology', industryAverage: 74, totalScans: 151 }),
      ],
    );

    const [stored] = await db
      .asUser(user)
      .query<AssessmentRow>(`select ${COLUMNS} from assessments where id = $1`, [row.id]);

    const scan = assessmentFromRow(stored);

    // The four things the old schema dropped, checked individually because
    // each one was a separate broken feature: the report could not be
    // reproduced, the score could not be explained, the estate could not be
    // diffed, and the benchmark could not be reprinted as written.
    expect(scan.categories[0].scoreBreakdown?.[0].label).toBe('DNSSEC');
    expect(scan.categories[0].details[0].value).toBe('ns1.test, ns2.test');
    expect(scan.findings[0].evidence.verification).toBe('Two resolvers agreed.');
    expect(scan.inventory?.networks[0].asName).toBe('CLOUDFLARENET');
    expect(scan.inventory?.technologies[0].name).toBe('nginx');
    expect(scan.inventory?.limits).toHaveLength(1);
    expect(scan.coverage).toBeCloseTo(0.92);
    expect(scan.riskLevel).toBe('Low Risk');
    expect(scan.toolVersion).toBe('1.0.0');
  });
});
