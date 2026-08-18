import { fetchJson } from '../checks/util';
import { TOOL_VERSION } from '../constants';
import { SCANNER_INFO_URL } from '../site';

/**
 * Corporate ownership resolution.
 *
 * Automated ownership lookup is not reliable enough to publish unattended.
 * Probing showed Wikidata resolving "Okta" to the given name "Oktay", and
 * missing the LinkedIn/Microsoft relationship entirely. So the hierarchy here
 * is deliberate:
 *
 *   1. Curated facts are the authority. Each carries a named source.
 *   2. GLEIF verifies them against regulatory filings where an LEI exists.
 *      Agreement raises confidence to `confirmed`.
 *   3. Wikidata is a cross-check only, and only when the entity's own
 *      published website matches the domain being assessed — which removes
 *      the entire class of name-collision error above.
 *
 * A disagreement between sources is recorded, never silently resolved.
 */

export type OwnershipType =
  | 'independent'
  | 'subsidiary'
  | 'division'
  | 'joint_venture'
  | 'acquired'
  | 'unknown';

export type OwnershipConfidence = 'confirmed' | 'reported' | 'inferred' | 'unknown';

export interface OwnershipSource {
  name: string;
  url?: string;
  agrees: boolean;
  detail: string;
}

export interface OwnershipRecord {
  domain: string;
  ownershipType: OwnershipType;
  parentName: string | null;
  parentDomain: string | null;
  ultimateParentName: string | null;
  legalName: string | null;
  lei: string | null;
  hqCountry: string | null;
  confidence: OwnershipConfidence;
  sources: OwnershipSource[];
  /** Populated when sources contradict each other. */
  conflicts: string[];
}

/** The curated facts a dataset entry may assert about ownership. */
export interface CuratedOwnership {
  legalName?: string;
  ownershipType?: OwnershipType;
  parentName?: string;
  parentDomain?: string;
  ultimateParentName?: string;
  hqCountry?: string;
  /** Where the curator got this from. */
  source?: string;
  sourceUrl?: string;
}

const UA = `KlyroDueDiligence/${TOOL_VERSION} (+${SCANNER_INFO_URL})`;
const JSON_HEADERS = { accept: 'application/json', 'user-agent': UA };

/* ------------------------------------------------------------------ *
 * GLEIF — Legal Entity Identifier registry (authoritative, keyless)
 * ------------------------------------------------------------------ */

interface GleifRecord {
  id?: string;
  attributes?: {
    entity?: {
      legalName?: { name?: string };
      legalAddress?: { country?: string };
    };
  };
}

function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|incorporated|corp|corporation|ltd|limited|llc|plc|gmbh|ag|sa|nv|bv|as|oy|ab|pte|pty|holdings?|group|co)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface GleifResult {
  lei: string;
  legalName: string;
  country: string | null;
  directParent: string | null;
  ultimateParent: string | null;
}

async function queryGleif(legalName: string): Promise<GleifResult | null> {
  const search = await fetchJson<{ data?: GleifRecord[] }>(
    `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${encodeURIComponent(legalName)}&page[size]=3`,
    { headers: { accept: 'application/vnd.api+json', 'user-agent': UA } },
    10_000,
  );

  const wanted = normaliseName(legalName);

  // GLEIF's name filter is fuzzy — "Robert Bosch GmbH" matched a hospital
  // company in the Dominican Republic during testing. Only accept a record
  // whose normalised legal name actually matches what we asked for.
  const record = (search?.data ?? []).find((r) => {
    const got = r.attributes?.entity?.legalName?.name;
    return got ? normaliseName(got) === wanted : false;
  });

  if (!record?.id) return null;

  const parentOf = async (rel: 'direct-parent' | 'ultimate-parent'): Promise<string | null> => {
    const res = await fetchJson<{ data?: GleifRecord }>(
      `https://api.gleif.org/api/v1/lei-records/${record.id}/${rel}`,
      { headers: { accept: 'application/vnd.api+json', 'user-agent': UA } },
      10_000,
    );
    return res?.data?.attributes?.entity?.legalName?.name ?? null;
  };

  const [directParent, ultimateParent] = await Promise.all([
    parentOf('direct-parent'),
    parentOf('ultimate-parent'),
  ]);

  return {
    lei: record.id,
    legalName: record.attributes?.entity?.legalName?.name ?? legalName,
    country: record.attributes?.entity?.legalAddress?.country ?? null,
    directParent,
    ultimateParent,
  };
}

