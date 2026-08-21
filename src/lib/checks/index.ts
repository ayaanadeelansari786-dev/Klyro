import type { CategoryKey } from '../types';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../constants';
import type { ModuleOutput } from './util';

import { checkDns } from './dns';
import { checkSubdomains } from './subdomains';
import { checkSsl } from './ssl';
import { checkHeaders } from './headers';
import { checkEmailSecurity } from './email-security';
import { checkWhois } from './whois';
import { checkExposedPaths } from './exposed-paths';
import { checkCookies } from './cookies';
import { checkCors } from './cors';
import { checkRobotsSecurity } from './robots-sitemap';
import { checkTechnologies } from './technologies';
import { checkInternetDB } from './internetdb';

export type CheckFn = (domain: string) => Promise<ModuleOutput>;

export const CHECKS: Record<CategoryKey, CheckFn> = {
  dns: checkDns,
  subdomains: checkSubdomains,
  ssl: checkSsl,
  headers: checkHeaders,
  emailSecurity: checkEmailSecurity,
  whois: checkWhois,
  exposedPaths: checkExposedPaths,
  cookies: checkCookies,
  cors: checkCors,
  robotsSecurity: checkRobotsSecurity,
  technologies: checkTechnologies,
  internetdb: checkInternetDB,
};

/** Execution order used by the progress UI — most material checks first. */
export const CHECK_ORDER: CategoryKey[] = CATEGORY_ORDER;

/**
 * Per-module wall-clock budget. crt.sh returns very large result sets for
 * well-known domains and is the slowest source by a wide margin; the rest are
 * comfortable inside the default.
 */
const DEFAULT_MODULE_TIMEOUT_MS = 14_000;

const MODULE_TIMEOUTS: Partial<Record<CategoryKey, number>> = {
  // Raised from 24s when host fingerprinting was added: the certificate
  // harvest is unchanged, but up to thirty hosts now get a GET on top of it.
  subdomains: 32_000,
  ssl: 20_000,
  exposedPaths: 22_000,
  technologies: 16_000,
  // One DNS lookup plus one HTTPS request to a fast API — measured at well
  // under a second. 10s is headroom for a slow resolver, not an expectation.
  internetdb: 10_000,
};

export function timeoutFor(key: CategoryKey): number {
  return MODULE_TIMEOUTS[key] ?? DEFAULT_MODULE_TIMEOUT_MS;
}

export const MODULE_MANIFEST = CHECK_ORDER.map((key) => ({
  key,
  label: CATEGORY_LABELS[key],
}));

export {
  checkDns,
  checkSubdomains,
  checkSsl,
  checkHeaders,
  checkEmailSecurity,
  checkWhois,
  checkExposedPaths,
  checkCookies,
  checkCors,
  checkRobotsSecurity,
  checkTechnologies,
  checkInternetDB,
};
