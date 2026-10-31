import crypto from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { db } from './index.ts';
import {
  actionLogs,
  goals,
  tasks,
  userIntegrations,
  workspaces,
} from './schema.ts';
import {
  decryptIntegrationSecretDetailed,
  encryptIntegrationSecret,
  EnvConfigError,
  sanitizeEvidencePayload,
} from '../server/crypto-vault.ts';
import type {
  ActionLogRecord,
  ActionLogStatus,
  ApprovalStatus,
  CapabilityId,
  GoalExecutionState,
  GoalRecord,
  GoalStatus,
  IntegrationConnectionMode,
  IntegrationProviderKey,
  IntegrationPublicMetadata,
  ProposedActionDetails,
  TaskActionCategory,
  TaskRecord,
  TaskStatus,
  ToolId,
  UserIntegrationRecord,
  VerificationState,
  WorkspaceRecord,
} from '../types.ts';
import {
  defaultCapabilitiesForTask,
  type NormalizedPlannedTask,
} from '../lib/domain-rules.ts';

function mapWorkspaceRow(row: typeof workspaces.$inferSelect): WorkspaceRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    slug: row.slug,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapGoalRow(row: typeof goals.$inferSelect): GoalRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId ?? null,
    problem: row.problem,
    description: row.problem,
    targetMetric: row.targetMetric,
    deadline: row.deadline ? row.deadline.toISOString() : null,
    status: row.status as GoalStatus,
    executionState: (row.executionState || 'idle') as GoalExecutionState,
    progressPercent:
      typeof row.progressPercent === 'number' ? row.progressPercent : 0,
    achievedAt: row.achievedAt ? row.achievedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapTaskRow(row: typeof tasks.$inferSelect): TaskRecord {
  const tool = row.tool as ToolId;
  const actionCategory = row.actionCategory as TaskActionCategory;
  const caps =
    Array.isArray(row.requiredCapabilities) &&
    row.requiredCapabilities.length > 0
      ? row.requiredCapabilities
      : defaultCapabilitiesForTask(tool, actionCategory);

  return {
    id: row.id,
    goalId: row.goalId,
    userId: row.userId,
    workspaceId: row.workspaceId ?? null,
    stepOrder: row.stepOrder,
    description: row.description,
    tool,
    requiredCapabilities: caps,
    assignedProvider: row.assignedProvider ?? null,
    assignedIntegrationId: row.assignedIntegrationId ?? null,
    actionCategory,
    dependencies: Array.isArray(row.dependencies) ? row.dependencies : [],
    approvalRequired: row.approvalRequired,
    approvalStatus: row.approvalStatus as ApprovalStatus,
    approvalDecisionAt: row.approvalDecisionAt
      ? row.approvalDecisionAt.toISOString()
      : null,
    approvalDecisionBy: row.approvalDecisionBy ?? null,
    proposedActionDetails: row.proposedActionDetails ?? null,
    expectedResult: row.expectedResult,
    verificationMethod: row.verificationMethod,
    status: row.status as TaskStatus,
    verificationStatus: (row.verificationStatus ||
      'unverified') as VerificationState,
    statusReason: row.statusReason ?? null,
    outputData: row.outputData ?? null,
    lockedBy: row.lockedBy ?? null,
    lockedAt: row.lockedAt ? row.lockedAt.toISOString() : null,
    retryCount: row.retryCount,
    maxRetries: row.maxRetries,
    backoffBaseMs: row.backoffBaseMs ?? 2000,
    nextRetryAt: row.nextRetryAt ? row.nextRetryAt.toISOString() : null,
    executionTimeoutMs: row.executionTimeoutMs ?? 20000,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    lastDurationMs: row.lastDurationMs ?? null,
    reconciliationRequired: Boolean(row.reconciliationRequired),
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapActionLogRow(
  row: typeof actionLogs.$inferSelect
): ActionLogRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId ?? null,
    goalId: row.goalId,
    taskId: row.taskId ?? null,
    executionProvider: row.executionProvider || 'legacy_worker',
    actionType: row.actionType,
    status: row.status as ActionLogStatus,
    timestamp: row.timestamp.toISOString(),
    resultSummary: row.resultSummary,
    evidence: row.evidence ?? null,
    errorMessage: row.errorMessage ?? null,
  };
}

/**
 * Maps a database user_integrations row to a public DTO.
 * Encrypted secret columns are NEVER copied into this object.
 */
function mapIntegrationRowPublic(
  row: typeof userIntegrations.$inferSelect
): UserIntegrationRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    providerKey: row.providerKey as IntegrationProviderKey,
    displayName: row.displayName,
    connectionMode: row.connectionMode as IntegrationConnectionMode,
    connectorType: (row.connectorType as UserIntegrationRecord['connectorType']) ?? 'webhook',
    connectorCategory:
      (row.connectorCategory as UserIntegrationRecord['connectorCategory']) ??
      'webhooks',
    authStatus:
      (row.authStatus as UserIntegrationRecord['authStatus']) ?? 'configured',
    grantedScopes: Array.isArray(row.grantedScopes) ? row.grantedScopes : [],
    healthStatus:
      (row.healthStatus as UserIntegrationRecord['healthStatus']) ?? 'untested',
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    configMetadata: row.configMetadata ?? { authType: 'none' },
    hasSecret: Boolean(row.encryptedSecret && row.secretIv && row.secretAuthTag),
    secretMaskedHint: row.secretMaskedHint ?? null,
    enabled: row.enabled,
    verified: row.verified,
    statusDetail: row.statusDetail,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    lastSuccessAt: row.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
    lastActivityAt: row.lastActivityAt ? row.lastActivityAt.toISOString() : null,
    lastErrorMessage: row.lastErrorMessage ?? null,
    rateLimitRpm: row.rateLimitRpm ?? 60,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function slugifyWorkspaceName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'workspace';
}

