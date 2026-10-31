import crypto from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from './index.ts';
import {
  aiProviderConfigs,
  integrationActivityLogs,
  n8nWorkflows,
  oauthStates,
  userIntegrations,
  workforceConfigurations,
} from './schema.ts';
import {
  redactSecretsFromText,
  sanitizeEvidencePayload,
} from '../server/crypto-vault.ts';
import type {
  AiProviderId,
  CapabilityId,
  CapabilityReadinessState,
  ConnectorHealthStatus,
  CustomApiHttpMethod,
  IntegrationActivityLogRecord,
  N8nRegisteredWorkflowRecord,
  WorkforceConfigurationRecord,
  WorkforceConnectorRecommendation,
} from '../types.ts';

function mapN8nWorkflowRow(
  row: typeof n8nWorkflows.$inferSelect
): N8nRegisteredWorkflowRecord {
  return {
    id: row.id,
    integrationId: row.integrationId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    workflowExternalId: row.workflowExternalId,
    name: row.name,
    description: row.description,
    webhookUrlOrPath: row.webhookUrlOrPath,
    httpMethod: (row.httpMethod as CustomApiHttpMethod) || 'POST',
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    inputSchema: row.inputSchema ?? {},
    active: row.active,
    discoveredViaApi: row.discoveredViaApi,
    lastTriggeredAt: row.lastTriggeredAt
      ? row.lastTriggeredAt.toISOString()
      : null,
    lastStatus: row.lastStatus ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapActivityLogRow(
  row: typeof integrationActivityLogs.$inferSelect
): IntegrationActivityLogRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    integrationId: row.integrationId ?? null,
    providerKey: row.providerKey,
    operation: row.operation,
    direction:
      (row.direction as IntegrationActivityLogRecord['direction']) ||
      'outbound',
    status: (row.status as IntegrationActivityLogRecord['status']) || 'success',
    httpStatus: row.httpStatus ?? null,
    durationMs: row.durationMs ?? null,
    summary: row.summary,
    errorMessage: row.errorMessage ?? null,
    metadata: row.metadataJson ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

function mapWorkforceConfigRow(
  row: typeof workforceConfigurations.$inferSelect
): WorkforceConfigurationRecord {
  const matrix = row.capabilityMatrixJson ?? ({} as Record<
    CapabilityId,
    CapabilityReadinessState
  >);
  const required = Array.isArray(row.requiredCapabilitiesJson)
    ? row.requiredCapabilitiesJson
    : [];
  const missing = required.filter((cap) => matrix[cap] !== 'operational');

  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    goalId: row.goalId ?? null,
    conversationId: row.conversationId ?? null,
    title: row.title,
    requestPrompt: row.requestPrompt,
    roleSummary: row.roleSummary,
    status:
      (row.status as WorkforceConfigurationRecord['status']) ||
      'awaiting_authorization',
    requiredCapabilities: required,
    recommendedConnectors: Array.isArray(row.recommendedConnectorsJson)
      ? row.recommendedConnectorsJson
      : [],
    approvedConnectorIds: Array.isArray(row.approvedConnectorIdsJson)
      ? row.approvedConnectorIdsJson
      : [],
    rejectedProviders: Array.isArray(row.rejectedProvidersJson)
      ? row.rejectedProvidersJson
      : [],
    capabilityMatrix: matrix,
    missingCapabilities: missing,
    activationBlockerReason: row.activationBlockerReason ?? null,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ============================================================================
// 1. N8N REGISTERED WORKFLOWS (PER USER / PER WORKSPACE / PER INTEGRATION)
// ============================================================================

export async function listN8nWorkflowsByWorkspace(params: {
  userId: string;
  workspaceId: string;
  integrationId?: string;
}): Promise<N8nRegisteredWorkflowRecord[]> {
  const conditions = [
    eq(n8nWorkflows.userId, params.userId),
    eq(n8nWorkflows.workspaceId, params.workspaceId),
  ];
  if (params.integrationId) {
    conditions.push(eq(n8nWorkflows.integrationId, params.integrationId));
  }
  const rows = await db
    .select()
    .from(n8nWorkflows)
    .where(and(...conditions))
    .orderBy(desc(n8nWorkflows.active), asc(n8nWorkflows.createdAt));

  return rows.map(mapN8nWorkflowRow);
}

export async function upsertN8nWorkflowForIntegration(params: {
  userId: string;
  workspaceId: string;
  integrationId: string;
  workflowExternalId: string;
  name: string;
  description?: string;
  webhookUrlOrPath: string;
  httpMethod?: CustomApiHttpMethod;
  capabilities: CapabilityId[];
  inputSchema?: Record<string, unknown>;
  active?: boolean;
  discoveredViaApi?: boolean;
}): Promise<N8nRegisteredWorkflowRecord> {
  const existingRows = await db
    .select()
    .from(n8nWorkflows)
    .where(
      and(
        eq(n8nWorkflows.userId, params.userId),
        eq(n8nWorkflows.workspaceId, params.workspaceId),
        eq(n8nWorkflows.integrationId, params.integrationId),
        eq(n8nWorkflows.workflowExternalId, params.workflowExternalId.trim())
      )
    );

  const now = new Date();
  if (existingRows[0]) {
    const updated = await db
      .update(n8nWorkflows)
      .set({
        name: params.name.trim(),
        description: (params.description ?? '').trim(),
        webhookUrlOrPath: params.webhookUrlOrPath.trim(),
        httpMethod: params.httpMethod ?? 'POST',
        capabilities: params.capabilities,
        inputSchema: params.inputSchema ?? existingRows[0].inputSchema ?? {},
        active: params.active ?? existingRows[0].active,
        discoveredViaApi:
          params.discoveredViaApi ?? existingRows[0].discoveredViaApi,
        updatedAt: now,
      })
      .where(
        and(
          eq(n8nWorkflows.id, existingRows[0].id),
          eq(n8nWorkflows.userId, params.userId)
        )
      )
      .returning();
    return mapN8nWorkflowRow(updated[0]);
  }

  const inserted = await db
    .insert(n8nWorkflows)
    .values({
      id: crypto.randomUUID(),
      integrationId: params.integrationId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      workflowExternalId: params.workflowExternalId.trim(),
      name: params.name.trim(),
      description: (params.description ?? '').trim(),
      webhookUrlOrPath: params.webhookUrlOrPath.trim(),
      httpMethod: params.httpMethod ?? 'POST',
      capabilities: params.capabilities,
      inputSchema: params.inputSchema ?? {},
      active: params.active ?? true,
      discoveredViaApi: params.discoveredViaApi ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return mapN8nWorkflowRow(inserted[0]);
}

export async function recordN8nWorkflowExecutionStatus(params: {
  workflowId: string;
  userId: string;
  status: string;
}): Promise<void> {
  const now = new Date();
  await db
    .update(n8nWorkflows)
    .set({
      lastTriggeredAt: now,
      lastStatus: params.status,
      updatedAt: now,
    })
    .where(
      and(
        eq(n8nWorkflows.id, params.workflowId),
        eq(n8nWorkflows.userId, params.userId)
      )
    );
}

export async function deleteN8nWorkflowForUser(params: {
  workflowId: string;
  userId: string;
  workspaceId: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(n8nWorkflows)
    .where(
      and(
        eq(n8nWorkflows.id, params.workflowId),
        eq(n8nWorkflows.userId, params.userId),
        eq(n8nWorkflows.workspaceId, params.workspaceId)
      )
    )
    .returning({ id: n8nWorkflows.id });
  return deleted.length > 0;
}

// ============================================================================
// 2. INTEGRATION ACTIVITY & HEALTH TELEMETRY LOGS (SECRET-SANITIZED)
// ============================================================================

export async function recordIntegrationActivityLog(params: {
  userId: string;
  workspaceId: string;
  integrationId?: string | null;
  providerKey: string;
  operation: string;
  direction: 'outbound' | 'inbound' | 'health_check' | 'auth';
  status: 'success' | 'error' | 'deduplicated';
  httpStatus?: number | null;
  durationMs?: number | null;
  summary: string;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<IntegrationActivityLogRecord> {
  const cleanSummary = redactSecretsFromText(params.summary);
  const cleanError = params.errorMessage
    ? redactSecretsFromText(params.errorMessage)
    : null;
  const cleanMetadata = params.metadata
    ? sanitizeEvidencePayload(params.metadata)
    : {};

  const inserted = await db
    .insert(integrationActivityLogs)
    .values({
      id: crypto.randomUUID(),
      userId: params.userId,
      workspaceId: params.workspaceId,
      integrationId: params.integrationId ?? null,
      providerKey: params.providerKey,
      operation: params.operation,
      direction: params.direction,
      status: params.status,
      httpStatus: params.httpStatus ?? null,
      durationMs: params.durationMs ?? null,
      summary: cleanSummary,
      errorMessage: cleanError,
      metadataJson: cleanMetadata,
      createdAt: new Date(),
    })
    .returning();

  return mapActivityLogRow(inserted[0]);
}

export async function listIntegrationActivityLogs(params: {
  userId: string;
  workspaceId: string;
  integrationId?: string;
  limit?: number;
}): Promise<IntegrationActivityLogRecord[]> {
  const conditions = [
    eq(integrationActivityLogs.userId, params.userId),
    eq(integrationActivityLogs.workspaceId, params.workspaceId),
  ];
  if (params.integrationId) {
    conditions.push(
      eq(integrationActivityLogs.integrationId, params.integrationId)
    );
  }

  const rows = await db
    .select()
    .from(integrationActivityLogs)
    .where(and(...conditions))
    .orderBy(desc(integrationActivityLogs.createdAt))
    .limit(Math.min(Math.max(params.limit ?? 40, 1), 150));

  return rows.map(mapActivityLogRow);
}

export async function updateIntegrationOperationalTelemetry(params: {
  integrationId: string;
  userId: string;
  succeeded: boolean;
  errorMessage?: string | null;
  healthStatus?: ConnectorHealthStatus;
}): Promise<void> {
  const now = new Date();
  const cleanErr = params.errorMessage
    ? redactSecretsFromText(params.errorMessage)
    : null;

  await db
    .update(userIntegrations)
    .set({
      lastActivityAt: now,
      ...(params.succeeded
        ? {
            lastSuccessAt: now,
            lastErrorMessage: null,
            healthStatus: params.healthStatus ?? 'healthy',
          }
        : {
            lastErrorMessage: cleanErr,
            healthStatus: params.healthStatus ?? 'degraded',
          }),
      updatedAt: now,
    })
    .where(
      and(
        eq(userIntegrations.id, params.integrationId),
        eq(userIntegrations.userId, params.userId)
      )
    );
}

// ============================================================================
// 3. OAUTH 2.0 CSRF STATE TOKENS (SINGLE-USE, TENANT-SCOPED)
// ============================================================================

export async function createOAuthStateToken(params: {
  userId: string;
  workspaceId: string;
  providerKey: string;
  redirectUri: string;
  requestedScopes: string[];
  ttlSeconds?: number;
}): Promise<string> {
  const stateToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(
    Date.now() + (params.ttlSeconds ?? 600) * 1000
  );

  await db.insert(oauthStates).values({
    stateToken,
    userId: params.userId,
    workspaceId: params.workspaceId,
    providerKey: params.providerKey,
    redirectUri: params.redirectUri,
    requestedScopes: params.requestedScopes,
    expiresAt,
    createdAt: new Date(),
  });

  return stateToken;
}

export async function consumeOAuthStateToken(stateToken: string): Promise<{
  userId: string;
  workspaceId: string;
  providerKey: string;
  redirectUri: string;
  requestedScopes: string[];
} | null> {
  const trimmed = stateToken.trim();
  if (!trimmed) return null;

  const now = new Date();
  const updated = await db
    .update(oauthStates)
    .set({ consumedAt: now })
    .where(
      and(
        eq(oauthStates.stateToken, trimmed),
        isNull(oauthStates.consumedAt),
        gt(oauthStates.expiresAt, now)
      )
    )
    .returning();

  const row = updated[0];
  if (!row) return null;

  return {
    userId: row.userId,
    workspaceId: row.workspaceId,
    providerKey: row.providerKey,
    redirectUri: row.redirectUri,
    requestedScopes: Array.isArray(row.requestedScopes)
      ? row.requestedScopes
      : [],
  };
}

// ============================================================================
// 4. AI PROVIDER CONFIGS & USAGE COUNTERS
// ============================================================================

export async function listAiProviderConfigsForWorkspace(params: {
  userId: string;
  workspaceId: string;
}): Promise<Array<typeof aiProviderConfigs.$inferSelect>> {
  return db
    .select()
    .from(aiProviderConfigs)
    .where(
      and(
        eq(aiProviderConfigs.userId, params.userId),
        eq(aiProviderConfigs.workspaceId, params.workspaceId)
      )
    )
    .orderBy(asc(aiProviderConfigs.fallbackPriority));
}

export async function upsertAiProviderConfigForWorkspace(params: {
  userId: string;
  workspaceId: string;
  providerId: AiProviderId;
  enabled?: boolean;
  preferredModel?: string;
  fallbackPriority?: number;
  lastHealthStatus?: ConnectorHealthStatus;
  lastLatencyMs?: number | null;
  lastCheckedAt?: Date;
  lastErrorMessage?: string | null;
  incrementTotal?: boolean;
  incrementFailed?: boolean;
}): Promise<typeof aiProviderConfigs.$inferSelect> {
  const existingRows = await db
    .select()
    .from(aiProviderConfigs)
    .where(
      and(
        eq(aiProviderConfigs.userId, params.userId),
        eq(aiProviderConfigs.workspaceId, params.workspaceId),
        eq(aiProviderConfigs.providerId, params.providerId)
      )
    );

  const now = new Date();
  const defaultModel =
    params.providerId === 'gemini'
      ? 'gemini-3-flash-preview'
      : params.providerId === 'openai'
        ? 'gpt-4o-mini'
        : 'claude-3-5-sonnet-latest';
  const defaultPriority =
    params.providerId === 'gemini'
      ? 1
      : params.providerId === 'openai'
        ? 2
        : 3;

  if (existingRows[0]) {
    const existing = existingRows[0];
    const updated = await db
      .update(aiProviderConfigs)
      .set({
        enabled: params.enabled ?? existing.enabled,
        preferredModel: params.preferredModel ?? existing.preferredModel,
        fallbackPriority: params.fallbackPriority ?? existing.fallbackPriority,
        lastHealthStatus: params.lastHealthStatus ?? existing.lastHealthStatus,
        lastLatencyMs:
          params.lastLatencyMs !== undefined
            ? params.lastLatencyMs
            : existing.lastLatencyMs,
        lastCheckedAt: params.lastCheckedAt ?? existing.lastCheckedAt,
        lastErrorMessage:
          params.lastErrorMessage !== undefined
            ? params.lastErrorMessage
              ? redactSecretsFromText(params.lastErrorMessage)
              : null
            : existing.lastErrorMessage,
        totalRequests: params.incrementTotal
          ? sql`${aiProviderConfigs.totalRequests} + 1`
          : existing.totalRequests,
        failedRequests: params.incrementFailed
          ? sql`${aiProviderConfigs.failedRequests} + 1`
          : existing.failedRequests,
        updatedAt: now,
      })
      .where(eq(aiProviderConfigs.id, existing.id))
      .returning();

    return updated[0];
  }

  const inserted = await db
    .insert(aiProviderConfigs)
    .values({
      id: crypto.randomUUID(),
      userId: params.userId,
      workspaceId: params.workspaceId,
      providerId: params.providerId,
      enabled: params.enabled ?? (params.providerId === 'gemini'),
      preferredModel: params.preferredModel ?? defaultModel,
      fallbackPriority: params.fallbackPriority ?? defaultPriority,
      totalRequests: params.incrementTotal ? 1 : 0,
      failedRequests: params.incrementFailed ? 1 : 0,
      lastLatencyMs: params.lastLatencyMs ?? null,
      lastHealthStatus: params.lastHealthStatus ?? 'untested',
      lastCheckedAt: params.lastCheckedAt ?? null,
      lastErrorMessage: params.lastErrorMessage
        ? redactSecretsFromText(params.lastErrorMessage)
        : null,
      updatedAt: now,
    })
    .returning();

  return inserted[0];
}

// ============================================================================
// 5. INTELLIGENT WORKFORCE CONFIGURATIONS
// ============================================================================

export async function listWorkforceConfigurationsForWorkspace(params: {
  userId: string;
  workspaceId: string;
}): Promise<WorkforceConfigurationRecord[]> {
  const rows = await db
    .select()
    .from(workforceConfigurations)
    .where(
      and(
        eq(workforceConfigurations.userId, params.userId),
        eq(workforceConfigurations.workspaceId, params.workspaceId)
      )
    )
    .orderBy(desc(workforceConfigurations.updatedAt));

  return rows.map(mapWorkforceConfigRow);
}

export async function getWorkforceConfigurationByIdForUser(params: {
  configId: string;
  userId: string;
  workspaceId?: string;
}): Promise<WorkforceConfigurationRecord | null> {
  const clauses = [
    eq(workforceConfigurations.id, params.configId),
    eq(workforceConfigurations.userId, params.userId),
  ];
  if (params.workspaceId) {
    clauses.push(eq(workforceConfigurations.workspaceId, params.workspaceId));
  }
  const rows = await db
    .select()
    .from(workforceConfigurations)
    .where(and(...clauses));
  return rows[0] ? mapWorkforceConfigRow(rows[0]) : null;
}

export async function createWorkforceConfigurationRow(params: {
  userId: string;
  workspaceId: string;
  goalId?: string | null;
  conversationId?: string | null;
  title: string;
  requestPrompt: string;
  roleSummary: string;
  status: WorkforceConfigurationRecord['status'];
  requiredCapabilities: CapabilityId[];
  recommendedConnectors: WorkforceConnectorRecommendation[];
  approvedConnectorIds?: string[];
  rejectedProviders?: string[];
  capabilityMatrix: Record<CapabilityId, CapabilityReadinessState>;
  activationBlockerReason?: string | null;
}): Promise<WorkforceConfigurationRecord> {
  const now = new Date();
  const inserted = await db
    .insert(workforceConfigurations)
    .values({
      id: crypto.randomUUID(),
      userId: params.userId,
      workspaceId: params.workspaceId,
      goalId: params.goalId ?? null,
      conversationId: params.conversationId ?? null,
      title: params.title.trim(),
      requestPrompt: params.requestPrompt.trim(),
      roleSummary: params.roleSummary.trim(),
      status: params.status,
      requiredCapabilitiesJson: params.requiredCapabilities,
      recommendedConnectorsJson: params.recommendedConnectors,
      approvedConnectorIdsJson: params.approvedConnectorIds ?? [],
      rejectedProvidersJson: params.rejectedProviders ?? [],
      capabilityMatrixJson: params.capabilityMatrix,
      activationBlockerReason: params.activationBlockerReason ?? null,
      activatedAt: params.status === 'operational' ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return mapWorkforceConfigRow(inserted[0]);
}

export async function updateWorkforceConfigurationRow(params: {
  configId: string;
  userId: string;
  status?: WorkforceConfigurationRecord['status'];
  requiredCapabilities?: CapabilityId[];
  recommendedConnectors?: WorkforceConnectorRecommendation[];
  approvedConnectorIds?: string[];
  rejectedProviders?: string[];
  capabilityMatrix?: Record<CapabilityId, CapabilityReadinessState>;
  activationBlockerReason?: string | null;
  lastTestedAt?: Date | null;
  activatedAt?: Date | null;
  goalId?: string | null;
}): Promise<WorkforceConfigurationRecord | null> {
  const now = new Date();
  const updatePayload: Partial<typeof workforceConfigurations.$inferInsert> = {
    updatedAt: now,
  };
  if (params.status !== undefined) updatePayload.status = params.status;
  if (params.requiredCapabilities !== undefined) {
    updatePayload.requiredCapabilitiesJson = params.requiredCapabilities;
  }
  if (params.recommendedConnectors !== undefined) {
    updatePayload.recommendedConnectorsJson = params.recommendedConnectors;
  }
  if (params.approvedConnectorIds !== undefined) {
    updatePayload.approvedConnectorIdsJson = params.approvedConnectorIds;
  }
  if (params.rejectedProviders !== undefined) {
    updatePayload.rejectedProvidersJson = params.rejectedProviders;
  }
  if (params.capabilityMatrix !== undefined) {
    updatePayload.capabilityMatrixJson = params.capabilityMatrix;
  }
  if (params.activationBlockerReason !== undefined) {
    updatePayload.activationBlockerReason = params.activationBlockerReason;
  }
  if (params.lastTestedAt !== undefined) {
    updatePayload.lastTestedAt = params.lastTestedAt;
  }
  if (params.activatedAt !== undefined) {
    updatePayload.activatedAt = params.activatedAt;
  }
  if (params.goalId !== undefined) {
    updatePayload.goalId = params.goalId;
  }

  const updated = await db
    .update(workforceConfigurations)
    .set(updatePayload)
    .where(
      and(
        eq(workforceConfigurations.id, params.configId),
        eq(workforceConfigurations.userId, params.userId)
      )
    )
    .returning();

  return updated[0] ? mapWorkforceConfigRow(updated[0]) : null;
}
