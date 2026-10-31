import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProviderRegistryItems,
  PROVIDER_DESCRIPTORS,
} from './provider-registry.ts';
import {
  computeInboundWebhookSignature,
  evaluateEvidenceVerification,
  validateInboundEvidencePayload,
  verifyInboundWebhookAuth,
} from './verification-engine.ts';
import {
  computeGoalMetricsAndProgress,
  parseGoalTargetMetrics,
} from './goal-progress.ts';
import {
  computeExponentialBackoffMs,
  detectStalledTasks,
  isRetryBackoffElapsed,
  planExecutionWave,
} from './orchestrator-rules.ts';
import type {
  OutcomeEvidenceRecord,
  TaskAttemptRecord,
  TaskRecord,
} from '../types.ts';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 't-1',
    goalId: overrides.goalId ?? 'g-1',
    userId: overrides.userId ?? 'u-1',
    workspaceId: overrides.workspaceId ?? 'ws-1',
    stepOrder: overrides.stepOrder ?? 1,
    description: overrides.description ?? 'Execute step',
    tool: overrides.tool ?? 'llm_reasoning',
    requiredCapabilities: overrides.requiredCapabilities ?? ['ai_reasoning'],
    assignedProvider: overrides.assignedProvider ?? null,
    assignedIntegrationId: overrides.assignedIntegrationId ?? null,
    actionCategory: overrides.actionCategory ?? 'analysis',
    dependencies: overrides.dependencies ?? [],
    approvalRequired: overrides.approvalRequired ?? false,
    approvalStatus: overrides.approvalStatus ?? 'not_required',
    approvalDecisionAt: overrides.approvalDecisionAt ?? null,
    approvalDecisionBy: overrides.approvalDecisionBy ?? null,
    proposedActionDetails: overrides.proposedActionDetails ?? null,
    expectedResult: overrides.expectedResult ?? 'Expected result',
    verificationMethod: overrides.verificationMethod ?? 'Verification method',
    status: overrides.status ?? 'queued',
    verificationStatus: overrides.verificationStatus ?? 'unverified',
    reconciliationRequired: overrides.reconciliationRequired ?? false,
    statusReason: overrides.statusReason ?? null,
    outputData: overrides.outputData ?? null,
    lockedBy: overrides.lockedBy ?? null,
    lockedAt: overrides.lockedAt ?? null,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 2,
    backoffBaseMs: overrides.backoffBaseMs ?? 2000,
    nextRetryAt: overrides.nextRetryAt ?? null,
    executionTimeoutMs: overrides.executionTimeoutMs ?? 20000,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    verifiedAt: overrides.verifiedAt ?? null,
    lastDurationMs: overrides.lastDurationMs ?? null,
    idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

test('Provider Registry exposes common descriptor interface across all 10 providers with honest implementation status', () => {
  assert.equal(PROVIDER_DESCRIPTORS.length, 10);
  const items = buildProviderRegistryItems({
    geminiReady: true,
    workspaceIntegrations: [],
  });
  assert.equal(items.length, 10);

  const builtInReady = items.filter(
    (i) => i.scope === 'built_in' && i.healthStatus === 'healthy'
  );
  assert.equal(builtInReady.length, 2);

  const makeItem = items.find((i) => i.id === 'make_webhook');
  assert.ok(makeItem);
  assert.equal(
    makeItem.implementationStatus,
    'implemented_requires_external_credentials'
  );
  assert.equal(makeItem.healthStatus, 'unconfigured');
});

test('Inbound Webhook HMAC-SHA256 verification accepts valid signatures and rejects tampered payloads and expired replay timestamps', () => {
  const secret = 'whsec_test_inbound_secret_0123456789abcdef';
  const nowMs = 1_760_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  const rawBody = JSON.stringify({
    provider: 'stripe_payment_webhook',
    externalEventId: 'evt_live_001',
    goalId: 'g-1',
    evidenceType: 'payment_confirmed',
    structuredMetrics: { amountUsd: 500 },
  });

  const validSig = computeInboundWebhookSignature(secret, nowSec, rawBody);
  const checkOk = verifyInboundWebhookAuth({
    signingSecret: secret,
    rawBody,
    signatureHeader: validSig,
    nowMs,
  });
  assert.equal(checkOk.valid, true);

  // Tampered body rejected
  const checkTampered = verifyInboundWebhookAuth({
    signingSecret: secret,
    rawBody: rawBody.replace('500', '50000'),
    signatureHeader: validSig,
    nowMs,
  });
  assert.equal(checkTampered.valid, false);
  if (!checkTampered.valid) {
    assert.equal(checkTampered.code, 'invalid_signature');
  }

  // Replay attack outside 300s skew rejected
  const staleSig = computeInboundWebhookSignature(
    secret,
    nowSec - 600,
    rawBody
  );
  const checkReplay = verifyInboundWebhookAuth({
    signingSecret: secret,
    rawBody,
    signatureHeader: staleSig,
    nowMs,
  });
  assert.equal(checkReplay.valid, false);
  if (!checkReplay.valid) {
    assert.equal(checkReplay.code, 'replay_window_expired');
  }

  // Payload validation
  const parsed = validateInboundEvidencePayload(JSON.parse(rawBody));
  assert.equal(parsed.valid, true);
});

