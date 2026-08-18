import type { Severity } from '../types';

/**
 * Intelligence modules are deliberately separate from the scored checks.
 *
 * A scored check measures something Klyro observed directly about a domain. An
 * intelligence module reports what third parties have published about the
 * organisation behind it. The second kind is useful context but must never
 * move a risk score: a company can generate negative coverage for reasons that
 * say nothing about whether it is a safe vendor, and headline volume tracks
 * company size far more than company risk.
 */

export type NewsEventType = 'security' | 'legal' | 'operational' | 'corporate';

/** How much independent confirmation a story has. */
export type NewsVerification =
  /** Two or more distinct outlets published substantially the same story. */
  | 'corroborated'
  /** One outlet only — reported, but not independently confirmed. */
  | 'single-source'
  /** A press-release wire. The company is the author; this is not journalism. */
  | 'vendor-issued';

/** Editorial standing of the outlet, not of the individual story. */
export type PublisherTier = 'established' | 'specialist' | 'wire' | 'unknown';

/**
 * Whether the story appears to be *about* this organisation, or merely
 * mentions it. "Retailer breached via Vendor SSO" is a story about the
 * retailer — filing it under the vendor's incident history would be a
 * material misattribution.
 */
export type SubjectConfidence = 'primary' | 'mentioned';

export interface NewsItem {
  id: string;
  title: string;
  publisher: string;
  url: string;
  publishedAt: string | null;
  eventType: NewsEventType;
  /** Finer-grained label, e.g. "Data breach", "Regulatory action". */
  classification: string;
  severity: Severity;
  credibility: PublisherTier;
  verification: NewsVerification;
  subjectConfidence: SubjectConfidence;
  /** Other outlets that carried the same story. */
  corroboratingPublishers: string[];
}

export interface NewsIntelligence {
  domain: string;
  /** The name searched for, and how Klyro arrived at it. */
  brand: string;
  brandDerivedFrom: string;
  retrievedAt: string;
  sourceName: string;
  status: 'ok' | 'unavailable';
  error?: string;
  items: NewsItem[];
  counts: Record<NewsEventType, number>;
  /** Stories with a named, independently-confirmed source. */
  corroboratedCount: number;
  /** Stories that name the organisation but appear to be about someone else. */
  mentionOnlyCount: number;
  /**
   * What this module cannot see. Stated on every report — the absence of a
   * story is not evidence that nothing happened.
   */
  blindSpots: string[];
}
