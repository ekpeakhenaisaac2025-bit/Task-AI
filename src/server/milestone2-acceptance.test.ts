import 'dotenv/config';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inArray, like } from 'drizzle-orm';
import { createPool, db } from '../db/index.ts';
import { actionLogs, goals, tasks, users, workspaces } from '../db/schema.ts';
import { getOrCreateUser } from '../db/users.ts';
import {
  createGoalForUser,
  createSingleTaskForGoal,
  createUserIntegration,
  ensureDefaultWorkspaceForUser,
  getGoalByIdForUser,
  getTaskByIdForUser,
  listIntegrationsByUser,
  listTasksByUser,
  recordApprovalDecision,
  recordIntegrationTestOutcome,
  savePlannedTasksForGoal,
} from '../db/repository.ts';
import {
  getExecutionMonitorSnapshot,
  getOutcomeEvidenceByIdForUser,
  listOutcomeEvidenceByWorkspace,
  listTaskAttemptsByWorkspace,
  listVerificationRecordsByWorkspace,
  recalculateAndPersistGoalProgress,
  rotateWorkspaceInboundWebhookSecret,
} from '../db/milestone2-repository.ts';
import {
  controlGoalExecution,
  decideNextActionProposal,
  executeSingleTaskManaged,
  ingestSignedInboundEvidence,
  retryTaskManually,
  reviewOutcomeEvidenceByHuman,
  runAiAssistedVerificationOnEvidence,
  runContinuousReasoningForGoal,
  runOrchestratorCycle,
  submitManualWorkspaceEvidence,
} from './orchestrator.ts';
import { buildWorkspaceToolRegistry } from './execution-router.ts';
import { computeInboundWebhookSignature } from '../lib/verification-engine.ts';
import { validateAndNormalizePlan } from '../lib/domain-rules.ts';
import type { safeOutboundPostJson } from './ssrf-guard.ts';

type HttpTransportFn = typeof safeOutboundPostJson;

const testUserUids: string[] = [];

async function cleanupTestUsers(uids: string[]) {
  if (uids.length === 0) return;
  await db.delete(actionLogs).where(inArray(actionLogs.userId, uids));
  await db.delete(tasks).where(inArray(tasks.userId, uids));
  await db.delete(goals).where(inArray(goals.userId, uids));
  await db.delete(workspaces).where(inArray(workspaces.ownerUserId, uids));
  await db.delete(users).where(inArray(users.uid, uids));
}

async function createIsolatedTestTenant(label: string) {
  const uid = `m2_test_${label}_${crypto.randomUUID().slice(0, 8)}`;
  const email = `${uid}@taskai-acceptance.local`;
  testUserUids.push(uid);
  await getOrCreateUser(uid, email);
  const workspace = await ensureDefaultWorkspaceForUser(uid);
  return { uid, email, workspace };
}

function buildSignedWebhookCall(params: {
  secret: string;
  providerSecret?: string;
  payload: Record<string, unknown>;
  timestampSec?: number;
}) {
  const ts = params.timestampSec ?? Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify(params.payload);
  const signatureHeader = computeInboundWebhookSignature(
    params.secret,
    ts,
    rawBody
  );
  const providerSignatureHeader = params.providerSecret
    ? computeInboundWebhookSignature(params.providerSecret, ts, rawBody)
    : undefined;
  return {
    rawBody,
    parsedBody: params.payload,
    signatureHeader,
    providerSignatureHeader,
    timestampHeader: String(ts),
  };
}

async function connectVerifiedProviderForTest(params: {
  uid: string;
  workspaceId: string;
  providerKey: 'payment_webhook' | 'google_calendar_api' | 'custom_webhook';
  providerSecret: string;
}) {
  const integration = await createUserIntegration({
    userId: params.uid,
    workspaceId: params.workspaceId,
    providerKey: params.providerKey,
    displayName: `Verified ${params.providerKey} Adapter`,
    connectionMode: 'user_owned',
    capabilities: [
      'payment_verification',
      'calendar_booking',
      'workflow_automation',
      'http_request',
    ],
    configMetadata: {
      endpointUrl: `https://hooks.example.com/${params.providerKey}`,
      authType: 'hmac_sha256',
    },
    plaintextSecret: params.providerSecret,
  });
  await recordIntegrationTestOutcome({
    integrationId: integration.id,
    userId: params.uid,
    verified: true,
    statusDetail: 'Verified in acceptance test',
    testedAt: new Date(),
  });
  return integration;
}

test.before(async () => {
  // Clean up any leftover m2_test_% users from aborted runs
  const stale = await db
    .select({ uid: users.uid })
    .from(users)
    .where(like(users.uid, 'm2_test_%'));
  if (stale.length > 0) {
    await cleanupTestUsers(stale.map((r) => r.uid));
  }
});

test.after(async () => {
  await cleanupTestUsers(testUserUids);
  await createPool().end();
});

