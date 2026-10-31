import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArtifactsForTurn,
  buildHonestExecutionTrace,
  deriveConversationTitle,
  detectComplexExecutionIntent,
  normalizeChatModel,
  parseCsvPreviewRows,
  sanitizeMessageAttachments,
} from './chat-utils.ts';
import type { GoalRecord, OutcomeEvidenceRecord, TaskRecord } from '../types.ts';

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  const now = new Date().toISOString();
  return {
    id: 'goal_test_1',
    userId: 'user_1',
    workspaceId: 'ws_1',
    problem: 'Launch B2B SaaS outbound campaign to acquire 5 qualified leads',
    description: 'Launch B2B SaaS outbound campaign to acquire 5 qualified leads',
    targetMetric: '5 qualified leads',
    deadline: null,
    status: 'active',
    executionState: 'running',
    progressPercent: 0,
    achievedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: 'task_1',
    goalId: 'goal_test_1',
    userId: 'user_1',
    workspaceId: 'ws_1',
    stepOrder: 1,
    description: 'Define ICP qualification rubric',
    tool: 'llm_reasoning',
    requiredCapabilities: ['ai_reasoning', 'prospect_qualification'],
    assignedProvider: 'Built-in Gemini Reasoning',
    assignedIntegrationId: null,
    actionCategory: 'prospect_qualification',
    dependencies: [],
    approvalRequired: false,
    approvalStatus: 'not_required',
    approvalDecisionAt: null,
    approvalDecisionBy: null,
    proposedActionDetails: null,
    expectedResult: 'Persisted ICP qualification rubric',
    verificationMethod: 'Artifact persisted in workspace',
    status: 'completed',
    verificationStatus: 'unverified',
    statusReason: 'Drafted rubric saved',
    outputData: {
      keyCriteria: ['ARR > $1M', 'B2B SaaS'],
      deliverable: '## ICP Rubric\nTarget VP Operations at Series A SaaS firms.',
      verificationCheck: 'Check rubric completeness',
    },
    lockedBy: null,
    lockedAt: null,
    retryCount: 0,
    maxRetries: 2,
    backoffBaseMs: 2000,
    nextRetryAt: null,
    executionTimeoutMs: 20000,
    startedAt: now,
    completedAt: now,
    verifiedAt: null,
    lastDurationMs: 420,
    reconciliationRequired: false,
    idempotencyKey: 'idem_1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('deriveConversationTitle strips markdown syntax and truncates cleanly on word boundaries', () => {
  assert.equal(deriveConversationTitle('   '), 'New conversation');
  assert.equal(
    deriveConversationTitle('### **Acquire 10 enterprise customers**!'),
    'Acquire 10 enterprise customers'
  );
  const longTitle = deriveConversationTitle(
    'Launch a comprehensive multi-channel B2B lead generation and qualification workflow across EMEA accounts'
  );
  assert.ok(longTitle.length <= 56);
  assert.ok(longTitle.endsWith('...'));
});

