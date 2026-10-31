import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  CapabilityId,
  CapabilityReadinessState,
  ChatAttachmentRecord,
  ChatExecutionTrace,
  IntegrationPublicMetadata,
  ProposedActionDetails,
  WorkforceConnectorRecommendation,
} from '../types.ts';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const userIntegrations = pgTable(
  'user_integrations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    providerKey: text('provider_key').notNull(),
    displayName: text('display_name').notNull(),
    connectionMode: text('connection_mode').notNull().default('user_owned'),
    connectorType: text('connector_type').notNull().default('webhook'),
    connectorCategory: text('connector_category').notNull().default('webhooks'),
    authStatus: text('auth_status').notNull().default('configured'),
    grantedScopes: jsonb('granted_scopes')
      .$type<string[]>()
      .notNull()
      .default([]),
    healthStatus: text('health_status').notNull().default('untested'),
    capabilities: jsonb('capabilities')
      .$type<CapabilityId[]>()
      .notNull()
      .default([]),
    configMetadata: jsonb('config_metadata')
      .$type<IntegrationPublicMetadata>()
      .notNull(),
    encryptedSecret: text('encrypted_secret'),
    secretIv: text('secret_iv'),
    secretAuthTag: text('secret_auth_tag'),
    secretMaskedHint: text('secret_masked_hint'),
    enabled: boolean('enabled').notNull().default(true),
    verified: boolean('verified').notNull().default(false),
    statusDetail: text('status_detail')
      .notNull()
      .default('Saved. Run a connection test before executing tasks.'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    lastErrorMessage: text('last_error_message'),
    rateLimitRpm: integer('rate_limit_rpm').notNull().default(60),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_user_integrations_workspace').on(
      table.userId,
      table.workspaceId
    ),
  ]
);

export const workspaceInboundConfigs = pgTable(
  'workspace_inbound_configs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    encryptedSigningSecret: text('encrypted_signing_secret').notNull(),
    secretIv: text('secret_iv').notNull(),
    secretAuthTag: text('secret_auth_tag').notNull(),
    secretMaskedHint: text('secret_masked_hint').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_inbound_configs_user_ws').on(table.userId, table.workspaceId),
  ]
);

export const goals = pgTable(
  'goals',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid)
      .notNull(),
    workspaceId: text('workspace_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    problem: text('problem').notNull(),
    targetMetric: text('target_metric').notNull(),
    deadline: timestamp('deadline', { withTimezone: true }),
    status: text('status').notNull().default('draft'),
    executionState: text('execution_state').notNull().default('idle'),
    progressPercent: integer('progress_percent').notNull().default(0),
    achievedAt: timestamp('achieved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_goals_tenant_status').on(
      table.userId,
      table.workspaceId,
      table.status
    ),
  ]
);

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .references(() => goals.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.uid)
      .notNull(),
    workspaceId: text('workspace_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    stepOrder: integer('step_order').notNull().default(1),
    description: text('description').notNull(),
    tool: text('tool').notNull(),
    requiredCapabilities: jsonb('required_capabilities')
      .$type<CapabilityId[]>()
      .notNull()
      .default([]),
    assignedProvider: text('assigned_provider'),
    assignedIntegrationId: text('assigned_integration_id').references(
      () => userIntegrations.id,
      { onDelete: 'set null' }
    ),
    actionCategory: text('action_category').notNull().default('analysis'),
    dependencies: jsonb('dependencies').$type<string[]>().notNull().default([]),
    approvalRequired: boolean('approval_required').notNull().default(false),
    approvalStatus: text('approval_status').notNull().default('not_required'),
    approvalDecisionAt: timestamp('approval_decision_at', {
      withTimezone: true,
    }),
    approvalDecisionBy: text('approval_decision_by'),
    proposedActionDetails:
      jsonb('proposed_action_details').$type<ProposedActionDetails | null>(),
    expectedResult: text('expected_result').notNull(),
    verificationMethod: text('verification_method').notNull(),
    status: text('status').notNull().default('queued'),
    verificationStatus: text('verification_status')
      .notNull()
      .default('unverified'),
    statusReason: text('status_reason'),
    outputData: jsonb('output_data').$type<Record<string, unknown> | null>(),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    retryCount: integer('retry_count').notNull().default(0),
    maxRetries: integer('max_retries').notNull().default(2),
    backoffBaseMs: integer('backoff_base_ms').notNull().default(2000),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    executionTimeoutMs: integer('execution_timeout_ms')
      .notNull()
      .default(20000),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    lastDurationMs: integer('last_duration_ms'),
    reconciliationRequired: boolean('reconciliation_required')
      .notNull()
      .default(false),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_tasks_tenant_goal_status').on(
      table.userId,
      table.workspaceId,
      table.goalId,
      table.status
    ),
  ]
);

