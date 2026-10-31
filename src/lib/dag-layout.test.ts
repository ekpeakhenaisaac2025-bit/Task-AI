import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeGoalDagLayout,
  matchesDagFilter,
} from './dag-layout';
import type { TaskRecord, ToolRegistryItem } from '../types';

function makeTask(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  const now = '2026-10-30T16:00:00.000Z';
  return {
    id: overrides.id,
    goalId: overrides.goalId ?? 'goal-1',
    userId: overrides.userId ?? 'user-1',
    workspaceId: overrides.workspaceId ?? 'ws-1',
    stepOrder: overrides.stepOrder ?? 1,
    description: overrides.description ?? `Task ${overrides.id}`,
    tool: overrides.tool ?? 'internal_test_tool',
    requiredCapabilities: overrides.requiredCapabilities ?? [
      'diagnostic_verification',
    ],
    assignedProvider: overrides.assignedProvider ?? null,
    assignedIntegrationId: overrides.assignedIntegrationId ?? null,
    actionCategory: overrides.actionCategory ?? 'internal_test',
    dependencies: overrides.dependencies ?? [],
    approvalRequired: overrides.approvalRequired ?? false,
    approvalStatus: overrides.approvalStatus ?? 'not_required',
    approvalDecisionAt: overrides.approvalDecisionAt ?? null,
    approvalDecisionBy: overrides.approvalDecisionBy ?? null,
    proposedActionDetails: overrides.proposedActionDetails ?? null,
    expectedResult: overrides.expectedResult ?? 'Expected output',
    verificationMethod: overrides.verificationMethod ?? 'Deterministic check',
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
    executionTimeoutMs: overrides.executionTimeoutMs ?? 30000,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    verifiedAt: overrides.verifiedAt ?? null,
    lastDurationMs: overrides.lastDurationMs ?? null,
    idempotencyKey: overrides.idempotencyKey ?? `goal-1:${overrides.id}`,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

const SAMPLE_TOOLS: ToolRegistryItem[] = [
  {
    id: 'internal_test_tool',
    name: 'Internal Diagnostic Runtime',
    scope: 'built_in',
    description: 'Deterministic runtime',
    capabilities: ['diagnostic_verification'],
    authenticationMethod: 'Built-in',
    executionInterface: 'built_in_runtime',
    verificationCapabilities: ['deterministic'],
    healthStatus: 'healthy',
    rateLimit: { requestsPerMinute: 120, burstLimit: 30 },
    supportedOperations: ['verify'],
    integrationClassification: 'native_implemented',
    implementationStatus: 'implemented_and_tested',
    configured: true,
    verified: true,
    statusDetail: 'Ready',
    lastTestedAt: null,
  },
  {
    id: 'custom_webhook',
    name: 'Custom HTTPS Webhook',
    scope: 'tenant_configurable',
    description: 'External HTTPS webhook',
    capabilities: ['workflow_automation', 'http_request'],
    authenticationMethod: 'HMAC',
    executionInterface: 'https_json_webhook',
    verificationCapabilities: ['evidence_based'],
    healthStatus: 'unconfigured',
    rateLimit: { requestsPerMinute: 60, burstLimit: 10 },
    supportedOperations: ['dispatch'],
    integrationClassification: 'generic_webhook_adapter',
    implementationStatus: 'implemented_requires_external_credentials',
    configured: false,
    verified: false,
    statusDetail: 'Connect in Integrations',
    lastTestedAt: null,
  },
];

test('computeGoalDagLayout returns empty layout cleanly when goal has zero tasks', () => {
  const layout = computeGoalDagLayout({
    tasks: [],
    goalStatus: 'active',
    tools: SAMPLE_TOOLS,
  });

  assert.equal(layout.nodes.length, 0);
  assert.equal(layout.edges.length, 0);
  assert.equal(layout.waves.length, 0);
  assert.equal(layout.summary.totalNodes, 0);
});

test('computeGoalDagLayout assigns diamond DAG waves, non-overlapping coordinates, and lineage sets', () => {
  const t1 = makeTask({
    id: 't1',
    stepOrder: 1,
    status: 'verified',
    verificationStatus: 'verified',
  });
  const t2 = makeTask({
    id: 't2',
    stepOrder: 2,
    dependencies: ['t1'],
    status: 'queued',
  });
  const t3 = makeTask({
    id: 't3',
    stepOrder: 3,
    dependencies: ['t1'],
    approvalRequired: true,
    approvalStatus: 'pending',
    status: 'queued',
  });
  const t4 = makeTask({
    id: 't4',
    stepOrder: 4,
    dependencies: ['t2', 't3'],
    status: 'queued',
  });

  const layout = computeGoalDagLayout({
    tasks: [t1, t2, t3, t4],
    goalStatus: 'active',
    tools: SAMPLE_TOOLS,
  });

  assert.equal(layout.waves.length, 3);
  assert.deepEqual(layout.waves[0].nodeIds, ['t1']);
  assert.deepEqual(layout.waves[1].nodeIds, ['t2', 't3']);
  assert.deepEqual(layout.waves[2].nodeIds, ['t4']);
  assert.equal(layout.edges.length, 4);

  // Verify zero bounding-box overlap across all nodes
  for (let i = 0; i < layout.nodes.length; i++) {
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i];
      const b = layout.nodes[j];
      const overlapsX = a.x < b.x + b.width && a.x + a.width > b.x;
      const overlapsY = a.y < b.y + b.height && a.y + a.height > b.y;
      assert.equal(
        overlapsX && overlapsY,
        false,
        `Nodes ${a.id} and ${b.id} must not overlap`
      );
    }
  }

  // Verify states: t1 verified, t2 ready, t3 blocked by approval, t4 waiting on t2 & t3
  assert.equal(layout.nodesById.t1.visualState, 'verified');
  assert.equal(layout.nodesById.t2.visualState, 'ready');
  assert.equal(layout.nodesById.t2.isReady, true);
  assert.equal(layout.nodesById.t3.visualState, 'blocked');
  assert.equal(layout.nodesById.t3.isHardBlocked, true);
  assert.equal(layout.nodesById.t3.primaryIssue?.code, 'approval_pending');
  assert.equal(layout.nodesById.t4.visualState, 'waiting');
  assert.equal(layout.nodesById.t4.isWaitingUpstream, true);

  // Verify lineage sets
  assert.deepEqual(layout.nodesById.t4.ancestorIds.sort(), ['t1', 't2', 't3']);
  assert.deepEqual(layout.nodesById.t1.descendantIds.sort(), ['t2', 't3', 't4']);

  // Verify edge states
  const e12 = layout.edges.find((e) => e.id === 't1->t2');
  const e34 = layout.edges.find((e) => e.id === 't3->t4');
  assert.equal(e12?.state, 'satisfied');
  assert.equal(e34?.state, 'blocking');

  // Filter helpers
  assert.equal(matchesDagFilter(layout.nodesById.t3, 'blocking'), true);
  assert.equal(matchesDagFilter(layout.nodesById.t2, 'blocking'), false);
  assert.equal(matchesDagFilter(layout.nodesById.t2, 'ready'), true);
  assert.equal(matchesDagFilter(layout.nodesById.t1, 'completed'), true);
});

