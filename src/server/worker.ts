import crypto from 'node:crypto';
import {
  ensureDefaultWorkspaceForUser,
  getGoalByIdForUser,
  listGoalsByUser,
  listIntegrationsByUser,
  listTasksByUser,
} from '../db/repository.ts';
import { evaluateTaskEligibility } from '../lib/domain-rules.ts';
import { isRetryBackoffElapsed } from '../lib/orchestrator-rules.ts';
import { getBuiltInProviderReadiness } from './execution-router.ts';
import { executeSingleTaskManaged } from './orchestrator.ts';
import type { TaskRecord } from '../types.ts';

export interface WorkerDispatchResult {
  executed: boolean;
  workerId: string;
  task: TaskRecord | null;
  outcomeCode: string;
  message: string;
}

/**
 * Executes a specific task through the centralized Milestone 2 Execution Orchestrator.
 * Enforces goal status, pause/cancel state, retry backoff windows, dependencies,
 * Approval Gate, capability routing, persistent DB locks, execution timeouts,
 * strict separation of execution vs. verification, and verified-only goal completion.
 */
export async function runWorkerOnSpecificTask(params: {
  userId: string;
  taskId: string;
}): Promise<WorkerDispatchResult> {
  const managed = await executeSingleTaskManaged({
    userId: params.userId,
    taskId: params.taskId,
  });

  return {
    executed: managed.executed,
    workerId: managed.workerId,
    task: managed.task,
    outcomeCode: managed.outcomeCode,
    message: managed.message,
  };
}

/**
 * Selects and dispatches the next eligible task across active, unpaused goals in the workspace.
 */
export async function runWorkerQueueNext(params: {
  userId: string;
  goalId?: string;
  workspaceId?: string;
}): Promise<WorkerDispatchResult> {
  const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;

  const targetGoals = params.goalId
    ? [await getGoalByIdForUser(params.goalId, params.userId)].filter(
        (g): g is NonNullable<typeof g> => Boolean(g)
      )
    : await listGoalsByUser(params.userId, params.workspaceId);

  if (targetGoals.length === 0) {
    return {
      executed: false,
      workerId,
      task: null,
      outcomeCode: 'no_goals',
      message: 'No goals found in your workspace.',
    };
  }

  const activeGoals = targetGoals.filter((g) => g.status === 'active');
  if (activeGoals.length === 0) {
    const sampleStatus = targetGoals[0].status;
    return {
      executed: false,
      workerId,
      task: null,
      outcomeCode: 'goal_inactive',
      message: `Goal status is "${sampleStatus}". Activate the goal before running queued tasks.`,
    };
  }

  const runnableGoals = activeGoals.filter(
    (g) => g.executionState !== 'paused' && g.executionState !== 'cancelled'
  );
  if (runnableGoals.length === 0) {
    const state = activeGoals[0].executionState;
    return {
      executed: false,
      workerId,
      task: null,
      outcomeCode: state === 'paused' ? 'goal_paused' : 'goal_cancelled',
      message:
        state === 'paused'
          ? 'Goal execution is currently paused. Resume the goal in the Execution Monitor to dispatch tasks.'
          : 'Goal execution was cancelled.',
    };
  }

  const builtInProviders = getBuiltInProviderReadiness();
  let firstNonEligibleCandidate: {
    task: TaskRecord;
    reason: string;
    code: string;
  } | null = null;
  let backoffWaitingCandidate: TaskRecord | null = null;

  for (const goal of runnableGoals) {
    const wsId =
      goal.workspaceId ??
      (await ensureDefaultWorkspaceForUser(params.userId)).id;
    const [goalTasks, userIntegrations] = await Promise.all([
      listTasksByUser(params.userId, goal.id, wsId),
      listIntegrationsByUser(params.userId, wsId),
    ]);

    const tasksById = new Map(goalTasks.map((t) => [t.id, t]));
    const queueCandidates = goalTasks.filter(
      (t) =>
        t.status === 'queued' ||
        t.status === 'approved' ||
        t.status === 'proposed'
    );

    for (const candidate of queueCandidates) {
      if (!isRetryBackoffElapsed(candidate.nextRetryAt)) {
        if (!backoffWaitingCandidate) {
          backoffWaitingCandidate = candidate;
        }
        continue;
      }

      const check = evaluateTaskEligibility({
        task: candidate,
        goalStatus: goal.status,
        tasksById,
        routingContext: {
          builtInProviders,
          userIntegrations,
        },
      });

      if (check.eligible) {
        return runWorkerOnSpecificTask({
          userId: params.userId,
          taskId: candidate.id,
        });
      }

      if (!firstNonEligibleCandidate) {
        firstNonEligibleCandidate = {
          task: candidate,
          reason: check.reason,
          code: check.code,
        };
      }
    }
  }

  if (firstNonEligibleCandidate) {
    return runWorkerOnSpecificTask({
      userId: params.userId,
      taskId: firstNonEligibleCandidate.task.id,
    });
  }

  if (backoffWaitingCandidate) {
    return {
      executed: false,
      workerId,
      task: backoffWaitingCandidate,
      outcomeCode: 'retry_backoff_pending',
      message: `Next queued task (Step ${backoffWaitingCandidate.stepOrder}) is in exponential retry backoff until ${backoffWaitingCandidate.nextRetryAt}. Use Manual Retry in Monitor to override.`,
    };
  }

  return {
    executed: false,
    workerId,
    task: null,
    outcomeCode: 'queue_empty',
    message: 'No runnable queued tasks remain for active goals.',
  };
}
