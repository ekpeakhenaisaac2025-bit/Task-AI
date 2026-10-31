import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateDestinationUrlSync } from './ssrf-guard.ts';
import type {
  EnvironmentDiagnosticsResponse,
  EnvironmentVariableDiagnostic,
} from '../types.ts';

export class EnvConfigError extends Error {
  public readonly variableName: string;

  constructor(variableName: string, actionableMessage: string) {
    super(actionableMessage);
    this.name = 'EnvConfigError';
    this.variableName = variableName;
  }
}

export interface EnvResolutionOptions {
  devSecretsFilePath?: string;
}

interface PersistedDevSecrets {
  sessionHmacSecretHex: string;
  integrationEncryptionKeyHex: string;
  createdAt: string;
}

const DEFAULT_DEV_SECRETS_PATH = path.resolve(
  process.cwd(),
  '.aistudio',
  '.dev-runtime-secrets.json'
);

const KNOWN_PLACEHOLDER_VALUES = new Set([
  'replace_with_32_byte_random_hex',
  'replace_with_64_char_hex',
  'my_session_hmac_secret',
  'my_integration_encryption_key',
  'my_gemini_api_key',
  'changeme',
  'your_secret_here',
  'secret',
  'password',
]);

const EMAIL_SIMPLE_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

export function computeKeyFingerprint(keyBytes: Buffer): string {
  return crypto
    .createHash('sha256')
    .update('taskai-aes256gcm-key-v2:')
    .update(keyBytes)
    .digest('hex')
    .slice(0, 8);
}

/**
 * Validates a hexadecimal cryptographic secret without EVER echoing the secret value in error messages.
 */
export function validateHexSecretFormat(
  variableName: string,
  rawValue: string,
  constraints: { exactBytes?: number; minBytes?: number }
): { valid: true; keyBuffer: Buffer } | { valid: false; error: string } {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return {
      valid: false,
      error: `${variableName} is empty. Generate a 32-byte (64-character hex) secret locally with: openssl rand -hex 32`,
    };
  }

  if (KNOWN_PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) {
    return {
      valid: false,
      error: `${variableName} is set to a placeholder string rather than a real cryptographic secret. Generate a valid 64-character hex value with: openssl rand -hex 32`,
    };
  }

  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    return {
      valid: false,
      error: `Invalid ${variableName} encoding: expected hexadecimal characters only (0-9, a-f) with no spaces or quotes. Generate a valid 64-character hex value with: openssl rand -hex 32`,
    };
  }

  if (trimmed.length % 2 !== 0) {
    return {
      valid: false,
      error: `Invalid ${variableName} length: hexadecimal string has an odd length (${trimmed.length} chars). Expected ${
        constraints.exactBytes
          ? `exactly ${constraints.exactBytes * 2}`
          : `at least ${(constraints.minBytes ?? 32) * 2}`
      } hex characters. Generate one with: openssl rand -hex 32`,
    };
  }

  const byteLen = trimmed.length / 2;

  if (
    constraints.exactBytes !== undefined &&
    byteLen !== constraints.exactBytes
  ) {
    return {
      valid: false,
      error: `Invalid ${variableName} key length: AES-256-GCM requires exactly ${
        constraints.exactBytes
      } bytes (${
        constraints.exactBytes * 2
      } hex characters), but received ${byteLen} bytes (${
        trimmed.length
      } hex characters). Generate one with: openssl rand -hex 32`,
    };
  }

  const minBytes = constraints.minBytes ?? constraints.exactBytes ?? 32;
  if (byteLen < minBytes) {
    return {
      valid: false,
      error: `Insufficient ${variableName} entropy: requires at least ${minBytes} bytes (${
        minBytes * 2
      } hex characters / ${minBytes * 8} bits), but received ${byteLen} bytes (${
        trimmed.length
      } hex characters). Generate one with: openssl rand -hex 32`,
    };
  }

  // Reject degenerate low-entropy hex strings such as all-zeros, 'aaaa...', or 2-char repeats
  const distinctNibbles = new Set(trimmed.toLowerCase()).size;
  if (distinctNibbles < 6) {
    return {
      valid: false,
      error: `Insufficient ${variableName} entropy: secret contains a low-entropy repeated character pattern. Generate 32 cryptographically random bytes with: openssl rand -hex 32`,
    };
  }

  return {
    valid: true,
    keyBuffer: Buffer.from(trimmed, 'hex'),
  };
}