test('computeGoalDagLayout detects unconfigured external provider and upstream cascade failure', () => {
  const upstreamFailed = makeTask({
    id: 'up-fail',
    stepOrder: 1,
    status: 'failed',
    retryCount: 3,
    maxRetries: 2,
    statusReason: 'Remote webhook returned HTTP 502',
  });
  const downstreamWebhook = makeTask({
    id: 'down-wh',
    stepOrder: 2,
    tool: 'custom_webhook',
    requiredCapabilities: ['workflow_automation', 'http_request'],
    dependencies: ['up-fail'],
    approvalRequired: true,
    approvalStatus: 'approved',
    status: 'queued',
  });

  const layout = computeGoalDagLayout({
    tasks: [upstreamFailed, downstreamWebhook],
    goalStatus: 'active',
    tools: SAMPLE_TOOLS,
  });

  const upNode = layout.nodesById['up-fail'];
  const downNode = layout.nodesById['down-wh'];

  assert.equal(upNode.visualState, 'failed');
  assert.equal(upNode.primaryIssue?.code, 'execution_failed');

  assert.equal(downNode.isHardBlocked, true);
  assert.equal(downNode.visualState, 'failed');
  const issueCodes = downNode.blockingIssues.map((i) => i.code);
  assert.ok(issueCodes.includes('failed_dependency'));
  assert.ok(issueCodes.includes('provider_unconfigured'));
});

test('computeGoalDagLayout handles unexpected circular dependencies gracefully without throwing', () => {
  const cycA = makeTask({
    id: 'cyc-a',
    stepOrder: 1,
    dependencies: ['cyc-b'],
  });
  const cycB = makeTask({
    id: 'cyc-b',
    stepOrder: 2,
    dependencies: ['cyc-a'],
  });

  const layout = computeGoalDagLayout({
    tasks: [cycA, cycB],
    goalStatus: 'active',
    tools: SAMPLE_TOOLS,
  });

  assert.equal(layout.summary.cycleDetected, true);
  assert.equal(layout.nodesById['cyc-a'].inCycle, true);
  assert.equal(layout.nodesById['cyc-b'].inCycle, true);
  assert.equal(
    layout.edges.some((e) => e.isBackEdge && e.state === 'cycle'),
    true
  );
});

test('computeGoalDagLayout flags reconciliationRequired tasks with critical reconciliation_required issue', () => {
  const uncertain = makeTask({
    id: 'uncertain-1',
    stepOrder: 1,
    status: 'blocked',
    reconciliationRequired: true,
    statusReason: 'Outbound webhook timed out after socket write',
  });
  const layout = computeGoalDagLayout({
    tasks: [uncertain],
    goalStatus: 'active',
    tools: SAMPLE_TOOLS,
  });

  const node = layout.nodesById['uncertain-1'];
  assert.equal(node.isHardBlocked, true);
  assert.equal(node.primaryIssue?.code, 'reconciliation_required');
  assert.equal(node.primaryIssue?.remediation, 'reconcile_task');
});
