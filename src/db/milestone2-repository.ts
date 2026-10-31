import crypto from 'node:crypto';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { db } from './index.ts';
import {
  executionLocks,
  executionRuns,
  goalMetricValues,
  goals,
  inboundEvents,
  nextActionProposals,
  outcomeEvidence,
  reasoningCycles,
  taskAttempts,
  tasks,
  verificationRecords,
  workspaceInboundConfigs,
  workspaces,
} from './schema.ts';
import {
  getGoalByIdForUser,
  listGoalsByUser,
  listTasksByUser,
  updateGoalForUser,
} from './repository.ts';
import {
  decryptIntegrationSecretDetailed,
  encryptIntegrationSecret,
  sanitizeEvidencePayload,
} from '../server/crypto-vault.ts';
import {
  computeGoalMetricsAndProgress,
  parseGoalTargetMetrics,
  type MetricUnit,
} from '../lib/goal-progress.ts';
import {
  INBOUND_SIGNATURE_HEADER,
  INBOUND_TIMESTAMP_HEADER,
} from '../lib/verification-engine.ts';
import type {
  CapabilityId,
  EvidenceType,
  ExecutionMonitorSnapshot,
  ExecutionRunRecord,
  GoalMetricValueRecord,
  GoalRecord,
  InboundWebhookPublicConfig,
  NextActionProposalRecord,
  OutcomeEvidenceRecord,
  ReasoningCycleRecord,
  TaskActionCategory,
  TaskAttemptRecord,
  ToolId,
  ToolRegistryItem,
  VerificationDecisionRecord,
  VerificationMethodType,
} from '../types.ts';

function isPostgresUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: string; cause?: { code?: string } };
  return candidate.code === '23505' || candidate.cause?.code === '23505';
}

function mapExecutionRunRow(
  row: typeof executionRuns.$inferSelect
): ExecutionRunRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    goalId: row.goalId,
    triggerType: row.triggerType as ExecutionRunRecord['triggerType'],
    status: row.status as ExecutionRunRecord['status'],
    concurrencyMode:
      (row.concurrencyMode as ExecutionRunRecord['concurrencyMode']) ||
      'parallel_safe',
    tasksDispatched: row.tasksDispatched,
    tasksSucceeded: row.tasksSucceeded,
    tasksFailed: row.tasksFailed,
    summary: row.summary ?? null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.durationMs ?? null,
  };
}

function mapTaskAttemptRow(
  row: typeof taskAttempts.$inferSelect
): TaskAttemptRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    goalId: row.goalId,
    taskId: row.taskId,
    runId: row.runId ?? null,
    attemptNumber: row.attemptNumber,
    workerId: row.workerId,
    providerKey: row.providerKey,
    idempotencyKey: row.idempotencyKey,
    status: row.status as TaskAttemptRecord['status'],
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.durationMs ?? null,
    nextRetryAt: row.nextRetryAt ? row.nextRetryAt.toISOString() : null,
    errorMessage: row.errorMessage ?? null,
    outputSummary: row.outputSummary ?? null,
  };
}

function mapOutcomeEvidenceRow(
  row: typeof outcomeEvidence.$inferSelect
): OutcomeEvidenceRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    goalId: row.goalId,
    taskId: row.taskId ?? null,
    inboundEventId: row.inboundEventId ?? null,
    sourceType: row.sourceType as OutcomeEvidenceRecord['sourceType'],
    provider: row.provider,
    evidenceType: row.evidenceType as EvidenceType,
    externalReferenceId: row.externalReferenceId ?? null,
    summary: row.summary,
    structuredMetrics: row.structuredMetrics ?? {},
    sanitizedPayload: row.sanitizedPayload ?? {},
    provenanceClass:
      (row.provenanceClass as OutcomeEvidenceRecord['provenanceClass']) ||
      'unverified_claim',
    trustTier:
      (row.trustTier as OutcomeEvidenceRecord['trustTier']) || 'untrusted',
    hasConflict: Boolean(row.hasConflict),
    requiresHumanReview: row.requiresHumanReview,
    verificationState:
      row.verificationState as OutcomeEvidenceRecord['verificationState'],
    observedAt: row.observedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapVerificationDecisionRow(
  row: typeof verificationRecords.$inferSelect
): VerificationDecisionRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    goalId: row.goalId,
    taskId: row.taskId ?? null,
    evidenceId: row.evidenceId ?? null,
    verificationMethod: row.verificationMethod as VerificationMethodType,
    decision: row.decision as VerificationDecisionRecord['decision'],
    reviewerIdentity: row.reviewerIdentity,
    notes: row.notes,
    traceMetadata: row.traceMetadata ?? {},
    decidedAt: row.decidedAt.toISOString(),
  };
}

function mapGoalMetricRow(
  row: typeof goalMetricValues.$inferSelect
): GoalMetricValueRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    goalId: row.goalId,
    metricKey: row.metricKey,
    metricLabel: row.metricLabel,
    unit: (row.unit as MetricUnit) || 'count',
    isPrimaryTarget: row.isPrimaryTarget,
    targetValue: Number(row.targetValue ?? 0),
    attemptedValue: Number(row.attemptedValue ?? 0),
    completedValue: Number(row.completedValue ?? 0),
    verifiedValue: Number(row.verifiedValue ?? 0),
    estimatedValue: Number(row.estimatedValue ?? 0),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapReasoningCycleRow(
  row: typeof reasoningCycles.$inferSelect
): ReasoningCycleRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    goalId: row.goalId,
    triggerSource: row.triggerSource as ReasoningCycleRecord['triggerSource'],
    modelUsed: row.modelUsed,
    currentAssessment: row.currentAssessment,
    goalAchievedRecommendation: row.goalAchievedRecommendation,
    humanInterventionRequired: row.humanInterventionRequired,
    confidenceLevel:
      row.confidenceLevel as ReasoningCycleRecord['confidenceLevel'],
    reasoningSummary: row.reasoningSummary,
    findings: Array.isArray(row.findings) ? row.findings : [],
    recommendedNextActions: Array.isArray(row.recommendedNextActions)
      ? row.recommendedNextActions
      : [],
    structuredOutput: row.structuredOutput ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

