import React, { useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Cpu,
  KeyRound,
  Send,
  Plus,
  Ban,
} from 'lucide-react';
import type {
  EvidenceType,
  ExecutionMonitorSnapshot,
  GoalMetricValueRecord,
  GoalRecord,
  OutcomeEvidenceRecord,
  TaskRecord,
  ToolRegistryItem,
} from '../types';
import { TaskDagVisualizer } from './TaskDagVisualizer';

interface ExecutionMonitorViewProps {
  workspaceId: string;
  workspaceName: string;
  goals: GoalRecord[];
  selectedGoalId: string | null;
  tasks: TaskRecord[];
  tools: ToolRegistryItem[];
  snapshot: ExecutionMonitorSnapshot | null;
  busyAction: string | null;
  onSelectGoal: (goalId: string) => void;
  onOpenNewGoal: () => void;
  onOpenAddTask: () => void;
  onOpenApprovalTab: () => void;
  onOpenIntegrationsTab: () => void;
  onGeneratePlan: (goalId: string) => Promise<void>;
  onExecuteTask: (taskId: string) => Promise<void>;
  onOrchestrateGoal: (
    goalId: string,
    concurrencyMode: 'sequential' | 'parallel_safe',
    autoRunReasoning: boolean
  ) => Promise<void>;
  onControlGoalExecution: (
    goalId: string,
    action: 'pause' | 'resume' | 'cancel'
  ) => Promise<void>;
  onRetryTask: (taskId: string) => Promise<void>;
  onReconcileTask: (
    taskId: string,
    resolution:
      | 'reconcile_from_evidence'
      | 'mark_dispatched_pending_verification'
      | 'confirm_not_executed_requeue'
  ) => Promise<void>;
  onRotateInboundSecret: () => Promise<string>;
  onSendSignedWebhook: (params: {
    signingSecret: string;
    payload: {
      externalEventId: string;
      provider: string;
      evidenceType: EvidenceType;
      summary: string;
      goalId?: string;
      taskId?: string | null;
      externalReferenceId?: string | null;
      requiresHumanReview?: boolean;
      structuredMetrics?: Record<string, unknown>;
    };
  }) => Promise<{
    duplicate: boolean;
    message?: string;
    verificationState?: string;
    provenanceClass?: string;
  }>;
  onSubmitManualEvidence: (payload: {
    goalId: string;
    taskId?: string | null;
    provider?: string;
    evidenceType: EvidenceType;
    summary: string;
    externalReferenceId?: string | null;
    structuredMetrics?: Record<string, unknown>;
  }) => Promise<void>;
  onReviewEvidence: (
    evidenceId: string,
    decision: 'verified' | 'rejected',
    notes: string
  ) => Promise<void>;
  onAiVerifyEvidence: (evidenceId: string) => Promise<void>;
  onRunReasoning: (goalId: string) => Promise<void>;
  onDecideProposal: (
    proposalId: string,
    decision: 'accept' | 'reject'
  ) => Promise<void>;
}

const EVIDENCE_TYPE_OPTIONS: Array<{ value: EvidenceType; label: string }> = [
  { value: 'customer_acquired', label: 'customer_acquired (Verified Customer)' },
  { value: 'payment_confirmed', label: 'payment_confirmed (Settled Payment)' },
  { value: 'meeting_booked', label: 'meeting_booked (Booked Discovery Call)' },
  { value: 'reply_received', label: 'reply_received (Inbound Reply)' },
  { value: 'qualified_lead', label: 'qualified_lead (Qualified Prospect)' },
  { value: 'prospect_identified', label: 'prospect_identified (Prospect Record)' },
  { value: 'message_delivered', label: 'message_delivered (Delivery Receipt)' },
  {
    value: 'outcome_reversal',
    label: 'outcome_reversal (Refund / Chargeback / Cancelled Outcome)',
  },
  { value: 'custom_outcome', label: 'custom_outcome (Custom Metric Event)' },
  {
    value: 'api_dispatch_ack',
    label: 'api_dispatch_ack (HTTP 200 Ack Only — Stays Unverified)',
  },
];

function formatIntegrationClassification(
  cls: ToolRegistryItem['integrationClassification']
): string {
  switch (cls) {
    case 'native_implemented':
      return 'Native Runtime';
    case 'generic_webhook_adapter':
      return 'Generic Webhook Adapter';
    case 'partially_implemented':
      return 'HTTPS Relay Bridge (Non-Native)';
    case 'registered_unavailable':
    default:
      return 'Registered · Unavailable';
  }
}

function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatMetricValue(
  value: number,
  unit: GoalMetricValueRecord['unit']
): string {
  if (unit === 'USD') return `$${value.toFixed(2)}`;
  if (unit === 'NGN') return `₦${value.toLocaleString()}`;
  if (unit === 'EUR') return `€${value.toFixed(2)}`;
  if (unit === 'GBP') return `£${value.toFixed(2)}`;
  if (unit === 'percent') return `${value}%`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function renderVerificationState(
  state: OutcomeEvidenceRecord['verificationState']
) {
  if (state === 'verified') {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-700 font-semibold">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        <span>Verified</span>
      </span>
    );
  }
  if (state === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1.5 text-red-700 font-semibold">
        <XCircle className="w-3.5 h-3.5 shrink-0" />
        <span>Rejected</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-amber-800 font-semibold">
      <Clock className="w-3.5 h-3.5 shrink-0" />
      <span>Pending Verification</span>
    </span>
  );
}

