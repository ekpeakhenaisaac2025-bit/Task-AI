import type {
  ActionLogRecord,
  ApprovalStatus,
  CapabilityId,
  GoalMetricValueRecord,
  GoalRecord,
  GoalStatus,
  IntegrationProviderKey,
  OutcomeEvidenceRecord,
  ProposedActionDetails,
  ResultsReportSummary,
  TaskActionCategory,
  TaskRecord,
  TaskStatus,
  ToolId,
  ToolRegistryItem,
  UserIntegrationRecord,
} from '../types.ts';
import { INTEGRATION_PROVIDER_KEYS } from './provider-registry.ts';

export const SUPPORTED_TOOLS: ReadonlySet<string> = new Set([
  'llm_reasoning',
  'internal_test_tool',
  'n8n_webhook',
  'custom_webhook',
  'make_webhook',
  'zapier_webhook',
  'crm_webhook',
  'gmail_api',
  'google_calendar_api',
  'payment_webhook',
  'gmail_native',
  'google_calendar_native',
  'google_drive_native',
  'slack_native',
  'telegram_native',
  'microsoft_outlook_native',
  'microsoft_teams_native',
  'custom_api',
]);

export const VALID_CAPABILITIES: ReadonlySet<string> = new Set([
  'ai_reasoning',
  'content_drafting',
  'prospect_qualification',
  'diagnostic_verification',
  'workflow_automation',
  'message_dispatch',
  'crm_sync',
  'prospect_search',
  'http_request',
  'calendar_booking',
  'payment_verification',
  'email_read',
  'calendar_read',
  'file_storage',
  'team_messaging',
  'custom_api_execution',
]);

export const VALID_ACTION_CATEGORIES: ReadonlySet<string> = new Set([
  'prospect_research',
  'prospect_qualification',
  'message_draft',
  'message_send',
  'calendar_booking',
  'crm_update',
  'payment_collection',
  'external_workflow',
  'internal_test',
  'analysis',
  'unsupported',
]);

export function isExternalProviderTool(
  tool: ToolId
): tool is IntegrationProviderKey {
  return INTEGRATION_PROVIDER_KEYS.has(tool as IntegrationProviderKey);
}

export function normalizeToolId(rawTool: unknown): ToolId {
  if (typeof rawTool !== 'string') return 'unsupported';
  const cleaned = rawTool.trim().toLowerCase();
  if (SUPPORTED_TOOLS.has(cleaned)) {
    return cleaned as ToolId;
  }
  return 'unsupported';
}

export function normalizeActionCategory(
  rawCategory: unknown,
  tool: ToolId
): TaskActionCategory {
  if (tool === 'internal_test_tool') return 'internal_test';
  if (typeof rawCategory === 'string') {
    const cleaned = rawCategory.trim().toLowerCase();
    if (VALID_ACTION_CATEGORIES.has(cleaned)) {
      return cleaned as TaskActionCategory;
    }
  }
  if (tool === 'unsupported') return 'unsupported';
  if (
    tool === 'gmail_api' ||
    tool === 'gmail_native' ||
    tool === 'microsoft_outlook_native' ||
    tool === 'slack_native' ||
    tool === 'telegram_native' ||
    tool === 'microsoft_teams_native'
  ) {
    return 'message_send';
  }
  if (tool === 'google_calendar_api' || tool === 'google_calendar_native') {
    return 'calendar_booking';
  }
  if (tool === 'crm_webhook') return 'crm_update';
  if (tool === 'payment_webhook') return 'payment_collection';
  if (isExternalProviderTool(tool)) {
    return 'external_workflow';
  }
  return 'analysis';
}

export function defaultCapabilitiesForTask(
  tool: ToolId,
  actionCategory: TaskActionCategory
): CapabilityId[] {
  if (tool === 'internal_test_tool' || actionCategory === 'internal_test') {
    return ['diagnostic_verification'];
  }
  if (tool === 'llm_reasoning') {
    if (actionCategory === 'message_draft') {
      return ['ai_reasoning', 'content_drafting'];
    }
    if (actionCategory === 'prospect_qualification') {
      return ['ai_reasoning', 'prospect_qualification'];
    }
    return ['ai_reasoning'];
  }
  if (tool === 'gmail_native' || tool === 'microsoft_outlook_native') {
    return actionCategory === 'analysis'
      ? ['email_read']
      : ['message_dispatch'];
  }
  if (tool === 'google_calendar_native') {
    return actionCategory === 'analysis'
      ? ['calendar_read']
      : ['calendar_booking'];
  }
  if (tool === 'google_drive_native') {
    return ['file_storage'];
  }
  if (
    tool === 'slack_native' ||
    tool === 'telegram_native' ||
    tool === 'microsoft_teams_native'
  ) {
    return ['team_messaging', 'message_dispatch'];
  }
  if (tool === 'custom_api') {
    return ['custom_api_execution', 'http_request'];
  }
  if (tool === 'gmail_api' || actionCategory === 'message_send') {
    return ['message_dispatch'];
  }
  if (tool === 'google_calendar_api' || actionCategory === 'calendar_booking') {
    return ['calendar_booking', 'http_request'];
  }
  if (tool === 'payment_webhook' || actionCategory === 'payment_collection') {
    return ['payment_verification', 'http_request'];
  }
  if (tool === 'crm_webhook' || actionCategory === 'crm_update') {
    return ['crm_sync', 'http_request'];
  }
  if (actionCategory === 'prospect_research') {
    return ['prospect_search'];
  }
  if (isExternalProviderTool(tool)) {
    return ['workflow_automation', 'http_request'];
  }
  return ['workflow_automation'];
}

