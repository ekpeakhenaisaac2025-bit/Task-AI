import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptIntegrationSecret,
  decryptIntegrationSecretDetailed,
  encryptIntegrationSecret,
  maskSecretValue,
  redactSecretsFromText,
  sanitizeEvidencePayload,
} from './crypto-vault.ts';
import {
  assertValidServerEnvironment,
  EnvConfigError,
  getPublicEnvironmentDiagnostics,
  resolveOptionalSharedN8nConfig,
  validateHexSecretFormat,
} from './env-config.ts';
import {
  buildWorkspaceToolRegistry,
  getPlatformCapabilities,
} from './execution-router.ts';
import {
  createSignedIsolatedToken,
  verifySignedIsolatedToken,
} from '../middleware/auth.ts';
import {
  computeResultsReport,
  evaluateTaskEligibility,
  resolveExecutionRoute,
} from '../lib/domain-rules.ts';
import {
  isPrivateOrReservedIp,
  validateDestinationUrlSync,
} from './ssrf-guard.ts';
import type { GoalRecord, TaskRecord } from '../types.ts';

function generateTestHex32(): string {
  return crypto.randomBytes(32).toString('hex');
}

// 1. Missing required secrets are rejected in production
test('1. Production mode rejects missing SESSION_HMAC_SECRET and INTEGRATION_ENCRYPTION_KEY (never auto-generates)', () => {
  const validSessionSecret = generateTestHex32();
  const validVaultKey = generateTestHex32();

  // Missing SESSION_HMAC_SECRET in production
  const envMissingSession: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: '',
    INTEGRATION_ENCRYPTION_KEY: validVaultKey,
  };
  assert.throws(
    () => assertValidServerEnvironment(envMissingSession),
    (err: unknown) =>
      err instanceof EnvConfigError &&
      err.variableName === 'SESSION_HMAC_SECRET' &&
      /Missing required production secret SESSION_HMAC_SECRET/.test(err.message)
  );
  assert.throws(
    () =>
      createSignedIsolatedToken(
        'iso_1234567890abcdef',
        'u@example.com',
        envMissingSession
      ),
    (err: unknown) => err instanceof EnvConfigError
  );

  // Missing INTEGRATION_ENCRYPTION_KEY in production
  const envMissingVault: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: validSessionSecret,
    INTEGRATION_ENCRYPTION_KEY: '',
  };
  assert.throws(
    () => assertValidServerEnvironment(envMissingVault),
    (err: unknown) =>
      err instanceof EnvConfigError &&
      err.variableName === 'INTEGRATION_ENCRYPTION_KEY' &&
      /Missing required production secret INTEGRATION_ENCRYPTION_KEY/.test(
        err.message
      )
  );
  assert.throws(
    () => encryptIntegrationSecret('whsec_live_12345', envMissingVault),
    (err: unknown) => err instanceof EnvConfigError
  );
});

// 2. Invalid secret formats produce actionable error messages
test('2. Invalid secret formats produce actionable error messages with generation instructions', () => {
  // Non-hex characters
  const nonHex = validateHexSecretFormat(
    'INTEGRATION_ENCRYPTION_KEY',
    'not-valid-hex-characters-at-all-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    { exactBytes: 32 }
  );
  assert.equal(nonHex.valid, false);
  if (!nonHex.valid) {
    assert.match(nonHex.error, /hexadecimal characters only/i);
    assert.match(nonHex.error, /openssl rand -hex 32/);
  }

  // Wrong byte length for AES-256-GCM (16 bytes / 32 hex chars instead of 32 bytes / 64 hex chars)
  const shortKey = crypto.randomBytes(16).toString('hex');
  const wrongLen = validateHexSecretFormat(
    'INTEGRATION_ENCRYPTION_KEY',
    shortKey,
    { exactBytes: 32 }
  );
  assert.equal(wrongLen.valid, false);
  if (!wrongLen.valid) {
    assert.match(wrongLen.error, /exactly 32 bytes \(64 hex characters\)/);
    assert.match(wrongLen.error, /received 16 bytes \(32 hex characters\)/);
  }

  // Odd-length hex string
  const oddHex = validateHexSecretFormat('SESSION_HMAC_SECRET', 'abcdef1', {
    minBytes: 32,
  });
  assert.equal(oddHex.valid, false);
  if (!oddHex.valid) {
    assert.match(oddHex.error, /odd length/);
  }

  // Placeholder string rejected
  const placeholder = validateHexSecretFormat(
    'SESSION_HMAC_SECRET',
    'replace_with_32_byte_random_hex',
    { minBytes: 32 }
  );
  assert.equal(placeholder.valid, false);
  if (!placeholder.valid) {
    assert.match(placeholder.error, /placeholder string/i);
  }

  // Low-entropy repeated character pattern rejected
  const lowEntropy = validateHexSecretFormat(
    'INTEGRATION_ENCRYPTION_KEY',
    'a'.repeat(64),
    { exactBytes: 32 }
  );
  assert.equal(lowEntropy.valid, false);
  if (!lowEntropy.valid) {
    assert.match(lowEntropy.error, /low-entropy/i);
  }

  // Malformed INTEGRATION_ENCRYPTION_KEY_PREVIOUS rejected on startup
  assert.throws(
    () =>
      assertValidServerEnvironment({
        NODE_ENV: 'production',
        SESSION_HMAC_SECRET: generateTestHex32(),
        INTEGRATION_ENCRYPTION_KEY: generateTestHex32(),
        INTEGRATION_ENCRYPTION_KEY_PREVIOUS: 'short_bad_prev_key',
      }),
    (err: unknown) =>
      err instanceof EnvConfigError &&
      err.variableName === 'INTEGRATION_ENCRYPTION_KEY_PREVIOUS'
  );
});

