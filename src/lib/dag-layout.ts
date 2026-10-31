import type {
  CapabilityId,
  GoalStatus,
  TaskRecord,
  ToolRegistryItem,
} from '../types';

export const DAG_GEOMETRY = {
  nodeWidth: 216,
  nodeHeight: 124,
  columnGap: 52,
  rowGap: 20,
  paddingX: 16,
  paddingTop: 46,
  paddingBottom: 20,
} as const;

export type DagBlockingCode =
  | 'cycle_detected'
  | 'reconciliation_required'
  | 'missing_dependency'
  | 'failed_dependency'
  | 'approval_rejected'
  | 'approval_pending'
  | 'provider_unconfigured'
  | 'execution_failed'
  | 'retry_backoff'
  | 'unmet_dependency'
  | 'goal_inactive'
  | 'explicit_blocked';

export type DagIssueSeverity = 'critical' | 'warning' | 'info';

export type DagRemediationAction =
  | 'approval_gate'
  | 'configure_provider'
  | 'reconcile_task'
  | 'retry_task'
  | 'inspect_upstream'
  | 'activate_goal'
  | 'wait_upstream'
  | 'inspect_dependencies';

export interface DagBlockingIssue {
  code: DagBlockingCode;
  severity: DagIssueSeverity;
  headline: string;
  detail: string;
  remediation: DagRemediationAction;
  relatedTaskId?: string;
}

export type DagNodeVisualState =
  | 'verified'
  | 'completed'
  | 'pending_verification'
  | 'running'
  | 'ready'
  | 'waiting'
  | 'blocked'
  | 'failed';

export type DagEdgeState =
  | 'satisfied'
  | 'active'
  | 'pending'
  | 'blocking'
  | 'cycle';

export type DagFilterMode = 'all' | 'blocking' | 'ready' | 'completed';

export interface DagNodeLayout {
  id: string;
  task: TaskRecord;
  waveIndex: number;
  rowIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visualState: DagNodeVisualState;
  isReady: boolean;
  isHardBlocked: boolean;
  isWaitingUpstream: boolean;
  inCycle: boolean;
  blockingIssues: DagBlockingIssue[];
  primaryIssue: DagBlockingIssue | null;
  upstreamIds: string[];
  downstreamIds: string[];
  ancestorIds: string[];
  descendantIds: string[];
}

export interface DagEdgeLayout {
  id: string;
  sourceId: string;
  targetId: string;
  sourceStepOrder: number;
  targetStepOrder: number;
  state: DagEdgeState;
  isBackEdge: boolean;
  path: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}

export interface DagWaveColumn {
  waveIndex: number;
  label: string;
  x: number;
  width: number;
  nodeIds: string[];
}

export interface DagSummaryMetrics {
  totalNodes: number;
  totalEdges: number;
  waveCount: number;
  criticalPathLength: number;
  readyCount: number;
  hardBlockedCount: number;
  waitingCount: number;
  runningCount: number;
  completedOrVerifiedCount: number;
  cycleDetected: boolean;
}

export interface GoalDagLayout {
  width: number;
  height: number;
  nodes: DagNodeLayout[];
  nodesById: Record<string, DagNodeLayout>;
  edges: DagEdgeLayout[];
  waves: DagWaveColumn[];
  summary: DagSummaryMetrics;
}

function capabilitiesCovered(
  available: readonly CapabilityId[],
  required: readonly CapabilityId[]
): boolean {
  if (required.length === 0) return true;
  const set = new Set(available);
  return required.every((cap) => set.has(cap));
}