test('TEST 1: Complete execution lifecycle (goal -> plan -> activate -> execute -> evidence -> verify -> progress update)', async () => {
  const tenant = await createIsolatedTestTenant('t1');

  // 1. Create Goal
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Acquire 2 paying B2B customers for our analytics service.',
    targetMetric: '2 paying customers',
    status: 'draft',
  });
  assert.equal(goal.status, 'draft');
  assert.equal(goal.progressPercent, 0);

  // Configure & verify a custom_webhook integration for external outreach dispatch
  const integration = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'custom_webhook',
    displayName: 'Outbound Campaign Webhook',
    connectionMode: 'user_owned',
    capabilities: ['workflow_automation', 'message_dispatch', 'http_request'],
    configMetadata: {
      endpointUrl: 'https://hooks.example.com/campaign-dispatch',
      authType: 'bearer_token',
    },
    plaintextSecret: 'tok_live_acceptance_test_secret_123456',
  });
  await recordIntegrationTestOutcome({
    integrationId: integration.id,
    userId: tenant.uid,
    verified: true,
    statusDetail: 'Verified in acceptance test',
    testedAt: new Date(),
  });

  // 2. Plan structured tasks (deterministic + external consequential step)
  const normalizedPlan = validateAndNormalizePlan(
    [
      {
        step_id: 'step_1',
        description: 'Run internal pre-flight payload verification',
        tool: 'internal_test_tool',
        required_capabilities: ['diagnostic_verification'],
        action_category: 'internal_test',
        dependencies: [],
        approval_required: false,
        expected_result: 'Deterministic SHA-256 verification artifact',
        verification_method: 'Server-side SHA-256 checksum validation',
      },
      {
        step_id: 'step_2',
        description: 'Dispatch approved B2B outreach sequence via webhook',
        tool: 'custom_webhook',
        required_capabilities: ['workflow_automation', 'message_dispatch'],
        action_category: 'message_send',
        dependencies: ['step_1'],
        approval_required: true,
        proposed_action: 'Send B2B campaign sequence',
        target_recipient: 'Qualified B2B leads',
        estimated_cost: '$0.00',
        consequence_explanation: 'Triggers external outreach webhook',
        expected_result: 'Signed external conversion evidence',
        verification_method: 'HMAC-signed customer_acquired webhook',
      },
    ],
    goal.id,
    () => crypto.randomUUID()
  );

  const savedPlan = await savePlannedTasksForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    plannedTasks: normalizedPlan,
  });
  assert.equal(savedPlan.goal.status, 'planning');
  assert.equal(savedPlan.tasks.length, 2);

  // Approve consequential step_2 and activate goal
  const webhookTask = savedPlan.tasks[1];
  await recordApprovalDecision({
    userId: tenant.uid,
    taskId: webhookTask.id,
    decision: 'approved',
  });
  await controlGoalExecution({
    userId: tenant.uid,
    goalId: goal.id,
    action: 'resume', // transitions goal to active + idle
  });

  // 3. Execute orchestrator cycle with deterministic HTTP 200 transport
  let outboundCalls = 0;
  const mockTransport: HttpTransportFn = async (req) => {
    outboundCalls += 1;
    return {
      ok: true,
      status: 200,
      responseText: '{"accepted":true,"dispatchId":"disp_001"}',
      destinationOrigin: new URL(req.url).origin,
    };
  };

  const cycleResult = await runOrchestratorCycle({
    userId: tenant.uid,
    goalId: goal.id,
    concurrencyMode: 'parallel_safe',
    httpTransport: mockTransport,
  });

  assert.equal(outboundCalls, 1);
  assert.equal(cycleResult.run.tasksDispatched, 2);
  assert.equal(cycleResult.run.tasksSucceeded, 2);

  const step1After = cycleResult.tasks.find((t) => t.stepOrder === 1)!;
  const step2After = cycleResult.tasks.find((t) => t.stepOrder === 2)!;
  assert.equal(step1After.status, 'verified');
  assert.equal(step2After.status, 'pending_verification');
  assert.equal(cycleResult.goal.status, 'active');
  assert.equal(cycleResult.goal.progressPercent, 0);

  // 4. Collect external signed & provider-corroborated evidence & verify progress updates -> goal achievement
  const paymentSecret = 'prov_sec_payment_t1_abcdef0123456789';
  await connectVerifiedProviderForTest({
    uid: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'payment_webhook',
    providerSecret: paymentSecret,
  });
  const rotated = await rotateWorkspaceInboundWebhookSecret({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
  });

  const ev1 = buildSignedWebhookCall({
    secret: rotated.oneTimeSigningSecret,
    providerSecret: paymentSecret,
    payload: {
      provider: 'payment_webhook',
      externalEventId: 'evt_cust_001',
      goalId: goal.id,
      taskId: step2After.id,
      evidenceType: 'customer_acquired',
      externalReferenceId: 'cus_live_001',
      summary: 'First paying B2B customer subscribed',
      structuredMetrics: { customers: 1, revenue: 500 },
    },
  });
  const res1 = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...ev1,
  });
  assert.equal(res1.httpStatus, 200);
  assert.equal(
    (res1.body.goalProgress as { progressPercent: number }).progressPercent,
    50
  );
  assert.equal(
    (res1.body.goalProgress as { goalStatus: string }).goalStatus,
    'active'
  );

  const ev2 = buildSignedWebhookCall({
    secret: rotated.oneTimeSigningSecret,
    providerSecret: paymentSecret,
    payload: {
      provider: 'payment_webhook',
      externalEventId: 'evt_cust_002',
      goalId: goal.id,
      taskId: step2After.id,
      evidenceType: 'customer_acquired',
      externalReferenceId: 'cus_live_002',
      summary: 'Second paying B2B customer subscribed',
      structuredMetrics: { customers: 1, revenue: 500 },
    },
  });
  const res2 = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...ev2,
  });
  assert.equal(res2.httpStatus, 200);
  assert.equal(
    (res2.body.goalProgress as { progressPercent: number }).progressPercent,
    100
  );
  assert.equal(
    (res2.body.goalProgress as { isGoalAchieved: boolean }).isGoalAchieved,
    true
  );
  assert.equal(
    (res2.body.goalProgress as { goalStatus: string }).goalStatus,
    'completed'
  );
});

