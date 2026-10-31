import crypto from 'node:crypto';
import {
  appendActionLog,
  claimQueuedTaskAtomically,
  createSingleTaskForGoal,
  ensureDefaultWorkspaceForUser,
  findPriorCompletedExecutionLog,
  getExecutableIntegrationForServer,
  getGoalByIdForUser,
  getTaskByIdForUser,
  getWorkspaceByIdForUser,
  listIntegrationsByUser,
  listTasksByUser,
  requeueTaskSafely,
  updateGoalForUser,
  updateTaskAfterWorkerCheckOrRun,
} from '../db/repository.ts';
import {
  acquireExecutionLock,
  claimProposalForDecisionAtomically,
  createExecutionRun,
  createOutcomeEvidenceRecord,
  createTaskAttempt,
  createVerificationDecisionRecord,
  detectAndQuarantineConflictingReference,
  finishExecutionRun,
  finishTaskAttempt,
  getOutcomeEvidenceByIdForUser,
  getProposalByIdForUser,
  getWorkspaceInboundSecretForServer,
  insertInboundEventDeduped,
  listOutcomeEvidenceByWorkspace,
  listTaskAttemptsByWorkspace,
  markProposalDecided,
  recalculateAndPersistGoalProgress,
  releaseExecutionLock,
  saveReasoningCycleWithProposals,
  updateOutcomeEvidenceVerificationState,
} from '../db/milestone2-repository.ts';
import {
  detectRequiresApproval,
  evaluateTaskEligibility,
  isExternalProviderTool,
  normalizeActionCategory,
  normalizeCapabilities,
  normalizeToolId,
} from '../lib/domain-rules.ts';
import {
  computeExponentialBackoffMs,
  detectStalledTasks,
  isRetryBackoffElapsed,
  planExecutionWave,
} from '../lib/orchestrator-rules.ts';
import {
  evaluateEvidenceVerification,
  validateInboundEvidencePayload,
  verifyInboundWebhookAuth,
  VALID_EVIDENCE_TYPES,
} from '../lib/verification-engine.ts';
import {
  decryptIntegrationSecretDetailed,
  redactSecretsFromText,
} from './crypto-vault.ts';
import {
  collectVerifiedWorkspaceCapabilities,
  executeRoutedTask,
  getBuiltInProviderReadiness,
} from './execution-router.ts';
import {
  analyzeEvidenceWithGemini,
  analyzeExecutionCycleWithGemini,
} from './gemini.ts';
import { RateLimitExceededError } from './rate-limiter.ts';
import { safeOutboundPostJson } from './ssrf-guard.ts';
import type {
  EvidenceType,
  ExecutionRunRecord,
  GoalMetricValueRecord,
  GoalRecord,
  NextActionProposalRecord,
  OutcomeEvidenceRecord,
  ProposedActionDetails,
  ReasoningCycleRecord,
  TaskAttemptRecord,
  TaskRecord,
  TaskStatus,
  VerificationDecisionRecord,
} from '../types.ts';

class ExecutionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Task execution timed out after ${timeoutMs}ms.`);
    this.name = 'ExecutionTimeoutError';
  }
}

async function runWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        handle = setTimeout(
          () => reject(new ExecutionTimeoutError(timeoutMs)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (handle !== undefined) {
      clearTimeout(handle);
    }
  }
}

export function isUncertainExternalExecutionError(err: unknown): boolean {
  if (err instanceof ExecutionTimeoutError) return true;
  if (err instanceof RateLimitExceededError) return false;

  const fullText =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err ?? '');

  // Pre-connect local guardrails never transmitted an external HTTP payload
  if (
    /SSRF Guard|DNS lookup|requires HTTPS|not configured|credentials|Rate limit exceeded/i.test(
      fullText
    )
  ) {
    return false;
  }

  // Deterministic HTTP status response received from upstream
  if (/failed with HTTP \d{3}\b/i.test(fullText)) {
    return false;
  }

  return /AbortError|TimeoutError|timed out|timeout|aborted|socket hang up|econnreset|etimedout|epipe|premature close/i.test(
    fullText
  );
}

export function isNonRetryableExecutionError(err: unknown): boolean {
  const fullText =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err ?? '');
  if (/failed with HTTP (400|401|403|404|405|409|410|422)\b/i.test(fullText)) {
    return true;
  }
  if (/SSRF Guard|requires HTTPS|credentials/i.test(fullText)) {
    return true;
  }
  return false;
}

async function findCorrelatedExternalOutcomeForTask(params: {
  userId: string;
  workspaceId: string;
  goalId: string;
  taskId: string;
}): Promise<{
  matchedState: 'verified' | 'pending_verification';
  evidence: OutcomeEvidenceRecord;
} | null> {
  const allEvidence = await listOutcomeEvidenceByWorkspace({
    userId: params.userId,
    workspaceId: params.workspaceId,
    goalId: params.goalId,
  });

  const matching = allEvidence.filter(
    (e) =>
      e.taskId === params.taskId &&
      e.verificationState !== 'rejected' &&
      e.provenanceClass !== 'internal_diagnostic'
  );
  if (matching.length === 0) return null;

  const verifiedMatch = matching.find(
    (e) => e.verificationState === 'verified'
  );
  if (verifiedMatch) {
    return { matchedState: 'verified', evidence: verifiedMatch };
  }

  return { matchedState: 'pending_verification', evidence: matching[0] };
}

/**
 * Detects tasks stuck in `running` beyond their timeout window (e.g., worker crash or server restart),
 * releases stale locks, reconciles external tasks from correlated evidence if already delivered,
 * and quarantines uncertain external tasks in `reconciliation_required` so external side effects
 * are NEVER blindly repeated.
 */
export async function recoverStalledTasksForGoal(params: {
  userId: string;
  workspaceId: string;
  goalId: string;
  nowMs?: number;
}): Promise<TaskRecord[]> {
  const effectiveNowMs = params.nowMs ?? Date.now();
  const goalTasks = await listTasksByUser(
    params.userId,
    params.goalId,
    params.workspaceId
  );
  const stalled = detectStalledTasks({
    tasks: goalTasks,
    nowMs: effectiveNowMs,
  });

  const recovered: TaskRecord[] = [];

  for (const task of stalled) {
    if (task.lockedBy) {
      await releaseExecutionLock({
        resourceKey: `task:${task.id}`,
        ownerWorkerId: task.lockedBy,
      });
    }

    const attemptNumber = task.retryCount + 1;

    if (isExternalProviderTool(task.tool)) {
      const correlated = await findCorrelatedExternalOutcomeForTask({
        userId: params.userId,
        workspaceId: params.workspaceId,
        goalId: params.goalId,
        taskId: task.id,
      });

      const recoveryAttempt = await createTaskAttempt({
        userId: params.userId,
        workspaceId: params.workspaceId,
        goalId: params.goalId,
        taskId: task.id,
        runId: null,
        attemptNumber,
        workerId: 'orchestrator-watchdog',
        providerKey: task.assignedProvider ?? task.tool,
        idempotencyKey: task.idempotencyKey,
      });

      if (correlated) {
        const reconcileSummary = `Watchdog reconciled crashed/restarted external execution via correlated outcome evidence (${correlated.evidence.evidenceType}) without duplicate dispatch.`;
        await finishTaskAttempt({
          attemptId: recoveryAttempt.id,
          userId: params.userId,
          status: correlated.matchedState,
          startedAtIso: task.startedAt ?? recoveryAttempt.startedAt,
          nextRetryAt: null,
          outputSummary: reconcileSummary,
        });

        const updated = await updateTaskAfterWorkerCheckOrRun({
          taskId: task.id,
          userId: params.userId,
          status: correlated.matchedState,
          verificationStatus: correlated.matchedState,
          statusReason: reconcileSummary,
          reconciliationRequired: false,
          nextRetryAt: null,
          completedAt: new Date(effectiveNowMs),
          verifiedAt:
            correlated.matchedState === 'verified'
              ? new Date(effectiveNowMs)
              : undefined,
        });

        await appendActionLog({
          userId: params.userId,
          workspaceId: params.workspaceId,
          goalId: params.goalId,
          taskId: task.id,
          executionProvider: 'orchestrator_watchdog',
          actionType: 'orchestrator:stalled_reconciled',
          status: correlated.matchedState,
          resultSummary: reconcileSummary,
          evidence: {
            evidenceId: correlated.evidence.id,
            matchedState: correlated.matchedState,
          },
          errorMessage: null,
        });

        await recalculateAndPersistGoalProgress({
          userId: params.userId,
          goalId: params.goalId,
        });

        if (updated) recovered.push(updated);
        continue;
      }

      const quarantineReason =
        'Uncertain execution outcome: external task stalled mid-flight (worker crash or server restart) and may have already produced external side effects. Reconcile before retrying.';

      await finishTaskAttempt({
        attemptId: recoveryAttempt.id,
        userId: params.userId,
        status: 'stalled_recovered',
        startedAtIso: task.startedAt ?? recoveryAttempt.startedAt,
        nextRetryAt: null,
        errorMessage: quarantineReason,
        outputSummary:
          'External task quarantined in reconciliation_required; automatic retry suppressed to prevent duplicate external actions.',
      });

      const updated = await updateTaskAfterWorkerCheckOrRun({
        taskId: task.id,
        userId: params.userId,
        status: 'blocked',
        statusReason: quarantineReason,
        retryCount: attemptNumber,
        nextRetryAt: null,
        reconciliationRequired: true,
      });

      await appendActionLog({
        userId: params.userId,
        workspaceId: params.workspaceId,
        goalId: params.goalId,
        taskId: task.id,
        executionProvider: 'orchestrator_watchdog',
        actionType: 'orchestrator:reconciliation_required',
        status: 'blocked',
        resultSummary: quarantineReason,
        evidence: {
          attemptNumber,
          reconciliationRequired: true,
        },
        errorMessage: quarantineReason,
      });

      if (updated) recovered.push(updated);
      continue;
    }

    const canRetry = attemptNumber <= task.maxRetries;
    const delayMs = canRetry
      ? computeExponentialBackoffMs({
          attemptNumber,
          backoffBaseMs: task.backoffBaseMs,
        })
      : 0;
    const nextRetryAt = canRetry ? new Date(effectiveNowMs + delayMs) : null;

    const recoveryAttempt = await createTaskAttempt({
      userId: params.userId,
      workspaceId: params.workspaceId,
      goalId: params.goalId,
      taskId: task.id,
      runId: null,
      attemptNumber,
      workerId: 'orchestrator-watchdog',
      providerKey: task.assignedProvider ?? task.tool,
      idempotencyKey: task.idempotencyKey,
    });

    await finishTaskAttempt({
      attemptId: recoveryAttempt.id,
      userId: params.userId,
      status: 'stalled_recovered',
      startedAtIso: task.startedAt ?? recoveryAttempt.startedAt,
      nextRetryAt,
      errorMessage:
        'Stalled running internal task detected past executionTimeoutMs; lock released by watchdog.',
      outputSummary: canRetry
        ? `Recovered stalled internal task and scheduled backoff retry in ${delayMs}ms.`
        : 'Recovered stalled internal task; retry limit reached, marked failed.',
    });

    const nextStatus: TaskStatus = canRetry
      ? task.approvalRequired && task.approvalStatus === 'approved'
        ? 'approved'
        : 'queued'
      : 'failed';

    const statusReason = canRetry
      ? `Watchdog recovered stalled execution (attempt ${attemptNumber}/${task.maxRetries + 1}); retry scheduled after ${delayMs}ms backoff.`
      : `Watchdog recovered stalled execution; failed after ${attemptNumber} attempt(s).`;

    const updated = await updateTaskAfterWorkerCheckOrRun({
      taskId: task.id,
      userId: params.userId,
      status: nextStatus,
      statusReason,
      retryCount: attemptNumber,
      nextRetryAt,
      reconciliationRequired: false,
    });

    await appendActionLog({
      userId: params.userId,
      workspaceId: params.workspaceId,
      goalId: params.goalId,
      taskId: task.id,
      executionProvider: 'orchestrator_watchdog',
      actionType: 'orchestrator:stalled_recovery',
      status: 'failed',
      resultSummary: statusReason,
      evidence: {
        attemptNumber,
        maxRetries: task.maxRetries,
        nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
      },
      errorMessage: 'Stalled task exceeded execution timeout.',
    });

    if (updated) {
      recovered.push(updated);
    }
  }

  return recovered;
}

export interface ManagedTaskExecutionResult {
  executed: boolean;
  workerId: string;
  task: TaskRecord | null;
  outcomeCode: string;
  message: string;
  attempt: TaskAttemptRecord | null;
}

/**
 * Executes a single task through the full Milestone 2 managed pipeline:
 * Goal/Pause checks -> Backoff gate -> Dependency & Approval & Capability Router gates ->
 * Persistent DB Lock + Atomic Claim -> Idempotency Guard -> Timeout-Guarded Execution ->
 * Outcome Separation (`verified` vs `pending_verification` vs `completed`) ->
 * Exponential Backoff Retry -> Goal Progress Recalculation.
 */
export async function executeSingleTaskManaged(params: {
  userId: string;
  taskId: string;
  runId?: string | null;
  workerId?: string;
  googleAccessToken?: string | null;
  httpTransport?: typeof safeOutboundPostJson;
  nowMs?: number;
}): Promise<ManagedTaskExecutionResult> {
  const workerId =
    params.workerId?.trim() || `orch-${crypto.randomUUID().slice(0, 8)}`;
  const effectiveNowMs = params.nowMs ?? Date.now();

  const task = await getTaskByIdForUser(params.taskId, params.userId);
  if (!task) {
    return {
      executed: false,
      workerId,
      task: null,
      outcomeCode: 'not_found',
      message: 'Task not found or access denied.',
      attempt: null,
    };
  }

  const goal = await getGoalByIdForUser(task.goalId, params.userId);
  if (!goal) {
    return {
      executed: false,
      workerId,
      task,
      outcomeCode: 'goal_not_found',
      message: 'Parent goal not found.',
      attempt: null,
    };
  }

  if (goal.executionState === 'paused') {
    return {
      executed: false,
      workerId,
      task,
      outcomeCode: 'goal_paused',
      message:
        'Goal execution is currently paused. Resume the goal to dispatch tasks.',
      attempt: null,
    };
  }

  if (goal.executionState === 'cancelled') {
    return {
      executed: false,
      workerId,
      task,
      outcomeCode: 'goal_cancelled',
      message: 'Goal execution was cancelled.',
      attempt: null,
    };
  }

  const workspaceId =
    goal.workspaceId ??
    task.workspaceId ??
    (await ensureDefaultWorkspaceForUser(params.userId)).id;

  if (
    (task.status === 'queued' ||
      task.status === 'approved' ||
      task.status === 'proposed') &&
    !isRetryBackoffElapsed(task.nextRetryAt, effectiveNowMs)
  ) {
    return {
      executed: false,
      workerId,
      task,
      outcomeCode: 'retry_backoff_pending',
      message: `Retry backoff window active until ${task.nextRetryAt}. Use Manual Retry to override immediately.`,
      attempt: null,
    };
  }

  const [allGoalTasks, userIntegrations] = await Promise.all([
    listTasksByUser(params.userId, goal.id, workspaceId),
    listIntegrationsByUser(params.userId, workspaceId),
  ]);

  const tasksById = new Map(allGoalTasks.map((t) => [t.id, t]));
  const builtInProviders = getBuiltInProviderReadiness();

  const eligibility = evaluateTaskEligibility({
    task,
    goalStatus: goal.status,
    tasksById,
    routingContext: {
      builtInProviders,
      userIntegrations,
    },
  });

  if (!eligibility.eligible) {
    if (eligibility.shouldTransitionTaskStatus) {
      const updatedTask = await updateTaskAfterWorkerCheckOrRun({
        taskId: task.id,
        userId: params.userId,
        status: eligibility.shouldTransitionTaskStatus,
        statusReason: eligibility.reason,
      });

      await appendActionLog({
        userId: params.userId,
        workspaceId,
        goalId: goal.id,
        taskId: task.id,
        executionProvider: `router_gate:${eligibility.code}`,
        actionType: `worker_gate:${eligibility.code}`,
        status:
          eligibility.shouldTransitionTaskStatus === 'rejected'
            ? 'rejected'
            : eligibility.shouldTransitionTaskStatus === 'failed'
              ? 'failed'
              : 'blocked',
        resultSummary: eligibility.reason,
        evidence: {
          workerId,
          gateCode: eligibility.code,
          proposedTool: task.tool,
          requiredCapabilities: task.requiredCapabilities,
          approvalRequired: task.approvalRequired,
          approvalStatus: task.approvalStatus,
        },
        errorMessage: eligibility.reason,
      });

      await recalculateAndPersistGoalProgress({
        userId: params.userId,
        goalId: goal.id,
      });

      return {
        executed: false,
        workerId,
        task: updatedTask,
        outcomeCode: eligibility.code,
        message: eligibility.reason,
        attempt: null,
      };
    }

    if (
      eligibility.code === 'dependency_unmet' ||
      eligibility.code === 'goal_inactive'
    ) {
      const preservedQueueStatus: TaskStatus =
        task.approvalRequired && task.approvalStatus === 'approved'
          ? 'approved'
          : 'queued';

      const updatedTask = await updateTaskAfterWorkerCheckOrRun({
        taskId: task.id,
        userId: params.userId,
        status: preservedQueueStatus,
        statusReason: eligibility.reason,
      });

      await appendActionLog({
        userId: params.userId,
        workspaceId,
        goalId: goal.id,
        taskId: task.id,
        executionProvider: `router_gate:${eligibility.code}`,
        actionType: `worker_gate:${eligibility.code}`,
        status: 'blocked',
        resultSummary: `Execution prevented: ${eligibility.reason}`,
        evidence: {
          workerId,
          gateCode: eligibility.code,
          dependencies: task.dependencies,
          goalStatus: goal.status,
        },
        errorMessage: eligibility.reason,
      });

      return {
        executed: false,
        workerId,
        task: updatedTask,
        outcomeCode: eligibility.code,
        message: eligibility.reason,
        attempt: null,
      };
    }

    return {
      executed: false,
      workerId,
      task,
      outcomeCode: eligibility.code,
      message: eligibility.reason,
      attempt: null,
    };
  }

  const resolvedRoute = eligibility.route!;
  const lockResourceKey = `task:${task.id}`;
  const timeoutMs =
    task.executionTimeoutMs > 0 ? task.executionTimeoutMs : 20_000;

  const lockAcquired = await acquireExecutionLock({
    resourceKey: lockResourceKey,
    workspaceId,
    ownerWorkerId: workerId,
    idempotencyKey: task.idempotencyKey,
    ttlMs: Math.max(timeoutMs + 10_000, 30_000),
  });

  if (!lockAcquired) {
    return {
      executed: false,
      workerId,
      task,
      outcomeCode: 'concurrent_lock_prevented',
      message:
        'Persistent execution lock held by another worker; duplicate execution prevented.',
      attempt: null,
    };
  }

  try {
    const claimedTask = await claimQueuedTaskAtomically({
      taskId: task.id,
      userId: params.userId,
      workerId,
    });

    if (!claimedTask) {
      return {
        executed: false,
        workerId,
        task,
        outcomeCode: 'concurrent_lock_prevented',
        message:
          'Another worker claimed this task atomically; duplicate execution prevented.',
        attempt: null,
      };
    }

    // Idempotency Guard
    const priorCompleted = await findPriorCompletedExecutionLog({
      userId: params.userId,
      taskId: claimedTask.id,
      idempotencyKey: claimedTask.idempotencyKey,
    });

    if (priorCompleted) {
      const restoredStatus: TaskStatus =
        priorCompleted.status === 'verified'
          ? 'verified'
          : priorCompleted.status === 'pending_verification'
            ? 'pending_verification'
            : 'completed';
      const restoredVerificationStatus =
        restoredStatus === 'verified'
          ? 'verified'
          : restoredStatus === 'pending_verification'
            ? 'pending_verification'
            : 'unverified';

      const restoredTask = await updateTaskAfterWorkerCheckOrRun({
        taskId: claimedTask.id,
        userId: params.userId,
        status: restoredStatus,
        verificationStatus: restoredVerificationStatus,
        statusReason:
          'Idempotency guard: restored prior execution state without duplicate side effects.',
      });

      await recalculateAndPersistGoalProgress({
        userId: params.userId,
        goalId: goal.id,
      });

      return {
        executed: false,
        workerId,
        task: restoredTask,
        outcomeCode: 'idempotent_skip',
        message:
          'Idempotency guard prevented duplicate execution; restored prior state.',
        attempt: null,
      };
    }

    const attemptNumber = claimedTask.retryCount + 1;
    const attempt = await createTaskAttempt({
      userId: params.userId,
      workspaceId,
      goalId: goal.id,
      taskId: claimedTask.id,
      runId: params.runId ?? null,
      attemptNumber,
      workerId,
      providerKey: resolvedRoute.providerKey,
      idempotencyKey: claimedTask.idempotencyKey,
    });

    await appendActionLog({
      userId: params.userId,
      workspaceId,
      goalId: goal.id,
      taskId: claimedTask.id,
      executionProvider: resolvedRoute.providerLabel,
      actionType: `${resolvedRoute.providerKey}:${claimedTask.actionCategory}`,
      status: 'attempted',
      resultSummary: `Orchestrator ${workerId} dispatched attempt #${attemptNumber} to "${resolvedRoute.providerLabel}".`,
      evidence: {
        workerId,
        workspaceId,
        attemptId: attempt.id,
        executionProvider: resolvedRoute.providerLabel,
        integrationId: resolvedRoute.integrationId,
        idempotencyKey: claimedTask.idempotencyKey,
        attemptNumber,
      },
      errorMessage: null,
    });

    const execStartMs = Date.now();

    try {
      const prerequisiteOutputs = claimedTask.dependencies
        .map((depId) => tasksById.get(depId))
        .filter((t): t is TaskRecord => Boolean(t))
        .map((t) => ({
          stepOrder: t.stepOrder,
          description: t.description,
          outputData: t.outputData,
        }));

      const result = await runWithTimeout(
        () =>
          executeRoutedTask({
            userId: params.userId,
            problem: goal.problem,
            targetMetric: goal.targetMetric,
            task: claimedTask,
            route: resolvedRoute,
            prerequisiteOutputs,
            googleAccessToken: params.googleAccessToken,
            httpTransport: params.httpTransport,
          }),
        timeoutMs
      );

      const completedAt = new Date();
      const durationMs = Math.max(0, Date.now() - execStartMs);

      if (result.independentVerification.verified) {
        // Mode 1: Deterministic server-side checksum verification (`internal_test_tool`)
        // Strictly classified as `internal_diagnostic` (`diagnostic_only`) so SHA-256 diagnostics NEVER inflate external business outcomes!
        const finalReason =
          result.independentVerification.verificationSummary ??
          result.completedSummary;

        const finishedTask = await updateTaskAfterWorkerCheckOrRun({
          taskId: claimedTask.id,
          userId: params.userId,
          status: 'verified',
          verificationStatus: 'verified',
          statusReason: finalReason,
          outputData: result.outputData,
          nextRetryAt: null,
          completedAt,
          verifiedAt: completedAt,
          lastDurationMs: durationMs,
          reconciliationRequired: false,
          assignedProvider: result.executionProvider,
          assignedIntegrationId: result.integrationId,
          expectedLockedBy: workerId,
        });

        if (!finishedTask) {
          const fencedAttempt = await finishTaskAttempt({
            attemptId: attempt.id,
            userId: params.userId,
            status: 'failed',
            startedAtIso: attempt.startedAt,
            errorMessage:
              'Execution lock expired and was reclaimed; stale worker write fenced.',
          });
          return {
            executed: false,
            workerId,
            task: await getTaskByIdForUser(claimedTask.id, params.userId),
            outcomeCode: 'stale_worker_fenced',
            message:
              'Stale worker write fenced after execution lock expiration.',
            attempt: fencedAttempt,
          };
        }

        const detEvidence = await createOutcomeEvidenceRecord({
          userId: params.userId,
          workspaceId,
          goalId: goal.id,
          taskId: claimedTask.id,
          inboundEventId: null,
          sourceType: 'deterministic_execution',
          provider: resolvedRoute.providerKey,
          evidenceType: 'diagnostic_checksum',
          externalReferenceId: String(
            result.outputData.payloadSha256 ?? claimedTask.id
          ),
          summary: finalReason,
          structuredMetrics: { diagnosticPass: 1 },
          rawPayload:
            result.independentVerification.verificationEvidence ??
            result.outputData,
          provenanceClass: 'internal_diagnostic',
          trustTier: 'diagnostic_only',
          hasConflict: false,
          requiresHumanReview: false,
          verificationState: 'verified',
          observedAt: completedAt,
        });

        await createVerificationDecisionRecord({
          userId: params.userId,
          workspaceId,
          goalId: goal.id,
          taskId: claimedTask.id,
          evidenceId: detEvidence.id,
          verificationMethod: 'deterministic',
          decision: 'verified',
          reviewerIdentity: 'system:deterministic_sha256',
          notes: `${finalReason} (diagnostic_only; excluded from external business outcomes)`,
          traceMetadata: {
            payloadSha256: result.outputData.payloadSha256 ?? null,
            idempotencyKey: claimedTask.idempotencyKey,
            provenanceClass: 'internal_diagnostic',
            trustTier: 'diagnostic_only',
          },
        });

        await appendActionLog({
          userId: params.userId,
          workspaceId,
          goalId: goal.id,
          taskId: claimedTask.id,
          executionProvider: result.executionProvider,
          actionType: `${resolvedRoute.providerKey}:${claimedTask.actionCategory}`,
          status: 'completed',
          resultSummary: result.completedSummary,
          evidence: {
            ...result.outputData,
            workerId,
            workspaceId,
            idempotencyKey: claimedTask.idempotencyKey,
          },
          errorMessage: null,
        });

        await appendActionLog({
          userId: params.userId,
          workspaceId,
          goalId: goal.id,
          taskId: claimedTask.id,
          executionProvider: result.executionProvider,
          actionType: `${resolvedRoute.providerKey}:verification`,
          status: 'verified',
          resultSummary: finalReason,
          evidence: {
            ...(result.independentVerification.verificationEvidence ?? {}),
            evidenceId: detEvidence.id,
            provenanceClass: 'internal_diagnostic',
            trustTier: 'diagnostic_only',
            workerId,
            workspaceId,
            idempotencyKey: claimedTask.idempotencyKey,
          },
          errorMessage: null,
        });

        const finishedAttempt = await finishTaskAttempt({
          attemptId: attempt.id,
          userId: params.userId,
          status: 'verified',
          startedAtIso: attempt.startedAt,
          outputSummary: finalReason,
        });

        await recalculateAndPersistGoalProgress({
          userId: params.userId,
          goalId: goal.id,
        });

        return {
          executed: true,
          workerId,
          task: finishedTask,
          outcomeCode: 'verified',
          message: finalReason,
          attempt: finishedAttempt,
        };
      }

      if (result.awaitingExternalOutcomeVerification) {
        // External HTTP 2xx dispatch accepted -> STRICTLY enters `pending_verification`, NOT `verified`!
        const finishedTask = await updateTaskAfterWorkerCheckOrRun({
          taskId: claimedTask.id,
          userId: params.userId,
          status: 'pending_verification',
          verificationStatus: 'pending_verification',
          statusReason: result.completedSummary,
          outputData: result.outputData,
          nextRetryAt: null,
          completedAt,
          lastDurationMs: durationMs,
          reconciliationRequired: false,
          assignedProvider: result.executionProvider,
          assignedIntegrationId: result.integrationId,
          expectedLockedBy: workerId,
        });

        if (!finishedTask) {
          const fencedAttempt = await finishTaskAttempt({
            attemptId: attempt.id,
            userId: params.userId,
            status: 'failed',
            startedAtIso: attempt.startedAt,
            errorMessage:
              'Execution lock expired and was reclaimed; stale worker write fenced.',
          });
          return {
            executed: false,
            workerId,
            task: await getTaskByIdForUser(claimedTask.id, params.userId),
            outcomeCode: 'stale_worker_fenced',
            message:
              'Stale worker write fenced after execution lock expiration.',
            attempt: fencedAttempt,
          };
        }

        await appendActionLog({
          userId: params.userId,
          workspaceId,
          goalId: goal.id,
          taskId: claimedTask.id,
          executionProvider: result.executionProvider,
          actionType: `${resolvedRoute.providerKey}:${claimedTask.actionCategory}`,
          status: 'pending_verification',
          resultSummary: result.completedSummary,
          evidence: {
            ...result.outputData,
            workerId,
            workspaceId,
            idempotencyKey: claimedTask.idempotencyKey,
            verificationState: 'pending_verification',
          },
          errorMessage: null,
        });

        const finishedAttempt = await finishTaskAttempt({
          attemptId: attempt.id,
          userId: params.userId,
          status: 'pending_verification',
          startedAtIso: attempt.startedAt,
          outputSummary: result.completedSummary,
        });

        await recalculateAndPersistGoalProgress({
          userId: params.userId,
          goalId: goal.id,
        });

        return {
          executed: true,
          workerId,
          task: finishedTask,
          outcomeCode: 'pending_verification',
          message: result.completedSummary,
          attempt: finishedAttempt,
        };
      }

      // Built-in LLM reasoning / drafting task -> `completed` (`unverified`, drafts never counted as sent)
      const finishedTask = await updateTaskAfterWorkerCheckOrRun({
        taskId: claimedTask.id,
        userId: params.userId,
        status: 'completed',
        verificationStatus: 'unverified',
        statusReason: result.completedSummary,
        outputData: result.outputData,
        nextRetryAt: null,
        completedAt,
        lastDurationMs: durationMs,
        reconciliationRequired: false,
        assignedProvider: result.executionProvider,
        assignedIntegrationId: result.integrationId,
        expectedLockedBy: workerId,
      });

      if (!finishedTask) {
        const fencedAttempt = await finishTaskAttempt({
          attemptId: attempt.id,
          userId: params.userId,
          status: 'failed',
          startedAtIso: attempt.startedAt,
          errorMessage:
            'Execution lock expired and was reclaimed; stale worker write fenced.',
        });
        return {
          executed: false,
          workerId,
          task: await getTaskByIdForUser(claimedTask.id, params.userId),
          outcomeCode: 'stale_worker_fenced',
          message: 'Stale worker write fenced after execution lock expiration.',
          attempt: fencedAttempt,
        };
      }

      await appendActionLog({
        userId: params.userId,
        workspaceId,
        goalId: goal.id,
        taskId: claimedTask.id,
        executionProvider: result.executionProvider,
        actionType: `${resolvedRoute.providerKey}:${claimedTask.actionCategory}`,
        status: 'completed',
        resultSummary: result.completedSummary,
        evidence: {
          ...result.outputData,
          workerId,
          workspaceId,
          idempotencyKey: claimedTask.idempotencyKey,
        },
        errorMessage: null,
      });

      const finishedAttempt = await finishTaskAttempt({
        attemptId: attempt.id,
        userId: params.userId,
        status: 'completed',
        startedAtIso: attempt.startedAt,
        outputSummary: result.completedSummary,
      });

      await recalculateAndPersistGoalProgress({
        userId: params.userId,
        goalId: goal.id,
      });

      return {
        executed: true,
        workerId,
        task: finishedTask,
        outcomeCode: 'completed',
        message: result.completedSummary,
        attempt: finishedAttempt,
      };
    } catch (error: unknown) {
      const rawError =
        error instanceof Error
          ? error.message
          : 'Unknown provider execution error.';
      const cleanError = redactSecretsFromText(rawError);
      const isTimeout = error instanceof ExecutionTimeoutError;
      const durationMs = Math.max(0, Date.now() - execStartMs);

      const isExternalRoute = isExternalProviderTool(
        resolvedRoute.providerKey as TaskRecord['tool']
      );
      const uncertainExternal =
        isExternalRoute && isUncertainExternalExecutionError(error);

      if (uncertainExternal) {
        // Check if external outcome callback already arrived before our local HTTP socket timed out!
        const correlated = await findCorrelatedExternalOutcomeForTask({
          userId: params.userId,
          workspaceId,
          goalId: goal.id,
          taskId: claimedTask.id,
        });

        if (correlated) {
          const reconciledMsg = `Outbound HTTP request timed out (${cleanError}), but correlated external outcome evidence (${correlated.evidence.evidenceType}) was already received; reconciled without duplicate dispatch.`;
          const reconciledTask = await updateTaskAfterWorkerCheckOrRun({
            taskId: claimedTask.id,
            userId: params.userId,
            status: correlated.matchedState,
            verificationStatus: correlated.matchedState,
            statusReason: reconciledMsg,
            retryCount: attemptNumber,
            nextRetryAt: null,
            completedAt: new Date(),
            verifiedAt:
              correlated.matchedState === 'verified' ? new Date() : undefined,
            lastDurationMs: durationMs,
            reconciliationRequired: false,
            assignedProvider: resolvedRoute.providerLabel,
            assignedIntegrationId: resolvedRoute.integrationId,
            expectedLockedBy: workerId,
          });

          const reconciledAttempt = await finishTaskAttempt({
            attemptId: attempt.id,
            userId: params.userId,
            status: correlated.matchedState,
            startedAtIso: attempt.startedAt,
            nextRetryAt: null,
            outputSummary: reconciledMsg,
          });

          await appendActionLog({
            userId: params.userId,
            workspaceId,
            goalId: goal.id,
            taskId: claimedTask.id,
            executionProvider: resolvedRoute.providerLabel,
            actionType: 'orchestrator:timeout_reconciled_from_evidence',
            status: correlated.matchedState,
            resultSummary: reconciledMsg,
            evidence: {
              workerId,
              attemptId: attempt.id,
              evidenceId: correlated.evidence.id,
              matchedState: correlated.matchedState,
            },
            errorMessage: null,
          });

          await recalculateAndPersistGoalProgress({
            userId: params.userId,
            goalId: goal.id,
          });

          return {
            executed: true,
            workerId,
            task:
              reconciledTask ??
              (await getTaskByIdForUser(claimedTask.id, params.userId)),
            outcomeCode: 'reconciled_from_evidence',
            message: reconciledMsg,
            attempt: reconciledAttempt,
          };
        }

        // Uncertain external side-effect state: NEVER schedule automatic retry!
        const quarantineMsg = `Uncertain external outcome (${cleanError}). Automatic retry suppressed to prevent duplicate external side effects; reconcile external state before retrying.`;

        const quarantinedTask = await updateTaskAfterWorkerCheckOrRun({
          taskId: claimedTask.id,
          userId: params.userId,
          status: 'blocked',
          statusReason: quarantineMsg,
          retryCount: attemptNumber,
          nextRetryAt: null,
          lastDurationMs: durationMs,
          reconciliationRequired: true,
          assignedProvider: resolvedRoute.providerLabel,
          assignedIntegrationId: resolvedRoute.integrationId,
          expectedLockedBy: workerId,
        });

        if (!quarantinedTask) {
          const fencedAttempt = await finishTaskAttempt({
            attemptId: attempt.id,
            userId: params.userId,
            status: 'failed',
            startedAtIso: attempt.startedAt,
            errorMessage:
              'Execution lock expired and was reclaimed; stale worker write fenced.',
          });
          return {
            executed: false,
            workerId,
            task: await getTaskByIdForUser(claimedTask.id, params.userId),
            outcomeCode: 'stale_worker_fenced',
            message:
              'Stale worker write fenced after execution lock expiration.',
            attempt: fencedAttempt,
          };
        }

        await appendActionLog({
          userId: params.userId,
          workspaceId,
          goalId: goal.id,
          taskId: claimedTask.id,
          executionProvider: resolvedRoute.providerLabel,
          actionType: 'orchestrator:reconciliation_required',
          status: 'blocked',
          resultSummary: quarantineMsg,
          evidence: {
            workerId,
            workspaceId,
            attemptId: attempt.id,
            executionProvider: resolvedRoute.providerLabel,
            idempotencyKey: claimedTask.idempotencyKey,
            attemptNumber,
            reconciliationRequired: true,
            timedOut: isTimeout,
          },
          errorMessage: cleanError,
        });

        const finishedAttempt = await finishTaskAttempt({
          attemptId: attempt.id,
          userId: params.userId,
          status: isTimeout ? 'timed_out' : 'failed',
          startedAtIso: attempt.startedAt,
          nextRetryAt: null,
          errorMessage: cleanError,
          outputSummary: quarantineMsg,
        });

        await recalculateAndPersistGoalProgress({
          userId: params.userId,
          goalId: goal.id,
        });

        return {
          executed: false,
          workerId,
          task: quarantinedTask,
          outcomeCode: 'reconciliation_required',
          message: quarantineMsg,
          attempt: finishedAttempt,
        };
      }

      const nonRetryable = isNonRetryableExecutionError(error);
      const canAutoRetry = !nonRetryable && attemptNumber <= claimedTask.maxRetries;
      const delayMs = canAutoRetry
        ? computeExponentialBackoffMs({
            attemptNumber,
            backoffBaseMs: claimedTask.backoffBaseMs,
          })
        : 0;
      const nextRetryAt = canAutoRetry
        ? new Date(Date.now() + delayMs)
        : null;

      const nextTaskStatus: TaskStatus = canAutoRetry
        ? claimedTask.approvalRequired &&
          claimedTask.approvalStatus === 'approved'
          ? 'approved'
          : 'queued'
        : 'failed';

      const failureSummary = canAutoRetry
        ? `Attempt ${attemptNumber}/${claimedTask.maxRetries + 1} failed (${cleanError}). Exponential backoff retry scheduled in ${delayMs}ms.`
        : `Execution failed after ${attemptNumber} attempt(s): ${cleanError}`;

      const failedTask = await updateTaskAfterWorkerCheckOrRun({
        taskId: claimedTask.id,
        userId: params.userId,
        status: nextTaskStatus,
        statusReason: failureSummary,
        retryCount: attemptNumber,
        nextRetryAt,
        lastDurationMs: durationMs,
        reconciliationRequired: false,
        assignedProvider: resolvedRoute.providerLabel,
        assignedIntegrationId: resolvedRoute.integrationId,
        expectedLockedBy: workerId,
      });

      if (!failedTask) {
        const fencedAttempt = await finishTaskAttempt({
          attemptId: attempt.id,
          userId: params.userId,
          status: 'failed',
          startedAtIso: attempt.startedAt,
          errorMessage:
            'Execution lock expired and was reclaimed; stale worker write fenced.',
        });
        return {
          executed: false,
          workerId,
          task: await getTaskByIdForUser(claimedTask.id, params.userId),
          outcomeCode: 'stale_worker_fenced',
          message: 'Stale worker write fenced after execution lock expiration.',
          attempt: fencedAttempt,
        };
      }

      await appendActionLog({
        userId: params.userId,
        workspaceId,
        goalId: goal.id,
        taskId: claimedTask.id,
        executionProvider: resolvedRoute.providerLabel,
        actionType: `${resolvedRoute.providerKey}:${claimedTask.actionCategory}`,
        status: 'failed',
        resultSummary: failureSummary,
        evidence: {
          workerId,
          workspaceId,
          attemptId: attempt.id,
          executionProvider: resolvedRoute.providerLabel,
          idempotencyKey: claimedTask.idempotencyKey,
          attemptNumber,
          maxRetries: claimedTask.maxRetries,
          backoffDelayMs: canAutoRetry ? delayMs : null,
          nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
          timedOut: isTimeout,
        },
        errorMessage: cleanError,
      });

      const finishedAttempt = await finishTaskAttempt({
        attemptId: attempt.id,
        userId: params.userId,
        status: isTimeout ? 'timed_out' : 'failed',
        startedAtIso: attempt.startedAt,
        nextRetryAt,
        errorMessage: cleanError,
        outputSummary: failureSummary,
      });

      await recalculateAndPersistGoalProgress({
        userId: params.userId,
        goalId: goal.id,
      });

      return {
        executed: false,
        workerId,
        task: failedTask,
        outcomeCode: canAutoRetry ? 'retry_scheduled' : 'execution_failed',
        message: failureSummary,
        attempt: finishedAttempt,
      };
    }
  } finally {
    await releaseExecutionLock({
      resourceKey: lockResourceKey,
      ownerWorkerId: workerId,
    });
  }
}