export const executionLocks = pgTable(
  'execution_locks',
  {
    resourceKey: text('resource_key').primaryKey(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    ownerWorkerId: text('owner_worker_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_execution_locks_ws_exp').on(table.workspaceId, table.expiresAt),
  ]
);

export const executionRuns = pgTable(
  'execution_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    goalId: text('goal_id')
      .references(() => goals.id, { onDelete: 'cascade' })
      .notNull(),
    triggerType: text('trigger_type').notNull(),
    status: text('status').notNull(),
    concurrencyMode: text('concurrency_mode')
      .notNull()
      .default('parallel_safe'),
    tasksDispatched: integer('tasks_dispatched').notNull().default(0),
    tasksSucceeded: integer('tasks_succeeded').notNull().default(0),
    tasksFailed: integer('tasks_failed').notNull().default(0),
    summary: text('summary'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
  },
  (table) => [
    index('idx_execution_runs_tenant').on(
      table.workspaceId,
      table.goalId,
      table.startedAt
    ),
  ]
);

export const taskAttempts = pgTable(
  'task_attempts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    goalId: text('goal_id')
      .references(() => goals.id, { onDelete: 'cascade' })
      .notNull(),
    taskId: text('task_id')
      .references(() => tasks.id, { onDelete: 'cascade' })
      .notNull(),
    runId: text('run_id').references(() => executionRuns.id, {
      onDelete: 'set null',
    }),
    attemptNumber: integer('attempt_number').notNull(),
    workerId: text('worker_id').notNull(),
    providerKey: text('provider_key').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    outputSummary: text('output_summary'),
  },
  (table) => [
    index('idx_task_attempts_tenant_task').on(
      table.workspaceId,
      table.taskId,
      table.attemptNumber
    ),
  ]
);

export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    goalId: text('goal_id').references(() => goals.id, {
      onDelete: 'set null',
    }),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),
    externalEventId: text('external_event_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    evidenceType: text('evidence_type').notNull(),
    eventTimestamp: timestamp('event_timestamp', {
      withTimezone: true,
    }).notNull(),
    signatureVerified: boolean('signature_verified').notNull().default(false),
    processingStatus: text('processing_status').notNull(),
    sanitizedPayload: jsonb('sanitized_payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_inbound_events_provider_event').on(
      table.workspaceId,
      table.provider,
      table.externalEventId
    ),
    uniqueIndex('uq_inbound_events_idempotency').on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index('idx_inbound_events_ws_received').on(
      table.workspaceId,
      table.receivedAt
    ),
  ]
);

export const outcomeEvidence = pgTable(
  'outcome_evidence',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    goalId: text('goal_id')
      .references(() => goals.id, { onDelete: 'cascade' })
      .notNull(),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'cascade',
    }),
    inboundEventId: text('inbound_event_id')
      .references(() => inboundEvents.id, { onDelete: 'set null' })
      .unique(),
    sourceType: text('source_type').notNull(),
    provider: text('provider').notNull(),
    evidenceType: text('evidence_type').notNull(),
    externalReferenceId: text('external_reference_id'),
    summary: text('summary').notNull(),
    structuredMetrics: jsonb('structured_metrics')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    sanitizedPayload: jsonb('sanitized_payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    provenanceClass: text('provenance_class')
      .notNull()
      .default('unverified_claim'),
    trustTier: text('trust_tier').notNull().default('untrusted'),
    hasConflict: boolean('has_conflict').notNull().default(false),
    requiresHumanReview: boolean('requires_human_review')
      .notNull()
      .default(false),
    verificationState: text('verification_state')
      .notNull()
      .default('pending_verification'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_outcome_evidence_tenant_goal').on(
      table.workspaceId,
      table.goalId,
      table.verificationState
    ),
  ]
);

export const verificationRecords = pgTable(
  'verification_records',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    goalId: text('goal_id')
      .references(() => goals.id, { onDelete: 'cascade' })
      .notNull(),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'cascade',
    }),
    evidenceId: text('evidence_id').references(() => outcomeEvidence.id, {
      onDelete: 'cascade',
    }),
    verificationMethod: text('verification_method').notNull(),
    decision: text('decision').notNull(),
    reviewerIdentity: text('reviewer_identity').notNull(),
    notes: text('notes').notNull(),
    traceMetadata: jsonb('trace_metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    decidedAt: timestamp('decided_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_verification_records_tenant').on(
      table.workspaceId,
      table.goalId,
      table.decidedAt
    ),
  ]
);

