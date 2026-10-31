import React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ResultsReportSummary } from '../types';

interface ResultsReportViewProps {
  report: ResultsReportSummary | null;
  onNavigateIntegrations: () => void;
}

export const ResultsReportView: React.FC<ResultsReportViewProps> = ({
  report,
  onNavigateIntegrations,
}) => {
  if (!report) {
    return (
      <div className="p-8 bg-white border border-slate-200 rounded-xl text-sm text-slate-500">
        Loading outcome metrics from persisted records...
      </div>
    );
  }

  const { metrics, missingConfigurations, goalComparisons, processSummary } =
    report;

  const outcomeRows: Array<{
    label: string;
    value: string | number;
    note: string;
  }> = [
    {
      label: 'Prospects found',
      value: metrics.prospectsFound,
      note: 'Verified external prospect records',
    },
    {
      label: 'Qualified prospects',
      value: metrics.qualifiedProspects,
      note: 'Prospects verified against qualification rubric',
    },
    {
      label: 'Messages drafted',
      value: metrics.messagesDrafted,
      note: 'Persisted drafts (never counted as sent)',
    },
    {
      label: 'Messages sent',
      value: metrics.messagesSent,
      note: 'Confirmed external dispatches only',
    },
    {
      label: 'Messages delivered',
      value: metrics.messagesDeliveredVerified,
      note: 'Verified by external delivery provider receipt',
    },
    {
      label: 'Replies received',
      value: metrics.repliesReceived,
      note: 'Verified inbound replies',
    },
    {
      label: 'Meetings booked',
      value: metrics.meetingsBooked,
      note: 'Verified calendar bookings',
    },
    {
      label: 'Deals won',
      value: metrics.dealsWon,
      note: 'Authoritatively verified customer conversions',
    },
    {
      label: 'Revenue earned',
      value: `$${metrics.revenueEarnedUsd.toFixed(2)}`,
      note: 'Backed by payment/contract evidence only',
    },
    {
      label: 'Blocked tasks & failures',
      value: `${metrics.blockedTasks} blocked / ${metrics.executionFailures} failed`,
      note: 'Tasks halted by gates, missing tools, or errors',
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-slate-900">Results Report</h1>
          <p className="text-sm text-slate-600 max-w-3xl">
            Displays real, persisted, evidence-backed outcomes only. Zero
            fabricated or demo numbers are injected into this report.
          </p>
        </div>
        <span className="text-xs text-slate-500 font-mono tabular-nums">
          Provenance: Persisted Server Records · 0 Demo Rows
        </span>
      </div>

      {/* Missing Integration Notice */}
      {missingConfigurations.length > 0 && (
        <section className="bg-amber-50 border border-amber-200 rounded-xl p-5 flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5 max-w-3xl">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                Optional External Automation Providers Not Configured in
                Workspace ({missingConfigurations.length})
              </span>
            </div>
            {missingConfigurations.slice(0, 4).map((mc) => (
              <p
                key={mc.toolId}
                className="text-xs text-amber-900/90 leading-relaxed"
              >
                <span className="font-semibold">{mc.name}:</span> {mc.impact}{' '}
                Capabilities:{' '}
                <code className="font-mono">
                  {mc.requiredCapabilities.join(', ')}
                </code>
              </p>
            ))}
          </div>
          <button
            type="button"
            onClick={onNavigateIntegrations}
            className="px-3.5 py-2 text-xs font-semibold text-amber-950 bg-white border border-amber-300 rounded-lg hover:bg-amber-100/50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Configure Integrations
          </button>
        </section>
      )}

      {/* Outcome Metrics Grid (Single-Elevation Hairline Grid) */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">
            Verified Outcome Metrics
          </h2>
          <span className="text-xs text-slate-500 tabular-nums">
            {processSummary.completedTasks} completed ·{' '}
            {processSummary.pendingVerificationTasks} pending verification ·{' '}
            {processSummary.verifiedTasks} independently verified ·{' '}
            {processSummary.pendingApprovals} pending approval
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
          {outcomeRows.slice(0, 5).map((item) => (
            <div key={item.label} className="p-5 space-y-1.5">
              <p className="text-xs font-medium text-slate-500">{item.label}</p>
              <p className="text-2xl font-bold text-slate-900 font-mono tabular-nums">
                {item.value}
              </p>
              <p className="text-xs text-slate-500 leading-snug">{item.note}</p>
            </div>
          ))}
        </div>

        <div className="border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
          {outcomeRows.slice(5, 10).map((item) => (
            <div key={item.label} className="p-5 space-y-1.5">
              <p className="text-xs font-medium text-slate-500">{item.label}</p>
              <p className="text-2xl font-bold text-slate-900 font-mono tabular-nums">
                {item.value}
              </p>
              <p className="text-xs text-slate-500 leading-snug">{item.note}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Target Metric vs Achieved Reality Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">
            Stated Goal Targets vs. Achieved Evidence
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Prevents confusing desired target metrics with actual verified
            outcomes.
          </p>
        </div>

        {goalComparisons.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No goals persisted yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 bg-slate-50">
                  <th className="py-3 px-6">Goal Description</th>
                  <th className="py-3 px-4">Desired Target Metric</th>
                  <th className="py-3 px-4">Deadline</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Verified %</th>
                  <th className="py-3 px-4 text-right">Drafted Assets</th>
                  <th className="py-3 px-4 text-right">Verified Outcomes</th>
                  <th className="py-3 px-6 text-right">Blocked / Failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {goalComparisons.map((row) => (
                  <tr key={row.goalId} className="hover:bg-slate-50/70">
                    <td className="py-3.5 px-6 font-medium text-slate-900 max-w-xs">
                      {row.problem}
                    </td>
                    <td className="py-3.5 px-4 text-slate-700">
                      {row.statedTargetMetric}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-xs tabular-nums text-slate-600">
                      {row.deadline
                        ? new Date(row.deadline).toISOString().slice(0, 10)
                        : '—'}
                    </td>
                    <td className="py-3.5 px-4 capitalize text-slate-700">
                      {row.goalStatus}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-emerald-700">
                      {row.progressPercent}%
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-800">
                      {row.draftedArtifactsCount}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-emerald-700 font-medium">
                      <span className="inline-flex items-center justify-end gap-1">
                        {row.verifiedOutcomesCount > 0 && (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        )}
                        <span>{row.verifiedOutcomesCount}</span>
                      </span>
                    </td>
                    <td className="py-3.5 px-6 text-right font-mono tabular-nums text-slate-700">
                      {row.blockedCount} / {row.failedCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
