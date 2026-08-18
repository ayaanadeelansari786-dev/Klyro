#!/usr/bin/env node
/**
 * Drives the benchmark dataset seeding run.
 *
 * Seeds parent entities first so that when a subsidiary is assessed, its
 * parent's scan already exists to measure infrastructure linkage against.
 *
 *   node scripts/seed.mjs                 # seed everything
 *   node scripts/seed.mjs --only okta.com,auth0.com
 *   node scripts/seed.mjs --concurrency 4 --label run-2026-08-13
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.KLYRO_BASE_URL ?? 'http://localhost:3000';

function readToken() {
  if (process.env.KLYRO_ADMIN_TOKEN) return process.env.KLYRO_ADMIN_TOKEN;
  try {
    const env = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
    return /^KLYRO_ADMIN_TOKEN=(.+)$/m.exec(env)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

const TOKEN = readToken();
if (!TOKEN) {
  console.error('KLYRO_ADMIN_TOKEN not found in environment or .env.local');
  process.exit(1);
}

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const only = arg('only', null)?.split(',').map((s) => s.trim());
const concurrency = Number(arg('concurrency', '3'));
const runLabel = arg('label', `run-${new Date().toISOString().slice(0, 10)}`);

const headers = { 'content-type': 'application/json', 'x-klyro-admin-token': TOKEN };

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server at ${BASE} never came up`);
}

await waitForServer();

const listRes = await fetch(`${BASE}/api/admin/seed`, { headers });
if (!listRes.ok) {
  console.error('Could not list dataset:', listRes.status, await listRes.text());
  process.exit(1);
}
const { vendors, total, parentsFirst } = await listRes.json();

const targets = only ? vendors.filter((v) => only.includes(v.domain)) : vendors;

console.log(`Klyro dataset seeding — ${runLabel}`);
console.log(`${targets.length} of ${total} vendors (${parentsFirst} parent entities first), concurrency ${concurrency}\n`);

const results = [];
const failures = [];
let done = 0;
const started = Date.now();

// Parents must complete before subsidiaries, so run them as a first phase.
const phases = only
  ? [targets]
  : [targets.filter((v) => v.isParentEntity), targets.filter((v) => !v.isParentEntity)];

for (const [phaseIndex, phase] of phases.entries()) {
  if (phase.length === 0) continue;
  if (!only) {
    console.log(`--- Phase ${phaseIndex + 1}: ${phaseIndex === 0 ? 'parent entities' : 'vendors'} (${phase.length}) ---`);
  }

  const queue = [...phase];

  async function worker() {
    for (;;) {
      const vendor = queue.shift();
      if (!vendor) return;

      try {
        const res = await fetch(`${BASE}/api/admin/seed`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ domain: vendor.domain, runLabel }),
        });
        const json = await res.json();
        done += 1;

        if (!res.ok) {
          failures.push({ domain: vendor.domain, error: json.error });
          console.log(
            `[${String(done).padStart(3)}/${targets.length}] ✗ ${vendor.domain.padEnd(30)} ${json.error}`,
          );
          continue;
        }

        results.push(json);
        const own = json.ownership?.parent ? ` · owned by ${json.ownership.parent}` : '';
        const link = json.linkageVerdict ? ` [${json.linkageVerdict}]` : '';
        const conflict = json.ownership?.conflicts?.length ? ' ⚠ conflict' : '';
        console.log(
          `[${String(done).padStart(3)}/${targets.length}] ✓ ${vendor.domain.padEnd(30)} ${String(json.compositeScore).padStart(3)} ${json.riskLevel.padEnd(14)} ${String(Math.round(json.coverage * 100)).padStart(3)}%${own}${link}${conflict}`,
        );
      } catch (err) {
        done += 1;
        failures.push({ domain: vendor.domain, error: err.message });
        console.log(`[${String(done).padStart(3)}/${targets.length}] ✗ ${vendor.domain.padEnd(30)} ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

const elapsed = ((Date.now() - started) / 1000).toFixed(0);

console.log(`\n${'='.repeat(76)}`);
console.log(`Seeded ${results.length}/${targets.length} in ${elapsed}s · label ${runLabel}`);

if (results.length > 0) {
  const scores = results.map((r) => r.compositeScore).sort((a, b) => a - b);
  const mean = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const median = scores[Math.floor(scores.length / 2)];
  console.log(`Score range ${scores[0]}–${scores[scores.length - 1]} · mean ${mean} · median ${median}`);

  const withParents = results.filter((r) => r.ownership?.parent);
  console.log(`Ownership: ${withParents.length} with an identified parent`);
  const conflicts = results.filter((r) => r.ownership?.conflicts?.length);
  if (conflicts.length) {
    console.log(`\nOwnership conflicts requiring review (${conflicts.length}):`);
    for (const c of conflicts) console.log(`  ${c.domain}: ${c.ownership.conflicts.join(' | ')}`);
  }
}

if (failures.length > 0) {
  console.log(`\nFailures (${failures.length}):`);
  for (const f of failures) console.log(`  ${f.domain}: ${f.error}`);
}