export const goalMetricValues = pgTable(
  'goal_metric_values',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    goalId: text('goal_id')
      .references(() => goals.id, { onDelete: 'cascade' })
      .notNull(),
    metricKey: text('metric_key').notNull(),
    metricLabel: text('metric_label').notNull(),
    unit: text('unit').notNull().default('count'),
    isPrimaryTarget: boolean('is_primary_target').notNull().default(false),
    targetValue: doublePrecision('target_value').notNull().default(0),
    attemptedValue: doublePrecision('attempted_value').notNull().default(0),
    completedValue: doublePrecision('completed_value').notNull().default(0),
    verifiedValue: doublePrecision('verified_value').notNull().default(0),
    estimatedValue: doublePrecision('estimated_value').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_goal_metric_key').on(table.goalId, table.metricKey),
    index('idx_goal_metrics_tenant').on(table.workspaceId, table.goalId),
  ]
);

export const reasoningCycles = pgTable(
  'reasoning_cycles',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    goalId: text('goal_id')
      .references(() => goals.id, { onDelete: 'cascade' })
      .notNull(),
    triggerSource: text('trigger_source').notNull(),
    modelUsed: text('model_used').notNull(),
    currentAssessment: text('current_assessment').notNull(),
    goalAchievedRecommendation: boolean('goal_achieved_recommendation')
      .notNull()
      .default(false),
    humanInterventionRequired: boolean('human_intervention_required')
      .notNull()
      .default(false),
    confidenceLevel: text('confidence_level').notNull(),
    reasoningSummary: text('reasoning_summary').notNull(),
    findings: jsonb('findings').$type<string[]>().notNull().default([]),
    recommendedNextActions: jsonb('recommended_next_actions')
      .$type<string[]>()
      .notNull()
      .default([]),
    structuredOutput: jsonb('structured_output')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_reasoning_cycles_tenant').on(
      table.workspaceId,
      table.goalId,
      table.createdAt
    ),
  ]
);

export const nextActionProposals = pgTable(
  'next_action_proposals',
  {
    id: text('id').primaryKey(),
    reasoningCycleId: text('reasoning_cycle_id')
      .references(() => reasoningCycles.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    goalId: text('goal_id')
      .references(() => goals.id, { onDelete: 'cascade' })
      .notNull(),
    proposalType: text('proposal_type').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    proposedTool: text('proposed_tool').notNull(),
    actionCategory: text('action_category').notNull(),
    requiredCapabilities: jsonb('required_capabilities')
      .$type<CapabilityId[]>()
      .notNull()
      .default([]),
    dependencies: jsonb('dependencies').$type<string[]>().notNull().default([]),
    targetTaskId: text('target_task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    approvalRequired: boolean('approval_required').notNull().default(true),
    expectedOutcome: text('expected_outcome').notNull(),
    verificationMethod: text('verification_method').notNull(),
    status: text('status').notNull().default('proposed'),
    enqueuedTaskId: text('enqueued_task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_next_action_proposals_tenant').on(
      table.workspaceId,
      table.goalId,
      table.status
    ),
  ]
);

export const actionLogs = pgTable(
  'action_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid)
      .notNull(),
    workspaceId: text('workspace_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    goalId: text('goal_id')
      .references(() => goals.id, { onDelete: 'cascade' })
      .notNull(),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'cascade',
    }),
    executionProvider: text('execution_provider')
      .notNull()
      .default('legacy_worker'),
    actionType: text('action_type').notNull(),
    status: text('status').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true })
      .defaultNow()
      .notNull(),
    resultSummary: text('result_summary').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown> | null>(),
    errorMessage: text('error_message'),
  },
  (table) => [
    index('idx_action_logs_tenant_ts').on(
      table.userId,
      table.workspaceId,
      table.timestamp
    ),
  ]
);

export const usersRelations = relations(users, ({ many }) => ({
  workspaces: many(workspaces),
  integrations: many(userIntegrations),
  goals: many(goals),
  tasks: many(tasks),
  actionLogs: many(actionLogs),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(users, {
    fields: [workspaces.ownerUserId],
    references: [users.uid],
  }),
  integrations: many(userIntegrations),
  goals: many(goals),
  tasks: many(tasks),
  actionLogs: many(actionLogs),
}));

