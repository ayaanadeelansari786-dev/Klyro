/**
 * Port classification, standalone.
 *
 * Pulled out of `internetdb.ts` so it can be imported from the dashboard —
 * `NetworkExposure.tsx` runs in the browser, and `internetdb.ts` itself pulls
 * in `dnsQuery` and `safeFetch`, which reach for Node's `dns` and network
 * primitives. Importing anything from that file into a client component would
 * bundle those into the browser build, or fail to build at all. This file has
 * no I/O and no server-only dependency, so both sides can share one table
 * instead of the dashboard keeping its own copy to drift from the module's.
 */

/** Data stores. Reachable from the internet, these are the serious ones. */
export const CRITICAL_PORTS: Record<number, string> = {
  3306: 'MySQL',
  5432: 'PostgreSQL',
  27017: 'MongoDB',
  6379: 'Redis',
  1433: 'Microsoft SQL Server',
  9200: 'Elasticsearch',
  5984: 'CouchDB',
  11211: 'Memcached',
  9042: 'Cassandra',
  1521: 'Oracle Database',
};

/** Remote access and administration. */
export const REMOTE_PORTS: Record<number, string> = {
  22: 'SSH',
  23: 'Telnet',
  3389: 'Remote Desktop',
  5900: 'VNC',
  5985: 'WinRM over HTTP',
  5986: 'WinRM over HTTPS',
  2375: 'Docker Engine API',
  2379: 'etcd',
  445: 'SMB',
  135: 'MSRPC',
};

/** Administrative or secondary web surfaces. Worth naming, not alarming. */
export const ADMIN_WEB_PORTS: Record<number, string> = {
  8080: 'HTTP alternate',
  8000: 'HTTP alternate',
  8888: 'HTTP alternate',
  7001: 'WebLogic',
  9090: 'Admin console',
  10000: 'Webmin',
  15672: 'RabbitMQ management',
};

/**
 * Ports that mean nothing on a normal public host.
 *
 * 80 and 443 answer on every website. 53 answers on every name server. The
 * 2052–2087 block and 8443/8880 are Cloudflare's standard alternate HTTP and
 * HTTPS ports, so *every* Cloudflare-fronted domain publishes them — flagging
 * those would put an identical finding on a large fraction of the corpus and
 * teach readers to skip this section.
 */
export const EXPECTED_PORTS = new Set([
  80, 443, 53, 25, 587, 465, 993, 995, 110, 143, 21,
  2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8443, 8880,
]);

export type PortClass = 'critical' | 'remote' | 'admin-web' | 'expected' | 'other';

export function classifyPort(port: number): PortClass {
  if (port in CRITICAL_PORTS) return 'critical';
  if (port in REMOTE_PORTS) return 'remote';
  if (port in ADMIN_WEB_PORTS) return 'admin-web';
  if (EXPECTED_PORTS.has(port)) return 'expected';
  return 'other';
}

export function serviceFor(port: number): string | null {
  return CRITICAL_PORTS[port] ?? REMOTE_PORTS[port] ?? ADMIN_WEB_PORTS[port] ?? null;
}
