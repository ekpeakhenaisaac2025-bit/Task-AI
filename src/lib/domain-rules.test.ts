import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeResultsReport,
  detectRequiresApproval,
  evaluateTaskEligibility,
  normalizeToolId,
  resolveExecutionRoute,
  validateAndNormalizePlan,
} from './domain-rules.ts';
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  sanitizeEvidencePayload,
} from '../server/crypto-vault.ts';
import {
  isPrivateOrReservedIp,
  validateDestinationUrlSync,
} from '../server/ssrf-guard.ts';
import type {
  ActionLogRecord,
  GoalRecord,
  TaskRecord,
  ToolId,
  ToolRegistryItem,
} from '../types.ts';

test('normalizeToolId supports custom_webhook & n8n_webhook and maps invented tools to unsupported', () => {
  assert.equal(normalizeToolId('llm_reasoning'), 'llm_reasoning');
  assert.equal(normalizeToolId('internal_test_tool'), 'internal_test_tool');
  assert.equal(normalizeToolId('n8n_webhook'), 'n8n_webhook');
  assert.equal(normalizeToolId('custom_webhook'), 'custom_webhook');
  assert.equal(normalizeToolId('hubspot_magic_scraper'), 'unsupported');
  assert.equal(normalizeToolId('apollo_io'), 'unsupported');
  assert.equal(normalizeToolId(''), 'unsupported');
});

test('detectRequiresApproval flags money, messaging, external webhooks, and contacting people', () => {
  assert.equal(
    detectRequiresApproval({
      tool: 'llm_reasoning',
      actionCategory: 'message_draft',
      description: 'Draft 3 cold outreach message templates for SaaS founders',
      llmFlaggedApproval: false,
    }),
    false
  );

  assert.equal(
    detectRequiresApproval({
      tool: 'llm_reasoning',
      actionCategory: 'analysis',
      description: 'Send cold outreach emails to 25 SaaS founders',
      llmFlaggedApproval: false,
    }),
    true
  );

  assert.equal(
    detectRequiresApproval({
      tool: 'custom_webhook',
      actionCategory: 'external_workflow',
      description: 'Trigger user custom HTTPS webhook',
      llmFlaggedApproval: false,
    }),
    true
  );

  assert.equal(
    detectRequiresApproval({
      tool: 'llm_reasoning',
      actionCategory: 'analysis',
      description: 'Purchase LinkedIn paid ads budget of $200',
      llmFlaggedApproval: false,
    }),
    true
  );
});

test('validateAndNormalizePlan maps step dependencies, preserves required_capabilities, and rejects circular dependencies', () => {
  let counter = 0;
  const nextId = () => `uuid-task-${++counter}`;

  const plan = validateAndNormalizePlan(
    [
      {
        step_id: 'step_1',
        description: 'Define ideal customer profile criteria',
        tool: 'llm_reasoning',
        required_capabilities: ['ai_reasoning', 'prospect_qualification'],
        action_category: 'analysis',
        dependencies: [],
        approval_required: false,
        expected_result: 'Structured ICP rubric',
        verification_method: 'Validate JSON output fields',
      },
      {
        step_id: 'step_2',
        description: 'Send outreach messages to qualified prospects',
        tool: 'n8n_webhook',
        required_capabilities: ['workflow_automation', 'message_dispatch'],
        action_category: 'message_send',
        dependencies: ['step_1'],
        approval_required: false,
        expected_result: 'Provider dispatch receipt',
        verification_method: 'Verify webhook 200 and message provider ID',
      },
    ],
    'goal-123',
    nextId
  );

  assert.equal(plan.length, 2);
  assert.equal(plan[0].id, 'uuid-task-1');
  assert.deepEqual(plan[0].requiredCapabilities, [
    'ai_reasoning',
    'prospect_qualification',
  ]);
  assert.equal(plan[1].id, 'uuid-task-2');
  assert.deepEqual(plan[1].dependencies, ['uuid-task-1']);
  assert.deepEqual(plan[1].requiredCapabilities, [
    'workflow_automation',
    'message_dispatch',
  ]);
  assert.equal(plan[1].approvalRequired, true);
  assert.equal(plan[1].approvalStatus, 'pending');
  assert.ok(plan[1].proposedActionDetails !== null);

  assert.throws(() => {
    validateAndNormalizePlan(
      [
        {
          step_id: 'step_1',
          description: 'Task A',
          tool: 'llm_reasoning',
          dependencies: ['step_2'],
          expected_result: 'Result A',
          verification_method: 'Check A',
        },
        {
          step_id: 'step_2',
          description: 'Task B',
          tool: 'llm_reasoning',
          dependencies: ['step_1'],
          expected_result: 'Result B',
          verification_method: 'Check B',
        },
      ],
      'goal-123',
      () => `id-${++counter}`
    );
  }, /circular task dependencies/i);
});