export function normalizeCapabilities(
  rawCapabilities: unknown,
  tool: ToolId,
  actionCategory: TaskActionCategory
): CapabilityId[] {
  if (Array.isArray(rawCapabilities)) {
    const valid: CapabilityId[] = [];
    for (const item of rawCapabilities) {
      if (typeof item !== 'string') continue;
      const cleaned = item.trim().toLowerCase();
      if (
        VALID_CAPABILITIES.has(cleaned) &&
        !valid.includes(cleaned as CapabilityId)
      ) {
        valid.push(cleaned as CapabilityId);
      }
    }
    if (valid.length > 0) {
      return valid;
    }
  }
  return defaultCapabilitiesForTask(tool, actionCategory);
}

const CONSEQUENTIAL_PATTERNS: RegExp[] = [
  /\b(send|sending|dispatch|deliver)\b.*\b(email|emails|message|messages|dm|sms|outreach|campaign)\b/i,
  /\b(contact|reach out to|cold call|message|book|schedule)\b.*\b(prospect|prospects|customer|customers|lead|leads|people|client|clients|recipient|meeting)\b/i,
  /\b(spend|pay|purchase|buy|charge|budget|ad spend|paid ads|billing|invoice|checkout)\b/i,
  /\b(publish|post publicly|deploy live|broadcast|launch campaign)\b/i,
  /\b(webhook|external workflow|crm update|modify production)\b/i,
];

export function detectRequiresApproval(params: {
  tool: ToolId;
  actionCategory: TaskActionCategory;
  description: string;
  requiredCapabilities?: CapabilityId[];
  llmFlaggedApproval?: boolean;
}): boolean {
  if (params.llmFlaggedApproval === true) return true;
  if (isExternalProviderTool(params.tool)) {
    return true;
  }
  if (
    params.actionCategory === 'message_send' ||
    params.actionCategory === 'calendar_booking' ||
    params.actionCategory === 'crm_update' ||
    params.actionCategory === 'payment_collection' ||
    params.actionCategory === 'external_workflow'
  ) {
    return true;
  }
  if (
    params.requiredCapabilities?.some(
      (c) =>
        c === 'message_dispatch' ||
        c === 'crm_sync' ||
        c === 'calendar_booking' ||
        c === 'payment_verification' ||
        c === 'workflow_automation' ||
        c === 'http_request'
    ) &&
    params.tool !== 'llm_reasoning' &&
    params.tool !== 'internal_test_tool'
  ) {
    return true;
  }
  for (const pattern of CONSEQUENTIAL_PATTERNS) {
    if (pattern.test(params.description)) {
      return true;
    }
  }
  return false;
}

export interface RawPlannedTaskInput {
  step_id?: string;
  description?: string;
  tool?: string;
  proposed_tool?: string;
  required_capabilities?: string[];
  action_category?: string;
  dependencies?: string[];
  approval_required?: boolean;
  proposed_action?: string;
  target_recipient?: string;
  estimated_cost?: string;
  consequence_explanation?: string;
  expected_result?: string;
  verification_method?: string;
  verification_criteria?: string;
}

export interface NormalizedPlannedTask {
  id: string;
  goalId: string;
  stepOrder: number;
  description: string;
  tool: ToolId;
  requiredCapabilities: CapabilityId[];
  actionCategory: TaskActionCategory;
  dependencies: string[];
  approvalRequired: boolean;
  approvalStatus: ApprovalStatus;
  proposedActionDetails: ProposedActionDetails | null;
  expectedResult: string;
  verificationMethod: string;
  status: TaskStatus;
  statusReason: string | null;
  idempotencyKey: string;
}

function hasDependencyCycle(
  tasks: Array<{ id: string; dependencies: string[] }>
): boolean {
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    adj.set(t.id, t.dependencies);
  }
  const state = new Map<string, 'visiting' | 'visited'>();

  const dfs = (nodeId: string): boolean => {
    const cur = state.get(nodeId);
    if (cur === 'visiting') return true;
    if (cur === 'visited') return false;
    state.set(nodeId, 'visiting');
    const deps = adj.get(nodeId) ?? [];
    for (const depId of deps) {
      if (adj.has(depId) && dfs(depId)) {
        return true;
      }
    }
    state.set(nodeId, 'visited');
    return false;
  };

  for (const t of tasks) {
    if (dfs(t.id)) return true;
  }
  return false;
}