export const userIntegrationsRelations = relations(
  userIntegrations,
  ({ one }) => ({
    owner: one(users, {
      fields: [userIntegrations.userId],
      references: [users.uid],
    }),
    workspace: one(workspaces, {
      fields: [userIntegrations.workspaceId],
      references: [workspaces.id],
    }),
  })
);

export const goalsRelations = relations(goals, ({ one, many }) => ({
  owner: one(users, {
    fields: [goals.userId],
    references: [users.uid],
  }),
  workspace: one(workspaces, {
    fields: [goals.workspaceId],
    references: [workspaces.id],
  }),
  tasks: many(tasks),
  actionLogs: many(actionLogs),
  metricValues: many(goalMetricValues),
  executionRuns: many(executionRuns),
  reasoningCycles: many(reasoningCycles),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  goal: one(goals, {
    fields: [tasks.goalId],
    references: [goals.id],
  }),
  owner: one(users, {
    fields: [tasks.userId],
    references: [users.uid],
  }),
  workspace: one(workspaces, {
    fields: [tasks.workspaceId],
    references: [workspaces.id],
  }),
  assignedIntegration: one(userIntegrations, {
    fields: [tasks.assignedIntegrationId],
    references: [userIntegrations.id],
  }),
  actionLogs: many(actionLogs),
  attempts: many(taskAttempts),
}));

export const actionLogsRelations = relations(actionLogs, ({ one }) => ({
  goal: one(goals, {
    fields: [actionLogs.goalId],
    references: [goals.id],
  }),
  task: one(tasks, {
    fields: [actionLogs.taskId],
    references: [tasks.id],
  }),
  owner: one(users, {
    fields: [actionLogs.userId],
    references: [users.uid],
  }),
  workspace: one(workspaces, {
    fields: [actionLogs.workspaceId],
    references: [workspaces.id],
  }),
}));

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    goalId: text('goal_id').references(() => goals.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull().default('New conversation'),
    model: text('model').notNull().default('gemini-3.8-flash'),
    archived: boolean('archived').notNull().default(false),
    pinned: boolean('pinned').notNull().default(false),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_conversations_tenant_recent').on(
      table.userId,
      table.workspaceId,
      table.archived,
      table.lastMessageAt
    ),
  ]
);

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .references(() => conversations.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    role: text('role').notNull(),
    content: text('content').notNull().default(''),
    model: text('model'),
    status: text('status').notNull().default('completed'),
    attachmentsJson: jsonb('attachments_json')
      .$type<ChatAttachmentRecord[]>()
      .notNull()
      .default([]),
    executionTraceJson: jsonb('execution_trace_json').$type<ChatExecutionTrace | null>(),
    artifactIdsJson: jsonb('artifact_ids_json')
      .$type<string[]>()
      .notNull()
      .default([]),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_conv_messages_thread').on(table.conversationId, table.createdAt),
    index('idx_conv_messages_tenant').on(table.userId, table.workspaceId),
  ]
);

export const conversationArtifacts = pgTable(
  'conversation_artifacts',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .references(() => conversations.id, { onDelete: 'cascade' })
      .notNull(),
    messageId: text('message_id').references(() => conversationMessages.id, {
      onDelete: 'set null',
    }),
    goalId: text('goal_id').references(() => goals.id, {
      onDelete: 'set null',
    }),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    title: text('title').notNull(),
    artifactType: text('artifact_type').notNull(),
    mimeType: text('mime_type').notNull().default('text/markdown'),
    filename: text('filename').notNull(),
    content: text('content').notNull(),
    metadataJson: jsonb('metadata_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_conv_artifacts_tenant').on(
      table.userId,
      table.workspaceId,
      table.conversationId,
      table.createdAt
    ),
  ]
);

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [conversations.userId],
      references: [users.uid],
    }),
    workspace: one(workspaces, {
      fields: [conversations.workspaceId],
      references: [workspaces.id],
    }),
    goal: one(goals, {
      fields: [conversations.goalId],
      references: [goals.id],
    }),
    messages: many(conversationMessages),
    artifacts: many(conversationArtifacts),
  })
);

export const conversationMessagesRelations = relations(
  conversationMessages,
  ({ one }) => ({
    conversation: one(conversations, {
      fields: [conversationMessages.conversationId],
      references: [conversations.id],
    }),
    owner: one(users, {
      fields: [conversationMessages.userId],
      references: [users.uid],
    }),
    workspace: one(workspaces, {
      fields: [conversationMessages.workspaceId],
      references: [workspaces.id],
    }),
  })
);