/**
 * Centralized Execution Orchestrator wave cycle.
 * Supports sequential or parallel-safe execution across eligible waves, stalled-task recovery,
 * Approval Gate halting, and optional post-cycle continuous AI reasoning.
 */
export async function runOrchestratorCycle(params: {
  userId: string;
  goalId: string;
  concurrencyMode?: 'sequential' | 'parallel_safe';
  triggerType?: ExecutionRunRecord['triggerType'];
  autoRunReasoning?: boolean;
  googleAccessToken?: string | null;
  httpTransport?: typeof safeOutboundPostJson;
  nowMs?: number;
}): Promise<{
  run: ExecutionRunRecord;
  goal: GoalRecord;
  tasks: TaskRecord[];
  metrics: GoalMetricValueRecord[];
  reasoning: {
    cycle: ReasoningCycleRecord;
    proposals: NextActionProposalRecord[];
  } | null;
}> {
  const concurrencyMode = params.concurrencyMode ?? 'parallel_safe';
  const triggerType = params.triggerType ?? 'manual_cycle';

  const initialGoal = await getGoalByIdForUser(params.goalId, params.userId);
  if (!initialGoal) {
    throw new Error('Goal not found or access denied.');
  }

  const workspaceId =
    initialGoal.workspaceId ??
    (await ensureDefaultWorkspaceForUser(params.userId)).id;

  // Step 1: Recover any stalled tasks before planning waves
  await recoverStalledTasksForGoal({
    userId: params.userId,
    workspaceId,
    goalId: initialGoal.id,
    nowMs: params.nowMs,
  });

  const run = await createExecutionRun({
    userId: params.userId,
    workspaceId,
    goalId: initialGoal.id,
    triggerType,
    concurrencyMode,
  });

  if (
    initialGoal.status === 'active' &&
    initialGoal.executionState !== 'paused' &&
    initialGoal.executionState !== 'cancelled'
  ) {
    await updateGoalForUser({
      goalId: initialGoal.id,
      userId: params.userId,
      executionState: 'running',
    });
  }

  let tasksDispatched = 0;
  let tasksSucceeded = 0;
  let tasksFailed = 0;
  let haltSummary: string | null = null;
  let haltedForApproval = false;

  const builtInProviders = getBuiltInProviderReadiness();
  const MAX_WAVES = 10;

  try {
    for (let waveIndex = 0; waveIndex < MAX_WAVES; waveIndex++) {
      const currentGoal = await getGoalByIdForUser(initialGoal.id, params.userId);
      if (!currentGoal) break;

      if (
        currentGoal.executionState === 'paused' ||
        currentGoal.executionState === 'cancelled' ||
        currentGoal.status === 'completed'
      ) {
        haltSummary =
          currentGoal.status === 'completed'
            ? 'Goal target metrics verified and achieved.'
            : `Execution halted because goal state is "${currentGoal.executionState}".`;
        break;
      }

      const [goalTasks, userIntegrations] = await Promise.all([
        listTasksByUser(params.userId, currentGoal.id, workspaceId),
        listIntegrationsByUser(params.userId, workspaceId),
      ]);

      const wave = planExecutionWave({
        goal: currentGoal,
        tasks: goalTasks,
        concurrencyMode,
        nowMs: params.nowMs,
        routingContext: {
          builtInProviders,
          userIntegrations,
        },
      });

      // Apply any deterministic gate transitions (approval_pending -> blocked, tool_unconfigured -> blocked, etc.)
      for (const gt of wave.gateTransitions) {
        if (gt.code === 'approval_pending') {
          haltedForApproval = true;
        }
        await updateTaskAfterWorkerCheckOrRun({
          taskId: gt.task.id,
          userId: params.userId,
          status: gt.nextStatus,
          statusReason: gt.reason,
        });
        await appendActionLog({
          userId: params.userId,
          workspaceId,
          goalId: currentGoal.id,
          taskId: gt.task.id,
          executionProvider: `orchestrator_gate:${gt.code}`,
          actionType: `worker_gate:${gt.code}`,
          status:
            gt.nextStatus === 'rejected'
              ? 'rejected'
              : gt.nextStatus === 'failed'
                ? 'failed'
                : 'blocked',
          resultSummary: gt.reason,
          evidence: {
            runId: run.id,
            waveIndex: waveIndex + 1,
            gateCode: gt.code,
          },
          errorMessage: gt.reason,
        });
      }

      if (wave.haltedReason) {
        haltSummary = wave.haltedReason;
        break;
      }

      if (wave.eligibleBatch.length === 0) {
        if (wave.waitingOnBackoffCount > 0) {
          haltSummary = `${wave.waitingOnBackoffCount} task(s) scheduled for exponential backoff retry.`;
        }
        break;
      }

      const batchResults: ManagedTaskExecutionResult[] = [];
      if (concurrencyMode === 'parallel_safe' && wave.eligibleBatch.length > 1) {
        const settled = await Promise.allSettled(
          wave.eligibleBatch.map((item) =>
            executeSingleTaskManaged({
              userId: params.userId,
              taskId: item.task.id,
              runId: run.id,
              googleAccessToken: params.googleAccessToken,
              httpTransport: params.httpTransport,
              nowMs: params.nowMs,
            })
          )
        );
        for (const outcome of settled) {
          if (outcome.status === 'fulfilled') {
            batchResults.push(outcome.value);
          } else {
            tasksDispatched += 1;
            tasksFailed += 1;
          }
        }
      } else {
        for (const item of wave.eligibleBatch) {
          const res = await executeSingleTaskManaged({
            userId: params.userId,
            taskId: item.task.id,
            runId: run.id,
            googleAccessToken: params.googleAccessToken,
            httpTransport: params.httpTransport,
            nowMs: params.nowMs,
          });
          batchResults.push(res);
        }
      }

      for (const r of batchResults) {
        tasksDispatched += 1;
        if (r.executed) {
          tasksSucceeded += 1;
        } else if (
          r.outcomeCode === 'execution_failed' ||
          r.outcomeCode === 'retry_scheduled' ||
          r.outcomeCode === 'reconciliation_required'
        ) {
          tasksFailed += 1;
        }
      }

      if (concurrencyMode === 'sequential') {
        if (batchResults.some((r) => !r.executed)) {
          break;
        }
      }
    }

    const progress = await recalculateAndPersistGoalProgress({
      userId: params.userId,
      goalId: initialGoal.id,
    });

    const latestTasks = await listTasksByUser(
      params.userId,
      initialGoal.id,
      workspaceId
    );

    const anyPendingApproval = latestTasks.some(
      (t) =>
        t.approvalRequired &&
        t.approvalStatus === 'pending' &&
        (t.status === 'blocked' ||
          t.status === 'queued' ||
          t.status === 'proposed')
    );
    if (anyPendingApproval) {
      haltedForApproval = true;
    }

    const refreshedGoalBeforeFinish =
      progress.goal ??
      (await getGoalByIdForUser(initialGoal.id, params.userId)) ??
      initialGoal;

    let nextExecState = refreshedGoalBeforeFinish.executionState;
    if (
      nextExecState !== 'paused' &&
      nextExecState !== 'cancelled' &&
      refreshedGoalBeforeFinish.status !== 'completed'
    ) {
      const hasBlocked = latestTasks.some((t) => t.status === 'blocked');
      const hasRunnable = latestTasks.some(
        (t) => t.status === 'queued' || t.status === 'approved'
      );
      nextExecState = hasBlocked && !hasRunnable ? 'blocked' : 'idle';
      await updateGoalForUser({
        goalId: initialGoal.id,
        userId: params.userId,
        executionState: nextExecState,
      });
    }

    let runStatus: ExecutionRunRecord['status'] = 'completed';
    if (refreshedGoalBeforeFinish.executionState === 'paused') {
      runStatus = 'paused';
    } else if (refreshedGoalBeforeFinish.executionState === 'cancelled') {
      runStatus = 'cancelled';
    } else if (haltedForApproval && tasksDispatched === 0) {
      runStatus = 'halted_for_approval';
    } else if (tasksFailed > 0 && tasksSucceeded === 0) {
      runStatus = 'failed';
    }

    const runSummary =
      haltSummary ??
      (haltedForApproval
        ? `Dispatched ${tasksDispatched} task(s) (${tasksSucceeded} succeeded, ${tasksFailed} failed); consequential task(s) halted at Approval Gate.`
        : `Dispatched ${tasksDispatched} task(s) (${tasksSucceeded} succeeded, ${tasksFailed} failed). Verified goal progress: ${progress.progressPercent}%.`);

    const finishedRun =
      (await finishExecutionRun({
        runId: run.id,
        userId: params.userId,
        status: runStatus,
        tasksDispatched,
        tasksSucceeded,
        tasksFailed,
        summary: runSummary,
        startedAtIso: run.startedAt,
      })) ?? run;

    let reasoning: {
      cycle: ReasoningCycleRecord;
      proposals: NextActionProposalRecord[];
    } | null = null;

    if (params.autoRunReasoning) {
      try {
        reasoning = await runContinuousReasoningForGoal({
          userId: params.userId,
          goalId: initialGoal.id,
          triggerSource: 'post_cycle',
        });
      } catch (reasoningErr) {
        const safeReasoningErr =
          reasoningErr instanceof Error
            ? redactSecretsFromText(reasoningErr.message)
            : 'Post-cycle AI reasoning unavailable.';
        await appendActionLog({
          userId: params.userId,
          workspaceId,
          goalId: initialGoal.id,
          taskId: null,
          executionProvider: 'continuous_reasoning_engine',
          actionType: 'orchestrator:post_cycle_reasoning_skipped',
          status: 'blocked',
          resultSummary: `Execution wave completed cleanly; post-cycle AI reasoning deferred: ${safeReasoningErr}`,
          evidence: { runId: finishedRun.id },
          errorMessage: safeReasoningErr,
        }).catch(() => {});
      }
    }

    const finalGoal =
      (await getGoalByIdForUser(initialGoal.id, params.userId)) ??
      refreshedGoalBeforeFinish;

    return {
      run: finishedRun,
      goal: finalGoal,
      tasks: latestTasks,
      metrics: progress.metrics,
      reasoning,
    };
  } catch (cycleError) {
    const safeMsg =
      cycleError instanceof Error
        ? redactSecretsFromText(cycleError.message)
        : 'Unexpected orchestrator cycle failure.';
    await finishExecutionRun({
      runId: run.id,
      userId: params.userId,
      status: 'failed',
      tasksDispatched,
      tasksSucceeded,
      tasksFailed: Math.max(1, tasksFailed),
      summary: `Orchestrator cycle aborted safely: ${safeMsg}`,
      startedAtIso: run.startedAt,
    }).catch(() => {});

    const g = await getGoalByIdForUser(initialGoal.id, params.userId).catch(
      () => null
    );
    if (g && g.executionState === 'running') {
      await updateGoalForUser({
        goalId: g.id,
        userId: params.userId,
        executionState: 'idle',
      }).catch(() => {});
    }
    throw cycleError;
  }
}