test('resolveExecutionRoute routes tasks integration-independently per user capabilities without requiring n8n', () => {
  // Case A: User has NO n8n configured, but connected a verified custom_webhook with matching capabilities!
  const fallbackRoute = resolveExecutionRoute({
    task: {
      tool: 'n8n_webhook',
      requiredCapabilities: ['workflow_automation', 'message_dispatch'],
    },
    builtInProviders: { llmReasoningReady: true, internalTestReady: true },
    userIntegrations: [
      {
        id: 'int-user-a-webhook',
        providerKey: 'custom_webhook',
        displayName: 'Make.com Outreach Endpoint',
        capabilities: ['workflow_automation', 'message_dispatch', 'http_request'],
        enabled: true,
        verified: true,
        connectionMode: 'user_owned',
      },
    ],
  });

  assert.equal(fallbackRoute.routable, true);
  if (fallbackRoute.routable) {
    assert.equal(fallbackRoute.providerKey, 'custom_webhook');
    assert.equal(fallbackRoute.integrationId, 'int-user-a-webhook');
  }

  // Case B: User has an enabled integration, but it is NOT connection-verified -> must NOT execute
  const unverifiedRoute = resolveExecutionRoute({
    task: {
      tool: 'n8n_webhook',
      requiredCapabilities: ['workflow_automation'],
    },
    builtInProviders: { llmReasoningReady: true, internalTestReady: true },
    userIntegrations: [
      {
        id: 'int-unverified',
        providerKey: 'n8n_webhook',
        displayName: 'Unverified Tenant n8n',
        capabilities: ['workflow_automation'],
        enabled: true,
        verified: false,
        connectionMode: 'user_owned',
      },
    ],
  });
  assert.equal(unverifiedRoute.routable, false);
  if (!unverifiedRoute.routable) {
    assert.equal(unverifiedRoute.code, 'tool_unconfigured');
    assert.match(unverifiedRoute.reason, /connection test/i);
  }

  // Case C: User has zero external integrations -> built-in LLM & internal test still route cleanly!
  const llmRoute = resolveExecutionRoute({
    task: {
      tool: 'llm_reasoning',
      requiredCapabilities: ['ai_reasoning'],
    },
    builtInProviders: { llmReasoningReady: true, internalTestReady: true },
    userIntegrations: [],
  });
  assert.equal(llmRoute.routable, true);
});

