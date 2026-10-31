import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileText,
  Menu,
  MessageSquarePlus,
} from 'lucide-react';
import {
  purgeLegacyFirebaseAuthPersistence,
  signOutFirebaseIfInitialized,
} from './lib/firebase';
import { api } from './lib/api';
import { normalizeChatModel } from './lib/chat-utils';
import { AuthGate } from './components/AuthGate';
import { GoalFormModal } from './components/GoalFormModal';
import { DiagnosticTaskModal } from './components/DiagnosticTaskModal';
import {
  ChatSidebar,
  type SidebarSection,
} from './components/chat/ChatSidebar';
import { ChatMessageList } from './components/chat/ChatMessageList';
import { MessageComposer } from './components/chat/MessageComposer';
import { ArtifactInspectorDrawer } from './components/chat/ArtifactInspectorDrawer';
import { WorkspaceSecondaryViews } from './components/chat/WorkspaceSecondaryViews';
import type {
  ActionLogRecord,
  AiProviderStatusRecord,
  AuthSessionUser,
  CapabilityId,
  CapabilityStatusEntry,
  ChatAttachmentRecord,
  ChatModelId,
  ConversationArtifactRecord,
  ConversationMessageRecord,
  ConversationRecord,
  EvidenceType,
  ExecutionMonitorSnapshot,
  GoalRecord,
  GoalStatus,
  HydratedGoalExecutionContext,
  IntegrationActivityLogRecord,
  IntegrationAuthType,
  IntegrationConnectionMode,
  IntegrationProviderKey,
  IntegrationRegistryEntry,
  N8nRegisteredWorkflowRecord,
  PlatformCapabilitiesInfo,
  ResultsReportSummary,
  TaskActionCategory,
  TaskRecord,
  ToolId,
  ToolRegistryItem,
  UserIntegrationRecord,
  WorkforceConfigurationRecord,
  WorkspaceRecord,
} from './types';

function readInitialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('taskai_theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // ignore storage errors
  }
  return 'light';
}

function readInitialModel(): ChatModelId {
  try {
    return normalizeChatModel(localStorage.getItem('taskai_default_model'));
  } catch {
    return 'gemini-3.8-flash';
  }
}

function readInitialCollapsed(): boolean {
  try {
    return localStorage.getItem('taskai_sidebar_collapsed') === 'true';
  } catch {
    return false;
  }
}