/**
 * Pause, resume, or cancel autonomous execution for a goal.
 */
export async function controlGoalExecution(params: {
  userId: string;
  goalId: string;
  action: 'pause' | 'resume' | 'cancel';
}): Promise<GoalRecord | null> {
  const goal = await getGoalByIdForUser(params.goalId, params.userId);
  if (!goal) return null;

  const workspaceId =
    goal.workspaceId ??
    (await ensureDefaultWorkspaceForUser(params.userId)).id;

  let updated: GoalRecord | null = null;
  if (params.action === 'pause') {
    updated = await updateGoalForUser({
      goalId: goal.id,
      userId: params.userId,
      executionState: 'paused',
    });
  } else if (params.action === 'resume') {
    updated = await updateGoalForUser({
      goalId: goal.id,
      userId: params.userId,
      status: goal.status === 'completed' ? 'completed' : 'active',
      executionState: goal.status === 'completed' ? 'completed' : 'idle',
    });
  } else if (params.action === 'cancel') {
    updated = await updateGoalForUser({
      goalId: goal.id,
      userId: params.userId,
      status: goal.status === 'completed' ? 'completed' : 'planning',
      executionState: 'cancelled',
    });
  }

  await appendActionLog({
    userId: params.userId,
    workspaceId,
    goalId: goal.id,
    taskId: null,
    executionProvider: 'execution_orchestrator',
    actionType: `orchestrator:${params.action}`,
    status: params.action === 'cancel' ? 'rejected' : 'proposed',
    resultSummary: `User triggered "${params.action}" on goal execution state.`,
    evidence: {
      action: params.action,
      previousExecutionState: goal.executionState,
      nextExecutionState: updated?.executionState ?? goal.executionState,
    },
    errorMessage: null,
  });

  return updated;
}

