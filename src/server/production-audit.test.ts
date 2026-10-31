import 'dotenv/config';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import { inArray, like } from 'drizzle-orm';
import { createPool, db } from '../db/index.ts';
import { actionLogs, goals, tasks, users, workspaces } from '../db/schema.ts';
import { getOrCreateUser } from '../db/users.ts';
import {
  createGoalForUser,
  createSingleTaskForGoal,
  createUserIntegration,
  createWorkspaceForUser,
  ensureDefaultWorkspaceForUser,
  getExecutableIntegrationForServer,
  getGoalByIdForUser,
  getTaskByIdForUser,
  listActionLogsByUser,
  listGoalsByUser,
  listIntegrationsByUser,
  listTasksByUser,
  recordApprovalDecision,
  recordIntegrationTestOutcome,
  updateTaskAfterWorkerCheckOrRun,
} from '../db/repository.ts';
import {
  acquireExecutionLock,
  getExecutionMonitorSnapshot,
  listOutcomeEvidenceByWorkspace,
  recalculateAndPersistGoalProgress,
  releaseExecutionLock,
  rotateWorkspaceInboundWebhookSecret,
  saveReasoningCycleWithProposals,
} from '../db/milestone2-repository.ts';
import {
  computeResultsReport,
  defaultCapabilitiesForTask,
  resolveExecutionRoute,
} from '../lib/domain-rules.ts';
import {
  computeGoalMetricsAndProgress,
  parseGoalTargetMetrics,
} from '../lib/goal-progress.ts';
import {
  buildProviderRegistryItems,
  PROVIDER_DESCRIPTORS,
} from '../lib/provider-registry.ts';
import { computeInboundWebhookSignature } from '../lib/verification-engine.ts';
import {
  createSignedIsolatedToken,
  verifySignedIsolatedToken,
} from '../middleware/auth.ts';
import {
  buildWorkspaceToolRegistry,
  executeRoutedTask,
} from './execution-router.ts';
import {
  decideNextActionProposal,
  executeSingleTaskManaged,
  ingestSignedInboundEvidence,
  reconcileUncertainTask,
  recoverStalledTasksForGoal,
  retryTaskManually,
  reviewOutcomeEvidenceByHuman,
  runAiAssistedVerificationOnEvidence,
  runOrchestratorCycle,
} from './orchestrator.ts';
import {
  createExpressRateLimitMiddleware,
  RateLimitExceededError,
  resetRateLimiterForTests,
} from './rate-limiter.ts';
import {
  isPrivateOrReservedIp,
  validateDestinationUrlSync,
  type safeOutboundPostJson,
} from './ssrf-guard.ts';

type HttpTransportFn = typeof safeOutboundPostJson;

const auditTenantUids: string[] = [];

async function cleanupAuditTenants(uids: string[]) {
  if (uids.length === 0) return;
  await db.delete(actionLogs).where(inArray(actionLogs.userId, uids));
  await db.delete(tasks).where(inArray(tasks.userId, uids));
  await db.delete(goals).where(inArray(goals.userId, uids));
  await db.delete(workspaces).where(inArray(workspaces.ownerUserId, uids));
  await db.delete(users).where(inArray(users.uid, uids));
}

async function createAuditTenant(label: string) {
  const uid = `audit_test_${label}_${crypto.randomUUID().slice(0, 8)}`;
  const email = `${uid}@taskai-audit.local`;
  auditTenantUids.push(uid);
  await getOrCreateUser(uid, email);
  const workspace = await ensureDefaultWorkspaceForUser(uid);
  return { uid, email, workspace };
}

function signInboundCall(params: {
  workspaceSecret: string;
  providerSecret?: string;
  payload: Record<string, unknown>;
  timestampSec?: number;
}) {
  const ts = params.timestampSec ?? Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify(params.payload);
  return {
    rawBody,
    parsedBody: params.payload,
    signatureHeader: computeInboundWebhookSignature(
      params.workspaceSecret,
      ts,
      rawBody
    ),
    providerSignatureHeader: params.providerSecret
      ? computeInboundWebhookSignature(params.providerSecret, ts, rawBody)
      : undefined,
    timestampHeader: String(ts),
  };
}

test.before(async () => {
  const stale = await db
    .select({ uid: users.uid })
    .from(users)
    .where(like(users.uid, 'audit_test_%'));
  if (stale.length > 0) {
    await cleanupAuditTenants(stale.map((r) => r.uid));
  }
});

test.after(async () => {
  await cleanupAuditTenants(auditTenantUids);
  await createPool().end();
});

// ============================================================================
// DIMENSION 1: EXECUTION RELIABILITY STRESS TESTS
// ============================================================================

test('AUDIT 1.1: Concurrent duplicate dispatch race (5 parallel workers -> external transport called strictly once)', async () => {
  resetRateLimiterForTests();
  const tenant = await createAuditTenant('d1_race');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Dispatch high-value contract invoice once without duplicates.',
    targetMetric: '1 paying customer',
    status: 'active',
  });

  const integration = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'custom_webhook',
    displayName: 'Billing Dispatch Webhook',
    connectionMode: 'user_owned',
    capabilities: ['workflow_automation', 'payment_verification', 'http_request'],
    configMetadata: {
      endpointUrl: 'https://billing.example.com/dispatch',
      authType: 'bearer_token',
    },
    plaintextSecret: 'tok_billing_concurrent_test_001122',
  });
  await recordIntegrationTestOutcome({
    integrationId: integration.id,
    userId: tenant.uid,
    verified: true,
    statusDetail: 'Verified',
    testedAt: new Date(),
  });

  const task = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Send invoice checkout link',
    tool: 'custom_webhook',
    requiredCapabilities: ['workflow_automation'],
    actionCategory: 'payment_collection',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'Send $5,000 invoice',
      targetRecipient: 'billing@client.example',
      estimatedCost: '$0.00',
      explanation: 'Sends invoice',
    },
    expectedResult: 'Paid invoice',
    verificationMethod: 'Signed payment_confirmed webhook',
  });
  await recordApprovalDecision({
    userId: tenant.uid,
    taskId: task.id,
    decision: 'approved',
  });

  let externalSideEffects = 0;
  const slowTransport: HttpTransportFn = async (req) => {
    externalSideEffects += 1;
    await new Promise((r) => setTimeout(r, 80));
    return {
      ok: true,
      status: 200,
      responseText: '{"dispatched":true}',
      destinationOrigin: new URL(req.url).origin,
    };
  };

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, idx) =>
      executeSingleTaskManaged({
        userId: tenant.uid,
        taskId: task.id,
        workerId: `race-worker-${idx + 1}`,
        httpTransport: slowTransport,
      })
    )
  );

  assert.equal(
    externalSideEffects,
    1,
    'External HTTP side effect must execute strictly once across 5 concurrent workers'
  );
  const executedWinners = results.filter((r) => r.executed);
  assert.equal(executedWinners.length, 1);
  assert.equal(executedWinners[0].outcomeCode, 'pending_verification');
});