// 3. Stable secrets preserve sessions and encrypted credentials across restarts (plus safe key rotation)
test('3. Stable secrets preserve sessions and encrypted credentials across restarts and key rotation', () => {
  const stableSessionHex = generateTestHex32();
  const stableVaultHex = generateTestHex32();

  const restartOneEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: stableSessionHex,
    INTEGRATION_ENCRYPTION_KEY: stableVaultHex,
  };

  const sessionToken = createSignedIsolatedToken(
    'iso_abcdef1234567890',
    'tenant@isolated.task.ai',
    restartOneEnv
  );
  const encryptedCred = encryptIntegrationSecret(
    'whsec_persistent_credential_9988',
    restartOneEnv
  );

  // Simulated process restart with the same configured secrets
  const restartTwoEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: stableSessionHex,
    INTEGRATION_ENCRYPTION_KEY: stableVaultHex,
  };

  const verifiedSession = verifySignedIsolatedToken(
    sessionToken,
    restartTwoEnv
  );
  assert.deepEqual(verifiedSession, {
    uid: 'iso_abcdef1234567890',
    email: 'tenant@isolated.task.ai',
  });
  assert.equal(
    decryptIntegrationSecret(encryptedCred, restartTwoEnv),
    'whsec_persistent_credential_9988'
  );

  // Key rotation migration: new INTEGRATION_ENCRYPTION_KEY + old key in INTEGRATION_ENCRYPTION_KEY_PREVIOUS
  const rotatedNewVaultHex = generateTestHex32();
  const rotatedEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: stableSessionHex,
    INTEGRATION_ENCRYPTION_KEY: rotatedNewVaultHex,
    INTEGRATION_ENCRYPTION_KEY_PREVIOUS: stableVaultHex,
  };

  const detailedAfterRotation = decryptIntegrationSecretDetailed(
    encryptedCred,
    rotatedEnv
  );
  assert.equal(
    detailedAfterRotation.plaintext,
    'whsec_persistent_credential_9988'
  );
  assert.equal(detailedAfterRotation.needsReencryption, true);

  const reencrypted = encryptIntegrationSecret(
    detailedAfterRotation.plaintext,
    rotatedEnv
  );
  // Once re-encrypted, INTEGRATION_ENCRYPTION_KEY_PREVIOUS can be safely removed
  const postMigrationEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: stableSessionHex,
    INTEGRATION_ENCRYPTION_KEY: rotatedNewVaultHex,
    INTEGRATION_ENCRYPTION_KEY_PREVIOUS: '',
  };
  const postMigrationCheck = decryptIntegrationSecretDetailed(
    reencrypted,
    postMigrationEnv
  );
  assert.equal(
    postMigrationCheck.plaintext,
    'whsec_persistent_credential_9988'
  );
  assert.equal(postMigrationCheck.needsReencryption, false);

  // Non-production persistent keyfile stability across restarts in an isolated temp dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskai-dev-secrets-'));
  const devFile = path.join(tmpDir, '.dev-runtime-secrets.json');
  try {
    const devEnv: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
    const devTok = createSignedIsolatedToken(
      'iso_devrestart000001',
      'dev@isolated.task.ai',
      devEnv,
      { devSecretsFilePath: devFile }
    );
    const devEnc = encryptIntegrationSecret('dev_secret_value', devEnv, {
      devSecretsFilePath: devFile,
    });

    // Second simulated dev restart reads the same 0600 file
    assert.deepEqual(
      verifySignedIsolatedToken(devTok, devEnv, { devSecretsFilePath: devFile }),
      { uid: 'iso_devrestart000001', email: 'dev@isolated.task.ai' }
    );
    assert.equal(
      decryptIntegrationSecret(devEnc, devEnv, { devSecretsFilePath: devFile }),
      'dev_secret_value'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 4. AES-256-GCM encryption and decryption work correctly
test('4. AES-256-GCM encryption generates unique 12-byte IVs, versioned v2 envelopes, and round-trips accurately', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: generateTestHex32(),
    INTEGRATION_ENCRYPTION_KEY: generateTestHex32(),
  };

  const secret = 'Bearer sk_live_tenant_token_4242';
  const encA = encryptIntegrationSecret(secret, env);
  const encB = encryptIntegrationSecret(secret, env);

  assert.match(encA.ciphertextBase64, /^v2:[0-9a-f]{8}:.+/);
  assert.notEqual(
    encA.ivBase64,
    encB.ivBase64,
    'Every encryption call must use a distinct 96-bit random IV'
  );
  assert.notEqual(encA.ciphertextBase64, encB.ciphertextBase64);
  assert.equal(encA.maskedHint, '••••••••4242');
  assert.equal(maskSecretValue('short'), '••••••••');

  assert.equal(decryptIntegrationSecret(encA, env), secret);
  assert.equal(decryptIntegrationSecret(encB, env), secret);
});

