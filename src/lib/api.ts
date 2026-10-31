import { getGoogleWorkspaceAccessToken } from './firebase';
import type {
  ActionLogRecord,
  AiProviderId,
  AiProviderStatusRecord,
  AuthSessionUser,
  CapabilityId,
  CapabilityReadinessState,
  CapabilityStatusEntry,
  ChatAttachmentRecord,
  ChatExecutionTrace,
  ChatModelId,
  ConversationArtifactRecord,
  ConversationMessageRecord,
  ConversationRecord,
  CustomApiConfigMetadata,
  CustomApiHttpMethod,
  EnvironmentDiagnosticsResponse,
  EvidenceType,
  ExecutionMonitorSnapshot,
  ExecutionRunRecord,
  GoalMetricValueRecord,
  GoalRecord,
  GoalStatus,
  HydratedGoalExecutionContext,
  InboundWebhookPublicConfig,
  IntegrationActivityLogRecord,
  IntegrationAuthType,
  IntegrationConnectionMode,
  IntegrationProviderKey,
  IntegrationRegistryEntry,
  N8nRegisteredWorkflowRecord,
  NextActionProposalRecord,
  OutcomeEvidenceRecord,
  PlatformCapabilitiesInfo,
  ReasoningCycleRecord,
  ResultsReportSummary,
  TaskActionCategory,
  TaskRecord,
  ToolId,
  ToolRegistryItem,
  UserIntegrationRecord,
  VerificationDecisionRecord,
  WorkforceConfigurationRecord,
  WorkspaceRecord,
} from '../types';

export interface EnrichedIntegrationBundle {
  workspaceId: string;
  tools?: ToolRegistryItem[];
  integrations: UserIntegrationRecord[];
  platformCapabilities?: PlatformCapabilitiesInfo;
  registry?: IntegrationRegistryEntry[];
  capabilityEntries?: CapabilityStatusEntry[];
  capabilityMatrix?: Record<CapabilityId, CapabilityReadinessState>;
  n8nWorkflows?: N8nRegisteredWorkflowRecord[];
  aiProviders?: AiProviderStatusRecord[];
  activityLogs?: IntegrationActivityLogRecord[];
  workforceConfigs?: WorkforceConfigurationRecord[];
  oauthEnv?: {
    googleWorkspaceConfigured: boolean;
    slackOAuthConfigured: boolean;
    microsoftOAuthConfigured: boolean;
  };
}

let inMemoryBearerToken: string | null = null;

export function setAuthBearerToken(token: string | null) {
  inMemoryBearerToken = token;
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };

  if (inMemoryBearerToken) {
    headers['Authorization'] = `Bearer ${inMemoryBearerToken}`;
  }
  const wsToken = getGoogleWorkspaceAccessToken();
  if (wsToken) {
    headers['X-Google-Access-Token'] = wsToken;
  }

  const res = await fetch(path, {
    ...options,
    credentials: 'include',
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg =
      typeof data?.error === 'string'
        ? data.error
        : `Request failed with status ${res.status}`;
    throw new Error(errMsg);
  }
  return data as T;
}

function buildQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val) search.set(key, val);
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

/**
 * Browser Web Crypto helper to compute an authentic `X-TaskAI-Signature: t=<sec>,v1=<hex>`
 * HMAC-SHA256 header over exact raw JSON request bytes for the Inbound Webhook Test Bench.
 */