export function validateAndNormalizePlan(
  rawInput: unknown,
  goalId: string,
  generateId: () => string
): NormalizedPlannedTask[] {
  if (!Array.isArray(rawInput) || rawInput.length === 0) {
    throw new Error('AI planner returned an empty or non-array task plan.');
  }
  if (rawInput.length > 20) {
    throw new Error('AI planner exceeded maximum allowed tasks per plan (20).');
  }

  const stepRefToRealId = new Map<string, string>();
  const intermediate: Array<{
    realId: string;
    raw: RawPlannedTaskInput;
    index: number;
  }> = [];

  for (let i = 0; i < rawInput.length; i++) {
    const item = rawInput[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`Task at index ${i} is not a valid object.`);
    }
    const raw = item as RawPlannedTaskInput;
    const description =
      typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!description) {
      throw new Error(`Task at index ${i} is missing a description.`);
    }
    const expectedResult =
      typeof raw.expected_result === 'string' ? raw.expected_result.trim() : '';
    if (!expectedResult) {
      throw new Error(`Task "${description}" is missing expected_result.`);
    }
    const verificationRaw =
      typeof raw.verification_method === 'string' &&
      raw.verification_method.trim()
        ? raw.verification_method.trim()
        : typeof raw.verification_criteria === 'string'
          ? raw.verification_criteria.trim()
          : '';
    if (!verificationRaw) {
      throw new Error(`Task "${description}" is missing verification_method.`);
    }

    const realId = generateId();
    const stepKey =
      typeof raw.step_id === 'string' && raw.step_id.trim()
        ? raw.step_id.trim()
        : `step_${i + 1}`;
    stepRefToRealId.set(stepKey, realId);
    stepRefToRealId.set(`step_${i + 1}`, realId);
    stepRefToRealId.set(String(i + 1), realId);

    intermediate.push({ realId, raw, index: i });
  }

  const validRealIds = new Set(intermediate.map((entry) => entry.realId));

  const normalized: NormalizedPlannedTask[] = intermediate.map(
    ({ realId, raw, index }) => {
      const description = raw.description!.trim();
      const tool = normalizeToolId(raw.tool ?? raw.proposed_tool);
      const actionCategory = normalizeActionCategory(raw.action_category, tool);
      const requiredCapabilities = normalizeCapabilities(
        raw.required_capabilities,
        tool,
        actionCategory
      );
      const approvalRequired = detectRequiresApproval({
        tool,
        actionCategory,
        description,
        requiredCapabilities,
        llmFlaggedApproval: raw.approval_required,
      });

      const rawDeps = Array.isArray(raw.dependencies) ? raw.dependencies : [];
      const resolvedDeps: string[] = [];
      for (const depRef of rawDeps) {
        if (typeof depRef !== 'string') continue;
        const trimmedRef = depRef.trim();
        const mapped =
          stepRefToRealId.get(trimmedRef) ??
          (validRealIds.has(trimmedRef) ? trimmedRef : undefined);
        if (!mapped) {
          throw new Error(
            `Task "${description}" references unknown prerequisite "${trimmedRef}".`
          );
        }
        if (mapped !== realId && !resolvedDeps.includes(mapped)) {
          resolvedDeps.push(mapped);
        }
      }

      const proposedActionDetails: ProposedActionDetails | null =
        approvalRequired
          ? {
              proposedAction:
                typeof raw.proposed_action === 'string' &&
                raw.proposed_action.trim()
                  ? raw.proposed_action.trim()
                  : description,
              targetRecipient:
                typeof raw.target_recipient === 'string' &&
                raw.target_recipient.trim()
                  ? raw.target_recipient.trim()
                  : 'External target / specified audience',
              estimatedCost:
                typeof raw.estimated_cost === 'string' &&
                raw.estimated_cost.trim()
                  ? raw.estimated_cost.trim()
                  : '$0.00 direct platform fee (external provider rates may apply)',
              explanation:
                typeof raw.consequence_explanation === 'string' &&
                raw.consequence_explanation.trim()
                  ? raw.consequence_explanation.trim()
                  : 'This consequential action interacts with external systems, contacts people, or commits resources and will not run until you explicitly approve it.',
            }
          : null;

      const verificationMethod = (
        raw.verification_method ??
        raw.verification_criteria ??
        ''
      ).trim();

      const statusReason =
        tool === 'unsupported'
          ? `Configuration required: Requires capabilities [${requiredCapabilities.join(', ')}] which have no compatible integration connected yet.`
          : approvalRequired
            ? 'Awaiting explicit human approval before execution.'
            : null;

      return {
        id: realId,
        goalId,
        stepOrder: index + 1,
        description,
        tool,
        requiredCapabilities,
        actionCategory,
        dependencies: resolvedDeps,
        approvalRequired,
        approvalStatus: approvalRequired ? 'pending' : 'not_required',
        proposedActionDetails,
        expectedResult: raw.expected_result!.trim(),
        verificationMethod,
        status: 'queued',
        statusReason,
        idempotencyKey: `${goalId}:${realId}`,
      };
    }
  );

  if (hasDependencyCycle(normalized)) {
    throw new Error('AI planner generated circular task dependencies.');
  }

  return normalized;
}