/* ------------------------------------------------------------------ *
 * Wikidata — cross-check only, gated on website match
 * ------------------------------------------------------------------ */

const WD = 'https://www.wikidata.org/w/api.php';

interface WikidataClaim {
  mainsnak?: { datavalue?: { value?: { id?: string } | string } };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

async function queryWikidata(
  displayName: string,
  domain: string,
): Promise<{ parents: string[]; entityId: string } | null> {
  const search = await fetchJson<{ search?: { id: string; label: string }[] }>(
    `${WD}?action=wbsearchentities&search=${encodeURIComponent(displayName)}&language=en&type=item&limit=5&format=json`,
    { headers: JSON_HEADERS },
    10_000,
  );

  const candidates = (search?.search ?? []).map((s) => s.id);
  if (candidates.length === 0) return null;

  const entities = await fetchJson<{
    entities?: Record<string, { claims?: Record<string, WikidataClaim[]> }>;
  }>(
    `${WD}?action=wbgetentities&ids=${candidates.join('|')}&props=claims&languages=en&format=json`,
    { headers: JSON_HEADERS },
    10_000,
  );

  // Accept only an entity whose own published website matches this domain.
  let matched: string | null = null;
  for (const id of candidates) {
    const claims = entities?.entities?.[id]?.claims ?? {};
    const site = claims['P856']?.[0]?.mainsnak?.datavalue?.value;
    if (typeof site === 'string') {
      const host = hostOf(site);
      if (host && (host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`))) {
        matched = id;
        break;
      }
    }
  }

  if (!matched) return null;

  const claims = entities?.entities?.[matched]?.claims ?? {};

  /*
   * Only P749 ("parent organization") is used. P127 ("owned by") looked like
   * an obvious second source but returns *shareholders* for public companies:
   * the first seeding run produced "Uber owned by Morgan Stanley", "Tesla
   * owned by Elon Musk", "Shell owned by BlackRock" and "Nestlé owned by
   * treasury stock". An institutional holding is not a corporate parent, and
   * publishing it as one in a due-diligence report would be badly misleading.
   */
  const parentIds = (claims['P749'] ?? [])
    .map((c) => (typeof c.mainsnak?.datavalue?.value === 'object' ? c.mainsnak?.datavalue?.value?.id : null))
    .filter((id): id is string => Boolean(id));

  if (parentIds.length === 0) return { parents: [], entityId: matched };

  const parents = await fetchJson<{
    entities?: Record<string, { labels?: { en?: { value?: string } } }>;
  }>(
    `${WD}?action=wbgetentities&ids=${[...new Set(parentIds)].slice(0, 4).join('|')}&props=labels&languages=en&format=json`,
    { headers: JSON_HEADERS },
    10_000,
  );

  const self = normaliseName(displayName);
  const labels = [...new Set(parentIds)]
    .slice(0, 4)
    .map((id) => parents?.entities?.[id]?.labels?.en?.value)
    .filter((l): l is string => Boolean(l))
    // Wikidata models some groups as their own parent ("Siemens" -> "Siemens",
    // "Broadcom" -> "Broadcom"). A company is not its own conglomerate.
    .filter((l) => normaliseName(l) !== self && normaliseName(l).length > 0);

  return { parents: labels, entityId: matched };
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

export async function resolveOwnership(
  domain: string,
  displayName: string,
  curated: CuratedOwnership = {},
): Promise<OwnershipRecord> {
  const sources: OwnershipSource[] = [];
  const conflicts: string[] = [];

  const record: OwnershipRecord = {
    domain,
    ownershipType: curated.ownershipType ?? 'unknown',
    parentName: curated.parentName ?? null,
    parentDomain: curated.parentDomain ?? null,
    ultimateParentName: curated.ultimateParentName ?? curated.parentName ?? null,
    legalName: curated.legalName ?? null,
    lei: null,
    hqCountry: curated.hqCountry ?? null,
    confidence: 'unknown',
    sources,
    conflicts,
  };

  if (curated.parentName || curated.ownershipType) {
    // `name` is the source, `detail` is what that source says. Keeping the
    // curated basis statement out of the name stops the report rendering
    // "Sourced from Microsoft acquired GitHub in 2018".
    sources.push({
      name: 'Klyro curated dataset',
      url: curated.sourceUrl,
      agrees: true,
      detail:
        curated.source ??
        (curated.parentName
          ? `Recorded as ${curated.ownershipType ?? 'subsidiary'} of ${curated.parentName}.`
          : 'Recorded as an independent entity.'),
    });
    record.confidence = 'reported';
  }

  /* --- GLEIF verification --- */
  if (curated.legalName) {
    try {
      const gleif = await queryGleif(curated.legalName);
      if (gleif) {
        record.lei = gleif.lei;
        record.hqCountry = record.hqCountry ?? gleif.country;

        if (gleif.directParent) {
          const agrees =
            !curated.parentName ||
            normaliseName(gleif.directParent).includes(normaliseName(curated.parentName)) ||
            normaliseName(curated.parentName).includes(normaliseName(gleif.directParent));

          sources.push({
            name: 'GLEIF (Global LEI Foundation)',
            url: `https://search.gleif.org/#/record/${gleif.lei}`,
            agrees,
            detail: `LEI ${gleif.lei} records a direct parent of ${gleif.directParent}${
              gleif.ultimateParent && gleif.ultimateParent !== gleif.directParent
                ? ` and an ultimate parent of ${gleif.ultimateParent}`
                : ''
            }.`,
          });

          if (agrees) {
            record.confidence = 'confirmed';
            record.ultimateParentName = gleif.ultimateParent ?? record.ultimateParentName;
            record.parentName = record.parentName ?? gleif.directParent;
            if (record.ownershipType === 'unknown') record.ownershipType = 'subsidiary';
          } else {
            conflicts.push(
              `Curated parent "${curated.parentName}" does not match GLEIF's recorded parent "${gleif.directParent}".`,
            );
          }
        } else {
          sources.push({
            name: 'GLEIF (Global LEI Foundation)',
            url: `https://search.gleif.org/#/record/${gleif.lei}`,
            agrees: !curated.parentName,
            detail: `LEI ${gleif.lei} exists with no parent relationship filed, which is consistent with an independent entity.`,
          });
          if (!curated.parentName) {
            record.ownershipType = curated.ownershipType ?? 'independent';
            record.confidence = 'confirmed';
          } else {
            conflicts.push(
              `Curated data records a parent (${curated.parentName}) but GLEIF has no parent relationship filed for this entity. Parent filings are only mandatory in some jurisdictions, so this is not necessarily a contradiction.`,
            );
          }
        }
      }
    } catch {
      /* GLEIF unavailable — curated data stands on its own. */
    }
  }

  /* --- Wikidata cross-check --- */
  try {
    const wd = await queryWikidata(displayName, domain);
    if (wd) {
      if (wd.parents.length > 0) {
        const agrees =
          !curated.parentName ||
          wd.parents.some(
            (p) =>
              normaliseName(p).includes(normaliseName(curated.parentName as string)) ||
              normaliseName(curated.parentName as string).includes(normaliseName(p)),
          );

        sources.push({
          name: 'Wikidata',
          url: `https://www.wikidata.org/wiki/${wd.entityId}`,
          agrees,
          detail: `Lists ${wd.parents.join(', ')} as parent or owner.`,
        });

        if (!agrees) {
          conflicts.push(
            `Wikidata lists ${wd.parents.join(', ')} as owner, which does not match the curated parent "${curated.parentName}".`,
          );
        } else if (record.confidence === 'unknown') {
          record.confidence = 'reported';
          record.parentName = record.parentName ?? wd.parents[0];
          if (record.ownershipType === 'unknown') record.ownershipType = 'subsidiary';
        }
      } else if (!curated.parentName) {
        sources.push({
          name: 'Wikidata',
          url: `https://www.wikidata.org/wiki/${wd.entityId}`,
          agrees: true,
          detail: 'Records no parent organisation or owner.',
        });
      }
    }
  } catch {
    /* Wikidata unavailable — it is a cross-check, not a dependency. */
  }

  if (record.ownershipType === 'unknown' && !record.parentName) {
    record.ownershipType = 'unknown';
  }

  return record;
}
