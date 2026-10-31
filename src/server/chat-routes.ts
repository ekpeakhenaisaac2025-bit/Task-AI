import type express from 'express';
import {
  createConversationArtifactsBatch,
  createConversationForWorkspace,
  createConversationMessage,
  deleteConversationForUser,
  getArtifactByIdForUser,
  getConversationByIdForUser,
  getConversationMessageForUser,
  listArtifactsForWorkspace,
  listConversationsForWorkspace,
  listMessagesForConversation,
  pruneMessagesFromTurn,
  updateConversationForUser,
  updateConversationMessage,
} from '../db/conversations-repository.ts';
import {
  ensureGoalMetricsInitialized,
  listGoalMetricsByWorkspace,
  listOutcomeEvidenceByWorkspace,
  listTaskAttemptsByWorkspace,
} from '../db/milestone2-repository.ts';
import {
  createGoalForUser,
  ensureDefaultWorkspaceForUser,
  getGoalByIdForUser,
  getWorkspaceByIdForUser,
  listGoalsByUser,
  listIntegrationsByUser,
  listTasksByUser,
  savePlannedTasksForGoal,
  updateGoalForUser,
} from '../db/repository.ts';
import {
  buildArtifactsForTurn,
  buildHonestExecutionTrace,
  deriveConversationTitle,
  detectComplexExecutionIntent,
  normalizeChatModel,
  sanitizeMessageAttachments,
} from '../lib/chat-utils.ts';
import { requireAuth, type AuthRequest } from '../middleware/auth.ts';
import { createWorkforceConfigurationRow } from '../db/integrations-repository.ts';
import {
  analyzeWorkforceRequest,
  buildInteractivePromptFromWorkforce,
  detectWorkforceOrConnectorIntent,
  evaluateWorkforceReadiness,
} from '../lib/workforce-manager.ts';
import { redactSecretsFromText } from './crypto-vault.ts';
import { collectVerifiedWorkspaceCapabilities } from './execution-router.ts';
import { buildEnrichedWorkspaceIntegrationBundle } from './integration-routes.ts';
import {
  generateValidatedPlanWithGemini,
  streamConversationalTurnWithGemini,
} from './gemini.ts';
import { runOrchestratorCycle } from './orchestrator.ts';
import type {
  ChatExecutionTrace,
  ChatModelId,
  ConversationArtifactRecord,
  ExecutionStageItem,
  GoalRecord,
  HydratedGoalExecutionContext,
  TaskRecord,
} from '../types.ts';

async function resolveOwnedWorkspace(
  userId: string,
  requestedWorkspaceId: unknown
): Promise<{ id: string; name: string } | null> {
  if (
    typeof requestedWorkspaceId === 'string' &&
    requestedWorkspaceId.trim().length > 0
  ) {
    const ws = await getWorkspaceByIdForUser(
      requestedWorkspaceId.trim(),
      userId
    );
    return ws ? { id: ws.id, name: ws.name } : null;
  }
  const def = await ensureDefaultWorkspaceForUser(userId);
  return { id: def.id, name: def.name };
}

export async function hydrateGoalContextForConversation(params: {
  userId: string;
  workspaceId: string;
  goalId: string | null;
}): Promise<HydratedGoalExecutionContext | null> {
  if (!params.goalId) return null;
  const goal = await getGoalByIdForUser(params.goalId, params.userId);
  if (!goal || (goal.workspaceId && goal.workspaceId !== params.workspaceId)) {
    return null;
  }

  const [tasks, allMetrics, evidence, attempts] = await Promise.all([
    listTasksByUser(params.userId, goal.id, params.workspaceId),
    listGoalMetricsByWorkspace({
      userId: params.userId,
      workspaceId: params.workspaceId,
    }),
    listOutcomeEvidenceByWorkspace({
      userId: params.userId,
      workspaceId: params.workspaceId,
      goalId: goal.id,
    }),
    listTaskAttemptsByWorkspace({
      userId: params.userId,
      workspaceId: params.workspaceId,
      goalId: goal.id,
    }),
  ]);

  const metrics = allMetrics.filter((m) => m.goalId === goal.id);

  return {
    goal,
    tasks,
    metrics,
    evidence,
    attempts,
  };
}

