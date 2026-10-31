import {
  evaluateTaskEligibility,
  type EligibilityOutcome,
  type ExecutionRouteResolution,
} from './domain-rules.ts';
import type {
  GoalRecord,
  TaskRecord,
  TaskStatus,
  UserIntegrationRecord,
} from '../types.ts';

export const DEFAULT_MAX_PARALLEL_TASKS = 4;
export const MAX_BACKOFF_DELAY_MS = 60_000;

/**
 * Computes deterministic exponential backoff in milliseconds for failed task attempts:
 * attempt 1 -> backoffBaseMs (e.g. 2000ms)
 * attempt 2 -> backoffBaseMs * 2 (e.g. 4000ms)
 * attempt 3 -> backoffBaseMs * 4 (e.g. 8000ms)
 */
export function computeExponentialBackoffMs(params: {
  attemptNumber: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
}): number {
  const base =
    typeof params.backoffBaseMs === 'number' && params.backoffBaseMs > 0
      ? params.backoffBaseMs
      : 2000;
  const cap =
    typeof params.maxBackoffMs === 'number' && params.maxBackoffMs > 0
      ? params.maxBackoffMs
      : MAX_BACKOFF_DELAY_MS;
  const exponent = Math.max(0, params.attemptNumber - 1);
  return Math.min(cap, Math.round(base * Math.pow(2, exponent)));
}

export function isRetryBackoffElapsed(
  nextRetryAtIso: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!nextRetryAtIso) return true;
  const parsed = new Date(nextRetryAtIso).getTime();
  if (Number.isNaN(parsed)) return true;
  return nowMs >= parsed;
}

/**
 * Detects stalled tasks stuck in `running` beyond their configured `executionTimeoutMs`.
 */
export function detectStalledTasks(params: {
  tasks: TaskRecord[];
  nowMs?: number;
  fallbackTimeoutMs?: number;
}): TaskRecord[] {
  const nowMs = params.nowMs ?? Date.now();
  const fallbackTimeoutMs = params.fallbackTimeoutMs ?? 30_000;

  return params.tasks.filter((task) => {
    if (task.status !== 'running') return false;
    const referenceIso = task.startedAt ?? task.lockedAt ?? task.updatedAt;
    const refMs = new Date(referenceIso).getTime();
    if (Number.isNaN(refMs)) return false;
    const timeoutMs =
      task.executionTimeoutMs > 0
        ? Math.max(task.executionTimeoutMs + 5_000, 10_000)
        : fallbackTimeoutMs;
    return nowMs - refMs > timeoutMs;
  });
}

export interface PlannedWaveDispatchItem {
  task: TaskRecord;
  route: Extract<ExecutionRouteResolution, { routable: true }>;
}

export interface PlannedWaveGateTransition {
  task: TaskRecord;
  code: string;
  nextStatus: TaskStatus;
  reason: string;
}

export interface PlannedExecutionWave {
  haltedReason: string | null;
  eligibleBatch: PlannedWaveDispatchItem[];
  gateTransitions: PlannedWaveGateTransition[];
  waitingOnBackoffCount: number;
  waitingOnDependenciesCount: number;
}

/**
 * Plans the next safe execution wave for a goal, supporting either sequential (1 task)
 * or parallel_safe (independent ready tasks whose prerequisites are satisfied).
 */
export function planExecutionWave(params: {
  goal: Pick<GoalRecord, 'id' | 'status' | 'executionState'>;
  tasks: TaskRecord[];
  concurrencyMode: 'sequential' | 'parallel_safe';
  maxParallelTasks?: number;
  nowMs?: number;
  routingContext: {
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
}): PlannedExecutionWave {
  const {
    goal,
    tasks,
    concurrencyMode,
    maxParallelTasks = DEFAULT_MAX_PARALLEL_TASKS,
    nowMs = Date.now(),
    routingContext,
  } = params;

  if (goal.executionState === 'paused') {
    return {
      haltedReason: 'Goal execution is paused. Resume execution to dispatch queued tasks.',
      eligibleBatch: [],
      gateTransitions: [],
      waitingOnBackoffCount: 0,
      waitingOnDependenciesCount: 0,
    };
  }

  if (goal.executionState === 'cancelled') {
    return {
      haltedReason: 'Goal execution was cancelled.',
      eligibleBatch: [],
      gateTransitions: [],
      waitingOnBackoffCount: 0,
      waitingOnDependenciesCount: 0,
    };
  }

  if (goal.status !== 'active') {
    return {
      haltedReason: `Goal status is "${goal.status}". Activate the goal before running tasks.`,
      eligibleBatch: [],
      gateTransitions: [],
      waitingOnBackoffCount: 0,
      waitingOnDependenciesCount: 0,
    };
  }

  const ordered = [...tasks].sort((a, b) => a.stepOrder - b.stepOrder);
  const tasksById = new Map(ordered.map((t) => [t.id, t]));

  const eligibleBatch: PlannedWaveDispatchItem[] = [];
  const gateTransitions: PlannedWaveGateTransition[] = [];
  let waitingOnBackoffCount = 0;
  let waitingOnDependenciesCount = 0;

  const limit = concurrencyMode === 'sequential' ? 1 : Math.max(1, maxParallelTasks);

  for (const candidate of ordered) {
    if (
      candidate.status !== 'queued' &&
      candidate.status !== 'approved' &&
      candidate.status !== 'proposed'
    ) {
      continue;
    }

    if (!isRetryBackoffElapsed(candidate.nextRetryAt, nowMs)) {
      waitingOnBackoffCount += 1;
      continue;
    }

    const check: EligibilityOutcome = evaluateTaskEligibility({
      task: candidate,
      goalStatus: goal.status,
      tasksById,
      routingContext,
    });

    if (check.eligible && check.route) {
      if (eligibleBatch.length < limit) {
        eligibleBatch.push({
          task: candidate,
          route: check.route,
        });
      }
      continue;
    }

    if (!check.eligible) {
      if (check.code === 'dependency_unmet') {
        waitingOnDependenciesCount += 1;
      } else if (check.shouldTransitionTaskStatus) {
        gateTransitions.push({
          task: candidate,
          code: check.code,
          nextStatus: check.shouldTransitionTaskStatus,
          reason: check.reason,
        });
      }
    }
  }

  return {
    haltedReason: null,
    eligibleBatch,
    gateTransitions,
    waitingOnBackoffCount,
    waitingOnDependenciesCount,
  };
}
