import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Cpu,
  KeyRound,
  MessageSquare,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Sun,
  Trash2,
  XCircle,
} from 'lucide-react';
import { SUPPORTED_CHAT_MODELS } from '../../lib/chat-utils';
import { ArtifactCard } from './ArtifactCard';
import { TaskDagVisualizer } from '../TaskDagVisualizer';
import { IntegrationCenterView } from '../integrations/IntegrationCenterView';
import type { SidebarSection } from './ChatSidebar';
import type {
  ActionLogRecord,
  AiProviderStatusRecord,
  CapabilityId,
  CapabilityStatusEntry,
  ChatModelId,
  ConversationArtifactRecord,
  EnvironmentDiagnosticsResponse,
  EvidenceType,
  ExecutionMonitorSnapshot,
  GoalRecord,
  GoalStatus,
  IntegrationActivityLogRecord,
  IntegrationAuthType,
  IntegrationConnectionMode,
  IntegrationProviderKey,
  IntegrationRegistryEntry,
  N8nRegisteredWorkflowRecord,
  PlatformCapabilitiesInfo,
  ResultsReportSummary,
  TaskRecord,
  ToolRegistryItem,
  UserIntegrationRecord,
  WorkforceConfigurationRecord,
  WorkspaceRecord,
} from '../../types';

interface WorkspaceSecondaryViewsProps {
  section: Exclude<SidebarSection, 'chat'>;
  workspaceName: string;
  workspaces: WorkspaceRecord[];
  selectedWorkspaceId: string | null;
  goals: GoalRecord[];
  selectedGoalId: string | null;
  tasks: TaskRecord[];
  logs: ActionLogRecord[];
  report: ResultsReportSummary | null;
  snapshot: ExecutionMonitorSnapshot | null;
  tools: ToolRegistryItem[];
  integrations: UserIntegrationRecord[];
  registry: IntegrationRegistryEntry[];
  capabilityEntries: CapabilityStatusEntry[];
  n8nWorkflows: N8nRegisteredWorkflowRecord[];
  aiProviders: AiProviderStatusRecord[];
  activityLogs: IntegrationActivityLogRecord[];
  workforceConfigs: WorkforceConfigurationRecord[];
  platformCapabilities: PlatformCapabilitiesInfo | null;
  workspaceArtifacts: ConversationArtifactRecord[];
  theme: 'light' | 'dark';
  defaultModel: ChatModelId;
  busyAction: string | null;
  onRefreshWorkspace: () => Promise<void>;
  onBackToChat: () => void;
  onOpenGoalInChat: (goal: GoalRecord) => Promise<void>;
  onSelectGoal: (goalId: string) => void;
  onOpenNewGoal: () => void;
  onOpenEditGoal: (goal: GoalRecord) => void;
  onUpdateGoalStatus: (goalId: string, status: GoalStatus) => Promise<void>;
  onOpenAddTask: () => void;
  onGeneratePlan: (goalId: string) => Promise<void>;
  onOrchestrateGoal: (
    goalId: string,
    mode: 'sequential' | 'parallel_safe',
    autoReasoning: boolean
  ) => Promise<void>;
  onControlGoalExecution: (
    goalId: string,
    action: 'pause' | 'resume' | 'cancel'
  ) => Promise<void>;
  onExecuteTask: (taskId: string) => Promise<void>;
  onRetryTask: (taskId: string) => Promise<void>;
  onReconcileTask: (
    taskId: string,
    resolution:
      | 'reconcile_from_evidence'
      | 'mark_dispatched_pending_verification'
      | 'confirm_not_executed_requeue'
  ) => Promise<void>;
  onDecideApproval: (
    taskId: string,
    decision: 'approved' | 'rejected'
  ) => Promise<void>;
  onRunReasoning: (goalId: string) => Promise<void>;
  onDecideProposal: (
    proposalId: string,
    decision: 'accept' | 'reject'
  ) => Promise<void>;
  onSubmitManualEvidence: (payload: {
    goalId: string;
    taskId?: string | null;
    provider?: string;
    evidenceType: EvidenceType;
    summary: string;
    externalReferenceId?: string | null;
    structuredMetrics?: Record<string, unknown>;
  }) => Promise<void>;
  onReviewEvidence: (
    evidenceId: string,
    decision: 'verified' | 'rejected',
    notes: string
  ) => Promise<void>;
  onAiVerifyEvidence: (evidenceId: string) => Promise<void>;
  onRotateInboundSecret: () => Promise<string>;
  onSendSignedWebhook: (params: {
    signingSecret: string;
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
  }) => Promise<{
    duplicate: boolean;
    message?: string;
    verificationState?: string;
    provenanceClass?: string;
  }>;
  onCreateIntegration: (payload: {
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
  }) => Promise<void>;
  onToggleIntegration: (id: string, enabled: boolean) => Promise<void>;
  onDeleteIntegration: (id: string) => Promise<void>;
  onTestIntegration: (
    id: string
  ) => Promise<{ success: boolean; statusDetail: string }>;
  onRotateWorkspaceKeys: () => Promise<{
    rotatedCount: number;
    alreadyCurrentCount: number;
    noSecretCount: number;
  }>;
  onFetchEnvironmentDiagnostics: () => Promise<EnvironmentDiagnosticsResponse>;
  onPreviewArtifact: (artifact: ConversationArtifactRecord) => void;
  onDownloadArtifact: (artifact: ConversationArtifactRecord) => void;
  onSetTheme: (theme: 'light' | 'dark') => void;
  onSetDefaultModel: (model: ChatModelId) => void;
  onSwitchWorkspace: (workspaceId: string) => Promise<void>;
  onCreateWorkspace: (name: string) => Promise<void>;
  onSelectSection: (section: SidebarSection) => void;
}