test('Outcome Verification Engine separates HTTP 200 api_dispatch_ack and human review from verified outcomes', () => {
  const approvedTask = makeTask({
    id: 't-send',
    approvalRequired: true,
    approvalStatus: 'approved',
    status: 'pending_verification',
  });

  // 1. Mere HTTP 200 / api_dispatch_ack NEVER becomes verified
  const ackEval = evaluateEvidenceVerification({
    sourceType: 'inbound_webhook',
    signatureVerified: true,
    evidenceType: 'api_dispatch_ack',
    externalReferenceId: 'http_200_ack',
    requiresHumanReview: false,
    structuredMetrics: { httpStatus: 200 },
    associatedTask: approvedTask,
  });
  assert.equal(ackEval.verificationState, 'pending_verification');
  assert.equal(ackEval.taskNextStatus, 'pending_verification');

  // 2. Evidence flagged requiresHumanReview stays pending_verification until human reviewer approves
  const humanEval = evaluateEvidenceVerification({
    sourceType: 'inbound_webhook',
    signatureVerified: true,
    evidenceType: 'customer_acquired',
    externalReferenceId: 'deal_99',
    requiresHumanReview: true,
    structuredMetrics: { customersAcquired: 1 },
    associatedTask: approvedTask,
  });
  assert.equal(humanEval.verificationState, 'pending_verification');
  assert.equal(humanEval.verificationMethod, 'human_review');

  // 3. Unapproved consequential task rejects verification
  const unapprovedTask = makeTask({
    id: 't-unapproved',
    approvalRequired: true,
    approvalStatus: 'pending',
    status: 'blocked',
  });
  const unapprovedEval = evaluateEvidenceVerification({
    sourceType: 'inbound_webhook',
    signatureVerified: true,
    evidenceType: 'customer_acquired',
    externalReferenceId: 'deal_100',
    requiresHumanReview: false,
    structuredMetrics: { customersAcquired: 1 },
    associatedTask: unapprovedTask,
  });
  assert.equal(unapprovedEval.verificationState, 'rejected');

  // 4a. Workspace HMAC signature alone (without verified provider integration) -> stays authenticated_webhook (pending_verification)
  const hmacOnlyEval = evaluateEvidenceVerification({
    sourceType: 'inbound_webhook',
    provider: 'payment_webhook',
    signatureVerified: true,
    providerSignatureVerified: false,
    verifiedWorkspaceIntegrationPresent: false,
    evidenceType: 'customer_acquired',
    externalReferenceId: 'cus_stripe_9001',
    requiresHumanReview: false,
    structuredMetrics: { customersAcquired: 1, amountUsd: 299 },
    associatedTask: approvedTask,
  });
  assert.equal(hmacOnlyEval.provenanceClass, 'authenticated_webhook');
  assert.equal(hmacOnlyEval.trustTier, 'transport_authenticated');
  assert.equal(hmacOnlyEval.verificationState, 'pending_verification');

  // 4b. Signed webhook corroborated by verified workspace provider integration + executed external task -> provider_confirmed (verified)
  const externalApprovedTask = makeTask({
    id: 't-ext-send',
    tool: 'payment_webhook',
    approvalRequired: true,
    approvalStatus: 'approved',
    status: 'pending_verification',
  });
  const verifiedEval = evaluateEvidenceVerification({
    sourceType: 'inbound_webhook',
    provider: 'payment_webhook',
    signatureVerified: true,
    providerSignatureVerified: true,
    verifiedWorkspaceIntegrationPresent: true,
    evidenceType: 'customer_acquired',
    externalReferenceId: 'cus_stripe_9001',
    requiresHumanReview: false,
    structuredMetrics: { customersAcquired: 1, amountUsd: 299 },
    associatedTask: externalApprovedTask,
  });
  assert.equal(verifiedEval.provenanceClass, 'provider_confirmed');
  assert.equal(verifiedEval.trustTier, 'provider_verified');
  assert.equal(verifiedEval.verificationState, 'verified');
  assert.equal(verifiedEval.taskNextStatus, 'verified');
});