test('evaluateTaskEligibility blocks unmet dependencies, unapproved tasks, and unconfigured tenant providers', () => {
  const toolStatusMap = new Map<
    ToolId,
    { configured: boolean; verified: boolean; statusDetail: string }
  >([
    [
      'llm_reasoning',
      { configured: true, verified: true, statusDetail: 'Gemini ready' },
    ],
    [
      'internal_test_tool',
      { configured: true, verified: true, statusDetail: 'Internal tool ready' },
    ],
    [
      'n8n_webhook',
      {
        configured: false,
        verified: false,
        statusDetail: 'No verified n8n integration in workspace.',
      },
    ],
  ]);

  const tasksById = new Map<
    string,
    {
      id: string;
      stepOrder: number;
      description: string;
      status: TaskRecord['status'];
    }
  >([
    [
      't1',
      {
        id: 't1',
        stepOrder: 1,
        description: 'Prerequisite step',
        status: 'queued',
      },
    ],
  ]);

  const unmetResult = evaluateTaskEligibility({
    task: {
      id: 't2',
      status: 'queued',
      tool: 'llm_reasoning',
      dependencies: ['t1'],
      approvalRequired: false,
      approvalStatus: 'not_required',
      retryCount: 0,
    },
    goalStatus: 'active',
    tasksById,
    toolStatusMap,
  });
  assert.equal(unmetResult.eligible, false);

  tasksById.set('t1', {
    id: 't1',
    stepOrder: 1,
    description: 'Prerequisite step',
    status: 'completed',
  });

  const unapprovedResult = evaluateTaskEligibility({
    task: {
      id: 't2',
      status: 'queued',
      tool: 'internal_test_tool',
      dependencies: ['t1'],
      approvalRequired: true,
      approvalStatus: 'pending',
      retryCount: 2,
    },
    goalStatus: 'active',
    tasksById,
    toolStatusMap,
  });
  assert.equal(unapprovedResult.eligible, false);
  if (!unapprovedResult.eligible) {
    assert.equal(unapprovedResult.code, 'approval_pending');
  }
});

test('SSRF guard blocks loopback, RFC1918 private IPs, cloud metadata, non-HTTPS, and URL query secrets', () => {
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('10.12.0.5'), true);
  assert.equal(isPrivateOrReservedIp('172.20.1.4'), true);
  assert.equal(isPrivateOrReservedIp('192.168.1.10'), true);
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);

  assert.equal(
    validateDestinationUrlSync('http://hooks.example.com/webhook').valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://127.0.0.1:5678/webhook/test').valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://169.254.169.254/computeMetadata/v1/')
      .valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://metadata.google.internal/v1').valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://user:pass@hooks.example.com/w').valid,
    false
  );
  assert.equal(
    validateDestinationUrlSync('https://hooks.example.com/w?api_key=shhh').valid,
    false
  );

  const validHttps = validateDestinationUrlSync(
    'https://automations.example.com/webhook/tenant-a-flow'
  );
  assert.equal(validHttps.valid, true);
  assert.equal(validHttps.origin, 'https://automations.example.com');
});

test('crypto-vault encrypts/decrypts credentials with AES-256-GCM and scrubs secrets from log payloads', () => {
  const rawSecret = 'whsec_super_secret_tenant_credential_9876';
  const encrypted = encryptIntegrationSecret(rawSecret);

  assert.notEqual(encrypted.ciphertextBase64, rawSecret);
  assert.equal(encrypted.maskedHint, '••••••••9876');

  const decrypted = decryptIntegrationSecret(encrypted);
  assert.equal(decrypted, rawSecret);

  const scrubbed = sanitizeEvidencePayload({
    provider: 'n8n_webhook',
    httpStatus: 200,
    webhookSecret: rawSecret,
    nested: {
      authorization: 'Bearer secret123',
      workflowId: 'wf_42',
    },
  });
  assert.equal(scrubbed.webhookSecret, '[REDACTED]');
  assert.equal(
    (scrubbed.nested as Record<string, unknown>).authorization,
    '[REDACTED]'
  );
  assert.equal(
    (scrubbed.nested as Record<string, unknown>).workflowId,
    'wf_42'
  );
});

