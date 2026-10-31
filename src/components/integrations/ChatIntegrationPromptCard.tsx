import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Play,
  Settings2,
} from 'lucide-react';
import { api } from '../../lib/api';
import type {
  CapabilityReadinessState,
  ChatInteractivePromptPayload,
  IntegrationProviderKey,
  WorkforceConfigurationRecord,
} from '../../types';

interface ChatIntegrationPromptCardProps {
  prompt: ChatInteractivePromptPayload;
  onOpenIntegrations: () => void;
  onRefreshWorkspace: () => Promise<void>;
}

function formatReadinessLabel(state: CapabilityReadinessState): {
  label: string;
  colorClass: string;
} {
  switch (state) {
    case 'operational':
      return {
        label: 'Operational',
        colorClass: 'text-emerald-700 dark:text-emerald-400',
      };
    case 'tested':
      return {
        label: 'Tested',
        colorClass: 'text-emerald-700 dark:text-emerald-400',
      };
    case 'configured':
      return {
        label: 'Configured (Untested)',
        colorClass: 'text-amber-700 dark:text-amber-400',
      };
    case 'authorized':
      return {
        label: 'Authorized',
        colorClass: 'text-blue-700 dark:text-blue-400',
      };
    case 'connected':
      return {
        label: 'Connected',
        colorClass: 'text-blue-700 dark:text-blue-400',
      };
    case 'available':
      return {
        label: 'Available (Not Connected)',
        colorClass: 'text-slate-600 dark:text-slate-400',
      };
    case 'unavailable':
    default:
      return {
        label: 'Unavailable',
        colorClass: 'text-red-700 dark:text-red-400',
      };
  }
}

export const ChatIntegrationPromptCard: React.FC<
  ChatIntegrationPromptCardProps
> = ({ prompt, onOpenIntegrations, onRefreshWorkspace }) => {
  const [liveConfig, setLiveConfig] =
    useState<WorkforceConfigurationRecord | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const effectiveStatus = liveConfig?.status ?? prompt.status;
  const effectiveRecommendations =
    liveConfig?.recommendedConnectors ?? prompt.recommendedConnectors;
  const effectiveBlocker =
    liveConfig !== null
      ? liveConfig.activationBlockerReason
      : prompt.activationBlockerReason;

  const handleDecision = async (
    action: 'approve' | 'reject',
    providerKey?: IntegrationProviderKey
  ) => {
    if (!prompt.workforceConfigId) {
      onOpenIntegrations();
      return;
    }
    setBusyAction(`${action}:${providerKey ?? 'all'}`);
    setFeedback(null);
    try {
      const res = await api.decideWorkforceConnector(prompt.workforceConfigId, {
        action,
        providerKey,
      });
      setLiveConfig(res.workforceConfig);
      await onRefreshWorkspace();
    } catch (err: unknown) {
      setFeedback(
        err instanceof Error ? err.message : 'Failed to update decision.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleActivate = async () => {
    if (!prompt.workforceConfigId) {
      onOpenIntegrations();
      return;
    }
    setBusyAction('activate');
    setFeedback(null);
    try {
      const res = await api.activateWorkforce(prompt.workforceConfigId);
      setLiveConfig(res.workforceConfig);
      setFeedback(
        res.activated
          ? 'All required capabilities verified live. Workforce is now operational.'
          : res.workforceConfig.activationBlockerReason ||
              'Activation blocked until all required connectors pass live capability verification.'
      );
      await onRefreshWorkspace();
    } catch (err: unknown) {
      setFeedback(
        err instanceof Error ? err.message : 'Capability verification failed.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section
      aria-label="Intelligent Workforce Configuration"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {prompt.title}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={
                effectiveStatus === 'operational'
                  ? 'font-medium text-emerald-700 dark:text-emerald-400'
                  : effectiveStatus === 'rejected'
                    ? 'font-medium text-red-700 dark:text-red-400'
                    : 'font-medium text-amber-700 dark:text-amber-400'
              }
            >
              {effectiveStatus === 'operational'
                ? 'Operational'
                : effectiveStatus === 'rejected'
                  ? 'Rejected'
                  : 'Awaiting Connector Readiness'}
            </span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            {prompt.summary}
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenIntegrations}
          className="min-h-[34px] px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 cursor-pointer shrink-0"
        >
          <Settings2 className="w-3.5 h-3.5" />
          <span>Open Integration Center</span>
        </button>
      </div>

      {/* Required Capabilities Line */}
      <div className="text-xs text-slate-600 dark:text-slate-400 pt-2 border-t border-slate-200/80 dark:border-slate-800/80">
        <span className="font-medium text-slate-800 dark:text-slate-200">
          Required capabilities:{' '}
        </span>
        <span className="font-mono text-[11px]">
          {prompt.requiredCapabilities.join(' · ')}
        </span>
      </div>

      {/* Recommended Connectors */}
      {effectiveRecommendations.length > 0 && (
        <div className="divide-y divide-slate-200/80 dark:divide-slate-800/80 border-y border-slate-200/80 dark:border-slate-800/80">
          {effectiveRecommendations.map((rec) => {
            const pres = formatReadinessLabel(rec.currentReadiness);
            return (
              <div
                key={rec.providerKey}
                className="py-3 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {rec.connectorName}
                    </span>
                    <span aria-hidden="true" className="text-slate-400">
                      ·
                    </span>
                    <span className={`font-medium ${pres.colorClass}`}>
                      {pres.label}
                    </span>
                    {rec.decision !== 'pending' && (
                      <>
                        <span aria-hidden="true" className="text-slate-400">
                          ·
                        </span>
                        <span className="text-slate-500 capitalize">
                          {rec.decision}
                        </span>
                      </>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    {rec.reasonNeeded}
                  </p>
                </div>

                {prompt.workforceConfigId && (
                  <div className="flex items-center gap-2 shrink-0">
                    {rec.currentReadiness !== 'operational' ? (
                      <button
                        type="button"
                        onClick={onOpenIntegrations}
                        className="min-h-[32px] px-3 py-1 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 inline-flex items-center gap-1 cursor-pointer"
                      >
                        <span>Configure</span>
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() =>
                        void handleDecision('approve', rec.providerKey)
                      }
                      className="min-h-[32px] px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() =>
                        void handleDecision('reject', rec.providerKey)
                      }
                      className="min-h-[32px] px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-red-600 rounded-lg cursor-pointer disabled:opacity-50"
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

      {/* Honest Activation Gate Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-2 text-xs min-w-[220px] flex-1">
          {effectiveStatus === 'operational' ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <span className="text-emerald-800 dark:text-emerald-300">
                Workforce verified and active across all required capabilities.
              </span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <span className="text-slate-600 dark:text-slate-400 leading-relaxed">
                {feedback ||
                  effectiveBlocker ||
                  'Task.ai activates a workforce only after every required capability is connected, authorized, and live-tested.'}
              </span>
            </>
          )}
        </div>

        {prompt.workforceConfigId && effectiveStatus !== 'operational' && (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => void handleActivate()}
            className="min-h-[34px] px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white text-white dark:text-slate-950 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            <span>
              {busyAction === 'activate'
                ? 'Testing Capabilities...'
                : 'Verify & Activate Workforce'}
            </span>
          </button>
        )}
      </div>
    </section>
  );
};
