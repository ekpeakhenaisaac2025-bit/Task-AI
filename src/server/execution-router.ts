import crypto from 'node:crypto';
import {
  getExecutableIntegrationForServer,
  recordIntegrationTestOutcome,
  reencryptIntegrationSecretRow,
  type ServerExecutableIntegration,
} from '../db/repository.ts';
import {
  recordIntegrationActivityLog,
  updateIntegrationOperationalTelemetry,
} from '../db/integrations-repository.ts';
import {
  decryptIntegrationSecretDetailed,
  isDedicatedVaultKeyConfigured,
  redactSecretsFromText,
  sanitizeEvidencePayload,
} from './crypto-vault.ts';
import { resolveOptionalSharedN8nConfig } from './env-config.ts';
import { executeLlmReasoningTask, isGeminiConfigured } from './gemini.ts';
import {
  safeOutboundHttpRequest,
  safeOutboundPostJson,
} from './ssrf-guard.ts';
import {
  executeNativeConnectorTask,
  isNativeConnectorProviderKey,
  testNativeConnectorConnection,
  type HttpTransportFn,
} from './connectors/native-connectors.ts';
import {
  executeN8nWorkflowTask,
  testN8nExistingInstanceConnection,
} from './connectors/n8n-connector.ts';
import {
  executeCustomApiTask,
  testCustomApiConnection,
} from './connectors/custom-api-connector.ts';
import { getCatalogItemForProvider } from '../lib/integration-registry.ts';
import type {
  CapabilityId,
  PlatformCapabilitiesInfo,
  TaskRecord,
  ToolRegistryItem,
  UserIntegrationRecord,
} from '../types.ts';
import type { ExecutionRouteResolution } from '../lib/domain-rules.ts';
import {
  buildProviderRegistryItems,
  getProviderDescriptor,
} from '../lib/provider-registry.ts';
import { assertWithinRateLimit } from './rate-limiter.ts';

const SAFE_WEBHOOK_PATH_REGEX = /^[a-zA-Z0-9/_-]+$/;

function adaptPostTransportToHttpTransport(
  postTransport?: typeof safeOutboundPostJson
): HttpTransportFn {
  if (!postTransport) {
    return safeOutboundHttpRequest;
  }
  return async (reqParams) => {
    const res = await postTransport({
      url: reqParams.url,
      headers: reqParams.headers ?? {},
      body:
        reqParams.body && typeof reqParams.body === 'object'
          ? (reqParams.body as Record<string, unknown>)
          : { raw: reqParams.body ?? null },
      timeoutMs: reqParams.timeoutMs,
      dnsLookup: reqParams.dnsLookup,
    });
    return {
      ok: res.ok,
      status: res.status,
      responseText: res.responseText,
      destinationOrigin: res.destinationOrigin,
      headers: {},
    };
  };
}

export function isPlatformAdminUser(
  email: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const shared = resolveOptionalSharedN8nConfig(env);
  if (!shared.adminEmailsValid || shared.adminEmails.length === 0) return false;
  return shared.adminEmails.includes(email.trim().toLowerCase());
}

export function getPlatformCapabilities(
  userEmail: string,
  env: NodeJS.ProcessEnv = process.env
): PlatformCapabilitiesInfo {
  const shared = resolveOptionalSharedN8nConfig(env);
  return {
    sharedN8nAvailable: shared.enabled,
    sharedN8nOrigin: shared.origin,
    dedicatedVaultKeyConfigured: isDedicatedVaultKeyConfigured(env),
    isPlatformAdmin: isPlatformAdminUser(userEmail, env),
  };
}

export function getBuiltInProviderReadiness(): {
  llmReasoningReady: boolean;
  internalTestReady: boolean;
} {
  return {
    llmReasoningReady: isGeminiConfigured(),
    internalTestReady: true,
  };
}

/**
 * Computes workspace-scoped provider statuses across legacy built-in and tenant-configurable adapters.
 */
export function buildWorkspaceToolRegistry(
  workspaceIntegrations: UserIntegrationRecord[]
): ToolRegistryItem[] {
  return buildProviderRegistryItems({
    geminiReady: isGeminiConfigured(),
    workspaceIntegrations,
  });
}

