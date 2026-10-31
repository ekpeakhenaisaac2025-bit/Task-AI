import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Play,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import {
  WorkspaceMutationConfirmModal,
  type WorkspaceMutationConfirmationRequest,
} from '../integrations/WorkspaceMutationConfirmModal';
import type {
  ChatExecutionTrace,
  ExecutionStageItem,
  ExecutionStageStatus,
  TaskRecord,
} from '../../types';

interface ExecutionActivityPanelProps {
  trace: ChatExecutionTrace;
  goalTasks: TaskRecord[];
  busyAction: string | null;
  onDecideApproval: (
    taskId: string,
    decision: 'approved' | 'rejected'
  ) => Promise<void>;
  onRunGoalWave: (goalId: string) => Promise<void>;
  onInspectProject: (goalId: string) => void;
}

function getStageStatusPresentation(status: ExecutionStageStatus): {
  label: string;
  textClass: string;
  icon: React.ReactNode;
} {
  switch (status) {
    case 'completed':
      return {
        label: 'Completed',
        textClass: 'text-emerald-700 dark:text-emerald-400',
        icon: (
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
        ),
      };
    case 'running':
      return {
        label: 'Running',
        textClass: 'text-blue-700 dark:text-blue-400',
        icon: (
          <Loader2 className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-spin shrink-0" />
        ),
      };
    case 'awaiting_approval':
      return {
        label: 'Approval Gate',
        textClass: 'text-amber-700 dark:text-amber-400',
        icon: (
          <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
        ),
      };
    case 'pending_verification':
      return {
        label: 'Pending Proof',
        textClass: 'text-amber-700 dark:text-amber-400',
        icon: (
          <Clock className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
        ),
      };
    case 'blocked':
      return {
        label: 'Blocked',
        textClass: 'text-amber-800 dark:text-amber-400',
        icon: (
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
        ),
      };
    case 'failed':
      return {
        label: 'Failed',
        textClass: 'text-red-700 dark:text-red-400',
        icon: (
          <XCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
        ),
      };
    case 'pending':
    default:
      return {
        label: 'Queued',
        textClass: 'text-slate-500 dark:text-slate-400',
        icon: (
          <Clock className="w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0" />
        ),
      };
  }
}