const PROVIDER_OPTIONS: Array<{
  key: IntegrationProviderKey;
  label: string;
  defaultCapabilities: CapabilityId[];
}> = [
  {
    key: 'custom_webhook',
    label: 'Custom HTTPS Webhook',
    defaultCapabilities: ['workflow_automation', 'http_request'],
  },
  {
    key: 'n8n_webhook',
    label: 'n8n Workflow Webhook',
    defaultCapabilities: ['workflow_automation', 'message_dispatch'],
  },
  {
    key: 'make_webhook',
    label: 'Make.com Scenario Webhook',
    defaultCapabilities: ['workflow_automation'],
  },
  {
    key: 'zapier_webhook',
    label: 'Zapier Catch Hook',
    defaultCapabilities: ['workflow_automation'],
  },
  {
    key: 'crm_webhook',
    label: 'CRM Sync Webhook',
    defaultCapabilities: ['crm_sync', 'prospect_search'],
  },
  {
    key: 'gmail_api',
    label: 'Gmail / Email Dispatch Relay',
    defaultCapabilities: ['message_dispatch'],
  },
  {
    key: 'google_calendar_api',
    label: 'Google Calendar Booking Adapter',
    defaultCapabilities: ['calendar_booking'],
  },
  {
    key: 'payment_webhook',
    label: 'Payment Verification Webhook',
    defaultCapabilities: ['payment_verification'],
  },
];

export const WorkspaceSecondaryViews: React.FC<
  WorkspaceSecondaryViewsProps