function isProviderReadyForTask(
  task: TaskRecord,
  tools: readonly ToolRegistryItem[]
): { ready: boolean; detail: string } {
  if (task.tool === 'unsupported') {
    const caps =
      task.requiredCapabilities.length > 0
        ? task.requiredCapabilities.join(', ')
        : 'unspecified';
    return {
      ready: false,
      detail: `Unsupported tool assignment. Connect a provider covering [${caps}] in Integrations.`,
    };
  }

  if (tools.length === 0) {
    if (task.tool === 'llm_reasoning' || task.tool === 'internal_test_tool') {
      return { ready: true, detail: 'Built-in runtime available.' };
    }
    return {
      ready: false,
      detail: `External provider "${task.tool}" has no verified workspace connection.`,
    };
  }

  const directTool = tools.find((t) => t.id === task.tool);
  if (task.tool === 'llm_reasoning' || task.tool === 'internal_test_tool') {
    if (!directTool || (directTool.configured && directTool.verified)) {
      return { ready: true, detail: 'Built-in runtime ready.' };
    }
    return {
      ready: false,
      detail:
        directTool.statusDetail ||
        `Built-in runtime "${task.tool}" is not currently ready.`,
    };
  }

  if (directTool && directTool.configured && directTool.verified) {
    if (
      capabilitiesCovered(directTool.capabilities, task.requiredCapabilities)
    ) {
      return {
        ready: true,
        detail: `${directTool.name} verified.`,
      };
    }
  }

  const fallbackCompatible = tools.find(
    (t) =>
      t.scope === 'tenant_configurable' &&
      t.configured &&
      t.verified &&
      capabilitiesCovered(t.capabilities, task.requiredCapabilities)
  );

  if (fallbackCompatible) {
    return {
      ready: true,
      detail: `Routable via ${fallbackCompatible.name}.`,
    };
  }

  const unverifiedMatch =
    directTool && directTool.configured && !directTool.verified
      ? directTool
      : tools.find(
          (t) =>
            t.scope === 'tenant_configurable' &&
            t.configured &&
            !t.verified &&
            capabilitiesCovered(t.capabilities, task.requiredCapabilities)
        );

  if (unverifiedMatch) {
    return {
      ready: false,
      detail: `${unverifiedMatch.name} is saved in this workspace, but its connection test has not passed yet.`,
    };
  }

  return {
    ready: false,
    detail: `No verified workspace integration connected for "${task.tool}".`,
  };
}

function buildBezierEdgePath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  isBackEdge: boolean
): string {
  if (isBackEdge || tx <= sx + 12) {
    const lift = 68;
    const midY = Math.min(sy, ty) - lift;
    return `M ${sx} ${sy} C ${sx + 64} ${midY}, ${tx - 64} ${midY}, ${tx} ${ty}`;
  }
  const dx = tx - sx;
  const controlOffset = Math.max(36, Math.min(96, dx * 0.48));
  const c1x = Math.round((sx + controlOffset) * 10) / 10;
  const c2x = Math.round((tx - controlOffset) * 10) / 10;
  return `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`;
}

export function matchesDagFilter(
  node: DagNodeLayout,
  filter: DagFilterMode
): boolean {
  if (filter === 'all') return true;
  if (filter === 'blocking') {
    return node.isHardBlocked || node.visualState === 'failed';
  }
  if (filter === 'ready') {
    return node.isReady || node.visualState === 'running';
  }
  if (filter === 'completed') {
    return (
      node.visualState === 'verified' ||
      node.visualState === 'completed' ||
      node.visualState === 'pending_verification'
    );
  }
  return true;
}

