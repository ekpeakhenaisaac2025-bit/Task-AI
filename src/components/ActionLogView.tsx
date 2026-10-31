import React, { useState } from 'react';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { ActionLogRecord, ActionLogStatus, GoalRecord } from '../types';

interface ActionLogViewProps {
  logs: ActionLogRecord[];
  goals: GoalRecord[];
}

const LOG_FILTERS: Array<{ value: 'all' | ActionLogStatus; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'proposed', label: 'Proposed' },
  { value: 'approved', label: 'Approved' },
  { value: 'attempted', label: 'Attempted' },
  { value: 'completed', label: 'Completed' },
  { value: 'pending_verification', label: 'Pending Verification' },
  { value: 'verified', label: 'Verified' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'failed', label: 'Failed' },
];

function renderLogStatus(status: ActionLogStatus) {
  switch (status) {
    case 'verified':
      return (
        <span className="inline-flex items-center gap-1.5 text-emerald-700 font-semibold">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>verified</span>
        </span>
      );
    case 'pending_verification':
      return (
        <span className="inline-flex items-center gap-1.5 text-amber-800 font-semibold">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>pending_verification</span>
        </span>
      );
    case 'approved':
      return (
        <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>approved</span>
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1.5 text-blue-700 font-semibold">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>completed</span>
        </span>
      );
    case 'attempted':
      return (
        <span className="inline-flex items-center gap-1.5 text-slate-800 font-medium">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>attempted</span>
        </span>
      );
    case 'blocked':
      return (
        <span className="inline-flex items-center gap-1.5 text-amber-700 font-semibold">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>blocked</span>
        </span>
      );
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1.5 text-red-700 font-semibold">
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          <span>rejected</span>
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-red-700 font-semibold">
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          <span>failed</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-slate-600 font-medium">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>{status}</span>
        </span>
      );
  }
}

export const ActionLogView: React.FC<ActionLogViewProps> = ({
  logs,
  goals,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | ActionLogStatus>(
    'all'
  );
  const [goalFilter, setGoalFilter] = useState<string>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const filteredLogs = logs.filter((log) => {
    if (statusFilter !== 'all' && log.status !== statusFilter) return false;
    if (goalFilter !== 'all' && log.goalId !== goalFilter) return false;
    return true;
  });

  const toggleEvidence = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-slate-900">Action Log</h1>
          <p className="text-sm text-slate-600">
            Immutable lifecycle audit trail: proposed → approved → attempted →
            completed / pending_verification → verified, with provider and
            workspace attribution.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="log-goal-filter" className="text-xs text-slate-600">
            Goal:
          </label>
          <select
            id="log-goal-filter"
            value={goalFilter}
            onChange={(e) => setGoalFilter(e.target.value)}
            className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
          >
            <option value="all">All Goals</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.problem.slice(0, 48)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        role="group"
        aria-label="Filter action logs by lifecycle status"
        className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit"
      >
        {LOG_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatusFilter(f.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              statusFilter === f.value
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filteredLogs.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No action log entries match the selected filters.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {filteredLogs.map((log) => {
              const expanded = expandedIds.has(log.id);
              return (
                <div key={log.id} className="p-4 sm:px-6 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1 flex-1 min-w-[240px]">
                      <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
                        {renderLogStatus(log.status)}
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="font-mono text-slate-700">
                          {log.actionType}
                        </span>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="font-mono text-slate-600">
                          provider: {log.executionProvider}
                        </span>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="font-mono text-slate-500">
                          {log.taskId
                            ? `task: ${log.taskId.slice(0, 8)}`
                            : 'scope: goal'}
                        </span>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="font-mono text-slate-500">
                          {new Date(log.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-sm text-slate-900">
                        {log.resultSummary}
                      </p>
                      {log.errorMessage && (
                        <p className="text-xs text-red-700 font-medium">
                          Error: {log.errorMessage}
                        </p>
                      )}
                    </div>

                    {log.evidence && (
                      <button
                        type="button"
                        onClick={() => toggleEvidence(log.id)}
                        aria-expanded={expanded}
                        aria-label={`View evidence for ${log.actionType} at ${log.timestamp}`}
                        className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <span>Inspect Evidence</span>
                        {expanded ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>

                  {expanded && log.evidence && (
                    <pre className="p-3 bg-slate-900 text-slate-100 text-xs font-mono rounded-lg overflow-x-auto leading-relaxed">
                      {JSON.stringify(log.evidence, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