const StageRow: React.FC<{ stage: ExecutionStageItem; index: number }> = ({
  stage,
  index,
}) => {
  const [open, setOpen] = useState(
    stage.status === 'awaiting_approval' ||
      stage.status === 'failed' ||
      stage.status === 'blocked'
  );
  const pres = getStageStatusPresentation(stage.status);
  const hasDetails = Boolean(stage.details && stage.details.length > 0);

  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <div className="mt-0.5">{pres.icon}</div>
          <div className="min-w-0 flex-1">
            {hasDetails ? (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((prev) => !prev)}
                className="w-full text-left flex items-center justify-between gap-2 group cursor-pointer"
              >
                <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 group-hover:underline">
                  {String(index + 1).padStart(2, '0')}. {stage.label}
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs shrink-0 tabular-nums">
                  <span className={`font-medium ${pres.textClass}`}>
                    {pres.label}
                  </span>
                  {open ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </span>
              </button>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {String(index + 1).padStart(2, '0')}. {stage.label}
                </span>
                <span className={`text-xs font-medium shrink-0 ${pres.textClass}`}>
                  {pres.label}
                </span>
              </div>
            )}

            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5 leading-relaxed">
              {stage.summary}
            </p>

            {open && hasDetails && (
              <ul className="mt-2 space-y-1 pl-3 border-l border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 font-mono">
                {stage.details!.map((line, dIdx) => (
                  <li key={dIdx} className="leading-relaxed break-words">
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const ExecutionActivityPanel: React.FC<ExecutionActivityPanelProps> = ({
  trace,
  goalTasks,
  busyAction,
  onDecideApproval,
  onRunGoalWave,
  onInspectProject,
}) => {
  const [panelOpen, setPanelOpen] = useState(true);
  const [confirmMutation, setConfirmMutation] =
    useState<WorkspaceMutationConfirmationRequest | null>(null);

  const terminalStage = trace.stages[trace.stages.length - 1];
  const headerPres = getStageStatusPresentation(
    trace.stages.some((s) => s.status === 'running')
      ? 'running'
      : terminalStage?.status ?? 'pending'
  );

  const pendingApprovalTasks = goalTasks.filter(
    (t) =>
      t.approvalRequired &&
      t.approvalStatus === 'pending' &&
      t.status !== 'rejected'
  );

  const eligibleApprovedTasks = goalTasks.filter(
    (t) =>
      (t.status === 'queued' || t.status === 'approved') &&
      (!t.approvalRequired || t.approvalStatus === 'approved')
  );

  const completedStagesCount = trace.stages.filter(
    (s) => s.status === 'completed'
  ).length;

  return (
    <section
      aria-label="Task execution activity"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 overflow-hidden"
    >
      {/* Expandable Activity Summary Header */}
      <button
        type="button"
        aria-expanded={panelOpen}
        onClick={() => setPanelOpen((prev) => !prev)}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-slate-100/70 dark:hover:bg-slate-800/40 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {headerPres.icon}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                Execution Activity
              </span>
              <span aria-hidden="true" className="text-slate-400">
                ·
              </span>
              <span className={`font-medium ${headerPres.textClass}`}>
                {trace.hasVerifiedBusinessOutcome
                  ? 'Verified Outcome Recorded'
                  : pendingApprovalTasks.length > 0 ||
                      trace.awaitingApprovalCount > 0
                    ? `Paused at Approval Gate (${pendingApprovalTasks.length || trace.awaitingApprovalCount})`
                    : headerPres.label}
              </span>
              <span aria-hidden="true" className="text-slate-400">
                ·
              </span>
              <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                {completedStagesCount}/{trace.stages.length} stages
              </span>
            </div>
          </div>
        </div>

        <span className="text-xs font-medium text-slate-500 dark:text-slate-400 inline-flex items-center gap-1 shrink-0">
          <span>{panelOpen ? 'Hide details' : 'Show details'}</span>
          {panelOpen ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </span>
      </button>

      {panelOpen && (
        <div className="px-4 pb-4 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-4">
          {/* Target vs Verified Honesty Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400 pb-2.5 border-b border-slate-200/80 dark:border-slate-800/80 tabular-nums">
            <span>
              Target metric:{' '}
              <strong className="text-slate-900 dark:text-slate-200 font-medium">
                {trace.targetMetric}
              </strong>
            </span>
            <span>
              External outcome verified:{' '}
              <strong
                className={
                  trace.hasVerifiedBusinessOutcome
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-800 dark:text-slate-300'
                }
              >
                {trace.hasVerifiedBusinessOutcome
                  ? 'Yes (Evidence-backed)'
                  : 'No (0 verified external outcomes)'}
              </strong>
            </span>
          </div>

          {/* 7-Stage Lifecycle */}
          <div className="divide-y divide-slate-200/70 dark:divide-slate-800/70">
            {trace.stages.map((stage, idx) => (
              <StageRow key={stage.key} stage={stage} index={idx} />
            ))}
          </div>

          {/* Inline Approval Gate Controls (when consequential tasks require human approval) */}
          {pendingApprovalTasks.length > 0 && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 p-3.5 space-y-3">
              <div className="space-y-0.5">
                <p className="text-xs font-semibold text-amber-900 dark:text-amber-300">
                  Approval Gate — Human Authorization Required (
                  {pendingApprovalTasks.length})
                </p>
                <p className="text-xs text-amber-800/90 dark:text-amber-300/80">
                  Consequential actions (sending messages, external webhooks, CRM
                  or calendar mutations) never execute without explicit approval.
                </p>
              </div>

              <div className="space-y-2.5">
                {pendingApprovalTasks.map((task) => {
                  const isApproving = busyAction === `approval:${task.id}`;
                  return (
                    <div
                      key={task.id}
                      className="rounded-lg border border-amber-200/80 dark:border-amber-800/50 bg-white dark:bg-slate-950/70 p-3 flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                          Step {task.stepOrder}: {task.description}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-400">
                          <span className="font-mono">
                            {task.assignedProvider || task.tool}
                          </span>
                          {task.proposedActionDetails?.targetRecipient && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>
                                Target:{' '}
                                {task.proposedActionDetails.targetRecipient}
                              </span>
                            </>
                          )}
                          {task.proposedActionDetails?.estimatedCost && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>
                                Cost: {task.proposedActionDetails.estimatedCost}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => {
                            const providerLabel =
                              task.assignedProvider || task.tool;
                            setConfirmMutation({
                              title: `Confirm Action on ${providerLabel}?`,
                              description:
                                'Approving this step authorizes Task.ai to execute a consequential or mutating action on your connected account or external endpoint.',
                              targetSummary: `Step ${task.stepOrder}: ${task.description}`,
                              affectedItems: [
                                `Connector: ${providerLabel}`,
                                ...(task.proposedActionDetails?.targetRecipient
                                  ? [
                                      `Target: ${task.proposedActionDetails.targetRecipient}`,
                                    ]
                                  : []),
                              ],
                              confirmLabel: 'Confirm & Approve Action',
                              onConfirm: async () => {
                                await onDecideApproval(task.id, 'approved');
                                setConfirmMutation(null);
                              },
                            });
                          }}
                          aria-label={`Approve Step ${task.stepOrder}: ${task.description}`}
                          className="min-h-[34px] px-3 py-1 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {isApproving ? 'Saving...' : 'Approve'}
                        </button>
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => onDecideApproval(task.id, 'rejected')}
                          aria-label={`Reject Step ${task.stepOrder}: ${task.description}`}
                          className="min-h-[34px] px-3 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Honest Completion Summary + Quick Execution Controls */}
          <div className="pt-2 border-t border-slate-200/80 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-600 dark:text-slate-400 flex-1 min-w-[220px] leading-relaxed">
              {trace.honestCompletionNote}
            </p>

            {trace.goalId && (
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {eligibleApprovedTasks.length > 0 && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => onRunGoalWave(trace.goalId!)}
                    className="min-h-[34px] px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>
                      {busyAction?.startsWith(`orchestrate:${trace.goalId}`)
                        ? 'Running...'
                        : `Run Ready Tasks (${eligibleApprovedTasks.length})`}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => onInspectProject(trace.goalId!)}
                  className="min-h-[34px] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span>Inspect Task Graph</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <WorkspaceMutationConfirmModal
        request={confirmMutation}
        busy={busyAction !== null}
        onCancel={() => setConfirmMutation(null)}
      />
    </section>
  );
};
