import React, { useState, useEffect } from 'react';
import { X, AlertCircle } from 'lucide-react';
import type { GoalRecord, GoalStatus } from '../types';

interface GoalFormModalProps {
  isOpen: boolean;
  initialGoal?: GoalRecord | null;
  onClose: () => void;
  onSubmit: (payload: {
    problem: string;
    targetMetric: string;
    deadline: string | null;
    status: GoalStatus;
  }) => Promise<void>;
}

const GOAL_STATUS_OPTIONS: Array<{ value: GoalStatus; label: string }> = [
  { value: 'draft', label: 'Draft (Not yet planned)' },
  { value: 'planning', label: 'Planning (Reviewing tasks)' },
  { value: 'active', label: 'Active (Eligible tasks may run)' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export const GoalFormModal: React.FC<GoalFormModalProps> = ({
  isOpen,
  initialGoal,
  onClose,
  onSubmit,
}) => {
  const [problem, setProblem] = useState('');
  const [targetMetric, setTargetMetric] = useState('');
  const [deadlineDate, setDeadlineDate] = useState('');
  const [status, setStatus] = useState<GoalStatus>('draft');
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setProblem(initialGoal?.problem ?? '');
      setTargetMetric(initialGoal?.targetMetric ?? '');
      setDeadlineDate(toDateInputValue(initialGoal?.deadline));
      setStatus(initialGoal?.status ?? 'draft');
      setValidationError(null);
    }
  }, [isOpen, initialGoal]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    const trimmedProblem = problem.trim();
    const trimmedTarget = targetMetric.trim();

    if (!trimmedProblem) {
      setValidationError(
        'Please enter the goal description or problem to solve.'
      );
      return;
    }
    if (!trimmedTarget) {
      setValidationError(
        'Please specify a concrete, measurable desired target metric.'
      );
      return;
    }

    const isoDeadline = deadlineDate
      ? new Date(`${deadlineDate}T23:59:59.000Z`).toISOString()
      : null;

    setSubmitting(true);
    try {
      await onSubmit({
        problem: trimmedProblem,
        targetMetric: trimmedTarget,
        deadline: isoDeadline,
        status,
      });
      onClose();
    } catch (err: unknown) {
      setValidationError(
        err instanceof Error ? err.message : 'Failed to save goal.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const applyExample = () => {
    const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    setProblem('I need more paying customers for my business.');
    setTargetMetric('Acquire 3 paying customers.');
    setDeadlineDate(nextMonth);
    setStatus('planning');
    setValidationError(null);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="goal-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/55"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-xl text-slate-900 dark:text-slate-100">
        <div className="flex items-center justify-between gap-4">
          <h2
            id="goal-modal-title"
            className="text-lg font-semibold text-slate-900 dark:text-white"
          >
            {initialGoal ? 'Update Project Goal' : 'Create Project Goal'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close goal dialog"
            className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!initialGoal && (
          <div className="flex items-center justify-between gap-3 py-2 px-3 bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-600 dark:text-slate-300">
            <span>Need a starting example?</span>
            <button
              type="button"
              onClick={applyExample}
              className="font-semibold text-blue-700 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              Fill Customer Acquisition Example
            </button>
          </div>
        )}

        {validationError && (
          <div
            role="alert"
            className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-800 dark:text-red-200 flex items-start gap-2"
          >
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <span>{validationError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label
              htmlFor="goal-problem-input"
              className="block text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Goal Description / Stated Problem
            </label>
            <textarea
              id="goal-problem-input"
              rows={3}
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              placeholder="e.g., I need more paying customers for my B2B SaaS business."
              className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="goal-target-metric-input"
              className="block text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Target Metric (Desired Outcome)
            </label>
            <input
              id="goal-target-metric-input"
              type="text"
              value={targetMetric}
              onChange={(e) => setTargetMetric(e.target.value)}
              placeholder="e.g., Acquire 3 paying customers."
              className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              required
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Defines what success looks like. Target metrics are tracked
              separately from verified results.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                htmlFor="goal-deadline-input"
                className="block text-sm font-medium text-slate-800 dark:text-slate-200"
              >
                Target Deadline (Optional)
              </label>
              <input
                id="goal-deadline-input"
                type="date"
                value={deadlineDate}
                onChange={(e) => setDeadlineDate(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="goal-status-select"
                className="block text-sm font-medium text-slate-800 dark:text-slate-200"
              >
                Goal Lifecycle Status
              </label>
              <select
                id="goal-status-select"
                value={status}
                onChange={(e) => setStatus(e.target.value as GoalStatus)}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {GOAL_STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-semibold text-white dark:text-slate-950 bg-slate-900 dark:bg-slate-100 rounded-lg hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {submitting
                ? 'Saving...'
                : initialGoal
                  ? 'Save Changes'
                  : 'Create Goal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