test('AUDIT 1.2: Expired execution lock & zombie worker fencing prevents stale worker from overwriting active task state', async () => {
  const tenant = await createAuditTenant('d1_fence');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Prevent zombie worker state corruption.',
    targetMetric: '1 paying customer',
    status: 'active',
  });
  const task = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Fenced task',
    tool: 'internal_test_tool',
    requiredCapabilities: ['diagnostic_verification'],
    actionCategory: 'internal_test',
    dependencies: [],
    approvalRequired: false,
    proposedActionDetails: null,
    expectedResult: 'Checksum',
    verificationMethod: 'SHA-256',
  });

  // Simulate Worker A acquiring lock with short TTL, then expiring and Worker B stealing lock
  const lockA = await acquireExecutionLock({
    resourceKey: `task:${task.id}`,
    workspaceId: tenant.workspace.id,
    ownerWorkerId: 'zombie-worker-A',
    idempotencyKey: task.idempotencyKey,
    ttlMs: 1000,
    nowMs: 1_000_000,
  });
  assert.equal(lockA, true);

  const lockBBlockedBeforeExpiry = await acquireExecutionLock({
    resourceKey: `task:${task.id}`,
    workspaceId: tenant.workspace.id,
    ownerWorkerId: 'fresh-worker-B',
    idempotencyKey: task.idempotencyKey,
    ttlMs: 10_000,
    nowMs: 1_000_500,
  });
  assert.equal(lockBBlockedBeforeExpiry, false);

  const lockBStolenAfterExpiry = await acquireExecutionLock({
    resourceKey: `task:${task.id}`,
    workspaceId: tenant.workspace.id,
    ownerWorkerId: 'fresh-worker-B',
    idempotencyKey: task.idempotencyKey,
    ttlMs: 10_000,
    nowMs: 1_002_000, // Past Worker A's 1000ms TTL
  });
  assert.equal(lockBStolenAfterExpiry, true);

  // Set task row lockedBy = 'fresh-worker-B' (simulating active claim)
  await db
    .update(tasks)
    .set({ status: 'running', lockedBy: 'fresh-worker-B', lockedAt: new Date() })
    .where(inArray(tasks.id, [task.id]));

  // Zombie Worker A wakes up and attempts to mark task failed with expectedLockedBy='zombie-worker-A' -> FENCED (null)!
  const zombieWrite = await updateTaskAfterWorkerCheckOrRun({
    taskId: task.id,
    userId: tenant.uid,
    expectedLockedBy: 'zombie-worker-A',
    status: 'failed',
    statusReason: 'Zombie overwrite attempt',
  });
  assert.equal(zombieWrite, null, 'Stale worker write must be rejected by lock fencing');

  const intactTask = await getTaskByIdForUser(task.id, tenant.uid);
  assert.equal(intactTask?.status, 'running');
  assert.equal(intactTask?.lockedBy, 'fresh-worker-B');

  await releaseExecutionLock({
    resourceKey: `task:${task.id}`,
    ownerWorkerId: 'fresh-worker-B',
  });
});

test('AUDIT 1.3 & 1.4: External API timeout after successful side effect quarantines task in reconciliationRequired (blocks blind retry) OR auto-reconciles if callback arrived', async () => {
  resetRateLimiterForTests();
  const tenant = await createAuditTenant('d1_timeout');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Charge enterprise customer once without double-charging on timeout.',
    targetMetric: '1 paying customer',
    status: 'active',
  });

  const paymentSecret = 'prov_sec_d1_timeout_abcdef0123456789';
  const integration = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'payment_webhook',
    displayName: 'Stripe Charge Webhook',
    connectionMode: 'user_owned',
    capabilities: ['payment_verification', 'http_request'],
    configMetadata: {
      endpointUrl: 'https://payments.example.com/charge',
      authType: 'hmac_sha256',
    },
    plaintextSecret: paymentSecret,
  });
  await recordIntegrationTestOutcome({
    integrationId: integration.id,
    userId: tenant.uid,
    verified: true,
    statusDetail: 'Verified',
    testedAt: new Date(),
  });

  const taskA = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Execute payment link dispatch A (times out without immediate callback)',
    tool: 'payment_webhook',
    requiredCapabilities: ['payment_verification'],
    actionCategory: 'payment_collection',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'Create payment charge A',
      targetRecipient: 'Customer A',
      estimatedCost: '$0.00',
      explanation: 'Charges Customer A',
    },
    expectedResult: 'Paid invoice',
    verificationMethod: 'Signed payment_confirmed webhook',
    executionTimeoutMs: 50,
    maxRetries: 3,
  });
  await recordApprovalDecision({
    userId: tenant.uid,
    taskId: taskA.id,
    decision: 'approved',
  });

  // Simulate upstream executing side effect, then hanging past 50ms client timeout
  let callsA = 0;
  const timedOutRes = await executeSingleTaskManaged({
    userId: tenant.uid,
    taskId: taskA.id,
    httpTransport: async (req) => {
      callsA += 1;
      await new Promise((r) => setTimeout(r, 140));
      return {
        ok: true,
        status: 200,
        responseText: '{"charged":true}',
        destinationOrigin: new URL(req.url).origin,
      };
    },
  });

  assert.equal(callsA, 1);
  assert.equal(timedOutRes.executed, false);
  assert.equal(timedOutRes.outcomeCode, 'reconciliation_required');
  assert.equal(timedOutRes.task?.status, 'blocked');
  assert.equal(timedOutRes.task?.reconciliationRequired, true);
  assert.equal(
    timedOutRes.task?.nextRetryAt,
    null,
    'Uncertain external timeout must NEVER schedule an automatic retry'
  );

  // Blind manual retry MUST be blocked unless operator explicitly reconciles
  await assert.rejects(
    () => retryTaskManually({ userId: tenant.uid, taskId: taskA.id }),
    /Uncertain execution outcome/i
  );

  // Reconciling from evidence before evidence exists fails safely
  await assert.rejects(
    () =>
      reconcileUncertainTask({
        userId: tenant.uid,
        taskId: taskA.id,
        resolution: 'reconcile_from_evidence',
      }),
    /No correlated external outcome evidence/i
  );

  // Operator confirms dispatch occurred in upstream logs -> transitions to pending_verification with 0 extra HTTP calls
  const reconciledDispatched = await reconcileUncertainTask({
    userId: tenant.uid,
    taskId: taskA.id,
    resolution: 'mark_dispatched_pending_verification',
    notes: 'Confirmed charge_001 in Stripe dashboard logs',
  });
  assert.equal(reconciledDispatched.task.status, 'pending_verification');
  assert.equal(reconciledDispatched.task.reconciliationRequired, false);
  assert.equal(callsA, 1);

  // AUDIT 1.4: Task B times out on outbound HTTP response, BUT signed webhook callback arrived mid-flight -> auto-reconciles!
  const rotated = await rotateWorkspaceInboundWebhookSecret({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
  });
  const taskB = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Execute payment link dispatch B (webhook arrives before timeout handler)',
    tool: 'payment_webhook',
    requiredCapabilities: ['payment_verification'],
    actionCategory: 'payment_collection',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'Create payment charge B',
      targetRecipient: 'Customer B',
      estimatedCost: '$0.00',
      explanation: 'Charges Customer B',
    },
    expectedResult: 'Paid invoice',
    verificationMethod: 'Signed payment_confirmed webhook',
    executionTimeoutMs: 1200,
  });
  await recordApprovalDecision({
    userId: tenant.uid,
    taskId: taskB.id,
    decision: 'approved',
  });

  const autoReconciledRes = await executeSingleTaskManaged({
    userId: tenant.uid,
    taskId: taskB.id,
    httpTransport: async (req) => {
      // Simulate upstream firing signed webhook callback while HTTP response hangs past client timeout
      await ingestSignedInboundEvidence({
        workspaceId: tenant.workspace.id,
        ...signInboundCall({
          workspaceSecret: rotated.oneTimeSigningSecret,
          providerSecret: paymentSecret,
          payload: {
            provider: 'payment_webhook',
            externalEventId: 'evt_midflight_b_001',
            goalId: goal.id,
            taskId: taskB.id,
            evidenceType: 'customer_acquired',
            externalReferenceId: 'cus_midflight_b',
            summary: 'Mid-flight customer charge settled',
            structuredMetrics: { customers: 1, revenueUsd: 500 },
          },
        }),
      });
      await new Promise((r) => setTimeout(r, 1500));
      return {
        ok: true,
        status: 200,
        responseText: '{}',
        destinationOrigin: new URL(req.url).origin,
      };
    },
  });

  assert.equal(autoReconciledRes.executed, true);
  assert.equal(autoReconciledRes.outcomeCode, 'reconciled_from_evidence');
  assert.equal(autoReconciledRes.task?.status, 'verified');
  assert.equal(autoReconciledRes.task?.reconciliationRequired, false);
});