export async function ensureDefaultWorkspaceForUser(
  userId: string
): Promise<WorkspaceRecord> {
  try {
    const existing = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerUserId, userId))
      .orderBy(desc(workspaces.isDefault), asc(workspaces.createdAt));

    let defaultWs = existing[0];
    if (!defaultWs) {
      const id = crypto.randomUUID();
      const inserted = await db
        .insert(workspaces)
        .values({
          id,
          ownerUserId: userId,
          name: 'Primary Workspace',
          slug: 'primary-workspace',
          isDefault: true,
        })
        .returning();
      defaultWs = inserted[0];
    }

    // Backfill legacy Phase 1 records belonging to this user that had null workspace_id
    await Promise.all([
      db
        .update(goals)
        .set({ workspaceId: defaultWs.id })
        .where(and(eq(goals.userId, userId), isNull(goals.workspaceId))),
      db
        .update(tasks)
        .set({ workspaceId: defaultWs.id })
        .where(and(eq(tasks.userId, userId), isNull(tasks.workspaceId))),
      db
        .update(actionLogs)
        .set({ workspaceId: defaultWs.id })
        .where(
          and(eq(actionLogs.userId, userId), isNull(actionLogs.workspaceId))
        ),
    ]);

    return mapWorkspaceRow(defaultWs);
  } catch (error) {
    console.error('Failed to ensure default workspace:', error);
    throw new Error('Failed to initialize user workspace.', { cause: error });
  }
}

export async function listWorkspacesByUser(
  userId: string
): Promise<WorkspaceRecord[]> {
  try {
    await ensureDefaultWorkspaceForUser(userId);
    const rows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerUserId, userId))
      .orderBy(desc(workspaces.isDefault), asc(workspaces.createdAt));
    return rows.map(mapWorkspaceRow);
  } catch (error) {
    console.error('Failed to list workspaces:', error);
    throw new Error('Failed to load workspaces.', { cause: error });
  }
}

export async function getWorkspaceByIdForUser(
  workspaceId: string,
  userId: string
): Promise<WorkspaceRecord | null> {
  try {
    const rows = await db
      .select()
      .from(workspaces)
      .where(
        and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, userId))
      );
    return rows[0] ? mapWorkspaceRow(rows[0]) : null;
  } catch (error) {
    console.error('Failed to fetch workspace:', error);
    throw new Error('Failed to verify workspace ownership.', { cause: error });
  }
}

export async function createWorkspaceForUser(params: {
  userId: string;
  name: string;
}): Promise<WorkspaceRecord> {
  try {
    await ensureDefaultWorkspaceForUser(params.userId);
    const id = crypto.randomUUID();
    const slug = `${slugifyWorkspaceName(params.name)}-${id.slice(0, 6)}`;
    const inserted = await db
      .insert(workspaces)
      .values({
        id,
        ownerUserId: params.userId,
        name: params.name.trim(),
        slug,
        isDefault: false,
      })
      .returning();
    return mapWorkspaceRow(inserted[0]);
  } catch (error) {
    console.error('Failed to create workspace:', error);
    throw new Error('Failed to create workspace.', { cause: error });
  }
}

// --- USER / WORKSPACE INTEGRATIONS ---

export async function listIntegrationsByUser(
  userId: string,
  workspaceId?: string
): Promise<UserIntegrationRecord[]> {
  try {
    const condition = workspaceId
      ? and(
          eq(userIntegrations.userId, userId),
          eq(userIntegrations.workspaceId, workspaceId)
        )
      : eq(userIntegrations.userId, userId);

    const rows = await db
      .select()
      .from(userIntegrations)
      .where(condition)
      .orderBy(desc(userIntegrations.createdAt));

    return rows.map(mapIntegrationRowPublic);
  } catch (error) {
    console.error('Failed to list user integrations:', error);
    throw new Error('Failed to load integrations from database.', {
      cause: error,
    });
  }
}

export async function getIntegrationByIdForUser(
  integrationId: string,
  userId: string
): Promise<UserIntegrationRecord | null> {
  try {
    const rows = await db
      .select()
      .from(userIntegrations)
      .where(
        and(
          eq(userIntegrations.id, integrationId),
          eq(userIntegrations.userId, userId)
        )
      );
    return rows[0] ? mapIntegrationRowPublic(rows[0]) : null;
  } catch (error) {
    console.error('Failed to load integration:', error);
    throw new Error('Failed to load integration record.', { cause: error });
  }
}

export interface ServerExecutableIntegration {
  record: UserIntegrationRecord;
  encryptedSecret: string | null;
  secretIv: string | null;
  secretAuthTag: string | null;
}

/**
 * Server-only helper for Execution Router & Connection Tester.
 * Strictly requires matching `userId` so cross-user credential access is impossible.
 */
export async function getExecutableIntegrationForServer(
  integrationId: string,
  userId: string,
  workspaceId?: string
): Promise<ServerExecutableIntegration | null> {
  try {
    const clauses = [
      eq(userIntegrations.id, integrationId),
      eq(userIntegrations.userId, userId),
    ];
    if (workspaceId) {
      clauses.push(eq(userIntegrations.workspaceId, workspaceId));
    }
    const rows = await db
      .select()
      .from(userIntegrations)
      .where(and(...clauses));
    const row = rows[0];
    if (!row) return null;
    return {
      record: mapIntegrationRowPublic(row),
      encryptedSecret: row.encryptedSecret ?? null,
      secretIv: row.secretIv ?? null,
      secretAuthTag: row.secretAuthTag ?? null,
    };
  } catch (error) {
    console.error('Failed to load executable integration:', error);
    throw new Error('Failed to load integration credentials on server.', {
      cause: error,
    });
  }
}