/**
 * Manual recovery / retry for a failed, blocked, or backoff-delayed task.
 * Clears `nextRetryAt`, bumps retry budget if exhausted, and preserves Approval Gate enforcement.
 */
export async function retryTaskManually(params: {
  userId: string;
  taskId: string;
  confirmExternalNotExecuted?: boolean;
}): Promise<TaskRecord | null> {
  const updated = await requeueTaskSafely({
    taskId: params.taskId,
    userId: params.userId,
    bumpRetryBudget: true,
    confirmExternalNotExecuted: params.confirmExternalNotExecuted,
  });
  if (!updated) return null;

  await appendActionLog({
    userId: params.userId,
    workspaceId: updated.workspaceId,
    goalId: updated.goalId,
    taskId: updated.id,
    executionProvider: 'execution_orchestrator',
    actionType: 'orchestrator:manual_retry',
    status: updated.status === 'approved' ? 'approved' : 'queued',
    resultSummary:
      'Manual retry requested: cleared backoff timer and re-queued task with all safety gates intact.',
    evidence: {
      retryCount: updated.retryCount,
      maxRetries: updated.maxRetries,
      approvalRequired: updated.approvalRequired,
      approvalStatus: updated.approvalStatus,
      confirmExternalNotExecuted: Boolean(params.confirmExternalNotExecuted),
    },
    errorMessage: null,
  });

  return updated;
}

/**
 * Safely reconciles an external task quarantined in `reconciliation_required` after an uncertain
 * timeout, crash, or server restart so external actions are never blindly repeated.
 */
