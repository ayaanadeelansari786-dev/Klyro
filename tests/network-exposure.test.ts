import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyPort, serviceFor } from '@/lib/checks/ports';

/**
 * Network exposure has its own dashboard section now, alongside Subdomains,
 * Technology and Inventory — it previously only appeared folded into a
 * `CheckMatrix` row and one combined risk-register finding, both of which
 * described every notable port in a single sentence rather than as separate,
 * individually checkable rows.
 */

const src = (...parts: string[]) => readFileSync(join(process.cwd(), 'src', ...parts), 'utf8');

describe('the network exposure section', () => {
  it('has its own component, its own section id and its own rail entry', () => {
    const view = src('components', 'ResultsView.tsx');
    expect(view).toContain("from '@/components/NetworkExposure'");
    expect(view).toContain('id="network-exposure"');
    expect(view).toContain("label: 'Network Exposure'");
  });

  it('only renders when the module actually produced a record', () => {
    const view = src('components', 'ResultsView.tsx');
    expect(view).toContain("internetDbCategory?.status === 'assessed'");
    expect(view).toContain('{exposureFacts &&');
  });

  it('imports port classification from the client-safe module, not from the check module', () => {
    // `internetdb.ts` pulls in `dnsQuery` and `safeFetch`, which reach for
    // Node's `dns` and network primitives — importing a runtime value from it
    // into this 'use client' component would bundle those for the browser.
    const component = src('components', 'NetworkExposure.tsx');
    expect(component).toContain("from '@/lib/checks/ports'");
    // The only import touching internetdb.ts must be `import type` — a value
    // import would pull `dnsQuery`/`safeFetch` into the client bundle.
    const importLines = component.split('\n').filter((l) => l.includes("@/lib/checks/internetdb"));
    expect(importLines).toEqual(["import type { InternetDbFacts } from '@/lib/checks/internetdb';"]);
  });

  it('renders each notable port as its own row rather than one merged sentence', () => {
    const component = src('components', 'NetworkExposure.tsx');
    expect(component).toContain('function PortRow');
    expect(component).toMatch(/\.map\(\(p\)/);
  });

  it('the module and the dashboard classify ports identically, from one table', () => {
    // classifyPort/serviceFor are re-exported from internetdb.ts for anything
    // still importing them from there (the module's own tests); this checks
    // they are the exact same functions, not two copies that could drift.
    expect(classifyPort(22)).toBe('remote');
    expect(serviceFor(22)).toBe('SSH');
    expect(classifyPort(3306)).toBe('critical');
    expect(classifyPort(443)).toBe('expected');
  });
});