export async function createUserIntegration(params: {
  userId: string;
  workspaceId: string;
  providerKey: IntegrationProviderKey;
  displayName: string;
  connectionMode: IntegrationConnectionMode;
  connectorType?: UserIntegrationRecord['connectorType'];
  connectorCategory?: UserIntegrationRecord['connectorCategory'];
  authStatus?: UserIntegrationRecord['authStatus'];
  grantedScopes?: string[];
  healthStatus?: UserIntegrationRecord['healthStatus'];
  rateLimitRpm?: number;
  verified?: boolean;
  statusDetail?: string;
  capabilities: CapabilityId[];
  configMetadata: IntegrationPublicMetadata;
  plaintextSecret?: string;
}): Promise<UserIntegrationRecord> {
  try {
    const ws = await getWorkspaceByIdForUser(params.workspaceId, params.userId);
    if (!ws) {
      throw new Error('Target workspace not found or access denied.');
    }

    let encryptedSecret: string | null = null;
    let secretIv: string | null = null;
    let secretAuthTag: string | null = null;
    let secretMaskedHint: string | null = null;

    if (params.plaintextSecret && params.plaintextSecret.trim()) {
      const enc = encryptIntegrationSecret(params.plaintextSecret);
      encryptedSecret = enc.ciphertextBase64;
      secretIv = enc.ivBase64;
      secretAuthTag = enc.authTagBase64;
      secretMaskedHint = enc.maskedHint;
    }

    const inferredType: NonNullable<UserIntegrationRecord['connectorType']> =
      params.connectorType ??
      (params.providerKey === 'custom_api'
        ? 'custom_api'
        : params.providerKey === 'telegram_native'
          ? 'native_token'
          : params.providerKey.endsWith('_native')
            ? 'native_oauth'
            : 'webhook');

    const inferredCategory: NonNullable<
      UserIntegrationRecord['connectorCategory']
    > =
      params.connectorCategory ??
      (params.providerKey === 'n8n_webhook' ||
      params.providerKey === 'make_webhook' ||
      params.providerKey === 'zapier_webhook'
        ? 'automation_platforms'
        : params.providerKey === 'custom_api'
          ? 'custom_api'
          : params.providerKey.endsWith('_native')
            ? 'connected_apps'
            : 'webhooks');

    const now = new Date();
    const id = crypto.randomUUID();
    const isVerified = params.verified ?? false;
    const inserted = await db
      .insert(userIntegrations)
      .values({
        id,
        userId: params.userId,
        workspaceId: ws.id,
        providerKey: params.providerKey,
        displayName: params.displayName.trim(),
        connectionMode: params.connectionMode,
        connectorType: inferredType,
        connectorCategory: inferredCategory,
        authStatus: params.authStatus ?? (isVerified ? 'authorized' : 'configured'),
        grantedScopes: params.grantedScopes ?? [],
        healthStatus: params.healthStatus ?? (isVerified ? 'healthy' : 'untested'),
        capabilities: params.capabilities,
        configMetadata: params.configMetadata,
        encryptedSecret,
        secretIv,
        secretAuthTag,
        secretMaskedHint,
        enabled: true,
        verified: isVerified,
        statusDetail:
          params.statusDetail ??
          'Configuration saved. Run "Test Connection" to verify reachability before task execution.',
        lastTestedAt: isVerified ? now : null,
        lastSuccessAt: isVerified ? now : null,
        lastActivityAt: now,
        rateLimitRpm: params.rateLimitRpm ?? 60,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return mapIntegrationRowPublic(inserted[0]);
  } catch (error) {
    if (error instanceof EnvConfigError) {
      throw error;
    }
    console.error('Failed to create user integration');
    throw new Error(
      error instanceof Error && error.message.includes('workspace')
        ? error.message
        : 'Failed to save integration configuration.',
      { cause: error }
    );
  }
}

export async function updateUserIntegration(params: {
  integrationId: string;
  userId: string;
  displayName?: string;
  capabilities?: CapabilityId[];
  configMetadata?: IntegrationPublicMetadata;
  plaintextSecret?: string | null;
  enabled?: boolean;
  authStatus?: UserIntegrationRecord['authStatus'];
  grantedScopes?: string[];
  healthStatus?: UserIntegrationRecord['healthStatus'];
  verified?: boolean;
  statusDetail?: string;
  lastErrorMessage?: string | null;
  rateLimitRpm?: number;
}): Promise<UserIntegrationRecord | null> {
  try {
    const existingRows = await db
      .select()
      .from(userIntegrations)
      .where(
        and(
          eq(userIntegrations.id, params.integrationId),
          eq(userIntegrations.userId, params.userId)
        )
      );
    const existing = existingRows[0];
    if (!existing) return null;

    const now = new Date();
    const updateValues: Partial<typeof userIntegrations.$inferInsert> = {
      updatedAt: now,
      lastActivityAt: now,
    };

    if (params.displayName !== undefined) {
      updateValues.displayName = params.displayName.trim();
    }
    if (params.capabilities !== undefined) {
      updateValues.capabilities = params.capabilities;
    }
    if (params.enabled !== undefined) {
      updateValues.enabled = params.enabled;
      if (!params.enabled && params.healthStatus === undefined) {
        updateValues.healthStatus = 'disabled';
      } else if (params.enabled && existing.healthStatus === 'disabled') {
        updateValues.healthStatus = existing.verified ? 'healthy' : 'untested';
      }
    }
    if (params.authStatus !== undefined) {
      updateValues.authStatus = params.authStatus;
    }
    if (params.grantedScopes !== undefined) {
      updateValues.grantedScopes = params.grantedScopes;
    }
    if (params.healthStatus !== undefined) {
      updateValues.healthStatus = params.healthStatus;
    }
    if (params.lastErrorMessage !== undefined) {
      updateValues.lastErrorMessage = params.lastErrorMessage;
    }
    if (params.rateLimitRpm !== undefined) {
      updateValues.rateLimitRpm = params.rateLimitRpm;
    }

    let endpointOrAuthChanged = false;
    if (params.configMetadata !== undefined) {
      const prevMeta = JSON.stringify(existing.configMetadata ?? {});
      const nextMeta = JSON.stringify(params.configMetadata);
      if (prevMeta !== nextMeta) {
        endpointOrAuthChanged = true;
      }
      updateValues.configMetadata = params.configMetadata;
    }

    if (params.plaintextSecret !== undefined) {
      if (params.plaintextSecret === null || params.plaintextSecret === '') {
        updateValues.encryptedSecret = null;
        updateValues.secretIv = null;
        updateValues.secretAuthTag = null;
        updateValues.secretMaskedHint = null;
        endpointOrAuthChanged = true;
      } else if (params.plaintextSecret.trim()) {
        const enc = encryptIntegrationSecret(params.plaintextSecret);
        updateValues.encryptedSecret = enc.ciphertextBase64;
        updateValues.secretIv = enc.ivBase64;
        updateValues.secretAuthTag = enc.authTagBase64;
        updateValues.secretMaskedHint = enc.maskedHint;
        endpointOrAuthChanged = true;
      }
    }

    if (endpointOrAuthChanged && params.verified === undefined) {
      updateValues.verified = false;
      updateValues.healthStatus = params.healthStatus ?? 'untested';
      updateValues.statusDetail =
        params.statusDetail ??
        'Connection settings updated. Re-run "Test Connection" to verify before executing tasks.';
    } else {
      if (params.verified !== undefined) {
        updateValues.verified = params.verified;
        if (params.verified) {
          updateValues.lastTestedAt = now;
          updateValues.lastSuccessAt = now;
        }
      }
      if (params.statusDetail !== undefined) {
        updateValues.statusDetail = params.statusDetail;
      }
    }

    const updated = await db
      .update(userIntegrations)
      .set(updateValues)
      .where(
        and(
          eq(userIntegrations.id, params.integrationId),
          eq(userIntegrations.userId, params.userId)
        )
      )
      .returning();

    return updated[0] ? mapIntegrationRowPublic(updated[0]) : null;
  } catch (error) {
    if (error instanceof EnvConfigError) {
      throw error;
    }
    console.error('Failed to update integration');
    throw new Error('Failed to update integration configuration.', {
      cause: error,
    });
  }
}

export async function recordIntegrationTestOutcome(params: {
  integrationId: string;
  userId: string;
  verified: boolean;
  statusDetail: string;
  testedAt: Date;
  authStatus?: UserIntegrationRecord['authStatus'];
  healthStatus?: UserIntegrationRecord['healthStatus'];
  grantedScopes?: string[];
  lastErrorMessage?: string | null;
}): Promise<UserIntegrationRecord | null> {
  try {
    const updatePayload: Partial<typeof userIntegrations.$inferInsert> = {
      verified: params.verified,
      statusDetail: params.statusDetail,
      lastTestedAt: params.testedAt,
      lastActivityAt: params.testedAt,
      healthStatus:
        params.healthStatus ?? (params.verified ? 'healthy' : 'unhealthy'),
      lastErrorMessage:
        params.lastErrorMessage !== undefined
          ? params.lastErrorMessage
          : params.verified
            ? null
            : params.statusDetail,
      updatedAt: params.testedAt,
    };

    if (params.verified) {
      updatePayload.lastSuccessAt = params.testedAt;
    }
    if (params.authStatus !== undefined) {
      updatePayload.authStatus = params.authStatus;
    }
    if (params.grantedScopes !== undefined) {
      updatePayload.grantedScopes = params.grantedScopes;
    }

    const updated = await db
      .update(userIntegrations)
      .set(updatePayload)
      .where(
        and(
          eq(userIntegrations.id, params.integrationId),
          eq(userIntegrations.userId, params.userId)
        )
      )
      .returning();

    return updated[0] ? mapIntegrationRowPublic(updated[0]) : null;
  } catch (error) {
    console.error('Failed to persist integration test outcome:', error);
    throw new Error('Failed to record integration connection test result.', {
      cause: error,
    });
  }
}

export async function deleteUserIntegration(
  integrationId: string,
  userId: string
): Promise<boolean> {
  try {
    const deleted = await db
      .delete(userIntegrations)
      .where(
        and(
          eq(userIntegrations.id, integrationId),
          eq(userIntegrations.userId, userId)
        )
      )
      .returning();
    return deleted.length > 0;
  } catch (error) {
    console.error('Failed to delete integration');
    throw new Error('Failed to delete integration.', { cause: error });
  }
}

/**
 * Re-encrypts a single stored credential under the current active INTEGRATION_ENCRYPTION_KEY
 * during transparent or explicit key rotation. Never returns secret values.
 */
export async function reencryptIntegrationSecretRow(params: {
  integrationId: string;
  userId: string;
  plaintextSecret: string;
}): Promise<void> {
  const enc = encryptIntegrationSecret(params.plaintextSecret);
  await db
    .update(userIntegrations)
    .set({
      encryptedSecret: enc.ciphertextBase64,
      secretIv: enc.ivBase64,
      secretAuthTag: enc.authTagBase64,
      secretMaskedHint: enc.maskedHint,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userIntegrations.id, params.integrationId),
        eq(userIntegrations.userId, params.userId)
      )
    );
}

/**
 * Batch key-rotation migration for a user's workspace integrations:
 * decrypts rows encrypted under INTEGRATION_ENCRYPTION_KEY_PREVIOUS (or v1 format)
 * and re-wraps them with a fresh random IV under the current INTEGRATION_ENCRYPTION_KEY.
 */
export async function rotateUserIntegrationSecrets(params: {
  userId: string;
  workspaceId?: string;
}): Promise<{
  rotatedCount: number;
  alreadyCurrentCount: number;
  noSecretCount: number;
}> {
  const condition = params.workspaceId
    ? and(
        eq(userIntegrations.userId, params.userId),
        eq(userIntegrations.workspaceId, params.workspaceId)
      )
    : eq(userIntegrations.userId, params.userId);

  const rows = await db.select().from(userIntegrations).where(condition);

  let rotatedCount = 0;
  let alreadyCurrentCount = 0;
  let noSecretCount = 0;

  for (const row of rows) {
    if (!row.encryptedSecret || !row.secretIv || !row.secretAuthTag) {
      noSecretCount++;
      continue;
    }

    const detailed = decryptIntegrationSecretDetailed({
      ciphertextBase64: row.encryptedSecret,
      ivBase64: row.secretIv,
      authTagBase64: row.secretAuthTag,
    });

    if (detailed.needsReencryption) {
      await reencryptIntegrationSecretRow({
        integrationId: row.id,
        userId: params.userId,
        plaintextSecret: detailed.plaintext,
      });
      rotatedCount++;
    } else {
      alreadyCurrentCount++;
    }
  }

  return {
    rotatedCount,
    alreadyCurrentCount,
    noSecretCount,
  };
}

// --- GOALS ---

export async function listGoalsByUser(
  userId: string,
  workspaceId?: string
): Promise<GoalRecord[]> {
  try {
    const condition = workspaceId
      ? and(eq(goals.userId, userId), eq(goals.workspaceId, workspaceId))
      : eq(goals.userId, userId);

    const rows = await db
      .select()
      .from(goals)
      .where(condition)
      .orderBy(desc(goals.createdAt));
    return rows.map(mapGoalRow);
  } catch (error) {
    console.error('Failed to list user goals:', error);
    throw new Error('Failed to load goals from database.', { cause: error });
  }
}

export async function getGoalByIdForUser(
  goalId: string,
  userId: string
): Promise<GoalRecord | null> {
  try {
    const rows = await db
      .select()
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.userId, userId)));
    return rows[0] ? mapGoalRow(rows[0]) : null;
  } catch (error) {
    console.error('Failed to fetch goal:', error);
    throw new Error('Failed to load goal record.', { cause: error });
  }
}

