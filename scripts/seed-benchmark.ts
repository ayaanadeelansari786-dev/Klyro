/**
 * Seeds the benchmark corpus by re-running curated vendors through the admin
 * endpoint.
 *
 *   npx tsx scripts/seed-benchmark.ts                     # every curated vendor
 *   npx tsx scripts/seed-benchmark.ts --region UAE        # one region
 *   npx tsx scripts/seed-benchmark.ts --region UAE --industry "Banking & Finance"
 *   npx tsx scripts/seed-benchmark.ts --dry-run           # plan only, no requests
 *
 * Environment:
 *   KLYRO_ADMIN_TOKEN   required (sent as `x-klyro-admin-token`)
 *   KLYRO_URL           defaults to the production deployment
 *
 * Three things about `/api/admin/seed` that a caller has to get right, all of
 * which are easy to get wrong from the outside:
 *
 * 1. It authenticates on the `x-klyro-admin-token` header. A `Bearer` token in
 *    `Authorization` is ignored and every request comes back 401.
 * 2. The body is `{ domain, runLabel? }` and nothing else. Industry and region
 *    are *not* accepted — they are read from the curated dataset, so that a
 *    seeded sample cannot be filed under a category the corpus disagrees with.
 * 3. A domain that is not in `VENDOR_SEEDS` returns 404. The endpoint seeds the
 *    reference corpus; it is not a way to scan arbitrary domains into it.
 *
 * So this script takes its list *from* the curated dataset rather than carrying
 * its own, and validates the plan before opening a single connection.
 */

import { MIN_BENCHMARK_SAMPLES } from '../src/lib/constants';
import { VENDOR_SEEDS } from '../src/lib/dataset/vendors';

const BASE_URL = (process.env.KLYRO_URL ?? 'https://klyro-alpha-gold.vercel.app').replace(/\/$/, '');
const TOKEN = process.env.KLYRO_ADMIN_TOKEN;

/** Each seed runs a full assessment server-side; four at once is plenty. */
const CONCURRENCY = 4;
const PAUSE_MS = 2_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const wantRegion = arg('region');
const wantIndustry = arg('industry');
const dryRun = process.argv.includes('--dry-run');

const targets = VENDOR_SEEDS.filter(
  (v) =>
    (!wantRegion || v.region === wantRegion) && (!wantIndustry || v.industry === wantIndustry),
);

/**
 * What each pool can reach, which is not the same as how many rows are written.
 *
 * `buildBenchmark` keeps one row per domain — "one domain, one vote", so that
 * re-seeding the same list three times cannot inflate a pool. That makes the
 * ceiling for any pool the number of *distinct curated domains* in it, and no
 * amount of re-running moves it. Printing this before the run is the difference
 * between finding that out now and finding it out after forty live scans.
 */
function poolReport() {
  const pools = new Map<string, Set<string>>();
  for (const v of targets) {
    const key = `${v.industry} / ${v.region}`;
    if (!pools.has(key)) pools.set(key, new Set());
    pools.get(key)!.add(v.domain.toLowerCase());
  }

  const rows = [...pools.entries()]
    .map(([pool, domains]) => ({ pool, distinct: domains.size }))
    .sort((a, b) => b.distinct - a.distinct);

  console.log(`\nPools in this run (threshold is ${MIN_BENCHMARK_SAMPLES} distinct domains):\n`);
  for (const { pool, distinct } of rows) {
    const mark = distinct >= MIN_BENCHMARK_SAMPLES ? 'OK  ' : 'SHORT';
    const gap = distinct >= MIN_BENCHMARK_SAMPLES ? '' : ` — needs ${MIN_BENCHMARK_SAMPLES - distinct} more curated domains`;
    console.log(`  ${mark}  ${pool}: ${distinct}${gap}`);
  }

  const short = rows.filter((r) => r.distinct < MIN_BENCHMARK_SAMPLES);
  if (short.length) {
    console.log(
      `\n  ${short.length} pool(s) cannot reach the threshold by seeding. The pool is\n` +
        '  deduplicated by domain, so this is a dataset gap, not a seeding gap:\n' +
        '  new vendors have to be added to src/lib/dataset/vendors.ts first.',
    );
  }
}

async function seedOne(domain: string, runLabel: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/admin/seed`, {
      method: 'POST',
      headers: {
        // Not `Authorization: Bearer`. See the note at the top of this file.
        'x-klyro-admin-token': TOKEN!,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ domain, runLabel }),
    });

    if (res.ok) {
      console.log(`  ok      ${domain}`);
      return true;
    }

    // The endpoint's error body is the useful part — 404 means "not curated",
    // 503 means Supabase is not configured on that deployment, and the two
    // want completely different responses from whoever is running this.
    const detail = await res.text().catch(() => '');
    console.log(`  FAILED  ${domain} — ${res.status} ${detail.slice(0, 160)}`);
    return false;
  } catch (error) {
    console.log(`  FAILED  ${domain} — ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main() {
  console.log(`Klyro benchmark seeding`);
  console.log(`  target:   ${BASE_URL}`);
  console.log(`  filter:   ${wantIndustry ?? 'all industries'} / ${wantRegion ?? 'all regions'}`);
  console.log(`  vendors:  ${targets.length} curated`);

  if (targets.length === 0) {
    console.log('\nNothing matches that filter. Check the spelling against INDUSTRIES/REGIONS.');
    process.exitCode = 1;
    return;
  }

  poolReport();

  if (dryRun) {
    console.log('\n--dry-run: no requests made.');
    return;
  }

  if (!TOKEN) {
    console.log('\nKLYRO_ADMIN_TOKEN is not set. Nothing was sent.');
    process.exitCode = 1;
    return;
  }

  const runLabel = `seed-${new Date().toISOString().slice(0, 10)}`;
  console.log(`\nSeeding as run label "${runLabel}":\n`);

  let ok = 0;
  const failed: string[] = [];

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((v) => seedOne(v.domain, runLabel)));
    results.forEach((success, j) => {
      if (success) ok += 1;
      else failed.push(batch[j].domain);
    });
    if (i + CONCURRENCY < targets.length) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  console.log(`\n${ok} seeded, ${failed.length} failed.`);
  if (failed.length) console.log(`Failed: ${failed.join(', ')}`);
  if (failed.length) process.exitCode = 1;
}

void main();