> = (props) => {
  const {
    section,
    workspaceName,
    workspaces,
    selectedWorkspaceId,
    goals,
    selectedGoalId,
    tasks,
    logs,
    report,
    snapshot,
    tools,
    integrations,
    registry,
    capabilityEntries,
    n8nWorkflows,
    aiProviders,
    activityLogs,
    workforceConfigs,
    workspaceArtifacts,
    theme,
    defaultModel,
    busyAction,
    onRefreshWorkspace,
    onBackToChat,
    onOpenGoalInChat,
    onSelectGoal,
    onOpenNewGoal,
    onOpenEditGoal,
    onOpenAddTask,
    onGeneratePlan,
    onOrchestrateGoal,
    onControlGoalExecution,
    onExecuteTask,
    onRetryTask,
    onReconcileTask,
    onDecideApproval,
    onRunReasoning,
    onDecideProposal,
    onSubmitManualEvidence,
    onReviewEvidence,
    onAiVerifyEvidence,
    onRotateInboundSecret,
    onSendSignedWebhook,
    onCreateIntegration,
    onToggleIntegration,
    onDeleteIntegration,
    onTestIntegration,
    onRotateWorkspaceKeys,
    onFetchEnvironmentDiagnostics,
    onPreviewArtifact,
    onDownloadArtifact,
    onSetTheme,
    onSetDefaultModel,
    onSwitchWorkspace,
    onCreateWorkspace,
    onSelectSection,
  } = props;

  // Sub-view filters
  const [taskFilter, setTaskFilter] = useState<
    'approvals' | 'all' | 'reconcile' | 'proposals'
  >('approvals');
  const [historyTab, setHistoryTab] = useState<
    'runs' | 'evidence' | 'logs' | 'outcomes'
  >('runs');
  const [settingsSubTab, setSettingsSubTab] = useState<
    'integrations' | 'workspace_runtime'
  >('integrations');

  // Evidence submission state
  const [evGoalId, setEvGoalId] = useState(selectedGoalId ?? '');
  const [evType, setEvType] = useState<EvidenceType>('qualified_lead');
  const [evSummary, setEvSummary] = useState('');
  const [evCount, setEvCount] = useState('1');
  const [evBusy, setEvBusy] = useState(false);
  const [evFeedback, setEvFeedback] = useState<string | null>(null);

  // Webhook signing secret & test bench
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [webhookTestSecret, setWebhookTestSecret] = useState('');
  const [webhookTestResult, setWebhookTestResult] = useState<string | null>(
    null
  );

  // Connected app creation form
  const [newProviderKey, setNewProviderKey] =
    useState<IntegrationProviderKey>('custom_webhook');
  const [newAppName, setNewAppName] = useState('');
  const [newEndpointUrl, setNewEndpointUrl] = useState('');
  const [newAuthType, setNewAuthType] = useState<IntegrationAuthType>('none');
  const [newSecret, setNewSecret] = useState('');
  const [appMessage, setAppMessage] = useState<string | null>(null);
  const [appSaving, setAppSaving] = useState(false);

  // Settings workspace & env diagnostics
  const [newWsName, setNewWsName] = useState('');
  const [wsCreating, setWsCreating] = useState(false);
  const [envDiag, setEnvDiag] = useState<EnvironmentDiagnosticsResponse | null>(
    null
  );
  const [envLoading, setEnvLoading] = useState(false);

  useEffect(() => {
    if (selectedGoalId && !evGoalId) {
      setEvGoalId(selectedGoalId);
    } else if (!evGoalId && goals[0]?.id) {
      setEvGoalId(goals[0].id);
    }
  }, [selectedGoalId, goals, evGoalId]);

  useEffect(() => {
    if (section === 'settings' && !envDiag && !envLoading) {
      setEnvLoading(true);
      onFetchEnvironmentDiagnostics()
        .then((res) => setEnvDiag(res))
        .catch(() => {})
        .finally(() => setEnvLoading(false));
    }
  }, [section, envDiag, envLoading, onFetchEnvironmentDiagnostics]);

  const activeGoal =
    goals.find((g) => g.id === selectedGoalId) ?? goals[0] ?? null;

  const pendingApprovals = tasks.filter(
    (t) =>
      t.approvalRequired &&
      t.approvalStatus === 'pending' &&
      t.status !== 'rejected'
  );
  const reconcileTasks = tasks.filter((t) => t.reconciliationRequired);
  const proposals = snapshot?.proposals.filter((p) => p.status === 'proposed') ?? [];

  const sectionTitleMap: Record<Exclude<SidebarSection, 'chat'>, string> = {
    projects: 'Projects & Dependency Graphs',
    tasks: 'Task Queue & Approval Gate',
    history: 'Execution History & Verification Evidence',
    apps: 'Connected Apps & Provider Adapters',
    settings: 'Workspace & Platform Settings',
  };

  return (
    <div className="flex-1 overflow-y-auto bg-white dark:bg-[#0b0f17] text-slate-900 dark:text-slate-100">
      <div className="max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Contextual Top Return Strip */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div className="space-y-1">
            <button
              type="button"
              onClick={onBackToChat}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Chat</span>
            </button>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              {sectionTitleMap[section]}
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Workspace: {workspaceName} · Multi-tenant isolated state
            </p>
          </div>

          {section === 'projects' && (
            <button
              type="button"
              onClick={onOpenNewGoal}
              className="min-h-[38px] px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white rounded-xl inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Project</span>
            </button>
          )}

          {section === 'tasks' && activeGoal && (
            <button
              type="button"
              onClick={onOpenAddTask}
              className="min-h-[38px] px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white rounded-xl inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Queued Task</span>
            </button>
          )}
        </div>

        {/* 1. PROJECTS VIEW */}
        {section === 'projects' && (
          <div className="space-y-6">
            {goals.length === 0 ? (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-10 text-center space-y-3">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  No execution projects yet
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                  Describe a complex objective directly in Chat, or create a
                  structured execution project here to inspect its DAG and
                  verified target progress.
                </p>
                <div className="pt-2 flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={onBackToChat}
                    className="min-h-[38px] px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 bg-slate-900 dark:bg-slate-100 rounded-xl cursor-pointer"
                  >
                    Start in Chat
                  </button>
                  <button
                    type="button"
                    onClick={onOpenNewGoal}
                    className="min-h-[38px] px-4 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-xl cursor-pointer"
                  >
                    Create Project Manually
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {goals.map((goal) => {
                    const isSelected = activeGoal?.id === goal.id;
                    const gTasks = tasks.filter((t) => t.goalId === goal.id);
                    const gVerified = gTasks.filter(
                      (t) => t.status === 'verified'
                    ).length;

                    return (
                      <div
                        key={goal.id}
                        className={`rounded-xl border p-4 space-y-3 transition-colors ${
                          isSelected
                            ? 'border-slate-900 dark:border-slate-200 bg-slate-50/70 dark:bg-slate-900/80'
                            : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <button
                            type="button"
                            onClick={() => onSelectGoal(goal.id)}
                            className="text-left min-w-0 flex-1 space-y-1 cursor-pointer"
                          >
                            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
                              {goal.problem}
                            </p>
                            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                              <span className="capitalize">{goal.status}</span>
                              <span aria-hidden="true">·</span>
                              <span>
                                Verified: {goal.progressPercent}%
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>
                                {gTasks.length} steps ({gVerified} verified)
                              </span>
                            </div>
                          </button>

                          <button
                            type="button"
                            onClick={() => onOpenGoalInChat(goal)}
                            aria-label={`Continue project in chat: ${goal.problem}`}
                            className="min-h-[34px] px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                            <span>Chat</span>
                          </button>
                        </div>

                        <p className="text-xs text-slate-600 dark:text-slate-400">
                          Target metric: {goal.targetMetric}
                        </p>

                        <div className="pt-2 border-t border-slate-200/80 dark:border-slate-800 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={() =>
                              onOrchestrateGoal(goal.id, 'sequential', true)
                            }
                            className="min-h-[32px] px-3 py-1 text-xs font-semibold text-white dark:text-slate-950 bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <Play className="w-3 h-3" />
                            <span>Run Cycle</span>
                          </button>

                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={() => onRunReasoning(goal.id)}
                            className="min-h-[32px] px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Cpu className="w-3 h-3" />
                            <span>AI Analysis</span>
                          </button>

                          {goal.executionState !== 'paused' ? (
                            <button
                              type="button"
                              disabled={busyAction !== null}
                              onClick={() =>
                                onControlGoalExecution(goal.id, 'pause')
                              }
                              className="min-h-[32px] px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Pause className="w-3 h-3" />
                              <span>Pause</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busyAction !== null}
                              onClick={() =>
                                onControlGoalExecution(goal.id, 'resume')
                              }
                              className="min-h-[32px] px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Play className="w-3 h-3" />
                              <span>Resume</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => onOpenEditGoal(goal)}
                            className="min-h-[32px] px-2.5 py-1 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                          >
                            Edit
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {activeGoal && (
                  <TaskDagVisualizer
                    goal={activeGoal}
                    tasks={tasks}
                    tools={tools}
                    busyAction={busyAction}
                    onGeneratePlan={onGeneratePlan}
                    onOpenAddTask={onOpenAddTask}
                    onExecuteTask={onExecuteTask}
                    onRetryTask={onRetryTask}
                    onReconcileTask={onReconcileTask}
                    onOpenApprovalTab={() => {
                      setTaskFilter('approvals');
                      onSelectSection('tasks');
                    }}
                    onOpenIntegrationsTab={() => onSelectSection('apps')}
                    onControlGoalExecution={onControlGoalExecution}
                  />
                )}

                {/* Workspace Generated Artifacts */}
                {workspaceArtifacts.length > 0 && (
                  <section className="space-y-3">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Workspace Deliverables &amp; Artifacts (
                      {workspaceArtifacts.length})
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {workspaceArtifacts.slice(0, 8).map((art) => (
                        <ArtifactCard
                          key={art.id}
                          artifact={art}
                          onPreview={onPreviewArtifact}
                          onDownload={onDownloadArtifact}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}

        {/* 2. TASKS & APPROVAL GATE VIEW */}
        {section === 'tasks' && (
          <div className="space-y-5">
            <div
              role="group"
              aria-label="Filter workspace tasks"
              className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-xl"
            >
              <button
                type="button"
                onClick={() => setTaskFilter('approvals')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors tabular-nums cursor-pointer ${
                  taskFilter === 'approvals'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Approval Gate ({pendingApprovals.length})
              </button>
              <button
                type="button"
                onClick={() => setTaskFilter('all')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors tabular-nums cursor-pointer ${
                  taskFilter === 'all'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                All Queued &amp; Active ({tasks.length})
              </button>
              <button
                type="button"
                onClick={() => setTaskFilter('reconcile')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors tabular-nums cursor-pointer ${
                  taskFilter === 'reconcile'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Reconciliation ({reconcileTasks.length})
              </button>
              <button
                type="button"
                onClick={() => setTaskFilter('proposals')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors tabular-nums cursor-pointer ${
                  taskFilter === 'proposals'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                AI Next-Actions ({proposals.length})
              </button>
            </div>

            {taskFilter === 'approvals' && (
              <div className="space-y-3">
                {pendingApprovals.length === 0 ? (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                    No consequential tasks are waiting at the Approval Gate.
                  </div>
                ) : (
                  pendingApprovals.map((task) => {
                    const parentGoal = goals.find((g) => g.id === task.goalId);
                    return (
                      <div
                        key={task.id}
                        className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/40 dark:bg-amber-950/20 p-4 flex flex-wrap items-center justify-between gap-4"
                      >
                        <div className="space-y-1 min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-amber-800 dark:text-amber-300 font-medium">
                            <ShieldAlert className="w-4 h-4 shrink-0" />
                            <span>Step {task.stepOrder}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{task.tool}</span>
                            {parentGoal && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="truncate max-w-xs">
                                  {parentGoal.problem}
                                </span>
                              </>
                            )}
                          </div>
                          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {task.description}
                          </p>
                          {task.proposedActionDetails && (
                            <p className="text-xs text-slate-600 dark:text-slate-400">
                              Target:{' '}
                              {task.proposedActionDetails.targetRecipient} ·
                              Cost: {task.proposedActionDetails.estimatedCost}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={() =>
                              onDecideApproval(task.id, 'approved')
                            }
                            className="min-h-[36px] px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-lg cursor-pointer"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={() =>
                              onDecideApproval(task.id, 'rejected')
                            }
                            className="min-h-[36px] px-3.5 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 rounded-lg cursor-pointer"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {taskFilter === 'all' && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs tabular-nums">
                  <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Step</th>
                      <th className="px-4 py-3 font-semibold">Description</th>
                      <th className="px-4 py-3 font-semibold">Provider</th>
                      <th className="px-4 py-3 font-semibold">Approval</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold">Verification</th>
                      <th className="px-4 py-3 font-semibold text-right">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {tasks.length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-4 py-8 text-center text-slate-500 dark:text-slate-400"
                        >
                          No tasks queued in this workspace yet.
                        </td>
                      </tr>
                    ) : (
                      tasks.map((t) => (
                        <tr
                          key={t.id}
                          className="hover:bg-slate-50/70 dark:hover:bg-slate-900/40"
                        >
                          <td className="px-4 py-3 font-mono font-semibold">
                            #{t.stepOrder}
                          </td>
                          <td className="px-4 py-3 max-w-md">
                            <p className="font-medium text-slate-900 dark:text-slate-100">
                              {t.description}
                            </p>
                            {t.statusReason && (
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                                {t.statusReason}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-slate-600 dark:text-slate-400">
                            {t.assignedProvider || t.tool}
                          </td>
                          <td className="px-4 py-3 capitalize">
                            {t.approvalStatus.replace(/_/g, ' ')}
                          </td>
                          <td className="px-4 py-3 capitalize font-medium">
                            {t.status.replace(/_/g, ' ')}
                          </td>
                          <td className="px-4 py-3 capitalize">
                            {t.verificationStatus.replace(/_/g, ' ')}
                          </td>
                          <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                            {(t.status === 'queued' ||
                              t.status === 'approved') &&
                              (!t.approvalRequired ||
                                t.approvalStatus === 'approved') && (
                                <button
                                  type="button"
                                  disabled={busyAction !== null}
                                  onClick={() => onExecuteTask(t.id)}
                                  className="px-2.5 py-1 rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 font-semibold cursor-pointer"
                                >
                                  Run
                                </button>
                              )}
                            {(t.status === 'failed' ||
                              t.status === 'blocked') &&
                              !t.reconciliationRequired && (
                                <button
                                  type="button"
                                  disabled={busyAction !== null}
                                  onClick={() => onRetryTask(t.id)}
                                  className="px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                                >
                                  Retry
                                </button>
                              )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {taskFilter === 'reconcile' && (
              <div className="space-y-3">
                {reconcileTasks.length === 0 ? (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                    No uncertain external executions require manual
                    reconciliation.
                  </div>
                ) : (
                  reconcileTasks.map((t) => (
                    <div
                      key={t.id}
                      className="rounded-xl border border-amber-200 dark:border-amber-900/60 p-4 space-y-3"
                    >
                      <div className="space-y-1">
                        <p className="text-sm font-semibold">
                          Step {t.stepOrder}: {t.description}
                        </p>
                        <p className="text-xs text-slate-600 dark:text-slate-400">
                          {t.statusReason ||
                            'External request timed out or crashed with uncertain side effects. Blind automatic retry is blocked.'}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            onReconcileTask(t.id, 'reconcile_from_evidence')
                          }
                          className="min-h-[34px] px-3 py-1.5 text-xs font-semibold bg-emerald-700 text-white rounded-lg cursor-pointer"
                        >
                          Reconcile from Evidence
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onReconcileTask(
                              t.id,
                              'mark_dispatched_pending_verification'
                            )
                          }
                          className="min-h-[34px] px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer"
                        >
                          Mark Dispatched (Await Proof)
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onReconcileTask(
                              t.id,
                              'confirm_not_executed_requeue'
                            )
                          }
                          className="min-h-[34px] px-3 py-1.5 text-xs font-medium border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 rounded-lg cursor-pointer"
                        >
                          Confirm Not Sent &amp; Re-queue
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {taskFilter === 'proposals' && (
              <div className="space-y-3">
                {proposals.length === 0 ? (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                    No pending AI next-action proposals. Run AI Analysis on a
                    project to generate grounded recommendations.
                  </div>
                ) : (
                  proposals.map((prop) => (
                    <div
                      key={prop.id}
                      className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <p className="text-sm font-semibold">{prop.title}</p>
                        <p className="text-xs text-slate-600 dark:text-slate-400">
                          {prop.description}
                        </p>
                        <p className="text-[11px] font-mono text-slate-500">
                          {prop.proposedTool} · Approval required:{' '}
                          {prop.approvalRequired ? 'Yes' : 'No'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => onDecideProposal(prop.id, 'accept')}
                          className="min-h-[34px] px-3 py-1.5 text-xs font-semibold bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 rounded-lg cursor-pointer"
                        >
                          Accept &amp; Enqueue
                        </button>
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => onDecideProposal(prop.id, 'reject')}
                          className="min-h-[34px] px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* 3. EXECUTION HISTORY & VERIFICATION EVIDENCE */}
        {section === 'history' && (
          <div className="space-y-5">
            <div
              role="group"
              aria-label="Execution history sections"
              className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-xl"
            >
              {(
                [
                  { id: 'runs', label: 'Orchestrator Runs' },
                  { id: 'evidence', label: 'Outcome Evidence' },
                  { id: 'logs', label: 'Action Audit Log' },
                  { id: 'outcomes', label: 'Verified Results' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setHistoryTab(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                    historyTab === tab.id
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {historyTab === 'runs' && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs tabular-nums">
                  <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Run ID</th>
                      <th className="px-4 py-3 font-semibold">Mode</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold">Dispatched</th>
                      <th className="px-4 py-3 font-semibold">Succeeded</th>
                      <th className="px-4 py-3 font-semibold">Failed</th>
                      <th className="px-4 py-3 font-semibold">Summary</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {!snapshot || snapshot.runs.length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-4 py-8 text-center text-slate-500 dark:text-slate-400"
                        >
                          No orchestrator runs recorded yet.
                        </td>
                      </tr>
                    ) : (
                      snapshot.runs.map((run) => (
                        <tr key={run.id}>
                          <td className="px-4 py-3 font-mono">
                            {run.id.slice(0, 8)}
                          </td>
                          <td className="px-4 py-3">{run.concurrencyMode}</td>
                          <td className="px-4 py-3 font-medium">
                            {run.status.replace(/_/g, ' ')}
                          </td>
                          <td className="px-4 py-3 font-mono">
                            {run.tasksDispatched}
                          </td>
                          <td className="px-4 py-3 font-mono">
                            {run.tasksSucceeded}
                          </td>
                          <td className="px-4 py-3 font-mono">
                            {run.tasksFailed}
                          </td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-400">
                            {run.summary || '—'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {historyTab === 'evidence' && (
              <div className="space-y-5">
                {goals.length > 0 && (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!evGoalId || !evSummary.trim()) return;
                      setEvBusy(true);
                      setEvFeedback(null);
                      try {
                        await onSubmitManualEvidence({
                          goalId: evGoalId,
                          evidenceType: evType,
                          summary: evSummary.trim(),
                          structuredMetrics: {
                            count: Math.max(1, Number(evCount) || 1),
                          },
                        });
                        setEvSummary('');
                        setEvFeedback(
                          'Evidence submitted (unverified_claim — requires human verification below before advancing target progress).'
                        );
                      } catch (err: unknown) {
                        setEvFeedback(
                          err instanceof Error
                            ? err.message
                            : 'Failed to submit evidence.'
                        );
                      } finally {
                        setEvBusy(false);
                      }
                    }}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3"
                  >
                    <h2 className="text-sm font-semibold">
                      Log External Outcome Claim for Verification
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                      <select
                        aria-label="Evidence project"
                        value={evGoalId}
                        onChange={(e) => setEvGoalId(e.target.value)}
                        className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      >
                        {goals.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.problem.slice(0, 48)}
                          </option>
                        ))}
                      </select>

                      <select
                        aria-label="Evidence type"
                        value={evType}
                        onChange={(e) =>
                          setEvType(e.target.value as EvidenceType)
                        }
                        className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      >
                        <option value="qualified_lead">qualified_lead</option>
                        <option value="message_delivered">
                          message_delivered
                        </option>
                        <option value="reply_received">reply_received</option>
                        <option value="meeting_booked">meeting_booked</option>
                        <option value="customer_acquired">
                          customer_acquired
                        </option>
                        <option value="payment_confirmed">
                          payment_confirmed
                        </option>
                      </select>

                      <input
                        type="number"
                        min={1}
                        aria-label="Outcome count"
                        value={evCount}
                        onChange={(e) => setEvCount(e.target.value)}
                        className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 tabular-nums"
                      />

                      <button
                        type="submit"
                        disabled={evBusy || !evSummary.trim()}
                        className="min-h-[36px] px-4 py-2 text-xs font-semibold bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 disabled:opacity-50 rounded-lg cursor-pointer"
                      >
                        {evBusy ? 'Submitting...' : 'Submit Claim'}
                      </button>
                    </div>

                    <input
                      type="text"
                      aria-label="Evidence summary"
                      value={evSummary}
                      onChange={(e) => setEvSummary(e.target.value)}
                      placeholder="Describe external proof (e.g., CRM lead ID #4091 confirmed discovery call)"
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                    {evFeedback && (
                      <p className="text-xs text-slate-600 dark:text-slate-400">
                        {evFeedback}
                      </p>
                    )}
                  </form>
                )}

                <div className="space-y-2.5">
                  {!snapshot || snapshot.evidence.length === 0 ? (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                      No evidence records logged yet.
                    </div>
                  ) : (
                    snapshot.evidence.map((ev) => (
                      <div
                        key={ev.id}
                        className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4"
                      >
                        <div className="space-y-1 min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                            <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                              {ev.evidenceType}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>Provenance: {ev.provenanceClass}</span>
                            <span aria-hidden="true">·</span>
                            <span>Trust: {ev.trustTier}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold capitalize">
                              {ev.verificationState.replace(/_/g, ' ')}
                            </span>
                          </div>
                          <p className="text-sm text-slate-900 dark:text-slate-100">
                            {ev.summary}
                          </p>
                        </div>

                        {ev.verificationState === 'pending_verification' && (
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={busyAction !== null}
                              onClick={() => onAiVerifyEvidence(ev.id)}
                              className="min-h-[32px] px-2.5 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer"
                            >
                              AI Check
                            </button>
                            <button
                              type="button"
                              disabled={busyAction !== null}
                              onClick={() =>
                                onReviewEvidence(
                                  ev.id,
                                  'verified',
                                  'Human reviewer verified external evidence.'
                                )
                              }
                              className="min-h-[32px] px-3 py-1 text-xs font-semibold bg-emerald-700 text-white rounded-lg cursor-pointer"
                            >
                              Verify
                            </button>
                            <button
                              type="button"
                              disabled={busyAction !== null}
                              onClick={() =>
                                onReviewEvidence(
                                  ev.id,
                                  'rejected',
                                  'Rejected during human verification review.'
                                )
                              }
                              className="min-h-[32px] px-2.5 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {historyTab === 'logs' && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs tabular-nums">
                  <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Timestamp</th>
                      <th className="px-4 py-3 font-semibold">Provider</th>
                      <th className="px-4 py-3 font-semibold">Action</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold">Summary</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {logs.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-4 py-8 text-center text-slate-500 dark:text-slate-400"
                        >
                          No action audit logs recorded yet.
                        </td>
                      </tr>
                    ) : (
                      logs.map((log) => (
                        <tr key={log.id}>
                          <td className="px-4 py-3 font-mono whitespace-nowrap text-slate-500">
                            {new Date(log.timestamp).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 font-mono">
                            {log.executionProvider}
                          </td>
                          <td className="px-4 py-3 font-mono">
                            {log.actionType}
                          </td>
                          <td className="px-4 py-3 capitalize font-medium">
                            {log.status.replace(/_/g, ' ')}
                          </td>
                          <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                            {log.resultSummary}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {historyTab === 'outcomes' && report && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 tabular-nums">
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Messages Drafted (Not Sent)
                    </p>
                    <p className="text-2xl font-bold mt-1 font-mono">
                      {report.metrics.messagesDrafted}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Verified Deliveries
                    </p>
                    <p className="text-2xl font-bold mt-1 font-mono text-emerald-700 dark:text-emerald-400">
                      {report.metrics.messagesDeliveredVerified}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Verified Qualified Leads
                    </p>
                    <p className="text-2xl font-bold mt-1 font-mono text-emerald-700 dark:text-emerald-400">
                      {report.metrics.qualifiedProspects}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Verified Revenue (USD)
                    </p>
                    <p className="text-2xl font-bold mt-1 font-mono text-emerald-700 dark:text-emerald-400">
                      ${report.metrics.revenueEarnedUsd.toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 4. CONNECTED APPS VIEW (Unified Integration Center) */}
        {section === 'apps' && (
          <IntegrationCenterView
            workspaceId={selectedWorkspaceId ?? undefined}
            registry={registry}
            capabilityEntries={capabilityEntries}
            integrations={integrations}
            n8nWorkflows={n8nWorkflows}
            aiProviders={aiProviders}
            activityLogs={activityLogs}
            workforceConfigs={workforceConfigs}
            onRefreshWorkspace={onRefreshWorkspace}
            onCreateWebhookIntegration={onCreateIntegration}
            onTestIntegration={onTestIntegration}
            onRotateWorkspaceKeys={onRotateWorkspaceKeys}
          />
        )}

        {/* 5. SETTINGS VIEW (Task.ai -> Settings -> Integrations | Workspace & Runtime) */}
        {section === 'settings' && (
          <div className="space-y-6">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-900 w-fit">
              <button
                type="button"
                onClick={() => setSettingsSubTab('integrations')}
                className={`min-h-[38px] px-4 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                  settingsSubTab === 'integrations'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Integrations
              </button>
              <button
                type="button"
                onClick={() => setSettingsSubTab('workspace_runtime')}
                className={`min-h-[38px] px-4 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                  settingsSubTab === 'workspace_runtime'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Workspace &amp; Runtime
              </button>
            </div>

            {settingsSubTab === 'integrations' ? (
              <IntegrationCenterView
                workspaceId={selectedWorkspaceId ?? undefined}
                registry={registry}
                capabilityEntries={capabilityEntries}
                integrations={integrations}
                n8nWorkflows={n8nWorkflows}
                aiProviders={aiProviders}
                activityLogs={activityLogs}
                workforceConfigs={workforceConfigs}
                onRefreshWorkspace={onRefreshWorkspace}
                onCreateWebhookIntegration={onCreateIntegration}
                onTestIntegration={onTestIntegration}
                onRotateWorkspaceKeys={onRotateWorkspaceKeys}
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
            {/* Appearance & Default Model */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-5 space-y-5">
              <div className="space-y-2">
                <h2 className="text-sm font-semibold">Theme Appearance</h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSetTheme('light')}
                    className={`min-h-[38px] px-4 py-2 text-xs font-medium rounded-xl border inline-flex items-center gap-2 cursor-pointer ${
                      theme === 'light'
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <Sun className="w-3.5 h-3.5" />
                    <span>Light</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onSetTheme('dark')}
                    className={`min-h-[38px] px-4 py-2 text-xs font-medium rounded-xl border inline-flex items-center gap-2 cursor-pointer ${
                      theme === 'dark'
                        ? 'border-slate-100 bg-slate-100 text-slate-950'
                        : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <Moon className="w-3.5 h-3.5" />
                    <span>Dark</span>
                  </button>
                </div>
              </div>

              <div className="space-y-2 pt-4 border-t border-slate-200 dark:border-slate-800">
                <label
                  htmlFor="settings-default-model"
                  className="block text-sm font-semibold"
                >
                  Default Conversation AI Model
                </label>
                <select
                  id="settings-default-model"
                  value={defaultModel}
                  onChange={(e) =>
                    onSetDefaultModel(e.target.value as ChatModelId)
                  }
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  {SUPPORTED_CHAT_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.description}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  All AI requests are authenticated and routed through the
                  server-side Task.ai AI Provider Gateway.
                </p>
              </div>

              {/* Workspace Management */}
              <div className="space-y-3 pt-4 border-t border-slate-200 dark:border-slate-800">
                <h2 className="text-sm font-semibold">
                  Multi-Tenant Workspaces
                </h2>
                <select
                  aria-label="Select workspace in settings"
                  value={selectedWorkspaceId ?? ''}
                  onChange={(e) => onSwitchWorkspace(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  {workspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>
                      {ws.name} ({ws.slug})
                    </option>
                  ))}
                </select>

                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!newWsName.trim()) return;
                    setWsCreating(true);
                    try {
                      await onCreateWorkspace(newWsName.trim());
                      setNewWsName('');
                    } finally {
                      setWsCreating(false);
                    }
                  }}
                  className="flex items-center gap-2"
                >
                  <label htmlFor="settings-new-ws-name" className="sr-only">
                    New workspace name
                  </label>
                  <input
                    id="settings-new-ws-name"
                    type="text"
                    value={newWsName}
                    onChange={(e) => setNewWsName(e.target.value)}
                    placeholder="New isolated workspace name..."
                    className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                  <button
                    type="submit"
                    disabled={wsCreating || !newWsName.trim()}
                    className="min-h-[36px] px-3.5 py-2 text-xs font-semibold bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    Create
                  </button>
                </form>
              </div>
            </div>

            {/* Inbound Webhook HMAC Security & Server Environment Diagnostics */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-5 space-y-5">
              <div className="space-y-2.5">
                <h2 className="text-sm font-semibold">
                  Inbound Evidence Webhook (HMAC-SHA256)
                </h2>
                <p className="text-xs font-mono text-slate-600 dark:text-slate-400 break-all">
                  Endpoint:{' '}
                  {snapshot?.inboundWebhook.endpointPath ||
                    `/api/webhooks/inbound/${selectedWorkspaceId ?? ''}`}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={async () => {
                      const secret = await onRotateInboundSecret();
                      setRotatedSecret(secret);
                      setWebhookTestSecret(secret);
                    }}
                    className="min-h-[34px] px-3 py-1.5 text-xs font-semibold border border-slate-300 dark:border-slate-700 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Generate / Rotate Signing Secret</span>
                  </button>

                  {webhookTestSecret && goals[0] && (
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await onSendSignedWebhook({
                          signingSecret: webhookTestSecret,
                          payload: {
                            externalEventId: `evt_${Date.now()}`,
                            provider: 'custom_webhook',
                            evidenceType: 'message_delivered',
                            summary:
                              'Signed webhook delivery receipt verification test',
                            goalId: goals[0].id,
                            structuredMetrics: { count: 1 },
                          },
                        });
                        setWebhookTestResult(
                          `Accepted (provenance=${res.provenanceClass}, state=${res.verificationState})`
                        );
                      }}
                      className="min-h-[34px] px-3 py-1.5 text-xs font-medium bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 rounded-lg cursor-pointer"
                    >
                      Send Signed Test Event
                    </button>
                  )}
                </div>

                {rotatedSecret && (
                  <p className="text-xs font-mono p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200 break-all">
                    One-time HMAC secret: {rotatedSecret}
                  </p>
                )}
                {webhookTestResult && (
                  <p className="text-xs text-emerald-700 dark:text-emerald-400">
                    {webhookTestResult}
                  </p>
                )}
              </div>

              <div className="space-y-2.5 pt-4 border-t border-slate-200 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold">
                    Server Runtime Diagnostics
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setEnvLoading(true);
                      onFetchEnvironmentDiagnostics()
                        .then((r) => setEnvDiag(r))
                        .finally(() => setEnvLoading(false));
                    }}
                    aria-label="Refresh server diagnostics"
                    className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${envLoading ? 'animate-spin' : ''}`}
                    />
                  </button>
                </div>

                {envDiag ? (
                  <ul className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                    {envDiag.variables.map((v) => (
                      <li
                        key={v.name}
                        className="py-2 flex items-center justify-between gap-2"
                      >
                        <span className="font-mono font-medium">{v.name}</span>
                        <span className="text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
                          {v.state === 'action_required' ? (
                            <XCircle className="w-3.5 h-3.5 text-red-600" />
                          ) : v.state === 'optional_blank' ? (
                            <Clock className="w-3.5 h-3.5 text-slate-400" />
                          ) : (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                          )}
                          <span>{v.statusSummary}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-500">
                    Loading runtime diagnostics...
                  </p>
                )}
              </div>
            </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