export type ExecutionRouteResolution =
  | {
      routable: true;
      providerKey: 'llm_reasoning' | 'internal_test_tool' | IntegrationProviderKey;
      integrationId: string | null;
      providerLabel: string;
    }
  | {
      routable: false;
      code: 'tool_unsupported' | 'tool_unconfigured';
      reason: string;
    };

export function capabilitiesSatisfied(
  available: readonly CapabilityId[],
  required: readonly CapabilityId[]
): boolean {
  if (required.length === 0) return true;
  const set = new Set(available);
  return required.every((cap) => set.has(cap));
}

/**
 * Integration-Independent Execution Router decision logic.
 * Routes tasks to compatible built-in or user/workspace-owned execution providers
 * based on user configuration, capabilities, verification status, and proposed tool.
 */
export function resolveExecutionRoute(params: {
  task: Pick<TaskRecord, 'tool'> & {
    requiredCapabilities?: CapabilityId[];
    assignedIntegrationId?: string | null;
  };
  builtInProviders: {
    llmReasoningReady: boolean;
    internalTestReady: boolean;
  };
  userIntegrations: Array<
    Pick<
      UserIntegrationRecord,
      | 'id'
      | 'providerKey'
      | 'displayName'
      | 'capabilities'
      | 'enabled'
      | 'verified'
      | 'connectionMode'
    >
  >;
}): ExecutionRouteResolution {
  const { task, builtInProviders, userIntegrations } = params;
  const requiredCaps =
    task.requiredCapabilities && task.requiredCapabilities.length > 0
      ? task.requiredCapabilities
      : defaultCapabilitiesForTask(task.tool, 'analysis');

  if (task.tool === 'internal_test_tool') {
    if (builtInProviders.internalTestReady) {
      return {
        routable: true,
        providerKey: 'internal_test_tool',
        integrationId: null,
        providerLabel: 'built_in:internal_test_tool',
      };
    }
    return {
      routable: false,
      code: 'tool_unconfigured',
      reason: 'Internal diagnostic provider is disabled.',
    };
  }

  if (task.tool === 'llm_reasoning') {
    if (builtInProviders.llmReasoningReady) {
      return {
        routable: true,
        providerKey: 'llm_reasoning',
        integrationId: null,
        providerLabel: 'built_in:llm_reasoning',
      };
    }
    return {
      routable: false,
      code: 'tool_unconfigured',
      reason:
        'Configuration required: Server GEMINI_API_KEY is not configured for LLM reasoning.',
    };
  }

  const enabledIntegrations = userIntegrations.filter((i) => i.enabled);
  const verifiedIntegrations = enabledIntegrations.filter((i) => i.verified);

  // 1. Explicit integration assignment on the task (if set)
  if (task.assignedIntegrationId) {
    const exact = enabledIntegrations.find(
      (i) => i.id === task.assignedIntegrationId
    );
    if (!exact) {
      return {
        routable: false,
        code: 'tool_unconfigured',
        reason:
          'Assigned workspace integration was disabled or removed. Configure an active integration in Integrations.',
      };
    }
    if (!exact.verified) {
      return {
        routable: false,
        code: 'tool_unconfigured',
        reason: `Integration "${exact.displayName}" is configured, but its connection test has not succeeded yet.`,
      };
    }
    if (!capabilitiesSatisfied(exact.capabilities, requiredCaps)) {
      return {
        routable: false,
        code: 'tool_unconfigured',
        reason: `Integration "${exact.displayName}" does not grant required capabilities [${requiredCaps.join(', ')}].`,
      };
    }
    return {
      routable: true,
      providerKey: exact.providerKey,
      integrationId: exact.id,
      providerLabel: `${exact.providerKey}:${exact.displayName}`,
    };
  }

  // 2. Match preferred proposed provider with required capabilities
  if (isExternalProviderTool(task.tool)) {
    const preferredVerified = verifiedIntegrations.find(
      (i) =>
        i.providerKey === task.tool &&
        capabilitiesSatisfied(i.capabilities, requiredCaps)
    );
    if (preferredVerified) {
      return {
        routable: true,
        providerKey: preferredVerified.providerKey,
        integrationId: preferredVerified.id,
        providerLabel: `${preferredVerified.providerKey}:${preferredVerified.displayName}`,
      };
    }
  }

  // 3. Integration-independent capability routing: any verified provider in this user's workspace
  //    that satisfies all required capabilities can execute the task!
  const capabilityCompatibleVerified = verifiedIntegrations.find((i) =>
    capabilitiesSatisfied(i.capabilities, requiredCaps)
  );
  if (capabilityCompatibleVerified) {
    return {
      routable: true,
      providerKey: capabilityCompatibleVerified.providerKey,
      integrationId: capabilityCompatibleVerified.id,
      providerLabel: `${capabilityCompatibleVerified.providerKey}:${capabilityCompatibleVerified.displayName}`,
    };
  }

  // 4. Explain clearly if a matching integration exists in this workspace but hasn't passed connection verification
  const unverifiedMatch = enabledIntegrations.find(
    (i) =>
      !i.verified &&
      (i.providerKey === task.tool ||
        capabilitiesSatisfied(i.capabilities, requiredCaps))
  );
  if (unverifiedMatch) {
    return {
      routable: false,
      code: 'tool_unconfigured',
      reason: `Configuration verification required: "${unverifiedMatch.displayName}" (${unverifiedMatch.providerKey}) is saved in your workspace, but has not passed a live connection test yet.`,
    };
  }

  if (task.tool === 'unsupported') {
    return {
      routable: false,
      code: 'tool_unsupported',
      reason: `Configuration required: No compatible execution provider in your workspace supports capabilities [${requiredCaps.join(', ')}].`,
    };
  }

  return {
    routable: false,
    code: 'tool_unconfigured',
    reason: `Configuration required: No verified execution provider is connected in your workspace for "${task.tool}" or capabilities [${requiredCaps.join(', ')}].`,
  };
}