test('AUDIT 1.5 & 1.6: Worker crash / server restart recovery quarantines external running tasks; interrupted parallel wave & dependency failure isolate downstream tasks', async () => {
  resetRateLimiterForTests();
  const tenant = await createAuditTenant('d1_crash_wave');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Survive server restarts and partial parallel wave failures safely.',
    targetMetric: '2 paying customers',
    status: 'active',
  });

  const integration = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'custom_webhook',
    displayName: 'Parallel Wave Webhook',
    connectionMode: 'user_owned',
    capabilities: ['workflow_automation', 'http_request'],
    configMetadata: {
      endpointUrl: 'https://wave.example.com/hook',
      authType: 'bearer_token',
    },
    plaintextSecret: 'tok_wave_secret_998877',
  });
  await recordIntegrationTestOutcome({
    integrationId: integration.id,
    userId: tenant.uid,
    verified: true,
    statusDetail: 'Verified',
    testedAt: new Date(),
  });

  // Simulate a crashed external task stuck in `running` from 5 minutes ago (server restart mid-flight)
  const crashedExtTask = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'External webhook in-flight during server restart',
    tool: 'custom_webhook',
    requiredCapabilities: ['workflow_automation'],
    actionCategory: 'external_workflow',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'Run external workflow',
      targetRecipient: 'Webhook',
      estimatedCost: '$0',
      explanation: 'External call',
    },
    expectedResult: 'Receipt',
    verificationMethod: 'Webhook',
    executionTimeoutMs: 10_000,
  });
  await recordApprovalDecision({
    userId: tenant.uid,
    taskId: crashedExtTask.id,
    decision: 'approved',
  });
  const fiveMinAgo = new Date(Date.now() - 300_000);
  await db
    .update(tasks)
    .set({
      status: 'running',
      startedAt: fiveMinAgo,
      lockedAt: fiveMinAgo,
      lockedBy: 'crashed-server-worker',
    })
    .where(inArray(tasks.id, [crashedExtTask.id]));

  const recovered = await recoverStalledTasksForGoal({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    goalId: goal.id,
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, 'blocked');
  assert.equal(recovered[0].reconciliationRequired, true);
  assert.equal(recovered[0].nextRetryAt, null);

  // Now create parallel tasks: Step 2 (internal_test_tool -> succeeds), Step 3 (custom_webhook -> fails non-retryable HTTP 401), Step 4 (depends on Step 3 -> must NOT run)
  const step2Ok = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Parallel branch A (deterministic internal check)',
    tool: 'internal_test_tool',
    requiredCapabilities: ['diagnostic_verification'],
    actionCategory: 'internal_test',
    dependencies: [],
    approvalRequired: false,
    proposedActionDetails: null,
    expectedResult: 'Checksum',
    verificationMethod: 'SHA-256',
  });
  const step3Fail = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Parallel branch B (upstream returns fatal HTTP 401)',
    tool: 'custom_webhook',
    requiredCapabilities: ['workflow_automation'],
    actionCategory: 'external_workflow',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'Call webhook B',
      targetRecipient: 'Endpoint B',
      estimatedCost: '$0',
      explanation: 'External call',
    },
    expectedResult: 'Receipt',
    verificationMethod: 'Webhook',
    maxRetries: 3, // Even with maxRetries=3, HTTP 401 is non-retryable and must fail immediately
  });
  await recordApprovalDecision({
    userId: tenant.uid,
    taskId: step3Fail.id,
    decision: 'approved',
  });
  const step4Downstream = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Downstream step depending on failed branch B',
    tool: 'internal_test_tool',
    requiredCapabilities: ['diagnostic_verification'],
    actionCategory: 'internal_test',
    dependencies: [step3Fail.id],
    approvalRequired: false,
    proposedActionDetails: null,
    expectedResult: 'Downstream artifact',
    verificationMethod: 'SHA-256',
  });

  const wave = await runOrchestratorCycle({
    userId: tenant.uid,
    goalId: goal.id,
    concurrencyMode: 'parallel_safe',
    httpTransport: async (req) => ({
      ok: false,
      status: 401,
      responseText: 'Unauthorized invalid token',
      destinationOrigin: new URL(req.url).origin,
    }),
  });

  const t2After = wave.tasks.find((t) => t.id === step2Ok.id)!;
  const t3After = wave.tasks.find((t) => t.id === step3Fail.id)!;
  const t4After = wave.tasks.find((t) => t.id === step4Downstream.id)!;
  const crashedAfter = wave.tasks.find((t) => t.id === crashedExtTask.id)!;

  assert.equal(t2After.status, 'verified');
  assert.equal(
    t3After.status,
    'failed',
    'Non-retryable HTTP 401 must fail immediately without backoff retries'
  );
  assert.equal(t3After.nextRetryAt, null);
  assert.equal(
    t4After.status,
    'blocked',
    'Downstream task depending on failed upstream step must transition to blocked and never execute'
  );
  assert.equal(
    crashedAfter.reconciliationRequired,
    true,
    'Crashed external task must remain quarantined during subsequent wave runs'
  );
});