async function buildWorkspaceMemorySummary(params: {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  linkedGoalId: string | null;
}): Promise<string> {
  const [goals, tasks, integrations] = await Promise.all([
    listGoalsByUser(params.userId, params.workspaceId),
    listTasksByUser(params.userId, undefined, params.workspaceId),
    listIntegrationsByUser(params.userId, params.workspaceId),
  ]);

  const capabilities = collectVerifiedWorkspaceCapabilities(integrations);
  const pendingApprovals = tasks.filter(
    (t) => t.approvalRequired && t.approvalStatus === 'pending'
  ).length;
  const verifiedTasks = tasks.filter((t) => t.status === 'verified').length;

  const recentGoalsSummary =
    goals.length > 0
      ? goals
          .slice(0, 5)
          .map(
            (g) =>
              `- [${g.status} · ${g.progressPercent}% verified] "${g.problem}" (Target: ${g.targetMetric})`
          )
          .join('\n')
      : '- No goals/projects created in this workspace yet.';

  const linkedGoalNote = params.linkedGoalId
    ? `Active Linked Project/Goal ID in this conversation: ${params.linkedGoalId}`
    : 'No Goal linked to this conversation yet.';

  return [
    `Workspace: "${params.workspaceName}" (${params.workspaceId})`,
    `Active Verified Capabilities: ${capabilities.join(', ') || 'ai_reasoning, content_drafting, prospect_qualification, diagnostic_verification'}`,
    `Connected Workspace Integrations: ${integrations.filter((i) => i.enabled).map((i) => `${i.displayName} (${i.providerKey}, verified=${i.verified})`).join(', ') || 'None configured (built-in LLM reasoning & diagnostic verification available)'}`,
    `Workspace Task Summary: ${tasks.length} total tasks, ${pendingApprovals} awaiting human approval, ${verifiedTasks} verified.`,
    linkedGoalNote,
    'Recent Workspace Projects / Goals:',
    recentGoalsSummary,
  ].join('\n');
}