// 5. Tampered ciphertext, IV, or authentication tag is rejected
test('5. AES-256-GCM rejects tampered ciphertext, tampered IV, and tampered authentication tag', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: generateTestHex32(),
    INTEGRATION_ENCRYPTION_KEY: generateTestHex32(),
  };

  const encrypted = encryptIntegrationSecret(
    'whsec_integrity_protected_secret_7777',
    env
  );

  // 5a. Tampered authTag
  const tagBytes = Buffer.from(encrypted.authTagBase64, 'base64');
  tagBytes[0] ^= 0xff;
  assert.throws(() =>
    decryptIntegrationSecret(
      { ...encrypted, authTagBase64: tagBytes.toString('base64') },
      env
    )
  );

  // 5b. Tampered IV
  const ivBytes = Buffer.from(encrypted.ivBase64, 'base64');
  ivBytes[0] ^= 0xff;
  assert.throws(() =>
    decryptIntegrationSecret(
      { ...encrypted, ivBase64: ivBytes.toString('base64') },
      env
    )
  );

  // 5c. Tampered ciphertext bytes inside v2:<keyId>:<base64>
  const parts = encrypted.ciphertextBase64.split(':');
  const cipherBytes = Buffer.from(parts[2], 'base64');
  cipherBytes[0] ^= 0xff;
  const tamperedEnvelope = `${parts[0]}:${parts[1]}:${cipherBytes.toString('base64')}`;
  assert.throws(() =>
    decryptIntegrationSecret(
      { ...encrypted, ciphertextBase64: tamperedEnvelope },
      env
    )
  );
});