export const ExecutionMonitorView: React.FC<ExecutionMonitorViewProps> = ({
  workspaceName,
  goals,
  selectedGoalId,
  tasks,
  tools,
  snapshot,
  busyAction,
  onSelectGoal,
  onOpenNewGoal,
  onOpenAddTask,
  onOpenApprovalTab,
  onOpenIntegrationsTab,
  onGeneratePlan,
  onExecuteTask,
  onOrchestrateGoal,
  onControlGoalExecution,
  onRetryTask,
  onReconcileTask,
  onRotateInboundSecret,
  onSendSignedWebhook,
  onSubmitManualEvidence,
  onReviewEvidence,
  onAiVerifyEvidence,
  onRunReasoning,
  onDecideProposal,
}) => {
  const [autoReasonAfterWave, setAutoReasonAfterWave] = useState(false);
  const [scopeToSelectedGoal, setScopeToSelectedGoal] = useState(true);

  // Inbound Webhook & Evidence Workbench State
  const [oneTimeSigningSecret, setOneTimeSigningSecret] = useState('');
  const [evidencePanelOpen, setEvidencePanelOpen] = useState(false);
  const [submissionMode, setSubmissionMode] = useState<
    'signed_webhook' | 'manual_entry'
  >('signed_webhook');
  const [evType, setEvType] = useState<EvidenceType>('customer_acquired');
  const [evTaskId, setEvTaskId] = useState<string>('');
  const [evProvider, setEvProvider] = useState('custom_webhook');
  const [evExternalEventId, setEvExternalEventId] = useState(
    () => `evt_${Math.random().toString(36).slice(2, 10)}`
  );
  const [evExternalRef, setEvExternalRef] = useState('inv_paid_001');
  const [evSummary, setEvSummary] = useState(
    'Confirmed customer invoice settled via external payment webhook'
  );
  const [evMetricCount, setEvMetricCount] = useState('1');
  const [evRevenueUsd, setEvRevenueUsd] = useState('0');
  const [evRequiresHuman, setEvRequiresHuman] = useState(false);
  const [evidenceFeedback, setEvidenceFeedback] = useState<{
    tone: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [submittingEvidence, setSubmittingEvidence] = useState(false);

  // Per-evidence reviewer notes map
  const [reviewNotesById, setReviewNotesById] = useState<
    Record<string, string>
  >({});
  const [reviewError, setReviewError] = useState<string | null>(null);

  const selectedGoal =
    goals.find((g) => g.id === selectedGoalId) ?? goals[0] ?? null;

  if (!snapshot) {
    return (
      <div className="p-8 bg-white border border-slate-200 rounded-xl text-sm text-slate-500">
        Loading workspace execution monitor telemetry...
      </div>
    );
  }

  const { counts, inboundWebhook } = snapshot;

  const operationalKpis: Array<{
    label: string;
    value: string | number;
    detail: string;
  }> = [
    {
      label: 'Active goals',
      value: counts.activeGoals,
      detail: `${goals.length} total in workspace`,
    },
    {
      label: 'Queued tasks',
      value: counts.queuedTasks,
      detail: 'Eligible or awaiting wave',
    },
    {
      label: 'Running tasks',
      value: counts.runningTasks,
      detail: 'Active DB execution locks',
    },
    {
      label: 'Completed executions',
      value: counts.completedTasks,
      detail: 'Executed (unverified)',
    },
    {
      label: 'Pending verification',
      value: counts.pendingVerificationTasks,
      detail: 'Awaiting outcome proof',
    },
    {
      label: 'Verified outcomes',
      value: counts.verifiedOutcomes,
      detail: 'Cryptographic / human verified',
    },
    {
      label: 'Failed tasks',
      value: counts.failedTasks,
      detail: 'Exhausted retry policy',
    },
    {
      label: 'Blocked tasks',
      value: counts.blockedTasks,
      detail: 'Halted by safety gates',
    },
    {
      label: 'Awaiting approval',
      value: counts.awaitingApprovalTasks,
      detail: 'Consequential actions gated',
    },
    {
      label: 'Retry attempts',
      value: counts.totalRetryAttempts,
      detail: 'Exponential backoff retries',
    },
    {
      label: 'Execution duration',
      value: formatDurationMs(counts.totalExecutionDurationMs),
      detail: 'Cumulative attempt runtime',
    },
    {
      label: 'Provider availability',
      value: `${counts.readyProvidersCount}/${tools.length}`,
      detail: 'Verified routing adapters',
    },
  ];

  const goalTasks = selectedGoal
    ? tasks.filter((t) => t.goalId === selectedGoal.id)
    : [];

  const filteredMetrics =
    scopeToSelectedGoal && selectedGoal
      ? snapshot.goalMetrics.filter((m) => m.goalId === selectedGoal.id)
      : snapshot.goalMetrics;

  const filteredEvidence =
    scopeToSelectedGoal && selectedGoal
      ? snapshot.evidence.filter((e) => e.goalId === selectedGoal.id)
      : snapshot.evidence;

  const filteredVerifications =
    scopeToSelectedGoal && selectedGoal
      ? snapshot.verifications.filter((v) => v.goalId === selectedGoal.id)
      : snapshot.verifications;

  const filteredCycles =
    scopeToSelectedGoal && selectedGoal
      ? snapshot.reasoningCycles.filter((c) => c.goalId === selectedGoal.id)
      : snapshot.reasoningCycles;

  const filteredProposals =
    scopeToSelectedGoal && selectedGoal
      ? snapshot.proposals.filter((p) => p.goalId === selectedGoal.id)
      : snapshot.proposals;

  const filteredAttempts =
    scopeToSelectedGoal && selectedGoal
      ? snapshot.attempts.filter((a) => a.goalId === selectedGoal.id)
      : snapshot.attempts;

  const filteredRuns =
    scopeToSelectedGoal && selectedGoal
      ? snapshot.runs.filter((r) => r.goalId === selectedGoal.id)
      : snapshot.runs;

  const recoverableTasks = (
    scopeToSelectedGoal && selectedGoal ? goalTasks : tasks
  ).filter(
    (t) =>
      t.status === 'failed' ||
      t.status === 'blocked' ||
      Boolean(t.nextRetryAt)
  );

  const handleRotateSecretClick = async () => {
    setEvidenceFeedback(null);
    try {
      const secret = await onRotateInboundSecret();
      setOneTimeSigningSecret(secret);
      setEvidencePanelOpen(true);
      setSubmissionMode('signed_webhook');
      setEvidenceFeedback({
        tone: 'success',
        text: 'Generated new HMAC-SHA256 signing secret for this workspace. Copy it now—subsequent loads only show the masked hint.',
      });
    } catch (err: unknown) {
      setEvidenceFeedback({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to rotate inbound webhook secret.',
      });
    }
  };

  const buildStructuredMetricsPayload = (): Record<string, unknown> => {
    const countNum = Number(evMetricCount);
    const revNum = Number(evRevenueUsd);
    const metrics: Record<string, unknown> = {};
    if (evType === 'outcome_reversal') {
      if (Number.isFinite(countNum) && countNum !== 0) {
        const negCount = -Math.abs(countNum);
        metrics.count = negCount;
        metrics.customers = negCount;
      }
      if (Number.isFinite(revNum) && revNum !== 0) {
        metrics.refundAmountUsd = Math.abs(revNum);
      }
      return metrics;
    }
    if (Number.isFinite(countNum) && countNum > 0) {
      metrics.count = countNum;
      if (evType === 'customer_acquired') metrics.customers = countNum;
      if (evType === 'meeting_booked') metrics.meetings = countNum;
      if (evType === 'reply_received') metrics.replies = countNum;
      if (evType === 'qualified_lead') metrics.qualifiedLeads = countNum;
      if (evType === 'prospect_identified') metrics.prospects = countNum;
    }
    if (Number.isFinite(revNum) && revNum > 0) {
      metrics.revenueUsd = revNum;
    }
    return metrics;
  };

  const handleEvidenceSubmit = async (
    e: React.FormEvent,
    keepSameEventId = false
  ) => {
    e.preventDefault();
    if (!selectedGoal) {
      setEvidenceFeedback({
        tone: 'error',
        text: 'Create and select a goal before submitting outcome evidence.',
      });
      return;
    }
    if (!evSummary.trim()) {
      setEvidenceFeedback({
        tone: 'error',
        text: 'Outcome evidence summary is required.',
      });
      return;
    }

    setSubmittingEvidence(true);
    setEvidenceFeedback(null);

    try {
      const structuredMetrics = buildStructuredMetricsPayload();
      if (submissionMode === 'signed_webhook') {
        if (!oneTimeSigningSecret.trim()) {
          setEvidenceFeedback({
            tone: 'error',
            text: 'Provide or rotate the workspace HMAC-SHA256 signing secret to dispatch a signed inbound webhook.',
          });
          setSubmittingEvidence(false);
          return;
        }
        const eventIdToUse =
          evExternalEventId.trim() ||
          `evt_${Math.random().toString(36).slice(2, 10)}`;

        const res = await onSendSignedWebhook({
          signingSecret: oneTimeSigningSecret.trim(),
          payload: {
            externalEventId: eventIdToUse,
            provider: evProvider.trim() || 'custom_webhook',
            evidenceType: evType,
            summary: evSummary.trim(),
            goalId: selectedGoal.id,
            taskId: evTaskId || null,
            externalReferenceId: evExternalRef.trim() || null,
            requiresHumanReview: evRequiresHuman,
            structuredMetrics,
          },
        });

        if (res.duplicate) {
          if (!keepSameEventId) {
            setEvExternalEventId(
              `evt_${Math.random().toString(36).slice(2, 10)}`
            );
          }
          setEvidenceFeedback({
            tone: 'warning',
            text: !keepSameEventId
              ? `Event "${eventIdToUse}" was already ingested (duplicate ignored idempotently). Generated a fresh Event ID for your next dispatch.`
              : res.message ||
                `Duplicate event "${eventIdToUse}" detected and ignored idempotently.`,
          });
        } else {
          if (!keepSameEventId) {
            setEvExternalEventId(
              `evt_${Math.random().toString(36).slice(2, 10)}`
            );
          }
          if (res.verificationState === 'verified') {
            setEvidenceFeedback({
              tone: 'success',
              text: `Signed webhook event "${eventIdToUse}" corroborated (${res.provenanceClass ?? 'provider_confirmed'}) and verified.`,
            });
          } else {
            setEvidenceFeedback({
              tone: 'warning',
              text: `Signed webhook event "${eventIdToUse}" authenticated (${res.provenanceClass ?? 'authenticated_webhook'}) and held in Pending Verification. Approve with reviewer notes below or corroborate via verified provider integration.`,
            });
          }
        }
      } else {
        await onSubmitManualEvidence({
          goalId: selectedGoal.id,
          taskId: evTaskId || null,
          provider: evProvider.trim() || 'manual_workspace_entry',
          evidenceType: evType,
          summary: evSummary.trim(),
          externalReferenceId: evExternalRef.trim() || null,
          structuredMetrics,
        });
        setEvidenceFeedback({
          tone: 'success',
          text: 'Manual outcome evidence recorded as Pending Verification. Approve with reviewer notes below to count toward goal progress.',
        });
      }
    } catch (err: unknown) {
      setEvidenceFeedback({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Evidence ingestion failed.',
      });
    } finally {
      setSubmittingEvidence(false);
    }
  };

  const handleHumanDecision = async (
    evidenceId: string,
    decision: 'verified' | 'rejected'
  ) => {
    setReviewError(null);
    const notes = (reviewNotesById[evidenceId] ?? '').trim();
    if (notes.length < 3) {
      setReviewError(
        'Enter reviewer notes (at least 3 characters) before approving or rejecting outcome evidence.'
      );
      return;
    }
    try {
      await onReviewEvidence(evidenceId, decision, notes);
      setReviewNotesById((prev) => ({ ...prev, [evidenceId]: '' }));
    } catch (err: unknown) {
      setReviewError(
        err instanceof Error
          ? err.message
          : 'Failed to submit human verification review.'
      );
    }
  };

  return (
    <div className="space-y-8">
      {/* Page Title & Scope Filter */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-slate-900">
            Execution Monitor & Verification Engine
          </h1>
          <p className="text-sm text-slate-600 max-w-3xl">
            Live orchestration, retry recovery, HMAC-signed inbound evidence
            ingestion, independent outcome verification, and continuous AI
            reasoning for{' '}
            <span className="font-semibold text-slate-900">
              {workspaceName}
            </span>
            .
          </p>
        </div>

        <div
          role="group"
          aria-label="Monitor scope filter"
          className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0"
        >
          <button
            type="button"
            onClick={() => setScopeToSelectedGoal(true)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              scopeToSelectedGoal
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Selected Goal
          </button>
          <button
            type="button"
            onClick={() => setScopeToSelectedGoal(false)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              !scopeToSelectedGoal
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Entire Workspace
          </button>
        </div>
      </div>

      {/* 12 Operational Telemetry Metrics (Single-Elevation Hairline Grid) */}
      <section
        aria-label="Operational execution metrics"
        className="bg-white border border-slate-200 rounded-xl overflow-hidden"
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
          {operationalKpis.slice(0, 6).map((kpi) => (
            <div key={kpi.label} className="p-4 space-y-1">
              <p className="text-xs font-medium text-slate-500">{kpi.label}</p>
              <p className="text-2xl font-bold text-slate-900 font-mono tabular-nums">
                {kpi.value}
              </p>
              <p className="text-xs text-slate-500 leading-snug">
                {kpi.detail}
              </p>
            </div>
          ))}
        </div>
        <div className="border-t border-slate-200 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
          {operationalKpis.slice(6, 12).map((kpi) => (
            <div key={kpi.label} className="p-4 space-y-1">
              <p className="text-xs font-medium text-slate-500">{kpi.label}</p>
              <p className="text-2xl font-bold text-slate-900 font-mono tabular-nums">
                {kpi.value}
              </p>
              <p className="text-xs text-slate-500 leading-snug">
                {kpi.detail}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Orchestrator Control Bar */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        {goals.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-slate-900">
                No Goals Available for Orchestration
              </h2>
              <p className="text-xs text-slate-500">
                Create a goal with a measurable target metric to launch wave
                execution and outcome verification.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenNewGoal}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Create First Goal
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[260px]">
                <label
                  htmlFor="monitor-goal-select"
                  className="text-xs font-semibold text-slate-700 whitespace-nowrap"
                >
                  Target Goal:
                </label>
                <select
                  id="monitor-goal-select"
                  value={selectedGoal?.id ?? ''}
                  onChange={(e) => onSelectGoal(e.target.value)}
                  className="px-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 max-w-md w-full"
                >
                  {goals.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.problem.length > 44
                        ? `${g.problem.slice(0, 44)}…`
                        : g.problem}{' '}
                      ({g.status} · {g.progressPercent}%)
                    </option>
                  ))}
                </select>

                {selectedGoal && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 tabular-nums">
                    <span>
                      Status:{' '}
                      <strong className="text-slate-900 capitalize">
                        {selectedGoal.status}
                      </strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Engine:{' '}
                      <strong className="text-slate-900 capitalize">
                        {selectedGoal.executionState}
                      </strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Verified Progress:{' '}
                      <strong className="font-mono text-emerald-700">
                        {selectedGoal.progressPercent}%
                      </strong>
                    </span>
                  </div>
                )}
              </div>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={autoReasonAfterWave}
                  onChange={(e) => setAutoReasonAfterWave(e.target.checked)}
                  className="rounded border-slate-300 text-slate-900"
                />
                <span>Auto-run AI reasoning after wave</span>
              </label>
            </div>

            {selectedGoal && (
              <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    disabled={
                      busyAction !== null || selectedGoal.status === 'completed'
                    }
                    onClick={() =>
                      onOrchestrateGoal(
                        selectedGoal.id,
                        'parallel_safe',
                        autoReasonAfterWave
                      )
                    }
                    className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>
                      {busyAction === `orchestrate:${selectedGoal.id}:parallel_safe`
                        ? 'Dispatching Wave...'
                        : 'Run Parallel Wave'}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={
                      busyAction !== null || selectedGoal.status === 'completed'
                    }
                    onClick={() =>
                      onOrchestrateGoal(
                        selectedGoal.id,
                        'sequential',
                        autoReasonAfterWave
                      )
                    }
                    className="px-3.5 py-2 text-xs font-semibold text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>
                      {busyAction === `orchestrate:${selectedGoal.id}:sequential`
                        ? 'Running Sequential...'
                        : 'Run Sequential'}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => onRunReasoning(selectedGoal.id)}
                    className="px-3.5 py-2 text-xs font-semibold text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    <span>
                      {busyAction === `reasoning:${selectedGoal.id}`
                        ? 'Analyzing Cycle...'
                        : 'Run AI Reasoning'}
                    </span>
                  </button>

                  {counts.awaitingApprovalTasks > 0 && (
                    <button
                      type="button"
                      onClick={onOpenApprovalTab}
                      className="px-3.5 py-2 text-xs font-semibold text-amber-950 bg-amber-100 hover:bg-amber-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Approval Gate ({counts.awaitingApprovalTasks})
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {selectedGoal.status === 'completed' ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 whitespace-nowrap shrink-0">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>Goal Target Verified & Achieved</span>
                    </span>
                  ) : selectedGoal.executionState === 'paused' ||
                    selectedGoal.executionState === 'cancelled' ||
                    selectedGoal.status !== 'active' ? (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() =>
                        onControlGoalExecution(selectedGoal.id, 'resume')
                      }
                      className="px-3 py-2 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>Resume Execution</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() =>
                        onControlGoalExecution(selectedGoal.id, 'pause')
                      }
                      className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Pause className="w-3.5 h-3.5" />
                      <span>Pause</span>
                    </button>
                  )}

                  {selectedGoal.executionState !== 'cancelled' &&
                    selectedGoal.status !== 'completed' && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() =>
                          onControlGoalExecution(selectedGoal.id, 'cancel')
                        }
                        className="px-3 py-2 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        <span>Cancel</span>
                      </button>
                    )}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Directed Acyclic Graph (DAG) Visualization of Goal Tasks, Dependencies & Blockers */}
      <TaskDagVisualizer
        goal={selectedGoal}
        tasks={tasks}
        tools={tools}
        busyAction={busyAction}
        onGeneratePlan={onGeneratePlan}
        onOpenAddTask={onOpenAddTask}
        onExecuteTask={onExecuteTask}
        onRetryTask={onRetryTask}
        onReconcileTask={onReconcileTask}
        onOpenApprovalTab={onOpenApprovalTab}
        onOpenIntegrationsTab={onOpenIntegrationsTab}
        onControlGoalExecution={onControlGoalExecution}
      />

      {/* Multi-Metric Goal Progress Intelligence */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Goal Progress Intelligence
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Separates stated targets, attempted actions, completed steps,
              verified outcomes, and unverified estimates. Goal completion
              triggers strictly on verified primary target metrics.
            </p>
          </div>
        </div>

        {filteredMetrics.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No goal metrics initialized yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 bg-slate-50">
                  <th className="py-3 px-6">Metric</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4 text-right">Stated Target</th>
                  <th className="py-3 px-4 text-right">Attempted</th>
                  <th className="py-3 px-4 text-right">Completed</th>
                  <th className="py-3 px-4 text-right">Verified</th>
                  <th className="py-3 px-4 text-right">Estimated</th>
                  <th className="py-3 px-6 text-right">Verified %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {filteredMetrics.map((m) => {
                  const pct =
                    m.targetValue > 0
                      ? Math.min(
                          100,
                          Math.round((m.verifiedValue / m.targetValue) * 100)
                        )
                      : null;

                  return (
                    <tr key={m.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-6 font-medium text-slate-900">
                        {m.metricLabel}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">
                        {m.isPrimaryTarget
                          ? 'Primary Success Target'
                          : 'Supporting Funnel Metric'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-800">
                        {m.targetValue > 0
                          ? formatMetricValue(m.targetValue, m.unit)
                          : '—'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600">
                        {formatMetricValue(m.attemptedValue, m.unit)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {formatMetricValue(m.completedValue, m.unit)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-emerald-700">
                        {formatMetricValue(m.verifiedValue, m.unit)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-800">
                        {formatMetricValue(m.estimatedValue, m.unit)}
                      </td>
                      <td className="py-3 px-6 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {pct !== null ? `${pct}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Inbound Evidence & Outcome Verification Workbench */}
      <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
        <div className="p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 max-w-3xl">
              <h2 className="text-base font-semibold text-slate-900">
                Inbound Evidence Webhook & Outcome Verification Workbench
              </h2>
              <p className="text-xs text-slate-500">
                External providers deliver signed outcome callbacks to{' '}
                <code className="font-mono text-slate-800">
                  {inboundWebhook.endpointPath}
                </code>{' '}
                with{' '}
                <code className="font-mono text-slate-800">
                  {inboundWebhook.signatureHeader}: t=&lt;unix&gt;,v1=&lt;hmac_sha256&gt;
                </code>
                . Replay skew &gt;300s and duplicate event IDs are rejected or
                deduplicated automatically.
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 pt-1 tabular-nums">
                <span>
                  Signing Secret:{' '}
                  <strong className="font-mono text-slate-900">
                    {inboundWebhook.configured
                      ? `Configured (${inboundWebhook.maskedHint ?? 'masked'})`
                      : 'Not generated yet'}
                  </strong>
                </span>
                {inboundWebhook.updatedAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      Rotated{' '}
                      {new Date(inboundWebhook.updatedAt).toLocaleString()}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleRotateSecretClick}
                className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>
                  {inboundWebhook.configured
                    ? 'Rotate Signing Secret'
                    : 'Generate Signing Secret'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setEvidencePanelOpen((prev) => !prev)}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>
                  {evidencePanelOpen
                    ? 'Hide Evidence Dispatcher'
                    : 'Record / Test Evidence'}
                </span>
              </button>
            </div>
          </div>

          {oneTimeSigningSecret && (
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="space-y-0.5">
                <p className="font-semibold text-slate-900">
                  Active One-Time Workspace Signing Secret (Shown Once):
                </p>
                <code className="font-mono text-slate-800 break-all">
                  {oneTimeSigningSecret}
                </code>
              </div>
              <button
                type="button"
                onClick={() => setOneTimeSigningSecret('')}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                Clear from View
              </button>
            </div>
          )}

          {evidenceFeedback && (
            <div
              role="status"
              className={`p-3.5 rounded-lg border text-sm ${
                evidenceFeedback.tone === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : evidenceFeedback.tone === 'warning'
                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                    : 'bg-red-50 border-red-200 text-red-900'
              }`}
            >
              {evidenceFeedback.text}
            </div>
          )}

          {evidencePanelOpen && (
            <form
              onSubmit={(e) => handleEvidenceSubmit(e, false)}
              className="pt-4 border-t border-slate-200 space-y-4"
            >
              <div
                role="group"
                aria-label="Evidence submission method"
                className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit"
              >
                <button
                  type="button"
                  onClick={() => setSubmissionMode('signed_webhook')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    submissionMode === 'signed_webhook'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Signed HMAC-SHA256 Webhook Test
                </button>
                <button
                  type="button"
                  onClick={() => setSubmissionMode('manual_entry')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    submissionMode === 'manual_entry'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Manual Evidence Entry (Requires Human Review)
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="ev-type-select"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Evidence Type
                  </label>
                  <select
                    id="ev-type-select"
                    value={evType}
                    onChange={(e) => setEvType(e.target.value as EvidenceType)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                  >
                    {EVIDENCE_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="ev-task-select"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Associated Task (Optional)
                  </label>
                  <select
                    id="ev-task-select"
                    value={evTaskId}
                    onChange={(e) => setEvTaskId(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                  >
                    <option value="">Goal-level outcome (no specific task)</option>
                    {goalTasks.map((t) => (
                      <option key={t.id} value={t.id}>
                        Step {t.stepOrder}: {t.description.slice(0, 36)} (
                        {t.status})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="ev-provider-input"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Source Provider
                  </label>
                  <input
                    id="ev-provider-input"
                    type="text"
                    value={evProvider}
                    onChange={(e) => setEvProvider(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                {submissionMode === 'signed_webhook' && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor="ev-event-id"
                        className="block text-xs font-medium text-slate-700"
                      >
                        External Event ID (Dedup Key)
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          setEvExternalEventId(
                            `evt_${Math.random().toString(36).slice(2, 10)}`
                          )
                        }
                        className="text-xs font-medium text-slate-600 hover:text-slate-900 underline cursor-pointer whitespace-nowrap shrink-0"
                      >
                        New ID
                      </button>
                    </div>
                    <input
                      id="ev-event-id"
                      type="text"
                      value={evExternalEventId}
                      onChange={(e) => setEvExternalEventId(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 font-mono"
                    />
                  </div>
                )}

                <div className="space-y-1">
                  <label
                    htmlFor="ev-ext-ref"
                    className="block text-xs font-medium text-slate-700"
                  >
                    External Reference ID
                  </label>
                  <input
                    id="ev-ext-ref"
                    type="text"
                    value={evExternalRef}
                    onChange={(e) => setEvExternalRef(e.target.value)}
                    placeholder="e.g., ch_3Qk82, msg_09"
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="ev-count-input"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Outcome Count
                  </label>
                  <input
                    id="ev-count-input"
                    type="number"
                    min="0"
                    step="1"
                    value={evMetricCount}
                    onChange={(e) => setEvMetricCount(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 font-mono tabular-nums"
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="ev-rev-input"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Settled Revenue (USD)
                  </label>
                  <input
                    id="ev-rev-input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={evRevenueUsd}
                    onChange={(e) => setEvRevenueUsd(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 font-mono tabular-nums"
                  />
                </div>
              </div>

              {submissionMode === 'signed_webhook' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label
                      htmlFor="ev-signing-secret"
                      className="block text-xs font-medium text-slate-700"
                    >
                      HMAC-SHA256 Signing Secret
                    </label>
                    <input
                      id="ev-signing-secret"
                      type="password"
                      value={oneTimeSigningSecret}
                      onChange={(e) => setOneTimeSigningSecret(e.target.value)}
                      placeholder="Rotate secret above or paste whsec_..."
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 font-mono"
                    />
                  </div>
                  <div className="flex items-end pb-2">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={evRequiresHuman}
                        onChange={(e) => setEvRequiresHuman(e.target.checked)}
                        className="rounded border-slate-300 text-slate-900"
                      />
                      <span>
                        Flag webhook event as requiring human verification
                        before counting
                      </span>
                    </label>
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <label
                  htmlFor="ev-summary-input"
                  className="block text-xs font-medium text-slate-700"
                >
                  Outcome Summary
                </label>
                <input
                  id="ev-summary-input"
                  type="text"
                  value={evSummary}
                  onChange={(e) => setEvSummary(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                  required
                />
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2.5">
                {submissionMode === 'signed_webhook' && (
                  <button
                    type="button"
                    disabled={submittingEvidence}
                    onClick={(e) =>
                      handleEvidenceSubmit(
                        e as unknown as React.FormEvent,
                        true
                      )
                    }
                    className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Send Keeping Event ID (Test Duplicate Replay)
                  </button>
                )}
                <button
                  type="submit"
                  disabled={submittingEvidence}
                  className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>
                    {submittingEvidence
                      ? 'Submitting...'
                      : submissionMode === 'signed_webhook'
                        ? 'Dispatch Signed Webhook'
                        : 'Submit Manual Evidence'}
                  </span>
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Collected Outcome Evidence Table */}
        <div className="p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">
              Collected Outcome Evidence ({filteredEvidence.length})
            </h3>
            <span className="text-xs text-slate-500">
              Human reviewers must enter verification notes; AI consistency
              checks are strictly advisory.
            </span>
          </div>

          {reviewError && (
            <div
              role="alert"
              className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800"
            >
              {reviewError}
            </div>
          )}

          {filteredEvidence.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg">
              No outcome evidence recorded for this view yet.
            </div>
          ) : (
            <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
              {filteredEvidence.map((ev) => {
                const aiBusy = busyAction === `ai-verify:${ev.id}`;
                const reviewBusy = busyAction === `review:${ev.id}`;

                return (
                  <div key={ev.id} className="p-4 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="space-y-1 flex-1 min-w-[240px]">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                          {renderVerificationState(ev.verificationState)}
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-slate-800">
                            {ev.evidenceType}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-slate-700">
                            {ev.provenanceClass} ({ev.trustTier})
                          </span>
                          {ev.hasConflict && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-semibold text-red-700">
                                Conflict Quarantined
                              </span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-slate-600">
                            {ev.sourceType} ({ev.provider})
                          </span>
                          {ev.externalReferenceId && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono text-slate-600">
                                ref: {ev.externalReferenceId}
                              </span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span>
                            {new Date(ev.observedAt).toLocaleString()}
                          </span>
                        </div>

                        <p className="text-sm font-medium text-slate-900">
                          {ev.summary}
                        </p>

                        {Object.keys(ev.structuredMetrics).length > 0 && (
                          <p className="text-xs font-mono text-slate-600 tabular-nums">
                            Metrics: {JSON.stringify(ev.structuredMetrics)}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => onAiVerifyEvidence(ev.id)}
                          aria-label={`Run advisory AI check on ${ev.summary}`}
                          className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {aiBusy ? 'Checking...' : 'AI Consistency Check'}
                        </button>
                      </div>
                    </div>

                    {ev.verificationState === 'pending_verification' && (
                      <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center gap-2">
                        <label
                          htmlFor={`review-notes-${ev.id}`}
                          className="sr-only"
                        >
                          Reviewer verification notes
                        </label>
                        <input
                          id={`review-notes-${ev.id}`}
                          type="text"
                          value={reviewNotesById[ev.id] ?? ''}
                          onChange={(e) =>
                            setReviewNotesById((prev) => ({
                              ...prev,
                              [ev.id]: e.target.value,
                            }))
                          }
                          placeholder="Required reviewer notes (e.g., Verified Stripe receipt #1042)"
                          className="flex-1 min-w-[220px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md text-slate-900"
                        />
                        <button
                          type="button"
                          disabled={reviewBusy || busyAction !== null}
                          onClick={() => handleHumanDecision(ev.id, 'verified')}
                          className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Verify Outcome
                        </button>
                        <button
                          type="button"
                          disabled={reviewBusy || busyAction !== null}
                          onClick={() => handleHumanDecision(ev.id, 'rejected')}
                          className="px-3 py-1.5 text-xs font-semibold text-red-700 bg-white border border-red-200 hover:bg-red-50 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {filteredVerifications.length > 0 && (
            <div className="pt-2 space-y-2">
              <h4 className="text-xs font-semibold text-slate-700">
                Verification Decisions Audit Trail (
                {filteredVerifications.length})
              </h4>
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-2 px-4">Method</th>
                      <th className="py-2 px-4">Decision</th>
                      <th className="py-2 px-4">Reviewer</th>
                      <th className="py-2 px-4">Notes</th>
                      <th className="py-2 px-4 text-right">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {filteredVerifications.slice(0, 12).map((v) => (
                      <tr key={v.id}>
                        <td className="py-2 px-4 font-mono text-slate-700">
                          {v.verificationMethod}
                        </td>
                        <td className="py-2 px-4 font-mono font-semibold text-slate-900">
                          {v.decision}
                        </td>
                        <td className="py-2 px-4 font-mono text-slate-600">
                          {v.reviewerIdentity}
                        </td>
                        <td className="py-2 px-4 text-slate-700 max-w-md">
                          {v.notes}
                        </td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums text-slate-500">
                          {new Date(v.decidedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Continuous AI Reasoning & Next-Action Proposals */}
      <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
        <div className="p-6 space-y-2">
          <h2 className="text-base font-semibold text-slate-900">
            Continuous AI Reasoning & Next-Action Proposals
          </h2>
          <p className="text-xs text-slate-500">
            Analyzes verified vs. unverified progress, failure causes, and retry
            state. Accepted consequential proposals always enter the Approval
            Gate—AI reasoning never bypasses human approval or auto-completes
            unverified goals.
          </p>
        </div>

        <div className="p-6 space-y-6">
          {filteredCycles.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg">
              No AI reasoning cycles executed yet. Click &ldquo;Run AI
              Reasoning&rdquo; above to evaluate outcomes and generate next
              actions.
            </div>
          ) : (
            <div className="space-y-4">
              {filteredCycles.slice(0, 3).map((cycle) => (
                <div
                  key={cycle.id}
                  className="p-4 border border-slate-200 rounded-lg space-y-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                    <span className="font-mono font-semibold text-slate-800">
                      {cycle.modelUsed}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>Confidence: {cycle.confidenceLevel}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Human Intervention:{' '}
                      {cycle.humanInterventionRequired
                        ? 'Recommended'
                        : 'Not Required'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{new Date(cycle.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="text-sm font-semibold text-slate-900">
                    {cycle.currentAssessment}
                  </p>
                  <p className="text-xs text-slate-700 leading-relaxed">
                    {cycle.reasoningSummary}
                  </p>
                  {cycle.findings.length > 0 && (
                    <ul className="list-disc pl-5 text-xs text-slate-600 space-y-0.5">
                      {cycle.findings.map((f, idx) => (
                        <li key={idx}>{f}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          {filteredProposals.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Structured Next-Action Proposals ({filteredProposals.length})
              </h3>
              <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
                {filteredProposals.map((prop) => {
                  const isBusy = busyAction === `proposal:${prop.id}`;
                  return (
                    <div
                      key={prop.id}
                      className="p-4 flex flex-wrap items-start justify-between gap-4"
                    >
                      <div className="space-y-1 flex-1 min-w-[240px]">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                          <span className="font-mono font-semibold text-slate-800">
                            {prop.proposalType}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-slate-700">
                            {prop.proposedTool}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="capitalize font-medium text-slate-700">
                            Status: {prop.status}
                          </span>
                          {prop.approvalRequired && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-amber-800 font-semibold">
                                Requires Approval Gate
                              </span>
                            </>
                          )}
                        </div>
                        <p className="text-sm font-semibold text-slate-900">
                          {prop.title}
                        </p>
                        <p className="text-xs text-slate-600">
                          {prop.description}
                        </p>
                        <p className="text-xs text-slate-500">
                          Expected: {prop.expectedOutcome} · Verification:{' '}
                          {prop.verificationMethod}
                        </p>
                      </div>

                      {prop.status === 'proposed' && (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            disabled={isBusy || busyAction !== null}
                            onClick={() => onDecideProposal(prop.id, 'accept')}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Accept &amp; Enqueue
                          </button>
                          <button
                            type="button"
                            disabled={isBusy || busyAction !== null}
                            onClick={() => onDecideProposal(prop.id, 'reject')}
                            className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Retry Recovery, Task Attempts & Execution Runs */}
      <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
        <div className="p-6 space-y-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-900">
              Task Attempts, Exponential Backoff &amp; Manual Recovery
            </h2>
            <p className="text-xs text-slate-500">
              Failed or stalled tasks schedule exponential backoff retries up to
              their configured budget and support immediate manual recovery
              while preserving Approval Gate rules.
            </p>
          </div>

          {recoverableTasks.length > 0 && (
            <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
              {recoverableTasks.map((t) => (
                <div
                  key={t.id}
                  className="p-3.5 flex flex-wrap items-center justify-between gap-4 text-xs"
                >
                  <div className="space-y-0.5 max-w-2xl">
                    <div className="flex flex-wrap items-center gap-2 text-slate-600 tabular-nums">
                      <span className="font-mono font-semibold text-slate-900">
                        Step {t.stepOrder}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize font-semibold text-amber-800">
                        {t.status}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">
                        Retries: {t.retryCount}/{t.maxRetries}
                      </span>
                      {t.reconciliationRequired && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-red-700">
                            Reconciliation Required
                          </span>
                        </>
                      )}
                      {t.nextRetryAt && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">
                            Next Retry:{' '}
                            {new Date(t.nextRetryAt).toLocaleTimeString()}
                          </span>
                        </>
                      )}
                    </div>
                    <p className="text-sm font-medium text-slate-900">
                      {t.description}
                    </p>
                    {t.statusReason && (
                      <p className="text-xs text-slate-600">{t.statusReason}</p>
                    )}
                  </div>

                  {t.reconciliationRequired ? (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() =>
                          onReconcileTask(
                            t.id,
                            'reconcile_from_evidence'
                          )
                        }
                        className="px-2.5 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Reconcile from Evidence
                      </button>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() =>
                          onReconcileTask(
                            t.id,
                            'mark_dispatched_pending_verification'
                          )
                        }
                        className="px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Mark Dispatched
                      </button>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() =>
                          onReconcileTask(
                            t.id,
                            'confirm_not_executed_requeue'
                          )
                        }
                        className="px-2.5 py-1.5 text-xs font-medium text-amber-900 bg-amber-50 border border-amber-200 hover:bg-amber-100 disabled:opacity-50 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Confirm Not Sent &amp; Retry
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => onRetryTask(t.id)}
                      aria-label={`Manual retry for Step ${t.stepOrder}`}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-md inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Manual Retry</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {filteredAttempts.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg">
              No task execution attempts recorded yet.
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Attempt</th>
                    <th className="py-2.5 px-4">Provider</th>
                    <th className="py-2.5 px-4">Worker</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Duration</th>
                    <th className="py-2.5 px-4">Summary / Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredAttempts.slice(0, 20).map((att) => (
                    <tr key={att.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4 font-mono tabular-nums text-slate-800">
                        #{att.attemptNumber} · {att.taskId.slice(0, 8)}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-700">
                        {att.providerKey}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-500">
                        {att.workerId}
                      </td>
                      <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">
                        {att.status}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600">
                        {formatDurationMs(att.durationMs)}
                      </td>
                      <td className="py-2.5 px-4 text-slate-700 max-w-md">
                        {att.errorMessage || att.outputSummary || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Orchestrator Execution Runs History */}
        {filteredRuns.length > 0 && (
          <div className="p-6 space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Orchestrator Wave Runs ({filteredRuns.length})
            </h3>
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Started</th>
                    <th className="py-2.5 px-4">Concurrency</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">
                      Dispatched / OK / Failed
                    </th>
                    <th className="py-2.5 px-4 text-right">Duration</th>
                    <th className="py-2.5 px-4">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredRuns.slice(0, 15).map((r) => (
                    <tr key={r.id}>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-slate-600">
                        {new Date(r.startedAt).toLocaleString()}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-700">
                        {r.concurrencyMode}
                      </td>
                      <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">
                        {r.status}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-800">
                        {r.tasksDispatched} / {r.tasksSucceeded} /{' '}
                        {r.tasksFailed}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600">
                        {formatDurationMs(r.durationMs)}
                      </td>
                      <td className="py-2.5 px-4 text-slate-700 max-w-md">
                        {r.summary ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Provider Availability, Health & Rate Limits */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">
            Provider Availability, Verification Modes &amp; Rate Limits
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Common provider descriptor interface across built-in runtimes and
            workspace-configurable external adapters.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <th className="py-3 px-6">Provider</th>
                <th className="py-3 px-4">Interface</th>
                <th className="py-3 px-4">Health</th>
                <th className="py-3 px-4 text-right">Rate Limit</th>
                <th className="py-3 px-4">Verification Modes</th>
                <th className="py-3 px-6">Implementation Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {tools.map((tool) => (
                <tr key={tool.id} className="hover:bg-slate-50/70">
                  <td className="py-3 px-6">
                    <p className="font-semibold text-slate-900">{tool.name}</p>
                    <p className="font-mono text-slate-500">{tool.id}</p>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-700">
                    {tool.executionInterface}
                  </td>
                  <td className="py-3 px-4">
                    {tool.healthStatus === 'healthy' ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>Healthy</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-slate-600">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-700" />
                        <span className="capitalize">{tool.healthStatus}</span>
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                    {tool.rateLimit.requestsPerMinute} RPM · burst{' '}
                    {tool.rateLimit.burstLimit}
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-600">
                    {tool.verificationCapabilities.join(', ')}
                  </td>
                  <td className="py-3 px-6 text-slate-700">
                    <span className="font-medium text-slate-900">
                      {formatIntegrationClassification(
                        tool.integrationClassification
                      )}
                    </span>
                    <span className="block text-[11px] text-slate-500">
                      {tool.implementationStatus === 'implemented_and_tested'
                        ? 'Implemented & Tested'
                        : 'Requires Workspace HTTPS Credentials'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