export function computeGoalDagLayout(params: {
  tasks: readonly TaskRecord[];
  goalStatus: GoalStatus;
  tools?: readonly ToolRegistryItem[];
}): GoalDagLayout {
  const { goalStatus, tools = [] } = params;
  const sortedTasks = [...params.tasks].sort((a, b) => {
    if (a.stepOrder !== b.stepOrder) return a.stepOrder - b.stepOrder;
    return a.id.localeCompare(b.id);
  });

  if (sortedTasks.length === 0) {
    return {
      width: 640,
      height: 220,
      nodes: [],
      nodesById: {},
      edges: [],
      waves: [],
      summary: {
        totalNodes: 0,
        totalEdges: 0,
        waveCount: 0,
        criticalPathLength: 0,
        readyCount: 0,
        hardBlockedCount: 0,
        waitingCount: 0,
        runningCount: 0,
        completedOrVerifiedCount: 0,
        cycleDetected: false,
      },
    };
  }

  const taskById = new Map<string, TaskRecord>();
  for (const t of sortedTasks) {
    taskById.set(t.id, t);
  }

  // Adjacency lists (source prerequisite -> target dependent)
  const upstreamById = new Map<string, string[]>();
  const downstreamById = new Map<string, string[]>();
  const missingDepsById = new Map<string, string[]>();

  for (const t of sortedTasks) {
    upstreamById.set(t.id, []);
    downstreamById.set(t.id, []);
    missingDepsById.set(t.id, []);
  }

  for (const t of sortedTasks) {
    const seen = new Set<string>();
    for (const depId of t.dependencies) {
      if (seen.has(depId)) continue;
      seen.add(depId);
      if (!taskById.has(depId)) {
        missingDepsById.get(t.id)!.push(depId);
        continue;
      }
      upstreamById.get(t.id)!.push(depId);
      downstreamById.get(depId)!.push(t.id);
    }
  }

  // Detect any cycle edges deterministically via DFS ordered by stepOrder
  const visitState = new Map<string, 'visiting' | 'visited'>();
  const cycleNodeIds = new Set<string>();
  const backEdgeKeys = new Set<string>();
  const activeStack: string[] = [];

  function dfsCycleCheck(nodeId: string): void {
    visitState.set(nodeId, 'visiting');
    activeStack.push(nodeId);

    const children = downstreamById.get(nodeId) ?? [];
    for (const childId of children) {
      const state = visitState.get(childId);
      if (state === 'visiting') {
        backEdgeKeys.add(`${nodeId}->${childId}`);
        const cycleStartIdx = activeStack.indexOf(childId);
        if (cycleStartIdx >= 0) {
          for (let i = cycleStartIdx; i < activeStack.length; i++) {
            cycleNodeIds.add(activeStack[i]);
          }
        }
        cycleNodeIds.add(childId);
      } else if (!state) {
        dfsCycleCheck(childId);
      }
    }

    activeStack.pop();
    visitState.set(nodeId, 'visited');
  }

  for (const t of sortedTasks) {
    if (!visitState.has(t.id)) {
      dfsCycleCheck(t.id);
    }
  }

  // Compute longest-path topological wave layer ignoring back-edges
  const waveById = new Map<string, number>();

  function computeWave(nodeId: string, guard = new Set<string>()): number {
    const cached = waveById.get(nodeId);
    if (cached !== undefined) return cached;
    if (guard.has(nodeId)) return 0;

    guard.add(nodeId);
    const parents = upstreamById.get(nodeId) ?? [];
    let maxParentWave = -1;
    for (const parentId of parents) {
      if (backEdgeKeys.has(`${parentId}->${nodeId}`)) continue;
      const pw = computeWave(parentId, guard);
      if (pw > maxParentWave) {
        maxParentWave = pw;
      }
    }
    guard.delete(nodeId);

    const wave = maxParentWave + 1;
    waveById.set(nodeId, wave);
    return wave;
  }

  let maxWave = 0;
  for (const t of sortedTasks) {
    const w = computeWave(t.id);
    if (w > maxWave) maxWave = w;
  }

  // Group into wave columns and apply barycenter ordering to minimize crossings
  const waveBuckets: TaskRecord[][] = Array.from(
    { length: maxWave + 1 },
    () => []
  );
  for (const t of sortedTasks) {
    const w = waveById.get(t.id) ?? 0;
    waveBuckets[w].push(t);
  }

  const rowIndexById = new Map<string, number>();
  for (let w = 0; w <= maxWave; w++) {
    const bucket = waveBuckets[w];
    if (w > 0) {
      bucket.sort((a, b) => {
        const aParents = (upstreamById.get(a.id) ?? []).filter(
          (pid) => !backEdgeKeys.has(`${pid}->${a.id}`)
        );
        const bParents = (upstreamById.get(b.id) ?? []).filter(
          (pid) => !backEdgeKeys.has(`${pid}->${b.id}`)
        );
        const aBary =
          aParents.length > 0
            ? aParents.reduce(
                (acc, pid) => acc + (rowIndexById.get(pid) ?? 0),
                0
              ) / aParents.length
            : a.stepOrder;
        const bBary =
          bParents.length > 0
            ? bParents.reduce(
                (acc, pid) => acc + (rowIndexById.get(pid) ?? 0),
                0
              ) / bParents.length
            : b.stepOrder;
        if (Math.abs(aBary - bBary) > 0.001) return aBary - bBary;
        return a.stepOrder - b.stepOrder;
      });
    }
    bucket.forEach((task, idx) => {
      rowIndexById.set(task.id, idx);
    });
  }

  // Compute canvas dimensions and vertically center shorter wave columns
  const maxRowsInAnyWave = Math.max(1, ...waveBuckets.map((b) => b.length));
  const maxColumnContentHeight =
    maxRowsInAnyWave * DAG_GEOMETRY.nodeHeight +
    Math.max(0, maxRowsInAnyWave - 1) * DAG_GEOMETRY.rowGap;

  const canvasWidth =
    DAG_GEOMETRY.paddingX * 2 +
    (maxWave + 1) * DAG_GEOMETRY.nodeWidth +
    maxWave * DAG_GEOMETRY.columnGap;

  const canvasHeight =
    DAG_GEOMETRY.paddingTop +
    maxColumnContentHeight +
    DAG_GEOMETRY.paddingBottom;

  // Compute ancestors and descendants for interactive lineage highlighting
  function collectLineage(
    startId: string,
    adjacency: Map<string, string[]>
  ): string[] {
    const visited = new Set<string>();
    const queue = [...(adjacency.get(startId) ?? [])];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (curr === startId || visited.has(curr)) continue;
      visited.add(curr);
      for (const next of adjacency.get(curr) ?? []) {
        if (!visited.has(next)) queue.push(next);
      }
    }
    return Array.from(visited);
  }

  const waves: DagWaveColumn[] = [];
  const nodes: DagNodeLayout[] = [];
  const nodesById: Record<string, DagNodeLayout> = {};

  let readyCount = 0;
  let hardBlockedCount = 0;
  let waitingCount = 0;
  let runningCount = 0;
  let completedOrVerifiedCount = 0;

  for (let w = 0; w <= maxWave; w++) {
    const bucket = waveBuckets[w];
    const colX =
      DAG_GEOMETRY.paddingX +
      w * (DAG_GEOMETRY.nodeWidth + DAG_GEOMETRY.columnGap);
    const colHeight =
      bucket.length * DAG_GEOMETRY.nodeHeight +
      Math.max(0, bucket.length - 1) * DAG_GEOMETRY.rowGap;
    const startY =
      DAG_GEOMETRY.paddingTop +
      Math.round((maxColumnContentHeight - colHeight) / 2);

    waves.push({
      waveIndex: w,
      label: `Wave ${w + 1}`,
      x: colX,
      width: DAG_GEOMETRY.nodeWidth,
      nodeIds: bucket.map((t) => t.id),
    });

    bucket.forEach((task, rowIdx) => {
      const y = startY + rowIdx * (DAG_GEOMETRY.nodeHeight + DAG_GEOMETRY.rowGap);
      const isTerminalDone =
        task.status === 'completed' || task.status === 'verified';
      const isPendingVerification = task.status === 'pending_verification';
      const isRunning =
        task.status === 'running' || task.status === 'attempted';
      const inCycle = cycleNodeIds.has(task.id);

      const issues: DagBlockingIssue[] = [];

      if (inCycle) {
        issues.push({
          code: 'cycle_detected',
          severity: 'critical',
          headline: 'Circular dependency detected',
          detail:
            'This task participates in a dependency loop and cannot be scheduled safely until dependencies are updated.',
          remediation: 'inspect_dependencies',
        });
      }

      const missingDeps = missingDepsById.get(task.id) ?? [];
      for (const missingId of missingDeps) {
        issues.push({
          code: 'missing_dependency',
          severity: 'critical',
          headline: 'Missing prerequisite reference',
          detail: `Prerequisite task "${missingId.slice(0, 8)}" does not exist in this goal.`,
          remediation: 'inspect_dependencies',
        });
      }

      if (!isTerminalDone && !isPendingVerification) {
        if (task.reconciliationRequired) {
          issues.push({
            code: 'reconciliation_required',
            severity: 'critical',
            headline: 'Uncertain execution — Reconcile required',
            detail:
              task.statusReason ||
              'External dispatch timed out or worker restarted mid-flight. Reconcile outcome before retrying.',
            remediation: 'reconcile_task',
          });
        }

        for (const depId of upstreamById.get(task.id) ?? []) {
          const dep = taskById.get(depId);
          if (!dep) continue;
          if (
            dep.status === 'failed' ||
            dep.status === 'rejected' ||
            dep.status === 'blocked'
          ) {
            issues.push({
              code: 'failed_dependency',
              severity: 'critical',
              headline: `Blocked by Step ${dep.stepOrder} (${dep.status})`,
              detail: `Upstream prerequisite "${dep.description}" is ${dep.status}. Resolve Step ${dep.stepOrder} first.`,
              remediation: 'inspect_upstream',
              relatedTaskId: dep.id,
            });
          } else if (
            dep.status !== 'completed' &&
            dep.status !== 'verified'
          ) {
            issues.push({
              code: 'unmet_dependency',
              severity: 'info',
              headline: `Waiting on Step ${dep.stepOrder}`,
              detail: `Prerequisite "${dep.description}" is currently ${dep.status.replace(/_/g, ' ')}.`,
              remediation: 'wait_upstream',
              relatedTaskId: dep.id,
            });
          }
        }

        if (task.approvalRequired && task.approvalStatus === 'rejected') {
          issues.push({
            code: 'approval_rejected',
            severity: 'critical',
            headline: 'Rejected in Approval Gate',
            detail:
              'Consequential execution was explicitly rejected by a human reviewer.',
            remediation: 'approval_gate',
          });
        } else if (
          task.approvalRequired &&
          task.approvalStatus !== 'approved'
        ) {
          issues.push({
            code: 'approval_pending',
            severity: 'warning',
            headline: 'Approval Gate required',
            detail:
              'Requires explicit human sign-off in Approval Gate before dispatch.',
            remediation: 'approval_gate',
          });
        }

        const providerCheck = isProviderReadyForTask(task, tools);
        if (!providerCheck.ready) {
          issues.push({
            code: 'provider_unconfigured',
            severity: 'warning',
            headline: 'Execution provider unconfigured',
            detail: providerCheck.detail,
            remediation: 'configure_provider',
          });
        }

        if (
          !task.reconciliationRequired &&
          (task.status === 'failed' ||
            (task.maxRetries >= 0 &&
              task.retryCount > 0 &&
              task.retryCount >= task.maxRetries + 1))
        ) {
          issues.push({
            code: 'execution_failed',
            severity: 'critical',
            headline:
              task.retryCount > 0
                ? `Execution failed (${task.retryCount}/${task.maxRetries} retries)`
                : 'Execution failed',
            detail:
              task.statusReason ||
              'Task exhausted retries or returned a fatal provider error.',
            remediation: 'retry_task',
          });
        } else if (!task.reconciliationRequired && task.nextRetryAt) {
          issues.push({
            code: 'retry_backoff',
            severity: 'info',
            headline: 'Scheduled for backoff retry',
            detail: `Retry ${task.retryCount}/${task.maxRetries} scheduled after ${new Date(task.nextRetryAt).toLocaleTimeString()}.`,
            remediation: 'retry_task',
          });
        }

        if (
          task.status === 'blocked' &&
          issues.every((i) => i.severity === 'info')
        ) {
          issues.push({
            code: 'explicit_blocked',
            severity: 'warning',
            headline: 'Task halted by safety gate',
            detail:
              task.statusReason ||
              'Task is marked blocked and requires manual inspection or retry.',
            remediation: 'retry_task',
          });
        }

        if (goalStatus !== 'active' && !isRunning) {
          issues.push({
            code: 'goal_inactive',
            severity: 'info',
            headline: `Goal status is "${goalStatus}"`,
            detail:
              'Activate or resume the goal so eligible queued tasks can execute.',
            remediation: 'activate_goal',
          });
        }
      }

      // Sort issues: critical -> warning -> info
      const severityRank: Record<DagIssueSeverity, number> = {
        critical: 0,
        warning: 1,
        info: 2,
      };
      issues.sort(
        (a, b) => severityRank[a.severity] - severityRank[b.severity]
      );

      const hasCritical = issues.some((i) => i.severity === 'critical');
      const hasWarning = issues.some((i) => i.severity === 'warning');
      const isHardBlocked =
        !isTerminalDone &&
        !isPendingVerification &&
        (hasCritical ||
          hasWarning ||
          task.status === 'blocked' ||
          task.status === 'failed' ||
          task.status === 'rejected');

      const isWaitingUpstream =
        !isTerminalDone &&
        !isPendingVerification &&
        !isRunning &&
        !isHardBlocked &&
        issues.length > 0;

      const isReady =
        !isTerminalDone &&
        !isPendingVerification &&
        !isRunning &&
        !isHardBlocked &&
        issues.length === 0 &&
        (task.status === 'queued' ||
          task.status === 'approved' ||
          task.status === 'proposed');

      let visualState: DagNodeVisualState = 'waiting';
      if (task.status === 'verified') {
        visualState = 'verified';
        completedOrVerifiedCount += 1;
      } else if (task.status === 'completed') {
        visualState = 'completed';
        completedOrVerifiedCount += 1;
      } else if (isPendingVerification) {
        visualState = 'pending_verification';
      } else if (isRunning) {
        visualState = 'running';
        runningCount += 1;
      } else if (
        task.status === 'failed' ||
        task.status === 'rejected' ||
        hasCritical
      ) {
        visualState = 'failed';
        hardBlockedCount += 1;
      } else if (isHardBlocked) {
        visualState = 'blocked';
        hardBlockedCount += 1;
      } else if (isReady) {
        visualState = 'ready';
        readyCount += 1;
      } else {
        visualState = 'waiting';
        waitingCount += 1;
      }

      const nodeLayout: DagNodeLayout = {
        id: task.id,
        task,
        waveIndex: w,
        rowIndex: rowIdx,
        x: colX,
        y,
        width: DAG_GEOMETRY.nodeWidth,
        height: DAG_GEOMETRY.nodeHeight,
        visualState,
        isReady,
        isHardBlocked,
        isWaitingUpstream,
        inCycle,
        blockingIssues: issues,
        primaryIssue: issues[0] ?? null,
        upstreamIds: upstreamById.get(task.id) ?? [],
        downstreamIds: downstreamById.get(task.id) ?? [],
        ancestorIds: collectLineage(task.id, upstreamById),
        descendantIds: collectLineage(task.id, downstreamById),
      };

      nodes.push(nodeLayout);
      nodesById[task.id] = nodeLayout;
    });
  }

  // Build directed dependency edges
  const edges: DagEdgeLayout[] = [];
  for (const targetNode of nodes) {
    for (const sourceId of targetNode.upstreamIds) {
      const sourceNode = nodesById[sourceId];
      if (!sourceNode) continue;

      const edgeKey = `${sourceId}->${targetNode.id}`;
      const isBackEdge = backEdgeKeys.has(edgeKey);
      const sourceX = sourceNode.x + sourceNode.width;
      const sourceY = Math.round(sourceNode.y + sourceNode.height / 2);
      const targetX = targetNode.x;
      const targetY = Math.round(targetNode.y + targetNode.height / 2);

      let state: DagEdgeState = 'pending';
      if (isBackEdge) {
        state = 'cycle';
      } else if (
        sourceNode.task.status === 'completed' ||
        sourceNode.task.status === 'verified'
      ) {
        state = 'satisfied';
      } else if (
        sourceNode.task.status === 'running' ||
        sourceNode.task.status === 'attempted'
      ) {
        state = 'active';
      } else if (
        sourceNode.isHardBlocked ||
        sourceNode.visualState === 'failed'
      ) {
        state = 'blocking';
      }

      edges.push({
        id: edgeKey,
        sourceId,
        targetId: targetNode.id,
        sourceStepOrder: sourceNode.task.stepOrder,
        targetStepOrder: targetNode.task.stepOrder,
        state,
        isBackEdge,
        path: buildBezierEdgePath(
          sourceX,
          sourceY,
          targetX,
          targetY,
          isBackEdge
        ),
        sourceX,
        sourceY,
        targetX,
        targetY,
      });
    }
  }

  return {
    width: canvasWidth,
    height: canvasHeight,
    nodes,
    nodesById,
    edges,
    waves,
    summary: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      waveCount: waves.length,
      criticalPathLength: waves.length,
      readyCount,
      hardBlockedCount,
      waitingCount,
      runningCount,
      completedOrVerifiedCount,
      cycleDetected: cycleNodeIds.size > 0,
    },
  };
}