function readExistingDevSecretsFile(
  filePath: string
): PersistedDevSecrets | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedDevSecrets>;
    if (
      typeof parsed.sessionHmacSecretHex === 'string' &&
      typeof parsed.integrationEncryptionKeyHex === 'string'
    ) {
      const sCheck = validateHexSecretFormat(
        'DEV_SESSION_HMAC_SECRET',
        parsed.sessionHmacSecretHex,
        { minBytes: 32 }
      );
      const eCheck = validateHexSecretFormat(
        'DEV_INTEGRATION_ENCRYPTION_KEY',
        parsed.integrationEncryptionKeyHex,
        { exactBytes: 32 }
      );
      if (sCheck.valid && eCheck.valid) {
        return {
          sessionHmacSecretHex: parsed.sessionHmacSecretHex.trim(),
          integrationEncryptionKeyHex:
            parsed.integrationEncryptionKeyHex.trim(),
          createdAt: parsed.createdAt || new Date().toISOString(),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Used ONLY in non-production environments when env secrets are not yet configured,
 * ensuring local development keys remain stable across server restarts without weakening key length.
 * NEVER called in production.
 */
function loadOrCreatePersistentDevSecrets(
  options?: EnvResolutionOptions
): PersistedDevSecrets {
  const filePath = options?.devSecretsFilePath || DEFAULT_DEV_SECRETS_PATH;
  const existing = readExistingDevSecretsFile(filePath);
  if (existing) {
    return existing;
  }

  const created: PersistedDevSecrets = {
    sessionHmacSecretHex: crypto.randomBytes(32).toString('hex'),
    integrationEncryptionKeyHex: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(created, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return created;
}

export function resolveSessionHmacKey(
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions
): {
  key: Buffer;
  source: 'env' | 'dev_persisted_file';
} {
  const raw = env.SESSION_HMAC_SECRET?.trim() ?? '';
  const isProd = isProductionEnv(env);

  if (raw.length > 0) {
    const check = validateHexSecretFormat('SESSION_HMAC_SECRET', raw, {
      minBytes: 32,
    });
    if (!check.valid) {
      throw new EnvConfigError('SESSION_HMAC_SECRET', check.error);
    }
    return { key: check.keyBuffer, source: 'env' };
  }

  if (isProd) {
    throw new EnvConfigError(
      'SESSION_HMAC_SECRET',
      'Missing required production secret SESSION_HMAC_SECRET. Never auto-generating a production session secret. Configure a 64-character hex secret generated via: openssl rand -hex 32'
    );
  }

  const devSecrets = loadOrCreatePersistentDevSecrets(options);
  return {
    key: Buffer.from(devSecrets.sessionHmacSecretHex, 'hex'),
    source: 'dev_persisted_file',
  };
}

export interface FallbackDecryptionKey {
  key: Buffer;
  keyId: string;
  reason: 'previous_env' | 'dev_persisted' | 'legacy_v1_dev';
}

export interface ResolvedEncryptionKeyRing {
  primaryKey: Buffer;
  primaryKeyId: string;
  primarySource: 'env' | 'dev_persisted_file';
  fallbackKeys: FallbackDecryptionKey[];
}

const LEGACY_V1_SALT = 'task-ai-vault-v1-salt';

export function resolveEncryptionKeyRing(
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions
): ResolvedEncryptionKeyRing {
  const rawPrimary = env.INTEGRATION_ENCRYPTION_KEY?.trim() ?? '';
  const rawPrevious = env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS?.trim() ?? '';
  const isProd = isProductionEnv(env);
  const filePath = options?.devSecretsFilePath || DEFAULT_DEV_SECRETS_PATH;

  let primaryKey: Buffer;
  let primarySource: 'env' | 'dev_persisted_file';

  if (rawPrimary.length > 0) {
    const check = validateHexSecretFormat(
      'INTEGRATION_ENCRYPTION_KEY',
      rawPrimary,
      { exactBytes: 32 }
    );
    if (!check.valid) {
      throw new EnvConfigError('INTEGRATION_ENCRYPTION_KEY', check.error);
    }
    primaryKey = check.keyBuffer;
    primarySource = 'env';
  } else if (isProd) {
    throw new EnvConfigError(
      'INTEGRATION_ENCRYPTION_KEY',
      'Missing required production secret INTEGRATION_ENCRYPTION_KEY. Never auto-generating a replacement encryption key in production. Configure a 64-character hex secret (32 bytes for AES-256-GCM) generated via: openssl rand -hex 32'
    );
  } else {
    const devSecrets = loadOrCreatePersistentDevSecrets(options);
    primaryKey = Buffer.from(devSecrets.integrationEncryptionKeyHex, 'hex');
    primarySource = 'dev_persisted_file';
  }

  const primaryKeyId = computeKeyFingerprint(primaryKey);
  const fallbackKeys: FallbackDecryptionKey[] = [];
  const seenKeyIds = new Set<string>([primaryKeyId]);

  // 1. Explicit key-rotation ring: INTEGRATION_ENCRYPTION_KEY_PREVIOUS (allowed in both prod & dev)
  if (rawPrevious.length > 0) {
    const items = rawPrevious
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    for (let idx = 0; idx < items.length; idx++) {
      const check = validateHexSecretFormat(
        `INTEGRATION_ENCRYPTION_KEY_PREVIOUS[${idx}]`,
        items[idx],
        { exactBytes: 32 }
      );
      if (!check.valid) {
        throw new EnvConfigError(
          'INTEGRATION_ENCRYPTION_KEY_PREVIOUS',
          check.error
        );
      }
      const fp = computeKeyFingerprint(check.keyBuffer);
      if (!seenKeyIds.has(fp)) {
        seenKeyIds.add(fp);
        fallbackKeys.push({
          key: check.keyBuffer,
          keyId: fp,
          reason: 'previous_env',
        });
      }
    }
  }

  // 2. Non-production transition preservation ONLY (never active in production)
  if (!isProd) {
    if (primarySource === 'env') {
      const existingDev = readExistingDevSecretsFile(filePath);
      if (existingDev) {
        const devBuf = Buffer.from(
          existingDev.integrationEncryptionKeyHex,
          'hex'
        );
        const devFp = computeKeyFingerprint(devBuf);
        if (!seenKeyIds.has(devFp)) {
          seenKeyIds.add(devFp);
          fallbackKeys.push({
            key: devBuf,
            keyId: devFp,
            reason: 'dev_persisted',
          });
        }
      }
    }

    // One-way migration support for pre-v2 development rows encrypted before strict hex enforcement
    const devSqlSeed = env.SQL_PASSWORD?.trim();
    if (devSqlSeed) {
      const legacyBuf = crypto.scryptSync(devSqlSeed, LEGACY_V1_SALT, 32);
      const legacyFp = computeKeyFingerprint(legacyBuf);
      if (!seenKeyIds.has(legacyFp)) {
        seenKeyIds.add(legacyFp);
        fallbackKeys.push({
          key: legacyBuf,
          keyId: legacyFp,
          reason: 'legacy_v1_dev',
        });
      }
    }
  }

  return {
    primaryKey,
    primaryKeyId,
    primarySource,
    fallbackKeys,
  };
}

export interface SharedN8nEnvResolution {
  enabled: boolean;
  origin: string | null;
  signingKey: Buffer | null;
  adminEmails: string[];
  adminEmailsValid: boolean;
  configurationIssue: string | null;
}

/**
 * Validates optional platform-managed shared n8n configuration.
 * Shared n8n is ONLY enabled when BOTH PLATFORM_SHARED_N8N_BASE_URL and
 * PLATFORM_SHARED_N8N_SIGNING_SECRET are present and pass validation.
 */
export function resolveOptionalSharedN8nConfig(
  env: NodeJS.ProcessEnv = process.env
): SharedN8nEnvResolution {
  const rawUrl = env.PLATFORM_SHARED_N8N_BASE_URL?.trim() ?? '';
  const rawSecret = env.PLATFORM_SHARED_N8N_SIGNING_SECRET?.trim() ?? '';
  const rawAdmins = env.PLATFORM_ADMIN_EMAILS?.trim() ?? '';

  const adminEmails: string[] = [];
  let adminEmailsValid = true;
  let adminIssue: string | null = null;

  if (rawAdmins.length > 0) {
    const parts = rawAdmins
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    for (const email of parts) {
      if (!EMAIL_SIMPLE_REGEX.test(email)) {
        adminEmailsValid = false;
        adminIssue =
          'Invalid PLATFORM_ADMIN_EMAILS format: expected a comma-separated list of valid email addresses (e.g., admin@example.com,ops@example.com).';
        break;
      }
      adminEmails.push(email);
    }
  }

  if (!rawUrl && !rawSecret) {
    return {
      enabled: false,
      origin: null,
      signingKey: null,
      adminEmails: adminEmailsValid ? adminEmails : [],
      adminEmailsValid,
      configurationIssue: adminIssue,
    };
  }

  if (rawUrl && !rawSecret) {
    return {
      enabled: false,
      origin: null,
      signingKey: null,
      adminEmails: adminEmailsValid ? adminEmails : [],
      adminEmailsValid,
      configurationIssue:
        'PLATFORM_SHARED_N8N_BASE_URL is set, but PLATFORM_SHARED_N8N_SIGNING_SECRET is missing. Shared n8n remains disabled until a 64-character hex signing secret is configured.',
    };
  }

  if (!rawUrl && rawSecret) {
    return {
      enabled: false,
      origin: null,
      signingKey: null,
      adminEmails: adminEmailsValid ? adminEmails : [],
      adminEmailsValid,
      configurationIssue:
        'PLATFORM_SHARED_N8N_SIGNING_SECRET is set, but PLATFORM_SHARED_N8N_BASE_URL is blank. Shared n8n remains disabled until a valid HTTPS origin URL is configured (or leave both blank).',
    };
  }

  const urlCheck = validateDestinationUrlSync(rawUrl);
  if (!urlCheck.valid || !urlCheck.origin) {
    return {
      enabled: false,
      origin: null,
      signingKey: null,
      adminEmails: adminEmailsValid ? adminEmails : [],
      adminEmailsValid,
      configurationIssue: `Invalid PLATFORM_SHARED_N8N_BASE_URL: ${
        urlCheck.error || 'Expected a public HTTPS origin URL.'
      }`,
    };
  }

  const secretCheck = validateHexSecretFormat(
    'PLATFORM_SHARED_N8N_SIGNING_SECRET',
    rawSecret,
    { minBytes: 32 }
  );
  if (!secretCheck.valid) {
    return {
      enabled: false,
      origin: null,
      signingKey: null,
      adminEmails: adminEmailsValid ? adminEmails : [],
      adminEmailsValid,
      configurationIssue: secretCheck.error,
    };
  }

  if (!adminEmailsValid) {
    return {
      enabled: false,
      origin: null,
      signingKey: null,
      adminEmails: [],
      adminEmailsValid: false,
      configurationIssue: adminIssue,
    };
  }

  return {
    enabled: true,
    origin: urlCheck.origin,
    signingKey: secretCheck.keyBuffer,
    adminEmails,
    adminEmailsValid: true,
    configurationIssue: null,
  };
}

/**
 * Enforces fail-closed security validation on startup.
 * - Rejects missing SESSION_HMAC_SECRET or INTEGRATION_ENCRYPTION_KEY in production.
 * - Rejects malformed secrets in ALL environments.
 * - Keeps n8n strictly optional (disables shared n8n cleanly if omitted or incomplete).
 */
export function assertValidServerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions
): {
  sessionSource: 'env' | 'dev_persisted_file';
  encryptionSource: 'env' | 'dev_persisted_file';
  sharedN8n: SharedN8nEnvResolution;
} {
  const session = resolveSessionHmacKey(env, options);
  const vault = resolveEncryptionKeyRing(env, options);
  const sharedN8n = resolveOptionalSharedN8nConfig(env);

  return {
    sessionSource: session.source,
    encryptionSource: vault.primarySource,
    sharedN8n,
  };
}

/**
 * Produces 100% secret-free diagnostic metadata for the Environment Configuration UI.
 * Never exposes secret values, lengths, hashes, or database credentials.
 */
export function getPublicEnvironmentDiagnostics(
  env: NodeJS.ProcessEnv = process.env,
  options?: EnvResolutionOptions
): EnvironmentDiagnosticsResponse {
  const isProd = isProductionEnv(env);
  const runtimeMode: 'production' | 'development' | 'test' = isProd
    ? 'production'
    : (env.NODE_ENV || '').trim().toLowerCase() === 'test'
      ? 'test'
      : 'development';

  const variables: EnvironmentVariableDiagnostic[] = [];

  // 1. SESSION_HMAC_SECRET
  const rawSession = env.SESSION_HMAC_SECRET?.trim() ?? '';
  if (rawSession.length > 0) {
    const check = validateHexSecretFormat('SESSION_HMAC_SECRET', rawSession, {
      minBytes: 32,
    });
    variables.push({
      name: 'SESSION_HMAC_SECRET',
      requirement: 'required_in_production',
      requirementLabel: 'Required in Production',
      state: check.valid ? 'configured_valid' : 'action_required',
      statusSummary: check.valid
        ? 'Configured and validated (>= 256-bit hex secret).'
        : check.error,
      expectedFormat:
        '64-character hexadecimal string (0-9, a-f), even length, >= 32 random bytes (256 bits of entropy).',
      generateCommand: 'openssl rand -hex 32',
      safeToLeaveBlank: false,
      safeToLeaveBlankDetail:
        'Not safe to leave blank in production (server refuses to start). In local development only, a persistent 0600 keyfile maintains session stability until configured.',
      dependentFeatures:
        'HMAC-SHA256 signing and verification of isolated workspace session cookies and tokens.',
    });
  } else {
    if (!isProd) {
      loadOrCreatePersistentDevSecrets(options);
    }
    variables.push({
      name: 'SESSION_HMAC_SECRET',
      requirement: 'required_in_production',
      requirementLabel: 'Required in Production',
      state: isProd ? 'action_required' : 'dev_persisted_key',
      statusSummary: isProd
        ? 'Missing required production secret. Configure before starting production server.'
        : 'Not set in environment — using persistent local development keyfile across restarts. Set an explicit secret before production deployment.',
      expectedFormat:
        '64-character hexadecimal string (0-9, a-f), even length, >= 32 random bytes (256 bits of entropy).',
      generateCommand: 'openssl rand -hex 32',
      safeToLeaveBlank: false,
      safeToLeaveBlankDetail:
        'Not safe to leave blank in production (server refuses to start). Set a stable 64-char hex value in the Secrets panel before deploying.',
      dependentFeatures:
        'HMAC-SHA256 signing and verification of isolated workspace session cookies and tokens.',
    });
  }

  // 2. INTEGRATION_ENCRYPTION_KEY
  const rawVault = env.INTEGRATION_ENCRYPTION_KEY?.trim() ?? '';
  if (rawVault.length > 0) {
    const check = validateHexSecretFormat(
      'INTEGRATION_ENCRYPTION_KEY',
      rawVault,
      { exactBytes: 32 }
    );
    variables.push({
      name: 'INTEGRATION_ENCRYPTION_KEY',
      requirement: 'required_in_production',
      requirementLabel: 'Required in Production',
      state: check.valid ? 'configured_valid' : 'action_required',
      statusSummary: check.valid
        ? 'Configured and validated (exact 32-byte / 256-bit AES-256-GCM key).'
        : check.error,
      expectedFormat:
        'Exact 64-character hexadecimal string (0-9, a-f) decoding to 32 random bytes (256 bits) for AES-256-GCM.',
      generateCommand: 'openssl rand -hex 32',
      safeToLeaveBlank: false,
      safeToLeaveBlankDetail:
        'Not safe to leave blank in production (server refuses to start). Must remain unchanged once credentials are saved unless rotating via INTEGRATION_ENCRYPTION_KEY_PREVIOUS.',
      dependentFeatures:
        'AES-256-GCM at-rest encryption and execution-time decryption of per-workspace webhook secrets and bearer tokens.',
    });
  } else {
    if (!isProd) {
      loadOrCreatePersistentDevSecrets(options);
    }
    variables.push({
      name: 'INTEGRATION_ENCRYPTION_KEY',
      requirement: 'required_in_production',
      requirementLabel: 'Required in Production',
      state: isProd ? 'action_required' : 'dev_persisted_key',
      statusSummary: isProd
        ? 'Missing required production encryption key. Configure before starting production server.'
        : 'Not set in environment — using persistent local development AES-256-GCM keyfile across restarts. Set an explicit 64-char hex key before production deployment.',
      expectedFormat:
        'Exact 64-character hexadecimal string (0-9, a-f) decoding to 32 random bytes (256 bits) for AES-256-GCM.',
      generateCommand: 'openssl rand -hex 32',
      safeToLeaveBlank: false,
      safeToLeaveBlankDetail:
        'Not safe to leave blank in production (server refuses to start). Keep stable across restarts so encrypted credentials remain decryptable.',
      dependentFeatures:
        'AES-256-GCM at-rest encryption and execution-time decryption of per-workspace webhook secrets and bearer tokens.',
    });
  }

  // 3. INTEGRATION_ENCRYPTION_KEY_PREVIOUS
  const rawPrev = env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS?.trim() ?? '';
  if (!rawPrev) {
    variables.push({
      name: 'INTEGRATION_ENCRYPTION_KEY_PREVIOUS',
      requirement: 'optional',
      requirementLabel: 'Optional (Key Rotation Only)',
      state: 'optional_blank',
      statusSummary: 'Safely left blank (no key rotation in progress).',
      expectedFormat:
        'Comma-separated list of previous 64-character hexadecimal AES-256-GCM keys, or blank.',
      generateCommand: null,
      safeToLeaveBlank: true,
      safeToLeaveBlankDetail:
        'Yes — leave blank unless actively rotating INTEGRATION_ENCRYPTION_KEY to a new 64-char hex value.',
      dependentFeatures:
        'Zero-downtime decryption and re-encryption migration of existing workspace integration credentials during key rotation.',
    });
  } else {
    const items = rawPrev
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const invalidItem = items
      .map((it, idx) =>
        validateHexSecretFormat(
          `INTEGRATION_ENCRYPTION_KEY_PREVIOUS[${idx}]`,
          it,
          { exactBytes: 32 }
        )
      )
      .find((res) => !res.valid);

    variables.push({
      name: 'INTEGRATION_ENCRYPTION_KEY_PREVIOUS',
      requirement: 'optional',
      requirementLabel: 'Optional (Key Rotation Only)',
      state: invalidItem ? 'action_required' : 'configured_valid',
      statusSummary: invalidItem
        ? invalidItem.error
        : `Configured with ${items.length} previous rotation key(s) for seamless credential re-encryption.`,
      expectedFormat:
        'Comma-separated list of previous 64-character hexadecimal AES-256-GCM keys, or blank.',
      generateCommand: null,
      safeToLeaveBlank: true,
      safeToLeaveBlankDetail:
        'Yes — safe to clear after running "Rotate Stored Keys" to re-encrypt existing credentials under the active key.',
      dependentFeatures:
        'Zero-downtime decryption and re-encryption migration of existing workspace integration credentials during key rotation.',
    });
  }

  // 4, 5, 6. Optional Shared n8n Variables
  const shared = resolveOptionalSharedN8nConfig(env);
  const rawSharedUrl = env.PLATFORM_SHARED_N8N_BASE_URL?.trim() ?? '';
  const rawSharedSecret = env.PLATFORM_SHARED_N8N_SIGNING_SECRET?.trim() ?? '';
  const rawAdmins = env.PLATFORM_ADMIN_EMAILS?.trim() ?? '';

  const sharedUrlCheck = rawSharedUrl
    ? validateDestinationUrlSync(rawSharedUrl)
    : null;
  variables.push({
    name: 'PLATFORM_SHARED_N8N_BASE_URL',
    requirement: 'optional',
    requirementLabel: 'Optional (Shared n8n Only)',
    state: !rawSharedUrl
      ? 'optional_blank'
      : sharedUrlCheck?.valid && shared.enabled
        ? 'configured_valid'
        : 'action_required',
    statusSummary: !rawSharedUrl
      ? 'Safely left blank. Task.ai operates without n8n; users can still connect custom HTTPS webhooks or their own n8n URLs per workspace.'
      : !sharedUrlCheck?.valid
        ? `Invalid URL: ${sharedUrlCheck?.error || 'Expected public HTTPS origin.'}`
        : !shared.enabled
          ? shared.configurationIssue ||
            'Shared n8n requires PLATFORM_SHARED_N8N_SIGNING_SECRET.'
          : `Configured (${shared.origin}).`,
    expectedFormat:
      'Public HTTPS origin URL (e.g., https://n8n.example.com) passing SSRF validation, or blank.',
    generateCommand: null,
    safeToLeaveBlank: true,
    safeToLeaveBlankDetail:
      'Yes — leave blank unless operating a platform-wide shared n8n server for multiple isolated workflows.',
    dependentFeatures:
      'Platform-shared isolated n8n workflow mode (connectionMode: "platform_shared"). Does not affect built-in tools or user-owned webhooks.',
  });

  const sharedSecretCheck = rawSharedSecret
    ? validateHexSecretFormat(
        'PLATFORM_SHARED_N8N_SIGNING_SECRET',
        rawSharedSecret,
        { minBytes: 32 }
      )
    : null;
  variables.push({
    name: 'PLATFORM_SHARED_N8N_SIGNING_SECRET',
    requirement: rawSharedUrl ? 'conditional' : 'optional',
    requirementLabel: rawSharedUrl
      ? 'Required When Shared n8n URL Is Set'
      : 'Optional (Shared n8n Only)',
    state:
      !rawSharedSecret && !rawSharedUrl
        ? 'optional_blank'
        : !rawSharedSecret && rawSharedUrl
          ? 'action_required'
          : sharedSecretCheck?.valid && shared.enabled
            ? 'configured_valid'
            : 'action_required',
    statusSummary:
      !rawSharedSecret && !rawSharedUrl
        ? 'Safely left blank (platform-shared n8n is not in use).'
        : !rawSharedSecret && rawSharedUrl
          ? 'Missing signing secret for PLATFORM_SHARED_N8N_BASE_URL; shared n8n remains disabled.'
          : !sharedSecretCheck || !sharedSecretCheck.valid
            ? sharedSecretCheck
              ? sharedSecretCheck.error
              : 'Invalid PLATFORM_SHARED_N8N_SIGNING_SECRET format.'
            : !rawSharedUrl
              ? 'Signing secret is set, but PLATFORM_SHARED_N8N_BASE_URL is blank; shared n8n remains disabled.'
              : 'Configured and validated (>= 256-bit HMAC signing secret).',
    expectedFormat:
      '64-character hexadecimal string (0-9, a-f), even length (>= 32 random bytes), or blank when shared n8n is unused.',
    generateCommand: 'openssl rand -hex 32',
    safeToLeaveBlank: !rawSharedUrl,
    safeToLeaveBlankDetail:
      'Yes when PLATFORM_SHARED_N8N_BASE_URL is blank. Required if PLATFORM_SHARED_N8N_BASE_URL is set.',
    dependentFeatures:
      'X-TaskAI-Platform-Signature HMAC-SHA256 request signing from Task.ai to an administrator-managed shared n8n server.',
  });

  variables.push({
    name: 'PLATFORM_ADMIN_EMAILS',
    requirement: 'optional',
    requirementLabel: 'Optional (Admin Allowlist)',
    state: !rawAdmins
      ? 'optional_blank'
      : shared.adminEmailsValid
        ? 'configured_valid'
        : 'action_required',
    statusSummary: !rawAdmins
      ? 'Safely left blank (no administrator email restriction configured).'
      : shared.adminEmailsValid
        ? `Configured (${shared.adminEmails.length} administrator email(s) authorized).`
        : shared.configurationIssue ||
          'Invalid comma-separated email format in PLATFORM_ADMIN_EMAILS.',
    expectedFormat:
      'Comma-separated email addresses (e.g., admin@example.com,secops@example.com), or blank.',
    generateCommand: null,
    safeToLeaveBlank: true,
    safeToLeaveBlankDetail:
      'Yes — leave blank unless restricting platform_shared n8n route registration to specific administrator accounts.',
    dependentFeatures:
      'Administrator email allowlist gating for registering platform-shared n8n workflow integrations.',
  });

  return {
    runtimeMode,
    readyWithoutN8n: true,
    sharedN8nEnabled: shared.enabled,
    variables,
  };
}
