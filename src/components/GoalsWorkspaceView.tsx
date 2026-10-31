import React, { useState } from 'react';
import {
  Play,
  Plus,
  Edit3,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Cpu,
  Activity,
} from 'lucide-react';
import type { GoalRecord, GoalStatus, TaskRecord, TaskStatus } from '../types';

interface GoalsWorkspaceViewProps {
  goals: GoalRecord[];
  selectedGoalId: string | null;
  tasks: TaskRecord[];
  onSelectGoal: (goalId: string) => void;
  onOpenNewGoal: () => void;
  onOpenEditGoal: (goal: GoalRecord) => void;
  onUpdateGoalStatus: (goalId: string, status: GoalStatus) => Promise<void>;
  onGeneratePlan: (goalId: string) => Promise<void>;
  onRunNextWorker: (goalId: string) => Promise<void>;
  onExecuteTask: (taskId: string) => Promise<void>;
  onRequeueTask: (taskId: string) => Promise<void>;
  onOpenApprovalTab: () => void;
  onOpenMonitor: () => void;
  onOpenAddTask: () => void;
  busyAction: string | null;
  workerFeedback: {
    tone: 'neutral' | 'success' | 'warning' | 'error';
    text: string;
  } | null;
}

const GOAL_FILTERS: Array<{ value: 'all' | GoalStatus; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'planning', label: 'Planning' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
];

function formatShortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function renderTaskStatusText(status: TaskStatus) {
  switch (status) {
    case 'verified':
      return (
        <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>Verified</span>
        </span>
      );
    case 'pending_verification':
      return (
        <span className="inline-flex items-center gap-1.5 text-amber-800 font-medium">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>Pending Verification</span>
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1.5 text-blue-700 font-medium">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>Completed (Unverified)</span>
        </span>
      );
    case 'approved':
      return (
        <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>Approved &amp; Queued</span>
        </span>
      );
    case 'blocked':
      return (
        <span className="inline-flex items-center gap-1.5 text-amber-700 font-medium">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Blocked</span>
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-red-700 font-medium">
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Failed</span>
        </span>
      );
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1.5 text-red-700 font-medium">
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Rejected</span>
        </span>
      );
    case 'running':
      return (
        <span className="inline-flex items-center gap-1.5 text-blue-700 font-medium">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>Running</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-slate-600 font-medium">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>Queued</span>
        </span>
      );
  }
}