test('TEST 2: External evidence ingestion (signed webhook routes to right workspace/task & rejects bad HMAC or replay)', async () => {
  const tenant = await createIsolatedTestTenant('t2');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Book 2 qualified sales discovery meetings.',
    targetMetric: '2 booked meetings',
    status: 'active',
  });
  const task = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Send calendar booking invite via webhook',
    tool: 'google_calendar_api',
    requiredCapabilities: ['calendar_booking'],
    actionCategory: 'calendar_booking',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'Book calendar meeting',
      targetRecipient: 'prospect@acme.example',
      estimatedCost: '$0.00',
      explanation: 'Sends calendar invite',
    },
    expectedResult: 'Confirmed calendar booking',
    verificationMethod: 'Signed meeting_booked webhook',
  });
  await recordApprovalDecision({
    userId: tenant.uid,
    taskId: task.id,
    decision: 'approved',
  });

  const rotated = await rotateWorkspaceInboundWebhookSecret({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
  });

  // Invalid HMAC signature -> 401
  const tampered = buildSignedWebhookCall({
    secret: 'whsec_wrong_secret_000000000000000000000000',
    payload: {
      provider: 'google_calendar_api',
      externalEventId: 'evt_cal_bad_sig',
      goalId: goal.id,
      taskId: task.id,
      evidenceType: 'meeting_booked',
      externalReferenceId: 'cal_ref_1',
      summary: 'Meeting booked',
      structuredMetrics: { meetings: 1 },
    },
  });
  const badSigRes = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...tampered,
  });
  assert.equal(badSigRes.httpStatus, 401);

  // Replay timestamp outside 300s window -> 401
  const staleSec = Math.floor(Date.now() / 1000) - 900;
  const staleCall = buildSignedWebhookCall({
    secret: rotated.oneTimeSigningSecret,
    timestampSec: staleSec,
    payload: {
      provider: 'google_calendar_api',
      externalEventId: 'evt_cal_stale',
      goalId: goal.id,
      taskId: task.id,
      evidenceType: 'meeting_booked',
      externalReferenceId: 'cal_ref_stale',
      summary: 'Stale replay event',
      structuredMetrics: { meetings: 1 },
    },
  });
  const replayRes = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...staleCall,
  });
  assert.equal(replayRes.httpStatus, 401);

  // Valid signed & provider-corroborated webhook -> 200, routes to workspace & task, transitions task to verified
  const calendarSecret = 'prov_sec_calendar_t2_abcdef0123456789';
  await connectVerifiedProviderForTest({
    uid: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'google_calendar_api',
    providerSecret: calendarSecret,
  });
  const validCall = buildSignedWebhookCall({
    secret: rotated.oneTimeSigningSecret,
    providerSecret: calendarSecret,
    payload: {
      provider: 'google_calendar_api',
      externalEventId: 'evt_cal_valid_01',
      goalId: goal.id,
      taskId: task.id,
      evidenceType: 'meeting_booked',
      externalReferenceId: 'cal_evt_9981',
      summary: 'Discovery call confirmed with Acme VP',
      structuredMetrics: { meetings: 1 },
    },
  });
  const okRes = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...validCall,
  });
  assert.equal(okRes.httpStatus, 200);

  const updatedTask = await getTaskByIdForUser(task.id, tenant.uid);
  assert.ok(updatedTask);
  assert.equal(updatedTask.status, 'verified');
  assert.equal(updatedTask.verificationStatus, 'verified');
});