test('Goal Progress Intelligence parses multi-currency targets and NEVER marks goal achieved from completed tasks alone', () => {
  const usdDefs = parseGoalTargetMetrics('Generate $1,500 USD in new revenue');
  assert.equal(usdDefs[0].unit, 'USD');
  assert.equal(usdDefs[0].targetValue, 1500);
  assert.equal(usdDefs[0].metricKey, 'revenue_earned');

  const ngnDefs = parseGoalTargetMetrics('Generate ₦500k in verified sales');
  assert.equal(ngnDefs[0].unit, 'NGN');
  assert.equal(ngnDefs[0].targetValue, 500_000);

  const customerGoal = {
    id: 'g-cust',
    targetMetric: 'Acquire 3 paying customers',
  };

  // All tasks finished execution, but ZERO verified customer_acquired evidence exists
  const tasks: TaskRecord[] = [
    makeTask({
      id: 't1',
      goalId: 'g-cust',
      actionCategory: 'message_draft',
      status: 'completed',
    }),
    makeTask({
      id: 't2',
      goalId: 'g-cust',
      actionCategory: 'internal_test',
      status: 'verified',
    }),
    makeTask({
      id: 't3',
      goalId: 'g-cust',
      actionCategory: 'payment_collection',
      status: 'pending_verification',
    }),
  ];
  const attempts: TaskAttemptRecord[] = [];
  const pendingEvidence: OutcomeEvidenceRecord[] = [
    {
      id: 'ev-pending',
      userId: 'u-1',
      workspaceId: 'ws-1',
      goalId: 'g-cust',
      taskId: 't3',
      inboundEventId: 'in-1',
      sourceType: 'inbound_webhook',
      provider: 'crm_webhook',
      evidenceType: 'customer_acquired',
      externalReferenceId: 'deal_pending_1',
      summary: 'Awaiting human review',
      structuredMetrics: { customersAcquired: 2 },
      sanitizedPayload: {},
      requiresHumanReview: true,
      verificationState: 'pending_verification',
      provenanceClass: 'authenticated_webhook',
      trustTier: 'transport_authenticated',
      hasConflict: false,
      observedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
  ];

  const unachieved = computeGoalMetricsAndProgress({
    goal: customerGoal,
    tasks,
    attempts,
    evidence: pendingEvidence,
  });
  assert.equal(unachieved.progressPercent, 0);
  assert.equal(unachieved.isGoalAchieved, false);
  const primaryPending = unachieved.metrics.find((m) => m.isPrimaryTarget)!;
  assert.equal(primaryPending.verifiedValue, 0);
  assert.equal(primaryPending.estimatedValue, 2);

  // Now supply 3 verified paying customers -> 100% and achieved!
  const verifiedEvidence: OutcomeEvidenceRecord[] = [
    {
      ...pendingEvidence[0],
      id: 'ev-ver-1',
      structuredMetrics: { customersAcquired: 3 },
      verificationState: 'verified',
      provenanceClass: 'provider_confirmed',
      trustTier: 'provider_verified',
      hasConflict: false,
    },
  ];
  const achieved = computeGoalMetricsAndProgress({
    goal: customerGoal,
    tasks,
    attempts,
    evidence: verifiedEvidence,
  });
  assert.equal(achieved.progressPercent, 100);
  assert.equal(achieved.isGoalAchieved, true);
});

test('Orchestrator rules compute exponential backoff, detect stalled tasks, and plan parallel-safe waves', () => {
  assert.equal(
    computeExponentialBackoffMs({ attemptNumber: 1, backoffBaseMs: 2000 }),
    2000
  );
  assert.equal(
    computeExponentialBackoffMs({ attemptNumber: 2, backoffBaseMs: 2000 }),
    4000
  );
  assert.equal(
    computeExponentialBackoffMs({ attemptNumber: 3, backoffBaseMs: 2000 }),
    8000
  );

  const nowMs = 1_760_000_000_000;
  assert.equal(
    isRetryBackoffElapsed(new Date(nowMs + 5000).toISOString(), nowMs),
    false
  );
  assert.equal(
    isRetryBackoffElapsed(new Date(nowMs - 1000).toISOString(), nowMs),
    true
  );

  const stalled = detectStalledTasks({
    tasks: [
      makeTask({
        id: 't-stalled',
        status: 'running',
        executionTimeoutMs: 10_000,
        startedAt: new Date(nowMs - 30_000).toISOString(),
      }),
      makeTask({
        id: 't-fresh',
        status: 'running',
        executionTimeoutMs: 20_000,
        startedAt: new Date(nowMs - 2_000).toISOString(),
      }),
    ],
    nowMs,
  });
  assert.deepEqual(
    stalled.map((t) => t.id),
    ['t-stalled']
  );

  // Parallel-safe wave picks independent ready tasks tA & tB, while holding dependent tC
  const tA = makeTask({ id: 'tA', stepOrder: 1, dependencies: [] });
  const tB = makeTask({ id: 'tB', stepOrder: 2, dependencies: [] });
  const tC = makeTask({ id: 'tC', stepOrder: 3, dependencies: ['tA', 'tB'] });

  const wave = planExecutionWave({
    goal: { id: 'g-1', status: 'active', executionState: 'running' },
    tasks: [tA, tB, tC],
    concurrencyMode: 'parallel_safe',
    nowMs,
    routingContext: {
      builtInProviders: { llmReasoningReady: true, internalTestReady: true },
      userIntegrations: [],
    },
  });

  assert.deepEqual(
    wave.eligibleBatch.map((i) => i.task.id),
    ['tA', 'tB']
  );
  assert.equal(wave.waitingOnDependenciesCount, 1);
});