export async function reconcileUncertainTask(params: {
  userId: string;
  taskId: string;
  resolution:
    | 'reconcile_from_evidence'
    | 'mark_dispatched_pending_verification'
    | 'confirm_not_executed_requeue';
  notes?: string;
}): Promise<{
  task: TaskRecord;
  reconciledStatus: TaskStatus;
  message: string;
}> {
  const task = await getTaskByIdForUser(params.taskId, params.userId);
  if (!task) {
    throw new Error('Task not found or access denied.');
  }

  const workspaceId =
    task.workspaceId ?? (await ensureDefaultWorkspaceForUser(params.userId)).id;
  const cleanNotes = params.notes?.trim() || 'Operator reconciliation recorded.';

  if (params.resolution === 'reconcile_from_evidence') {
    const correlated = await findCorrelatedExternalOutcomeForTask({
      userId: params.userId,
      workspaceId,
      goalId: task.goalId,
      taskId: task.id,
    });
    if (!correlated) {
      throw new Error(
        'No correlated external outcome evidence found for this task yet. Ingest or submit outcome evidence first, or choose another reconciliation resolution.'
      );
    }

    const message = `Reconciled uncertain task from correlated evidence (${correlated.evidence.evidenceType}) -> ${correlated.matchedState}. ${cleanNotes}`;
    const updated = await updateTaskAfterWorkerCheckOrRun({
      taskId: task.id,
      userId: params.userId,
      status: correlated.matchedState,
      verificationStatus: correlated.matchedState,
      statusReason: message,
      reconciliationRequired: false,
      nextRetryAt: null,
      completedAt: new Date(),
      verifiedAt:
        correlated.matchedState === 'verified' ? new Date() : undefined,
    });
    if (!updated) {
      throw new Error('Failed to persist reconciled task state.');
    }

    await appendActionLog({
      userId: params.userId,
      workspaceId,
      goalId: task.goalId,
      taskId: task.id,
      executionProvider: 'execution_orchestrator',
      actionType: 'orchestrator:task_reconciled',
      status: correlated.matchedState,
      resultSummary: message,
      evidence: {
        resolution: params.resolution,
        evidenceId: correlated.evidence.id,
        notes: cleanNotes,
      },
      errorMessage: null,
    });

    await recalculateAndPersistGoalProgress({
      userId: params.userId,
      goalId: task.goalId,
    });

    return {
      task: updated,
      reconciledStatus: updated.status,
      message,
    };
  }

  if (params.resolution === 'mark_dispatched_pending_verification') {
    const message = `Operator confirmed external dispatch occurred (${cleanNotes}); moved to pending_verification without re-sending.`;
    const updated = await updateTaskAfterWorkerCheckOrRun({
      taskId: task.id,
      userId: params.userId,
      status: 'pending_verification',
      verificationStatus: 'pending_verification',
      statusReason: message,
      reconciliationRequired: false,
      nextRetryAt: null,
      completedAt: new Date(),
    });
    if (!updated) {
      throw new Error('Failed to persist reconciled task state.');
    }

    await appendActionLog({
      userId: params.userId,
      workspaceId,
      goalId: task.goalId,
      taskId: task.id,
      executionProvider: 'execution_orchestrator',
      actionType: 'orchestrator:task_reconciled',
      status: 'pending_verification',
      resultSummary: message,
      evidence: {
        resolution: params.resolution,
        notes: cleanNotes,
      },
      errorMessage: null,
    });

    await recalculateAndPersistGoalProgress({
      userId: params.userId,
      goalId: task.goalId,
    });

    return {
      task: updated,
      reconciledStatus: updated.status,
      message,
    };
  }

  // confirm_not_executed_requeue
  const requeued = await requeueTaskSafely({
    taskId: task.id,
    userId: params.userId,
    bumpRetryBudget: true,
    confirmExternalNotExecuted: true,
  });
  if (!requeued) {
    throw new Error('Failed to requeue reconciled task.');
  }

  const message = `Operator confirmed external action did NOT execute (${cleanNotes}); cleared reconciliation lock and re-queued safely.`;
  await appendActionLog({
    userId: params.userId,
    workspaceId,
    goalId: task.goalId,
    taskId: task.id,
    executionProvider: 'execution_orchestrator',
    actionType: 'orchestrator:task_reconciled_requeue',
    status: requeued.status === 'approved' ? 'approved' : 'queued',
    resultSummary: message,
    evidence: {
      resolution: params.resolution,
      notes: cleanNotes,
    },
    errorMessage: null,
  });

  return {
    task: requeued,
    reconciledStatus: requeued.status,
    message,
  };
}

/**
 * Inbound Evidence Collection & Outcome Verification Pipeline (`POST /api/webhooks/inbound/:workspaceId`).
 * Enforces constant-time HMAC-SHA256 verification over raw bytes, 300s replay window,
 * strict workspace/tenant ownership isolation, idempotent deduplication, and 6-class Evidence Trust Architecture.
 */
export async function ingestSignedInboundEvidence(params: {
  workspaceId: string;
  rawBody: string;
  parsedBody: unknown;
  signatureHeader: string | undefined;
  providerSignatureHeader?: string | undefined;
  timestampHeader?: string | undefined;
  nowMs?: number;
}): Promise<{
  httpStatus: number;
  body: Record<string, unknown>;
}> {
  const secretConfig = await getWorkspaceInboundSecretForServer(
    params.workspaceId
  );
  if (!secretConfig || !secretConfig.enabled) {
    return {
      httpStatus: 401,
      body: {
        error:
          'Inbound webhook signing secret is not configured or enabled for this workspace.',
      },
    };
  }

  const authCheck = verifyInboundWebhookAuth({
    signingSecret: secretConfig.signingSecret,
    rawBody: params.rawBody,
    signatureHeader: params.signatureHeader,
    timestampHeader: params.timestampHeader,
    nowMs: params.nowMs,
  });

  if (!authCheck.valid) {
    return {
      httpStatus: 401,
      body: {
        error: authCheck.error,
        code: authCheck.code,
      },
    };
  }

  const validation = validateInboundEvidencePayload(
    params.parsedBody,
    params.nowMs ? new Date(params.nowMs) : new Date()
  );
  if (!validation.valid) {
    return {
      httpStatus: 400,
      body: {
        error: validation.error,
      },
    };
  }

  const data = validation.data;
  const ownerUserId = secretConfig.workspaceOwnerUserId;

  let associatedTask: TaskRecord | null = null;
  if (data.taskId) {
    const taskCandidate = await getTaskByIdForUser(data.taskId, ownerUserId);
    if (!taskCandidate || taskCandidate.workspaceId !== params.workspaceId) {
      return {
        httpStatus: 403,
        body: {
          error:
            'Referenced taskId does not belong to this workspace (cross-workspace isolation enforced).',
        },
      };
    }
    associatedTask = taskCandidate;
  }

  const effectiveGoalId = data.goalId ?? associatedTask?.goalId ?? null;
  if (!effectiveGoalId) {
    return {
      httpStatus: 400,
      body: {
        error: 'Inbound evidence must resolve to a valid workspace goalId.',
      },
    };
  }

  const associatedGoal = await getGoalByIdForUser(effectiveGoalId, ownerUserId);
  if (!associatedGoal || associatedGoal.workspaceId !== params.workspaceId) {
    return {
      httpStatus: 403,
      body: {
        error:
          'Referenced goalId does not belong to this workspace (cross-workspace isolation enforced).',
      },
    };
  }

  if (associatedTask && associatedTask.goalId !== associatedGoal.id) {
    return {
      httpStatus: 400,
      body: {
        error: 'Referenced taskId does not belong to the specified goalId.',
      },
    };
  }

  // Idempotent duplicate protection enforced at DB level
  const dedup = await insertInboundEventDeduped({
    workspaceId: params.workspaceId,
    goalId: associatedGoal.id,
    taskId: associatedTask?.id ?? null,
    provider: data.provider,
    externalEventId: data.externalEventId,
    idempotencyKey: data.idempotencyKey,
    evidenceType: data.evidenceType,
    eventTimestamp: data.observedAt,
    signatureVerified: true,
    processingStatus: 'processed',
    rawPayload: params.parsedBody as Record<string, unknown>,
  });

  if (dedup.duplicate) {
    return {
      httpStatus: 200,
      body: {
        accepted: true,
        duplicate: true,
        inboundEventId: dedup.existingInboundEventId,
        message:
          'Duplicate external event ignored idempotently; outcome metrics were not double-counted.',
      },
    };
  }

  // Verify whether this workspace actually has an enabled & verified integration for `data.provider`,
  // and optionally verify an independent provider-specific HMAC header (`X-TaskAI-Provider-Signature`).
  const workspaceIntegrations = await listIntegrationsByUser(
    ownerUserId,
    params.workspaceId
  );
  const matchingVerifiedIntegrations = workspaceIntegrations.filter(
    (i) => i.enabled && i.verified && i.providerKey === data.provider
  );
  const verifiedWorkspaceIntegrationPresent =
    matchingVerifiedIntegrations.length > 0;

  let providerSignatureVerified = false;
  if (
    params.providerSignatureHeader &&
    matchingVerifiedIntegrations.length > 0
  ) {
    for (const candidate of matchingVerifiedIntegrations) {
      const execInt = await getExecutableIntegrationForServer(
        candidate.id,
        ownerUserId,
        params.workspaceId
      );
      if (
        execInt?.encryptedSecret &&
        execInt.secretIv &&
        execInt.secretAuthTag
      ) {
        try {
          const dec = decryptIntegrationSecretDetailed({
            ciphertextBase64: execInt.encryptedSecret,
            ivBase64: execInt.secretIv,
            authTagBase64: execInt.secretAuthTag,
          });
          const provCheck = verifyInboundWebhookAuth({
            signingSecret: dec.plaintext,
            rawBody: params.rawBody,
            signatureHeader: params.providerSignatureHeader,
            timestampHeader: String(authCheck.timestampSec),
            nowMs: params.nowMs,
          });
          if (provCheck.valid) {
            providerSignatureVerified = true;
            break;
          }
        } catch {
          // Try next integration if secret format differs
        }
      }
    }
  }

  const hasConflict = await detectAndQuarantineConflictingReference({
    userId: ownerUserId,
    workspaceId: params.workspaceId,
    goalId: associatedGoal.id,
    evidenceType: data.evidenceType,
    externalReferenceId: data.externalReferenceId,
    newStructuredMetrics: data.structuredMetrics,
  });

  const evalOutcome = evaluateEvidenceVerification({
    sourceType: 'inbound_webhook',
    provider: data.provider,
    signatureVerified: true,
    providerSignatureVerified,
    verifiedWorkspaceIntegrationPresent,
    evidenceType: data.evidenceType,
    externalEventId: data.externalEventId,
    externalReferenceId: data.externalReferenceId,
    requiresHumanReview: data.requiresHumanReview,
    hasConflict,
    structuredMetrics: data.structuredMetrics,
    associatedTask,
  });

  const evidence = await createOutcomeEvidenceRecord({
    userId: ownerUserId,
    workspaceId: params.workspaceId,
    goalId: associatedGoal.id,
    taskId: associatedTask?.id ?? null,
    inboundEventId: dedup.inboundEventId,
    sourceType: 'inbound_webhook',
    provider: data.provider,
    evidenceType: data.evidenceType,
    externalReferenceId: data.externalReferenceId,
    summary: data.summary,
    structuredMetrics: data.structuredMetrics,
    rawPayload: params.parsedBody as Record<string, unknown>,
    provenanceClass: evalOutcome.provenanceClass,
    trustTier: evalOutcome.trustTier,
    hasConflict,
    requiresHumanReview: evalOutcome.requiresHumanReview,
    verificationState: evalOutcome.verificationState,
    observedAt: data.observedAt,
  });

  const verification = await createVerificationDecisionRecord({
    userId: ownerUserId,
    workspaceId: params.workspaceId,
    goalId: associatedGoal.id,
    taskId: associatedTask?.id ?? null,
    evidenceId: evidence.id,
    verificationMethod: evalOutcome.verificationMethod,
    decision: evalOutcome.decision,
    reviewerIdentity: `webhook:${data.provider}`,
    notes: evalOutcome.notes,
    traceMetadata: {
      inboundEventId: dedup.inboundEventId,
      externalEventId: data.externalEventId,
      externalReferenceId: data.externalReferenceId,
      evidenceType: data.evidenceType,
      provenanceClass: evalOutcome.provenanceClass,
      trustTier: evalOutcome.trustTier,
      providerSignatureVerified,
      verifiedWorkspaceIntegrationPresent,
      hasConflict,
    },
  });

  let updatedTask: TaskRecord | null = associatedTask;
  if (associatedTask && evalOutcome.taskNextStatus) {
    updatedTask = await updateTaskAfterWorkerCheckOrRun({
      taskId: associatedTask.id,
      userId: ownerUserId,
      status: evalOutcome.taskNextStatus,
      verificationStatus: evalOutcome.verificationState,
      statusReason: evalOutcome.notes,
      reconciliationRequired:
        evalOutcome.taskNextStatus === 'verified' ||
        evalOutcome.taskNextStatus === 'pending_verification'
          ? false
          : undefined,
      verifiedAt:
        evalOutcome.verificationState === 'verified' ? new Date() : undefined,
    });
  }

  await appendActionLog({
    userId: ownerUserId,
    workspaceId: params.workspaceId,
    goalId: associatedGoal.id,
    taskId: associatedTask?.id ?? null,
    executionProvider: `inbound_webhook:${data.provider}`,
    actionType: `evidence:${data.evidenceType}`,
    status:
      evalOutcome.verificationState === 'verified'
        ? 'verified'
        : evalOutcome.verificationState === 'rejected'
          ? 'rejected'
          : 'pending_verification',
    resultSummary: `${data.summary} — ${evalOutcome.notes}`,
    evidence: {
      evidenceId: evidence.id,
      inboundEventId: dedup.inboundEventId,
      externalEventId: data.externalEventId,
      externalReferenceId: data.externalReferenceId,
      provenanceClass: evalOutcome.provenanceClass,
      trustTier: evalOutcome.trustTier,
      hasConflict,
      verificationState: evalOutcome.verificationState,
      structuredMetrics: data.structuredMetrics,
    },
    errorMessage: null,
  });

  const goalProgress = await recalculateAndPersistGoalProgress({
    userId: ownerUserId,
    goalId: associatedGoal.id,
  });

  return {
    httpStatus: 200,
    body: {
      accepted: true,
      duplicate: false,
      inboundEventId: dedup.inboundEventId,
      evidence,
      verification,
      task: updatedTask,
      goalProgress: {
        progressPercent: goalProgress.progressPercent,
        isGoalAchieved: goalProgress.isGoalAchieved,
        goalStatus: goalProgress.goal?.status ?? associatedGoal.status,
      },
    },
  };
}