// ============================================================================
// DIMENSION 2: EVIDENCE TRUST ARCHITECTURE AUDIT
// ============================================================================

test('AUDIT 2.1: Evidence Trust Architecture enforces 6 provenance classes, denies workspace-HMAC-only auto-verification, and isolates internal SHA-256 diagnostics', async () => {
  const tenant = await createAuditTenant('d2_trust');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Acquire 1 verified paying customer ($500 USD).',
    targetMetric: '1 paying customer',
    status: 'active',
  });

  // 1. Internal SHA-256 diagnostic execution -> provenanceClass='internal_diagnostic', trustTier='diagnostic_only'
  const diagTask = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Run internal SHA-256 diagnostic check',
    tool: 'internal_test_tool',
    requiredCapabilities: ['diagnostic_verification'],
    actionCategory: 'internal_test',
    dependencies: [],
    approvalRequired: false,
    proposedActionDetails: null,
    expectedResult: 'SHA-256 checksum',
    verificationMethod: 'SHA-256',
  });
  await executeSingleTaskManaged({ userId: tenant.uid, taskId: diagTask.id });

  const snapshotAfterDiag = await getExecutionMonitorSnapshot({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    tools: buildWorkspaceToolRegistry([]),
  });
  assert.equal(
    snapshotAfterDiag.counts.verifiedOutcomes,
    0,
    'Internal SHA-256 diagnostic verification must NEVER inflate verified business outcomes count'
  );
  assert.equal(snapshotAfterDiag.evidence[0].evidenceType, 'diagnostic_checksum');
  assert.equal(snapshotAfterDiag.evidence[0].provenanceClass, 'internal_diagnostic');
  assert.equal(snapshotAfterDiag.evidence[0].trustTier, 'diagnostic_only');

  // 2. Valid workspace HMAC signature ALONE (no verified provider integration) -> stays authenticated_webhook (pending_verification, 0% progress)
  const rotated = await rotateWorkspaceInboundWebhookSecret({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
  });
  const hmacOnlyRes = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...signInboundCall({
      workspaceSecret: rotated.oneTimeSigningSecret,
      payload: {
        provider: 'payment_webhook',
        externalEventId: 'evt_hmac_only_claim',
        goalId: goal.id,
        evidenceType: 'customer_acquired',
        externalReferenceId: 'cus_uncorroborated_01',
        summary: 'Self-signed webhook claiming customer acquired without connected provider',
        structuredMetrics: { customers: 1, revenueUsd: 500 },
      },
    }),
  });
  assert.equal(hmacOnlyRes.httpStatus, 200);
  const hmacOnlyEv = hmacOnlyRes.body.evidence as {
    id: string;
    provenanceClass: string;
    trustTier: string;
    verificationState: string;
  };
  assert.equal(hmacOnlyEv.provenanceClass, 'authenticated_webhook');
  assert.equal(hmacOnlyEv.trustTier, 'transport_authenticated');
  assert.equal(hmacOnlyEv.verificationState, 'pending_verification');
  assert.equal(
    (hmacOnlyRes.body.goalProgress as { progressPercent: number }).progressPercent,
    0,
    'Valid workspace HMAC signature alone must NEVER auto-verify a business outcome'
  );

  // 3. Connect & verify payment_webhook, then test synthetic reference (`ref_demo_001`), `livemode: false`, and domain mismatch (`gmail_api` claiming `payment_confirmed`)
  const paymentSecret = 'prov_sec_d2_payment_0123456789abcdef';
  const paymentInt = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'payment_webhook',
    displayName: 'Verified Payment Adapter',
    connectionMode: 'user_owned',
    capabilities: ['payment_verification', 'http_request'],
    configMetadata: {
      endpointUrl: 'https://pay.example.com/webhook',
      authType: 'hmac_sha256',
    },
    plaintextSecret: paymentSecret,
  });
  await recordIntegrationTestOutcome({
    integrationId: paymentInt.id,
    userId: tenant.uid,
    verified: true,
    statusDetail: 'Verified',
    testedAt: new Date(),
  });

  // 3a. Synthetic/demo reference rejected from auto-verification even with valid provider signature
  const demoRefRes = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...signInboundCall({
      workspaceSecret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: {
        provider: 'payment_webhook',
        externalEventId: 'evt_demo_ref_01',
        goalId: goal.id,
        evidenceType: 'customer_acquired',
        externalReferenceId: 'ref_demo_001',
        summary: 'Synthetic test reference',
        structuredMetrics: { customers: 1 },
      },
    }),
  });
  assert.equal(
    (demoRefRes.body.evidence as { verificationState: string }).verificationState,
    'pending_verification'
  );

  // 3b. Sandbox `livemode: false` payload held in pending_verification
  const testModeRes = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...signInboundCall({
      workspaceSecret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: {
        provider: 'payment_webhook',
        externalEventId: 'evt_sandbox_mode_01',
        goalId: goal.id,
        evidenceType: 'customer_acquired',
        externalReferenceId: 'cus_real_looking_99',
        livemode: false,
        summary: 'Stripe test-mode webhook',
        structuredMetrics: { customers: 1 },
      },
    }),
  });
  assert.equal(
    (testModeRes.body.evidence as { verificationState: string }).verificationState,
    'pending_verification'
  );

  // 3c. Domain mismatch (`gmail_api` claiming `payment_confirmed`) held in pending_verification
  const mismatchRes = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...signInboundCall({
      workspaceSecret: rotated.oneTimeSigningSecret,
      payload: {
        provider: 'gmail_api',
        externalEventId: 'evt_domain_mismatch_01',
        goalId: goal.id,
        evidenceType: 'payment_confirmed',
        externalReferenceId: 'msg_claiming_payment_01',
        summary: 'Email adapter claiming settled payment',
        structuredMetrics: { revenueUsd: 500 },
      },
    }),
  });
  assert.equal(
    (mismatchRes.body.evidence as { verificationState: string }).verificationState,
    'pending_verification'
  );

  // 4. AI Consistency Check -> transitions provenance to `ai_assessed` (`advisory`), still `pending_verification`
  await runAiAssistedVerificationOnEvidence({
    userId: tenant.uid,
    evidenceId: hmacOnlyEv.id,
  });
  const afterAi = (
    await listOutcomeEvidenceByWorkspace({
      userId: tenant.uid,
      workspaceId: tenant.workspace.id,
      goalId: goal.id,
    })
  ).find((e) => e.id === hmacOnlyEv.id)!;
  assert.equal(afterAi.provenanceClass, 'ai_assessed');
  assert.equal(afterAi.trustTier, 'advisory');
  assert.equal(afterAi.verificationState, 'pending_verification');

  // 5. Human review with audit notes -> transitions provenance to `human_confirmed` (`human_verified`, `verified`)
  const afterHuman = await reviewOutcomeEvidenceByHuman({
    userId: tenant.uid,
    evidenceId: hmacOnlyEv.id,
    reviewerEmail: tenant.email,
    decision: 'verified',
    notes: 'Verified settled bank deposit #8812 manually',
  });
  assert.equal(afterHuman.evidence.provenanceClass, 'human_confirmed');
  assert.equal(afterHuman.evidence.trustTier, 'human_verified');
  assert.equal(afterHuman.evidence.verificationState, 'verified');
  assert.equal(afterHuman.goalProgress.progressPercent, 100);
});