test('computeResultsReport never counts drafted messages as sent or delivered and never fabricates revenue', () => {
  const goals: GoalRecord[] = [
    {
      id: 'g1',
      userId: 'u1',
      workspaceId: 'ws-1',
      problem: 'I need more paying customers for my business.',
      description: 'I need more paying customers for my business.',
      targetMetric: 'Acquire 3 paying customers.',
      deadline: '2026-12-31T00:00:00.000Z',
      status: 'active',
      executionState: 'idle',
      progressPercent: 0,
      achievedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const tasks: TaskRecord[] = [
    {
      id: 't-draft',
      goalId: 'g1',
      userId: 'u1',
      workspaceId: 'ws-1',
      stepOrder: 1,
      description: 'Draft 3 outreach emails',
      tool: 'llm_reasoning',
      requiredCapabilities: ['ai_reasoning', 'content_drafting'],
      assignedProvider: 'built_in:llm_reasoning',
      assignedIntegrationId: null,
      actionCategory: 'message_draft',
      dependencies: [],
      approvalRequired: false,
      approvalStatus: 'not_required',
      approvalDecisionAt: null,
      approvalDecisionBy: null,
      proposedActionDetails: null,
      expectedResult: '3 outreach message drafts',
      verificationMethod: 'Non-empty draft array',
      status: 'completed',
      verificationStatus: 'unverified',
      reconciliationRequired: false,
      statusReason: null,
      outputData: {
        draftedMessages: [
          { subject: 'A', body: 'Hello 1' },
          { subject: 'B', body: 'Hello 2' },
          { subject: 'C', body: 'Hello 3' },
        ],
      },
      lockedBy: null,
      lockedAt: null,
      retryCount: 0,
      maxRetries: 2,
      backoffBaseMs: 2000,
      nextRetryAt: null,
      executionTimeoutMs: 20000,
      startedAt: null,
      completedAt: new Date().toISOString(),
      verifiedAt: null,
      lastDurationMs: 120,
      idempotencyKey: 'g1:t-draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 't-blocked',
      goalId: 'g1',
      userId: 'u1',
      workspaceId: 'ws-1',
      stepOrder: 2,
      description: 'Send outreach via external provider',
      tool: 'n8n_webhook',
      requiredCapabilities: ['workflow_automation', 'message_dispatch'],
      assignedProvider: null,
      assignedIntegrationId: null,
      actionCategory: 'message_send',
      dependencies: ['t-draft'],
      approvalRequired: true,
      approvalStatus: 'approved',
      approvalDecisionAt: new Date().toISOString(),
      approvalDecisionBy: 'u1',
      proposedActionDetails: {
        proposedAction: 'Send 3 outreach emails',
        targetRecipient: 'Qualified prospects',
        estimatedCost: '$0.00',
        explanation: 'Contacts external people',
      },
      expectedResult: 'Sent confirmation',
      verificationMethod: 'Provider receipt',
      status: 'blocked',
      verificationStatus: 'unverified',
      reconciliationRequired: false,
      statusReason: 'No verified external provider in workspace',
      outputData: null,
      lockedBy: null,
      lockedAt: null,
      retryCount: 0,
      maxRetries: 2,
      backoffBaseMs: 2000,
      nextRetryAt: null,
      executionTimeoutMs: 20000,
      startedAt: null,
      completedAt: null,
      verifiedAt: null,
      lastDurationMs: null,
      idempotencyKey: 'g1:t-blocked',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const actionLogs: ActionLogRecord[] = [];
  const tools: ToolRegistryItem[] = [
    {
      id: 'n8n_webhook',
      name: 'n8n Workflow Provider',
      scope: 'tenant_configurable',
      description: 'Optional per-workspace n8n execution provider',
      capabilities: ['workflow_automation', 'message_dispatch'],
      authenticationMethod: 'HMAC-SHA256 / Bearer',
      executionInterface: 'https_json_webhook',
      verificationCapabilities: ['evidence_based', 'human_review'],
      healthStatus: 'unconfigured',
      rateLimit: { requestsPerMinute: 120, burstLimit: 20 },
      supportedOperations: ['isolated_workflow_dispatch'],
      integrationClassification: 'generic_webhook_adapter',
      implementationStatus: 'implemented_and_tested',
      configured: false,
      verified: false,
      statusDetail: 'No n8n integration configured for this workspace.',
      lastTestedAt: null,
    },
  ];

  const report = computeResultsReport({ goals, tasks, actionLogs, tools });
  assert.equal(report.metrics.messagesDrafted, 3);
  assert.equal(report.metrics.messagesSent, 0);
  assert.equal(report.metrics.messagesDeliveredVerified, 0);
  assert.equal(report.metrics.revenueEarnedUsd, 0);
  assert.equal(report.metrics.blockedTasks, 1);
  assert.equal(report.missingConfigurations.length, 1);
  assert.equal(report.goalComparisons[0].deadline, '2026-12-31T00:00:00.000Z');
});