test('TEST 3: Duplicate protection (same external event submitted twice processed once, metrics not double-counted)', async () => {
  const tenant = await createIsolatedTestTenant('t3');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Acquire 2 paying customers without duplicate webhook inflation.',
    targetMetric: '2 paying customers',
    status: 'active',
  });
  const paymentSecret = 'prov_sec_payment_t3_abcdef0123456789';
  await connectVerifiedProviderForTest({
    uid: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'payment_webhook',
    providerSecret: paymentSecret,
  });
  const rotated = await rotateWorkspaceInboundWebhookSecret({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
  });

  const duplicatePayload = {
    provider: 'payment_webhook',
    externalEventId: 'evt_idem_unique_777',
    idempotencyKey: 'idem_777',
    goalId: goal.id,
    evidenceType: 'customer_acquired',
    externalReferenceId: 'inv_777',
    summary: 'Customer invoice paid',
    structuredMetrics: { customers: 1 },
  };

  const first = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...buildSignedWebhookCall({
      secret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: duplicatePayload,
    }),
  });
  assert.equal(first.httpStatus, 200);
  assert.equal(first.body.duplicate, false);

  const second = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...buildSignedWebhookCall({
      secret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: duplicatePayload,
    }),
  });
  assert.equal(second.httpStatus, 200);
  assert.equal(second.body.duplicate, true);

  const allEvidence = await listOutcomeEvidenceByWorkspace({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    goalId: goal.id,
  });
  assert.equal(allEvidence.length, 1);

  const progress = await recalculateAndPersistGoalProgress({
    userId: tenant.uid,
    goalId: goal.id,
  });
  assert.equal(progress.progressPercent, 50);
  assert.equal(progress.isGoalAchieved, false);
  assert.equal(progress.goal?.status, 'active');
});

test('TEST 4: Verification integrity (HTTP 200 dispatch & api_dispatch_ack NEVER count as verified outcomes)', async () => {
  const tenant = await createIsolatedTestTenant('t4');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Send outbound emails and count only verified replies.',
    targetMetric: '3 replies',
    status: 'active',
  });

  const integration = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'gmail_api',
    displayName: 'Gmail Outbound Relay',
    connectionMode: 'user_owned',
    capabilities: ['message_dispatch', 'http_request'],
    configMetadata: {
      endpointUrl: 'https://relay.example.com/gmail-send',
      authType: 'bearer_token',
    },
    plaintextSecret: 'gmail_relay_secret_token_999',
  });
  await recordIntegrationTestOutcome({
    integrationId: integration.id,
    userId: tenant.uid,
    verified: true,
    statusDetail: 'Connection verified',
    testedAt: new Date(),
  });

  const task = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Dispatch email campaign via Gmail relay',
    tool: 'gmail_api',
    requiredCapabilities: ['message_dispatch'],
    actionCategory: 'message_send',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'Send 10 outreach emails',
      targetRecipient: '10 prospects',
      estimatedCost: '$0.00',
      explanation: 'Sends emails through configured relay',
    },
    expectedResult: '3 prospect replies',
    verificationMethod: 'Signed reply_received webhook',
  });
  await recordApprovalDecision({
    userId: tenant.uid,
    taskId: task.id,
    decision: 'approved',
  });

  const execRes = await executeSingleTaskManaged({
    userId: tenant.uid,
    taskId: task.id,
    httpTransport: async (req) => ({
      ok: true,
      status: 200,
      responseText: '{"queued":true,"status":"200 OK"}',
      destinationOrigin: new URL(req.url).origin,
    }),
  });

  assert.equal(execRes.executed, true);
  assert.equal(execRes.outcomeCode, 'pending_verification');
  assert.equal(execRes.task?.status, 'pending_verification');
  assert.equal(execRes.task?.verificationStatus, 'pending_verification');

  // Even a signed inbound `api_dispatch_ack` webhook must stay `pending_verification`
  const rotated = await rotateWorkspaceInboundWebhookSecret({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
  });
  const ackRes = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...buildSignedWebhookCall({
      secret: rotated.oneTimeSigningSecret,
      payload: {
        provider: 'gmail_api',
        externalEventId: 'evt_ack_only_01',
        goalId: goal.id,
        taskId: task.id,
        evidenceType: 'api_dispatch_ack',
        externalReferenceId: 'msg_batch_200',
        summary: 'Relay accepted HTTP 200 batch request',
        structuredMetrics: { count: 10 },
      },
    }),
  });
  assert.equal(ackRes.httpStatus, 200);

  const afterAckTask = await getTaskByIdForUser(task.id, tenant.uid);
  assert.equal(afterAckTask?.status, 'pending_verification');
  assert.equal(afterAckTask?.verificationStatus, 'pending_verification');

  const progress = await recalculateAndPersistGoalProgress({
    userId: tenant.uid,
    goalId: goal.id,
  });
  assert.equal(progress.progressPercent, 0);
  assert.equal(progress.isGoalAchieved, false);
});