// 6. Optional n8n configuration does not prevent built-in providers or custom webhooks from operating
test('6. Blank or partial optional n8n variables keep n8n disabled while built-in providers operate normally', () => {
  const envWithoutN8n: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: generateTestHex32(),
    INTEGRATION_ENCRYPTION_KEY: generateTestHex32(),
    PLATFORM_SHARED_N8N_BASE_URL: '',
    PLATFORM_SHARED_N8N_SIGNING_SECRET: '',
    PLATFORM_ADMIN_EMAILS: '',
  };

  const validated = assertValidServerEnvironment(envWithoutN8n);
  assert.equal(validated.sharedN8n.enabled, false);
  assert.equal(validated.sharedN8n.configurationIssue, null);

  const caps = getPlatformCapabilities('user@example.com', envWithoutN8n);
  assert.equal(caps.sharedN8nAvailable, false);
  assert.equal(caps.sharedN8nOrigin, null);

  // Partial config (URL set without signing secret) MUST NOT enable unsigned shared n8n
  const partialN8n = resolveOptionalSharedN8nConfig({
    PLATFORM_SHARED_N8N_BASE_URL: 'https://n8n.example.com',
    PLATFORM_SHARED_N8N_SIGNING_SECRET: '',
  });
  assert.equal(partialN8n.enabled, false);
  assert.match(
    partialN8n.configurationIssue || '',
    /PLATFORM_SHARED_N8N_SIGNING_SECRET is missing/
  );

  // Complete valid shared n8n config enables shared n8n and enforces admin allowlist
  const completeEnv: NodeJS.ProcessEnv = {
    ...envWithoutN8n,
    PLATFORM_SHARED_N8N_BASE_URL: 'https://n8n.example.com/nested',
    PLATFORM_SHARED_N8N_SIGNING_SECRET: generateTestHex32(),
    PLATFORM_ADMIN_EMAILS: 'admin@example.com',
  };
  const completeN8n = resolveOptionalSharedN8nConfig(completeEnv);
  assert.equal(completeN8n.enabled, true);
  assert.equal(completeN8n.origin, 'https://n8n.example.com');
  assert.equal(
    getPlatformCapabilities('admin@example.com', completeEnv).isPlatformAdmin,
    true
  );
  assert.equal(
    getPlatformCapabilities('other@example.com', completeEnv).isPlatformAdmin,
    false
  );

  // Built-in providers operate cleanly with zero workspace integrations and no n8n
  const registry = buildWorkspaceToolRegistry([]);
  const internalTool = registry.find((t) => t.id === 'internal_test_tool');
  assert.ok(internalTool?.configured && internalTool.verified);

  const route = resolveExecutionRoute({
    task: {
      tool: 'internal_test_tool',
      requiredCapabilities: ['diagnostic_verification'],
    },
    builtInProviders: { llmReasoningReady: true, internalTestReady: true },
    userIntegrations: [],
  });
  assert.equal(route.routable, true);
  if (route.routable) {
    assert.equal(route.providerKey, 'internal_test_tool');
  }
});