export const GoalsWorkspaceView: React.FC<GoalsWorkspaceViewProps> = ({
  goals,
  selectedGoalId,
  tasks,
  onSelectGoal,
  onOpenNewGoal,
  onOpenEditGoal,
  onUpdateGoalStatus,
  onGeneratePlan,
  onRunNextWorker,
  onExecuteTask,
  onRequeueTask,
  onOpenApprovalTab,
  onOpenMonitor,
  onOpenAddTask,
  busyAction,
  workerFeedback,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | GoalStatus>('all');
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(
    new Set()
  );

  const filteredGoals =
    statusFilter === 'all'
      ? goals
      : goals.filter((g) => g.status === statusFilter);

  const selectedGoal =
    goals.find((g) => g.id === selectedGoalId) ?? goals[0] ?? null;

  const goalTasks = selectedGoal
    ? tasks.filter((t) => t.goalId === selectedGoal.id)
    : [];

  const stepMap = new Map(goalTasks.map((t) => [t.id, t]));

  const toggleExpandTask = (id: string) => {
    setExpandedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (goals.length === 0) {
    return (
      <section className="bg-white border border-slate-200 rounded-xl p-10 text-center max-w-2xl mx-auto my-8 space-y-4">
        <h2 className="text-xl font-semibold text-slate-900">
          No Execution Goals in This Workspace
        </h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
          Define a goal description, measurable target metric, and optional
          deadline. The AI Planner produces capability-based tasks routed
          through your workspace&apos;s authorized execution providers.
        </p>
        <div className="pt-2">
          <button
            type="button"
            onClick={onOpenNewGoal}
            className="px-5 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Create First Goal
          </button>
        </div>
      </section>
    );
  }

  const formattedDeadline = selectedGoal
    ? formatShortDate(selectedGoal.deadline)
    : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left Sidebar: Workspace Goals List */}
      <aside className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900 tabular-nums">
              Goals ({goals.length})
            </h2>
            <button
              type="button"
              onClick={onOpenNewGoal}
              className="text-xs font-semibold text-blue-700 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              + New Goal
            </button>
          </div>

          <div
            role="group"
            aria-label="Filter goals by status"
            className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
          >
            {GOAL_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatusFilter(f.value)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  statusFilter === f.value
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {filteredGoals.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">
            No goals match the &ldquo;{statusFilter}&rdquo; filter.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {filteredGoals.map((goal) => {
              const isSelected = selectedGoal?.id === goal.id;
              const gTasks = tasks.filter((t) => t.goalId === goal.id);
              const doneCount = gTasks.filter(
                (t) =>
                  t.status === 'completed' ||
                  t.status === 'verified' ||
                  t.status === 'pending_verification'
              ).length;
              const itemDeadline = formatShortDate(goal.deadline);

              return (
                <button
                  key={goal.id}
                  type="button"
                  onClick={() => onSelectGoal(goal.id)}
                  className={`w-full text-left p-4 transition-colors cursor-pointer ${
                    isSelected ? 'bg-slate-50' : 'bg-white hover:bg-slate-50/70'
                  }`}
                >
                  <p className="text-sm font-semibold text-slate-900 line-clamp-2">
                    {goal.problem}
                  </p>
                  <p className="mt-1 text-xs text-slate-600 line-clamp-1">
                    Target: {goal.targetMetric}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                    <span className="capitalize font-medium text-slate-700">
                      {goal.status}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-emerald-700 font-medium">
                      {goal.progressPercent}% verified
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {doneCount}/{gTasks.length} steps run
                    </span>
                    {itemDeadline && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>Due {itemDeadline}</span>
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </aside>

      {/* Main Column: Goal Details, AI Planner & Execution Router Queue */}
      <section className="lg:col-span-8 space-y-6">
        {selectedGoal && (
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            {/* Goal Header & Controls */}
            <div className="p-6 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1.5 max-w-2xl">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                    <span className="capitalize font-semibold text-slate-800">
                      Status: {selectedGoal.status}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="capitalize text-slate-700">
                      Engine: {selectedGoal.executionState}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono font-semibold text-emerald-700">
                      Verified Progress: {selectedGoal.progressPercent}%
                    </span>
                    {formattedDeadline && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium text-slate-700">
                          Deadline: {formattedDeadline}
                        </span>
                      </>
                    )}
                  </div>
                  <h1 className="text-xl font-bold text-slate-900">
                    {selectedGoal.problem}
                  </h1>
                  <p className="text-sm text-slate-700">
                    <span className="font-medium text-slate-900">
                      Desired Target Metric:
                    </span>{' '}
                    {selectedGoal.targetMetric}{' '}
                    <span className="text-xs text-slate-500">
                      (Goal completes strictly when primary verified metric
                      satisfies target)
                    </span>
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => onOpenEditGoal(selectedGoal)}
                    aria-label="Edit selected goal"
                    className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>Edit Goal</span>
                  </button>

                  {selectedGoal.status !== 'active' ? (
                    <button
                      type="button"
                      disabled={
                        busyAction !== null ||
                        selectedGoal.status === 'completed'
                      }
                      onClick={() =>
                        onUpdateGoalStatus(selectedGoal.id, 'active')
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {selectedGoal.status === 'completed'
                        ? 'Goal Achieved'
                        : 'Activate Goal'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() =>
                        onUpdateGoalStatus(selectedGoal.id, 'planning')
                      }
                      className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Pause to Planning
                    </button>
                  )}
                </div>
              </div>

              {/* Execution Toolbar */}
              <div className="pt-2 flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => onGeneratePlan(selectedGoal.id)}
                  className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Cpu className="w-3.5 h-3.5" />
                  <span>
                    {busyAction === `plan:${selectedGoal.id}`
                      ? 'Planning Tasks...'
                      : 'Generate AI Plan'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={busyAction !== null || goalTasks.length === 0}
                  onClick={() => onRunNextWorker(selectedGoal.id)}
                  className="px-4 py-2 text-xs font-semibold text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>
                    {busyAction === `worker:${selectedGoal.id}`
                      ? 'Routing & Executing...'
                      : 'Run Next Eligible Task'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={onOpenMonitor}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>Open Monitor</span>
                </button>

                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={onOpenAddTask}
                  className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Task</span>
                </button>
              </div>

              {workerFeedback && (
                <div
                  role="status"
                  className={`p-3.5 rounded-lg border text-sm ${
                    workerFeedback.tone === 'error'
                      ? 'bg-red-50 border-red-200 text-red-900'
                      : workerFeedback.tone === 'warning'
                        ? 'bg-amber-50 border-amber-200 text-amber-900'
                        : workerFeedback.tone === 'success'
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                          : 'bg-slate-50 border-slate-200 text-slate-800'
                  }`}
                >
                  {workerFeedback.text}
                </div>
              )}
            </div>

            {/* Task Queue Section */}
            <div className="p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-slate-900 tabular-nums">
                  Task Queue ({goalTasks.length})
                </h2>
                <p className="text-xs text-slate-500">
                  Separates execution from independent outcome verification.
                </p>
              </div>

              {goalTasks.length === 0 ? (
                <div className="py-10 text-center space-y-2 border border-dashed border-slate-200 rounded-lg">
                  <p className="text-sm font-medium text-slate-800">
                    No tasks queued for this goal yet.
                  </p>
                  <p className="text-xs text-slate-500 max-w-md mx-auto">
                    Click &ldquo;Generate AI Plan&rdquo; to convert your goal
                    into capability-routed tasks, or &ldquo;Add Task&rdquo; to
                    enqueue a specific task.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
                  {goalTasks.map((task) => {
                    const isExpanded = expandedTaskIds.has(task.id);
                    const prereqLabels = task.dependencies.map((depId) => {
                      const dep = stepMap.get(depId);
                      return dep
                        ? `Step ${dep.stepOrder} (${dep.status})`
                        : depId.slice(0, 8);
                    });

                    return (
                      <div key={task.id} className="p-4 space-y-3 bg-white">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="space-y-1 flex-1 min-w-[240px]">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                              <span className="font-mono font-semibold text-slate-800">
                                Step {task.stepOrder}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono text-slate-700">
                                Proposed: {task.tool}
                              </span>
                              {task.assignedProvider && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono text-slate-700">
                                    Provider: {task.assignedProvider}
                                  </span>
                                </>
                              )}
                              <span aria-hidden="true">·</span>
                              {renderTaskStatusText(task.status)}
                              {task.retryCount > 0 && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono text-slate-600">
                                    Attempts: {task.retryCount}/
                                    {task.maxRetries + 1}
                                  </span>
                                </>
                              )}
                              {task.approvalRequired && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span
                                    className={`inline-flex items-center gap-1 font-medium ${
                                      task.approvalStatus === 'approved'
                                        ? 'text-emerald-700'
                                        : task.approvalStatus === 'rejected'
                                          ? 'text-red-700'
                                          : 'text-amber-700'
                                    }`}
                                  >
                                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                                    <span>Approval: {task.approvalStatus}</span>
                                  </span>
                                </>
                              )}
                            </div>

                            <h3 className="text-sm font-semibold text-slate-900">
                              {task.description}
                            </h3>

                            <div className="text-xs text-slate-600 space-y-0.5">
                              {task.requiredCapabilities.length > 0 && (
                                <p>
                                  <span className="font-medium text-slate-700">
                                    Required capabilities:
                                  </span>{' '}
                                  <span className="font-mono text-slate-700">
                                    {task.requiredCapabilities.join(', ')}
                                  </span>
                                </p>
                              )}
                              <p>
                                <span className="font-medium text-slate-700">
                                  Expected result:
                                </span>{' '}
                                {task.expectedResult}
                              </p>
                              <p>
                                <span className="font-medium text-slate-700">
                                  Verification criteria:
                                </span>{' '}
                                {task.verificationMethod}
                              </p>
                              {prereqLabels.length > 0 && (
                                <p>
                                  <span className="font-medium text-slate-700">
                                    Prerequisites:
                                  </span>{' '}
                                  {prereqLabels.join(', ')}
                                </p>
                              )}
                            </div>

                            {task.statusReason && (
                              <p
                                className={`text-xs pt-1 ${
                                  task.status === 'failed' ||
                                  task.status === 'rejected'
                                    ? 'text-red-700 font-medium'
                                    : task.status === 'blocked' ||
                                        task.status === 'pending_verification'
                                      ? 'text-amber-800 font-medium'
                                      : 'text-slate-600'
                                }`}
                              >
                                {task.statusReason}
                              </p>
                            )}
                          </div>

                          {/* Task Controls */}
                          <div className="flex flex-wrap items-center gap-2 shrink-0">
                            {task.approvalRequired &&
                              task.approvalStatus === 'pending' && (
                                <button
                                  type="button"
                                  onClick={onOpenApprovalTab}
                                  aria-label={`Review approval for Step ${task.stepOrder}`}
                                  className="px-3 py-1.5 text-xs font-semibold text-amber-900 bg-amber-100 hover:bg-amber-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  Review Approval
                                </button>
                              )}

                            {(task.status === 'queued' ||
                              task.status === 'approved') && (
                              <button
                                type="button"
                                disabled={busyAction !== null}
                                onClick={() => onExecuteTask(task.id)}
                                aria-label={`Run Step ${task.stepOrder}`}
                                className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <Play className="w-3 h-3" />
                                <span>
                                  {busyAction === `task:${task.id}`
                                    ? 'Running...'
                                    : 'Run Task'}
                                </span>
                              </button>
                            )}

                            {(task.status === 'blocked' ||
                              task.status === 'failed' ||
                              Boolean(task.nextRetryAt)) && (
                              <button
                                type="button"
                                disabled={busyAction !== null}
                                onClick={() => onRequeueTask(task.id)}
                                aria-label={`Re-queue Step ${task.stepOrder}`}
                                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>Re-queue</span>
                              </button>
                            )}

                            {task.outputData && (
                              <button
                                type="button"
                                onClick={() => toggleExpandTask(task.id)}
                                aria-expanded={isExpanded}
                                aria-label={`Toggle output evidence for Step ${task.stepOrder}`}
                                className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 rounded-md transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <span>Evidence</span>
                                {isExpanded ? (
                                  <ChevronUp className="w-3.5 h-3.5" />
                                ) : (
                                  <ChevronDown className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>

                        {isExpanded && task.outputData && (
                          <div className="pt-2 border-t border-slate-100">
                            <pre className="p-3 bg-slate-900 text-slate-100 text-xs font-mono rounded-lg overflow-x-auto leading-relaxed">
                              {JSON.stringify(task.outputData, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