test('TEST 5: Human & AI-assisted verification (manual/human-flagged evidence stays pending until human approves with notes)', async () => {
  const tenant = await createIsolatedTestTenant('t5');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Close 1 enterprise contract verified by finance reviewer.',
    targetMetric: '1 paying customer',
    status: 'active',
  });

  // Submit manual evidence -> strictly enters pending_verification
  const submitted = await submitManualWorkspaceEvidence({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    goalId: goal.id,
    provider: 'manual_crm_upload',
    evidenceType: 'customer_acquired',
    externalReferenceId: 'wire_transfer_ref_8842',
    summary: 'Enterprise annual wire transfer received ($12,000)',
    structuredMetrics: { customers: 1, revenue: 12000 },
  });

  assert.equal(submitted.evidence.verificationState, 'pending_verification');
  assert.equal(submitted.evidence.requiresHumanReview, true);
  assert.equal(submitted.goalProgress.progressPercent, 0);
  assert.equal(submitted.goalProgress.isGoalAchieved, false);

  // Run AI-Assisted Verification -> advisory only, NEVER mutates pending_verification state
  const aiAudit = await runAiAssistedVerificationOnEvidence({
    userId: tenant.uid,
    evidenceId: submitted.evidence.id,
  });
  assert.ok(
    aiAudit.recommendation === 'recommended_verify' ||
      aiAudit.recommendation === 'recommended_reject'
  );
  const stillPending = await getOutcomeEvidenceByIdForUser(
    submitted.evidence.id,
    tenant.uid
  );
  assert.equal(stillPending?.verificationState, 'pending_verification');

  // Empty/short reviewer notes must be rejected
  await assert.rejects(
    () =>
      reviewOutcomeEvidenceByHuman({
        userId: tenant.uid,
        evidenceId: submitted.evidence.id,
        reviewerEmail: tenant.email,
        decision: 'verified',
        notes: 'ok',
      }),
    /at least 3 characters/i
  );

  // Valid human verification with reviewer identity + notes -> transitions to verified & achieves goal
  const reviewed = await reviewOutcomeEvidenceByHuman({
    userId: tenant.uid,
    evidenceId: submitted.evidence.id,
    reviewerEmail: tenant.email,
    decision: 'verified',
    notes: 'Confirmed wire transfer wire_transfer_ref_8842 in bank ledger.',
  });
  assert.equal(reviewed.evidence.verificationState, 'verified');
  assert.equal(reviewed.verification.verificationMethod, 'human_review');
  assert.equal(reviewed.verification.reviewerIdentity, tenant.email);
  assert.equal(reviewed.goalProgress.progressPercent, 100);
  assert.equal(reviewed.goalProgress.isGoalAchieved, true);
  assert.equal(reviewed.goalProgress.goal?.status, 'completed');

  const auditTrail = await listVerificationRecordsByWorkspace({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    goalId: goal.id,
  });
  assert.ok(auditTrail.some((r) => r.verificationMethod === 'human_review'));
  assert.ok(
    auditTrail.some(
      (r) => r.verificationMethod === 'ai_assisted_recommendation'
    )
  );
});

test('TEST 6: Failed execution recovery (provider failure -> exponential backoff, attempt history, manual retry recovery, maxRetries exhaustion)', async () => {
  const tenant = await createIsolatedTestTenant('t6');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Sync qualified leads to CRM reliably.',
    targetMetric: '5 qualified leads',
    status: 'active',
  });

  const integration = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'crm_webhook',
    displayName: 'HubSpot Sync Endpoint',
    connectionMode: 'user_owned',
    capabilities: ['crm_sync', 'http_request'],
    configMetadata: {
      endpointUrl: 'https://crm.example.com/sync',
      authType: 'bearer_token',
    },
    plaintextSecret: 'crm_secret_key_abcdef123456',
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
    description: 'Push lead batch to CRM webhook',
    tool: 'crm_webhook',
    requiredCapabilities: ['crm_sync'],
    actionCategory: 'crm_update',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'Push CRM contacts',
      targetRecipient: 'CRM',
      estimatedCost: '$0.00',
      explanation: 'Updates CRM records',
    },
    expectedResult: 'CRM lead records created',
    verificationMethod: 'Signed qualified_lead webhook',
    maxRetries: 1,
    backoffBaseMs: 60_000, // 60s base backoff so immediate retry is blocked
  });
  await recordApprovalDecision({
    userId: tenant.uid,
    taskId: task.id,
    decision: 'approved',
  });

  // Attempt #1 fails with HTTP 503 -> schedules backoff retry (retryCount=1 <= maxRetries=1)
  const fail1 = await executeSingleTaskManaged({
    userId: tenant.uid,
    taskId: task.id,
    httpTransport: async (req) => ({
      ok: false,
      status: 503,
      responseText: 'Service Temporarily Unavailable',
      destinationOrigin: new URL(req.url).origin,
    }),
  });
  assert.equal(fail1.executed, false);
  assert.equal(fail1.outcomeCode, 'retry_scheduled');
  assert.equal(fail1.task?.retryCount, 1);
  assert.equal(fail1.task?.status, 'approved');
  assert.ok(fail1.task?.nextRetryAt);

  // Immediate re-execution before backoff window elapses is gated
  const gatedDuringBackoff = await executeSingleTaskManaged({
    userId: tenant.uid,
    taskId: task.id,
    httpTransport: async (req) => ({
      ok: true,
      status: 200,
      responseText: '{"ok":true}',
      destinationOrigin: new URL(req.url).origin,
    }),
  });
  assert.equal(gatedDuringBackoff.executed, false);
  assert.equal(gatedDuringBackoff.outcomeCode, 'retry_backoff_pending');

  // Advance past backoff window -> Attempt #2 also fails -> exhausts maxRetries=1 -> status='failed'
  const futureMs = Date.now() + 120_000;
  const fail2 = await executeSingleTaskManaged({
    userId: tenant.uid,
    taskId: task.id,
    nowMs: futureMs,
    httpTransport: async (req) => ({
      ok: false,
      status: 502,
      responseText: 'Bad Gateway',
      destinationOrigin: new URL(req.url).origin,
    }),
  });
  assert.equal(fail2.executed, false);
  assert.equal(fail2.outcomeCode, 'execution_failed');
  assert.equal(fail2.task?.status, 'failed');
  assert.equal(fail2.task?.retryCount, 2);

  // Manual Retry clears nextRetryAt, bumps retry budget, and recovers cleanly on Attempt #3
  const manuallyRetried = await retryTaskManually({
    userId: tenant.uid,
    taskId: task.id,
  });
  assert.ok(manuallyRetried);
  assert.equal(manuallyRetried.status, 'approved');
  assert.equal(manuallyRetried.nextRetryAt, null);
  assert.ok(manuallyRetried.maxRetries >= 4);

  const recoveredExec = await executeSingleTaskManaged({
    userId: tenant.uid,
    taskId: task.id,
    httpTransport: async (req) => ({
      ok: true,
      status: 200,
      responseText: '{"synced":true}',
      destinationOrigin: new URL(req.url).origin,
    }),
  });
  assert.equal(recoveredExec.executed, true);
  assert.equal(recoveredExec.outcomeCode, 'pending_verification');

  const attempts = await listTaskAttemptsByWorkspace({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    goalId: goal.id,
  });
  assert.equal(attempts.length, 3);
});

