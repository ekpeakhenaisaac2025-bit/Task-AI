import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { getOrCreateUser } from '../db/users.ts';
import {
  EnvConfigError,
  resolveSessionHmacKey,
  type EnvResolutionOptions,
} from '../server/env-config.ts';
import type { AuthSessionUser } from '../types.ts';

export const ISOLATED_COOKIE_NAME = 'taskai_session';

export interface AuthRequest extends Request {
  authUser?: AuthSessionUser;
}

export const DEFAULT_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function createSignedIsolatedToken(
  uid: string,
  email: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions,
  maxAgeMs: number = DEFAULT_SESSION_MAX_AGE_MS,
  nowMs: number = Date.now()
): string {
  const { key } = resolveSessionHmacKey(env, options);
  const exp = nowMs + maxAgeMs;
  const payload = Buffer.from(
    JSON.stringify({
      uid,
      email,
      iat: nowMs,
      exp,
    }),
    'utf8'
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', key)
    .update(payload)
    .digest('base64url');
  return `iso.${payload}.${sig}`;
}

export function createSignedSessionToken(
  params: {
    uid: string;
    email: string;
    authMode: 'google' | 'isolated_session';
    maxAgeMs?: number;
    nowMs?: number;
  },
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions
): string {
  const { key } = resolveSessionHmacKey(env, options);
  const iat = params.nowMs ?? Date.now();
  const exp = iat + (params.maxAgeMs ?? DEFAULT_SESSION_MAX_AGE_MS);
  const payload = Buffer.from(
    JSON.stringify({
      uid: params.uid,
      email: params.email,
      authMode: params.authMode,
      iat,
      exp,
    }),
    'utf8'
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', key)
    .update(`ses.${payload}`)
    .digest('base64url');
  return `ses.${payload}.${sig}`;
}

export function verifySignedIsolatedToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions,
  nowMs: number = Date.now()
): { uid: string; email: string } | null {
  // Always validate/resolve SESSION_HMAC_SECRET first so production fails securely if missing/invalid
  const { key } = resolveSessionHmacKey(env, options);

  if (!token.startsWith('iso.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payload, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', key)
    .update(payload)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as { uid?: unknown; email?: unknown; exp?: unknown; iat?: unknown };
    if (
      typeof parsed.uid !== 'string' ||
      !parsed.uid.startsWith('iso_') ||
      typeof parsed.email !== 'string' ||
      parsed.email.trim().length === 0
    ) {
      return null;
    }

    // Enforce expiration window (reject expired tokens and legacy tokens older than max age)
    if (typeof parsed.exp === 'number' && Number.isFinite(parsed.exp)) {
      if (parsed.exp <= nowMs) return null;
    } else if (typeof parsed.iat === 'number' && Number.isFinite(parsed.iat)) {
      if (parsed.iat + DEFAULT_SESSION_MAX_AGE_MS <= nowMs) return null;
    } else {
      return null;
    }

    return { uid: parsed.uid, email: parsed.email };
  } catch {
    return null;
  }
}

export function verifySignedSessionToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions,
  nowMs: number = Date.now()
): AuthSessionUser | null {
  const { key } = resolveSessionHmacKey(env, options);

  if (token.startsWith('iso.')) {
    const legacyIso = verifySignedIsolatedToken(token, env, options, nowMs);
    if (!legacyIso) return null;
    return {
      uid: legacyIso.uid,
      email: legacyIso.email,
      authMode: 'isolated_session',
    };
  }

  if (!token.startsWith('ses.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payload, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', key)
    .update(`ses.${payload}`)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as {
      uid?: unknown;
      email?: unknown;
      authMode?: unknown;
      exp?: unknown;
    };

    if (
      typeof parsed.uid !== 'string' ||
      parsed.uid.trim().length === 0 ||
      typeof parsed.email !== 'string' ||
      parsed.email.trim().length === 0 ||
      (parsed.authMode !== 'google' &&
        parsed.authMode !== 'isolated_session') ||
      typeof parsed.exp !== 'number' ||
      !Number.isFinite(parsed.exp) ||
      parsed.exp <= nowMs
    ) {
      return null;
    }

    if (
      parsed.authMode === 'isolated_session' &&
      !parsed.uid.startsWith('iso_')
    ) {
      return null;
    }

    return {
      uid: parsed.uid,
      email: parsed.email,
      authMode: parsed.authMode,
    };
  } catch {
    return null;
  }
}

export function parseCookieHeader(
  cookieHeader: string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    if (key) out[key] = val;
  }
  return out;
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : null;

    const cookies = parseCookieHeader(req.headers.cookie);
    const cookieToken = cookies[ISOLATED_COOKIE_NAME] || null;

    const candidateToken = bearerToken || cookieToken;
    if (!candidateToken) {
      return res.status(401).json({
        error: 'Authentication required. Sign in to access your records.',
      });
    }

    // 1. Check server-signed session token (isolated_session or verified google session)
    if (
      candidateToken.startsWith('iso.') ||
      candidateToken.startsWith('ses.')
    ) {
      const verifiedSession = verifySignedSessionToken(candidateToken);
      if (!verifiedSession) {
        return res.status(401).json({ error: 'Invalid or expired session.' });
      }
      await getOrCreateUser(verifiedSession.uid, verifiedSession.email);
      req.authUser = verifiedSession;
      return next();
    }

    // 2. Verify Firebase ID Token via Firebase Admin
    const decoded = await adminAuth.verifyIdToken(candidateToken);
    const email = decoded.email || `${decoded.uid}@authenticated.user`;
    await getOrCreateUser(decoded.uid, email);
    req.authUser = {
      uid: decoded.uid,
      email: email,
      authMode: 'google',
    };
    return next();
  } catch (error) {
    if (error instanceof EnvConfigError) {
      console.error('Session secret configuration error:', error.message);
      return res.status(500).json({ error: error.message });
    }
    console.error('Authentication verification failed');
    return res
      .status(401)
      .json({ error: 'Unauthorized: Invalid authentication credentials.' });
  }
};