// ============================================================================
// DIMENSION 3: PROVIDER INTEGRATION AUDIT (ALL 10 PROVIDERS)
// ============================================================================

test('AUDIT 3.1: All 10 providers carry truthful integrationClassification, Gmail capability routing works, and outbound rate limiting enforces burst limits', async () => {
  resetRateLimiterForTests();
  assert.equal(PROVIDER_DESCRIPTORS.length, 10);

  const items = buildProviderRegistryItems({
    geminiReady: true,
    workspaceIntegrations: [],
  });

  const byId = new Map(items.map((i) => [i.id, i]));

  // Native runtimes (2)
  assert.equal(byId.get('llm_reasoning')?.integrationClassification, 'native_implemented');
  assert.equal(byId.get('internal_test_tool')?.integrationClassification, 'native_implemented');

  // Generic HTTPS webhook adapters (6) — honest classification (no false native Make/Zapier SDK claim)
  for (const key of [
    'custom_webhook',
    'n8n_webhook',
    'make_webhook',
    'zapier_webhook',
    'crm_webhook',
    'payment_webhook',
  ] as const) {
    assert.equal(
      byId.get(key)?.integrationClassification,
      'generic_webhook_adapter',
      `Expected ${key} to be classified as generic_webhook_adapter`
    );
  }

  // Partially implemented HTTPS relay bridges (2) — honest non-native OAuth disclosure
  for (const key of ['gmail_api', 'google_calendar_api'] as const) {
    const item = byId.get(key)!;
    assert.equal(item.integrationClassification, 'partially_implemented');
    assert.equal(item.executionInterface, 'https_json_webhook');
    assert.match(item.description, /does NOT implement Google OAuth/i);
  }

  // Verify fixed gmail_api defaultCapabilitiesForTask ('message_dispatch', NOT 'workflow_automation')
  const gmailCaps = defaultCapabilitiesForTask('gmail_api', 'message_send');
  assert.deepEqual(gmailCaps, ['message_dispatch']);
  const gmailRoute = resolveExecutionRoute({
    task: { tool: 'gmail_api', requiredCapabilities: gmailCaps },
    builtInProviders: { llmReasoningReady: true, internalTestReady: true },
    userIntegrations: [
      {
        id: 'int-gmail-1',
        providerKey: 'gmail_api',
        displayName: 'Gmail HTTPS Relay',
        capabilities: ['message_dispatch', 'http_request'],
        enabled: true,
        verified: true,
        connectionMode: 'user_owned',
      },
    ],
  });
  assert.equal(gmailRoute.routable, true);

  // Verify outbound provider rate limiting (`gmail_api` burstLimit = 10)
  const tenant = await createAuditTenant('d3_ratelimit');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Test outbound provider rate limit enforcement.',
    targetMetric: '5 replies',
    status: 'active',
  });
  const gmailInt = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'gmail_api',
    displayName: 'Rate-Limited Gmail Relay',
    connectionMode: 'user_owned',
    capabilities: ['message_dispatch', 'http_request'],
    configMetadata: {
      endpointUrl: 'https://relay.example.com/send',
      authType: 'bearer_token',
    },
    plaintextSecret: 'tok_gmail_rl_secret_123456',
  });
  await recordIntegrationTestOutcome({
    integrationId: gmailInt.id,
    userId: tenant.uid,
    verified: true,
    statusDetail: 'Verified',
    testedAt: new Date(),
  });
  const task = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Send email via relay',
    tool: 'gmail_api',
    requiredCapabilities: ['message_dispatch'],
    actionCategory: 'message_send',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'Send email',
      targetRecipient: 'lead@example.com',
      estimatedCost: '$0',
      explanation: 'Relay dispatch',
    },
    expectedResult: 'Reply',
    verificationMethod: 'Webhook',
  });

  const resolvedGmailRoute = resolveExecutionRoute({
    task: { tool: 'gmail_api', requiredCapabilities: ['message_dispatch'] },
    builtInProviders: { llmReasoningReady: true, internalTestReady: true },
    userIntegrations: [
      {
        id: gmailInt.id,
        providerKey: 'gmail_api',
        displayName: gmailInt.displayName,
        capabilities: gmailInt.capabilities,
        enabled: true,
        verified: true,
        connectionMode: 'user_owned',
      },
    ],
  });
  assert.equal(resolvedGmailRoute.routable, true);
  if (!resolvedGmailRoute.routable) {
    throw new Error('Expected gmail_api route to resolve');
  }

  // Exhaust burstLimit=5 on `gmail_api`, then assert 6th immediate call throws RateLimitExceededError
  for (let i = 0; i < 5; i++) {
    await executeRoutedTask({
      userId: tenant.uid,
      problem: goal.problem,
      targetMetric: goal.targetMetric,
      task,
      route: resolvedGmailRoute,
      prerequisiteOutputs: [],
      httpTransport: async (req) => ({
        ok: true,
        status: 200,
        responseText: '{"sent":true}',
        destinationOrigin: new URL(req.url).origin,
      }),
    });
  }

  await assert.rejects(
    () =>
      executeRoutedTask({
        userId: tenant.uid,
        problem: goal.problem,
        targetMetric: goal.targetMetric,
        task,
        route: resolvedGmailRoute,
        prerequisiteOutputs: [],
        httpTransport: async (req) => ({
          ok: true,
          status: 200,
          responseText: '{"sent":true}',
          destinationOrigin: new URL(req.url).origin,
        }),
      }),
    (err: unknown) => err instanceof RateLimitExceededError
  );
});

