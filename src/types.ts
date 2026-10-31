export type GoalStatus =
  | 'draft'
  | 'planning'
  | 'active'
  | 'blocked'
  | 'completed'
  | 'failed';

export type GoalExecutionState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'blocked';

export type ToolId =
  | 'llm_reasoning'
  | 'internal_test_tool'
  | 'n8n_webhook'
  | 'custom_webhook'
  | 'make_webhook'
  | 'zapier_webhook'
  | 'crm_webhook'
  | 'gmail_api'
  | 'google_calendar_api'
  | 'payment_webhook'
  | 'gmail_native'
  | 'google_calendar_native'
  | 'google_drive_native'
  | 'slack_native'
  | 'telegram_native'
  | 'microsoft_outlook_native'
  | 'microsoft_teams_native'
  | 'custom_api'
  | 'unsupported';

export type CapabilityId =
  | 'ai_reasoning'
  | 'content_drafting'
  | 'prospect_qualification'
  | 'diagnostic_verification'
  | 'workflow_automation'
  | 'message_dispatch'
  | 'crm_sync'
  | 'prospect_search'
  | 'http_request'
  | 'calendar_booking'
  | 'payment_verification'
  | 'email_read'
  | 'calendar_read'
  | 'file_storage'
  | 'team_messaging'
  | 'custom_api_execution';

export type TaskActionCategory =
  | 'prospect_research'
  | 'prospect_qualification'
  | 'message_draft'
  | 'message_send'
  | 'calendar_booking'
  | 'crm_update'
  | 'payment_collection'
  | 'external_workflow'
  | 'internal_test'
  | 'analysis'
  | 'unsupported';

export type ApprovalStatus =
  | 'not_required'
  | 'pending'
  | 'approved'
  | 'rejected';

export type TaskStatus =
  | 'proposed'
  | 'approved'
  | 'queued'
  | 'attempted'
  | 'running'
  | 'completed'
  | 'pending_verification'
  | 'verified'
  | 'rejected'
  | 'blocked'
  | 'failed';

export type VerificationState =
  | 'unverified'
  | 'pending_verification'
  | 'verified'
  | 'rejected';

export type VerificationMethodType =
  | 'deterministic'
  | 'evidence_based'
  | 'human_review'
  | 'ai_assisted_recommendation';

export type ActionLogStatus =
  | 'proposed'
  | 'approved'
  | 'queued'
  | 'attempted'
  | 'completed'
  | 'pending_verification'
  | 'verified'
  | 'rejected'
  | 'blocked'
  | 'failed';

export type IntegrationProviderKey =
  | 'n8n_webhook'
  | 'custom_webhook'
  | 'make_webhook'
  | 'zapier_webhook'
  | 'crm_webhook'
  | 'gmail_api'
  | 'google_calendar_api'
  | 'payment_webhook'
  | 'gmail_native'
  | 'google_calendar_native'
  | 'google_drive_native'
  | 'slack_native'
  | 'telegram_native'
  | 'microsoft_outlook_native'
  | 'microsoft_teams_native'
  | 'custom_api';

export type IntegrationConnectionMode = 'user_owned' | 'platform_shared';

export type IntegrationAuthType =
  | 'none'
  | 'header_secret'
  | 'bearer_token'
  | 'hmac_sha256'
  | 'api_key'
  | 'oauth2'
  | 'basic_auth'
  | 'bot_token'
  | 'google_workspace_oauth';

export type IntegrationCenterCategory =
  | 'recommended'
  | 'connected_apps'
  | 'automation_platforms'
  | 'ai_providers'
  | 'custom_api'
  | 'webhooks'
  | 'health';

export type ConnectorType =
  | 'built_in'
  | 'native_oauth'
  | 'native_token'
  | 'webhook'
  | 'custom_api'
  | 'ai_provider';

export type ConnectorAuthStatus =
  | 'not_connected'
  | 'connected'
  | 'authorized'
  | 'reconnect_required'
  | 'revoked'
  | 'error'
  | 'configured';