function sendSseEvent(
  res: express.Response,
  event: string,
  payload: unknown
): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function registerChatAndArtifactRoutes(
  app: express.Application,
  aiRateLimiter: express.RequestHandler
): void {
  // List & search conversations for active workspace
  app.get('/api/conversations', requireAuth, async (req: AuthRequest, res) => {
    try {
      const ws = await resolveOwnedWorkspace(
        req.authUser!.uid,
        req.query.workspaceId
      );
      if (!ws) {
        return res.status(404).json({ error: 'Workspace not found.' });
      }

      const search =
        typeof req.query.search === 'string' ? req.query.search : undefined;
      const includeArchived = req.query.includeArchived === 'true';
      const archivedOnly = req.query.archivedOnly === 'true';

      const list = await listConversationsForWorkspace({
        userId: req.authUser!.uid,
        workspaceId: ws.id,
        search,
        includeArchived,
        archivedOnly,
      });

      res.json({ conversations: list, workspaceId: ws.id });
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? redactSecretsFromText(error.message)
          : 'Failed to load conversations.';
      res.status(500).json({ error: msg });
    }
  });

  // Create conversation
  app.post('/api/conversations', requireAuth, async (req: AuthRequest, res) => {
    try {
      const ws = await resolveOwnedWorkspace(
        req.authUser!.uid,
        req.body?.workspaceId
      );
      if (!ws) {
        return res.status(404).json({ error: 'Workspace not found.' });
      }

      const title =
        typeof req.body?.title === 'string' ? req.body.title : undefined;
      const model = normalizeChatModel(req.body?.model);
      const goalId =
        typeof req.body?.goalId === 'string' && req.body.goalId.trim()
          ? req.body.goalId.trim()
          : null;

      if (goalId) {
        const ownedGoal = await getGoalByIdForUser(goalId, req.authUser!.uid);
        if (!ownedGoal || ownedGoal.workspaceId !== ws.id) {
          return res.status(404).json({ error: 'Linked project/goal not found.' });
        }
      }

      const conversation = await createConversationForWorkspace({
        userId: req.authUser!.uid,
        workspaceId: ws.id,
        title,
        model,
        goalId,
      });

      res.status(201).json({ conversation });
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? redactSecretsFromText(error.message)
          : 'Failed to create conversation.';
      res.status(500).json({ error: msg });
    }
  });

  // Get conversation thread + artifacts + live hydrated execution context
  app.get(
    '/api/conversations/:id',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const workspaceIdParam =
          typeof req.query.workspaceId === 'string' &&
          req.query.workspaceId.trim()
            ? req.query.workspaceId.trim()
            : undefined;

        const conversation = await getConversationByIdForUser({
          conversationId: req.params.id,
          userId: req.authUser!.uid,
          workspaceId: workspaceIdParam,
        });
        if (!conversation) {
          return res.status(404).json({ error: 'Conversation not found.' });
        }

        const [rawMessages, artifacts, hydratedGoal] = await Promise.all([
          listMessagesForConversation({
            conversationId: conversation.id,
            userId: req.authUser!.uid,
            workspaceId: conversation.workspaceId,
          }),
          listArtifactsForWorkspace({
            userId: req.authUser!.uid,
            workspaceId: conversation.workspaceId,
            conversationId: conversation.id,
          }),
          hydrateGoalContextForConversation({
            userId: req.authUser!.uid,
            workspaceId: conversation.workspaceId,
            goalId: conversation.goalId,
          }),
        ]);

        // Refresh any message execution trace against live database truth so task/verification state is NEVER stale!
        const goalContextsCache = new Map<
          string,
          HydratedGoalExecutionContext | null
        >();
        if (conversation.goalId && hydratedGoal) {
          goalContextsCache.set(conversation.goalId, hydratedGoal);
        }

        const hydratedMessages = await Promise.all(
          rawMessages.map(async (m) => {
            if (!m.executionTrace?.goalId) return m;
            const gId = m.executionTrace.goalId;
            if (!goalContextsCache.has(gId)) {
              const ctx = await hydrateGoalContextForConversation({
                userId: req.authUser!.uid,
                workspaceId: conversation.workspaceId,
                goalId: gId,
              });
              goalContextsCache.set(gId, ctx);
            }
            const liveCtx = goalContextsCache.get(gId);
            if (!liveCtx) return m;

            return {
              ...m,
              executionTrace: buildHonestExecutionTrace({
                goal: liveCtx.goal,
                tasks: liveCtx.tasks,
                evidence: liveCtx.evidence,
              }),
            };
          })
        );

        res.json({
          conversation,
          messages: hydratedMessages,
          artifacts,
          hydratedGoal,
        });
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to load conversation thread.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // Rename, archive/restore, pin, or change model on conversation
  app.patch(
    '/api/conversations/:id',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const workspaceIdParam =
          typeof req.body?.workspaceId === 'string' &&
          req.body.workspaceId.trim()
            ? req.body.workspaceId.trim()
            : undefined;

        const title =
          typeof req.body?.title === 'string' ? req.body.title : undefined;
        if (title !== undefined && !title.trim()) {
          return res
            .status(400)
            .json({ error: 'Conversation title cannot be empty.' });
        }

        const archived =
          typeof req.body?.archived === 'boolean'
            ? req.body.archived
            : undefined;
        const pinned =
          typeof req.body?.pinned === 'boolean' ? req.body.pinned : undefined;
        const model =
          req.body?.model !== undefined
            ? normalizeChatModel(req.body.model)
            : undefined;

        const updated = await updateConversationForUser({
          conversationId: req.params.id,
          userId: req.authUser!.uid,
          workspaceId: workspaceIdParam,
          title,
          archived,
          pinned,
          model,
        });

        if (!updated) {
          return res.status(404).json({ error: 'Conversation not found.' });
        }

        res.json({ conversation: updated });
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to update conversation.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // Delete conversation
  app.delete(
    '/api/conversations/:id',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const workspaceIdParam =
          typeof req.query.workspaceId === 'string' &&
          req.query.workspaceId.trim()
            ? req.query.workspaceId.trim()
            : undefined;

        const deleted = await deleteConversationForUser({
          conversationId: req.params.id,
          userId: req.authUser!.uid,
          workspaceId: workspaceIdParam,
        });
        if (!deleted) {
          return res.status(404).json({ error: 'Conversation not found.' });
        }
        res.json({ deleted: true });
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to delete conversation.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // Stream a new message, an edited & resent message, or a regenerated response
  app.post(
    '/api/conversations/:id/messages/stream',
    requireAuth,
    aiRateLimiter,
    async (req: AuthRequest, res) => {
      const userId = req.authUser!.uid;
      const conversationId = req.params.id;

      const conversation = await getConversationByIdForUser({
        conversationId,
        userId,
      });
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }

      const ws = await getWorkspaceByIdForUser(conversation.workspaceId, userId);
      if (!ws) {
        return res.status(404).json({ error: 'Workspace not found.' });
      }

      const actionType: 'send' | 'edit' | 'regenerate' =
        req.body?.action === 'edit'
          ? 'edit'
          : req.body?.action === 'regenerate'
            ? 'regenerate'
            : 'send';

      const executionMode: 'auto' | 'chat' | 'execute' =
        req.body?.executionMode === 'execute'
          ? 'execute'
          : req.body?.executionMode === 'chat'
            ? 'chat'
            : 'auto';

      const requestedModel: ChatModelId = req.body?.model
        ? normalizeChatModel(req.body.model)
        : conversation.model;

      const attachments = sanitizeMessageAttachments(req.body?.attachments);
      let promptContent =
        typeof req.body?.content === 'string' ? req.body.content.trim() : '';

      // Validate edit / regenerate targets before opening SSE stream
      const existingMessages = await listMessagesForConversation({
        conversationId: conversation.id,
        userId,
        workspaceId: ws.id,
      });

      let activeUserMessage = null;
      let priorHistory = existingMessages;

      if (actionType === 'edit') {
        const targetMessageId =
          typeof req.body?.targetMessageId === 'string'
            ? req.body.targetMessageId.trim()
            : '';
        const targetMsg = await getConversationMessageForUser({
          messageId: targetMessageId,
          conversationId: conversation.id,
          userId,
        });
        if (!targetMsg || targetMsg.role !== 'user') {
          return res
            .status(404)
            .json({ error: 'Target user message not found for edit.' });
        }
        if (!promptContent && attachments.length === 0 && targetMsg.attachments.length === 0) {
          return res.status(400).json({ error: 'Message content cannot be empty.' });
        }

        await pruneMessagesFromTurn({
          conversationId: conversation.id,
          userId,
          workspaceId: ws.id,
          fromCreatedAtIso: targetMsg.createdAt,
        });

        const nextAttachments =
          req.body?.attachments !== undefined ? attachments : targetMsg.attachments;

        activeUserMessage = await updateConversationMessage({
          messageId: targetMsg.id,
          conversationId: conversation.id,
          userId,
          content: promptContent,
          attachments: nextAttachments,
          markEdited: true,
        });

        const targetIndex = existingMessages.findIndex(
          (m) => m.id === targetMsg.id
        );
        priorHistory =
          targetIndex > 0 ? existingMessages.slice(0, targetIndex) : [];
      } else if (actionType === 'regenerate') {
        const targetAssistantId =
          typeof req.body?.targetMessageId === 'string'
            ? req.body.targetMessageId.trim()
            : '';

        let lastUserIdx = -1;
        if (targetAssistantId) {
          const aIdx = existingMessages.findIndex(
            (m) => m.id === targetAssistantId
          );
          for (let i = (aIdx >= 0 ? aIdx : existingMessages.length) - 1; i >= 0; i--) {
            if (existingMessages[i].role === 'user') {
              lastUserIdx = i;
              break;
            }
          }
        } else {
          for (let i = existingMessages.length - 1; i >= 0; i--) {
            if (existingMessages[i].role === 'user') {
              lastUserIdx = i;
              break;
            }
          }
        }

        if (lastUserIdx === -1) {
          return res
            .status(400)
            .json({ error: 'No user prompt found to regenerate.' });
        }

        const pivotUserMsg = existingMessages[lastUserIdx];
        await pruneMessagesFromTurn({
          conversationId: conversation.id,
          userId,
          workspaceId: ws.id,
          fromCreatedAtIso: pivotUserMsg.createdAt,
        });

        activeUserMessage = pivotUserMsg;
        promptContent = pivotUserMsg.content;
        priorHistory = existingMessages.slice(0, lastUserIdx);
      } else {
        if (!promptContent && attachments.length === 0) {
          return res
            .status(400)
            .json({ error: 'Please enter a message or attach a file.' });
        }

        activeUserMessage = await createConversationMessage({
          conversationId: conversation.id,
          userId,
          workspaceId: ws.id,
          role: 'user',
          content: promptContent,
          model: requestedModel,
          status: 'completed',
          attachments,
        });
        priorHistory = existingMessages;
      }

      // Open SSE headers
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });

      // Auto-title new conversations on first message
      let currentConversation = conversation;
      if (
        priorHistory.length === 0 &&
        conversation.title === 'New conversation' &&
        promptContent
      ) {
        const derivedTitle = deriveConversationTitle(promptContent);
        const updatedConv = await updateConversationForUser({
          conversationId: conversation.id,
          userId,
          title: derivedTitle,
          model: requestedModel,
          touchLastMessageAt: true,
        });
        if (updatedConv) {
          currentConversation = updatedConv;
          sendSseEvent(res, 'conversation_updated', {
            conversation: updatedConv,
          });
        }
      } else if (requestedModel !== conversation.model) {
        const updatedConv = await updateConversationForUser({
          conversationId: conversation.id,
          userId,
          model: requestedModel,
          touchLastMessageAt: true,
        });
        if (updatedConv) {
          currentConversation = updatedConv;
        }
      }

      // Create streaming assistant placeholder message
      const assistantMsg = await createConversationMessage({
        conversationId: conversation.id,
        userId,
        workspaceId: ws.id,
        role: 'assistant',
        content: '',
        model: requestedModel,
        status: 'streaming',
      });

      sendSseEvent(res, 'message_started', {
        userMessage: activeUserMessage,
        assistantMessage: assistantMsg,
      });

      let executionTrace: ChatExecutionTrace | null = null;
      let executionSummaryForPrompt: string | null = null;
      let activeGoalForTurn: GoalRecord | null = null;
      let activeTasksForTurn: TaskRecord[] = [];
      let createdArtifacts: ConversationArtifactRecord[] = [];

      try {
        const liveGoogleToken = (
          req.header('x-google-access-token') || ''
        ).trim();
        const wfIntent = detectWorkforceOrConnectorIntent(promptContent);
        let interactivePromptForTurn: ChatExecutionTrace['interactivePrompt'] =
          null;

        if (wfIntent.matched && !abortController.signal.aborted) {
          const bundle = await buildEnrichedWorkspaceIntegrationBundle({
            userId,
            workspaceId: ws.id,
            hasLiveGoogleToken: Boolean(liveGoogleToken),
          });
          const blueprint = analyzeWorkforceRequest(promptContent);
          const readiness = evaluateWorkforceReadiness({
            blueprint,
            registry: bundle.registry,
          });
          const wfRecord = await createWorkforceConfigurationRow({
            userId,
            workspaceId: ws.id,
            conversationId: currentConversation.id,
            title: blueprint.title,
            requestPrompt: promptContent,
            roleSummary: blueprint.roleSummary,
            status: readiness.allOperational
              ? 'operational'
              : 'awaiting_authorization',
            requiredCapabilities: blueprint.requiredCapabilities,
            recommendedConnectors: readiness.recommendedConnectors,
            capabilityMatrix: readiness.capabilityMatrix,
            activationBlockerReason: readiness.activationBlockerReason,
          });
          interactivePromptForTurn = buildInteractivePromptFromWorkforce({
            kind: wfIntent.kind,
            config: wfRecord,
            targetProviderKey: wfIntent.targetProviderKey,
          });

          const wfSummaryLines = [
            `Workforce / Integration Configuration Evaluated: "${wfRecord.title}"`,
            `Overall Workforce Status: ${wfRecord.status} (NOTE: NEVER claim the AI employee or connector is operational unless status === "operational")`,
            `Blocker / Readiness Detail: ${wfRecord.activationBlockerReason || 'All required capabilities are verified and operational.'}`,
            'Recommended Connectors & Exact 7-State Readiness:',
            ...wfRecord.recommendedConnectors.map(
              (rc) =>
                `- ${rc.connectorName} (${rc.providerKey}): readiness=${rc.currentReadiness}, capabilities=[${rc.requiredForCapabilities.join(', ')}], why_needed="${rc.reasonNeeded}"`
            ),
            'Instruct the user clearly on why each missing connector is needed and direct them to review the interactive configuration card shown right above your response (or open Settings -> Integrations).',
          ].join('\n');

          executionSummaryForPrompt = wfSummaryLines;

          if (!detectComplexExecutionIntent(promptContent, executionMode).shouldExecute) {
            const nowIso = new Date().toISOString();
            executionTrace = {
              mode: 'autonomous_execution',
              goalId: null,
              goalProblem: wfRecord.title,
              targetMetric: 'Operational Workforce Readiness',
              runId: null,
              stages: [
                {
                  key: 'understanding_objective',
                  label: 'Understanding objective',
                  status: 'completed',
                  summary: wfRecord.roleSummary,
                  updatedAt: nowIso,
                },
                {
                  key: 'tool_selection',
                  label: 'Tool selection',
                  status: readiness.allOperational
                    ? 'completed'
                    : 'awaiting_approval',
                  summary:
                    wfRecord.activationBlockerReason ||
                    'All required capabilities are operational.',
                  details: wfRecord.recommendedConnectors.map(
                    (c) =>
                      `${c.connectorName}: ${c.currentReadiness} — ${c.reasonNeeded}`
                  ),
                  updatedAt: nowIso,
                },
              ],
              honestCompletionNote:
                wfRecord.activationBlockerReason ||
                'All required capabilities verified and operational.',
              hasVerifiedBusinessOutcome: false,
              awaitingApprovalCount: readiness.missingCapabilities.length,
              pendingVerificationCount: 0,
              interactivePrompt: interactivePromptForTurn,
            };
            sendSseEvent(res, 'execution_trace', { trace: executionTrace });
          }
        }

        const intent = detectComplexExecutionIntent(
          promptContent,
          executionMode
        );

        if (intent.shouldExecute && !abortController.signal.aborted) {
          const nowIso = new Date().toISOString();
          const initialStages: ExecutionStageItem[] = [
            {
              key: 'understanding_objective',
              label: 'Understanding objective',
              status: 'running',
              summary: 'Analyzing business objective, constraints, and target metric...',
              updatedAt: nowIso,
            },
            {
              key: 'planning',
              label: 'Planning',
              status: 'pending',
              summary: 'Waiting to generate execution plan.',
              updatedAt: nowIso,
            },
            {
              key: 'task_breakdown',
              label: 'Task breakdown',
              status: 'pending',
              summary: 'Waiting for DAG decomposition.',
              updatedAt: nowIso,
            },
            {
              key: 'tool_selection',
              label: 'Tool selection',
              status: 'pending',
              summary: 'Waiting for capability routing.',
              updatedAt: nowIso,
            },
            {
              key: 'execution',
              label: 'Execution',
              status: 'pending',
              summary: 'Waiting for orchestrator dispatch.',
              updatedAt: nowIso,
            },
            {
              key: 'verification',
              label: 'Verification',
              status: 'pending',
              summary: 'Waiting for execution evidence.',
              updatedAt: nowIso,
            },
            {
              key: 'completed_results',
              label: 'Completed results',
              status: 'pending',
              summary: 'Pending verified execution results.',
              updatedAt: nowIso,
            },
          ];

          sendSseEvent(res, 'execution_trace', {
            trace: {
              mode: 'autonomous_execution',
              goalId: null,
              goalProblem: promptContent,
              targetMetric: intent.inferredTargetMetric,
              runId: null,
              stages: initialStages,
              honestCompletionNote: 'Initializing Task.ai execution pipeline...',
              hasVerifiedBusinessOutcome: false,
              awaitingApprovalCount: 0,
              pendingVerificationCount: 0,
            } satisfies ChatExecutionTrace,
          });

          // Step 1 & 2: Create Goal in active state + invoke existing AI Planner
          const goal = await createGoalForUser({
            userId,
            workspaceId: ws.id,
            problem: promptContent,
            targetMetric: intent.inferredTargetMetric,
            deadline: null,
            status: 'active',
          });
          await ensureGoalMetricsInitialized({
            userId,
            workspaceId: ws.id,
            goal,
          });

          const updatedWithGoal = await updateConversationForUser({
            conversationId: currentConversation.id,
            userId,
            goalId: goal.id,
            touchLastMessageAt: true,
          });
          if (updatedWithGoal) {
            currentConversation = updatedWithGoal;
            sendSseEvent(res, 'conversation_updated', {
              conversation: updatedWithGoal,
            });
          }

          initialStages[0] = {
            ...initialStages[0],
            status: 'completed',
            summary: `Objective registered with target metric: "${intent.inferredTargetMetric}".`,
            updatedAt: new Date().toISOString(),
          };
          initialStages[1] = {
            ...initialStages[1],
            status: 'running',
            summary: 'Generating capability-routed task DAG via AI Planner...',
            updatedAt: new Date().toISOString(),
          };
          sendSseEvent(res, 'execution_trace', {
            trace: {
              mode: 'autonomous_execution',
              goalId: goal.id,
              goalProblem: goal.problem,
              targetMetric: goal.targetMetric,
              runId: null,
              stages: initialStages,
              honestCompletionNote: 'Generating dependency-checked task plan...',
              hasVerifiedBusinessOutcome: false,
              awaitingApprovalCount: 0,
              pendingVerificationCount: 0,
            } satisfies ChatExecutionTrace,
          });

          const workspaceIntegrations = await listIntegrationsByUser(
            userId,
            ws.id
          );
          const availableCapabilities = collectVerifiedWorkspaceCapabilities(
            workspaceIntegrations
          );
          const verifiedExternal = workspaceIntegrations.find(
            (i) => i.enabled && i.verified
          );

          const plannedTasks = await generateValidatedPlanWithGemini({
            goalId: goal.id,
            problem: goal.problem,
            targetMetric: goal.targetMetric,
            deadline: goal.deadline,
            availableCapabilities,
            preferredExternalProvider: verifiedExternal?.providerKey ?? null,
          });

          await savePlannedTasksForGoal({
            userId,
            goalId: goal.id,
            plannedTasks,
          });

          // Activate goal so eligible un-gated steps can execute immediately while approvalRequired steps pause at the Approval Gate
          const activatedGoal =
            (await updateGoalForUser({
              goalId: goal.id,
              userId,
              status: 'active',
            })) ?? goal;

          const preExecTasks = await listTasksByUser(userId, goal.id, ws.id);
          const midTrace = buildHonestExecutionTrace({
            goal: activatedGoal,
            tasks: preExecTasks,
            stageOverrides: {
              execution: {
                status: 'running',
                summary:
                  'Dispatching eligible un-gated tasks via Execution Orchestrator...',
              },
            },
          });
          sendSseEvent(res, 'execution_trace', { trace: midTrace });

          // Step 5 & 6: Run real Orchestrator Cycle (respects dependencies, Approval Gate, locks, idempotency, and verification separation!)
          if (!abortController.signal.aborted) {
            const orchResult = await runOrchestratorCycle({
              userId,
              goalId: activatedGoal.id,
              concurrencyMode: 'sequential',
              triggerType: 'manual_cycle',
              autoRunReasoning: false,
              googleAccessToken: liveGoogleToken || null,
            });

            const liveEvidence = await listOutcomeEvidenceByWorkspace({
              userId,
              workspaceId: ws.id,
              goalId: activatedGoal.id,
            });

            activeGoalForTurn = orchResult.goal;
            activeTasksForTurn = orchResult.tasks;
            executionTrace = {
              ...buildHonestExecutionTrace({
                goal: orchResult.goal,
                tasks: orchResult.tasks,
                run: orchResult.run,
                evidence: liveEvidence,
              }),
              interactivePrompt: interactivePromptForTurn,
            };

            const hydrated = await hydrateGoalContextForConversation({
              userId,
              workspaceId: ws.id,
              goalId: orchResult.goal.id,
            });

            sendSseEvent(res, 'execution_trace', {
              trace: executionTrace,
              hydratedGoal: hydrated,
            });

            const sortedTasks = [...orchResult.tasks].sort(
              (a, b) => a.stepOrder - b.stepOrder
            );
            executionSummaryForPrompt = [
              `Goal ID: ${orchResult.goal.id}`,
              `Goal Status: ${orchResult.goal.status} (Verified Progress: ${orchResult.goal.progressPercent}%)`,
              `Target Metric: ${orchResult.goal.targetMetric}`,
              `Orchestrator Run Summary: ${orchResult.run.tasksDispatched} dispatched, ${orchResult.run.tasksSucceeded} succeeded, ${orchResult.run.tasksFailed} failed (${orchResult.run.status})`,
              `Honest Completion Assessment: ${executionTrace.honestCompletionNote}`,
              'Persisted Tasks & Exact States:',
              ...sortedTasks.map((t) => {
                const draftSummary =
                  t.outputData && typeof t.outputData === 'object'
                    ? JSON.stringify(t.outputData).slice(0, 600)
                    : 'No output data yet';
                return `- Step ${t.stepOrder} [${t.status} | verification=${t.verificationStatus} | approval=${t.approvalStatus}]: ${t.description} (Tool: ${t.assignedProvider || t.tool}). Reason: ${t.statusReason || 'Queued'}. Output preview: ${draftSummary}`;
              }),
            ].join('\n');
          }
        }

        const workspaceContextSummary = await buildWorkspaceMemorySummary({
          userId,
          workspaceId: ws.id,
          workspaceName: ws.name,
          linkedGoalId: currentConversation.goalId,
        });

        const streamResult = await streamConversationalTurnWithGemini({
          requestedModel,
          workspaceContextSummary,
          history: priorHistory.map((m) => ({
            role: m.role,
            content: m.content,
            attachments: m.attachments,
          })),
          currentPrompt: promptContent,
          currentAttachments: activeUserMessage?.attachments ?? attachments,
          executionSummaryContext: executionSummaryForPrompt,
          abortSignal: abortController.signal,
          onTextDelta: (delta) => {
            sendSseEvent(res, 'text_delta', { delta });
          },
        });

        const wasAborted = abortController.signal.aborted;
        const finalStatus = wasAborted ? 'stopped' : 'completed';

        // Persist artifacts associated with this conversation & workspace
        const candidateArtifacts = buildArtifactsForTurn({
          conversationId: currentConversation.id,
          messageId: assistantMsg.id,
          userId,
          workspaceId: ws.id,
          goal: activeGoalForTurn,
          tasks: activeTasksForTurn,
          assistantMarkdown: streamResult.fullText,
        });

        if (candidateArtifacts.length > 0) {
          createdArtifacts =
            await createConversationArtifactsBatch(candidateArtifacts);
          sendSseEvent(res, 'artifacts_created', {
            artifacts: createdArtifacts,
          });
        }

        const finalizedAssistant = await updateConversationMessage({
          messageId: assistantMsg.id,
          conversationId: currentConversation.id,
          userId,
          content:
            streamResult.fullText ||
            (wasAborted ? '*(Generation stopped by user)*' : ''),
          model: streamResult.modelUsed,
          status: finalStatus,
          executionTrace,
          artifactIds: createdArtifacts.map((a) => a.id),
        });

        sendSseEvent(res, 'done', {
          assistantMessage: finalizedAssistant,
          artifacts: createdArtifacts,
          conversation: currentConversation,
          stopped: wasAborted,
        });
        res.end();
      } catch (error: unknown) {
        const cleanErr =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to generate AI response.';

        await updateConversationMessage({
          messageId: assistantMsg.id,
          conversationId: currentConversation.id,
          userId,
          content: cleanErr,
          status: 'error',
          executionTrace,
        }).catch(() => {});

        sendSseEvent(res, 'error', { error: cleanErr });
        res.end();
      }
    }
  );

  // List workspace artifacts
  app.get('/api/artifacts', requireAuth, async (req: AuthRequest, res) => {
    try {
      const ws = await resolveOwnedWorkspace(
        req.authUser!.uid,
        req.query.workspaceId
      );
      if (!ws) {
        return res.status(404).json({ error: 'Workspace not found.' });
      }
      const conversationId =
        typeof req.query.conversationId === 'string' &&
        req.query.conversationId.trim()
          ? req.query.conversationId.trim()
          : undefined;

      const artifacts = await listArtifactsForWorkspace({
        userId: req.authUser!.uid,
        workspaceId: ws.id,
        conversationId,
      });
      res.json({ artifacts });
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? redactSecretsFromText(error.message)
          : 'Failed to load workspace artifacts.';
      res.status(500).json({ error: msg });
    }
  });

  // Download single artifact with proper Workspace/User authorization
  app.get(
    '/api/artifacts/:id/download',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const artifact = await getArtifactByIdForUser({
          artifactId: req.params.id,
          userId: req.authUser!.uid,
        });
        if (!artifact) {
          return res.status(404).json({ error: 'Artifact not found.' });
        }

        const safeFilename = artifact.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        res.setHeader('Content-Type', `${artifact.mimeType}; charset=utf-8`);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${safeFilename}"`
        );
        res.send(artifact.content);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to download artifact.';
        res.status(500).json({ error: msg });
      }
    }
  );
}