// ============================================================================
// DIMENSION 4: GOAL METRIC ACCURACY STRESS TESTS
// ============================================================================

test('AUDIT 4.1: Compound multi-metric goals, NGN/USD/EUR/GBP currency isolation, reference deduplication, conflict quarantine, negative reversals, overshooting, and unquantified targets', async () => {
  resetRateLimiterForTests();
  const tenant = await createAuditTenant('d4_metrics');

  // 1. Compound multi-metric parsing & overshooting protection
  const compoundDefs = parseGoalTargetMetrics(
    'Acquire 2 paying customers and generate $1,000 USD revenue and book 3 discovery meetings'
  );
  const primaryDefs = compoundDefs.filter((d) => d.isPrimaryTarget);
  assert.equal(primaryDefs.length, 3);

  const compoundProgress = computeGoalMetricsAndProgress({
    goal: {
      id: 'g-compound',
      targetMetric:
        'Acquire 2 paying customers and generate $1,000 USD revenue and book 3 discovery meetings',
    },
    tasks: [],
    attempts: [],
    evidence: [
      {
        id: 'ev-overshoot-cust',
        userId: tenant.uid,
        workspaceId: tenant.workspace.id,
        goalId: 'g-compound',
        taskId: null,
        inboundEventId: null,
        sourceType: 'inbound_webhook',
        provider: 'payment_webhook',
        evidenceType: 'customer_acquired',
        externalReferenceId: 'cus_batch_4',
        summary: '4 customers acquired, $500 USD revenue, 0 meetings',
        structuredMetrics: { customers: 4, revenueUsd: 500 },
        sanitizedPayload: {},
        requiresHumanReview: false,
        verificationState: 'verified',
        provenanceClass: 'provider_confirmed',
        trustTier: 'provider_verified',
        hasConflict: false,
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ],
  });
  // Customers: min(1, 4/2)=1.0, Revenue: 500/1000=0.5, Meetings: 0/3=0.0 -> avg = 50%, NOT achieved!
  assert.equal(compoundProgress.progressPercent, 50);
  assert.equal(compoundProgress.isGoalAchieved, false);

  // 2. Strict NGN / USD / EUR / GBP currency isolation
  for (const [spec, expectedUnit, expectedVal] of [
    ['₦2,500,000 NGN revenue', 'NGN', 2_500_000],
    ['$1,200 USD sales', 'USD', 1_200],
    ['€800 EUR revenue', 'EUR', 800],
    ['£650 GBP subscriptions', 'GBP', 650],
  ] as const) {
    const parsed = parseGoalTargetMetrics(spec);
    assert.equal(parsed[0].unit, expectedUnit);
    assert.equal(parsed[0].targetValue, expectedVal);
  }

  const usdCurrencyCheck = computeGoalMetricsAndProgress({
    goal: { id: 'g-usd', targetMetric: 'Generate $500 USD revenue' },
    tasks: [],
    attempts: [],
    evidence: [
      {
        id: 'ev-ngn',
        userId: tenant.uid,
        workspaceId: tenant.workspace.id,
        goalId: 'g-usd',
        taskId: null,
        inboundEventId: null,
        sourceType: 'inbound_webhook',
        provider: 'payment_webhook',
        evidenceType: 'payment_confirmed',
        externalReferenceId: 'paystack_ngn_500k',
        summary: 'Settled 500,000 NGN charge',
        structuredMetrics: { amount: 500_000, currency: 'NGN' },
        sanitizedPayload: {},
        requiresHumanReview: false,
        verificationState: 'verified',
        provenanceClass: 'provider_confirmed',
        trustTier: 'provider_verified',
        hasConflict: false,
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        id: 'ev-eur',
        userId: tenant.uid,
        workspaceId: tenant.workspace.id,
        goalId: 'g-usd',
        taskId: null,
        inboundEventId: null,
        sourceType: 'inbound_webhook',
        provider: 'payment_webhook',
        evidenceType: 'payment_confirmed',
        externalReferenceId: 'sepa_eur_500',
        summary: 'Settled 500 EUR charge',
        structuredMetrics: { amountEur: 500 },
        sanitizedPayload: {},
        requiresHumanReview: false,
        verificationState: 'verified',
        provenanceClass: 'provider_confirmed',
        trustTier: 'provider_verified',
        hasConflict: false,
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        id: 'ev-gbp',
        userId: tenant.uid,
        workspaceId: tenant.workspace.id,
        goalId: 'g-usd',
        taskId: null,
        inboundEventId: null,
        sourceType: 'inbound_webhook',
        provider: 'payment_webhook',
        evidenceType: 'payment_confirmed',
        externalReferenceId: 'bacs_gbp_500',
        summary: 'Settled 500 GBP charge',
        structuredMetrics: { amountGbp: 500 },
        sanitizedPayload: {},
        requiresHumanReview: false,
        verificationState: 'verified',
        provenanceClass: 'provider_confirmed',
        trustTier: 'provider_verified',
        hasConflict: false,
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ],
  });
  assert.equal(
    usdCurrencyCheck.progressPercent,
    0,
    'NGN, EUR, and GBP payments must NEVER silently add into a USD revenue target without explicit conversion'
  );

  // 3. Ambiguous / missing target value never auto-achieves
  const ambiguousProgress = computeGoalMetricsAndProgress({
    goal: {
      id: 'g-ambig',
      targetMetric: 'Become the leading AI workflow brand in EMEA',
    },
    tasks: [],
    attempts: [],
    evidence: [
      {
        id: 'ev-ambig-1',
        userId: tenant.uid,
        workspaceId: tenant.workspace.id,
        goalId: 'g-ambig',
        taskId: null,
        inboundEventId: null,
        sourceType: 'inbound_webhook',
        provider: 'payment_webhook',
        evidenceType: 'customer_acquired',
        externalReferenceId: 'cus_emea_1',
        summary: '1 EMEA customer',
        structuredMetrics: { customers: 1 },
        sanitizedPayload: {},
        requiresHumanReview: false,
        verificationState: 'verified',
        provenanceClass: 'provider_confirmed',
        trustTier: 'provider_verified',
        hasConflict: false,
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ],
  });
  assert.equal(ambiguousProgress.progressPercent, 0);
  assert.equal(ambiguousProgress.isGoalAchieved, false);

  // 4. End-to-end DB test: externalReferenceId deduplication across distinct event IDs, negative refund reversal reverting completed goal, and conflicting evidence quarantine
  const revGoal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Generate $1,000 USD net settled subscription revenue.',
    targetMetric: '$1,000 USD revenue',
    status: 'active',
  });
  const paymentSecret = 'prov_sec_d4_rev_abcdef0123456789';
  const payInt = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'payment_webhook',
    displayName: 'Stripe Live Adapter',
    connectionMode: 'user_owned',
    capabilities: ['payment_verification', 'http_request'],
    configMetadata: {
      endpointUrl: 'https://stripe-bridge.example.com/hook',
      authType: 'hmac_sha256',
    },
    plaintextSecret: paymentSecret,
  });
  await recordIntegrationTestOutcome({
    integrationId: payInt.id,
    userId: tenant.uid,
    verified: true,
    statusDetail: 'Verified',
    testedAt: new Date(),
  });
  const rotated = await rotateWorkspaceInboundWebhookSecret({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
  });

  // 4a. Same charge `ch_live_1000` delivered under TWO different externalEventIds (`evt_a` and `evt_b`) with same $600 -> counted ONCE ($600 = 60%, NOT $1,200)!
  await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...signInboundCall({
      workspaceSecret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: {
        provider: 'payment_webhook',
        externalEventId: 'evt_same_ref_a',
        goalId: revGoal.id,
        evidenceType: 'payment_confirmed',
        externalReferenceId: 'ch_live_600_dup',
        summary: 'Charge settled $600 (webhook delivery 1)',
        structuredMetrics: { amountUsd: 600 },
      },
    }),
  });
  await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...signInboundCall({
      workspaceSecret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: {
        provider: 'payment_webhook',
        externalEventId: 'evt_same_ref_b',
        goalId: revGoal.id,
        evidenceType: 'payment_confirmed',
        externalReferenceId: 'ch_live_600_dup',
        summary: 'Charge settled $600 (provider retry under new event ID)',
        structuredMetrics: { amountUsd: 600 },
      },
    }),
  });
  const afterDupRef = await getGoalByIdForUser(revGoal.id, tenant.uid);
  assert.equal(afterDupRef?.progressPercent, 60);
  assert.equal(afterDupRef?.status, 'active');

  // 4b. Second distinct charge `$400` brings net verified revenue to `$1,000` (100% -> `completed`)
  await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...signInboundCall({
      workspaceSecret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: {
        provider: 'payment_webhook',
        externalEventId: 'evt_distinct_400',
        goalId: revGoal.id,
        evidenceType: 'payment_confirmed',
        externalReferenceId: 'ch_live_400_ok',
        summary: 'Second charge settled $400',
        structuredMetrics: { amountUsd: 400 },
      },
    }),
  });
  const afterComplete = await getGoalByIdForUser(revGoal.id, tenant.uid);
  assert.equal(afterComplete?.progressPercent, 100);
  assert.equal(afterComplete?.status, 'completed');

  // 4c. Refund / chargeback (`outcome_reversal` of $300) drops net verified revenue to $700 (70%) and REVERTS goal back to `active`!
  await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...signInboundCall({
      workspaceSecret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: {
        provider: 'payment_webhook',
        externalEventId: 'evt_refund_300',
        goalId: revGoal.id,
        evidenceType: 'outcome_reversal',
        externalReferenceId: 're_live_300',
        summary: 'Partial refund $300 issued',
        structuredMetrics: { refundAmountUsd: 300 },
      },
    }),
  });
  const afterRefund = await getGoalByIdForUser(revGoal.id, tenant.uid);
  assert.equal(afterRefund?.progressPercent, 70);
  assert.equal(
    afterRefund?.status,
    'active',
    'Goal status must revert from completed to active when a verified refund drops net progress below target'
  );
  assert.equal(afterRefund?.achievedAt, null);

  // 4d. Conflicting evidence on `ch_live_400_ok` (second event claims `$50` instead of `$400`) quarantines both records!
  await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...signInboundCall({
      workspaceSecret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: {
        provider: 'payment_webhook',
        externalEventId: 'evt_conflict_on_400',
        goalId: revGoal.id,
        evidenceType: 'payment_confirmed',
        externalReferenceId: 'ch_live_400_ok',
        summary: 'Contradictory settlement report $50 for ch_live_400_ok',
        structuredMetrics: { amountUsd: 50 },
      },
    }),
  });
  const afterConflict = await getGoalByIdForUser(revGoal.id, tenant.uid);
  // $600 valid - $300 refund = $300 (30%), because conflicting `ch_live_400_ok` is quarantined!
  assert.equal(afterConflict?.progressPercent, 30);
});