export type EligibilityOutcome =
  | {
      eligible: true;
      route?: Extract<ExecutionRouteResolution, { routable: true }>;
    }
  | {
      eligible: false;
      code:
        | 'not_queued'
        | 'goal_inactive'
        | 'dependency_unmet'
        | 'dependency_failed'
        | 'approval_pending'
        | 'approval_rejected'
        | 'reconciliation_required'
        | 'retry_limit_exceeded'
        | 'tool_unsupported'
        | 'tool_unconfigured';
      shouldTransitionTaskStatus: TaskStatus | null;
      reason: string;
    };

export function evaluateTaskEligibility(params: {
  task: Pick<
    TaskRecord,
    | 'id'
    | 'status'
    | 'tool'
    | 'dependencies'
    | 'approvalRequired'
    | 'approvalStatus'
    | 'retryCount'
  > & {
    reconciliationRequired?: boolean;
    maxRetries?: number;
    requiredCapabilities?: CapabilityId[];
    assignedIntegrationId?: string | null;
  };
  goalStatus: GoalStatus;
  tasksById: ReadonlyMap<
    string,
    Pick<TaskRecord, 'id' | 'stepOrder' | 'description' | 'status'>
  >;
  toolStatusMap?: ReadonlyMap<
    ToolId,
    { configured: boolean; verified: boolean; statusDetail: string }
  >;
  routingContext?: {
    builtInProviders: {
      llmReasoningReady: boolean;
      internalTestReady: boolean;
    };
    userIntegrations: Array<
      Pick<
        UserIntegrationRecord,
        | 'id'
        | 'providerKey'
        | 'displayName'
        | 'capabilities'
        | 'enabled'
        | 'verified'
        | 'connectionMode'
      >
    >;
  };
}): EligibilityOutcome {
  const { task, goalStatus, tasksById, toolStatusMap, routingContext } = params;

  if (
    task.status !== 'queued' &&
    task.status !== 'approved' &&
    task.status !== 'proposed'
  ) {
    return {
      eligible: false,
      code: 'not_queued',
      shouldTransitionTaskStatus: null,
      reason: `Task status is "${task.status}" and is not queued for execution.`,
    };
  }

  if (goalStatus !== 'active') {
    return {
      eligible: false,
      code: 'goal_inactive',
      shouldTransitionTaskStatus: null,
      reason: `Goal is currently "${goalStatus}". Set the goal status to "active" before executing tasks.`,
    };
  }

  if (task.reconciliationRequired === true) {
    return {
      eligible: false,
      code: 'reconciliation_required',
      shouldTransitionTaskStatus: 'blocked',
      reason:
        'Blocked: Prior external execution had an uncertain outcome (timeout or worker crash). Reconcile the task before retrying.',
    };
  }

  if (
    typeof task.maxRetries === 'number' &&
    task.maxRetries >= 0 &&
    task.retryCount >= task.maxRetries + 1
  ) {
    return {
      eligible: false,
      code: 'retry_limit_exceeded',
      shouldTransitionTaskStatus: 'failed',
      reason: `Retry limit reached (${task.retryCount} failed attempts). Inspect the error before resetting.`,
    };
  }

  for (const depId of task.dependencies) {
    const depTask = tasksById.get(depId);
    if (!depTask) {
      return {
        eligible: false,
        code: 'dependency_failed',
        shouldTransitionTaskStatus: 'blocked',
        reason: `Blocked: Missing prerequisite task (${depId}).`,
      };
    }
    if (
      depTask.status === 'failed' ||
      depTask.status === 'rejected' ||
      depTask.status === 'blocked'
    ) {
      return {
        eligible: false,
        code: 'dependency_failed',
        shouldTransitionTaskStatus: 'blocked',
        reason: `Blocked: Prerequisite Step ${depTask.stepOrder} ("${depTask.description}") is ${depTask.status}.`,
      };
    }
    if (depTask.status !== 'completed' && depTask.status !== 'verified') {
      return {
        eligible: false,
        code: 'dependency_unmet',
        shouldTransitionTaskStatus: null,
        reason: `Unmet dependency: Prerequisite Step ${depTask.stepOrder} ("${depTask.description}") is "${depTask.status}" and must finish first.`,
      };
    }
  }

  if (task.approvalRequired) {
    if (task.approvalStatus === 'rejected') {
      return {
        eligible: false,
        code: 'approval_rejected',
        shouldTransitionTaskStatus: 'rejected',
        reason: 'Action was explicitly rejected in the Approval Gate.',
      };
    }
    if (task.approvalStatus !== 'approved') {
      return {
        eligible: false,
        code: 'approval_pending',
        shouldTransitionTaskStatus: 'blocked',
        reason:
          'Blocked by Approval Gate: Explicit user approval is required before this consequential task can execute.',
      };
    }
  }

  // Prefer multi-tenant Execution Router resolution when routingContext is supplied
  if (routingContext) {
    const route = resolveExecutionRoute({
      task,
      builtInProviders: routingContext.builtInProviders,
      userIntegrations: routingContext.userIntegrations,
    });
    if (!route.routable) {
      return {
        eligible: false,
        code: route.code,
        shouldTransitionTaskStatus: 'blocked',
        reason: route.reason,
      };
    }
    return { eligible: true, route };
  }

  // Backwards-compatible fallback map support for existing unit tests
  if (task.tool === 'unsupported') {
    return {
      eligible: false,
      code: 'tool_unsupported',
      shouldTransitionTaskStatus: 'blocked',
      reason:
        'Blocked: Required action relies on an unsupported external tool or integration.',
    };
  }

  const toolState = toolStatusMap?.get(task.tool);
  if (!toolState || !toolState.configured || !toolState.verified) {
    return {
      eligible: false,
      code: 'tool_unconfigured',
      shouldTransitionTaskStatus: 'blocked',
      reason:
        toolState?.statusDetail ||
        `Blocked: Required tool "${task.tool}" is not configured or connection-verified.`,
    };
  }

  return { eligible: true };
}