export const conversationArtifactsRelations = relations(
  conversationArtifacts,
  ({ one }) => ({
    conversation: one(conversations, {
      fields: [conversationArtifacts.conversationId],
      references: [conversations.id],
    }),
    message: one(conversationMessages, {
      fields: [conversationArtifacts.messageId],
      references: [conversationMessages.id],
    }),
    goal: one(goals, {
      fields: [conversationArtifacts.goalId],
      references: [goals.id],
    }),
    task: one(tasks, {
      fields: [conversationArtifacts.taskId],
      references: [tasks.id],
    }),
    owner: one(users, {
      fields: [conversationArtifacts.userId],
      references: [users.uid],
    }),
    workspace: one(workspaces, {
      fields: [conversationArtifacts.workspaceId],
      references: [workspaces.id],
    }),
  })
);

export const n8nWorkflows = pgTable(
  'n8n_workflows',
  {
    id: text('id').primaryKey(),
    integrationId: text('integration_id')
      .references(() => userIntegrations.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    workflowExternalId: text('workflow_external_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    webhookUrlOrPath: text('webhook_url_or_path').notNull(),
    httpMethod: text('http_method').notNull().default('POST'),
    capabilities: jsonb('capabilities')
      .$type<CapabilityId[]>()
      .notNull()
      .default([]),
    inputSchema: jsonb('input_schema')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    active: boolean('active').notNull().default(true),
    discoveredViaApi: boolean('discovered_via_api').notNull().default(false),
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
    lastStatus: text('last_status'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_n8n_workflows_tenant').on(
      table.userId,
      table.workspaceId,
      table.integrationId
    ),
  ]
);

export const integrationActivityLogs = pgTable(
  'integration_activity_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    integrationId: text('integration_id').references(
      () => userIntegrations.id,
      { onDelete: 'set null' }
    ),
    providerKey: text('provider_key').notNull(),
    operation: text('operation').notNull(),
    direction: text('direction').notNull().default('outbound'),
    status: text('status').notNull(),
    httpStatus: integer('http_status'),
    durationMs: integer('duration_ms'),
    summary: text('summary').notNull(),
    errorMessage: text('error_message'),
    metadataJson: jsonb('metadata_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_integration_activity_tenant').on(
      table.userId,
      table.workspaceId,
      table.createdAt
    ),
  ]
);

export const oauthStates = pgTable(
  'oauth_states',
  {
    stateToken: text('state_token').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    providerKey: text('provider_key').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    requestedScopes: jsonb('requested_scopes')
      .$type<string[]>()
      .notNull()
      .default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_oauth_states_tenant').on(
      table.userId,
      table.workspaceId,
      table.expiresAt
    ),
  ]
);

export const aiProviderConfigs = pgTable(
  'ai_provider_configs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    providerId: text('provider_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    preferredModel: text('preferred_model').notNull(),
    fallbackPriority: integer('fallback_priority').notNull().default(1),
    totalRequests: integer('total_requests').notNull().default(0),
    failedRequests: integer('failed_requests').notNull().default(0),
    lastLatencyMs: integer('last_latency_ms'),
    lastHealthStatus: text('last_health_status').notNull().default('untested'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastErrorMessage: text('last_error_message'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_ai_provider_workspace').on(
      table.workspaceId,
      table.providerId
    ),
    index('idx_ai_provider_tenant').on(table.userId, table.workspaceId),
  ]
);

export const workforceConfigurations = pgTable(
  'workforce_configurations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.uid, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    goalId: text('goal_id').references(() => goals.id, {
      onDelete: 'set null',
    }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    requestPrompt: text('request_prompt').notNull(),
    roleSummary: text('role_summary').notNull(),
    status: text('status').notNull().default('awaiting_authorization'),
    requiredCapabilitiesJson: jsonb('required_capabilities_json')
      .$type<CapabilityId[]>()
      .notNull()
      .default([]),
    recommendedConnectorsJson: jsonb('recommended_connectors_json')
      .$type<WorkforceConnectorRecommendation[]>()
      .notNull()
      .default([]),
    approvedConnectorIdsJson: jsonb('approved_connector_ids_json')
      .$type<string[]>()
      .notNull()
      .default([]),
    rejectedProvidersJson: jsonb('rejected_providers_json')
      .$type<string[]>()
      .notNull()
      .default([]),
    capabilityMatrixJson: jsonb('capability_matrix_json')
      .$type<Record<CapabilityId, CapabilityReadinessState>>()
      .notNull()
      .default({} as Record<CapabilityId, CapabilityReadinessState>),
    activationBlockerReason: text('activation_blocker_reason'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_workforce_configs_tenant').on(
      table.userId,
      table.workspaceId,
      table.updatedAt
    ),
  ]
);