export type ConnectorHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'untested'
  | 'disabled';

export type CapabilityReadinessState =
  | 'available'
  | 'connected'
  | 'authorized'
  | 'configured'
  | 'tested'
  | 'operational'
  | 'unavailable';

export type CustomApiHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CustomApiConfigMetadata {
  baseUrl: string;
  httpMethod: CustomApiHttpMethod;
  endpointPath: string;
  requestHeaders?: Record<string, string>;
  requestParams?: Record<string, string>;
  requestBodySchema?: Record<string, unknown> | null;
  timeoutMs: number;
  allowedOperations: string[];
  apiKeyHeaderName?: string;
  basicAuthUsername?: string;
}

export type EvidenceType =
  | 'message_delivered'
  | 'reply_received'
  | 'qualified_lead'
  | 'prospect_identified'
  | 'meeting_booked'
  | 'payment_confirmed'
  | 'customer_acquired'
  | 'custom_outcome'
  | 'api_dispatch_ack'
  | 'diagnostic_checksum'
  | 'outcome_reversal';

export type EvidenceProvenanceClass =
  | 'internal_diagnostic'
  | 'ai_assessed'
  | 'unverified_claim'
  | 'authenticated_webhook'
  | 'provider_confirmed'
  | 'human_confirmed';

export type EvidenceTrustTier =
  | 'untrusted'
  | 'advisory'
  | 'diagnostic_only'
  | 'transport_authenticated'
  | 'provider_verified'
  | 'human_verified';

export type ProviderImplementationClass =
  | 'native_implemented'
  | 'generic_webhook_adapter'
  | 'partially_implemented'
  | 'registered_unavailable';

export interface ProposedActionDetails {
  proposedAction: string;
  targetRecipient: string;
  estimatedCost: string;
  explanation: string;
}

export interface WorkspaceRecord {
  id: string;
  ownerUserId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  createdAt: string;
}

export interface GoalRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  problem: string;
  description: string;
  targetMetric: string;
  deadline: string | null;
  status: GoalStatus;
  executionState: GoalExecutionState;
  progressPercent: number;
  achievedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  goalId: string;
  userId: string;
  workspaceId: string | null;
  stepOrder: number;
  description: string;
  tool: ToolId;
  requiredCapabilities: CapabilityId[];
  assignedProvider: string | null;
  assignedIntegrationId: string | null;
  actionCategory: TaskActionCategory;
  dependencies: string[];
  approvalRequired: boolean;
  approvalStatus: ApprovalStatus;
  approvalDecisionAt: string | null;
  approvalDecisionBy: string | null;
  proposedActionDetails: ProposedActionDetails | null;
  expectedResult: string;
  verificationMethod: string;
  status: TaskStatus;
  verificationStatus: VerificationState;
  statusReason: string | null;
  outputData: Record<string, unknown> | null;
  lockedBy: string | null;
  lockedAt: string | null;
  retryCount: number;
  maxRetries: number;
  backoffBaseMs: number;
  nextRetryAt: string | null;
  executionTimeoutMs: number;
  startedAt: string | null;
  completedAt: string | null;
  verifiedAt: string | null;
  lastDurationMs: number | null;
  reconciliationRequired: boolean;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActionLogRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  goalId: string;
  taskId: string | null;
  executionProvider: string;
  actionType: string;
  status: ActionLogStatus;
  timestamp: string;
  resultSummary: string;
  evidence: Record<string, unknown> | null;
  errorMessage: string | null;
}

export interface IntegrationPublicMetadata {
  endpointUrl?: string;
  destinationOrigin?: string;
  workflowId?: string;
  webhookPath?: string;
  authType: IntegrationAuthType;
  secretHeaderName?: string;
  n8nSetupMode?: 'existing_instance' | 'manual_webhook';
  n8nBaseUrl?: string;
  customApi?: CustomApiConfigMetadata;
  nativeAccountEmail?: string;
  nativeAccountLabel?: string;
  slackDefaultChannel?: string;
  telegramDefaultChatId?: string;
}