test('TEST 7 & TEST 8: Continuous AI Reasoning generates structured proposals & Approval Gate blocks consequential proposals until approved', async () => {
  const tenant = await createIsolatedTestTenant('t7_t8');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Acquire 3 paying B2B SaaS customers via outbound outreach.',
    targetMetric: '3 paying customers',
    status: 'active',
  });

  // Configure a verified custom_webhook integration so approved consequential tasks can route
  const integration = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'custom_webhook',
    displayName: 'Outbound Webhook Runner',
    connectionMode: 'user_owned',
    capabilities: [
      'workflow_automation',
      'message_dispatch',
      'crm_sync',
      'prospect_search',
      'http_request',
      'calendar_booking',
      'payment_verification',
    ],
    configMetadata: {
      endpointUrl: 'https://automation.example.com/execute',
      authType: 'bearer_token',
    },
    plaintextSecret: 'runner_secret_token_xyz_987654',
  });
  await recordIntegrationTestOutcome({
    integrationId: integration.id,
    userId: tenant.uid,
    verified: true,
    statusDetail: 'Verified',
    testedAt: new Date(),
  });

  // Seed one completed diagnostic step so Gemini has concrete cycle context
  const seedTask = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Verify initial readiness artifact',
    tool: 'internal_test_tool',
    requiredCapabilities: ['diagnostic_verification'],
    actionCategory: 'internal_test',
    dependencies: [],
    approvalRequired: false,
    proposedActionDetails: null,
    expectedResult: 'Verified diagnostic artifact',
    verificationMethod: 'SHA-256 checksum',
  });
  await executeSingleTaskManaged({
    userId: tenant.uid,
    taskId: seedTask.id,
  });

  // TEST 7: Run Continuous AI Reasoning with live Gemini
  const reasoning = await runContinuousReasoningForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    triggerSource: 'manual',
  });

  assert.ok(reasoning.cycle.id);
  assert.ok(reasoning.cycle.currentAssessment.length > 5);
  assert.ok(reasoning.cycle.reasoningSummary.length > 10);
  // Hard invariant: 0/3 customers verified, so goalAchievedRecommendation MUST be false
  assert.equal(reasoning.cycle.goalAchievedRecommendation, false);
  assert.ok(
    reasoning.proposals.length >= 1,
    'Expected at least 1 structured next-action proposal from Continuous AI Reasoning'
  );

  // TEST 8: Ensure consequential proposals strictly enter Approval Gate and CANNOT execute without approval
  const consequentialProposal = reasoning.proposals.find(
    (p) => p.approvalRequired && p.proposalType !== 'human_intervention'
  );

  let gatedTaskId: string;
  if (consequentialProposal) {
    const accepted = await decideNextActionProposal({
      userId: tenant.uid,
      proposalId: consequentialProposal.id,
      decision: 'accept',
    });
    assert.equal(accepted.proposal.status, 'enqueued');
    assert.ok(accepted.enqueuedTask);
    assert.equal(accepted.enqueuedTask.approvalRequired, true);
    assert.equal(accepted.enqueuedTask.approvalStatus, 'pending');
    gatedTaskId = accepted.enqueuedTask.id;
  } else {
    const acceptedNonConseq = await decideNextActionProposal({
      userId: tenant.uid,
      proposalId: reasoning.proposals[0].id,
      decision: 'accept',
    });
    assert.equal(acceptedNonConseq.proposal.status, 'enqueued');

    const explicitConseq = await createSingleTaskForGoal({
      userId: tenant.uid,
      goalId: goal.id,
      description: 'Send follow-up outreach emails to qualified prospects',
      tool: 'custom_webhook',
      requiredCapabilities: ['workflow_automation', 'message_dispatch'],
      actionCategory: 'message_send',
      dependencies: [],
      approvalRequired: true,
      proposedActionDetails: {
        proposedAction: 'Dispatch follow-up emails',
        targetRecipient: 'Qualified prospects',
        estimatedCost: '$0.00',
        explanation: 'Contacts external prospects',
      },
      expectedResult: 'Prospect replies',
      verificationMethod: 'Signed reply_received webhook',
    });
    gatedTaskId = explicitConseq.id;
  }

  let transportInvokedBeforeApproval = 0;
  const blockedAttempt = await executeSingleTaskManaged({
    userId: tenant.uid,
    taskId: gatedTaskId,
    httpTransport: async (req) => {
      transportInvokedBeforeApproval += 1;
      return {
        ok: true,
        status: 200,
        responseText: '{}',
        destinationOrigin: new URL(req.url).origin,
      };
    },
  });

  assert.equal(transportInvokedBeforeApproval, 0);
  assert.equal(blockedAttempt.executed, false);
  assert.equal(blockedAttempt.outcomeCode, 'approval_pending');
  assert.equal(blockedAttempt.task?.status, 'blocked');

  // Now explicitly approve in Approval Gate -> verify task transitions to approved
  const approvedTask = await recordApprovalDecision({
    userId: tenant.uid,
    taskId: gatedTaskId,
    decision: 'approved',
  });
  assert.equal(approvedTask?.status, 'approved');
  assert.equal(approvedTask?.approvalStatus, 'approved');
});