test('normalizeChatModel enforces supported server-side Gemini Flash models', () => {
  assert.equal(normalizeChatModel('gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(
    normalizeChatModel('gemini-3.1-flash-lite'),
    'gemini-3.1-flash-lite'
  );
  assert.equal(normalizeChatModel('gemini-flash-latest'), 'gemini-flash-latest');
  assert.equal(normalizeChatModel('gemini-1.5-pro'), 'gemini-3.8-flash');
  assert.equal(normalizeChatModel(undefined), 'gemini-3.8-flash');
});

test('detectComplexExecutionIntent distinguishes Q&A from actionable multi-step execution requests', () => {
  const qa = detectComplexExecutionIntent(
    'Explain how HMAC-SHA256 replay protection works in webhooks'
  );
  assert.equal(qa.shouldExecute, false);

  const exec = detectComplexExecutionIntent(
    'Launch an outreach campaign to acquire 5 qualified leads this month and prepare CRM sync'
  );
  assert.equal(exec.shouldExecute, true);
  assert.match(exec.inferredTargetMetric, /5 qualified leads/i);

  const forcedExec = detectComplexExecutionIntent('Draft an outreach plan', 'execute');
  assert.equal(forcedExec.shouldExecute, true);

  const forcedChat = detectComplexExecutionIntent(
    'Launch an outreach campaign to acquire 5 leads',
    'chat'
  );
  assert.equal(forcedChat.shouldExecute, false);
});

test('buildHonestExecutionTrace never marks objectives completed when tasks await approval or lack verified evidence', () => {
  const goal = makeGoal({ status: 'active', progressPercent: 0 });
  const step1 = makeTask({ stepOrder: 1, status: 'completed' });
  const step2 = makeTask({
    id: 'task_2',
    stepOrder: 2,
    description: 'Dispatch outbound campaign via webhook',
    tool: 'custom_webhook',
    actionCategory: 'message_send',
    approvalRequired: true,
    approvalStatus: 'pending',
    status: 'queued',
    outputData: null,
  });

  const trace = buildHonestExecutionTrace({
    goal,
    tasks: [step1, step2],
    evidence: [],
  });

  assert.equal(trace.stages.length, 7);
  assert.equal(trace.hasVerifiedBusinessOutcome, false);
  assert.equal(trace.awaitingApprovalCount, 1);

  const execStage = trace.stages.find((s) => s.key === 'execution')!;
  const resultsStage = trace.stages.find((s) => s.key === 'completed_results')!;
  assert.equal(execStage.status, 'awaiting_approval');
  assert.equal(resultsStage.status, 'awaiting_approval');
  assert.match(resultsStage.summary, /Approval Gate/i);

  // Internal diagnostic evidence alone must NOT count as verified business outcome
  const diagEvidence: OutcomeEvidenceRecord = {
    id: 'ev_diag',
    userId: 'user_1',
    workspaceId: 'ws_1',
    goalId: goal.id,
    taskId: step1.id,
    inboundEventId: null,
    sourceType: 'deterministic_execution',
    provider: 'internal_test_tool',
    evidenceType: 'diagnostic_checksum',
    externalReferenceId: 'sha256_abc',
    summary: 'SHA-256 verified',
    structuredMetrics: { diagnosticPass: 1 },
    sanitizedPayload: {},
    provenanceClass: 'internal_diagnostic',
    trustTier: 'diagnostic_only',
    hasConflict: false,
    requiresHumanReview: false,
    verificationState: 'verified',
    observedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  const traceWithDiag = buildHonestExecutionTrace({
    goal,
    tasks: [step1],
    evidence: [diagEvidence],
  });
  assert.equal(traceWithDiag.hasVerifiedBusinessOutcome, false);
  assert.equal(
    traceWithDiag.stages.find((s) => s.key === 'completed_results')!.status,
    'pending_verification'
  );
});

test('buildArtifactsForTurn extracts spreadsheet plan, strategy document, and outreach drafts honestly', () => {
  const goal = makeGoal();
  const step1 = makeTask();
  const step2 = makeTask({
    id: 'task_2',
    stepOrder: 2,
    description: 'Draft 2 outreach emails',
    actionCategory: 'message_draft',
    outputData: {
      deliveryState: 'drafted_only_not_sent',
      draftedMessages: [
        {
          targetPersona: 'VP Engineering',
          subjectLine: 'Audit-ready execution workflows',
          messageBody: 'Hi Alex, sharing our rubric...',
        },
      ],
    },
  });

  const artifacts = buildArtifactsForTurn({
    conversationId: 'conv_1',
    messageId: 'msg_1',
    userId: 'user_1',
    workspaceId: 'ws_1',
    goal,
    tasks: [step1, step2],
    assistantMarkdown: 'Completed initial planning and drafts.',
  });

  assert.equal(artifacts.length, 3);
  assert.equal(artifacts[0].artifactType, 'spreadsheet');
  assert.equal(artifacts[0].mimeType, 'text/csv');
  assert.equal(artifacts[1].artifactType, 'document');
  assert.equal(artifacts[2].artifactType, 'outreach_draft');
  assert.match(artifacts[2].content, /0 messages sent/);
});

test('parseCsvPreviewRows and sanitizeMessageAttachments handle quoted CSVs and base64 images', () => {
  const parsed = parseCsvPreviewRows(
    'Step,Description,Status\n1,"Define ICP, ""Tier 1""",completed\n2,Send webhook,queued'
  );
  assert.deepEqual(parsed.headers, ['Step', 'Description', 'Status']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0][1], 'Define ICP, "Tier 1"');

  const validPngDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const sanitized = sanitizeMessageAttachments([
    {
      id: 'att_1',
      name: 'diagram.png',
      mimeType: 'image/png',
      sizeBytes: 96,
      kind: 'image',
      dataUrl: validPngDataUrl,
    },
    {
      id: 'att_bad',
      name: 'xss.png',
      mimeType: 'image/png',
      sizeBytes: 50,
      kind: 'image',
      dataUrl: 'javascript:alert(1)',
    },
  ]);

  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[0].dataUrl, validPngDataUrl);
  assert.equal(sanitized[1].dataUrl, undefined);
});
