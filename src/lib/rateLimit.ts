import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from './constants';

/**
 * Rate limiting and concurrency control.
 *
 * Two implementations behind one interface. Upstash Redis is the real one:
 * it is shared, so every serverless instance consults the same counters, and
 * it survives a redeploy. The in-memory maps below are the fallback, and they
 * are kept deliberately rather than left as dead code — Klyro runs without a
 * database and without Upstash, and `npm run dev` on a fresh checkout has to
 * work with neither. Degraded mode is a supported mode, not a bug.
 *
 * Which one is active is decided once, at module load, by whether the two
 * Upstash variables are set. The fallback is also the failure path: a Redis
 * call that throws mid-request falls through to the in-memory implementation
 * rather than failing the request, because an Upstash outage taking down every
 * scan is a worse outcome than an hour of per-instance limiting.
 *
 * What the fallback cannot do, and what the whole change is for:
 *
 * - It resets on every deploy, so an attacker who watches for a deploy gets a
 *   fresh window immediately after one.
 * - It does not coordinate across instances, so the effective limit is the
 *   configured limit multiplied by however many Vercel instances are warm.
 * - Its bucket map is itself a target, which is why it needs the eviction
 *   logic further down and Redis does not.
 */

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? '';
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

/** Null when Upstash is not configured. Every caller handles that case. */
const redis: Redis | null =
  redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : null;

export const isDistributedRateLimitConfigured = redis !== null;

/* ------------------------------------------------------------------ *
 * Distributed limiter
 * ------------------------------------------------------------------ */

/**
 * One `Ratelimit` per (max, window) pair.
 *
 * The limit is baked into a `Ratelimit` instance at construction, and Klyro
 * calls `consumeRateLimit` with eight different ceilings — 10 for scans, 30
 * for reports, 120 for the read-only endpoints. Rather than hard-coding two
 * limiters and leaving the other six unprotected, they are built on demand and
 * cached here.
 *
 * The prefix carries the limit, so two endpoints sharing an identity but not a
 * ceiling do not share a counter. The identifier passed in already carries its
 * own namespace (`scan:`, `report:`), so the resulting Redis key is
 * `klyro:rl:10:3600:scan:203.0.113.9`.
 */
const limiters = new Map<string, Ratelimit>();

function limiterFor(max: number, windowMs: number): Ratelimit | null {
  if (!redis) return null;

  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));
  const cacheKey = `${max}:${windowSeconds}`;

  const existing = limiters.get(cacheKey);
  if (existing) return existing;

  const limiter = new Ratelimit({
    redis,
    // Sliding rather than fixed: a fixed window lets a caller spend the whole
    // allowance at 59:59 and the whole next allowance at 60:01.
    limiter: Ratelimit.slidingWindow(max, `${windowSeconds} s`),
    prefix: `klyro:rl:${cacheKey}`,
    // Off: it costs an extra round trip and a second set of Redis keys, and
    // nothing in Klyro reads the dashboard it feeds.
    analytics: false,
  });

  limiters.set(cacheKey, limiter);
  return limiter;
}

/* ------------------------------------------------------------------ *
 * In-memory fallback
 * ------------------------------------------------------------------ */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

/**
 * Maximum distinct identities tracked at once.
 *
 * Beyond this the oldest are evicted. Eviction gives an attacker a way to
 * clear their own record by flooding with fresh identities, which is a real
 * weakness and one of the reasons Redis is preferred where it is available.
 */
const MAX_BUCKETS = 20_000;

let lastSweep = Date.now();

/** Drops expired hits, and evicts wholesale if the map is being used as a lever. */
function sweep(now: number, force = false) {
  if (!force && now - lastSweep < 60_000) return;
  lastSweep = now;

  for (const [key, bucket] of buckets) {
    bucket.hits = bucket.hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (bucket.hits.length === 0) buckets.delete(key);
  }

  if (buckets.size > MAX_BUCKETS) {
    // Map iteration is insertion-ordered, so this drops the least recently
    // created entries first.
    const excess = buckets.size - MAX_BUCKETS;
    let removed = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++removed >= excess) break;
    }
  }
}

function consumeInMemory(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now, buckets.size > MAX_BUCKETS);

  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

  if (bucket.hits.length >= max) {
    buckets.set(key, bucket);
    const oldest = bucket.hits[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);

  return { allowed: true, remaining: max - bucket.hits.length, retryAfterSeconds: 0 };
}

/* ------------------------------------------------------------------ *
 * Public limiter
 * ------------------------------------------------------------------ */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Spends one unit of `key`'s allowance.
 *
 * Async because the shared counter lives over HTTP. Every caller is already
 * inside an async route handler, so this costs an `await` and no restructuring.
 */
export async function consumeRateLimit(
  key: string,
  max: number = RATE_LIMIT_MAX,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
): Promise<RateLimitResult> {
  const limiter = limiterFor(max, windowMs);

  if (limiter) {
    try {
      const verdict = await limiter.limit(key);
      return {
        allowed: verdict.success,
        remaining: Math.max(0, verdict.remaining),
        retryAfterSeconds: verdict.success
          ? 0
          : Math.max(1, Math.ceil((verdict.reset - Date.now()) / 1000)),
      };
    } catch {
      // Redis unreachable. Fall through rather than failing the request: a
      // per-instance limit is a great deal better than none, and better than
      // refusing every scan for the duration of somebody else's outage.
    }
  }

  return consumeInMemory(key, max, windowMs);
}

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