test('TEST 9: Multi-tenant isolation (cross-workspace access to tasks, evidence, monitor snapshots, credentials, and signed webhooks rejected)', async () => {
  const tenantA = await createIsolatedTestTenant('t9_a');
  const tenantB = await createIsolatedTestTenant('t9_b');

  const goalA = await createGoalForUser({
    userId: tenantA.uid,
    workspaceId: tenantA.workspace.id,
    problem: 'Tenant A confidential enterprise expansion goal.',
    targetMetric: '5 enterprise customers',
    status: 'active',
  });
  const taskA = await createSingleTaskForGoal({
    userId: tenantA.uid,
    goalId: goalA.id,
    description: 'Tenant A confidential task',
    tool: 'internal_test_tool',
    requiredCapabilities: ['diagnostic_verification'],
    actionCategory: 'internal_test',
    dependencies: [],
    approvalRequired: false,
    proposedActionDetails: null,
    expectedResult: 'Artifact A',
    verificationMethod: 'SHA-256',
  });
  await createUserIntegration({
    userId: tenantA.uid,
    workspaceId: tenantA.workspace.id,
    providerKey: 'custom_webhook',
    displayName: 'Tenant A Private Webhook',
    connectionMode: 'user_owned',
    capabilities: ['workflow_automation'],
    configMetadata: {
      endpointUrl: 'https://private-a.example.com/hook',
      authType: 'bearer_token',
    },
    plaintextSecret: 'super_secret_tenant_a_token_111111',
  });
  const manualEvA = await submitManualWorkspaceEvidence({
    userId: tenantA.uid,
    workspaceId: tenantA.workspace.id,
    goalId: goalA.id,
    taskId: taskA.id,
    evidenceType: 'customer_acquired',
    summary: 'Tenant A private customer deal',
    structuredMetrics: { customers: 1 },
  });

  // 1. Tenant B cannot read, execute, approve, or retry Tenant A's goal or task
  assert.equal(await getGoalByIdForUser(goalA.id, tenantB.uid), null);
  assert.equal(await getTaskByIdForUser(taskA.id, tenantB.uid), null);
  const crossExec = await executeSingleTaskManaged({
    userId: tenantB.uid,
    taskId: taskA.id,
  });
  assert.equal(crossExec.executed, false);
  assert.equal(crossExec.outcomeCode, 'not_found');
  assert.equal(
    await retryTaskManually({ userId: tenantB.uid, taskId: taskA.id }),
    null
  );

  // 2. Tenant B cannot read or review Tenant A's outcome evidence
  assert.equal(
    await getOutcomeEvidenceByIdForUser(manualEvA.evidence.id, tenantB.uid),
    null
  );
  await assert.rejects(
    () =>
      reviewOutcomeEvidenceByHuman({
        userId: tenantB.uid,
        evidenceId: manualEvA.evidence.id,
        reviewerEmail: tenantB.email,
        decision: 'verified',
        notes: 'Unauthorized cross-tenant review attempt',
      }),
    /not found or access denied/i
  );

  // 3. Tenant B's integrations list and Execution Monitor snapshot contain zero Tenant A records
  const bIntegrations = await listIntegrationsByUser(
    tenantB.uid,
    tenantB.workspace.id
  );
  assert.equal(bIntegrations.length, 0);
  const bSnapshot = await getExecutionMonitorSnapshot({
    userId: tenantB.uid,
    workspaceId: tenantB.workspace.id,
    tools: buildWorkspaceToolRegistry(bIntegrations),
  });
  assert.equal(bSnapshot.evidence.length, 0);
  assert.equal(bSnapshot.goalMetrics.length, 0);

  // 4. Signed webhook using Tenant B's workspace secret attempting to reference Tenant A's goalId/taskId is rejected with 403
  const rotatedB = await rotateWorkspaceInboundWebhookSecret({
    userId: tenantB.uid,
    workspaceId: tenantB.workspace.id,
  });
  const crossWebhook = await ingestSignedInboundEvidence({
    workspaceId: tenantB.workspace.id,
    ...buildSignedWebhookCall({
      secret: rotatedB.oneTimeSigningSecret,
      payload: {
        provider: 'custom_webhook',
        externalEventId: 'evt_cross_tenant_spoof',
        goalId: goalA.id,
        taskId: taskA.id,
        evidenceType: 'customer_acquired',
        externalReferenceId: 'spoof_ref_1',
        summary: 'Cross-workspace spoof attempt',
        structuredMetrics: { customers: 5 },
      },
    }),
  });
  assert.equal(crossWebhook.httpStatus, 403);
});

