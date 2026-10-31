import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
  Play,
  RotateCcw,
  Plus,
  Cpu,
  ArrowRight,
  GitBranch,
  Settings,
} from 'lucide-react';
import {
  computeGoalDagLayout,
  matchesDagFilter,
  type DagEdgeLayout,
  type DagFilterMode,
  type DagNodeLayout,
  type DagNodeVisualState,
} from '../lib/dag-layout';
import type { GoalRecord, TaskRecord, ToolRegistryItem } from '../types';

interface TaskDagVisualizerProps {
  goal: GoalRecord | null;
  tasks: TaskRecord[];
  tools: ToolRegistryItem[];
  busyAction: string | null;
  onGeneratePlan: (goalId: string) => Promise<void>;
  onOpenAddTask: () => void;
  onExecuteTask: (taskId: string) => Promise<void>;
  onRetryTask: (taskId: string) => Promise<void>;
  onReconcileTask?: (
    taskId: string,
    resolution:
      | 'reconcile_from_evidence'
      | 'mark_dispatched_pending_verification'
      | 'confirm_not_executed_requeue'
  ) => Promise<void>;
  onOpenApprovalTab: () => void;
  onOpenIntegrationsTab: () => void;
  onControlGoalExecution: (
    goalId: string,
    action: 'pause' | 'resume' | 'cancel'
  ) => Promise<void>;
}

const FILTER_OPTIONS: Array<{ value: DagFilterMode; label: string }> = [
  { value: 'all', label: 'All Tasks' },
  { value: 'blocking', label: 'Blocking Issues' },
  { value: 'ready', label: 'Ready / Running' },
  { value: 'completed', label: 'Done / Verified' },
];

function getVisualStateMeta(state: DagNodeVisualState): {
  label: string;
  textClass: string;
  borderClass: string;
  surfaceClass: string;
  icon: React.ReactNode;
} {
  switch (state) {
    case 'verified':
      return {
        label: 'Verified',
        textClass: 'text-emerald-700 dark:text-emerald-400',
        borderClass: 'border-emerald-300 dark:border-emerald-800',
        surfaceClass: 'bg-white dark:bg-slate-900',
        icon: <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-700 dark:text-emerald-400" />,
      };
    case 'completed':
      return {
        label: 'Completed (Unverified)',
        textClass: 'text-blue-700 dark:text-blue-400',
        borderClass: 'border-blue-300 dark:border-blue-800',
        surfaceClass: 'bg-white dark:bg-slate-900',
        icon: <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-blue-700 dark:text-blue-400" />,
      };
    case 'pending_verification':
      return {
        label: 'Pending Proof',
        textClass: 'text-amber-800 dark:text-amber-400',
        borderClass: 'border-amber-300 dark:border-amber-800',
        surfaceClass: 'bg-white dark:bg-slate-900',
        icon: <Clock className="w-3.5 h-3.5 shrink-0 text-amber-800 dark:text-amber-400" />,
      };
    case 'running':
      return {
        label: 'Running',
        textClass: 'text-blue-700 dark:text-blue-400',
        borderClass: 'border-blue-400 dark:border-blue-700',
        surfaceClass: 'bg-blue-50/40 dark:bg-blue-950/30',
        icon: <Clock className="w-3.5 h-3.5 shrink-0 text-blue-700 dark:text-blue-400" />,
      };
    case 'ready':
      return {
        label: 'Ready to Run',
        textClass: 'text-emerald-800 dark:text-emerald-400',
        borderClass: 'border-slate-300 dark:border-slate-700',
        surfaceClass: 'bg-white dark:bg-slate-900',
        icon: <Play className="w-3.5 h-3.5 shrink-0 text-emerald-700 dark:text-emerald-400" />,
      };
    case 'blocked':
      return {
        label: 'Blocked',
        textClass: 'text-amber-800 dark:text-amber-400',
        borderClass: 'border-amber-400 dark:border-amber-800',
        surfaceClass: 'bg-amber-50/40 dark:bg-amber-950/30',
        icon: <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-700 dark:text-amber-400" />,
      };
    case 'failed':
      return {
        label: 'Failed / Halted',
        textClass: 'text-red-700 dark:text-red-400',
        borderClass: 'border-red-300 dark:border-red-800',
        surfaceClass: 'bg-red-50/35 dark:bg-red-950/30',
        icon: <XCircle className="w-3.5 h-3.5 shrink-0 text-red-700 dark:text-red-400" />,
      };
    case 'waiting':
    default:
      return {
        label: 'Waiting Upstream',
        textClass: 'text-slate-600 dark:text-slate-400',
        borderClass: 'border-slate-200 dark:border-slate-800',
        surfaceClass: 'bg-white dark:bg-slate-900',
        icon: <Clock className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />,
      };
  }
}

