import crypto from 'node:crypto';
import {
  EnvConfigError,
  resolveEncryptionKeyRing,
  validateHexSecretFormat,
  type EnvResolutionOptions,
} from './env-config.ts';

export interface EncryptedSecretPayload {
  ciphertextBase64: string;
  ivBase64: string;
  authTagBase64: string;
  maskedHint: string;
  keyId: string;
}

export interface DecryptedSecretOutcome {
  plaintext: string;
  needsReencryption: boolean;
  keyIdUsed: string;
}

const STRICT_BASE64_REGEX =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeStrictBase64(b64: string, fieldLabel: string): Buffer {
  const trimmed = b64.trim();
  if (!trimmed || !STRICT_BASE64_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid base64 encoding in stored ${fieldLabel}; credential payload rejected.`
    );
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.toString('base64') !== trimmed) {
    throw new Error(
      `Non-canonical base64 detected in stored ${fieldLabel}; credential payload rejected.`
    );
  }
  return buf;
}

export function isDedicatedVaultKeyConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env.INTEGRATION_ENCRYPTION_KEY?.trim() ?? '';
  if (!raw) return false;
  return validateHexSecretFormat('INTEGRATION_ENCRYPTION_KEY', raw, {
    exactBytes: 32,
  }).valid;
}

export function maskSecretValue(rawSecret: string): string {
  const trimmed = rawSecret.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) {
    return '••••••••';
  }
  return `••••••••${trimmed.slice(-4)}`;
}

/**
 * Encrypts a per-workspace integration credential using AES-256-GCM with an exact 32-byte (256-bit) key,
 * a fresh 12-byte (96-bit) random IV, and a 16-byte (128-bit) authentication tag.
 * Wraps the ciphertext in a versioned key-fingerprint envelope: v2:<8-hex-key-id>:<base64>.
 */
export function encryptIntegrationSecret(
  plaintextSecret: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions
): EncryptedSecretPayload {
  const trimmed = plaintextSecret.trim();
  if (!trimmed) {
    throw new Error('Cannot encrypt an empty secret value.');
  }

  const ring = resolveEncryptionKeyRing(env, options);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ring.primaryKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(trimmed, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertextBase64: `v2:${ring.primaryKeyId}:${encrypted.toString('base64')}`,
    ivBase64: iv.toString('base64'),
    authTagBase64: authTag.toString('base64'),
    maskedHint: maskSecretValue(trimmed),
    keyId: ring.primaryKeyId,
  };
}

/**
 * Decrypts and authenticates an AES-256-GCM integration credential.
 * Supports primary INTEGRATION_ENCRYPTION_KEY as well as authorized key-rotation migration
 * via INTEGRATION_ENCRYPTION_KEY_PREVIOUS (marking needsReencryption: true when an older key is used).
 */
export function decryptIntegrationSecretDetailed(
  params: {
    ciphertextBase64: string;
    ivBase64: string;
    authTagBase64: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions
): DecryptedSecretOutcome {
  // Propagate EnvConfigError immediately if production key is missing or key format is invalid
  const ring = resolveEncryptionKeyRing(env, options);

  const iv = decodeStrictBase64(params.ivBase64, 'IV');
  if (iv.length !== 12) {
    throw new Error(
      `Invalid AES-256-GCM IV length (${iv.length} bytes; expected 12 bytes).`
    );
  }

  const authTag = decodeStrictBase64(
    params.authTagBase64,
    'authentication tag'
  );
  if (authTag.length !== 16) {
    throw new Error(
      `Invalid AES-256-GCM authentication tag length (${authTag.length} bytes; expected 16 bytes).`
    );
  }

  const rawEnvelope = params.ciphertextBase64.trim();
  const v2Match = /^v2:([0-9a-f]{8}):(.+)$/i.exec(rawEnvelope);
  const envelopeVersion: 'v1' | 'v2' = v2Match ? 'v2' : 'v1';
  const embeddedKeyId = v2Match ? v2Match[1].toLowerCase() : null;
  const rawCiphertextB64 = v2Match ? v2Match[2] : rawEnvelope;

  const ciphertext = decodeStrictBase64(rawCiphertextB64, 'ciphertext');
  if (ciphertext.length === 0) {
    throw new Error('Encrypted credential ciphertext cannot be empty.');
  }

  interface CandidateKey {
    key: Buffer;
    keyId: string;
    isPrimary: boolean;
  }

  const allCandidates: CandidateKey[] = [
    { key: ring.primaryKey, keyId: ring.primaryKeyId, isPrimary: true },
    ...ring.fallbackKeys
      .filter((fb) => envelopeVersion === 'v1' || fb.reason !== 'legacy_v1_dev')
      .map((fb) => ({
        key: fb.key,
        keyId: fb.keyId,
        isPrimary: false,
      })),
  ];

  // Prioritize the candidate matching the envelope's non-secret 8-hex-char fingerprint if present
  const orderedCandidates = embeddedKeyId
    ? [
        ...allCandidates.filter((c) => c.keyId === embeddedKeyId),
        ...allCandidates.filter((c) => c.keyId !== embeddedKeyId),
      ]
    : allCandidates;

  for (const candidate of orderedCandidates) {
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        candidate.key,
        iv
      );
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return {
        plaintext: decrypted.toString('utf8'),
        needsReencryption: !candidate.isPrimary || envelopeVersion !== 'v2',
        keyIdUsed: candidate.keyId,
      };
    } catch {
      // Try next authorized key in rotation ring
    }
  }

  throw new Error(
    'Failed to authenticate and decrypt stored integration credential. Ciphertext or authentication tag was tampered with, or INTEGRATION_ENCRYPTION_KEY was changed without setting INTEGRATION_ENCRYPTION_KEY_PREVIOUS.'
  );
}

export function decryptIntegrationSecret(
  params: {
    ciphertextBase64: string;
    ivBase64: string;
    authTagBase64: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions
): string {
  return decryptIntegrationSecretDetailed(params, env, options).plaintext;
}

const SENSITIVE_KEY_PATTERN =
  /(secret|token|password|api[-_]?key|authorization|signature|credential|private[-_]?key|encryption[-_]?key|hmac)/i;

/**
 * Scrubs any object before writing to action_logs or returning evidence,
 * ensuring credentials, bearer headers, or env secrets can never leak into logs or UI.
 */
export function sanitizeEvidencePayload(
  input: Record<string, unknown>
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      clean[key] = '[REDACTED]';
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = sanitizeEvidencePayload(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      clean[key] = value.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeEvidencePayload(item as Record<string, unknown>)
          : item
      );
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Defense-in-depth string scrubber: removes any accidental occurrence of configured
 * server secrets before returning error messages or writing logs.
 */
export function redactSecretsFromText(
  message: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  let result = message;
  const secretEnvVars = [
    'SESSION_HMAC_SECRET',
    'INTEGRATION_ENCRYPTION_KEY',
    'INTEGRATION_ENCRYPTION_KEY_PREVIOUS',
    'PLATFORM_SHARED_N8N_SIGNING_SECRET',
    'GEMINI_API_KEY',
    'SLACK_CLIENT_SECRET',
    'MICROSOFT_CLIENT_SECRET',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'SQL_PASSWORD',
    'SQL_ADMIN_PASSWORD',
  ];

  for (const varName of secretEnvVars) {
    const raw = env[varName]?.trim();
    if (!raw) continue;
    for (const part of raw.split(',').map((s) => s.trim())) {
      if (part.length >= 6 && result.includes(part)) {
        result = result.split(part).join('[REDACTED]');
      }
    }
  }
  return result;
}

export { EnvConfigError };