function mapNextActionProposalRow(
  row: typeof nextActionProposals.$inferSelect
): NextActionProposalRecord {
  return {
    id: row.id,
    reasoningCycleId: row.reasoningCycleId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    goalId: row.goalId,
    proposalType: row.proposalType as NextActionProposalRecord['proposalType'],
    title: row.title,
    description: row.description,
    proposedTool: row.proposedTool as ToolId,
    actionCategory: row.actionCategory as TaskActionCategory,
    requiredCapabilities: Array.isArray(row.requiredCapabilities)
      ? row.requiredCapabilities
      : [],
    dependencies: Array.isArray(row.dependencies) ? row.dependencies : [],
    targetTaskId: row.targetTaskId ?? null,
    approvalRequired: row.approvalRequired,
    expectedOutcome: row.expectedOutcome,
    verificationMethod: row.verificationMethod,
    status: row.status as NextActionProposalRecord['status'],
    enqueuedTaskId: row.enqueuedTaskId ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

// --- EXECUTION LOCKS ---

export async function acquireExecutionLock(params: {
  resourceKey: string;
  workspaceId: string;
  ownerWorkerId: string;
  idempotencyKey?: string;
  ttlMs?: number;
  nowMs?: number;
}): Promise<boolean> {
  const now = new Date(params.nowMs ?? Date.now());
  const expiresAt = new Date(now.getTime() + (params.ttlMs ?? 30_000));

  await db
    .delete(executionLocks)
    .where(lt(executionLocks.expiresAt, now))
    .catch(() => {});

  try {
    await db.insert(executionLocks).values({
      resourceKey: params.resourceKey,
      workspaceId: params.workspaceId,
      ownerWorkerId: params.ownerWorkerId,
      idempotencyKey: params.idempotencyKey ?? params.resourceKey,
      acquiredAt: now,
      expiresAt,
    });
    return true;
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      return false;
    }
    throw err;
  }
}

export async function releaseExecutionLock(params: {
  resourceKey: string;
  ownerWorkerId: string;
}): Promise<void> {
  await db
    .delete(executionLocks)
    .where(
      and(
        eq(executionLocks.resourceKey, params.resourceKey),
        eq(executionLocks.ownerWorkerId, params.ownerWorkerId)
      )
    )
    .catch(() => {});
}

// --- EXECUTION RUNS & TASK ATTEMPTS ---

export async function createExecutionRun(params: {
  userId: string;
  workspaceId: string;
  goalId: string;
  triggerType: ExecutionRunRecord['triggerType'];
  concurrencyMode: ExecutionRunRecord['concurrencyMode'];
}): Promise<ExecutionRunRecord> {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(executionRuns)
    .values({
      id,
      userId: params.userId,
      workspaceId: params.workspaceId,
      goalId: params.goalId,
      triggerType: params.triggerType,
      status: 'running',
      concurrencyMode: params.concurrencyMode,
      tasksDispatched: 0,
      tasksSucceeded: 0,
      tasksFailed: 0,
      startedAt: new Date(),
    })
    .returning();
  return mapExecutionRunRow(inserted[0]);
}

export async function finishExecutionRun(params: {
  runId: string;
  userId: string;
  status: ExecutionRunRecord['status'];
  tasksDispatched: number;
  tasksSucceeded: number;
  tasksFailed: number;
  summary: string;
  startedAtIso: string;
}): Promise<ExecutionRunRecord | null> {
  const finishedAt = new Date();
  const durationMs = Math.max(
    0,
    finishedAt.getTime() - new Date(params.startedAtIso).getTime()
  );
  const updated = await db
    .update(executionRuns)
    .set({
      status: params.status,
      tasksDispatched: params.tasksDispatched,
      tasksSucceeded: params.tasksSucceeded,
      tasksFailed: params.tasksFailed,
      summary: params.summary,
      finishedAt,
      durationMs,
    })
    .where(
      and(
        eq(executionRuns.id, params.runId),
        eq(executionRuns.userId, params.userId)
      )
    )
    .returning();
  return updated[0] ? mapExecutionRunRow(updated[0]) : null;
}

export async function createTaskAttempt(params: {
  userId: string;
  workspaceId: string;
  goalId: string;
  taskId: string;
  runId: string | null;
  attemptNumber: number;
  workerId: string;
  providerKey: string;
  idempotencyKey: string;
}): Promise<TaskAttemptRecord> {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(taskAttempts)
    .values({
      id,
      userId: params.userId,
      workspaceId: params.workspaceId,
      goalId: params.goalId,
      taskId: params.taskId,
      runId: params.runId,
      attemptNumber: params.attemptNumber,
      workerId: params.workerId,
      providerKey: params.providerKey,
      idempotencyKey: params.idempotencyKey,
      status: 'running',
      startedAt: new Date(),
    })
    .returning();
  return mapTaskAttemptRow(inserted[0]);
}

export async function finishTaskAttempt(params: {
  attemptId: string;
  userId: string;
  status: TaskAttemptRecord['status'];
  startedAtIso: string;
  nextRetryAt?: Date | null;
  errorMessage?: string | null;
  outputSummary?: string | null;
}): Promise<TaskAttemptRecord | null> {
  const finishedAt = new Date();
  const durationMs = Math.max(
    0,
    finishedAt.getTime() - new Date(params.startedAtIso).getTime()
  );
  const updated = await db
    .update(taskAttempts)
    .set({
      status: params.status,
      finishedAt,
      durationMs,
      nextRetryAt: params.nextRetryAt ?? null,
      errorMessage: params.errorMessage ?? null,
      outputSummary: params.outputSummary ?? null,
    })
    .where(
      and(
        eq(taskAttempts.id, params.attemptId),
        eq(taskAttempts.userId, params.userId)
      )
    )
    .returning();
  return updated[0] ? mapTaskAttemptRow(updated[0]) : null;
}

export async function listTaskAttemptsByWorkspace(params: {
  userId: string;
  workspaceId: string;
  goalId?: string;
}): Promise<TaskAttemptRecord[]> {
  const clauses = [
    eq(taskAttempts.userId, params.userId),
    eq(taskAttempts.workspaceId, params.workspaceId),
  ];
  if (params.goalId) clauses.push(eq(taskAttempts.goalId, params.goalId));

  const rows = await db
    .select()
    .from(taskAttempts)
    .where(and(...clauses))
    .orderBy(desc(taskAttempts.startedAt))
    .limit(100);
  return rows.map(mapTaskAttemptRow);
}

// --- WORKSPACE INBOUND WEBHOOK SIGNING CONFIG ---

export async function getWorkspaceInboundWebhookPublicConfig(params: {
  userId: string;
  workspaceId: string;
}): Promise<InboundWebhookPublicConfig> {
  const rows = await db
    .select()
    .from(workspaceInboundConfigs)
    .where(
      and(
        eq(workspaceInboundConfigs.userId, params.userId),
        eq(workspaceInboundConfigs.workspaceId, params.workspaceId)
      )
    );
  const row = rows[0];
  return {
    workspaceId: params.workspaceId,
    configured: Boolean(row),
    enabled: row ? row.enabled : false,
    endpointPath: `/api/webhooks/inbound/${params.workspaceId}`,
    maskedHint: row?.secretMaskedHint ?? null,
    signatureHeader: 'X-TaskAI-Signature',
    timestampHeader: 'X-TaskAI-Timestamp',
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Generates or rotates the per-workspace inbound webhook HMAC-SHA256 signing secret.
 * Returns the plaintext secret ONCE during rotation so the workspace owner can configure
 * their external webhook sender; subsequent GET calls return only `maskedHint`.
 */
export async function rotateWorkspaceInboundWebhookSecret(params: {
  userId: string;
  workspaceId: string;
}): Promise<{
  config: InboundWebhookPublicConfig;
  oneTimeSigningSecret: string;
}> {
  const wsRows = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, params.workspaceId),
        eq(workspaces.ownerUserId, params.userId)
      )
    );
  if (!wsRows[0]) {
    throw new Error('Workspace not found or access denied.');
  }

  const rawSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  const enc = encryptIntegrationSecret(rawSecret);
  const now = new Date();

  const existing = await db
    .select()
    .from(workspaceInboundConfigs)
    .where(
      and(
        eq(workspaceInboundConfigs.userId, params.userId),
        eq(workspaceInboundConfigs.workspaceId, params.workspaceId)
      )
    );

  if (existing[0]) {
    await db
      .update(workspaceInboundConfigs)
      .set({
        encryptedSigningSecret: enc.ciphertextBase64,
        secretIv: enc.ivBase64,
        secretAuthTag: enc.authTagBase64,
        secretMaskedHint: enc.maskedHint,
        enabled: true,
        updatedAt: now,
      })
      .where(eq(workspaceInboundConfigs.id, existing[0].id));
  } else {
    await db.insert(workspaceInboundConfigs).values({
      id: crypto.randomUUID(),
      userId: params.userId,
      workspaceId: params.workspaceId,
      encryptedSigningSecret: enc.ciphertextBase64,
      secretIv: enc.ivBase64,
      secretAuthTag: enc.authTagBase64,
      secretMaskedHint: enc.maskedHint,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    config: {
      workspaceId: params.workspaceId,
      configured: true,
      enabled: true,
      endpointPath: `/api/webhooks/inbound/${params.workspaceId}`,
      maskedHint: enc.maskedHint,
      signatureHeader: INBOUND_SIGNATURE_HEADER,
      timestampHeader: INBOUND_TIMESTAMP_HEADER,
      updatedAt: now.toISOString(),
    },
    oneTimeSigningSecret: rawSecret,
  };
}

/**
 * Server-only helper to verify public inbound webhook calls targeting `:workspaceId`.
 * Looks up the workspace owner and decrypts the workspace's inbound signing secret in memory.
 */
export async function getWorkspaceInboundSecretForServer(
  workspaceId: string
): Promise<{
  workspaceOwnerUserId: string;
  workspaceId: string;
  enabled: boolean;
  signingSecret: string;
} | null> {
  const rows = await db
    .select()
    .from(workspaceInboundConfigs)
    .where(eq(workspaceInboundConfigs.workspaceId, workspaceId));
  const row = rows[0];
  if (!row) return null;

  const decrypted = decryptIntegrationSecretDetailed({
    ciphertextBase64: row.encryptedSigningSecret,
    ivBase64: row.secretIv,
    authTagBase64: row.secretAuthTag,
  });

  if (decrypted.needsReencryption) {
    const reenc = encryptIntegrationSecret(decrypted.plaintext);
    await db
      .update(workspaceInboundConfigs)
      .set({
        encryptedSigningSecret: reenc.ciphertextBase64,
        secretIv: reenc.ivBase64,
        secretAuthTag: reenc.authTagBase64,
        secretMaskedHint: reenc.maskedHint,
        updatedAt: new Date(),
      })
      .where(eq(workspaceInboundConfigs.id, row.id))
      .catch(() => {});
  }

  return {
    workspaceOwnerUserId: row.userId,
    workspaceId: row.workspaceId,
    enabled: row.enabled,
    signingSecret: decrypted.plaintext,
  };
}

// --- INBOUND EVENTS & OUTCOME EVIDENCE ---

export async function insertInboundEventDeduped(params: {
  workspaceId: string;
  goalId: string | null;
  taskId: string | null;
  provider: string;
  externalEventId: string;
  idempotencyKey: string;
  evidenceType: EvidenceType;
  eventTimestamp: Date;
  signatureVerified: boolean;
  processingStatus: string;
  rawPayload: Record<string, unknown>;
}): Promise<
  | { duplicate: false; inboundEventId: string }
  | { duplicate: true; existingInboundEventId: string }
> {
  const id = crypto.randomUUID();
  const sanitizedPayload = sanitizeEvidencePayload(params.rawPayload);

  try {
    await db.insert(inboundEvents).values({
      id,
      workspaceId: params.workspaceId,
      goalId: params.goalId,
      taskId: params.taskId,
      provider: params.provider,
      externalEventId: params.externalEventId,
      idempotencyKey: params.idempotencyKey,
      evidenceType: params.evidenceType,
      eventTimestamp: params.eventTimestamp,
      signatureVerified: params.signatureVerified,
      processingStatus: params.processingStatus,
      sanitizedPayload,
      receivedAt: new Date(),
    });
    return { duplicate: false, inboundEventId: id };
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      const existing = await db
        .select()
        .from(inboundEvents)
        .where(
          and(
            eq(inboundEvents.workspaceId, params.workspaceId),
            eq(inboundEvents.provider, params.provider),
            eq(inboundEvents.externalEventId, params.externalEventId)
          )
        );
      return {
        duplicate: true,
        existingInboundEventId: existing[0]?.id ?? 'duplicate_event',
      };
    }
    throw err;
  }
}

export async function createOutcomeEvidenceRecord(params: {
  userId: string;
  workspaceId: string;
  goalId: string;
  taskId: string | null;
  inboundEventId: string | null;
  sourceType: OutcomeEvidenceRecord['sourceType'];
  provider: string;
  evidenceType: EvidenceType;
  externalReferenceId: string | null;
  summary: string;
  structuredMetrics: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  provenanceClass?: OutcomeEvidenceRecord['provenanceClass'];
  trustTier?: OutcomeEvidenceRecord['trustTier'];
  hasConflict?: boolean;
  requiresHumanReview: boolean;
  verificationState: OutcomeEvidenceRecord['verificationState'];
  observedAt: Date;
}): Promise<OutcomeEvidenceRecord> {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(outcomeEvidence)
    .values({
      id,
      userId: params.userId,
      workspaceId: params.workspaceId,
      goalId: params.goalId,
      taskId: params.taskId,
      inboundEventId: params.inboundEventId,
      sourceType: params.sourceType,
      provider: params.provider,
      evidenceType: params.evidenceType,
      externalReferenceId: params.externalReferenceId,
      summary: params.summary,
      structuredMetrics: sanitizeEvidencePayload(params.structuredMetrics),
      sanitizedPayload: sanitizeEvidencePayload(params.rawPayload),
      provenanceClass: params.provenanceClass ?? 'unverified_claim',
      trustTier: params.trustTier ?? 'untrusted',
      hasConflict: params.hasConflict ?? false,
      requiresHumanReview: params.requiresHumanReview,
      verificationState: params.verificationState,
      observedAt: params.observedAt,
      createdAt: new Date(),
    })
    .returning();
  return mapOutcomeEvidenceRow(inserted[0]);
}

export async function detectAndQuarantineConflictingReference(params: {
  userId: string;
  workspaceId: string;
  goalId: string;
  evidenceType: EvidenceType;
  externalReferenceId: string | null;
  newStructuredMetrics: Record<string, unknown>;
}): Promise<boolean> {
  const ref = params.externalReferenceId?.trim() || null;
  if (!ref || params.evidenceType === 'outcome_reversal' || params.evidenceType === 'api_dispatch_ack') {
    return false;
  }

  const existingRows = await db
    .select()
    .from(outcomeEvidence)
    .where(
      and(
        eq(outcomeEvidence.userId, params.userId),
        eq(outcomeEvidence.workspaceId, params.workspaceId),
        eq(outcomeEvidence.goalId, params.goalId),
        eq(outcomeEvidence.externalReferenceId, ref)
      )
    );

  const activeMatching = existingRows.filter(
    (r) =>
      r.verificationState !== 'rejected' &&
      r.evidenceType !== 'outcome_reversal' &&
      r.evidenceType !== 'api_dispatch_ack' &&
      r.provenanceClass !== 'human_confirmed'
  );
  if (activeMatching.length === 0) return false;

  const canonicalNew = JSON.stringify(
    sanitizeEvidencePayload(params.newStructuredMetrics)
  );
  const hasMismatch = activeMatching.some((r) => {
    if (r.evidenceType !== params.evidenceType) return true;
    const canonicalOld = JSON.stringify(r.structuredMetrics ?? {});
    return canonicalOld !== canonicalNew;
  });

  if (!hasMismatch) return false;

  // Quarantine prior matching rows for this reference into pending_verification + hasConflict=true
  for (const prior of activeMatching) {
    await db
      .update(outcomeEvidence)
      .set({
        hasConflict: true,
        requiresHumanReview: true,
        verificationState: 'pending_verification',
      })
      .where(eq(outcomeEvidence.id, prior.id));
  }

  return true;
}

export async function getOutcomeEvidenceByIdForUser(
  evidenceId: string,
  userId: string
): Promise<OutcomeEvidenceRecord | null> {
  const rows = await db
    .select()
    .from(outcomeEvidence)
    .where(
      and(
        eq(outcomeEvidence.id, evidenceId),
        eq(outcomeEvidence.userId, userId)
      )
    );
  return rows[0] ? mapOutcomeEvidenceRow(rows[0]) : null;
}

export async function updateOutcomeEvidenceVerificationState(params: {
  evidenceId: string;
  userId: string;
  verificationState: OutcomeEvidenceRecord['verificationState'];
  provenanceClass?: OutcomeEvidenceRecord['provenanceClass'];
  trustTier?: OutcomeEvidenceRecord['trustTier'];
  hasConflict?: boolean;
  requiresHumanReview?: boolean;
}): Promise<OutcomeEvidenceRecord | null> {
  const patch: Partial<typeof outcomeEvidence.$inferInsert> = {
    verificationState: params.verificationState,
  };
  if (params.provenanceClass !== undefined) {
    patch.provenanceClass = params.provenanceClass;
  }
  if (params.trustTier !== undefined) {
    patch.trustTier = params.trustTier;
  }
  if (params.hasConflict !== undefined) {
    patch.hasConflict = params.hasConflict;
  }
  if (params.requiresHumanReview !== undefined) {
    patch.requiresHumanReview = params.requiresHumanReview;
  }

  const updated = await db
    .update(outcomeEvidence)
    .set(patch)
    .where(
      and(
        eq(outcomeEvidence.id, params.evidenceId),
        eq(outcomeEvidence.userId, params.userId)
      )
    )
    .returning();
  return updated[0] ? mapOutcomeEvidenceRow(updated[0]) : null;
}

export async function listOutcomeEvidenceByWorkspace(params: {
  userId: string;
  workspaceId: string;
  goalId?: string;
}): Promise<OutcomeEvidenceRecord[]> {
  const clauses = [
    eq(outcomeEvidence.userId, params.userId),
    eq(outcomeEvidence.workspaceId, params.workspaceId),
  ];
  if (params.goalId) clauses.push(eq(outcomeEvidence.goalId, params.goalId));

  const rows = await db
    .select()
    .from(outcomeEvidence)
    .where(and(...clauses))
    .orderBy(desc(outcomeEvidence.observedAt), desc(outcomeEvidence.createdAt));
  return rows.map(mapOutcomeEvidenceRow);
}

export async function createVerificationDecisionRecord(params: {
  userId: string;
  workspaceId: string;
  goalId: string;
  taskId: string | null;
  evidenceId: string | null;
  verificationMethod: VerificationMethodType;
  decision: VerificationDecisionRecord['decision'];
  reviewerIdentity: string;
  notes: string;
  traceMetadata?: Record<string, unknown>;
}): Promise<VerificationDecisionRecord> {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(verificationRecords)
    .values({
      id,
      userId: params.userId,
      workspaceId: params.workspaceId,
      goalId: params.goalId,
      taskId: params.taskId,
      evidenceId: params.evidenceId,
      verificationMethod: params.verificationMethod,
      decision: params.decision,
      reviewerIdentity: params.reviewerIdentity,
      notes: params.notes,
      traceMetadata: sanitizeEvidencePayload(params.traceMetadata ?? {}),
      decidedAt: new Date(),
    })
    .returning();
  return mapVerificationDecisionRow(inserted[0]);
}

export async function listVerificationRecordsByWorkspace(params: {
  userId: string;
  workspaceId: string;
  goalId?: string;
}): Promise<VerificationDecisionRecord[]> {
  const clauses = [
    eq(verificationRecords.userId, params.userId),
    eq(verificationRecords.workspaceId, params.workspaceId),
  ];
  if (params.goalId) {
    clauses.push(eq(verificationRecords.goalId, params.goalId));
  }
  const rows = await db
    .select()
    .from(verificationRecords)
    .where(and(...clauses))
    .orderBy(desc(verificationRecords.decidedAt))
    .limit(100);
  return rows.map(mapVerificationDecisionRow);
}

// --- GOAL PROGRESS INTELLIGENCE PERSISTENCE ---

export async function ensureGoalMetricsInitialized(params: {
  userId: string;
  workspaceId: string;
  goal: GoalRecord;
}): Promise<GoalMetricValueRecord[]> {
  const parsed = parseGoalTargetMetrics(params.goal.targetMetric);
  const existing = await db
    .select()
    .from(goalMetricValues)
    .where(
      and(
        eq(goalMetricValues.goalId, params.goal.id),
        eq(goalMetricValues.userId, params.userId)
      )
    );

  const byKey = new Map(existing.map((r) => [r.metricKey, r]));
  const now = new Date();

  const parsedByKey = new Map(parsed.map((d) => [d.metricKey, d]));

  // Demote any stale primary metric row that is no longer part of the parsed primary targets
  for (const row of existing) {
    const matchingDef = parsedByKey.get(row.metricKey);
    if (!matchingDef && row.isPrimaryTarget) {
      await db
        .update(goalMetricValues)
        .set({
          isPrimaryTarget: false,
          targetValue: 0,
          updatedAt: now,
        })
        .where(eq(goalMetricValues.id, row.id));
    }
  }

  for (const def of parsed) {
    const found = byKey.get(def.metricKey);
    if (!found) {
      await db
        .insert(goalMetricValues)
        .values({
          id: crypto.randomUUID(),
          userId: params.userId,
          workspaceId: params.workspaceId,
          goalId: params.goal.id,
          metricKey: def.metricKey,
          metricLabel: def.metricLabel,
          unit: def.unit,
          isPrimaryTarget: def.isPrimaryTarget,
          targetValue: def.targetValue,
          attemptedValue: 0,
          completedValue: 0,
          verifiedValue: 0,
          estimatedValue: 0,
          updatedAt: now,
        })
        .onConflictDoNothing();
    } else if (
      found.isPrimaryTarget !== def.isPrimaryTarget ||
      found.targetValue !== def.targetValue ||
      found.unit !== def.unit ||
      found.metricLabel !== def.metricLabel
    ) {
      await db
        .update(goalMetricValues)
        .set({
          metricLabel: def.metricLabel,
          unit: def.unit,
          isPrimaryTarget: def.isPrimaryTarget,
          targetValue: def.targetValue,
          updatedAt: now,
        })
        .where(eq(goalMetricValues.id, found.id));
    }
  }

  const refreshed = await db
    .select()
    .from(goalMetricValues)
    .where(
      and(
        eq(goalMetricValues.goalId, params.goal.id),
        eq(goalMetricValues.userId, params.userId)
      )
    )
    .orderBy(desc(goalMetricValues.isPrimaryTarget), asc(goalMetricValues.metricKey));
  return refreshed.map(mapGoalMetricRow);
}

/**
 * Recalculates multi-metric progress for a goal strictly from verified outcomes
 * and transitions the goal to `completed` ONLY when `isGoalAchieved === true`.
 */
export async function recalculateAndPersistGoalProgress(params: {
  userId: string;
  goalId: string;
}): Promise<{
  goal: GoalRecord | null;
  metrics: GoalMetricValueRecord[];
  progressPercent: number;
  isGoalAchieved: boolean;
}> {
  const goal = await getGoalByIdForUser(params.goalId, params.userId);
  if (!goal || !goal.workspaceId) {
    return {
      goal,
      metrics: [],
      progressPercent: 0,
      isGoalAchieved: false,
    };
  }

  const workspaceId = goal.workspaceId;
  await ensureGoalMetricsInitialized({
    userId: params.userId,
    workspaceId,
    goal,
  });

  const [goalTasks, attempts, evidence] = await Promise.all([
    listTasksByUser(params.userId, goal.id, workspaceId),
    listTaskAttemptsByWorkspace({
      userId: params.userId,
      workspaceId,
      goalId: goal.id,
    }),
    listOutcomeEvidenceByWorkspace({
      userId: params.userId,
      workspaceId,
      goalId: goal.id,
    }),
  ]);

  const computed = computeGoalMetricsAndProgress({
    goal,
    tasks: goalTasks,
    attempts,
    evidence,
  });

  const now = new Date();
  for (const m of computed.metrics) {
    const existingRows = await db
      .select()
      .from(goalMetricValues)
      .where(
        and(
          eq(goalMetricValues.goalId, goal.id),
          eq(goalMetricValues.metricKey, m.metricKey)
        )
      );
    if (existingRows[0]) {
      await db
        .update(goalMetricValues)
        .set({
          metricLabel: m.metricLabel,
          unit: m.unit,
          isPrimaryTarget: m.isPrimaryTarget,
          targetValue: m.targetValue,
          attemptedValue: m.attemptedValue,
          completedValue: m.completedValue,
          verifiedValue: m.verifiedValue,
          estimatedValue: m.estimatedValue,
          updatedAt: now,
        })
        .where(eq(goalMetricValues.id, existingRows[0].id));
    } else {
      await db.insert(goalMetricValues).values({
        id: crypto.randomUUID(),
        userId: params.userId,
        workspaceId,
        goalId: goal.id,
        metricKey: m.metricKey,
        metricLabel: m.metricLabel,
        unit: m.unit,
        isPrimaryTarget: m.isPrimaryTarget,
        targetValue: m.targetValue,
        attemptedValue: m.attemptedValue,
        completedValue: m.completedValue,
        verifiedValue: m.verifiedValue,
        estimatedValue: m.estimatedValue,
        updatedAt: now,
      });
    }
  }

  // Goal achievement invariant: mark completed ONLY when verified primary target is satisfied
  let nextGoalStatus = goal.status;
  let nextExecState = goal.executionState;
  let nextAchievedAt: Date | null | undefined = undefined;

  if (computed.isGoalAchieved && goal.status !== 'failed') {
    nextGoalStatus = 'completed';
    nextExecState = 'completed';
    if (!goal.achievedAt) {
      nextAchievedAt = now;
    }
  } else if (!computed.isGoalAchieved && goal.status === 'completed') {
    // If previously marked completed without verified target satisfaction, restore active/planning honesty
    nextGoalStatus = 'active';
    nextExecState = 'idle';
    nextAchievedAt = null;
  }

  const updatedGoal = await updateGoalForUser({
    goalId: goal.id,
    userId: params.userId,
    status: nextGoalStatus,
    executionState: nextExecState,
    progressPercent: computed.progressPercent,
    achievedAt: nextAchievedAt,
  });

  const savedMetrics = await db
    .select()
    .from(goalMetricValues)
    .where(
      and(
        eq(goalMetricValues.goalId, goal.id),
        eq(goalMetricValues.userId, params.userId)
      )
    )
    .orderBy(
      desc(goalMetricValues.isPrimaryTarget),
      asc(goalMetricValues.metricKey)
    );

  return {
    goal: updatedGoal,
    metrics: savedMetrics.map(mapGoalMetricRow),
    progressPercent: computed.progressPercent,
    isGoalAchieved: computed.isGoalAchieved,
  };
}

export async function listGoalMetricsByWorkspace(params: {
  userId: string;
  workspaceId: string;
}): Promise<GoalMetricValueRecord[]> {
  const rows = await db
    .select()
    .from(goalMetricValues)
    .where(
      and(
        eq(goalMetricValues.userId, params.userId),
        eq(goalMetricValues.workspaceId, params.workspaceId)
      )
    )
    .orderBy(
      desc(goalMetricValues.isPrimaryTarget),
      asc(goalMetricValues.metricKey)
    );
  return rows.map(mapGoalMetricRow);
}

// --- CONTINUOUS AI REASONING & NEXT-ACTION PROPOSALS ---

export async function saveReasoningCycleWithProposals(params: {
  userId: string;
  workspaceId: string;
  goalId: string;
  triggerSource: ReasoningCycleRecord['triggerSource'];
  modelUsed: string;
  currentAssessment: string;
  goalAchievedRecommendation: boolean;
  humanInterventionRequired: boolean;
  confidenceLevel: ReasoningCycleRecord['confidenceLevel'];
  reasoningSummary: string;
  findings: string[];
  recommendedNextActions: string[];
  structuredOutput: Record<string, unknown>;
  proposals: Array<{
    proposalType: NextActionProposalRecord['proposalType'];
    title: string;
    description: string;
    proposedTool: ToolId;
    actionCategory: TaskActionCategory;
    requiredCapabilities: CapabilityId[];
    dependencies: string[];
    targetTaskId: string | null;
    approvalRequired: boolean;
    expectedOutcome: string;
    verificationMethod: string;
  }>;
}): Promise<{
  cycle: ReasoningCycleRecord;
  proposals: NextActionProposalRecord[];
}> {
  return db.transaction(async (tx) => {
    const cycleId = crypto.randomUUID();
    const now = new Date();
    const insertedCycle = await tx
      .insert(reasoningCycles)
      .values({
        id: cycleId,
        userId: params.userId,
        workspaceId: params.workspaceId,
        goalId: params.goalId,
        triggerSource: params.triggerSource,
        modelUsed: params.modelUsed,
        currentAssessment: params.currentAssessment,
        goalAchievedRecommendation: params.goalAchievedRecommendation,
        humanInterventionRequired: params.humanInterventionRequired,
        confidenceLevel: params.confidenceLevel,
        reasoningSummary: params.reasoningSummary,
        findings: params.findings,
        recommendedNextActions: params.recommendedNextActions,
        structuredOutput: sanitizeEvidencePayload(params.structuredOutput),
        createdAt: now,
      })
      .returning();

    const savedProposals: NextActionProposalRecord[] = [];
    for (const prop of params.proposals) {
      const propId = crypto.randomUUID();
      const row = await tx
        .insert(nextActionProposals)
        .values({
          id: propId,
          reasoningCycleId: cycleId,
          userId: params.userId,
          workspaceId: params.workspaceId,
          goalId: params.goalId,
          proposalType: prop.proposalType,
          title: prop.title,
          description: prop.description,
          proposedTool: prop.proposedTool,
          actionCategory: prop.actionCategory,
          requiredCapabilities: prop.requiredCapabilities,
          dependencies: prop.dependencies,
          targetTaskId: prop.targetTaskId,
          approvalRequired: prop.approvalRequired,
          expectedOutcome: prop.expectedOutcome,
          verificationMethod: prop.verificationMethod,
          status: 'proposed',
          createdAt: now,
        })
        .returning();
      savedProposals.push(mapNextActionProposalRow(row[0]));
    }

    return {
      cycle: mapReasoningCycleRow(insertedCycle[0]),
      proposals: savedProposals,
    };
  });
}

export async function getProposalByIdForUser(
  proposalId: string,
  userId: string
): Promise<NextActionProposalRecord | null> {
  const rows = await db
    .select()
    .from(nextActionProposals)
    .where(
      and(
        eq(nextActionProposals.id, proposalId),
        eq(nextActionProposals.userId, userId)
      )
    );
  return rows[0] ? mapNextActionProposalRow(rows[0]) : null;
}

export async function claimProposalForDecisionAtomically(params: {
  proposalId: string;
  userId: string;
  nextStatus: 'enqueued' | 'rejected';
}): Promise<NextActionProposalRecord | null> {
  const claimed = await db
    .update(nextActionProposals)
    .set({
      status: params.nextStatus,
      decidedAt: new Date(),
    })
    .where(
      and(
        eq(nextActionProposals.id, params.proposalId),
        eq(nextActionProposals.userId, params.userId),
        eq(nextActionProposals.status, 'proposed')
      )
    )
    .returning();
  return claimed[0] ? mapNextActionProposalRow(claimed[0]) : null;
}

export async function markProposalDecided(params: {
  proposalId: string;
  userId: string;
  status: 'enqueued' | 'rejected';
  enqueuedTaskId?: string | null;
}): Promise<NextActionProposalRecord | null> {
  const updated = await db
    .update(nextActionProposals)
    .set({
      status: params.status,
      enqueuedTaskId: params.enqueuedTaskId ?? null,
      decidedAt: new Date(),
    })
    .where(
      and(
        eq(nextActionProposals.id, params.proposalId),
        eq(nextActionProposals.userId, params.userId)
      )
    )
    .returning();
  return updated[0] ? mapNextActionProposalRow(updated[0]) : null;
}

// --- COMPLETE EXECUTION MONITOR SNAPSHOT ---

export async function getExecutionMonitorSnapshot(params: {
  userId: string;
  workspaceId: string;
  tools: ToolRegistryItem[];
}): Promise<ExecutionMonitorSnapshot> {
  const { userId, workspaceId, tools } = params;

  const workspaceGoals = await listGoalsByUser(userId, workspaceId);
  for (const g of workspaceGoals) {
    await ensureGoalMetricsInitialized({ userId, workspaceId, goal: g });
  }

  const [
    workspaceTasks,
    runsRows,
    attemptsRows,
    evidenceRows,
    verificationsRows,
    goalMetricsRows,
    reasoningRows,
    proposalRows,
    inboundWebhook,
  ] = await Promise.all([
    listTasksByUser(userId, undefined, workspaceId),
    db
      .select()
      .from(executionRuns)
      .where(
        and(
          eq(executionRuns.userId, userId),
          eq(executionRuns.workspaceId, workspaceId)
        )
      )
      .orderBy(desc(executionRuns.startedAt))
      .limit(50),
    db
      .select()
      .from(taskAttempts)
      .where(
        and(
          eq(taskAttempts.userId, userId),
          eq(taskAttempts.workspaceId, workspaceId)
        )
      )
      .orderBy(desc(taskAttempts.startedAt))
      .limit(80),
    db
      .select()
      .from(outcomeEvidence)
      .where(
        and(
          eq(outcomeEvidence.userId, userId),
          eq(outcomeEvidence.workspaceId, workspaceId)
        )
      )
      .orderBy(desc(outcomeEvidence.observedAt), desc(outcomeEvidence.createdAt))
      .limit(80),
    db
      .select()
      .from(verificationRecords)
      .where(
        and(
          eq(verificationRecords.userId, userId),
          eq(verificationRecords.workspaceId, workspaceId)
        )
      )
      .orderBy(desc(verificationRecords.decidedAt))
      .limit(80),
    db
      .select()
      .from(goalMetricValues)
      .where(
        and(
          eq(goalMetricValues.userId, userId),
          eq(goalMetricValues.workspaceId, workspaceId)
        )
      )
      .orderBy(
        desc(goalMetricValues.isPrimaryTarget),
        asc(goalMetricValues.metricKey)
      ),
    db
      .select()
      .from(reasoningCycles)
      .where(
        and(
          eq(reasoningCycles.userId, userId),
          eq(reasoningCycles.workspaceId, workspaceId)
        )
      )
      .orderBy(desc(reasoningCycles.createdAt))
      .limit(25),
    db
      .select()
      .from(nextActionProposals)
      .where(
        and(
          eq(nextActionProposals.userId, userId),
          eq(nextActionProposals.workspaceId, workspaceId)
        )
      )
      .orderBy(desc(nextActionProposals.createdAt))
      .limit(50),
    getWorkspaceInboundWebhookPublicConfig({ userId, workspaceId }),
  ]);

  const attempts = attemptsRows.map(mapTaskAttemptRow);
  const evidence = evidenceRows.map(mapOutcomeEvidenceRow);

  const totalExecutionDurationMs = attempts.reduce(
    (sum, a) => sum + (a.durationMs ?? 0),
    0
  );
  const totalRetryAttempts = attempts.filter((a) => a.attemptNumber > 1).length;
  const readyProvidersCount = tools.filter(
    (t) => t.configured && t.verified
  ).length;

  return {
    workspaceId,
    counts: {
      activeGoals: workspaceGoals.filter((g) => g.status === 'active').length,
      queuedTasks: workspaceTasks.filter(
        (t) =>
          t.status === 'queued' ||
          t.status === 'approved' ||
          t.status === 'proposed'
      ).length,
      runningTasks: workspaceTasks.filter((t) => t.status === 'running').length,
      completedTasks: workspaceTasks.filter((t) => t.status === 'completed')
        .length,
      pendingVerificationTasks: workspaceTasks.filter(
        (t) => t.status === 'pending_verification'
      ).length,
      verifiedOutcomes: evidence.filter(
        (e) =>
          e.verificationState === 'verified' &&
          !e.hasConflict &&
          e.provenanceClass !== 'internal_diagnostic' &&
          e.trustTier !== 'diagnostic_only' &&
          e.sourceType !== 'deterministic_execution' &&
          e.evidenceType !== 'diagnostic_checksum' &&
          e.evidenceType !== 'api_dispatch_ack' &&
          e.evidenceType !== 'outcome_reversal'
      ).length,
      failedTasks: workspaceTasks.filter((t) => t.status === 'failed').length,
      blockedTasks: workspaceTasks.filter((t) => t.status === 'blocked').length,
      awaitingApprovalTasks: workspaceTasks.filter(
        (t) => t.approvalRequired && t.approvalStatus === 'pending'
      ).length,
      totalRetryAttempts,
      totalExecutionDurationMs,
      readyProvidersCount,
    },
    runs: runsRows.map(mapExecutionRunRow),
    attempts,
    evidence,
    verifications: verificationsRows.map(mapVerificationDecisionRow),
    goalMetrics: goalMetricsRows.map(mapGoalMetricRow),
    reasoningCycles: reasoningRows.map(mapReasoningCycleRow),
    proposals: proposalRows.map(mapNextActionProposalRow),
    inboundWebhook,
  };
}