/**
 * Sanitized integration record safe for frontend & API responses.
 * Raw secrets and ciphertexts are NEVER included here.
 */
export interface UserIntegrationRecord {
  id: string;
  userId: string;
  workspaceId: string;
  providerKey: IntegrationProviderKey;
  displayName: string;
  connectionMode: IntegrationConnectionMode;
  connectorType?: ConnectorType;
  connectorCategory?: IntegrationCenterCategory;
  authStatus?: ConnectorAuthStatus;
  grantedScopes?: string[];
  healthStatus?: ConnectorHealthStatus;
  capabilities: CapabilityId[];
  configMetadata: IntegrationPublicMetadata;
  hasSecret: boolean;
  secretMaskedHint: string | null;
  enabled: boolean;
  verified: boolean;
  statusDetail: string;
  lastTestedAt: string | null;
  lastSuccessAt?: string | null;
  lastActivityAt?: string | null;
  lastErrorMessage?: string | null;
  rateLimitRpm?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRateLimitInfo {
  requestsPerMinute: number;
  burstLimit: number;
}

export interface ToolRegistryItem {
  id: ToolId;
  name: string;
  scope: 'built_in' | 'tenant_configurable';
  description: string;
  capabilities: CapabilityId[];
  authenticationMethod: string;
  executionInterface: 'built_in_runtime' | 'https_json_webhook' | 'rest_api_bearer';
  verificationCapabilities: VerificationMethodType[];
  healthStatus: 'healthy' | 'untested' | 'disabled' | 'unconfigured';
  rateLimit: ProviderRateLimitInfo;
  supportedOperations: string[];
  implementationStatus: 'implemented_and_tested' | 'implemented_requires_external_credentials';
  integrationClassification: ProviderImplementationClass;
  configured: boolean;
  verified: boolean;
  statusDetail: string;
  activeIntegrationName?: string | null;
  lastTestedAt: string | null;
}

export interface PlatformCapabilitiesInfo {
  sharedN8nAvailable: boolean;
  sharedN8nOrigin: string | null;
  dedicatedVaultKeyConfigured: boolean;
  isPlatformAdmin: boolean;
}

export interface ExecutionRunRecord {
  id: string;
  userId: string;
  workspaceId: string;
  goalId: string;
  triggerType: 'manual_cycle' | 'single_task' | 'continuous_cycle' | 'recovery';
  status: 'running' | 'paused' | 'completed' | 'cancelled' | 'failed' | 'halted_for_approval';
  concurrencyMode: 'sequential' | 'parallel_safe';
  tasksDispatched: number;
  tasksSucceeded: number;
  tasksFailed: number;
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface TaskAttemptRecord {
  id: string;
  userId: string;
  workspaceId: string;
  goalId: string;
  taskId: string;
  runId: string | null;
  attemptNumber: number;
  workerId: string;
  providerKey: string;
  idempotencyKey: string;
  status:
    | 'running'
    | 'completed'
    | 'pending_verification'
    | 'verified'
    | 'failed'
    | 'timed_out'
    | 'stalled_recovered';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  nextRetryAt: string | null;
  errorMessage: string | null;
  outputSummary: string | null;
}

export interface InboundWebhookPublicConfig {
  workspaceId: string;
  configured: boolean;
  enabled: boolean;
  endpointPath: string;
  maskedHint: string | null;
  signatureHeader: string;
  timestampHeader: string;
  updatedAt: string | null;
}

export interface OutcomeEvidenceRecord {
  id: string;
  userId: string;
  workspaceId: string;
  goalId: string;
  taskId: string | null;
  inboundEventId: string | null;
  sourceType: 'inbound_webhook' | 'deterministic_execution' | 'manual_submission';
  provider: string;
  evidenceType: EvidenceType;
  externalReferenceId: string | null;
  summary: string;
  structuredMetrics: Record<string, unknown>;
  sanitizedPayload: Record<string, unknown>;
  provenanceClass: EvidenceProvenanceClass;
  trustTier: EvidenceTrustTier;
  hasConflict: boolean;
  requiresHumanReview: boolean;
  verificationState: 'pending_verification' | 'verified' | 'rejected';
  observedAt: string;
  createdAt: string;
}

export interface VerificationDecisionRecord {
  id: string;
  userId: string;
  workspaceId: string;
  goalId: string;
  taskId: string | null;
  evidenceId: string | null;
  verificationMethod: VerificationMethodType;
  decision:
    | 'verified'
    | 'pending_verification'
    | 'rejected'
    | 'recommended_verify'
    | 'recommended_reject';
  reviewerIdentity: string;
  notes: string;
  traceMetadata: Record<string, unknown>;
  decidedAt: string;
}

export interface GoalMetricValueRecord {
  id: string;
  userId: string;
  workspaceId: string;
  goalId: string;
  metricKey: string;
  metricLabel: string;
  unit: 'count' | 'USD' | 'NGN' | 'EUR' | 'GBP' | 'percent';
  isPrimaryTarget: boolean;
  targetValue: number;
  attemptedValue: number;
  completedValue: number;
  verifiedValue: number;
  estimatedValue: number;
  updatedAt: string;
}

export interface ReasoningCycleRecord {
  id: string;
  userId: string;
  workspaceId: string;
  goalId: string;
  triggerSource: 'post_cycle' | 'post_verification' | 'manual';
  modelUsed: string;
  currentAssessment: string;
  goalAchievedRecommendation: boolean;
  humanInterventionRequired: boolean;
  confidenceLevel: 'low' | 'medium' | 'high';
  reasoningSummary: string;
  findings: string[];
  recommendedNextActions: string[];
  structuredOutput: Record<string, unknown>;
  createdAt: string;
}

export interface NextActionProposalRecord {
  id: string;
  reasoningCycleId: string;
  userId: string;
  workspaceId: string;
  goalId: string;
  proposalType: 'new_task' | 'retry_task' | 'update_dependencies' | 'human_intervention';
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
  status: 'proposed' | 'enqueued' | 'rejected';
  enqueuedTaskId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ExecutionMonitorSnapshot {
  workspaceId: string;
  counts: {
    activeGoals: number;
    queuedTasks: number;
    runningTasks: number;
    completedTasks: number;
    pendingVerificationTasks: number;
    verifiedOutcomes: number;
    failedTasks: number;
    blockedTasks: number;
    awaitingApprovalTasks: number;
    totalRetryAttempts: number;
    totalExecutionDurationMs: number;
    readyProvidersCount: number;
  };
  runs: ExecutionRunRecord[];
  attempts: TaskAttemptRecord[];
  evidence: OutcomeEvidenceRecord[];
  verifications: VerificationDecisionRecord[];
  goalMetrics: GoalMetricValueRecord[];
  reasoningCycles: ReasoningCycleRecord[];
  proposals: NextActionProposalRecord[];
  inboundWebhook: InboundWebhookPublicConfig;
}

export interface ResultsReportSummary {
  metrics: {
    prospectsFound: number;
    qualifiedProspects: number;
    messagesDrafted: number;
    messagesSent: number;
    messagesDeliveredVerified: number;
    repliesReceived: number;
    meetingsBooked: number;
    dealsWon: number;
    revenueEarnedUsd: number;
    blockedTasks: number;
    executionFailures: number;
  };
  processSummary: {
    totalGoals: number;
    activeGoals: number;
    completedTasks: number;
    pendingVerificationTasks: number;
    verifiedTasks: number;
    queuedTasks: number;
    pendingApprovals: number;
  };
  dataProvenance: 'evidence_backed_real_records';
  missingConfigurations: Array<{
    toolId: ToolId;
    name: string;
    requiredCapabilities: CapabilityId[];
    impact: string;
  }>;
  goalComparisons: Array<{
    goalId: string;
    problem: string;
    deadline: string | null;
    statedTargetMetric: string;
    goalStatus: GoalStatus;
    progressPercent: number;
    verifiedOutcomesCount: number;
    draftedArtifactsCount: number;
    blockedCount: number;
    failedCount: number;
    metricBreakdown?: GoalMetricValueRecord[];
  }>;
}

export interface AuthSessionUser {
  uid: string;
  email: string;
  authMode: 'google' | 'isolated_session';
}

export type EnvRequirementLevel = 'required_in_production' | 'optional' | 'conditional';

export type EnvValidationState =
  | 'configured_valid'
  | 'dev_persisted_key'
  | 'optional_blank'
  | 'action_required';

export interface EnvironmentVariableDiagnostic {
  name: string;
  requirement: EnvRequirementLevel;
  requirementLabel: string;
  state: EnvValidationState;
  statusSummary: string;
  expectedFormat: string;
  generateCommand: string | null;
  safeToLeaveBlank: boolean;
  safeToLeaveBlankDetail: string;
  dependentFeatures: string;
}

export interface EnvironmentDiagnosticsResponse {
  runtimeMode: 'production' | 'development' | 'test';
  readyWithoutN8n: boolean;
  sharedN8nEnabled: boolean;
  variables: EnvironmentVariableDiagnostic[];
}

export type ChatModelId =
  | 'gemini-3.8-flash'
  | 'gemini-3.1-flash-lite'
  | 'gemini-flash-latest';

export interface ChatAttachmentRecord {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'image' | 'file';
  dataUrl?: string;
  textContent?: string;
}

export type ExecutionStageKey =
  | 'understanding_objective'
  | 'planning'
  | 'task_breakdown'
  | 'tool_selection'
  | 'execution'
  | 'verification'
  | 'completed_results';

export type ExecutionStageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'awaiting_approval'
  | 'pending_verification'
  | 'blocked'
  | 'failed';

export interface ExecutionStageItem {
  key: ExecutionStageKey;
  label: string;
  status: ExecutionStageStatus;
  summary: string;
  details?: string[];
  updatedAt: string;
}

export interface ChatExecutionTrace {
  mode: 'autonomous_execution';
  goalId: string | null;
  goalProblem: string;
  targetMetric: string;
  runId: string | null;
  stages: ExecutionStageItem[];
  honestCompletionNote: string;
  hasVerifiedBusinessOutcome: boolean;
  awaitingApprovalCount: number;
  pendingVerificationCount: number;
  interactivePrompt?: ChatInteractivePromptPayload | null;
}

export type ArtifactType =
  | 'report'
  | 'document'
  | 'spreadsheet'
  | 'plan'
  | 'code'
  | 'outreach_draft';

export interface ConversationArtifactRecord {
  id: string;
  conversationId: string;
  messageId: string | null;
  goalId: string | null;
  taskId: string | null;
  userId: string;
  workspaceId: string;
  title: string;
  artifactType: ArtifactType;
  mimeType: string;
  filename: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationMessageRecord {
  id: string;
  conversationId: string;
  userId: string;
  workspaceId: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  status: 'streaming' | 'completed' | 'stopped' | 'error';
  attachments: ChatAttachmentRecord[];
  executionTrace: ChatExecutionTrace | null;
  artifactIds: string[];
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRecord {
  id: string;
  userId: string;
  workspaceId: string;
  goalId: string | null;
  title: string;
  model: ChatModelId;
  archived: boolean;
  pinned: boolean;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  messagePreview?: string | null;
}

export interface HydratedGoalExecutionContext {
  goal: GoalRecord;
  tasks: TaskRecord[];
  metrics: GoalMetricValueRecord[];
  evidence: OutcomeEvidenceRecord[];
  attempts: TaskAttemptRecord[];
}

export interface N8nRegisteredWorkflowRecord {
  id: string;
  integrationId: string;
  userId: string;
  workspaceId: string;
  workflowExternalId: string;
  name: string;
  description: string;
  webhookUrlOrPath: string;
  httpMethod: CustomApiHttpMethod;
  capabilities: CapabilityId[];
  inputSchema: Record<string, unknown>;
  active: boolean;
  discoveredViaApi: boolean;
  lastTriggeredAt: string | null;
  lastStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationActivityLogRecord {
  id: string;
  userId: string;
  workspaceId: string;
  integrationId: string | null;
  providerKey: string;
  operation: string;
  direction: 'outbound' | 'inbound' | 'health_check' | 'auth';
  status: 'success' | 'error' | 'deduplicated';
  httpStatus: number | null;
  durationMs: number | null;
  summary: string;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface IntegrationRegistryEntry {
  connectorId: string;
  workspaceId: string;
  providerKey: ToolId;
  connectorName: string;
  description: string;
  connectorType: ConnectorType;
  category: IntegrationCenterCategory;
  recommended: boolean;
  authenticationType: string;
  connectionStatus: 'not_connected' | 'connected' | 'configured' | 'disabled' | 'error';
  authorizationStatus: ConnectorAuthStatus;
  authorizationScopes: string[];
  availableCapabilities: CapabilityId[];
  supportedOperations: string[];
  rateLimit: ProviderRateLimitInfo;
  healthStatus: ConnectorHealthStatus;
  capabilityReadiness: CapabilityReadinessState;
  lastSuccessfulConnection: string | null;
  lastActivity: string | null;
  failureInformation: string | null;
  integrationId: string | null;
  oauthAppConfigured: boolean;
  reconnectRequired: boolean;
  registeredWorkflowCount?: number;
}

export interface CapabilityStatusEntry {
  capability: CapabilityId;
  label: string;
  state: CapabilityReadinessState;
  operationalProviders: string[];
  candidateProviders: string[];
  detail: string;
}

export type AiProviderId = 'gemini' | 'openai' | 'anthropic';

export interface AiProviderStatusRecord {
  providerId: AiProviderId;
  workspaceId: string;
  name: string;
  description: string;
  isBuiltInDefault: boolean;
  serverKeyConfigured: boolean;
  enabled: boolean;
  preferredModel: string;
  supportedModels: string[];
  fallbackPriority: number;
  healthStatus: ConnectorHealthStatus;
  totalRequests: number;
  failedRequests: number;
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  lastErrorMessage: string | null;
}

export interface WorkforceConnectorRecommendation {
  providerKey: IntegrationProviderKey;
  connectorName: string;
  connectorType: ConnectorType;
  requiredForCapabilities: CapabilityId[];
  reasonNeeded: string;
  currentReadiness: CapabilityReadinessState;
  integrationId: string | null;
  decision: 'pending' | 'approved' | 'rejected' | 'modified';
  alternativeProviderKeys: IntegrationProviderKey[];
}

export interface WorkforceConfigurationRecord {
  id: string;
  userId: string;
  workspaceId: string;
  goalId: string | null;
  conversationId: string | null;
  title: string;
  requestPrompt: string;
  roleSummary: string;
  status:
    | 'draft'
    | 'awaiting_authorization'
    | 'testing'
    | 'operational'
    | 'degraded'
    | 'rejected';
  requiredCapabilities: CapabilityId[];
  recommendedConnectors: WorkforceConnectorRecommendation[];
  approvedConnectorIds: string[];
  rejectedProviders: string[];
  capabilityMatrix: Record<CapabilityId, CapabilityReadinessState>;
  missingCapabilities: CapabilityId[];
  activationBlockerReason: string | null;
  lastTestedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatInteractivePromptPayload {
  kind: 'workforce_configuration' | 'connector_authorization';
  workforceConfigId?: string | null;
  targetProviderKey?: IntegrationProviderKey | null;
  title: string;
  summary: string;
  requiredCapabilities: CapabilityId[];
  recommendedConnectors: WorkforceConnectorRecommendation[];
  status: string;
  activationBlockerReason: string | null;
}