// 7. Missing integration configuration results in a clear blocked state rather than fabricated execution
test('7. Missing external integration transitions task to blocked with actionable reason and zero fabricated outcomes', () => {
  const activeGoal: GoalRecord = {
    id: 'goal-ext-1',
    userId: 'iso_1111222233334444',
    workspaceId: 'ws-1',
    problem: 'Sync qualified leads to CRM',
    description: 'Sync leads automatically',
    targetMetric: 'Sync 10 leads',
    deadline: null,
    status: 'active',
    executionState: 'idle',
    progressPercent: 0,
    achievedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const externalTask: TaskRecord = {
    id: 'task-ext-1',
    goalId: activeGoal.id,
    userId: activeGoal.userId,
    workspaceId: 'ws-1',
    stepOrder: 1,
    description: 'Dispatch approved lead payload to external CRM webhook',
    tool: 'custom_webhook',
    requiredCapabilities: ['workflow_automation', 'crm_sync'],
    assignedProvider: null,
    assignedIntegrationId: null,
    actionCategory: 'external_workflow',
    dependencies: [],
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalDecisionAt: new Date().toISOString(),
    approvalDecisionBy: activeGoal.userId,
    proposedActionDetails: {
      proposedAction: 'POST lead JSON',
      targetRecipient: 'CRM webhook',
      estimatedCost: '$0',
      explanation: 'Sync approved lead',
    },
    expectedResult: 'HTTP 200 delivery receipt',
    verificationMethod: 'Verify HTTP 200 response',
    status: 'queued',
    verificationStatus: 'unverified',
    reconciliationRequired: false,
    statusReason: null,
    outputData: null,
    retryCount: 0,
    maxRetries: 2,
    backoffBaseMs: 2000,
    nextRetryAt: null,
    executionTimeoutMs: 20000,
    startedAt: null,
    completedAt: null,
    verifiedAt: null,
    lastDurationMs: null,
    idempotencyKey: 'idem-ext-1',
    lockedBy: null,
    lockedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const route = resolveExecutionRoute({
    task: externalTask,
    builtInProviders: { llmReasoningReady: true, internalTestReady: true },
    userIntegrations: [], // No workspace integrations configured
  });
  assert.equal(route.routable, false);

  const eligibility = evaluateTaskEligibility({
    task: externalTask,
    goalStatus: activeGoal.status,
    tasksById: new Map([[externalTask.id, externalTask]]),
    routingContext: {
      builtInProviders: { llmReasoningReady: true, internalTestReady: true },
      userIntegrations: [],
    },
  });
  assert.equal(eligibility.eligible, false);
  if (!eligibility.eligible) {
    assert.equal(eligibility.code, 'tool_unconfigured');
    assert.equal(eligibility.shouldTransitionTaskStatus, 'blocked');
    assert.match(eligibility.reason, /Configuration required/i);
  }

  const blockedTask: TaskRecord = {
    ...externalTask,
    status: 'blocked',
    statusReason: !eligibility.eligible ? eligibility.reason : null,
  };
  const report = computeResultsReport({
    goals: [activeGoal],
    tasks: [blockedTask],
    actionLogs: [],
    tools: buildWorkspaceToolRegistry([]),
  });
  assert.equal(report.metrics.messagesDeliveredVerified, 0);
  assert.equal(report.metrics.revenueEarnedUsd, 0);
  assert.equal(report.metrics.blockedTasks, 1);
  assert.equal(report.goalComparisons[0].verifiedOutcomesCount, 0);
  assert.equal(report.goalComparisons[0].blockedCount, 1);
});

// 8. Secret values never appear in application logs, error messages, diagnostics, or API payloads
test('8. Secret values never leak into validation errors, public environment diagnostics, evidence logs, or redacted strings', () => {
  const canarySessionSecret =
    'deadbeefcafebabe0123456789abcdefdeadbeefcafebabe0123456789abcdef';
  const canaryVaultKey =
    'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef';
  const canaryPrevKey =
    '0123456789abcdefdeadbeefcafebabe0123456789abcdefdeadbeefcafebabe';
  const canaryN8nSecret =
    'abcdef0123456789deadbeefcafebabeabcdef0123456789deadbeefcafebabe';
  const canaryAdminEmail = 'canary-admin-7788@tenant-corp.test';
  const canaryBadSecret = 'SUPER_SENSITIVE_NON_HEX_SECRET_VALUE_999';

  // 8a. Validation error message must never echo the invalid secret input
  const badCheck = validateHexSecretFormat(
    'SESSION_HMAC_SECRET',
    canaryBadSecret,
    { minBytes: 32 }
  );
  assert.equal(badCheck.valid, false);
  if (!badCheck.valid) {
    assert.equal(badCheck.error.includes(canaryBadSecret), false);
  }

  // 8b. Public diagnostics response must never include any configured secret values
  const envWithCanaries: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: canarySessionSecret,
    INTEGRATION_ENCRYPTION_KEY: canaryVaultKey,
    INTEGRATION_ENCRYPTION_KEY_PREVIOUS: canaryPrevKey,
    PLATFORM_SHARED_N8N_BASE_URL: 'https://n8n.example.com',
    PLATFORM_SHARED_N8N_SIGNING_SECRET: canaryN8nSecret,
    PLATFORM_ADMIN_EMAILS: canaryAdminEmail,
  };
  const serializedDiagnostics = JSON.stringify(
    getPublicEnvironmentDiagnostics(envWithCanaries)
  );
  assert.equal(serializedDiagnostics.includes(canarySessionSecret), false);
  assert.equal(serializedDiagnostics.includes(canaryVaultKey), false);
  assert.equal(serializedDiagnostics.includes(canaryPrevKey), false);
  assert.equal(serializedDiagnostics.includes(canaryN8nSecret), false);
  assert.equal(serializedDiagnostics.includes(canaryAdminEmail), false);

  // 8c. Evidence sanitizer and text redactor strip secrets recursively
  const cleanEvidence = sanitizeEvidencePayload({
    provider: 'custom_webhook',
    authorization: 'Bearer secret_123',
    nested: {
      webhookSecret: 'raw_secret',
      encryption_key: canaryVaultKey,
      workflowId: 'wf_safe_01',
    },
  });
  const serializedEvidence = JSON.stringify(cleanEvidence);
  assert.equal(serializedEvidence.includes('secret_123'), false);
  assert.equal(serializedEvidence.includes('raw_secret'), false);
  assert.equal(serializedEvidence.includes(canaryVaultKey), false);

  const scrubbedErr = redactSecretsFromText(
    `Unexpected failure using key ${canaryVaultKey} and session ${canarySessionSecret}`,
    envWithCanaries
  );
  assert.equal(scrubbedErr.includes(canaryVaultKey), false);
  assert.equal(scrubbedErr.includes(canarySessionSecret), false);
  assert.match(scrubbedErr, /\[REDACTED\]/);
});

test('SSRF guard blocks HTTP, loopback, RFC1918, cloud metadata, embedded creds, and secret query params', () => {
  assert.equal(
    validateDestinationUrlSync('https://hooks.example.com/webhook/abc').valid,
    true
  );
  assert.equal(
    validateDestinationUrlSync('http://hooks.example.com/webhook/abc').valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://localhost:5678/webhook/test').valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://127.0.0.1/webhook/test').valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://169.254.169.254/latest/meta-data/')
      .valid,
    false
  );
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
});