// ============================================================================
// DIMENSION 6: SECURITY AUDIT STRESS TESTS
// ============================================================================

test('AUDIT 6.1: Same-user cross-workspace integration/dependency isolation, SSRF trailing-dot & DNS-rebind protection, iso token expiry, concurrent proposal race, and rate-limit middleware', async () => {
  resetRateLimiterForTests();
  const tenant = await createAuditTenant('d6_sec');
  const wsAlpha = tenant.workspace;
  const wsBeta = await createWorkspaceForUser({
    userId: tenant.uid,
    name: 'Workspace Beta Isolated',
  });

  // Connect integration in Workspace Beta
  const betaInt = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: wsBeta.id,
    providerKey: 'custom_webhook',
    displayName: 'Beta Secret Webhook',
    connectionMode: 'user_owned',
    capabilities: ['workflow_automation'],
    configMetadata: {
      endpointUrl: 'https://beta-only.example.com/hook',
      authType: 'bearer_token',
    },
    plaintextSecret: 'beta_workspace_secret_token_999999',
  });

  // 1. Workspace Alpha CANNOT fetch or bind Workspace Beta's integration ID even for the same user!
  const crossLookup = await getExecutableIntegrationForServer(
    betaInt.id,
    tenant.uid,
    wsAlpha.id
  );
  assert.equal(crossLookup, null);

  const goalAlpha = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: wsAlpha.id,
    problem: 'Workspace Alpha goal',
    targetMetric: '2 customers',
    status: 'active',
  });
  const goalBeta = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: wsBeta.id,
    problem: 'Workspace Beta goal',
    targetMetric: '2 customers',
    status: 'active',
  });
  const betaTask = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goalBeta.id,
    description: 'Beta step 1',
    tool: 'internal_test_tool',
    requiredCapabilities: ['diagnostic_verification'],
    actionCategory: 'internal_test',
    dependencies: [],
    approvalRequired: false,
    proposedActionDetails: null,
    expectedResult: 'OK',
    verificationMethod: 'SHA-256',
  });

  await assert.rejects(
    () =>
      createSingleTaskForGoal({
        userId: tenant.uid,
        goalId: goalAlpha.id,
        description: 'Attempt cross-workspace integration binding',
        tool: 'custom_webhook',
        requiredCapabilities: ['workflow_automation'],
        assignedIntegrationId: betaInt.id,
        actionCategory: 'external_workflow',
        dependencies: [],
        approvalRequired: true,
        proposedActionDetails: null,
        expectedResult: 'Blocked',
        verificationMethod: 'Webhook',
      }),
    /does not belong to this workspace/i
  );

  // 2. Cross-goal dependency injection rejected
  await assert.rejects(
    () =>
      createSingleTaskForGoal({
        userId: tenant.uid,
        goalId: goalAlpha.id,
        description: 'Attempt cross-goal dependency reference',
        tool: 'internal_test_tool',
        requiredCapabilities: ['diagnostic_verification'],
        actionCategory: 'internal_test',
        dependencies: [betaTask.id],
        approvalRequired: false,
        proposedActionDetails: null,
        expectedResult: 'Blocked',
        verificationMethod: 'SHA-256',
      }),
    /Invalid (task )?dependency/i
  );

  // 3. SSRF trailing-dot bypass, nip.io/sslip.io wildcard DNS rebinding, and IPv6 transition ranges blocked
  assert.equal(
    validateDestinationUrlSync('https://metadata.google.internal./computeMetadata/v1').valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://localhost./webhook').valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://169.254.169.254.nip.io/latest/meta-data').valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://10.0.0.1.sslip.io/internal').valid,
    false
  );
  assert.equal(isPrivateOrReservedIp('64:ff9b::a9fe:a9fe'), true); // NAT64 cloud metadata
  assert.equal(isPrivateOrReservedIp('2002:7f00:0001::1'), true); // 6to4 loopback
  assert.equal(isPrivateOrReservedIp('2001:0000:4136:e378:8000:63bf:3fff:fdd2'), true); // Teredo
  assert.equal(isPrivateOrReservedIp('192.0.2.10'), true); // TEST-NET-1

  // 4. Isolated session token (`iso.*`) expiration enforcement
  const testEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: crypto.randomBytes(32).toString('hex'),
    INTEGRATION_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  };
  const baseMs = 1_760_000_000_000;
  const isoToken = createSignedIsolatedToken(
    'iso_0123456789abcdef',
    'iso@isolated.task.ai',
    testEnv,
    undefined,
    baseMs,
    60_000
  );
  assert.ok(verifySignedIsolatedToken(isoToken, testEnv, undefined, baseMs + 30_000));
  assert.equal(
    verifySignedIsolatedToken(isoToken, testEnv, undefined, baseMs + 60_001),
    null,
    'Expired iso.* session token must be rejected'
  );

  // 5. Concurrent `decideNextActionProposal` race -> strictly 1 winner enqueues 1 task
  const savedCycle = await saveReasoningCycleWithProposals({
    userId: tenant.uid,
    workspaceId: wsAlpha.id,
    goalId: goalAlpha.id,
    triggerSource: 'manual',
    modelUsed: 'gemini-3.8-flash',
    currentAssessment: 'Need ICP analysis',
    goalAchievedRecommendation: false,
    humanInterventionRequired: false,
    confidenceLevel: 'medium',
    reasoningSummary: 'Propose 1 diagnostic analysis task',
    findings: ['0/2 customers'],
    recommendedNextActions: ['Run ICP analysis'],
    structuredOutput: {},
    proposals: [
      {
        proposalType: 'new_task',
        title: 'Run ICP segmentation',
        description: 'Segment top 20 B2B prospects',
        proposedTool: 'llm_reasoning',
        actionCategory: 'analysis',
        requiredCapabilities: ['ai_reasoning'],
        dependencies: [],
        targetTaskId: null,
        approvalRequired: false,
        expectedOutcome: 'Segmented list',
        verificationMethod: 'JSON output',
      },
    ],
  });
  const targetPropId = savedCycle.proposals[0].id;
  const raceOutcomes = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      decideNextActionProposal({
        userId: tenant.uid,
        proposalId: targetPropId,
        decision: 'accept',
      })
    )
  );
  const fulfilled = raceOutcomes.filter((r) => r.status === 'fulfilled');
  const rejected = raceOutcomes.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'Strictly one concurrent caller may accept and enqueue a proposal');
  assert.equal(rejected.length, 4);

  const alphaTasks = await listTasksByUser(tenant.uid, goalAlpha.id, wsAlpha.id);
  assert.equal(alphaTasks.length, 1);

  // 6. Express rate-limit middleware returns HTTP 429 + Retry-After header when burst is exceeded
  const mw = createExpressRateLimitMiddleware({
    namespace: 'audit_http_burst',
    requestsPerMinute: 12,
    burstLimit: 3,
    keyExtractor: () => 'ip:203.0.113.55',
  });
  let statusCaptured = 200;
  let retryAfterHeader = '';
  let nextCalledCount = 0;

  for (let i = 0; i < 4; i++) {
    const reqMock = { ip: '203.0.113.55', headers: {} } as unknown as Request;
    const resMock = {
      setHeader: (k: string, v: string) => {
        if (k.toLowerCase() === 'retry-after') retryAfterHeader = v;
      },
      status: (code: number) => {
        statusCaptured = code;
        return { json: () => resMock };
      },
    } as unknown as Response;
    const nextMock: NextFunction = () => {
      nextCalledCount += 1;
    };
    mw(reqMock, resMock, nextMock);
  }

  assert.equal(nextCalledCount, 3);
  assert.equal(statusCaptured, 429);
  assert.ok(Number(retryAfterHeader) >= 1);

  // 7. ResultsReport accuracy & secret non-leakage check
  const [allGoals, allLogs, allInts] = await Promise.all([
    listGoalsByUser(tenant.uid, wsBeta.id),
    listActionLogsByUser(tenant.uid, undefined, wsBeta.id),
    listIntegrationsByUser(tenant.uid, wsBeta.id),
  ]);
  const serialized = JSON.stringify({ allGoals, allLogs, allInts });
  assert.equal(
    serialized.includes('beta_workspace_secret_token_999999'),
    false,
    'Plaintext integration secret must never appear in repository responses or action logs'
  );

  const report = computeResultsReport({
    goals: allGoals,
    tasks: [betaTask],
    actionLogs: allLogs,
    tools: buildWorkspaceToolRegistry(allInts),
  });
  assert.equal(report.goalComparisons[0].verifiedOutcomesCount, 0);
});