export default function App() {
  const [authUser, setAuthUser] = useState<AuthSessionUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);

  // Theme & Layout preferences
  const [theme, setTheme] = useState<'light' | 'dark'>(readInitialTheme);
  const [defaultModel, setDefaultModel] =
    useState<ChatModelId>(readInitialModel);
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState<boolean>(readInitialCollapsed);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SidebarSection>('chat');

  // Workspace & Platform state
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null
  );
  const [goals, setGoals] = useState<GoalRecord[]>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [logs, setLogs] = useState<ActionLogRecord[]>([]);
  const [report, setReport] = useState<ResultsReportSummary | null>(null);
  const [monitorSnapshot, setMonitorSnapshot] =
    useState<ExecutionMonitorSnapshot | null>(null);
  const [tools, setTools] = useState<ToolRegistryItem[]>([]);
  const [integrations, setIntegrations] = useState<UserIntegrationRecord[]>([]);
  const [integrationRegistry, setIntegrationRegistry] = useState<
    IntegrationRegistryEntry[]
  >([]);
  const [capabilityEntries, setCapabilityEntries] = useState<
    CapabilityStatusEntry[]
  >([]);
  const [n8nWorkflows, setN8nWorkflows] = useState<
    N8nRegisteredWorkflowRecord[]
  >([]);
  const [aiProviders, setAiProviders] = useState<AiProviderStatusRecord[]>([]);
  const [integrationActivityLogs, setIntegrationActivityLogs] = useState<
    IntegrationActivityLogRecord[]
  >([]);
  const [workforceConfigs, setWorkforceConfigs] = useState<
    WorkforceConfigurationRecord[]
  >([]);
  const [platformCapabilities, setPlatformCapabilities] =
    useState<PlatformCapabilitiesInfo | null>(null);
  const [workspaceArtifacts, setWorkspaceArtifacts] = useState<
    ConversationArtifactRecord[]
  >([]);

  // Conversational state
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [messages, setMessages] = useState<ConversationMessageRecord[]>([]);
  const [conversationArtifacts, setConversationArtifacts] = useState<
    ConversationArtifactRecord[]
  >([]);
  const [hydratedGoal, setHydratedGoal] =
    useState<HydratedGoalExecutionContext | null>(null);
  const [selectedArtifact, setSelectedArtifact] =
    useState<ConversationArtifactRecord | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selectedModel, setSelectedModel] =
    useState<ChatModelId>(readInitialModel);
  const [executionMode, setExecutionMode] = useState<
    'auto' | 'chat' | 'execute'
  >('auto');
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);

  // Modals & Busy state
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [goalModalOpen, setGoalModalOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<GoalRecord | null>(null);
  const [addTaskModalOpen, setAddTaskModalOpen] = useState(false);

  // Sync `.dark` on `<html>` cleanly
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('taskai_theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const handleSetDefaultModel = useCallback((model: ChatModelId) => {
    setDefaultModel(model);
    setSelectedModel(model);
    try {
      localStorage.setItem('taskai_default_model', model);
    } catch {
      // ignore
    }
  }, []);

  const handleToggleSidebarCollapse = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('taskai_sidebar_collapsed', String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const refreshConversationsList = useCallback(
    async (
      wsId: string | undefined,
      query = searchQuery,
      archived = showArchived
    ) => {
      if (!wsId) return [];
      const res = await api.listConversations({
        workspaceId: wsId,
        search: query.trim() || undefined,
        archivedOnly: archived,
      });
      setConversations(res.conversations);
      return res.conversations;
    },
    [searchQuery, showArchived]
  );

  const loadConversationThread = useCallback(
    async (conversationId: string, wsId?: string) => {
      try {
        const res = await api.getConversation(conversationId, wsId);
        setActiveConversationId(res.conversation.id);
        setSelectedModel(res.conversation.model);
        setMessages(res.messages);
        setConversationArtifacts(res.artifacts);
        setHydratedGoal(res.hydratedGoal);
      } catch (err: unknown) {
        setGlobalError(
          err instanceof Error
            ? err.message
            : 'Failed to load conversation history.'
        );
      }
    },
    []
  );

  const loadWorkspaceData = useCallback(
    async (overrideWorkspaceId?: string) => {
      setGlobalError(null);
      try {
        const wsRes = await api.listWorkspaces();
        setWorkspaces(wsRes.workspaces);

        const resolvedWsId =
          overrideWorkspaceId &&
          wsRes.workspaces.some((w) => w.id === overrideWorkspaceId)
            ? overrideWorkspaceId
            : selectedWorkspaceId &&
                wsRes.workspaces.some((w) => w.id === selectedWorkspaceId)
              ? selectedWorkspaceId
              : wsRes.workspaces[0]?.id;

        if (resolvedWsId && resolvedWsId !== selectedWorkspaceId) {
          setSelectedWorkspaceId(resolvedWsId);
        }

        const [
          goalsRes,
          tasksRes,
          logsRes,
          reportRes,
          integrationsRes,
          monitorRes,
          convRes,
          artRes,
        ] = await Promise.all([
          api.listGoals(resolvedWsId),
          api.listTasks(undefined, resolvedWsId),
          api.listActionLogs(undefined, resolvedWsId),
          api.getResultsReport(resolvedWsId),
          api.getIntegrations(resolvedWsId),
          api.getExecutionMonitor(resolvedWsId),
          api.listConversations({
            workspaceId: resolvedWsId,
            search: searchQuery.trim() || undefined,
            archivedOnly: showArchived,
          }),
          api.listArtifacts(resolvedWsId),
        ]);

        setGoals(goalsRes.goals);
        setTasks(tasksRes.tasks);
        setLogs(logsRes.logs);
        setReport(reportRes.report);
        setTools(integrationsRes.tools);
        setIntegrations(integrationsRes.integrations);
        setIntegrationRegistry(integrationsRes.registry ?? []);
        setCapabilityEntries(integrationsRes.capabilityEntries ?? []);
        setN8nWorkflows(integrationsRes.n8nWorkflows ?? []);
        setAiProviders(integrationsRes.aiProviders ?? []);
        setIntegrationActivityLogs(integrationsRes.activityLogs ?? []);
        setWorkforceConfigs(integrationsRes.workforceConfigs ?? []);
        setPlatformCapabilities(integrationsRes.platformCapabilities);
        setMonitorSnapshot(monitorRes.snapshot);
        setConversations(convRes.conversations);
        setWorkspaceArtifacts(artRes.artifacts);

        setSelectedGoalId((prev) => {
          if (prev && goalsRes.goals.some((g) => g.id === prev)) return prev;
          return goalsRes.goals[0]?.id ?? null;
        });
      } catch (err: unknown) {
        setGlobalError(
          err instanceof Error ? err.message : 'Failed to load workspace data.'
        );
      }
    },
    [selectedWorkspaceId, searchQuery, showArchived]
  );

  // Initial session check (`?autostart=1` supported)
  useEffect(() => {
    let mounted = true;
    purgeLegacyFirebaseAuthPersistence();

    const params = new URLSearchParams(window.location.search);
    const autostart = params.get('autostart') === '1';

    const initializeSession = async () => {
      try {
        const sessionRes = await api.getSession();
        if (sessionRes.authenticated && sessionRes.user) {
          if (mounted) {
            setAuthUser(sessionRes.user);
          }
          return;
        }

        if (autostart) {
          const { user } = await api.createIsolatedSession();
          if (mounted) {
            setAuthUser(user);
          }
        }
      } catch (err: unknown) {
        if (mounted && autostart) {
          setGlobalError(
            err instanceof Error
              ? err.message
              : 'Could not initialize workspace session.'
          );
        }
      } finally {
        if (mounted) {
          setAuthChecking(false);
        }
      }
    };

    void initializeSession();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (authUser) {
      void loadWorkspaceData();
    }
  }, [authUser, loadWorkspaceData]);

  // Re-query conversations when search or archived filter changes
  useEffect(() => {
    if (!authUser || !selectedWorkspaceId) return;
    const handle = window.setTimeout(() => {
      void refreshConversationsList(
        selectedWorkspaceId,
        searchQuery,
        showArchived
      );
    }, 140);
    return () => window.clearTimeout(handle);
  }, [
    authUser,
    selectedWorkspaceId,
    searchQuery,
    showArchived,
    refreshConversationsList,
  ]);

  const handleSignOut = async () => {
    streamAbortRef.current?.abort();
    try {
      await signOutFirebaseIfInitialized();
      await api.logout();
    } finally {
      setAuthUser(null);
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setConversations([]);
      setActiveConversationId(null);
      setMessages([]);
      setConversationArtifacts([]);
      setSelectedArtifact(null);
      setGoals([]);
      setTasks([]);
      setLogs([]);
      setIntegrations([]);
      setReport(null);
      setMonitorSnapshot(null);
    }
  };

  const handleSwitchWorkspace = async (workspaceId: string) => {
    streamAbortRef.current?.abort();
    setIsStreaming(false);
    setSelectedWorkspaceId(workspaceId);
    setActiveConversationId(null);
    setMessages([]);
    setConversationArtifacts([]);
    setHydratedGoal(null);
    setSelectedArtifact(null);
    setSelectedGoalId(null);
    await loadWorkspaceData(workspaceId);
  };

  const handleCreateWorkspace = async (name: string) => {
    const { workspace } = await api.createWorkspace(name);
    await handleSwitchWorkspace(workspace.id);
  };

  // --- CONVERSATION MANAGEMENT ---

  const handleStartNewChat = async () => {
    streamAbortRef.current?.abort();
    setIsStreaming(false);
    setActiveSection('chat');
    setActiveConversationId(null);
    setMessages([]);
    setConversationArtifacts([]);
    setHydratedGoal(null);
    setSelectedArtifact(null);
    setSelectedModel(defaultModel);
  };

  const handleSelectConversation = async (conversationId: string) => {
    streamAbortRef.current?.abort();
    setIsStreaming(false);
    setActiveSection('chat');
    setSelectedArtifact(null);
    await loadConversationThread(
      conversationId,
      selectedWorkspaceId ?? undefined
    );
  };

  const handleRenameConversation = async (
    conversationId: string,
    newTitle: string
  ) => {
    const { conversation } = await api.updateConversation(conversationId, {
      workspaceId: selectedWorkspaceId ?? undefined,
      title: newTitle,
    });
    setConversations((prev) =>
      prev.map((c) => (c.id === conversation.id ? conversation : c))
    );
  };

  const handleToggleArchiveConversation = async (
    conversationId: string,
    archived: boolean
  ) => {
    await api.updateConversation(conversationId, {
      workspaceId: selectedWorkspaceId ?? undefined,
      archived,
    });
    if (archived && activeConversationId === conversationId) {
      setActiveConversationId(null);
      setMessages([]);
      setConversationArtifacts([]);
      setSelectedArtifact(null);
    }
    await refreshConversationsList(selectedWorkspaceId ?? undefined);
  };

  const handleDeleteConversation = async (conversationId: string) => {
    await api.deleteConversation(
      conversationId,
      selectedWorkspaceId ?? undefined
    );
    if (activeConversationId === conversationId) {
      setActiveConversationId(null);
      setMessages([]);
      setConversationArtifacts([]);
      setSelectedArtifact(null);
    }
    await refreshConversationsList(selectedWorkspaceId ?? undefined);
  };

  const executeStreamTurn = async (params: {
    conversationId: string;
    content?: string;
    attachments?: ChatAttachmentRecord[];
    action: 'send' | 'edit' | 'regenerate';
    targetMessageId?: string;
    modeOverride?: 'auto' | 'chat' | 'execute';
  }) => {
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setIsStreaming(true);
    setGlobalError(null);

    let streamingAssistantId: string | null = null;
    let triggeredExecution = false;

    try {
      await api.streamConversationMessage({
        conversationId: params.conversationId,
        content: params.content,
        attachments: params.attachments,
        model: selectedModel,
        executionMode: params.modeOverride ?? executionMode,
        action: params.action,
        targetMessageId: params.targetMessageId,
        signal: controller.signal,
        onConversationUpdated: (updatedConv) => {
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === updatedConv.id);
            if (!exists) return [updatedConv, ...prev];
            return prev.map((c) =>
              c.id === updatedConv.id ? updatedConv : c
            );
          });
        },
        onMessageStarted: ({ userMessage, assistantMessage }) => {
          streamingAssistantId = assistantMessage.id;
          setMessages((prev) => {
            if (params.action === 'edit') {
              const idx = prev.findIndex((m) => m.id === userMessage.id);
              const base = idx >= 0 ? prev.slice(0, idx) : prev;
              return [...base, userMessage, assistantMessage];
            }
            if (params.action === 'regenerate') {
              const idx = prev.findIndex((m) => m.id === userMessage.id);
              const base = idx >= 0 ? prev.slice(0, idx + 1) : prev;
              return [...base, assistantMessage];
            }
            return [...prev, userMessage, assistantMessage];
          });
        },
        onExecutionTrace: ({ trace, hydratedGoal: nextHydrated }) => {
          triggeredExecution = true;
          if (nextHydrated) {
            setHydratedGoal(nextHydrated);
          }
          if (!streamingAssistantId) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamingAssistantId
                ? { ...m, executionTrace: trace }
                : m
            )
          );
        },
        onTextDelta: (delta) => {
          if (!streamingAssistantId) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamingAssistantId
                ? { ...m, content: m.content + delta }
                : m
            )
          );
        },
        onArtifactsCreated: (created) => {
          setConversationArtifacts((prev) => {
            const existingIds = new Set(prev.map((a) => a.id));
            const fresh = created.filter((a) => !existingIds.has(a.id));
            return [...fresh, ...prev];
          });
          setWorkspaceArtifacts((prev) => {
            const existingIds = new Set(prev.map((a) => a.id));
            const fresh = created.filter((a) => !existingIds.has(a.id));
            return [...fresh, ...prev];
          });
        },
        onDone: ({ assistantMessage, conversation: finalConv }) => {
          if (assistantMessage) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessage.id ? assistantMessage : m
              )
            );
          }
          setConversations((prev) => {
            const filtered = prev.filter((c) => c.id !== finalConv.id);
            return [finalConv, ...filtered];
          });
        },
      });
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') {
        if (streamingAssistantId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamingAssistantId
                ? {
                    ...m,
                    status: 'stopped',
                    content: m.content || '*(Generation stopped)*',
                  }
                : m
            )
          );
        }
      } else {
        const errMsg =
          err instanceof Error ? err.message : 'Streaming failed.';
        setGlobalError(errMsg);
        if (streamingAssistantId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamingAssistantId
                ? { ...m, status: 'error', content: errMsg }
                : m
            )
          );
        }
      }
    } finally {
      setIsStreaming(false);
      streamAbortRef.current = null;
      if (triggeredExecution) {
        void loadWorkspaceData();
      }
    }
  };

  const handleSendMessage = async (
    content: string,
    attachments: ChatAttachmentRecord[],
    modeOverride?: 'auto' | 'chat' | 'execute'
  ) => {
    setActiveSection('chat');
    let convId = activeConversationId;
    if (!convId) {
      const created = await api.createConversation({
        workspaceId: selectedWorkspaceId ?? undefined,
        model: selectedModel,
      });
      convId = created.conversation.id;
      setActiveConversationId(convId);
      setConversations((prev) => [created.conversation, ...prev]);
    }

    await executeStreamTurn({
      conversationId: convId,
      content,
      attachments,
      action: 'send',
      modeOverride,
    });
  };

  const handleEditAndResend = async (
    messageId: string,
    updatedContent: string
  ) => {
    if (!activeConversationId) return;
    await executeStreamTurn({
      conversationId: activeConversationId,
      content: updatedContent,
      action: 'edit',
      targetMessageId: messageId,
    });
  };

  const handleRegenerateResponse = async (assistantMessageId: string) => {
    if (!activeConversationId) return;
    await executeStreamTurn({
      conversationId: activeConversationId,
      action: 'regenerate',
      targetMessageId: assistantMessageId,
    });
  };

  const handleStopGeneration = () => {
    streamAbortRef.current?.abort();
  };

  const handleOpenGoalInChat = async (goal: GoalRecord) => {
    const existing = conversations.find((c) => c.goalId === goal.id);
    if (existing) {
      await handleSelectConversation(existing.id);
      return;
    }
    const { conversation } = await api.createConversation({
      workspaceId: selectedWorkspaceId ?? undefined,
      title: goal.problem.slice(0, 56),
      model: selectedModel,
      goalId: goal.id,
    });
    setConversations((prev) => [conversation, ...prev]);
    await handleSelectConversation(conversation.id);
  };

  // --- PLATFORM / EXECUTION HANDLERS ---

  const refreshActiveChatIfLinked = async () => {
    if (activeConversationId) {
      await loadConversationThread(
        activeConversationId,
        selectedWorkspaceId ?? undefined
      );
    }
  };

  const handleSaveGoal = async (payload: {
    problem: string;
    targetMetric: string;
    deadline: string | null;
    status: GoalStatus;
  }) => {
    if (editingGoal) {
      await api.updateGoal(editingGoal.id, {
        ...payload,
        description: payload.problem,
      });
    } else {
      const { goal } = await api.createGoal({
        ...payload,
        description: payload.problem,
        workspaceId: selectedWorkspaceId ?? undefined,
      });
      setSelectedGoalId(goal.id);
    }
    await loadWorkspaceData();
  };

  const handleUpdateGoalStatus = async (goalId: string, status: GoalStatus) => {
    setBusyAction(`goal-status:${goalId}`);
    try {
      await api.updateGoal(goalId, { status });
      await loadWorkspaceData();
      await refreshActiveChatIfLinked();
    } finally {
      setBusyAction(null);
    }
  };

  const handleGeneratePlan = async (goalId: string) => {
    setBusyAction(`plan:${goalId}`);
    try {
      await api.generatePlan(goalId);
      await loadWorkspaceData();
      await refreshActiveChatIfLinked();
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error ? err.message : 'AI Planner failed.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleExecuteTask = async (taskId: string) => {
    setBusyAction(`task:${taskId}`);
    try {
      await api.executeTask(taskId);
      await loadWorkspaceData();
      await refreshActiveChatIfLinked();
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error ? err.message : 'Task execution failed.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRequeueTask = async (taskId: string) => {
    setBusyAction(`requeue:${taskId}`);
    try {
      await api.retryTask(taskId);
      await loadWorkspaceData();
      await refreshActiveChatIfLinked();
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error ? err.message : 'Failed to retry task.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleReconcileTask = async (
    taskId: string,
    resolution:
      | 'reconcile_from_evidence'
      | 'mark_dispatched_pending_verification'
      | 'confirm_not_executed_requeue'
  ) => {
    setBusyAction(`reconcile:${taskId}`);
    try {
      await api.reconcileTask(taskId, { resolution });
      await loadWorkspaceData();
      await refreshActiveChatIfLinked();
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error ? err.message : 'Failed to reconcile task.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleDecideApproval = async (
    taskId: string,
    decision: 'approved' | 'rejected'
  ) => {
    setBusyAction(`approval:${taskId}`);
    try {
      await api.decideApproval(taskId, decision);
      await loadWorkspaceData();
      await refreshActiveChatIfLinked();
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error
          ? err.message
          : 'Failed to record approval decision.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleOrchestrateGoal = async (
    goalId: string,
    concurrencyMode: 'sequential' | 'parallel_safe',
    autoRunReasoning: boolean
  ) => {
    setBusyAction(`orchestrate:${goalId}:${concurrencyMode}`);
    try {
      await api.orchestrateGoal(goalId, {
        concurrencyMode,
        autoRunReasoning,
      });
      await loadWorkspaceData();
      await refreshActiveChatIfLinked();
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error
          ? err.message
          : 'Execution orchestrator cycle failed.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleControlGoalExecution = async (
    goalId: string,
    action: 'pause' | 'resume' | 'cancel'
  ) => {
    setBusyAction(`control:${goalId}:${action}`);
    try {
      await api.controlGoalExecution(goalId, action);
      await loadWorkspaceData();
      await refreshActiveChatIfLinked();
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error
          ? err.message
          : 'Failed to update goal execution state.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRotateInboundSecret = async (): Promise<string> => {
    const wsId = selectedWorkspaceId ?? workspaces[0]?.id;
    if (!wsId) throw new Error('No active workspace selected.');
    setBusyAction('rotate-inbound');
    try {
      const res = await api.rotateInboundWebhookSecret(wsId);
      await loadWorkspaceData();
      return res.oneTimeSigningSecret;
    } finally {
      setBusyAction(null);
    }
  };

  const handleSendSignedWebhook = async (params: {
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
  }) => {
    const wsId = selectedWorkspaceId ?? workspaces[0]?.id;
    if (!wsId) throw new Error('No active workspace selected.');
    const res = await api.sendSignedInboundWebhook({
      workspaceId: wsId,
      signingSecret: params.signingSecret,
      payload: params.payload,
    });
    await loadWorkspaceData();
    await refreshActiveChatIfLinked();
    return {
      duplicate: res.duplicate,
      message: res.message,
      verificationState: res.evidence?.verificationState,
      provenanceClass: res.evidence?.provenanceClass,
    };
  };

  const handleSubmitManualEvidence = async (payload: {
    goalId: string;
    taskId?: string | null;
    provider?: string;
    evidenceType: EvidenceType;
    summary: string;
    externalReferenceId?: string | null;
    structuredMetrics?: Record<string, unknown>;
  }) => {
    const wsId = selectedWorkspaceId ?? workspaces[0]?.id;
    if (!wsId) throw new Error('No active workspace selected.');
    await api.submitManualEvidence(wsId, payload);
    await loadWorkspaceData();
    await refreshActiveChatIfLinked();
  };

  const handleReviewEvidence = async (
    evidenceId: string,
    decision: 'verified' | 'rejected',
    notes: string
  ) => {
    setBusyAction(`review:${evidenceId}`);
    try {
      await api.reviewEvidence(evidenceId, { decision, notes });
      await loadWorkspaceData();
      await refreshActiveChatIfLinked();
    } finally {
      setBusyAction(null);
    }
  };

  const handleAiVerifyEvidence = async (evidenceId: string) => {
    setBusyAction(`ai-verify:${evidenceId}`);
    try {
      await api.aiVerifyEvidence(evidenceId);
      await loadWorkspaceData();
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error ? err.message : 'AI consistency review failed.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunReasoning = async (goalId: string) => {
    setBusyAction(`reasoning:${goalId}`);
    try {
      await api.runGoalReasoning(goalId);
      await loadWorkspaceData();
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error ? err.message : 'Continuous AI reasoning failed.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleDecideProposal = async (
    proposalId: string,
    decision: 'accept' | 'reject'
  ) => {
    setBusyAction(`proposal:${proposalId}`);
    try {
      await api.decideProposal(proposalId, decision);
      await loadWorkspaceData();
    } catch (err: unknown) {
      setGlobalError(
        err instanceof Error ? err.message : 'Failed to process proposal.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateCustomTask = async (payload: {
    description: string;
    tool: ToolId;
    requiredCapabilities: CapabilityId[];
    actionCategory: TaskActionCategory;
    dependencies: string[];
    approvalRequired: boolean;
    proposedAction?: string;
    targetRecipient?: string;
    estimatedCost?: string;
    explanation?: string;
    expectedResult: string;
    verificationMethod: string;
  }) => {
    if (!selectedGoalId) return;
    await api.createTask(selectedGoalId, payload);
    await loadWorkspaceData();
  };

  const handleCreateIntegration = async (payload: {
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
  }) => {
    await api.createIntegration({
      ...payload,
      workspaceId: selectedWorkspaceId ?? undefined,
    });
    await loadWorkspaceData();
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-white dark:bg-[#0b0f17] flex items-center justify-center p-6">
        <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
          Loading Task.ai...
        </p>
      </div>
    );
  }

  if (!authUser) {
    return <AuthGate onAuthenticated={(user) => setAuthUser(user)} />;
  }

  const activeWorkspace =
    workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0];
  const activeConversation =
    conversations.find((c) => c.id === activeConversationId) ?? null;

  const pendingApprovalsCount = tasks.filter(
    (t) =>
      t.approvalRequired &&
      t.approvalStatus === 'pending' &&
      t.status !== 'rejected'
  ).length;
  const runningTasksCount = tasks.filter((t) => t.status === 'running').length;
  const selectedGoalTasks = selectedGoalId
    ? tasks.filter((t) => t.goalId === selectedGoalId)
    : [];

  return (
    <div className="h-screen w-full overflow-hidden flex bg-white dark:bg-[#0b0f17] text-slate-900 dark:text-slate-100">
      {/* PART 1: Collapsible Left Sidebar (Desktop) & Slide-out Drawer (Mobile) */}
      <ChatSidebar
        user={authUser}
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        conversations={conversations}
        activeConversationId={activeConversationId}
        activeSection={activeSection}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileSidebarOpen}
        searchQuery={searchQuery}
        showArchived={showArchived}
        theme={theme}
        projectsCount={goals.length}
        pendingTasksCount={pendingApprovalsCount}
        connectedAppsCount={integrations.filter((i) => i.enabled).length}
        onToggleCollapse={handleToggleSidebarCollapse}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onNewChat={handleStartNewChat}
        onSelectConversation={handleSelectConversation}
        onRenameConversation={handleRenameConversation}
        onToggleArchiveConversation={handleToggleArchiveConversation}
        onDeleteConversation={handleDeleteConversation}
        onSearchChange={setSearchQuery}
        onToggleShowArchived={setShowArchived}
        onSelectSection={(sec) => {
          setSelectedArtifact(null);
          setActiveSection(sec);
        }}
        onSwitchWorkspace={handleSwitchWorkspace}
        onToggleTheme={() =>
          setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
        }
        onSignOut={handleSignOut}
      />

      {/* PART 2: Main Conversational Workspace (or Secondary Workspace View) */}
      <main className="flex-1 min-w-0 flex flex-col h-full bg-white dark:bg-[#0b0f17]">
        {/* Minimal Conversational Header (<= 56px, well below 15% mobile sticky cap) */}
        <header className="h-12 md:h-14 px-3 sm:px-6 border-b border-slate-200/80 dark:border-slate-800/80 flex items-center justify-between gap-3 shrink-0 bg-white/95 dark:bg-[#0b0f17]/95">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label="Open navigation menu"
              className="md:hidden min-h-[42px] min-w-[42px] -ml-1.5 p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="min-w-0 flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate max-w-[210px] sm:max-w-md">
                {activeSection === 'chat'
                  ? activeConversation?.title || 'Task.ai'
                  : 'Task.ai Workspace'}
              </span>
              {activeSection === 'chat' && activeWorkspace && (
                <span className="hidden sm:inline text-xs text-slate-400 dark:text-slate-500 truncate">
                  · {activeWorkspace.name}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {activeSection === 'chat' && conversationArtifacts.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setSelectedArtifact((prev) =>
                    prev ? null : conversationArtifacts[0]
                  )
                }
                aria-label="Toggle conversation artifacts preview"
                className="min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 inline-flex items-center gap-1.5 transition-colors cursor-pointer tabular-nums"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Artifacts ({conversationArtifacts.length})</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleStartNewChat}
              aria-label="Start new chat"
              className="md:hidden min-h-[40px] min-w-[40px] p-2 rounded-xl text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer"
            >
              <MessageSquarePlus className="w-4 h-4" />
            </button>
          </div>
        </header>

        {globalError && (
          <div
            role="alert"
            className="mx-4 sm:mx-6 mt-3 px-4 py-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-800 dark:text-red-200 flex items-center justify-between gap-4 shrink-0"
          >
            <span className="break-words">{globalError}</span>
            <button
              type="button"
              onClick={() => setGlobalError(null)}
              className="font-semibold underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {activeSection === 'chat' ? (
          <>
            <ChatMessageList
              workspaceName={activeWorkspace?.name ?? 'Default Workspace'}
              messages={messages}
              artifacts={conversationArtifacts}
              selectedArtifactId={selectedArtifact?.id ?? null}
              workspaceTasks={tasks}
              hydratedGoal={hydratedGoal}
              isStreaming={isStreaming}
              busyAction={busyAction}
              onSelectStarterPrompt={(prompt, mode) => {
                setExecutionMode(mode);
                void handleSendMessage(prompt, [], mode);
              }}
              onEditAndResend={handleEditAndResend}
              onRegenerateResponse={handleRegenerateResponse}
              onPreviewArtifact={(art) => setSelectedArtifact(art)}
              onDownloadArtifact={(art) => void api.downloadArtifact(art)}
              onDecideApproval={handleDecideApproval}
              onRunGoalWave={(gId) =>
                handleOrchestrateGoal(gId, 'sequential', false)
              }
              onInspectProject={(gId) => {
                setSelectedArtifact(null);
                setSelectedGoalId(gId);
                setActiveSection('projects');
              }}
              onOpenIntegrations={() => {
                setSelectedArtifact(null);
                setActiveSection('settings');
              }}
              onRefreshWorkspace={() => loadWorkspaceData()}
            />

            <MessageComposer
              selectedModel={selectedModel}
              executionMode={executionMode}
              isStreaming={isStreaming}
              runningTasksCount={runningTasksCount}
              pendingApprovalsCount={pendingApprovalsCount}
              onModelChange={setSelectedModel}
              onExecutionModeChange={setExecutionMode}
              onSendMessage={(text, atts) => handleSendMessage(text, atts)}
              onStopGeneration={handleStopGeneration}
            />
          </>
        ) : (
          <WorkspaceSecondaryViews
            section={activeSection}
            workspaceName={activeWorkspace?.name ?? 'Default Workspace'}
            workspaces={workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            goals={goals}
            selectedGoalId={selectedGoalId}
            tasks={tasks}
            logs={logs}
            report={report}
            snapshot={monitorSnapshot}
            tools={tools}
            integrations={integrations}
            registry={integrationRegistry}
            capabilityEntries={capabilityEntries}
            n8nWorkflows={n8nWorkflows}
            aiProviders={aiProviders}
            activityLogs={integrationActivityLogs}
            workforceConfigs={workforceConfigs}
            platformCapabilities={platformCapabilities}
            workspaceArtifacts={workspaceArtifacts}
            theme={theme}
            defaultModel={defaultModel}
            busyAction={busyAction}
            onRefreshWorkspace={() => loadWorkspaceData()}
            onBackToChat={() => setActiveSection('chat')}
            onOpenGoalInChat={handleOpenGoalInChat}
            onSelectGoal={setSelectedGoalId}
            onOpenNewGoal={() => {
              setEditingGoal(null);
              setGoalModalOpen(true);
            }}
            onOpenEditGoal={(goal) => {
              setEditingGoal(goal);
              setGoalModalOpen(true);
            }}
            onUpdateGoalStatus={handleUpdateGoalStatus}
            onOpenAddTask={() => setAddTaskModalOpen(true)}
            onGeneratePlan={handleGeneratePlan}
            onOrchestrateGoal={handleOrchestrateGoal}
            onControlGoalExecution={handleControlGoalExecution}
            onExecuteTask={handleExecuteTask}
            onRetryTask={handleRequeueTask}
            onReconcileTask={handleReconcileTask}
            onDecideApproval={handleDecideApproval}
            onRunReasoning={handleRunReasoning}
            onDecideProposal={handleDecideProposal}
            onSubmitManualEvidence={handleSubmitManualEvidence}
            onReviewEvidence={handleReviewEvidence}
            onAiVerifyEvidence={handleAiVerifyEvidence}
            onRotateInboundSecret={handleRotateInboundSecret}
            onSendSignedWebhook={handleSendSignedWebhook}
            onCreateIntegration={handleCreateIntegration}
            onToggleIntegration={async (id, enabled) => {
              await api.updateIntegration(id, { enabled });
              await loadWorkspaceData();
            }}
            onDeleteIntegration={async (id) => {
              await api.deleteIntegration(id);
              await loadWorkspaceData();
            }}
            onTestIntegration={async (id) => {
              const res = await api.testIntegration(id);
              await loadWorkspaceData();
              return { success: res.success, statusDetail: res.statusDetail };
            }}
            onRotateWorkspaceKeys={async () => {
              const summary = await api.rotateIntegrationKeys(
                selectedWorkspaceId ?? undefined
              );
              await loadWorkspaceData();
              return summary;
            }}
            onFetchEnvironmentDiagnostics={() =>
              api.getEnvironmentDiagnostics()
            }
            onPreviewArtifact={(art) => setSelectedArtifact(art)}
            onDownloadArtifact={(art) => void api.downloadArtifact(art)}
            onSetTheme={setTheme}
            onSetDefaultModel={handleSetDefaultModel}
            onSwitchWorkspace={handleSwitchWorkspace}
            onCreateWorkspace={handleCreateWorkspace}
            onSelectSection={(sec) => {
              setSelectedArtifact(null);
              setActiveSection(sec);
            }}
          />
        )}
      </main>

      {/* PART 3: Right Artifact Inspector Panel (Desktop 3rd Pane / Mobile Sheet) */}
      <ArtifactInspectorDrawer
        artifact={selectedArtifact}
        onClose={() => setSelectedArtifact(null)}
        onDownload={(art) => void api.downloadArtifact(art)}
      />

      <GoalFormModal
        isOpen={goalModalOpen}
        initialGoal={editingGoal}
        onClose={() => setGoalModalOpen(false)}
        onSubmit={handleSaveGoal}
      />

      <DiagnosticTaskModal
        isOpen={addTaskModalOpen}
        existingTasks={selectedGoalTasks}
        onClose={() => setAddTaskModalOpen(false)}
        onCreateTask={handleCreateCustomTask}
      />
    </div>
  );
}