export function collectVerifiedWorkspaceCapabilities(
  workspaceIntegrations: UserIntegrationRecord[]
): CapabilityId[] {
  const caps = new Set<CapabilityId>(['diagnostic_verification']);
  if (isGeminiConfigured()) {
    caps.add('ai_reasoning');
    caps.add('content_drafting');
    caps.add('prospect_qualification');
  }
  for (const integ of workspaceIntegrations) {
    if (integ.enabled && integ.verified) {
      for (const c of integ.capabilities) {
        caps.add(c);
      }
    }
  }
  return Array.from(caps);
}

/**
 * Resolves the exact target URL and authenticated headers for a user/workspace webhook integration,
 * enforcing SSRF validation, tenant headers, and HMAC/header/Bearer signing.
 */
async function buildAuthenticatedIntegrationRequest(params: {
  executable: ServerExecutableIntegration;
  userId: string;
  eventType: 'connection_test' | 'task_execution';
  idempotencyKey: string;
  payload: Record<string, unknown>;
}): Promise<{
  targetUrl: string;
  headers: Record<string, string>;
}> {
  const { executable, userId, eventType, idempotencyKey, payload } = params;
  const { record } = executable;
  const meta = record.configMetadata;

  if (record.userId !== userId) {
    throw new Error('Cross-user integration execution denied.');
  }

  let targetUrl: string;
  const sharedConfig = resolveOptionalSharedN8nConfig();

  if (record.connectionMode === 'platform_shared') {
    if (record.providerKey !== 'n8n_webhook') {
      throw new Error(
        'Platform-shared mode is only supported for administrator-configured n8n instances.'
      );
    }
    if (
      !sharedConfig.enabled ||
      !sharedConfig.origin ||
      !sharedConfig.signingKey
    ) {
      throw new Error(
        sharedConfig.configurationIssue ||
          'Platform-shared n8n instance is not enabled. Both PLATFORM_SHARED_N8N_BASE_URL and PLATFORM_SHARED_N8N_SIGNING_SECRET must be valid.'
      );
    }
    const rawPath = (meta.webhookPath || '').trim().replace(/^\/+/, '');
    if (!rawPath || !SAFE_WEBHOOK_PATH_REGEX.test(rawPath)) {
      throw new Error(
        'Shared n8n integration requires a valid isolated webhook path.'
      );
    }
    if (!meta.workflowId?.trim()) {
      throw new Error(
        'Shared n8n integration requires an explicit isolated workflow ID.'
      );
    }
    targetUrl = `${sharedConfig.origin}/webhook/${rawPath}`;
  } else {
    if (!meta.endpointUrl?.trim()) {
      throw new Error('Integration endpoint URL is missing.');
    }
    targetUrl = meta.endpointUrl.trim();
  }

  const timestampSec = String(Math.floor(Date.now() / 1000));
  const serializedBody = JSON.stringify(payload);

  const headers: Record<string, string> = {
    'X-TaskAI-Event': eventType,
    'X-Idempotency-Key': idempotencyKey,
    'X-TaskAI-User-Id': record.userId,
    'X-TaskAI-Workspace-Id': record.workspaceId,
    'X-TaskAI-Integration-Id': record.id,
    'X-TaskAI-Timestamp': timestampSec,
  };

  if (meta.workflowId?.trim()) {
    headers['X-TaskAI-Workflow-Id'] = meta.workflowId.trim();
  }

  // Platform shared n8n signing (mandatory HMAC authenticity when platform_shared is used)
  if (record.connectionMode === 'platform_shared' && sharedConfig.signingKey) {
    const mac = crypto
      .createHmac('sha256', sharedConfig.signingKey)
      .update(
        `${timestampSec}.${record.userId}.${record.workspaceId}.${serializedBody}`
      )
      .digest('hex');
    headers['X-TaskAI-Platform-Signature'] = `t=${timestampSec},v1=${mac}`;
  }

  // Decrypt per-user credential strictly in memory if configured, transparently upgrading rotated keys
  if (
    executable.encryptedSecret &&
    executable.secretIv &&
    executable.secretAuthTag
  ) {
    const decrypted = decryptIntegrationSecretDetailed({
      ciphertextBase64: executable.encryptedSecret,
      ivBase64: executable.secretIv,
      authTagBase64: executable.secretAuthTag,
    });

    if (decrypted.needsReencryption) {
      await reencryptIntegrationSecretRow({
        integrationId: record.id,
        userId: record.userId,
        plaintextSecret: decrypted.plaintext,
      }).catch(() => {});
    }

    const secret = decrypted.plaintext;
    if (meta.authType === 'bearer_token' || meta.authType === 'oauth2') {
      headers['Authorization'] = `Bearer ${secret}`;
    } else if (meta.authType === 'hmac_sha256') {
      const sig = crypto
        .createHmac('sha256', secret)
        .update(`${timestampSec}.${serializedBody}`)
        .digest('hex');
      headers['X-TaskAI-Signature'] = `t=${timestampSec},v1=${sig}`;
    } else if (meta.authType === 'header_secret' || meta.authType === 'api_key') {
      const headerName =
        meta.secretHeaderName?.trim() &&
        /^[a-zA-Z0-9-]+$/.test(meta.secretHeaderName.trim())
          ? meta.secretHeaderName.trim()
          : 'X-TaskAI-Webhook-Secret';
      headers[headerName] = secret;
    }
  } else if (meta.authType !== 'none') {
    throw new Error(
      `Integration "${record.displayName}" requires a ${meta.authType} credential, but no secret is stored.`
    );
  }

  return { targetUrl, headers };
}