/**
 * Authenticated manual outcome evidence submission (always enters `pending_verification`
 * as `unverified_claim` / `untrusted` with `requiresHumanReview: true`).
 */
export async function submitManualWorkspaceEvidence(params: {
  userId: string;
  workspaceId: string;
  goalId: string;
  taskId?: string | null;
  provider?: string;
  evidenceType: EvidenceType;
  summary: string;
  externalReferenceId?: string | null;
  structuredMetrics?: Record<string, unknown>;
}): Promise<{
  evidence: OutcomeEvidenceRecord;
  verification: VerificationDecisionRecord;
  goalProgress: {
    progressPercent: number;
    isGoalAchieved: boolean;
  };
}> {
  const ws = await getWorkspaceByIdForUser(params.workspaceId, params.userId);
  if (!ws) {
    throw new Error('Workspace not found or access denied.');
  }

  if (
    !VALID_EVIDENCE_TYPES.has(params.evidenceType) ||
    params.evidenceType === 'diagnostic_checksum'
  ) {
    throw new Error('Invalid external evidenceType.');
  }

  const goal = await getGoalByIdForUser(params.goalId, params.userId);
  if (!goal || goal.workspaceId !== params.workspaceId) {
    throw new Error('Goal not found in this workspace.');
  }

  let associatedTask: TaskRecord | null = null;
  if (params.taskId) {
    const t = await getTaskByIdForUser(params.taskId, params.userId);
    if (!t || t.workspaceId !== params.workspaceId || t.goalId !== goal.id) {
      throw new Error('Task not found in this workspace goal.');
    }
    associatedTask = t;
  }

  const summary = params.summary.trim();
  if (!summary) {
    throw new Error('Evidence summary is required.');
  }

  const cleanRef = params.externalReferenceId?.trim() || null;
  const cleanMetrics = params.structuredMetrics ?? {};

  const hasConflict = await detectAndQuarantineConflictingReference({
    userId: params.userId,
    workspaceId: params.workspaceId,
    goalId: goal.id,
    evidenceType: params.evidenceType,
    externalReferenceId: cleanRef,
    newStructuredMetrics: cleanMetrics,
  });

  const evalOutcome = evaluateEvidenceVerification({
    sourceType: 'manual_submission',
    signatureVerified: false,
    evidenceType: params.evidenceType,
    externalReferenceId: cleanRef,
    requiresHumanReview: true,
    hasConflict,
    structuredMetrics: cleanMetrics,
    associatedTask,
  });

  const evidence = await createOutcomeEvidenceRecord({
    userId: params.userId,
    workspaceId: params.workspaceId,
    goalId: goal.id,
    taskId: associatedTask?.id ?? null,
    inboundEventId: null,
    sourceType: 'manual_submission',
    provider: params.provider?.trim() || 'manual_workspace_entry',
    evidenceType: params.evidenceType,
    externalReferenceId: cleanRef,
    summary,
    structuredMetrics: cleanMetrics,
    rawPayload: {
      summary,
      externalReferenceId: cleanRef,
      structuredMetrics: cleanMetrics,
    },
    provenanceClass: evalOutcome.provenanceClass,
    trustTier: evalOutcome.trustTier,
    hasConflict,
    requiresHumanReview: true,
    verificationState: evalOutcome.verificationState,
    observedAt: new Date(),
  });

  const verification = await createVerificationDecisionRecord({
    userId: params.userId,
    workspaceId: params.workspaceId,
    goalId: goal.id,
    taskId: associatedTask?.id ?? null,
    evidenceId: evidence.id,
    verificationMethod: evalOutcome.verificationMethod,
    decision: evalOutcome.decision,
    reviewerIdentity: 'system:human_review_gate',
    notes: evalOutcome.notes,
    traceMetadata: {
      sourceType: 'manual_submission',
      provenanceClass: evalOutcome.provenanceClass,
      trustTier: evalOutcome.trustTier,
      hasConflict,
    },
  });

  if (associatedTask && evalOutcome.taskNextStatus) {
    await updateTaskAfterWorkerCheckOrRun({
      taskId: associatedTask.id,
      userId: params.userId,
      status: evalOutcome.taskNextStatus,
      verificationStatus: evalOutcome.verificationState,
      statusReason: evalOutcome.notes,
    });
  }

  await appendActionLog({
    userId: params.userId,
    workspaceId: params.workspaceId,
    goalId: goal.id,
    taskId: associatedTask?.id ?? null,
    executionProvider: 'manual_evidence_submission',
    actionType: `evidence:${params.evidenceType}`,
    status:
      evalOutcome.verificationState === 'rejected'
        ? 'rejected'
        : 'pending_verification',
    resultSummary: `${summary} — ${evalOutcome.notes}`,
    evidence: {
      evidenceId: evidence.id,
      provenanceClass: evalOutcome.provenanceClass,
      trustTier: evalOutcome.trustTier,
      hasConflict,
      verificationState: evalOutcome.verificationState,
    },
    errorMessage: null,
  });

  const goalProgress = await recalculateAndPersistGoalProgress({
    userId: params.userId,
    goalId: goal.id,
  });

  return {
    evidence,
    verification,
    goalProgress: {
      progressPercent: goalProgress.progressPercent,
      isGoalAchieved: goalProgress.isGoalAchieved,
    },
  };
}

/**
 * Mode 3: Human Verification Review.
 * Promotes reviewed outcome evidence to `human_confirmed` (`human_verified`) or `rejected`.
 */
export async function reviewOutcomeEvidenceByHuman(params: {
  userId: string;
  evidenceId: string;
  reviewerEmail: string;
  decision: 'verified' | 'rejected';
  notes: string;
}): Promise<{
  evidence: OutcomeEvidenceRecord;
  verification: VerificationDecisionRecord;
  goalProgress: {
    goal: GoalRecord | null;
    progressPercent: number;
    isGoalAchieved: boolean;
  };
}> {
  const cleanNotes = params.notes.trim();
  if (cleanNotes.length < 3) {
    throw new Error(
      'Reviewer notes (at least 3 characters) are required to approve or reject outcome evidence.'
    );
  }

  const existing = await getOutcomeEvidenceByIdForUser(
    params.evidenceId,
    params.userId
  );
  if (!existing) {
    throw new Error('Outcome evidence record not found or access denied.');
  }

  if (existing.provenanceClass === 'internal_diagnostic') {
    throw new Error(
      'Internal SHA-256 diagnostic checksums cannot be promoted to external business outcomes.'
    );
  }

  let associatedTask: TaskRecord | null = null;
  if (existing.taskId) {
    associatedTask = await getTaskByIdForUser(existing.taskId, params.userId);
    if (
      associatedTask &&
      associatedTask.approvalRequired &&
      associatedTask.approvalStatus !== 'approved' &&
      params.decision === 'verified'
    ) {
      throw new Error(
        'Cannot verify outcome for an unapproved consequential task. Approve the task in the Approval Gate first.'
      );
    }
  }

  const updatedEvidence = await updateOutcomeEvidenceVerificationState({
    evidenceId: existing.id,
    userId: params.userId,
    verificationState: params.decision,
    provenanceClass:
      params.decision === 'verified'
        ? 'human_confirmed'
        : existing.provenanceClass,
    trustTier:
      params.decision === 'verified' ? 'human_verified' : existing.trustTier,
    hasConflict: false,
    requiresHumanReview: false,
  });
  if (!updatedEvidence) {
    throw new Error('Failed to update outcome evidence state.');
  }

  const verification = await createVerificationDecisionRecord({
    userId: params.userId,
    workspaceId: existing.workspaceId,
    goalId: existing.goalId,
    taskId: existing.taskId,
    evidenceId: existing.id,
    verificationMethod: 'human_review',
    decision: params.decision,
    reviewerIdentity: params.reviewerEmail,
    notes: cleanNotes,
    traceMetadata: {
      previousState: existing.verificationState,
      previousProvenance: existing.provenanceClass,
      newProvenance: updatedEvidence.provenanceClass,
      reviewedByUserId: params.userId,
    },
  });

  if (associatedTask) {
    const nextTaskStatus: TaskStatus =
      params.decision === 'verified'
        ? existing.evidenceType === 'outcome_reversal'
          ? 'pending_verification'
          : 'verified'
        : 'rejected';

    await updateTaskAfterWorkerCheckOrRun({
      taskId: associatedTask.id,
      userId: params.userId,
      status: nextTaskStatus,
      verificationStatus:
        nextTaskStatus === 'verified'
          ? 'verified'
          : nextTaskStatus === 'pending_verification'
            ? 'pending_verification'
            : 'rejected',
      statusReason: `Human verification (${params.reviewerEmail}): ${cleanNotes}`,
      reconciliationRequired: false,
      verifiedAt: nextTaskStatus === 'verified' ? new Date() : null,
    });
  }

  await appendActionLog({
    userId: params.userId,
    workspaceId: existing.workspaceId,
    goalId: existing.goalId,
    taskId: existing.taskId ?? null,
    executionProvider: `human_reviewer:${params.reviewerEmail}`,
    actionType: `human_verification:${params.decision}`,
    status: params.decision === 'verified' ? 'verified' : 'rejected',
    resultSummary: `Human reviewer (${params.reviewerEmail}) marked evidence "${existing.summary}" as ${params.decision} (human_confirmed): ${cleanNotes}`,
    evidence: {
      evidenceId: existing.id,
      verificationId: verification.id,
      decision: params.decision,
      provenanceClass: updatedEvidence.provenanceClass,
      trustTier: updatedEvidence.trustTier,
      notes: cleanNotes,
    },
    errorMessage: null,
  });

  const goalProgress = await recalculateAndPersistGoalProgress({
    userId: params.userId,
    goalId: existing.goalId,
  });

  return {
    evidence: updatedEvidence,
    verification,
    goalProgress: {
      goal: goalProgress.goal,
      progressPercent: goalProgress.progressPercent,
      isGoalAchieved: goalProgress.isGoalAchieved,
    },
  };
}