export async function createGoalForUser(params: {
  userId: string;
  workspaceId?: string;
  problem: string;
  targetMetric: string;
  deadline?: Date | null;
  status?: GoalStatus;
}): Promise<GoalRecord> {
  try {
    let resolvedWorkspaceId = params.workspaceId;
    if (resolvedWorkspaceId) {
      const ws = await getWorkspaceByIdForUser(
        resolvedWorkspaceId,
        params.userId
      );
      if (!ws) {
        throw new Error('Workspace not found or access denied.');
      }
    } else {
      const defaultWs = await ensureDefaultWorkspaceForUser(params.userId);
      resolvedWorkspaceId = defaultWs.id;
    }

    const now = new Date();
    const id = crypto.randomUUID();
    const rows = await db
      .insert(goals)
      .values({
        id,
        userId: params.userId,
        workspaceId: resolvedWorkspaceId,
        problem: params.problem,
        targetMetric: params.targetMetric,
        deadline: params.deadline ?? null,
        status: params.status ?? 'draft',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return mapGoalRow(rows[0]);
  } catch (error) {
    console.error('Failed to create goal:', error);
    throw new Error('Failed to save goal to database.', { cause: error });
  }
}

export async function updateGoalForUser(params: {
  goalId: string;
  userId: string;
  problem?: string;
  targetMetric?: string;
  deadline?: Date | null;
  status?: GoalStatus;
  executionState?: GoalExecutionState;
  progressPercent?: number;
  achievedAt?: Date | null;
}): Promise<GoalRecord | null> {
  try {
    const existing = await getGoalByIdForUser(params.goalId, params.userId);
    if (!existing) return null;

    const nextDeadline =
      params.deadline !== undefined
        ? params.deadline
        : existing.deadline
          ? new Date(existing.deadline)
          : null;

    const nextAchievedAt =
      params.achievedAt !== undefined
        ? params.achievedAt
        : existing.achievedAt
          ? new Date(existing.achievedAt)
          : null;

    const rows = await db
      .update(goals)
      .set({
        problem: params.problem ?? existing.problem,
        targetMetric: params.targetMetric ?? existing.targetMetric,
        deadline: nextDeadline,
        status: params.status ?? existing.status,
        executionState: params.executionState ?? existing.executionState,
        progressPercent: params.progressPercent ?? existing.progressPercent,
        achievedAt: nextAchievedAt,
        updatedAt: new Date(),
      })
      .where(and(eq(goals.id, params.goalId), eq(goals.userId, params.userId)))
      .returning();

    return rows[0] ? mapGoalRow(rows[0]) : null;
  } catch (error) {
    console.error('Failed to update goal:', error);
    throw new Error('Failed to update goal record.', { cause: error });
  }
}

// --- TASKS ---

export async function listTasksByUser(
  userId: string,
  goalId?: string,
  workspaceId?: string
): Promise<TaskRecord[]> {
  try {
    const clauses = [eq(tasks.userId, userId)];
    if (goalId) clauses.push(eq(tasks.goalId, goalId));
    if (workspaceId) clauses.push(eq(tasks.workspaceId, workspaceId));

    const rows = await db
      .select()
      .from(tasks)
      .where(and(...clauses))
      .orderBy(asc(tasks.stepOrder), asc(tasks.createdAt));

    return rows.map(mapTaskRow);
  } catch (error) {
    console.error('Failed to list tasks:', error);
    throw new Error('Failed to load tasks from database.', { cause: error });
  }
}

export async function getTaskByIdForUser(
  taskId: string,
  userId: string
): Promise<TaskRecord | null> {
  try {
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
    return rows[0] ? mapTaskRow(rows[0]) : null;
  } catch (error) {
    console.error('Failed to fetch task:', error);
    throw new Error('Failed to load task record.', { cause: error });
  }
}

export async function savePlannedTasksForGoal(params: {
  userId: string;
  goalId: string;
  plannedTasks: NormalizedPlannedTask[];
}): Promise<{ goal: GoalRecord; tasks: TaskRecord[] }> {
  try {
    return await db.transaction(async (tx) => {
      const goalRows = await tx
        .select()
        .from(goals)
        .where(
          and(eq(goals.id, params.goalId), eq(goals.userId, params.userId))
        );
      if (!goalRows[0]) {
        throw new Error('Goal not found or access denied.');
      }

      const goalWorkspaceId = goalRows[0].workspaceId ?? null;

      const existingTasks = await tx
        .select()
        .from(tasks)
        .where(
          and(eq(tasks.goalId, params.goalId), eq(tasks.userId, params.userId))
        );

      const stepOffset = existingTasks.length;
      const now = new Date();
      const insertedTasks: TaskRecord[] = [];

      for (const item of params.plannedTasks) {
        const inserted = await tx
          .insert(tasks)
          .values({
            id: item.id,
            goalId: params.goalId,
            userId: params.userId,
            workspaceId: goalWorkspaceId,
            stepOrder: stepOffset + item.stepOrder,
            description: item.description,
            tool: item.tool,
            requiredCapabilities: item.requiredCapabilities,
            actionCategory: item.actionCategory,
            dependencies: item.dependencies,
            approvalRequired: item.approvalRequired,
            approvalStatus: item.approvalStatus,
            proposedActionDetails: item.proposedActionDetails,
            expectedResult: item.expectedResult,
            verificationMethod: item.verificationMethod,
            status: item.status,
            statusReason: item.statusReason,
            idempotencyKey: item.idempotencyKey,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        insertedTasks.push(mapTaskRow(inserted[0]));

        await tx.insert(actionLogs).values({
          id: crypto.randomUUID(),
          userId: params.userId,
          workspaceId: goalWorkspaceId,
          goalId: params.goalId,
          taskId: item.id,
          executionProvider: `planner_proposed:${item.tool}`,
          actionType: `${item.tool}:${item.actionCategory}`,
          status: 'proposed',
          timestamp: now,
          resultSummary: item.approvalRequired
            ? `Task planned and queued behind Approval Gate (${item.description})`
            : `Task planned and added to queue (${item.description})`,
          evidence: sanitizeEvidencePayload({
            proposedTool: item.tool,
            requiredCapabilities: item.requiredCapabilities,
            dependencies: item.dependencies,
            approvalRequired: item.approvalRequired,
            expectedResult: item.expectedResult,
            verificationMethod: item.verificationMethod,
          }),
          errorMessage: null,
        });
      }

      const nextStatus: GoalStatus =
        goalRows[0].status === 'draft'
          ? 'planning'
          : (goalRows[0].status as GoalStatus);

      const updatedGoalRows = await tx
        .update(goals)
        .set({
          status: nextStatus,
          updatedAt: now,
        })
        .where(
          and(eq(goals.id, params.goalId), eq(goals.userId, params.userId))
        )
        .returning();

      return {
        goal: mapGoalRow(updatedGoalRows[0]),
        tasks: insertedTasks,
      };
    });
  } catch (error) {
    console.error('Failed to persist AI plan:', error);
    throw new Error('Failed to save generated plan to database.', {
      cause: error,
    });
  }
}

export async function createSingleTaskForGoal(params: {
  userId: string;
  goalId: string;
  description: string;
  tool: ToolId;
  requiredCapabilities: CapabilityId[];
  assignedIntegrationId?: string | null;
  actionCategory: TaskActionCategory;
  dependencies: string[];
  approvalRequired: boolean;
  proposedActionDetails: ProposedActionDetails | null;
  expectedResult: string;
  verificationMethod: string;
  maxRetries?: number;
  backoffBaseMs?: number;
  executionTimeoutMs?: number;
}): Promise<TaskRecord> {
  try {
    return await db.transaction(async (tx) => {
      const goalRows = await tx
        .select()
        .from(goals)
        .where(
          and(eq(goals.id, params.goalId), eq(goals.userId, params.userId))
        );
      if (!goalRows[0]) {
        throw new Error('Goal not found or access denied.');
      }

      const goalWorkspaceId = goalRows[0].workspaceId ?? null;

      if (params.assignedIntegrationId) {
        const integrationClauses = [
          eq(userIntegrations.id, params.assignedIntegrationId),
          eq(userIntegrations.userId, params.userId),
        ];
        if (goalWorkspaceId) {
          integrationClauses.push(
            eq(userIntegrations.workspaceId, goalWorkspaceId)
          );
        }
        const ownedInt = await tx
          .select()
          .from(userIntegrations)
          .where(and(...integrationClauses));
        if (!ownedInt[0]) {
          throw new Error(
            'Selected integration does not belong to this workspace.'
          );
        }
      }

      const existing = await tx
        .select()
        .from(tasks)
        .where(
          and(eq(tasks.goalId, params.goalId), eq(tasks.userId, params.userId))
        );

      const existingTaskIds = new Set(existing.map((t) => t.id));
      const cleanDeps: string[] = [];
      for (const rawDep of params.dependencies) {
        const depId = rawDep.trim();
        if (!depId) continue;
        if (!existingTaskIds.has(depId)) {
          throw new Error(
            `Invalid dependency "${depId}": prerequisite task must belong to the same goal.`
          );
        }
        if (!cleanDeps.includes(depId)) {
          cleanDeps.push(depId);
        }
      }

      const id = crypto.randomUUID();
      const now = new Date();
      const approvalStatus: ApprovalStatus = params.approvalRequired
        ? 'pending'
        : 'not_required';
      const statusReason =
        params.tool === 'unsupported'
          ? `Configuration required: Requires capabilities [${params.requiredCapabilities.join(', ')}] with no compatible provider.`
          : params.approvalRequired
            ? 'Awaiting explicit human approval before execution.'
            : null;

      const inserted = await tx
        .insert(tasks)
        .values({
          id,
          goalId: params.goalId,
          userId: params.userId,
          workspaceId: goalWorkspaceId,
          stepOrder: existing.length + 1,
          description: params.description,
          tool: params.tool,
          requiredCapabilities: params.requiredCapabilities,
          assignedIntegrationId: params.assignedIntegrationId ?? null,
          actionCategory: params.actionCategory,
          dependencies: cleanDeps,
          approvalRequired: params.approvalRequired,
          approvalStatus,
          proposedActionDetails: params.proposedActionDetails,
          expectedResult: params.expectedResult,
          verificationMethod: params.verificationMethod,
          status: 'queued',
          statusReason,
          maxRetries:
            typeof params.maxRetries === 'number' && params.maxRetries >= 0
              ? params.maxRetries
              : 2,
          backoffBaseMs:
            typeof params.backoffBaseMs === 'number' && params.backoffBaseMs > 0
              ? params.backoffBaseMs
              : 2000,
          executionTimeoutMs:
            typeof params.executionTimeoutMs === 'number' &&
            params.executionTimeoutMs > 0
              ? params.executionTimeoutMs
              : 20000,
          idempotencyKey: `${params.goalId}:${id}`,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      await tx.insert(actionLogs).values({
        id: crypto.randomUUID(),
        userId: params.userId,
        workspaceId: goalWorkspaceId,
        goalId: params.goalId,
        taskId: id,
        executionProvider: `proposed:${params.tool}`,
        actionType: `${params.tool}:${params.actionCategory}`,
        status: 'proposed',
        timestamp: now,
        resultSummary: `Task proposed and queued (${params.description})`,
        evidence: sanitizeEvidencePayload({
          proposedTool: params.tool,
          requiredCapabilities: params.requiredCapabilities,
          dependencies: cleanDeps,
          approvalRequired: params.approvalRequired,
        }),
        errorMessage: null,
      });

      return mapTaskRow(inserted[0]);
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('Invalid dependency') ||
        error.message.includes('Selected integration') ||
        error.message.includes('Goal not found'))
    ) {
      throw error;
    }
    console.error('Failed to create task:', error);
    throw new Error('Failed to create task record.', { cause: error });
  }
}

export async function recordApprovalDecision(params: {
  userId: string;
  taskId: string;
  decision: 'approved' | 'rejected';
}): Promise<TaskRecord | null> {
  try {
    return await db.transaction(async (tx) => {
      const taskRows = await tx
        .select()
        .from(tasks)
        .where(
          and(eq(tasks.id, params.taskId), eq(tasks.userId, params.userId))
        );
      const current = taskRows[0];
      if (!current) return null;

      const now = new Date();
      const nextTaskStatus: TaskStatus =
        params.decision === 'rejected'
          ? 'rejected'
          : current.status === 'blocked' ||
              current.status === 'rejected' ||
              current.status === 'proposed' ||
              current.status === 'queued'
            ? 'approved'
            : (current.status as TaskStatus);

      const nextReason =
        params.decision === 'rejected'
          ? 'Rejected by user in Approval Gate.'
          : 'Approved by user; ready for Execution Orchestrator dispatch.';

      const updated = await tx
        .update(tasks)
        .set({
          approvalRequired: true,
          approvalStatus: params.decision,
          approvalDecisionAt: now,
          approvalDecisionBy: params.userId,
          status: nextTaskStatus,
          statusReason: nextReason,
          updatedAt: now,
        })
        .where(
          and(eq(tasks.id, params.taskId), eq(tasks.userId, params.userId))
        )
        .returning();

      await tx.insert(actionLogs).values({
        id: crypto.randomUUID(),
        userId: params.userId,
        workspaceId: current.workspaceId ?? null,
        goalId: current.goalId,
        taskId: current.id,
        executionProvider: 'approval_gate',
        actionType: `approval_gate:${params.decision}`,
        status: params.decision === 'rejected' ? 'rejected' : 'approved',
        timestamp: now,
        resultSummary:
          params.decision === 'approved'
            ? 'User explicitly approved proposed consequential action.'
            : 'User explicitly rejected proposed consequential action.',
        evidence: sanitizeEvidencePayload({
          decision: params.decision,
          decidedBy: params.userId,
          decidedAt: now.toISOString(),
          proposedActionDetails: current.proposedActionDetails,
        }),
        errorMessage: null,
      });

      return mapTaskRow(updated[0]);
    });
  } catch (error) {
    console.error('Failed to record approval decision:', error);
    throw new Error('Failed to record approval decision.', { cause: error });
  }
}

export async function claimQueuedTaskAtomically(params: {
  taskId: string;
  userId: string;
  workerId: string;
}): Promise<TaskRecord | null> {
  try {
    const now = new Date();
    const staleLockCutoff = new Date(now.getTime() - 2 * 60 * 1000);

    const claimed = await db
      .update(tasks)
      .set({
        status: 'running',
        lockedBy: params.workerId,
        lockedAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, params.taskId),
          eq(tasks.userId, params.userId),
          inArray(tasks.status, ['queued', 'approved', 'proposed']),
          or(isNull(tasks.lockedBy), lt(tasks.lockedAt, staleLockCutoff))
        )
      )
      .returning();

    return claimed[0] ? mapTaskRow(claimed[0]) : null;
  } catch (error) {
    console.error('Atomic task claim failed:', error);
    throw new Error('Failed to claim task for worker execution.', {
      cause: error,
    });
  }
}

export async function updateTaskAfterWorkerCheckOrRun(params: {
  taskId: string;
  userId: string;
  status: TaskStatus;
  verificationStatus?: VerificationState;
  statusReason: string | null;
  outputData?: Record<string, unknown> | null;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  verifiedAt?: Date | null;
  lastDurationMs?: number | null;
  reconciliationRequired?: boolean;
  assignedProvider?: string | null;
  assignedIntegrationId?: string | null;
  expectedLockedBy?: string;
}): Promise<TaskRecord | null> {
  try {
    const updatePayload: Partial<typeof tasks.$inferInsert> = {
      status: params.status,
      statusReason: params.statusReason,
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date(),
    };
    if (params.verificationStatus !== undefined) {
      updatePayload.verificationStatus = params.verificationStatus;
    }
    if (params.outputData !== undefined) {
      updatePayload.outputData = params.outputData
        ? sanitizeEvidencePayload(params.outputData)
        : null;
    }
    if (params.retryCount !== undefined) {
      updatePayload.retryCount = params.retryCount;
    }
    if (params.maxRetries !== undefined) {
      updatePayload.maxRetries = params.maxRetries;
    }
    if (params.nextRetryAt !== undefined) {
      updatePayload.nextRetryAt = params.nextRetryAt;
    }
    if (params.startedAt !== undefined) {
      updatePayload.startedAt = params.startedAt;
    }
    if (params.completedAt !== undefined) {
      updatePayload.completedAt = params.completedAt;
    }
    if (params.verifiedAt !== undefined) {
      updatePayload.verifiedAt = params.verifiedAt;
    }
    if (params.lastDurationMs !== undefined) {
      updatePayload.lastDurationMs = params.lastDurationMs;
    }
    if (params.reconciliationRequired !== undefined) {
      updatePayload.reconciliationRequired = params.reconciliationRequired;
    }
    if (params.assignedProvider !== undefined) {
      updatePayload.assignedProvider = params.assignedProvider;
    }
    if (params.assignedIntegrationId !== undefined) {
      updatePayload.assignedIntegrationId = params.assignedIntegrationId;
    }

    const whereClauses = [
      eq(tasks.id, params.taskId),
      eq(tasks.userId, params.userId),
    ];
    if (params.expectedLockedBy) {
      whereClauses.push(eq(tasks.lockedBy, params.expectedLockedBy));
    }

    const updated = await db
      .update(tasks)
      .set(updatePayload)
      .where(and(...whereClauses))
      .returning();

    return updated[0] ? mapTaskRow(updated[0]) : null;
  } catch (error) {
    console.error('Failed to update task state:', error);
    throw new Error('Failed to update task state after execution.', {
      cause: error,
    });
  }
}

export async function requeueTaskSafely(params: {
  taskId: string;
  userId: string;
  bumpRetryBudget?: boolean;
  confirmExternalNotExecuted?: boolean;
}): Promise<TaskRecord | null> {
  try {
    const existing = await getTaskByIdForUser(params.taskId, params.userId);
    if (!existing) return null;

    if (
      existing.reconciliationRequired &&
      params.confirmExternalNotExecuted !== true
    ) {
      throw new Error(
        'Uncertain execution outcome: This external task timed out or crashed mid-execution and may have already produced external side effects. Reconcile the task first or explicitly confirm external non-execution before retrying.'
      );
    }

    if (
      existing.status !== 'blocked' &&
      existing.status !== 'failed' &&
      existing.status !== 'queued' &&
      existing.status !== 'approved'
    ) {
      return existing;
    }

    const nextMaxRetries =
      params.bumpRetryBudget && existing.retryCount >= existing.maxRetries
        ? existing.retryCount + 2
        : existing.maxRetries;

    const nextStatus: TaskStatus =
      existing.approvalRequired && existing.approvalStatus === 'approved'
        ? 'approved'
        : 'queued';

    const updated = await db
      .update(tasks)
      .set({
        status: nextStatus,
        statusReason:
          'Re-queued for safe execution retry (approval, capability, and dependency gates remain enforced).',
        reconciliationRequired: false,
        lockedBy: null,
        lockedAt: null,
        nextRetryAt: null,
        maxRetries: nextMaxRetries,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, params.taskId), eq(tasks.userId, params.userId)))
      .returning();

    return updated[0] ? mapTaskRow(updated[0]) : null;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Uncertain execution outcome')
    ) {
      throw error;
    }
    console.error('Failed to requeue task:', error);
    throw new Error('Failed to requeue task for retry.', { cause: error });
  }
}

export async function appendActionLog(params: {
  userId: string;
  workspaceId?: string | null;
  goalId: string;
  taskId?: string | null;
  executionProvider: string;
  actionType: string;
  status: ActionLogStatus;
  resultSummary: string;
  evidence?: Record<string, unknown> | null;
  errorMessage?: string | null;
}): Promise<ActionLogRecord> {
  try {
    const cleanEvidence = params.evidence
      ? sanitizeEvidencePayload(params.evidence)
      : null;

    const inserted = await db
      .insert(actionLogs)
      .values({
        id: crypto.randomUUID(),
        userId: params.userId,
        workspaceId: params.workspaceId ?? null,
        goalId: params.goalId,
        taskId: params.taskId ?? null,
        executionProvider: params.executionProvider,
        actionType: params.actionType,
        status: params.status,
        timestamp: new Date(),
        resultSummary: params.resultSummary,
        evidence: cleanEvidence,
        errorMessage: params.errorMessage ?? null,
      })
      .returning();

    return mapActionLogRow(inserted[0]);
  } catch (error) {
    console.error('Failed to append action log:', error);
    throw new Error('Failed to record action log entry.', { cause: error });
  }
}

export async function findPriorCompletedExecutionLog(params: {
  userId: string;
  taskId: string;
  idempotencyKey: string;
}): Promise<ActionLogRecord | null> {
  try {
    const rows = await db
      .select()
      .from(actionLogs)
      .where(
        and(
          eq(actionLogs.userId, params.userId),
          eq(actionLogs.taskId, params.taskId)
        )
      )
      .orderBy(desc(actionLogs.timestamp));

    for (const row of rows) {
      if (
        row.status === 'completed' ||
        row.status === 'pending_verification' ||
        row.status === 'verified'
      ) {
        const ev = row.evidence ?? {};
        if (ev.idempotencyKey === params.idempotencyKey) {
          return mapActionLogRow(row);
        }
      }
    }
    return null;
  } catch (error) {
    console.error('Failed to check idempotency log:', error);
    throw new Error('Failed to check idempotency state.', { cause: error });
  }
}

export async function listActionLogsByUser(
  userId: string,
  goalId?: string,
  workspaceId?: string
): Promise<ActionLogRecord[]> {
  try {
    const clauses = [eq(actionLogs.userId, userId)];
    if (goalId) clauses.push(eq(actionLogs.goalId, goalId));
    if (workspaceId) clauses.push(eq(actionLogs.workspaceId, workspaceId));

    const rows = await db
      .select()
      .from(actionLogs)
      .where(and(...clauses))
      .orderBy(desc(actionLogs.timestamp));

    return rows.map(mapActionLogRow);
  } catch (error) {
    console.error('Failed to list action logs:', error);
    throw new Error('Failed to load action logs from database.', {
      cause: error,
    });
  }
}