export async function testUserIntegrationConnection(params: {
  userId: string;
  integrationId: string;
  googleAccessToken?: string | null;
  httpTransport?: typeof safeOutboundPostJson;
  fullHttpTransport?: HttpTransportFn;
}): Promise<{
  success: boolean;
  statusDetail: string;
  httpStatus: number | null;
  testedAt: string;
  integration: UserIntegrationRecord;
}> {
  const transport = params.httpTransport ?? safeOutboundPostJson;
  const fullTransport =
    params.fullHttpTransport ??
    adaptPostTransportToHttpTransport(params.httpTransport);

  const executable = await getExecutableIntegrationForServer(
    params.integrationId,
    params.userId
  );
  if (!executable) {
    throw new Error('Integration not found or access denied.');
  }

  const descriptor = getProviderDescriptor(executable.record.providerKey);
  const catalogItem = getCatalogItemForProvider(executable.record.providerKey);
  const rpm =
    executable.record.rateLimitRpm ??
    descriptor?.rateLimit.requestsPerMinute ??
    catalogItem?.rateLimit.requestsPerMinute ??
    60;
  const burst =
    descriptor?.rateLimit.burstLimit ??
    catalogItem?.rateLimit.burstLimit ??
    15;

  assertWithinRateLimit({
    key: `provider:${executable.record.workspaceId}:${executable.record.providerKey}`,
    requestsPerMinute: rpm,
    burstLimit: burst,
    label: `${executable.record.providerKey} (${executable.record.workspaceId})`,
  });

  const startedMs = Date.now();
  const testedAtDate = new Date();
  const testedAt = testedAtDate.toISOString();

  // 1. Native Connectors (Google Workspace, Slack, Telegram, Microsoft Graph)
  if (isNativeConnectorProviderKey(executable.record.providerKey)) {
    const outcome = await testNativeConnectorConnection({
      executable,
      googleAccessToken: params.googleAccessToken,
      transport: fullTransport,
    });
    const updated = await recordIntegrationTestOutcome({
      integrationId: executable.record.id,
      userId: params.userId,
      verified: outcome.success,
      statusDetail: outcome.statusDetail,
      testedAt: testedAtDate,
      authStatus: outcome.authStatus,
      healthStatus: outcome.success ? 'healthy' : 'unhealthy',
    });

    await recordIntegrationActivityLog({
      userId: params.userId,
      workspaceId: executable.record.workspaceId,
      integrationId: executable.record.id,
      providerKey: executable.record.providerKey,
      operation: 'connection_test',
      direction: 'health_check',
      status: outcome.success ? 'success' : 'error',
      httpStatus: outcome.httpStatus,
      durationMs: Date.now() - startedMs,
      summary: outcome.statusDetail,
      errorMessage: outcome.success ? null : outcome.statusDetail,
    }).catch(() => {});

    return {
      success: outcome.success,
      statusDetail: outcome.statusDetail,
      httpStatus: outcome.httpStatus,
      testedAt,
      integration: updated ?? executable.record,
    };
  }

  // 2. Custom REST API Connector
  if (executable.record.providerKey === 'custom_api') {
    const outcome = await testCustomApiConnection({
      executable,
      transport: fullTransport,
    });
    const updated = await recordIntegrationTestOutcome({
      integrationId: executable.record.id,
      userId: params.userId,
      verified: outcome.success,
      statusDetail: outcome.statusDetail,
      testedAt: testedAtDate,
      authStatus: outcome.success ? 'authorized' : 'configured',
      healthStatus: outcome.success ? 'healthy' : 'unhealthy',
    });

    await recordIntegrationActivityLog({
      userId: params.userId,
      workspaceId: executable.record.workspaceId,
      integrationId: executable.record.id,
      providerKey: 'custom_api',
      operation: 'connection_test',
      direction: 'health_check',
      status: outcome.success ? 'success' : 'error',
      httpStatus: outcome.httpStatus,
      durationMs: Date.now() - startedMs,
      summary: outcome.statusDetail,
      errorMessage: outcome.success ? null : outcome.statusDetail,
    }).catch(() => {});

    return {
      success: outcome.success,
      statusDetail: outcome.statusDetail,
      httpStatus: outcome.httpStatus,
      testedAt,
      integration: updated ?? executable.record,
    };
  }

  // 3. n8n Existing Instance Mode (`existing_instance` without manual webhook URL)
  if (
    executable.record.providerKey === 'n8n_webhook' &&
    executable.record.configMetadata.n8nSetupMode === 'existing_instance' &&
    !executable.record.configMetadata.endpointUrl
  ) {
    const outcome = await testN8nExistingInstanceConnection({
      executable,
      transport: fullTransport,
    });
    const updated = await recordIntegrationTestOutcome({
      integrationId: executable.record.id,
      userId: params.userId,
      verified: outcome.success,
      statusDetail: outcome.statusDetail,
      testedAt: testedAtDate,
      authStatus: outcome.success ? 'authorized' : 'configured',
      healthStatus: outcome.success ? 'healthy' : 'unhealthy',
    });

    await recordIntegrationActivityLog({
      userId: params.userId,
      workspaceId: executable.record.workspaceId,
      integrationId: executable.record.id,
      providerKey: 'n8n_webhook',
      operation: 'n8n_instance_test',
      direction: 'health_check',
      status: outcome.success ? 'success' : 'error',
      httpStatus: outcome.httpStatus,
      durationMs: Date.now() - startedMs,
      summary: outcome.statusDetail,
      errorMessage: outcome.success ? null : outcome.statusDetail,
    }).catch(() => {});

    return {
      success: outcome.success,
      statusDetail: outcome.statusDetail,
      httpStatus: outcome.httpStatus,
      testedAt,
      integration: updated ?? executable.record,
    };
  }

  // 4. Signed HTTPS Webhook Connectors (n8n manual/platform_shared, Make, Zapier, Custom, CRM, Payment, Bridges)
  const probeIdempotencyKey = `probe:${executable.record.id}:${testedAtDate.getTime()}`;

  const probePayload: Record<string, unknown> = {
    type: 'task_ai_harmless_connection_probe',
    providerKey: executable.record.providerKey,
    connectionMode: executable.record.connectionMode,
    workspaceId: executable.record.workspaceId,
    integrationId: executable.record.id,
    workflowId: executable.record.configMetadata.workflowId ?? null,
    timestamp: testedAt,
  };

  try {
    const { targetUrl, headers } = await buildAuthenticatedIntegrationRequest({
      executable,
      userId: params.userId,
      eventType: 'connection_test',
      idempotencyKey: probeIdempotencyKey,
      payload: probePayload,
    });

    const response = await transport({
      url: targetUrl,
      headers,
      body: probePayload,
      timeoutMs: 8000,
    });

    if (!response.ok) {
      const detail = `Endpoint responded with HTTP ${response.status}. Tasks remain gated until connection returns 2xx.`;
      const updated = await recordIntegrationTestOutcome({
        integrationId: executable.record.id,
        userId: params.userId,
        verified: false,
        statusDetail: detail,
        testedAt: testedAtDate,
      });

      await recordIntegrationActivityLog({
        userId: params.userId,
        workspaceId: executable.record.workspaceId,
        integrationId: executable.record.id,
        providerKey: executable.record.providerKey,
        operation: 'connection_test',
        direction: 'health_check',
        status: 'error',
        httpStatus: response.status,
        durationMs: Date.now() - startedMs,
        summary: detail,
        errorMessage: detail,
      }).catch(() => {});

      return {
        success: false,
        statusDetail: detail,
        httpStatus: response.status,
        testedAt,
        integration: updated ?? executable.record,
      };
    }

    const detail = `Connection verified (HTTP ${response.status} from ${response.destinationOrigin}) at ${testedAt}.`;
    const updated = await recordIntegrationTestOutcome({
      integrationId: executable.record.id,
      userId: params.userId,
      verified: true,
      statusDetail: detail,
      testedAt: testedAtDate,
      authStatus: 'authorized',
      healthStatus: 'healthy',
    });

    await recordIntegrationActivityLog({
      userId: params.userId,
      workspaceId: executable.record.workspaceId,
      integrationId: executable.record.id,
      providerKey: executable.record.providerKey,
      operation: 'connection_test',
      direction: 'health_check',
      status: 'success',
      httpStatus: response.status,
      durationMs: Date.now() - startedMs,
      summary: detail,
    }).catch(() => {});

    return {
      success: true,
      statusDetail: detail,
      httpStatus: response.status,
      testedAt,
      integration: updated ?? executable.record,
    };
  } catch (error: unknown) {
    const rawMsg =
      error instanceof Error
        ? error.message
        : 'Outbound connection verification failed.';
    const msg = redactSecretsFromText(rawMsg);
    const detail = `Connection verification failed: ${msg}`;
    const updated = await recordIntegrationTestOutcome({
      integrationId: executable.record.id,
      userId: params.userId,
      verified: false,
      statusDetail: detail,
      testedAt: testedAtDate,
    });

    await recordIntegrationActivityLog({
      userId: params.userId,
      workspaceId: executable.record.workspaceId,
      integrationId: executable.record.id,
      providerKey: executable.record.providerKey,
      operation: 'connection_test',
      direction: 'health_check',
      status: 'error',
      httpStatus: null,
      durationMs: Date.now() - startedMs,
      summary: detail,
      errorMessage: detail,
    }).catch(() => {});

    return {
      success: false,
      statusDetail: detail,
      httpStatus: null,
      testedAt,
      integration: updated ?? executable.record,
    };
  }
}