function getEdgePresentation(edge: DagEdgeLayout): {
  stroke: string;
  dashArray?: string;
  markerId: string;
} {
  switch (edge.state) {
    case 'satisfied':
      return {
        stroke: '#047857', // emerald-700
        markerId: 'dag-arrow-satisfied',
      };
    case 'active':
      return {
        stroke: '#1d4ed8', // blue-700
        markerId: 'dag-arrow-active',
      };
    case 'blocking':
      return {
        stroke: '#b45309', // amber-700
        dashArray: '5 4',
        markerId: 'dag-arrow-blocking',
      };
    case 'cycle':
      return {
        stroke: '#b91c1c', // red-700
        dashArray: '3 3',
        markerId: 'dag-arrow-cycle',
      };
    case 'pending':
    default:
      return {
        stroke: '#64748b', // slate-500
        markerId: 'dag-arrow-pending',
      };
  }
}

export const TaskDagVisualizer: React.FC<TaskDagVisualizerProps> = ({
  goal,
  tasks,
  tools,
  busyAction,
  onGeneratePlan,
  onOpenAddTask,
  onExecuteTask,
  onRetryTask,
  onReconcileTask,
  onOpenApprovalTab,
  onOpenIntegrationsTab,
  onControlGoalExecution,
}) => {
  const [filterMode, setFilterMode] = useState<DagFilterMode>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);

  const goalTasks = useMemo(
    () => (goal ? tasks.filter((t) => t.goalId === goal.id) : []),
    [goal, tasks]
  );

  const layout = useMemo(
    () =>
      computeGoalDagLayout({
        tasks: goalTasks,
        goalStatus: goal?.status ?? 'draft',
        tools,
      }),
    [goalTasks, goal?.status, tools]
  );

  // Keep selection anchored to a valid task (prefer first blocked/ready task on initial load)
  useEffect(() => {
    if (layout.nodes.length === 0) {
      setSelectedTaskId(null);
      return;
    }
    if (selectedTaskId && layout.nodesById[selectedTaskId]) {
      return;
    }
    const firstAttentionNode =
      layout.nodes.find(
        (n) => n.isHardBlocked || n.visualState === 'failed'
      ) ??
      layout.nodes.find((n) => n.isReady) ??
      layout.nodes[0];
    setSelectedTaskId(firstAttentionNode?.id ?? null);
  }, [layout, selectedTaskId]);

  const selectedNode: DagNodeLayout | null = selectedTaskId
    ? layout.nodesById[selectedTaskId] ?? null
    : null;

  const connectedLineageSet = useMemo(() => {
    if (!selectedNode) return null;
    return new Set<string>([
      selectedNode.id,
      ...selectedNode.ancestorIds,
      ...selectedNode.descendantIds,
    ]);
  }, [selectedNode]);

  useEffect(() => {
    if (!selectedTaskId || !scrollViewportRef.current) return;
    const nodeEl = scrollViewportRef.current.querySelector<HTMLElement>(
      `[data-dag-node-id="${selectedTaskId}"]`
    );
    if (nodeEl) {
      nodeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [selectedTaskId]);

  if (!goal) {
    return null;
  }

  const planningBusy = busyAction === `plan:${goal.id}`;

  return (
    <section
      aria-label="Task dependency directed acyclic graph"
      className="bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-200 dark:divide-slate-800 overflow-hidden"
    >
      {/* Header, Summary Telemetry & Filter Controls */}
      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 max-w-3xl">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-slate-700 dark:text-slate-300 shrink-0" />
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                Task Dependency Graph (DAG) &amp; Bottleneck Diagnostics
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Topological execution waves, prerequisite links, and active safety
              or provider blockers for the selected goal. Select any node to
              trace its upstream prerequisites, downstream dependents, and
              remediation controls.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onOpenAddTask}
              className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Task</span>
            </button>

            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => onGeneratePlan(goal.id)}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>
                {planningBusy
                  ? 'Planning DAG...'
                  : layout.nodes.length > 0
                    ? 'Regenerate AI Plan'
                    : 'Generate AI Plan'}
              </span>
            </button>
          </div>
        </div>

        {layout.nodes.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
            {/* Clean Unboxed Telemetry Strip (Zero-Pill Discipline) */}
            <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-600 tabular-nums">
              <span>
                Nodes:{' '}
                <strong className="font-mono text-slate-900">
                  {layout.summary.totalNodes}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Dependencies:{' '}
                <strong className="font-mono text-slate-900">
                  {layout.summary.totalEdges}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Execution Waves:{' '}
                <strong className="font-mono text-slate-900">
                  {layout.summary.waveCount}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Ready:{' '}
                <strong className="font-mono text-emerald-700">
                  {layout.summary.readyCount}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Blocking Issues:{' '}
                <strong
                  className={`font-mono ${
                    layout.summary.hardBlockedCount > 0
                      ? 'text-amber-800'
                      : 'text-slate-900'
                  }`}
                >
                  {layout.summary.hardBlockedCount}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Done / Verified:{' '}
                <strong className="font-mono text-slate-900">
                  {layout.summary.completedOrVerifiedCount}
                </strong>
              </span>
            </div>

            {/* Interactive Filter Segmented Control */}
            <div
              role="group"
              aria-label="Filter DAG task nodes"
              className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0"
            >
              {FILTER_OPTIONS.map((opt) => {
                const count =
                  opt.value === 'all'
                    ? layout.summary.totalNodes
                    : layout.nodes.filter((n) => matchesDagFilter(n, opt.value))
                        .length;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setFilterMode(opt.value)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                      filterMode === opt.value
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {opt.label} ({count})
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {layout.summary.cycleDetected && (
          <div
            role="alert"
            className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
            <span>
              Circular dependency reference detected. Back-edges are highlighted
              in dashed crimson so affected steps can be inspected safely.
            </span>
          </div>
        )}
      </div>

      {/* Empty State vs Interactive DAG Canvas + Node Inspector */}
      {layout.nodes.length === 0 ? (
        <div className="p-10 text-center space-y-3 bg-slate-50/50">
          <p className="text-sm font-semibold text-slate-900">
            No Tasks Planned for This Goal Yet
          </p>
          <p className="text-xs text-slate-600 max-w-md mx-auto leading-relaxed">
            Generate a structured AI execution plan or add tasks manually to
            visualize prerequisite waves, execution routing, and approval or
            provider bottlenecks.
          </p>
          <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => onGeneratePlan(goal.id)}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>
                {planningBusy ? 'Generating DAG...' : 'Generate AI Execution Plan'}
              </span>
            </button>
            <button
              type="button"
              onClick={onOpenAddTask}
              className="px-4 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Task Manually</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 divide-y xl:divide-y-0 xl:divide-x divide-slate-200 dark:divide-slate-800">
          {/* Left / Main: Directed Acyclic Graph Viewport */}
          <div className="xl:col-span-8 flex flex-col justify-between bg-slate-50/60 dark:bg-slate-950/60">
            <div
              ref={scrollViewportRef}
              data-testid="dag-scroll-viewport"
              className="overflow-x-auto overflow-y-auto p-4"
            >
              <div
                style={{
                  width: `${layout.width}px`,
                  height: `${layout.height}px`,
                }}
                className="relative select-none mx-auto"
              >
                {/* Wave Column Headers */}
                {layout.waves.map((wave) => (
                  <div
                    key={wave.waveIndex}
                    style={{
                      left: `${wave.x}px`,
                      top: '10px',
                      width: `${wave.width}px`,
                    }}
                    className="absolute flex items-center justify-between text-xs text-slate-500 pb-1.5 border-b border-slate-200/90 tabular-nums"
                  >
                    <span className="font-semibold text-slate-700">
                      {wave.label}
                    </span>
                    <span className="font-mono">
                      {wave.nodeIds.length}{' '}
                      {wave.nodeIds.length === 1 ? 'task' : 'tasks'}
                    </span>
                  </div>
                ))}

                {/* Directed SVG Edge Layer */}
                <svg
                  width={layout.width}
                  height={layout.height}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  aria-hidden="true"
                  className="absolute inset-0 pointer-events-none"
                >
                  <defs>
                    <marker
                      id="dag-arrow-satisfied"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#047857" />
                    </marker>
                    <marker
                      id="dag-arrow-active"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#1d4ed8" />
                    </marker>
                    <marker
                      id="dag-arrow-blocking"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#b45309" />
                    </marker>
                    <marker
                      id="dag-arrow-cycle"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#b91c1c" />
                    </marker>
                    <marker
                      id="dag-arrow-pending"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#64748b" />
                    </marker>
                  </defs>

                  {layout.edges.map((edge) => {
                    const style = getEdgePresentation(edge);
                    const inSelectedChain = connectedLineageSet
                      ? connectedLineageSet.has(edge.sourceId) &&
                        connectedLineageSet.has(edge.targetId)
                      : true;
                    const directlyIncident =
                      selectedNode &&
                      (edge.sourceId === selectedNode.id ||
                        edge.targetId === selectedNode.id);

                    return (
                      <g
                        key={edge.id}
                        opacity={inSelectedChain ? 1 : 0.45}
                      >
                        <path
                          d={edge.path}
                          fill="none"
                          stroke={style.stroke}
                          strokeWidth={directlyIncident ? 2.5 : 1.75}
                          strokeDasharray={style.dashArray}
                          markerEnd={`url(#${style.markerId})`}
                        />
                      </g>
                    );
                  })}
                </svg>

                {/* Accessible Interactive Task Node Buttons */}
                {layout.nodes.map((node) => {
                  const meta = getVisualStateMeta(node.visualState);
                  const isSelected = selectedNode?.id === node.id;
                  const passesFilter = matchesDagFilter(node, filterMode);
                  const inLineage = connectedLineageSet
                    ? connectedLineageSet.has(node.id)
                    : true;

                  const opacityClass = !passesFilter
                    ? 'opacity-30'
                    : !isSelected && !inLineage
                      ? 'opacity-80'
                      : 'opacity-100';

                  return (
                    <button
                      key={node.id}
                      type="button"
                      data-dag-node-id={node.id}
                      onClick={() => setSelectedTaskId(node.id)}
                      aria-pressed={isSelected}
                      aria-label={`Step ${node.task.stepOrder}: ${node.task.description} — ${meta.label}`}
                      style={{
                        left: `${node.x}px`,
                        top: `${node.y}px`,
                        width: `${node.width}px`,
                        height: `${node.height}px`,
                      }}
                      className={`absolute text-left p-3 rounded-lg border transition-opacity flex flex-col justify-between cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                        meta.surfaceClass
                      } ${meta.borderClass} ${
                        isSelected
                          ? 'ring-2 ring-slate-900 border-slate-900'
                          : 'hover:border-slate-400'
                      } ${opacityClass}`}
                    >
                       {/* Top Metadata Row */}
                      <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                        <span className="font-mono font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          Step {node.task.stepOrder}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 font-semibold truncate ${meta.textClass}`}
                        >
                          {meta.icon}
                          <span className="truncate">{meta.label}</span>
                        </span>
                      </div>

                      {/* Task Description */}
                      <p className="text-xs font-medium text-slate-900 dark:text-slate-100 line-clamp-2 leading-snug">
                        {node.task.description}
                      </p>

                      {/* Bottom Provider / Blocker Callout */}
                      <div className="pt-1.5 border-t border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-2 text-[11px] tabular-nums">
                        {node.primaryIssue ? (
                          <span
                            className={`truncate font-medium ${
                              node.primaryIssue.severity === 'critical'
                                ? 'text-red-700'
                                : node.primaryIssue.severity === 'warning'
                                  ? 'text-amber-800'
                                  : 'text-slate-600'
                            }`}
                          >
                            {node.primaryIssue.headline}
                          </span>
                        ) : (
                          <span className="font-mono text-slate-600 truncate">
                            {node.task.tool}
                          </span>
                        )}
                        <span className="font-mono text-slate-500 whitespace-nowrap shrink-0">
                          {node.upstreamIds.length} in · {node.downstreamIds.length}{' '}
                          out
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Edge & Status Legend Footer */}
            <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400">
              <div className="flex flex-wrap items-center gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block w-5 h-0.5 bg-emerald-700"
                  />
                  <span>Satisfied prerequisite</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block w-5 h-0.5 bg-slate-500"
                  />
                  <span>Queued prerequisite</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block w-5 border-t-2 border-dashed border-amber-700"
                  />
                  <span>Blocking prerequisite</span>
                </span>
              </div>
              <span className="text-slate-500 dark:text-slate-400">
                Click any task node to inspect dependencies and resolve blockers
              </span>
            </div>
          </div>

          {/* Right: Selected Node Dependency & Blocking Inspector */}
          <div className="xl:col-span-4 p-6 space-y-5 bg-white dark:bg-slate-900 [&_h3]:dark:text-slate-100 [&_h4]:dark:text-slate-200 [&_strong]:dark:text-slate-100">
            {selectedNode ? (
              <>
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                    <span className="font-mono font-semibold text-slate-900">
                      Step {selectedNode.task.stepOrder}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>Wave {selectedNode.waveIndex + 1}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-slate-700">
                      {selectedNode.task.tool}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-slate-900 leading-snug">
                    {selectedNode.task.description}
                  </h3>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 tabular-nums pt-0.5">
                    <span>
                      Status:{' '}
                      <strong className="text-slate-900 capitalize">
                        {selectedNode.task.status.replace(/_/g, ' ')}
                      </strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Verification:{' '}
                      <strong className="text-slate-900 capitalize">
                        {selectedNode.task.verificationStatus.replace(/_/g, ' ')}
                      </strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono">
                      Retries: {selectedNode.task.retryCount}/
                      {selectedNode.task.maxRetries}
                    </span>
                  </div>
                </div>

                {/* Blocking & Gating Diagnostics */}
                <div className="space-y-2.5">
                  <h4 className="text-xs font-semibold text-slate-800">
                    Blocking &amp; Eligibility Diagnostics (
                    {selectedNode.blockingIssues.length})
                  </h4>

                  {selectedNode.blockingIssues.length === 0 ? (
                    <div className="p-3 bg-emerald-50/70 border border-emerald-200 rounded-lg text-xs text-emerald-900 flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                      <span>
                        {selectedNode.visualState === 'verified' ||
                        selectedNode.visualState === 'completed'
                          ? 'Execution completed with all upstream prerequisites satisfied.'
                          : selectedNode.visualState === 'pending_verification'
                            ? 'Task executed; awaiting external or human outcome verification below.'
                            : 'All prerequisites, approvals, and execution providers are satisfied. Ready to execute.'}
                      </span>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
                      {selectedNode.blockingIssues.map((issue, idx) => (
                        <div key={`${issue.code}-${idx}`} className="p-3 space-y-2">
                          <div className="flex items-start gap-2">
                            {issue.severity === 'critical' ? (
                              <XCircle className="w-3.5 h-3.5 text-red-700 shrink-0 mt-0.5" />
                            ) : issue.severity === 'warning' ? (
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
                            ) : (
                              <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
                            )}
                            <div className="space-y-0.5 min-w-0 flex-1">
                              <p className="text-xs font-semibold text-slate-900">
                                {issue.headline}
                              </p>
                              <p className="text-xs text-slate-600 leading-relaxed">
                                {issue.detail}
                              </p>
                            </div>
                          </div>

                          {/* Contextual Remediation Control */}
                          {issue.remediation === 'approval_gate' && (
                            <button
                              type="button"
                              onClick={onOpenApprovalTab}
                              className="px-2.5 py-1 text-xs font-semibold text-amber-900 bg-amber-100 hover:bg-amber-200 rounded-md transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              <span>Open Approval Gate</span>
                              <ArrowRight className="w-3 h-3" />
                            </button>
                          )}

                          {issue.remediation === 'configure_provider' && (
                            <button
                              type="button"
                              onClick={onOpenIntegrationsTab}
                              className="px-2.5 py-1 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              <Settings className="w-3 h-3" />
                              <span>Configure Provider</span>
                            </button>
                          )}

                          {issue.remediation === 'inspect_upstream' &&
                            issue.relatedTaskId && (
                              <button
                                type="button"
                                onClick={() =>
                                  setSelectedTaskId(issue.relatedTaskId!)
                                }
                                className="px-2.5 py-1 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <span>Inspect Blocking Prerequisite</span>
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            )}

                          {issue.remediation === 'activate_goal' &&
                            goal.status !== 'completed' && (
                              <button
                                type="button"
                                disabled={busyAction !== null}
                                onClick={() =>
                                  onControlGoalExecution(goal.id, 'resume')
                                }
                                className="px-2.5 py-1 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 rounded-md transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <Play className="w-3 h-3" />
                                <span>Activate Goal Execution</span>
                              </button>
                            )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Direct Node Execution / Recovery Actions */}
                <div className="flex flex-wrap items-center gap-2">
                  {selectedNode.isReady && (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => onExecuteTask(selectedNode.id)}
                      className="px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>
                        {busyAction === `task:${selectedNode.id}`
                          ? 'Executing...'
                          : `Execute Step ${selectedNode.task.stepOrder}`}
                      </span>
                    </button>
                  )}

                  {selectedNode.task.reconciliationRequired ? (
                    onReconcileTask ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() =>
                            onReconcileTask(
                              selectedNode.id,
                              'reconcile_from_evidence'
                            )
                          }
                          className="px-2.5 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Reconcile from Evidence
                        </button>
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() =>
                            onReconcileTask(
                              selectedNode.id,
                              'mark_dispatched_pending_verification'
                            )
                          }
                          className="px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Mark Dispatched
                        </button>
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() =>
                            onReconcileTask(
                              selectedNode.id,
                              'confirm_not_executed_requeue'
                            )
                          }
                          className="px-2.5 py-1.5 text-xs font-medium text-amber-900 bg-amber-50 border border-amber-200 hover:bg-amber-100 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Confirm Not Sent &amp; Retry
                        </button>
                      </div>
                    ) : null
                  ) : (
                    (selectedNode.task.status === 'failed' ||
                      selectedNode.task.status === 'blocked' ||
                      Boolean(selectedNode.task.nextRetryAt)) && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => onRetryTask(selectedNode.id)}
                        className="px-3 py-1.5 text-xs font-semibold text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>
                          {busyAction === `requeue:${selectedNode.id}`
                            ? 'Re-queueing...'
                            : 'Manual Retry'}
                        </span>
                      </button>
                    )
                  )}
                </div>

                {/* Upstream Prerequisites & Downstream Dependents Navigation */}
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-4 pt-2 border-t border-slate-200">
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-semibold text-slate-800">
                      Prerequisites ({selectedNode.upstreamIds.length})
                    </h4>
                    {selectedNode.upstreamIds.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        Root task (no upstream prerequisites).
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {selectedNode.upstreamIds.map((upId) => {
                          const upNode = layout.nodesById[upId];
                          if (!upNode) return null;
                          const upMeta = getVisualStateMeta(upNode.visualState);
                          return (
                            <button
                              key={upId}
                              type="button"
                              aria-label={`Inspect prerequisite Step ${upNode.task.stepOrder}: ${upNode.task.description}`}
                              onClick={() => setSelectedTaskId(upId)}
                              className="w-full text-left px-2.5 py-1.5 text-xs border border-slate-200 rounded-md hover:bg-slate-50 flex items-center justify-between gap-2 cursor-pointer"
                            >
                              <span className="truncate text-slate-800">
                                <strong className="font-mono">
                                  Step {upNode.task.stepOrder}:
                                </strong>{' '}
                                {upNode.task.description}
                              </span>
                              <span
                                className={`font-semibold whitespace-nowrap shrink-0 ${upMeta.textClass}`}
                              >
                                {upMeta.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <h4 className="text-xs font-semibold text-slate-800">
                      Downstream Dependents ({selectedNode.downstreamIds.length})
                    </h4>
                    {selectedNode.downstreamIds.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        Terminal leaf task (no downstream dependents).
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {selectedNode.downstreamIds.map((downId) => {
                          const downNode = layout.nodesById[downId];
                          if (!downNode) return null;
                          const downMeta = getVisualStateMeta(
                            downNode.visualState
                          );
                          return (
                            <button
                              key={downId}
                              type="button"
                              aria-label={`Inspect dependent Step ${downNode.task.stepOrder}: ${downNode.task.description}`}
                              onClick={() => setSelectedTaskId(downId)}
                              className="w-full text-left px-2.5 py-1.5 text-xs border border-slate-200 rounded-md hover:bg-slate-50 flex items-center justify-between gap-2 cursor-pointer"
                            >
                              <span className="truncate text-slate-800">
                                <strong className="font-mono">
                                  Step {downNode.task.stepOrder}:
                                </strong>{' '}
                                {downNode.task.description}
                              </span>
                              <span
                                className={`font-semibold whitespace-nowrap shrink-0 ${downMeta.textClass}`}
                              >
                                {downMeta.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Expected Result & Verification Criteria */}
                <div className="pt-2 border-t border-slate-200 space-y-1 text-xs text-slate-600">
                  <p>
                    <strong className="text-slate-800">Expected Outcome:</strong>{' '}
                    {selectedNode.task.expectedResult}
                  </p>
                  <p>
                    <strong className="text-slate-800">Verification:</strong>{' '}
                    {selectedNode.task.verificationMethod}
                  </p>
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-500">
                Select a task node in the graph to view its dependency chain and
                blocking diagnostics.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