export function computeResultsReport(params: {
  goals: GoalRecord[];
  tasks: TaskRecord[];
  actionLogs: ActionLogRecord[];
  tools: ToolRegistryItem[];
  outcomeEvidence?: OutcomeEvidenceRecord[];
  goalMetrics?: GoalMetricValueRecord[];
}): ResultsReportSummary {
  const {
    goals,
    tasks,
    actionLogs,
    tools,
    outcomeEvidence = [],
    goalMetrics = [],
  } = params;

  let prospectsFound = 0;
  let qualifiedProspects = 0;
  let messagesDrafted = 0;
  let messagesSent = 0;
  let messagesDeliveredVerified = 0;
  let repliesReceived = 0;
  let meetingsBooked = 0;
  let dealsWon = 0;
  let revenueEarnedUsd = 0;

  const verifiedLogsByTask = new Map<string, ActionLogRecord[]>();
  for (const log of actionLogs) {
    if (log.status === 'verified' && log.taskId) {
      const existing = verifiedLogsByTask.get(log.taskId) ?? [];
      existing.push(log);
      verifiedLogsByTask.set(log.taskId, existing);
    }
  }

  const goalStats = new Map<
    string,
    {
      verifiedOutcomesCount: number;
      draftedArtifactsCount: number;
      blockedCount: number;
      failedCount: number;
    }
  >();

  for (const goal of goals) {
    goalStats.set(goal.id, {
      verifiedOutcomesCount: 0,
      draftedArtifactsCount: 0,
      blockedCount: 0,
      failedCount: 0,
    });
  }

  for (const task of tasks) {
    const gStat = goalStats.get(task.goalId);
    if (task.status === 'blocked' && gStat) {
      gStat.blockedCount += 1;
    }
    if (task.status === 'failed' && gStat) {
      gStat.failedCount += 1;
    }
    // Only count legacy verified tasks when outcome_evidence table has no rows for this goal,
    // and NEVER count built-in deterministic SHA-256 diagnostics as external business outcomes.
    if (
      task.status === 'verified' &&
      task.tool !== 'internal_test_tool' &&
      gStat &&
      !outcomeEvidence.some((e) => e.goalId === task.goalId)
    ) {
      gStat.verifiedOutcomesCount += 1;
    }

    if (
      task.status !== 'completed' &&
      task.status !== 'pending_verification' &&
      task.status !== 'verified'
    ) {
      continue;
    }

    const output = task.outputData ?? {};

    if (task.actionCategory === 'message_draft') {
      const drafts = Array.isArray(output.draftedMessages)
        ? output.draftedMessages.length
        : typeof output.draftContent === 'string' && output.draftContent.trim()
          ? 1
          : 0;
      messagesDrafted += drafts;
      if (gStat) {
        gStat.draftedArtifactsCount += drafts;
      }
    }

    if (
      isExternalProviderTool(task.tool) &&
      task.actionCategory === 'message_send' &&
      (output.externalDispatchConfirmed === true ||
        typeof output.httpStatus === 'number')
    ) {
      const count =
        typeof output.dispatchedCount === 'number' ? output.dispatchedCount : 1;
      messagesSent += count;
    }

    const verifiedLogs = verifiedLogsByTask.get(task.id) ?? [];
    for (const vLog of verifiedLogs) {
      const ev = vLog.evidence ?? {};
      if (ev.authoritativeExternalSource === true && outcomeEvidence.length === 0) {
        if (typeof ev.verifiedProspectsFound === 'number') {
          prospectsFound += ev.verifiedProspectsFound;
        }
        if (typeof ev.verifiedQualifiedProspects === 'number') {
          qualifiedProspects += ev.verifiedQualifiedProspects;
        }
        if (typeof ev.verifiedMessagesSent === 'number') {
          messagesSent += ev.verifiedMessagesSent;
        }
        if (
          ev.providerDeliveryReceiptVerified === true &&
          typeof ev.verifiedMessagesDelivered === 'number'
        ) {
          messagesDeliveredVerified += ev.verifiedMessagesDelivered;
        }
        if (typeof ev.verifiedRepliesReceived === 'number') {
          repliesReceived += ev.verifiedRepliesReceived;
        }
        if (typeof ev.verifiedMeetingsBooked === 'number') {
          meetingsBooked += ev.verifiedMeetingsBooked;
        }
        if (typeof ev.verifiedDealsWon === 'number') {
          dealsWon += ev.verifiedDealsWon;
        }
        if (typeof ev.verifiedRevenueUsd === 'number') {
          revenueEarnedUsd += ev.verifiedRevenueUsd;
        }
      }
    }
  }

  // Incorporate Milestone 2 verified business outcome_evidence records (deduplicated & currency-isolated)
  const seenReportRefs = new Set<string>();
  for (const ev of outcomeEvidence) {
    if (ev.verificationState !== 'verified') continue;
    if (ev.hasConflict) continue;
    if (
      ev.provenanceClass === 'internal_diagnostic' ||
      ev.trustTier === 'diagnostic_only' ||
      ev.sourceType === 'deterministic_execution' ||
      ev.evidenceType === 'diagnostic_checksum' ||
      ev.evidenceType === 'api_dispatch_ack'
    ) {
      continue;
    }
    if (
      ev.provenanceClass &&
      ev.provenanceClass !== 'provider_confirmed' &&
      ev.provenanceClass !== 'human_confirmed'
    ) {
      continue;
    }

    const dedupeKey =
      ev.evidenceType !== 'outcome_reversal' && ev.externalReferenceId?.trim()
        ? `${ev.goalId}:${ev.evidenceType}:${ev.externalReferenceId.trim()}`
        : null;
    if (dedupeKey) {
      if (seenReportRefs.has(dedupeKey)) continue;
      seenReportRefs.add(dedupeKey);
    }

    const gStat = goalStats.get(ev.goalId);
    if (gStat && ev.evidenceType !== 'outcome_reversal') {
      gStat.verifiedOutcomesCount += 1;
    }
    const m = ev.structuredMetrics ?? {};
    const num = (keys: string[], fallback = 0): number => {
      for (const k of keys) {
        const v = m[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
      }
      return fallback;
    };

    const explicitCurrency =
      typeof m.currency === 'string' && m.currency.trim()
        ? m.currency.trim().toUpperCase()
        : null;
    const hasNonUsdKey =
      typeof m.amountNgn === 'number' ||
      typeof m.revenueNgn === 'number' ||
      typeof m.amountEur === 'number' ||
      typeof m.revenueEur === 'number' ||
      typeof m.amountGbp === 'number' ||
      typeof m.revenueGbp === 'number';
    const isUsdCompatible =
      (explicitCurrency === null || explicitCurrency === 'USD') && !hasNonUsdKey;

    switch (ev.evidenceType) {
      case 'prospect_identified':
        prospectsFound += num(
          ['prospectsFound', 'prospects', 'leads', 'count', 'value'],
          1
        );
        break;
      case 'qualified_lead':
        qualifiedProspects += num(
          ['qualifiedLeads', 'leads', 'count', 'value'],
          1
        );
        break;
      case 'message_delivered':
        messagesDeliveredVerified += num(
          ['messagesDelivered', 'messages', 'count', 'value'],
          1
        );
        break;
      case 'reply_received':
        repliesReceived += num(
          ['repliesReceived', 'replies', 'count', 'value'],
          1
        );
        break;
      case 'meeting_booked':
        meetingsBooked += num(
          ['meetingsBooked', 'meetings', 'count', 'value'],
          1
        );
        break;
      case 'customer_acquired':
        dealsWon += num(
          ['customersAcquired', 'customers', 'dealsWon', 'count', 'value'],
          1
        );
        if (typeof m.amountUsd === 'number' || typeof m.revenueUsd === 'number') {
          revenueEarnedUsd += num(['amountUsd', 'revenueUsd'], 0);
        } else if (isUsdCompatible) {
          revenueEarnedUsd += num(['revenue'], 0);
        }
        break;
      case 'payment_confirmed':
        if (typeof m.amountUsd === 'number' || typeof m.revenueUsd === 'number') {
          revenueEarnedUsd += num(['amountUsd', 'revenueUsd'], 0);
        } else if (isUsdCompatible) {
          revenueEarnedUsd += num(['revenue', 'amount', 'value'], 0);
        }
        dealsWon += num(['customersAcquired', 'customers', 'dealsWon'], 0);
        break;
      case 'outcome_reversal': {
        const refundUsd =
          typeof m.refundAmountUsd === 'number'
            ? -Math.abs(m.refundAmountUsd)
            : typeof m.amountUsd === 'number'
              ? m.amountUsd > 0
                ? -m.amountUsd
                : m.amountUsd
              : isUsdCompatible && typeof m.refundAmount === 'number'
                ? -Math.abs(m.refundAmount)
                : isUsdCompatible && typeof m.amount === 'number'
                  ? m.amount > 0
                    ? -m.amount
                    : m.amount
                  : 0;
        revenueEarnedUsd += refundUsd;
        const custRev = num(['customersAcquired', 'customers', 'dealsWon'], 0);
        if (custRev !== 0) {
          dealsWon += custRev > 0 ? -custRev : custRev;
        }
        const meetRev = num(['meetingsBooked', 'meetings'], 0);
        if (meetRev !== 0) {
          meetingsBooked += meetRev > 0 ? -meetRev : meetRev;
        }
        break;
      }
      default:
        break;
    }
  }

  revenueEarnedUsd = Math.max(0, Number(revenueEarnedUsd.toFixed(2)));
  dealsWon = Math.max(0, dealsWon);
  meetingsBooked = Math.max(0, meetingsBooked);

  const blockedTasks = tasks.filter((t) => t.status === 'blocked').length;
  const executionFailures = tasks.filter((t) => t.status === 'failed').length;

  const anyExternalVerified = tools.some(
    (t) => t.scope === 'tenant_configurable' && t.configured && t.verified
  );

  const missingConfigurations = tools
    .filter((tool) => {
      if (tool.scope === 'tenant_configurable') {
        if (anyExternalVerified) return false;
        return tool.id === 'n8n_webhook'
          ? !tool.configured || !tool.verified
          : false;
      }
      return !tool.configured || !tool.verified;
    })
    .map((tool) => ({
      toolId: tool.id,
      name:
        tool.id === 'n8n_webhook'
          ? 'External Execution Provider (Webhook, CRM, Calendar, Email, or n8n)'
          : tool.name,
      requiredCapabilities: tool.capabilities,
      impact:
        tool.id === 'n8n_webhook'
          ? 'No verified external execution provider is connected for this workspace. Built-in Gemini reasoning and deterministic verification run normally, while external outreach, calendar, CRM, and payment outcomes remain at 0 until an external provider is connected and verified.'
          : tool.statusDetail,
    }));

  const goalComparisons = goals.map((goal) => {
    const stat = goalStats.get(goal.id) ?? {
      verifiedOutcomesCount: 0,
      draftedArtifactsCount: 0,
      blockedCount: 0,
      failedCount: 0,
    };
    const metricsForGoal = goalMetrics.filter((gm) => gm.goalId === goal.id);
    return {
      goalId: goal.id,
      problem: goal.problem,
      deadline: goal.deadline,
      statedTargetMetric: goal.targetMetric,
      goalStatus: goal.status,
      progressPercent: goal.progressPercent ?? 0,
      verifiedOutcomesCount: stat.verifiedOutcomesCount,
      draftedArtifactsCount: stat.draftedArtifactsCount,
      blockedCount: stat.blockedCount,
      failedCount: stat.failedCount,
      metricBreakdown: metricsForGoal,
    };
  });

  return {
    metrics: {
      prospectsFound,
      qualifiedProspects,
      messagesDrafted,
      messagesSent,
      messagesDeliveredVerified,
      repliesReceived,
      meetingsBooked,
      dealsWon,
      revenueEarnedUsd,
      blockedTasks,
      executionFailures,
    },
    processSummary: {
      totalGoals: goals.length,
      activeGoals: goals.filter((g) => g.status === 'active').length,
      completedTasks: tasks.filter((t) => t.status === 'completed').length,
      pendingVerificationTasks: tasks.filter(
        (t) => t.status === 'pending_verification'
      ).length,
      verifiedTasks: tasks.filter((t) => t.status === 'verified').length,
      queuedTasks: tasks.filter(
        (t) => t.status === 'queued' || t.status === 'approved'
      ).length,
      pendingApprovals: tasks.filter(
        (t) => t.approvalRequired && t.approvalStatus === 'pending'
      ).length,
    },
    dataProvenance: 'evidence_backed_real_records',
    missingConfigurations,
    goalComparisons,
  };
}