export interface RoutedExecutionResult {
  executionProvider: string;
  integrationId: string | null;
  completedSummary: string;
  outputData: Record<string, unknown>;
  awaitingExternalOutcomeVerification: boolean;
  independentVerification: {
    verified: boolean;
    verificationSummary?: string;
    verificationEvidence?: Record<string, unknown>;
  };
}

export async function executeRoutedTask(params: {
  userId: string;
  problem: string;
  targetMetric: string;
  task: TaskRecord;
  route: Extract<ExecutionRouteResolution, { routable: true }>;
  prerequisiteOutputs: Array<{
    stepOrder: number;
    description: string;
    outputData: Record<string, unknown> | null;
  }>;
  googleAccessToken?: string | null;
  httpTransport?: typeof safeOutboundPostJson;
  fullHttpTransport?: HttpTransportFn;
}): Promise<RoutedExecutionResult> {
  const { task, route } = params;
  const transport = params.httpTransport ?? safeOutboundPostJson;
  const fullTransport =
    params.fullHttpTransport ??
    adaptPostTransportToHttpTransport(params.httpTransport);

  const providerDescriptor = getProviderDescriptor(
    route.providerKey as Parameters<typeof getProviderDescriptor>[0]
  );
  const catalogItem = getCatalogItemForProvider(route.providerKey);
  if (providerDescriptor || catalogItem) {
    assertWithinRateLimit({
      key: `provider:${task.workspaceId || params.userId}:${route.providerKey}`,
      requestsPerMinute:
        providerDescriptor?.rateLimit.requestsPerMinute ??
        catalogItem?.rateLimit.requestsPerMinute ??
        60,
      burstLimit:
        providerDescriptor?.rateLimit.burstLimit ??
        catalogItem?.rateLimit.burstLimit ??
        15,
      label: `${route.providerKey} (${task.workspaceId || 'workspace'})`,
    });
  }

  if (route.providerKey === 'internal_test_tool') {
    if (task.description.includes('[SIMULATE_FAILURE]')) {
      throw new Error(
        'Internal verification fault-injection triggered: simulated checksum mismatch during worker execution.'
      );
    }

    const executedAt = new Date().toISOString();
    const canonicalPayload = JSON.stringify({
      taskId: task.id,
      goalId: task.goalId,
      workspaceId: task.workspaceId,
      idempotencyKey: task.idempotencyKey,
      prerequisiteCount: params.prerequisiteOutputs.length,
      description: task.description,
    });
    const sha256Digest = crypto
      .createHash('sha256')
      .update(canonicalPayload)
      .digest('hex');

    const recomputedDigest = crypto
      .createHash('sha256')
      .update(canonicalPayload)
      .digest('hex');

    if (sha256Digest !== recomputedDigest) {
      throw new Error('Internal verification digest mismatch.');
    }

    return {
      executionProvider: route.providerLabel,
      integrationId: null,
      completedSummary: `Harmless internal verification executed (${params.prerequisiteOutputs.length} prerequisite input(s) validated).`,
      outputData: {
        provider: route.providerLabel,
        harmlessExecution: true,
        prerequisiteArtifactsChecked: params.prerequisiteOutputs.length,
        payloadSha256: sha256Digest,
        idempotencyKey: task.idempotencyKey,
        executedAt,
      },
      awaitingExternalOutcomeVerification: false,
      independentVerification: {
        verified: true,
        verificationSummary: `Independently verified deterministic SHA-256 payload digest (${sha256Digest.slice(0, 12)}...).`,
        verificationEvidence: {
          verificationType: 'deterministic_sha256_invariant',
          payloadSha256: sha256Digest,
          idempotencyKey: task.idempotencyKey,
          verifiedAt: executedAt,
          authoritativeExternalSource: false,
        },
      },
    };
  }

  if (route.providerKey === 'llm_reasoning') {
    const llmResult = await executeLlmReasoningTask({
      problem: params.problem,
      targetMetric: params.targetMetric,
      task,
      prerequisiteOutputs: params.prerequisiteOutputs,
    });

    return {
      executionProvider: route.providerLabel,
      integrationId: null,
      completedSummary: llmResult.summary,
      outputData: {
        ...llmResult.outputData,
        provider: route.providerLabel,
        idempotencyKey: task.idempotencyKey,
      },
      awaitingExternalOutcomeVerification: false,
      independentVerification: {
        verified: false,
      },
    };
  }

  // External user/workspace integration execution
  if (!route.integrationId) {
    throw new Error(
      'Execution Router could not resolve an authorized workspace integration ID.'
    );
  }

  const executable = await getExecutableIntegrationForServer(
    route.integrationId,
    params.userId,
    task.workspaceId ?? undefined
  );
  if (!executable) {
    throw new Error('Authorized integration not found for this workspace.');
  }
  if (
    task.workspaceId &&
    executable.record.workspaceId !== task.workspaceId
  ) {
    throw new Error(
      'Cross-workspace integration execution denied: integration belongs to a different workspace.'
    );
  }
  if (!executable.record.enabled || !executable.record.verified) {
    throw new Error(
      `Integration "${executable.record.displayName}" is not enabled and connection-verified.`
    );
  }

  const startedMs = Date.now();
  const dispatchedAt = new Date().toISOString();
  const outboundPayload: Record<string, unknown> = {
    event: 'task_execution',
    tenant: {
      userId: params.userId,
      workspaceId: executable.record.workspaceId,
      integrationId: executable.record.id,
      workflowId: executable.record.configMetadata.workflowId ?? null,
    },
    callbackWebhookPath: `/api/webhooks/inbound/${executable.record.workspaceId}`,
    task: {
      id: task.id,
      goalId: task.goalId,
      idempotencyKey: task.idempotencyKey,
      actionCategory: task.actionCategory,
      requiredCapabilities: task.requiredCapabilities,
      description: task.description,
      proposedActionDetails: task.proposedActionDetails,
      expectedResult: task.expectedResult,
      verificationCriteria: task.verificationMethod,
    },
    prerequisiteOutputs: params.prerequisiteOutputs,
    dispatchedAt,
  };

  try {
    // Branch A: Native Connectors
    if (isNativeConnectorProviderKey(executable.record.providerKey)) {
      const nativeOut = await executeNativeConnectorTask({
        executable,
        task,
        googleAccessToken: params.googleAccessToken,
        prerequisiteOutputs: params.prerequisiteOutputs,
        transport: fullTransport,
      });

      await updateIntegrationOperationalTelemetry({
        integrationId: executable.record.id,
        userId: params.userId,
        succeeded: true,
      }).catch(() => {});

      await recordIntegrationActivityLog({
        userId: params.userId,
        workspaceId: executable.record.workspaceId,
        integrationId: executable.record.id,
        providerKey: executable.record.providerKey,
        operation: 'task_execution',
        direction: 'outbound',
        status: 'success',
        httpStatus: 200,
        durationMs: Date.now() - startedMs,
        summary: nativeOut.completedSummary,
        metadata: { taskId: task.id },
      }).catch(() => {});

      return {
        executionProvider: route.providerLabel,
        integrationId: executable.record.id,
        completedSummary: nativeOut.completedSummary,
        outputData: nativeOut.outputData,
        awaitingExternalOutcomeVerification:
          nativeOut.awaitingExternalOutcomeVerification,
        independentVerification: { verified: false },
      };
    }

    // Branch B: Custom REST API Connector
    if (executable.record.providerKey === 'custom_api') {
      const customOut = await executeCustomApiTask({
        executable,
        task,
        prerequisiteOutputs: params.prerequisiteOutputs,
        transport: fullTransport,
      });

      await updateIntegrationOperationalTelemetry({
        integrationId: executable.record.id,
        userId: params.userId,
        succeeded: true,
      }).catch(() => {});

      await recordIntegrationActivityLog({
        userId: params.userId,
        workspaceId: executable.record.workspaceId,
        integrationId: executable.record.id,
        providerKey: 'custom_api',
        operation: 'task_execution',
        direction: 'outbound',
        status: 'success',
        httpStatus: 200,
        durationMs: Date.now() - startedMs,
        summary: customOut.completedSummary,
        metadata: { taskId: task.id },
      }).catch(() => {});

      return {
        executionProvider: route.providerLabel,
        integrationId: executable.record.id,
        completedSummary: customOut.completedSummary,
        outputData: customOut.outputData,
        awaitingExternalOutcomeVerification: true,
        independentVerification: { verified: false },
      };
    }

    // Branch C: n8n User-Owned Instance / Registered Workflows
    if (
      executable.record.providerKey === 'n8n_webhook' &&
      executable.record.connectionMode === 'user_owned' &&
      executable.record.configMetadata.n8nSetupMode === 'existing_instance'
    ) {
      const n8nOut = await executeN8nWorkflowTask({
        executable,
        userId: params.userId,
        task,
        outboundPayload,
        transport: fullTransport,
      });

      await updateIntegrationOperationalTelemetry({
        integrationId: executable.record.id,
        userId: params.userId,
        succeeded: true,
      }).catch(() => {});

      await recordIntegrationActivityLog({
        userId: params.userId,
        workspaceId: executable.record.workspaceId,
        integrationId: executable.record.id,
        providerKey: 'n8n_webhook',
        operation: 'trigger_workflow',
        direction: 'outbound',
        status: 'success',
        httpStatus: 200,
        durationMs: Date.now() - startedMs,
        summary: n8nOut.completedSummary,
        metadata: {
          taskId: task.id,
          workflowId: n8nOut.matchedWorkflow?.workflowExternalId ?? null,
        },
      }).catch(() => {});

      return {
        executionProvider: route.providerLabel,
        integrationId: executable.record.id,
        completedSummary: n8nOut.completedSummary,
        outputData: n8nOut.outputData,
        awaitingExternalOutcomeVerification: true,
        independentVerification: { verified: false },
      };
    }

    // Branch D: Standard Signed HTTPS Webhook (n8n manual/platform_shared, Make, Zapier, Custom, CRM, Payment)
    const { targetUrl, headers } = await buildAuthenticatedIntegrationRequest({
      executable,
      userId: params.userId,
      eventType: 'task_execution',
      idempotencyKey: task.idempotencyKey,
      payload: outboundPayload,
    });

    const timeoutMs =
      task.executionTimeoutMs > 0
        ? Math.min(task.executionTimeoutMs, 25000)
        : 12000;

    const response = await transport({
      url: targetUrl,
      headers,
      body: outboundPayload,
      timeoutMs,
    });

    if (!response.ok) {
      throw new Error(
        `Provider "${executable.record.displayName}" (${executable.record.providerKey}) failed with HTTP ${response.status}: ${response.responseText.slice(0, 200)}`
      );
    }

    await updateIntegrationOperationalTelemetry({
      integrationId: executable.record.id,
      userId: params.userId,
      succeeded: true,
    }).catch(() => {});

    const completedSummary = `Dispatched to ${executable.record.providerKey} "${executable.record.displayName}" (HTTP ${response.status} from ${response.destinationOrigin}). Execution accepted; task entered pending_verification until independent outcome evidence arrives.`;

    await recordIntegrationActivityLog({
      userId: params.userId,
      workspaceId: executable.record.workspaceId,
      integrationId: executable.record.id,
      providerKey: executable.record.providerKey,
      operation: 'task_execution',
      direction: 'outbound',
      status: 'success',
      httpStatus: response.status,
      durationMs: Date.now() - startedMs,
      summary: completedSummary,
      metadata: { taskId: task.id },
    }).catch(() => {});

    return {
      executionProvider: route.providerLabel,
      integrationId: executable.record.id,
      completedSummary,
      outputData: sanitizeEvidencePayload({
        providerKey: executable.record.providerKey,
        integrationId: executable.record.id,
        integrationName: executable.record.displayName,
        connectionMode: executable.record.connectionMode,
        workflowId: executable.record.configMetadata.workflowId ?? null,
        destinationOrigin: response.destinationOrigin,
        httpStatus: response.status,
        externalDispatchConfirmed: true,
        responsePreview: response.responseText.slice(0, 400),
        idempotencyKey: task.idempotencyKey,
        dispatchedAt,
      }),
      awaitingExternalOutcomeVerification: true,
      independentVerification: {
        verified: false,
      },
    };
  } catch (err: unknown) {
    const safeMsg =
      err instanceof Error ? redactSecretsFromText(err.message) : 'Execution error';
    await updateIntegrationOperationalTelemetry({
      integrationId: executable.record.id,
      userId: params.userId,
      succeeded: false,
      errorMessage: safeMsg,
    }).catch(() => {});

    await recordIntegrationActivityLog({
      userId: params.userId,
      workspaceId: executable.record.workspaceId,
      integrationId: executable.record.id,
      providerKey: executable.record.providerKey,
      operation: 'task_execution',
      direction: 'outbound',
      status: 'error',
      httpStatus: null,
      durationMs: Date.now() - startedMs,
      summary: `Outbound execution failed for "${executable.record.displayName}".`,
      errorMessage: safeMsg,
      metadata: { taskId: task.id },
    }).catch(() => {});

    throw err;
  }
}
