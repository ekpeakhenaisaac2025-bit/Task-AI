import type { Request, Response, NextFunction } from 'express';

export class RateLimitExceededError extends Error {
  public readonly retryAfterSeconds: number;
  public readonly bucketKey: string;

  constructor(message: string, retryAfterSeconds: number, bucketKey: string) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    this.bucketKey = bucketKey;
  }
}

interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

const MAX_TRACKED_KEYS = 10_000;
const buckets = new Map<string, TokenBucketState>();

export interface RateLimitCheckParams {
  key: string;
  requestsPerMinute: number;
  burstLimit: number;
  cost?: number;
  nowMs?: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  remainingTokens: number;
  retryAfterSeconds: number;
}

function evictOldestIfNeeded(nowMs: number): void {
  if (buckets.size < MAX_TRACKED_KEYS) return;
  const staleCutoff = nowMs - 10 * 60 * 1000;
  for (const [k, v] of buckets) {
    if (v.lastRefillMs < staleCutoff) {
      buckets.delete(k);
    }
    if (buckets.size < MAX_TRACKED_KEYS * 0.8) break;
  }
  if (buckets.size >= MAX_TRACKED_KEYS) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey !== undefined) {
      buckets.delete(oldestKey);
    }
  }
}

/**
 * Deterministic token-bucket rate limiter supporting burst capacity and sustained RPM replenishment.
 */
export function checkRateLimit(
  params: RateLimitCheckParams
): RateLimitCheckResult {
  const {
    key,
    requestsPerMinute,
    burstLimit,
    cost = 1,
    nowMs = Date.now(),
  } = params;

  const capacity = Math.max(1, burstLimit);
  const refillPerMs = Math.max(1, requestsPerMinute) / 60_000;

  let state = buckets.get(key);
  if (!state) {
    evictOldestIfNeeded(nowMs);
    state = {
      tokens: capacity,
      lastRefillMs: nowMs,
    };
  } else {
    const elapsedMs = Math.max(0, nowMs - state.lastRefillMs);
    state.tokens = Math.min(capacity, state.tokens + elapsedMs * refillPerMs);
    state.lastRefillMs = nowMs;
  }

  if (state.tokens >= cost) {
    state.tokens -= cost;
    buckets.set(key, state);
    return {
      allowed: true,
      remainingTokens: Math.floor(state.tokens),
      retryAfterSeconds: 0,
    };
  }

  buckets.set(key, state);
  const deficit = cost - state.tokens;
  const retryAfterSeconds = Math.max(1, Math.ceil(deficit / (refillPerMs * 1000)));
  return {
    allowed: false,
    remainingTokens: 0,
    retryAfterSeconds,
  };
}

export function assertWithinRateLimit(
  params: RateLimitCheckParams & { label?: string }
): void {
  const res = checkRateLimit(params);
  if (!res.allowed) {
    throw new RateLimitExceededError(
      `Rate limit exceeded for ${params.label || params.key}. Retry after ${res.retryAfterSeconds}s.`,
      res.retryAfterSeconds,
      params.key
    );
  }
}

export function resetRateLimiterForTests(): void {
  buckets.clear();
}

export function createExpressRateLimitMiddleware(options: {
  namespace: string;
  requestsPerMinute: number;
  burstLimit: number;
  keyExtractor?: (req: Request) => string;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const subKey = options.keyExtractor
      ? options.keyExtractor(req)
      : req.ip || req.socket.remoteAddress || 'anon';
    const check = checkRateLimit({
      key: `http:${options.namespace}:${subKey}`,
      requestsPerMinute: options.requestsPerMinute,
      burstLimit: options.burstLimit,
    });
    res.setHeader('X-RateLimit-Remaining', String(check.remainingTokens));
    if (!check.allowed) {
      res.setHeader('Retry-After', String(check.retryAfterSeconds));
      return res.status(429).json({
        error: `Too many requests (${options.namespace}). Please retry after ${check.retryAfterSeconds}s.`,
        retryAfterSeconds: check.retryAfterSeconds,
      });
    }
    return next();
  };
}
