import React from 'react';
import { Check, X, ShieldAlert, CheckCircle2, XCircle } from 'lucide-react';
import type { GoalRecord, TaskRecord } from '../types';

interface ApprovalGateViewProps {
  goals: GoalRecord[];
  tasks: TaskRecord[];
  onDecideApproval: (
    taskId: string,
    decision: 'approved' | 'rejected'
  ) => Promise<void>;
  busyAction: string | null;
}

export const ApprovalGateView: React.FC<ApprovalGateViewProps> = ({
  goals,
  tasks,
  onDecideApproval,
  busyAction,
}) => {
  const goalMap = new Map(goals.map((g) => [g.id, g]));
  const gatedTasks = tasks.filter((t) => t.approvalRequired);
  const pendingTasks = gatedTasks.filter((t) => t.approvalStatus === 'pending');
  const decidedTasks = gatedTasks.filter((t) => t.approvalStatus !== 'pending');

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">Approval Gate</h1>
        <p className="text-sm text-slate-600 max-w-3xl">
          Any task that spends money, contacts real people, sends messages,
          publishes content, or triggers external changes requires explicit
          approval before the worker can execute it. Retries never bypass this
          gate.
        </p>
      </div>

      {/* Pending Approvals */}
      <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
        <div className="px-6 py-4 flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-slate-900">
            Awaiting Your Decision ({pendingTasks.length})
          </h2>
          <span className="text-xs text-slate-500 tabular-nums">
            Unapproved tasks are strictly blocked from execution
          </span>
        </div>

        {pendingTasks.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No consequential actions are currently awaiting approval.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {pendingTasks.map((task) => {
              const goal = goalMap.get(task.goalId);
              const details = task.proposedActionDetails ?? {
                proposedAction: task.description,
                targetRecipient: 'External recipient or system',
                estimatedCost: '$0.00 direct platform fee',
                explanation:
                  'Consequential task requiring explicit human authorization before execution.',
              };

              return (
                <div key={task.id} className="p-6 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1 max-w-2xl">
                      <div className="flex items-center gap-2 text-xs text-amber-800 font-medium">
                        <ShieldAlert className="w-4 h-4 shrink-0" />
                        <span>Approval Required · Step {task.stepOrder}</span>
                        <span aria-hidden="true" className="text-slate-400">
                          ·
                        </span>
                        <span className="font-mono text-slate-600">
                          {task.tool}
                        </span>
                      </div>
                      <h3 className="text-base font-semibold text-slate-900">
                        {details.proposedAction}
                      </h3>
                      {goal && (
                        <p className="text-xs text-slate-500">
                          Goal: {goal.problem}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0">
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => onDecideApproval(task.id, 'rejected')}
                        aria-label={`Reject Step ${task.stepOrder}: ${task.description}`}
                        className="px-4 py-2 text-xs font-semibold text-red-700 bg-white border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Reject</span>
                      </button>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => onDecideApproval(task.id, 'approved')}
                        aria-label={`Approve Step ${task.stepOrder}: ${task.description}`}
                        className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Approve Action</span>
                      </button>
                    </div>
                  </div>

                  <dl className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-3 border-t border-slate-100 text-xs">
                    <div>
                      <dt className="font-medium text-slate-500">
                        Intended Recipient / Target
                      </dt>
                      <dd className="mt-1 text-slate-900 font-medium">
                        {details.targetRecipient}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Known Cost</dt>
                      <dd className="mt-1 text-slate-900 font-mono tabular-nums">
                        {details.estimatedCost}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">
                        What Will Happen
                      </dt>
                      <dd className="mt-1 text-slate-700 leading-relaxed">
                        {details.explanation}
                      </dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recorded Approval Decisions */}
      <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
        <div className="px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">
            Recorded Approval Decisions ({decidedTasks.length})
          </h2>
        </div>

        {decidedTasks.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">
            No approval decisions recorded yet.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {decidedTasks.map((task) => (
              <div
                key={task.id}
                className="px-6 py-4 flex flex-wrap items-center justify-between gap-4 text-sm"
              >
                <div className="space-y-0.5">
                  <p className="font-medium text-slate-900">
                    Step {task.stepOrder}: {task.description}
                  </p>
                  <p className="text-xs text-slate-500 font-mono tabular-nums">
                    Tool: {task.tool} · Decided at:{' '}
                    {task.approvalDecisionAt
                      ? new Date(task.approvalDecisionAt).toLocaleString()
                      : 'Recorded'}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {task.approvalStatus === 'approved' ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Approved</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700">
                      <XCircle className="w-4 h-4" />
                      <span>Rejected</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