/**
 * How many full scans may run at once across the deployment.
 *
 * A scan runs eleven modules at a concurrency of four, and the heavier ones
 * open well over a hundred sockets between them. The per-identity limit
 * permits ten scans an hour *each*, so a burst from a modest number of
 * addresses is entirely within the rules and still enough to exhaust the
 * instance. This is the backstop for that, and it deliberately does not
 * consider identity — an attacker rotating addresses does not get to raise it.
 *
 * On Redis this is now a deployment-wide ceiling rather than a per-instance
 * one, which is the difference between "six scans at a time" and "six scans
 * at a time per warm Vercel instance".
 */
const MAX_CONCURRENT_SCANS = 6;

const ACTIVE_SCANS_KEY = 'klyro:active_scans';

/**
 * How long a held slot may go unreleased before it is assumed abandoned.
 *
 * A serverless function that is killed mid-scan never runs its `finally`, so
 * without this a crash would consume a slot for the life of the Redis key.
 * Sized above the 60-second `maxDuration` on the scan route with headroom.
 */
const SLOT_STALE_MS = 90_000;

/**
 * Take a slot, atomically.
 *
 * The obvious three-step version — prune, count, add — has a race: two
 * instances can both read five and both write, and the ceiling is quietly a
 * seven. Doing it in one script removes the window rather than documenting it,
 * which is worth the six lines given this is the gate protecting the whole
 * deployment from a burst.
 *
 * Returns the new active count, or -1 when the ceiling was already reached.
 */
const ACQUIRE_SCRIPT = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
  local active = redis.call('ZCARD', KEYS[1])
  if active >= tonumber(ARGV[2]) then
    return -1
  end
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return active + 1
`;

/** In-memory counterpart, used when Redis is absent or unreachable. */
let activeScans = 0;

export interface ScanSlot {
  granted: boolean;
  /** Number in flight at the moment the request arrived. */
  active: number;
  /**
   * Idempotent. The scan route releases from a `finally` inside a stream
   * handler, and a client that disconnects mid-scan can otherwise take the
   * slot with it and leak capacity.
   */
  release: () => Promise<void>;
}

const REFUSED: Omit<ScanSlot, 'active'> = {
  granted: false,
  release: async () => undefined,
};

export async function acquireScanSlot(): Promise<ScanSlot> {
  if (redis) {
    try {
      const now = Date.now();
      const token = `${now}-${Math.random().toString(36).slice(2, 10)}`;

      const active = (await redis.eval(
        ACQUIRE_SCRIPT,
        [ACTIVE_SCANS_KEY],
        [
          String(now - SLOT_STALE_MS),
          String(MAX_CONCURRENT_SCANS),
          String(now),
          token,
          String(Math.ceil(SLOT_STALE_MS / 1000) * 2),
        ],
      )) as number;

      if (active === -1) {
        return { ...REFUSED, active: MAX_CONCURRENT_SCANS };
      }

      let released = false;
      return {
        granted: true,
        active,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await redis.zrem(ACTIVE_SCANS_KEY, token);
          } catch {
            // The stale-score prune in ACQUIRE_SCRIPT reclaims it within
            // SLOT_STALE_MS, so a failed release costs capacity briefly rather
            // than permanently. Nothing useful to do here.
          }
        },
      };
    } catch {
      // Fall through to the in-memory gate.
    }
  }

  if (activeScans >= MAX_CONCURRENT_SCANS) {
    return { ...REFUSED, active: activeScans };
  }

  activeScans += 1;
  let released = false;

  return {
    granted: true,
    active: activeScans,
    release: async () => {
      if (released) return;
      released = true;
      activeScans = Math.max(0, activeScans - 1);
    },
  };
}

/** Exposed for tests and for a future health endpoint. */
export async function activeScanCount(): Promise<number> {
  if (redis) {
    try {
      await redis.zremrangebyscore(ACTIVE_SCANS_KEY, 0, Date.now() - SLOT_STALE_MS);
      return await redis.zcard(ACTIVE_SCANS_KEY);
    } catch {
      /* Fall through to the local count. */
    }
  }
  return activeScans;
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * Best-effort client identity from proxy headers.
 *
 * These headers are only trustworthy behind a proxy that overwrites them.
 * Vercel does; a self-hosted deployment behind nothing does not, and there a
 * caller can put whatever they like in `x-forwarded-for` and get a fresh
 * bucket per request. That is the reason the concurrency gate exists and does
 * not consult this function.
 */
export function clientKey(request: Request): string {
  const headers = request.headers;
  const forwarded = headers.get('x-forwarded-for');
  const candidate =
    forwarded?.split(',')[0]?.trim() ||
    headers.get('x-real-ip') ||
    headers.get('cf-connecting-ip') ||
    'unknown';

  // A header is caller-controlled input; cap it so it cannot be used to grow
  // the map with megabyte-long keys.
  return candidate.slice(0, 64);
}