/**
 * Mode 4: AI-Assisted Evidence Consistency Analysis (Advisory Only — `ai_assessed` / `advisory`).
 * Records `recommended_verify` or `recommended_reject` in `verification_records` without
 * ever promoting unverified evidence to `verified` on its own.
 */
export async function runAiAssistedVerificationOnEvidence(params: {
  userId: string;
  evidenceId: string;
}): Promise<{
  verification: VerificationDecisionRecord;
  recommendation: 'recommended_verify' | 'recommended_reject';
  confidenceLevel: 'low' | 'medium' | 'high';
  consistencyFlags: string[];
}> {
  const evidence = await getOutcomeEvidenceByIdForUser(
    params.evidenceId,
    params.userId
  );
  if (!evidence) {
    throw new Error('Outcome evidence record not found or access denied.');
  }

  const goal = await getGoalByIdForUser(evidence.goalId, params.userId);
  if (!goal) {
    throw new Error('Parent goal not found.');
  }

  const task = evidence.taskId
    ? await getTaskByIdForUser(evidence.taskId, params.userId)
    : null;

  const analysis = await analyzeEvidenceWithGemini({
    goalProblem: goal.problem,
    goalTargetMetric: goal.targetMetric,
    taskDescription: task?.description ?? null,
    taskVerificationCriteria: task?.verificationMethod ?? null,
    evidence,
  });

  // Transition pending uncorroborated claims (`unverified_claim` or `authenticated_webhook`) to `ai_assessed` (`advisory`)
  // while strictly keeping `pending_verification` (never mutating verified/provider_confirmed/human_confirmed/internal_diagnostic)
  if (
    evidence.verificationState === 'pending_verification' &&
    (evidence.provenanceClass === 'unverified_claim' ||
      evidence.provenanceClass === 'authenticated_webhook')
  ) {
    await updateOutcomeEvidenceVerificationState({
      evidenceId: evidence.id,
      userId: params.userId,
      verificationState: 'pending_verification',
      provenanceClass: 'ai_assessed',
      trustTier: 'advisory',
    });
  }

  const verification = await createVerificationDecisionRecord({
    userId: params.userId,
    workspaceId: evidence.workspaceId,
    goalId: evidence.goalId,
    taskId: evidence.taskId,
    evidenceId: evidence.id,
    verificationMethod: 'ai_assisted_recommendation',
    decision: analysis.recommendation,
    reviewerIdentity: `ai_auditor:${analysis.modelUsed}`,
    notes: analysis.reasoningNotes,
    traceMetadata: {
      advisoryOnly: true,
      previousProvenanceClass: evidence.provenanceClass,
      provenanceClass: 'ai_assessed',
      trustTier: 'advisory',
      confidenceLevel: analysis.confidenceLevel,
      consistencyFlags: analysis.consistencyFlags,
    },
  });

  return {
    verification,
    recommendation: analysis.recommendation,
    confidenceLevel: analysis.confidenceLevel,
    consistencyFlags: analysis.consistencyFlags,
  };
}

/**
 * Continuous AI Reasoning Engine orchestration.
 */
export async function runContinuousReasoningForGoal(params: {
  userId: string;
  goalId: string;
  triggerSource?: ReasoningCycleRecord['triggerSource'];
}): Promise<{
  cycle: ReasoningCycleRecord;
  proposals: NextActionProposalRecord[];
}> {
  const goal = await getGoalByIdForUser(params.goalId, params.userId);
  if (!goal) {
    throw new Error('Goal not found or access denied.');
  }

  const workspaceId =
    goal.workspaceId ??
    (await ensureDefaultWorkspaceForUser(params.userId)).id;

  const progress = await recalculateAndPersistGoalProgress({
    userId: params.userId,
    goalId: goal.id,
  });

  const [goalTasks, recentAttempts, recentEvidence, workspaceIntegrations] =
    await Promise.all([
      listTasksByUser(params.userId, goal.id, workspaceId),
      listTaskAttemptsByWorkspace({
        userId: params.userId,
        workspaceId,
        goalId: goal.id,
      }),
      listOutcomeEvidenceByWorkspace({
        userId: params.userId,
        workspaceId,
        goalId: goal.id,
      }),
      listIntegrationsByUser(params.userId, workspaceId),
    ]);

  const verifiedCapabilities = collectVerifiedWorkspaceCapabilities(
    workspaceIntegrations
  );
  const preferredExternal =
    workspaceIntegrations.find((i) => i.enabled && i.verified)?.providerKey ??
    null;

  const llmAnalysis = await analyzeExecutionCycleWithGemini({
    goal: progress.goal ?? goal,
    tasks: goalTasks,
    metrics: progress.metrics,
    recentAttempts,
    recentEvidence,
    verifiedCapabilities,
    preferredExternalProvider: preferredExternal,
  });

  const saved = await saveReasoningCycleWithProposals({
    userId: params.userId,
    workspaceId,
    goalId: goal.id,
    triggerSource: params.triggerSource ?? 'manual',
    modelUsed: llmAnalysis.modelUsed,
    currentAssessment: llmAnalysis.currentAssessment,
    goalAchievedRecommendation: llmAnalysis.goalAchievedRecommendation,
    humanInterventionRequired: llmAnalysis.humanInterventionRequired,
    confidenceLevel: llmAnalysis.confidenceLevel,
    reasoningSummary: llmAnalysis.reasoningSummary,
    findings: llmAnalysis.findings,
    recommendedNextActions: llmAnalysis.recommendedNextActions,
    structuredOutput: {
      findings: llmAnalysis.findings,
      recommendedNextActions: llmAnalysis.recommendedNextActions,
      progressPercent: progress.progressPercent,
      isGoalAchieved: progress.isGoalAchieved,
    },
    proposals: llmAnalysis.proposals,
  });

  await appendActionLog({
    userId: params.userId,
    workspaceId,
    goalId: goal.id,
    taskId: null,
    executionProvider: `continuous_reasoning:${llmAnalysis.modelUsed}`,
    actionType: 'ai_reasoning:cycle_evaluation',
    status: 'proposed',
    resultSummary: `${llmAnalysis.currentAssessment} (${saved.proposals.length} next-action proposal(s) generated).`,
    evidence: {
      reasoningCycleId: saved.cycle.id,
      confidenceLevel: saved.cycle.confidenceLevel,
      humanInterventionRequired: saved.cycle.humanInterventionRequired,
      proposalCount: saved.proposals.length,
    },
    errorMessage: null,
  });

  return saved;
}

/**
 * Accepts or rejects a Next-Action Proposal generated by the Continuous AI Reasoning Engine.
 * Enforces atomic single-winner claiming, prevents enqueuing non-executable `human_intervention`
 * guidance as webhook tasks, and ensures consequential proposals ALWAYS enter the Approval Gate.
 */
export async function decideNextActionProposal(params: {
  userId: string;
  proposalId: string;
  decision: 'accept' | 'reject';
}): Promise<{
  proposal: NextActionProposalRecord;
  enqueuedTask: TaskRecord | null;
}> {
  const existing = await getProposalByIdForUser(
    params.proposalId,
    params.userId
  );
  if (!existing) {
    throw new Error('Next-action proposal not found or access denied.');
  }

  if (existing.status !== 'proposed') {
    throw new Error(`Proposal was already ${existing.status}.`);
  }

  const claimed = await claimProposalForDecisionAtomically({
    proposalId: existing.id,
    userId: params.userId,
    nextStatus: params.decision === 'reject' ? 'rejected' : 'enqueued',
  });

  if (!claimed) {
    throw new Error('Proposal was already decided by a concurrent request.');
  }

  if (params.decision === 'reject') {
    return { proposal: claimed, enqueuedTask: null };
  }

  // Human intervention advisories record operator acknowledgement without fabricating a runnable task
  if (claimed.proposalType === 'human_intervention') {
    await appendActionLog({
      userId: params.userId,
      workspaceId: claimed.workspaceId,
      goalId: claimed.goalId,
      taskId: claimed.targetTaskId,
      executionProvider: 'execution_orchestrator',
      actionType: 'ai_proposal:human_intervention_acknowledged',
      status: 'proposed',
      resultSummary: `Operator acknowledged human intervention proposal: "${claimed.title}"`,
      evidence: {
        proposalId: claimed.id,
        description: claimed.description,
        targetTaskId: claimed.targetTaskId,
      },
      errorMessage: null,
    });
    return { proposal: claimed, enqueuedTask: null };
  }

  // Accept: if retry_task targeting an existing task, safely re-queue it (preserving Approval & Reconciliation Gates)
  if (claimed.proposalType === 'retry_task' && claimed.targetTaskId) {
    const retried = await retryTaskManually({
      userId: params.userId,
      taskId: claimed.targetTaskId,
    });
    if (retried) {
      const decided = await markProposalDecided({
        proposalId: claimed.id,
        userId: params.userId,
        status: 'enqueued',
        enqueuedTaskId: retried.id,
      });
      return {
        proposal: decided ?? claimed,
        enqueuedTask: retried,
      };
    }
  }

  const tool = normalizeToolId(claimed.proposedTool);
  const actionCategory = normalizeActionCategory(claimed.actionCategory, tool);
  const requiredCapabilities = normalizeCapabilities(
    claimed.requiredCapabilities,
    tool,
    actionCategory
  );
  const approvalRequired = detectRequiresApproval({
    tool,
    actionCategory,
    description: claimed.description,
    requiredCapabilities,
    llmFlaggedApproval: claimed.approvalRequired,
  });

  const proposedActionDetails: ProposedActionDetails | null = approvalRequired
    ? {
        proposedAction: claimed.title,
        targetRecipient: 'Configured workspace execution target',
        estimatedCost: '$0.00 direct platform fee',
        explanation:
          'Generated by Continuous AI Reasoning Engine. Consequential actions require explicit human approval in the Approval Gate before execution.',
      }
    : null;

  const createdTask = await createSingleTaskForGoal({
    userId: params.userId,
    goalId: claimed.goalId,
    description: claimed.description,
    tool,
    requiredCapabilities,
    actionCategory,
    dependencies: claimed.dependencies,
    approvalRequired,
    proposedActionDetails,
    expectedResult: claimed.expectedOutcome,
    verificationMethod: claimed.verificationMethod,
  });

  const decided = await markProposalDecided({
    proposalId: claimed.id,
    userId: params.userId,
    status: 'enqueued',
    enqueuedTaskId: createdTask.id,
  });

  return {
    proposal: decided ?? claimed,
    enqueuedTask: createdTask,
  };
}