test('TEST 10: Goal achievement (goal marked completed ONLY when measurable target criteria are satisfied by verified outcomes, never by task completion)', async () => {
  const tenant = await createIsolatedTestTenant('t10');
  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
    problem: 'Generate $1,000 in verified new subscription revenue.',
    targetMetric: '$1,000 revenue',
    status: 'active',
  });

  // Execute 2 diagnostic tasks to 100% task completion
  for (let i = 1; i <= 2; i++) {
    const t = await createSingleTaskForGoal({
      userId: tenant.uid,
      goalId: goal.id,
      description: `Diagnostic readiness check #${i}`,
      tool: 'internal_test_tool',
      requiredCapabilities: ['diagnostic_verification'],
      actionCategory: 'internal_test',
      dependencies: [],
      approvalRequired: false,
      proposedActionDetails: null,
      expectedResult: 'Verified diagnostic checksum',
      verificationMethod: 'SHA-256 checksum',
    });
    const res = await executeSingleTaskManaged({
      userId: tenant.uid,
      taskId: t.id,
    });
    assert.equal(res.outcomeCode, 'verified');
  }

  // All tasks are finished (`verified`), yet verified revenue is $0 / $1,000 -> goal MUST remain `active` at 0%!
  const allTasks = await listTasksByUser(
    tenant.uid,
    goal.id,
    tenant.workspace.id
  );
  assert.equal(allTasks.length, 2);
  assert.ok(allTasks.every((t) => t.status === 'verified'));

  const progressAfterTasks = await recalculateAndPersistGoalProgress({
    userId: tenant.uid,
    goalId: goal.id,
  });
  assert.equal(progressAfterTasks.progressPercent, 0);
  assert.equal(progressAfterTasks.isGoalAchieved, false);
  assert.equal(progressAfterTasks.goal?.status, 'active');
  assert.equal(progressAfterTasks.goal?.achievedAt, null);

  // Ingest partial verified revenue ($400) -> 40% progress, still `active`
  const paymentSecret = 'prov_sec_payment_t10_abcdef0123456789';
  await connectVerifiedProviderForTest({
    uid: tenant.uid,
    workspaceId: tenant.workspace.id,
    providerKey: 'payment_webhook',
    providerSecret: paymentSecret,
  });
  const rotated = await rotateWorkspaceInboundWebhookSecret({
    userId: tenant.uid,
    workspaceId: tenant.workspace.id,
  });
  const rev1 = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...buildSignedWebhookCall({
      secret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: {
        provider: 'payment_webhook',
        externalEventId: 'evt_rev_400',
        goalId: goal.id,
        evidenceType: 'payment_confirmed',
        externalReferenceId: 'ch_live_400',
        summary: 'Subscription payment $400 settled',
        structuredMetrics: { revenue: 400 },
      },
    }),
  });
  assert.equal(rev1.httpStatus, 200);
  const afterPartial = await getGoalByIdForUser(goal.id, tenant.uid);
  assert.equal(afterPartial?.progressPercent, 40);
  assert.equal(afterPartial?.status, 'active');
  assert.equal(afterPartial?.achievedAt, null);

  // Ingest remaining verified revenue ($600 -> total $1,000) -> 100% progress, transitions to `completed` with `achievedAt`!
  const rev2 = await ingestSignedInboundEvidence({
    workspaceId: tenant.workspace.id,
    ...buildSignedWebhookCall({
      secret: rotated.oneTimeSigningSecret,
      providerSecret: paymentSecret,
      payload: {
        provider: 'payment_webhook',
        externalEventId: 'evt_rev_600',
        goalId: goal.id,
        evidenceType: 'payment_confirmed',
        externalReferenceId: 'ch_live_600',
        summary: 'Subscription payment $600 settled',
        structuredMetrics: { revenue: 600 },
      },
    }),
  });
  assert.equal(rev2.httpStatus, 200);
  const afterFull = await getGoalByIdForUser(goal.id, tenant.uid);
  assert.equal(afterFull?.progressPercent, 100);
  assert.equal(afterFull?.status, 'completed');
  assert.ok(afterFull?.achievedAt);
});