async function computeBrowserHmacHeader(
  signingSecret: string,
  rawBody: string,
  timestampSec: number
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await window.crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signedBuf = await window.crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestampSec}.${rawBody}`)
  );
  const hex = Array.from(new Uint8Array(signedBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `t=${timestampSec},v1=${hex}`;
}

export const api = {
  getSession: () =>
    apiRequest<{ authenticated: boolean; user: AuthSessionUser | null }>(
      '/api/auth/session'
    ),

  getMe: () => apiRequest<{ user: AuthSessionUser }>('/api/auth/me'),

  exchangeGoogleSession: async (firebaseIdToken: string) => {
    const res = await apiRequest<{ user: AuthSessionUser; token: string }>(
      '/api/auth/google-session',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${firebaseIdToken}`,
        },
      }
    );
    setAuthBearerToken(res.token);
    return res;
  },

  createIsolatedSession: async () => {
    const res = await apiRequest<{ user: AuthSessionUser; token: string }>(
      '/api/auth/isolated-session',
      { method: 'POST' }
    );
    setAuthBearerToken(res.token);
    return res;
  },

  logout: async () => {
    await apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
    setAuthBearerToken(null);
  },

  listWorkspaces: () =>
    apiRequest<{ workspaces: WorkspaceRecord[] }>('/api/workspaces'),

  createWorkspace: (name: string) =>
    apiRequest<{ workspace: WorkspaceRecord }>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  listGoals: (workspaceId?: string) =>
    apiRequest<{ goals: GoalRecord[] }>(
      `/api/goals${buildQuery({ workspaceId })}`
    ),

  createGoal: (payload: {
    problem: string;
    description?: string;
    targetMetric: string;
    deadline?: string | null;
    status?: GoalStatus;
    workspaceId?: string;
  }) =>
    apiRequest<{ goal: GoalRecord }>('/api/goals', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateGoal: (
    goalId: string,
    payload: {
      problem?: string;
      description?: string;
      targetMetric?: string;
      deadline?: string | null;
      status?: GoalStatus;
    }
  ) =>
    apiRequest<{ goal: GoalRecord }>(`/api/goals/${goalId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  generatePlan: (goalId: string) =>
    apiRequest<{
      goal: GoalRecord;
      tasks: TaskRecord[];
      message: string;
    }>(`/api/goals/${goalId}/plan`, {
      method: 'POST',
    }),

  listTasks: (goalId?: string, workspaceId?: string) =>
    apiRequest<{ tasks: TaskRecord[] }>(
      `/api/tasks${buildQuery({ goalId, workspaceId })}`
    ),

  createTask: (
    goalId: string,
    payload: {
      description: string;
      tool: ToolId;
      requiredCapabilities?: CapabilityId[];
      assignedIntegrationId?: string | null;
      actionCategory?: TaskActionCategory;
      dependencies?: string[];
      approvalRequired?: boolean;
      proposedAction?: string;
      targetRecipient?: string;
      estimatedCost?: string;
      explanation?: string;
      expectedResult?: string;
      verificationMethod?: string;
      maxRetries?: number;
      backoffBaseMs?: number;
      executionTimeoutMs?: number;
    }
  ) =>
    apiRequest<{ task: TaskRecord }>(`/api/goals/${goalId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  decideApproval: (taskId: string, decision: 'approved' | 'rejected') =>
    apiRequest<{ task: TaskRecord }>(`/api/tasks/${taskId}/approval`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),

  requeueTask: (taskId: string) =>
    apiRequest<{ task: TaskRecord }>(`/api/tasks/${taskId}/requeue`, {
      method: 'POST',
    }),

  retryTask: (taskId: string, confirmExternalNotExecuted?: boolean) =>
    apiRequest<{ task: TaskRecord }>(`/api/tasks/${taskId}/retry`, {
      method: 'POST',
      ...(confirmExternalNotExecuted !== undefined
        ? { body: JSON.stringify({ confirmExternalNotExecuted }) }
        : {}),
    }),

  reconcileTask: (
    taskId: string,
    payload: {
      resolution:
        | 'reconcile_from_evidence'
        | 'mark_dispatched_pending_verification'
        | 'confirm_not_executed_requeue';
      notes?: string;
    }
  ) =>
    apiRequest<{ task: TaskRecord; message: string }>(
      `/api/tasks/${taskId}/reconcile`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  executeTask: (taskId: string) =>
    apiRequest<{
      executed: boolean;
      workerId: string;
      task: TaskRecord | null;
      outcomeCode: string;
      message: string;
    }>(`/api/tasks/${taskId}/execute`, {
      method: 'POST',
    }),

  runNextWorkerTask: (goalId?: string, workspaceId?: string) =>
    apiRequest<{
      executed: boolean;
      workerId: string;
      task: TaskRecord | null;
      outcomeCode: string;
      message: string;
    }>('/api/worker/run-next', {
      method: 'POST',
      body: JSON.stringify({ goalId, workspaceId }),
    }),

  // --- MILESTONE 2: EXECUTION ORCHESTRATOR, EVIDENCE, VERIFICATION & CONTINUOUS AI REASONING ---

  getExecutionMonitor: (workspaceId?: string) =>
    apiRequest<{ snapshot: ExecutionMonitorSnapshot }>(
      `/api/execution-monitor${buildQuery({ workspaceId })}`
    ),

  orchestrateGoal: (
    goalId: string,
    payload: {
      concurrencyMode?: 'sequential' | 'parallel_safe';
      autoRunReasoning?: boolean;
    } = {}
  ) =>
    apiRequest<{
      run: ExecutionRunRecord;
      goal: GoalRecord;
      tasks: TaskRecord[];
      metrics: GoalMetricValueRecord[];
      reasoning: {
        cycle: ReasoningCycleRecord;
        proposals: NextActionProposalRecord[];
      } | null;
    }>(`/api/goals/${goalId}/orchestrate`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  controlGoalExecution: (
    goalId: string,
    action: 'pause' | 'resume' | 'cancel'
  ) =>
    apiRequest<{ goal: GoalRecord }>(`/api/goals/${goalId}/execution-control`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  getInboundWebhookConfig: (workspaceId: string) =>
    apiRequest<{ config: InboundWebhookPublicConfig }>(
      `/api/workspaces/${workspaceId}/inbound-webhook`
    ),

  rotateInboundWebhookSecret: (workspaceId: string) =>
    apiRequest<{
      config: InboundWebhookPublicConfig;
      oneTimeSigningSecret: string;
    }>(`/api/workspaces/${workspaceId}/inbound-webhook/rotate`, {
      method: 'POST',
    }),

  sendSignedInboundWebhook: async (params: {
    workspaceId: string;
    signingSecret: string;
    providerSecret?: string;
    payload: {
      externalEventId: string;
      provider: string;
      evidenceType: EvidenceType;
      summary: string;
      goalId?: string;
      taskId?: string | null;
      externalReferenceId?: string | null;
      requiresHumanReview?: boolean;
      structuredMetrics?: Record<string, unknown>;
    };
  }) => {
    const rawBody = JSON.stringify(params.payload);
    const timestampSec = Math.floor(Date.now() / 1000);
    const signature = await computeBrowserHmacHeader(
      params.signingSecret,
      rawBody,
      timestampSec
    );
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-TaskAI-Signature': signature,
      'X-TaskAI-Timestamp': String(timestampSec),
    };
    if (params.providerSecret && params.providerSecret.trim().length > 0) {
      headers['X-TaskAI-Provider-Signature'] = await computeBrowserHmacHeader(
        params.providerSecret.trim(),
        rawBody,
        timestampSec
      );
    }

    const res = await fetch(`/api/webhooks/inbound/${params.workspaceId}`, {
      method: 'POST',
      headers,
      body: rawBody,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof data?.error === 'string'
          ? data.error
          : `Inbound webhook rejected (${res.status})`
      );
    }
    return data as {
      accepted: boolean;
      duplicate: boolean;
      inboundEventId: string;
      evidence?: OutcomeEvidenceRecord;
      verification?: VerificationDecisionRecord;
      message?: string;
      goalProgress?: {
        progressPercent: number;
        isGoalAchieved: boolean;
        goalStatus: GoalStatus;
      };
    };
  },

  submitManualEvidence: (
    workspaceId: string,
    payload: {
      goalId: string;
      taskId?: string | null;
      provider?: string;
      evidenceType: EvidenceType;
      summary: string;
      externalReferenceId?: string | null;
      structuredMetrics?: Record<string, unknown>;
    }
  ) =>
    apiRequest<{
      evidence: OutcomeEvidenceRecord;
      verification: VerificationDecisionRecord;
      goalProgress: {
        progressPercent: number;
        isGoalAchieved: boolean;
      };
    }>(`/api/workspaces/${workspaceId}/evidence`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  reviewEvidence: (
    evidenceId: string,
    payload: {
      decision: 'verified' | 'rejected';
      notes: string;
    }
  ) =>
    apiRequest<{
      evidence: OutcomeEvidenceRecord;
      verification: VerificationDecisionRecord;
      goalProgress: {
        goal: GoalRecord | null;
        progressPercent: number;
        isGoalAchieved: boolean;
      };
    }>(`/api/evidence/${evidenceId}/review`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  aiVerifyEvidence: (evidenceId: string) =>
    apiRequest<{
      verification: VerificationDecisionRecord;
      recommendation: 'recommended_verify' | 'recommended_reject';
      confidenceLevel: 'low' | 'medium' | 'high';
      consistencyFlags: string[];
    }>(`/api/evidence/${evidenceId}/ai-verify`, {
      method: 'POST',
    }),

  runGoalReasoning: (goalId: string) =>
    apiRequest<{
      cycle: ReasoningCycleRecord;
      proposals: NextActionProposalRecord[];
    }>(`/api/goals/${goalId}/reasoning`, {
      method: 'POST',
    }),

  decideProposal: (proposalId: string, decision: 'accept' | 'reject') =>
    apiRequest<{
      proposal: NextActionProposalRecord;
      enqueuedTask: TaskRecord | null;
    }>(`/api/proposals/${proposalId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),

  listActionLogs: (goalId?: string, workspaceId?: string) =>
    apiRequest<{ logs: ActionLogRecord[] }>(
      `/api/action-logs${buildQuery({ goalId, workspaceId })}`
    ),

  getResultsReport: (workspaceId?: string) =>
    apiRequest<{ report: ResultsReportSummary }>(
      `/api/results-report${buildQuery({ workspaceId })}`
    ),

  getIntegrations: (workspaceId?: string) =>
    apiRequest<
      EnrichedIntegrationBundle & {
        tools: ToolRegistryItem[];
        platformCapabilities: PlatformCapabilitiesInfo;
      }
    >(`/api/integrations${buildQuery({ workspaceId })}`),

  getIntegrationRegistry: (workspaceId?: string) =>
    apiRequest<EnrichedIntegrationBundle>(
      `/api/integrations/registry${buildQuery({ workspaceId })}`
    ),

  connectGoogleNative: (payload: {
    workspaceId?: string;
    providerKey:
      | 'gmail_native'
      | 'google_calendar_native'
      | 'google_drive_native';
    grantedScopes: string[];
  }) =>
    apiRequest<
      EnrichedIntegrationBundle & {
        integration: UserIntegrationRecord;
      }
    >('/api/integrations/native/google', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  connectNativeBotToken: (payload: {
    workspaceId?: string;
    providerKey: 'slack_native' | 'telegram_native';
    botToken: string;
    displayName?: string;
    slackDefaultChannel?: string;
    telegramDefaultChatId?: string;
  }) =>
    apiRequest<
      EnrichedIntegrationBundle & {
        integration: UserIntegrationRecord;
        testResult?: {
          success: boolean;
          statusDetail: string;
          httpStatus: number | null;
        } | null;
      }
    >('/api/integrations/native/token', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  disconnectIntegration: (
    integrationId: string,
    revokeGoogleToken = false
  ) =>
    apiRequest<EnrichedIntegrationBundle & { disconnected: boolean }>(
      `/api/integrations/${integrationId}/disconnect`,
      {
        method: 'POST',
        body: JSON.stringify({ revokeGoogleToken }),
      }
    ),

  getThirdPartyOAuthUrl: (
    providerKey:
      | 'slack_native'
      | 'microsoft_outlook_native'
      | 'microsoft_teams_native',
    workspaceId?: string
  ) =>
    apiRequest<{
      configured: boolean;
      url?: string;
      redirectUri: string;
      missingEnvVars?: string[];
      message?: string;
    }>(
      `/api/oauth/${providerKey}/url${buildQuery({
        workspaceId,
        origin:
          typeof window !== 'undefined' ? window.location.origin : undefined,
      })}`
    ),

  createCustomApiIntegration: (payload: {
    workspaceId?: string;
    displayName: string;
    authType: IntegrationAuthType;
    secret?: string;
    capabilities?: CapabilityId[];
    customApi: CustomApiConfigMetadata;
  }) =>
    apiRequest<
      EnrichedIntegrationBundle & { integration: UserIntegrationRecord }
    >('/api/integrations/custom-api', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  configureN8nIntegration: (payload: {
    workspaceId?: string;
    setupMode: 'existing_instance' | 'manual_webhook';
    displayName?: string;
    n8nBaseUrl?: string;
    endpointUrl?: string;
    workflowId?: string;
    authType?: IntegrationAuthType;
    secret?: string;
    capabilities?: CapabilityId[];
  }) =>
    apiRequest<
      EnrichedIntegrationBundle & { integration: UserIntegrationRecord }
    >('/api/integrations/n8n/configure', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  registerN8nWorkflow: (
    integrationId: string,
    payload: {
      name: string;
      workflowExternalId?: string;
      description?: string;
      webhookUrlOrPath: string;
      httpMethod?: CustomApiHttpMethod;
      capabilities?: CapabilityId[];
    }
  ) =>
    apiRequest<
      EnrichedIntegrationBundle & { workflow: N8nRegisteredWorkflowRecord }
    >(`/api/integrations/${integrationId}/n8n/workflows`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  discoverN8nWorkflows: (integrationId: string) =>
    apiRequest<
      EnrichedIntegrationBundle & {
        discoveredCount: number;
        registeredWorkflows: N8nRegisteredWorkflowRecord[];
        skippedWithoutWebhookNode: number;
      }
    >(`/api/integrations/${integrationId}/n8n/discover`, {
      method: 'POST',
    }),

  deleteN8nWorkflow: (integrationId: string, workflowId: string) =>
    apiRequest<EnrichedIntegrationBundle & { deleted: boolean }>(
      `/api/integrations/${integrationId}/n8n/workflows/${workflowId}`,
      { method: 'DELETE' }
    ),

  updateAiProvider: (
    providerId: AiProviderId,
    payload: {
      workspaceId?: string;
      enabled?: boolean;
      preferredModel?: string;
      fallbackPriority?: number;
    }
  ) =>
    apiRequest<{
      workspaceId: string;
      aiProviders: AiProviderStatusRecord[];
    }>(`/api/ai-providers/${providerId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  checkAiProviderHealth: (providerId: AiProviderId, workspaceId?: string) =>
    apiRequest<{
      healthy: boolean;
      latencyMs: number;
      detail: string;
      provider: AiProviderStatusRecord;
    }>(`/api/ai-providers/${providerId}/health-check`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    }),

  evaluateWorkforce: (payload: {
    workspaceId?: string;
    conversationId?: string | null;
    prompt: string;
  }) =>
    apiRequest<{
      workforceConfig: WorkforceConfigurationRecord;
      workforceConfigs: WorkforceConfigurationRecord[];
    }>('/api/workforce/evaluate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  decideWorkforceConnector: (
    workforceId: string,
    payload: {
      action: 'approve' | 'reject' | 'modify';
      providerKey?: IntegrationProviderKey;
      replacementProviderKey?: IntegrationProviderKey;
    }
  ) =>
    apiRequest<{ workforceConfig: WorkforceConfigurationRecord }>(
      `/api/workforce/${workforceId}/decision`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  activateWorkforce: (workforceId: string) =>
    apiRequest<
      EnrichedIntegrationBundle & {
        activated: boolean;
        workforceConfig: WorkforceConfigurationRecord;
      }
    >(`/api/workforce/${workforceId}/activate`, {
      method: 'POST',
    }),

  createIntegration: (payload: {
    workspaceId?: string;
    providerKey: IntegrationProviderKey;
    displayName: string;
    connectionMode: IntegrationConnectionMode;
    endpointUrl?: string;
    webhookPath?: string;
    workflowId?: string;
    authType: IntegrationAuthType;
    secretHeaderName?: string;
    secret?: string;
    capabilities: CapabilityId[];
  }) =>
    apiRequest<{
      integration: UserIntegrationRecord;
      tools: ToolRegistryItem[];
    }>('/api/integrations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateIntegration: (
    integrationId: string,
    payload: {
      displayName?: string;
      enabled?: boolean;
      endpointUrl?: string;
      workflowId?: string;
      authType?: IntegrationAuthType;
      secret?: string;
      capabilities?: CapabilityId[];
    }
  ) =>
    apiRequest<{
      integration: UserIntegrationRecord;
      tools: ToolRegistryItem[];
    }>(`/api/integrations/${integrationId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteIntegration: (integrationId: string) =>
    apiRequest<{
      deleted: boolean;
      tools: ToolRegistryItem[];
    }>(`/api/integrations/${integrationId}`, {
      method: 'DELETE',
    }),

  testIntegration: (integrationId: string) =>
    apiRequest<{
      success: boolean;
      statusDetail: string;
      httpStatus: number | null;
      testedAt: string;
      integration: UserIntegrationRecord;
      tools: ToolRegistryItem[];
    }>(`/api/integrations/${integrationId}/test`, {
      method: 'POST',
    }),

  getEnvironmentDiagnostics: () =>
    apiRequest<EnvironmentDiagnosticsResponse>('/api/config/environment'),

  rotateIntegrationKeys: (workspaceId?: string) =>
    apiRequest<{
      rotatedCount: number;
      alreadyCurrentCount: number;
      noSecretCount: number;
    }>('/api/integrations/rotate-keys', {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    }),

  // --- CONVERSATIONS, STREAMING CHAT & ARTIFACTS ---

  listConversations: (params?: {
    workspaceId?: string;
    search?: string;
    includeArchived?: boolean;
    archivedOnly?: boolean;
  }) =>
    apiRequest<{ conversations: ConversationRecord[]; workspaceId: string }>(
      `/api/conversations${buildQuery({
        workspaceId: params?.workspaceId,
        search: params?.search,
        includeArchived: params?.includeArchived ? 'true' : undefined,
        archivedOnly: params?.archivedOnly ? 'true' : undefined,
      })}`
    ),

  createConversation: (payload?: {
    workspaceId?: string;
    title?: string;
    model?: ChatModelId;
    goalId?: string | null;
  }) =>
    apiRequest<{ conversation: ConversationRecord }>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),

  getConversation: (conversationId: string, workspaceId?: string) =>
    apiRequest<{
      conversation: ConversationRecord;
      messages: ConversationMessageRecord[];
      artifacts: ConversationArtifactRecord[];
      hydratedGoal: HydratedGoalExecutionContext | null;
    }>(
      `/api/conversations/${conversationId}${buildQuery({ workspaceId })}`
    ),

  updateConversation: (
    conversationId: string,
    payload: {
      workspaceId?: string;
      title?: string;
      archived?: boolean;
      pinned?: boolean;
      model?: ChatModelId;
    }
  ) =>
    apiRequest<{ conversation: ConversationRecord }>(
      `/api/conversations/${conversationId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }
    ),

  deleteConversation: (conversationId: string, workspaceId?: string) =>
    apiRequest<{ deleted: boolean }>(
      `/api/conversations/${conversationId}${buildQuery({ workspaceId })}`,
      { method: 'DELETE' }
    ),

  streamConversationMessage: async (params: {
    conversationId: string;
    content?: string;
    attachments?: ChatAttachmentRecord[];
    model?: ChatModelId;
    executionMode?: 'auto' | 'chat' | 'execute';
    action?: 'send' | 'edit' | 'regenerate';
    targetMessageId?: string;
    signal?: AbortSignal;
    onConversationUpdated?: (conv: ConversationRecord) => void;
    onMessageStarted?: (payload: {
      userMessage: ConversationMessageRecord;
      assistantMessage: ConversationMessageRecord;
    }) => void;
    onExecutionTrace?: (payload: {
      trace: ChatExecutionTrace;
      hydratedGoal?: HydratedGoalExecutionContext | null;
    }) => void;
    onTextDelta?: (delta: string) => void;
    onArtifactsCreated?: (artifacts: ConversationArtifactRecord[]) => void;
    onDone?: (payload: {
      assistantMessage: ConversationMessageRecord | null;
      artifacts: ConversationArtifactRecord[];
      conversation: ConversationRecord;
      stopped: boolean;
    }) => void;
  }): Promise<void> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (inMemoryBearerToken) {
      headers['Authorization'] = `Bearer ${inMemoryBearerToken}`;
    }
    const wsToken = getGoogleWorkspaceAccessToken();
    if (wsToken) {
      headers['X-Google-Access-Token'] = wsToken;
    }

    const res = await fetch(
      `/api/conversations/${params.conversationId}/messages/stream`,
      {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          content: params.content ?? '',
          attachments: params.attachments ?? [],
          model: params.model,
          executionMode: params.executionMode ?? 'auto',
          action: params.action ?? 'send',
          targetMessageId: params.targetMessageId,
        }),
        signal: params.signal,
      }
    );

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(
        typeof errBody?.error === 'string'
          ? errBody.error
          : `Streaming request failed (${res.status})`
      );
    }

    if (!res.body) {
      throw new Error('Streaming response body unavailable.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processEventBlock = (block: string) => {
      const lines = block.split('\n');
      let eventName = 'message';
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (dataLines.length === 0) return;
      const rawJson = dataLines.join('\n');
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawJson) as Record<string, unknown>;
      } catch {
        return;
      }

      switch (eventName) {
        case 'conversation_updated':
          if (parsed.conversation) {
            params.onConversationUpdated?.(
              parsed.conversation as ConversationRecord
            );
          }
          break;
        case 'message_started':
          params.onMessageStarted?.(
            parsed as unknown as {
              userMessage: ConversationMessageRecord;
              assistantMessage: ConversationMessageRecord;
            }
          );
          break;
        case 'execution_trace':
          params.onExecutionTrace?.(
            parsed as unknown as {
              trace: ChatExecutionTrace;
              hydratedGoal?: HydratedGoalExecutionContext | null;
            }
          );
          break;
        case 'text_delta':
          if (typeof parsed.delta === 'string') {
            params.onTextDelta?.(parsed.delta);
          }
          break;
        case 'artifacts_created':
          if (Array.isArray(parsed.artifacts)) {
            params.onArtifactsCreated?.(
              parsed.artifacts as ConversationArtifactRecord[]
            );
          }
          break;
        case 'done':
          params.onDone?.(
            parsed as unknown as {
              assistantMessage: ConversationMessageRecord | null;
              artifacts: ConversationArtifactRecord[];
              conversation: ConversationRecord;
              stopped: boolean;
            }
          );
          break;
        case 'error':
          throw new Error(
            typeof parsed.error === 'string'
              ? parsed.error
              : 'Streaming AI response failed.'
          );
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.trim().length > 0) {
            processEventBlock(block);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      if (buffer.trim().length > 0) {
        processEventBlock(buffer);
      }
    } finally {
      reader.releaseLock();
    }
  },

  listArtifacts: (workspaceId?: string, conversationId?: string) =>
    apiRequest<{ artifacts: ConversationArtifactRecord[] }>(
      `/api/artifacts${buildQuery({ workspaceId, conversationId })}`
    ),

  downloadArtifact: async (artifact: ConversationArtifactRecord) => {
    const headers: Record<string, string> = {};
    if (inMemoryBearerToken) {
      headers['Authorization'] = `Bearer ${inMemoryBearerToken}`;
    }

    const res = await fetch(`/api/artifacts/${artifact.id}/download`, {
      method: 'GET',
      credentials: 'include',
      headers,
    });

    const blob = res.ok
      ? await res.blob()
      : new Blob([artifact.content], {
          type: `${artifact.mimeType};charset=utf-8`,
        });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = artifact.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

