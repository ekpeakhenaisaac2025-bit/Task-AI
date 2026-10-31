import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Unplug,
  X,
} from 'lucide-react';
import { clearGoogleWorkspaceAccessToken } from '../../lib/firebase';
import { api } from '../../lib/api';
import { CustomApiModal } from './CustomApiModal';
import { N8nConfigModal } from './N8nConfigModal';
import { NativeConnectModal } from './NativeConnectModal';
import {
  WorkspaceMutationConfirmModal,
  type WorkspaceMutationConfirmationRequest,
} from './WorkspaceMutationConfirmModal';
import type {
  AiProviderId,
  AiProviderStatusRecord,
  CapabilityId,
  CapabilityReadinessState,
  CapabilityStatusEntry,
  IntegrationActivityLogRecord,
  IntegrationAuthType,
  IntegrationCenterCategory,
  IntegrationConnectionMode,
  IntegrationProviderKey,
  IntegrationRegistryEntry,
  N8nRegisteredWorkflowRecord,
  UserIntegrationRecord,
  WorkforceConfigurationRecord,
} from '../../types';

interface IntegrationCenterViewProps {
  workspaceId: string | undefined;
  registry: IntegrationRegistryEntry[];
  capabilityEntries: CapabilityStatusEntry[];
  integrations: UserIntegrationRecord[];
  n8nWorkflows: N8nRegisteredWorkflowRecord[];
  aiProviders: AiProviderStatusRecord[];
  activityLogs: IntegrationActivityLogRecord[];
  workforceConfigs: WorkforceConfigurationRecord[];
  onRefreshWorkspace: () => Promise<void>;
  onCreateWebhookIntegration: (payload: {
    providerKey: IntegrationProviderKey;
    displayName: string;
    connectionMode: IntegrationConnectionMode;
    endpointUrl?: string;
    authType: IntegrationAuthType;
    secret?: string;
    capabilities: CapabilityId[];
  }) => Promise<void>;
  onTestIntegration: (
    id: string
  ) => Promise<{ success: boolean; statusDetail: string }>;
  onRotateWorkspaceKeys: () => Promise<{
    rotatedCount: number;
    alreadyCurrentCount: number;
    noSecretCount: number;
  }>;
}

const CATEGORY_TABS: ReadonlyArray<{
  id: IntegrationCenterCategory;
  label: string;
}> = [
  { id: 'recommended', label: 'Recommended Integrations' },
  { id: 'connected_apps', label: 'Connected Applications' },
  { id: 'automation_platforms', label: 'Automation Platforms' },
  { id: 'ai_providers', label: 'AI Providers' },
  { id: 'custom_api', label: 'Custom API Connections' },
  { id: 'webhooks', label: 'Webhook Connections' },
  { id: 'health', label: 'Connection Health' },
];

const CATEGORY_HUMAN_NAMES: Record<IntegrationCenterCategory, string> = {
  recommended: 'Recommended',
  connected_apps: 'Connected Application',
  automation_platforms: 'Automation Platform',
  ai_providers: 'AI Provider',
  custom_api: 'Custom API',
  webhooks: 'Webhook Connection',
  health: 'Connection Health',
};

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return 'Never';
  return dt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getReadinessTone(state: CapabilityReadinessState): {
  label: string;
  textClass: string;
} {
  switch (state) {
    case 'operational':
      return {
        label: 'Operational',
        textClass: 'text-emerald-700 dark:text-emerald-400',
      };
    case 'tested':
      return {
        label: 'Tested',
        textClass: 'text-emerald-700 dark:text-emerald-400',
      };
    case 'configured':
      return {
        label: 'Configured (Untested)',
        textClass: 'text-amber-700 dark:text-amber-400',
      };
    case 'authorized':
      return {
        label: 'Authorized',
        textClass: 'text-blue-700 dark:text-blue-400',
      };
    case 'connected':
      return {
        label: 'Connected',
        textClass: 'text-blue-700 dark:text-blue-400',
      };
    case 'available':
      return {
        label: 'Available',
        textClass: 'text-slate-600 dark:text-slate-400',
      };
    case 'unavailable':
    default:
      return {
        label: 'Unavailable',
        textClass: 'text-red-700 dark:text-red-400',
      };
  }
}

export const IntegrationCenterView: React.FC<IntegrationCenterViewProps> = ({
  workspaceId,
  registry,
  capabilityEntries,
  integrations,
  n8nWorkflows,
  aiProviders,
  activityLogs,
  workforceConfigs,
  onRefreshWorkspace,
  onCreateWebhookIntegration,
  onTestIntegration,
  onRotateWorkspaceKeys,
}) => {
  const [activeCategory, setActiveCategory] =
    useState<IntegrationCenterCategory>('recommended');
  const [bannerMessage, setBannerMessage] = useState<{
    tone: 'neutral' | 'success' | 'error';
    text: string;
  } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Modals
  const [nativeEntryModal, setNativeEntryModal] =
    useState<IntegrationRegistryEntry | null>(null);
  const [n8nModalOpen, setN8nModalOpen] = useState(false);
  const [n8nEditingIntegration, setN8nEditingIntegration] =
    useState<UserIntegrationRecord | null>(null);
  const [customApiModalOpen, setCustomApiModalOpen] = useState(false);
  const [webhookModalEntry, setWebhookModalEntry] =
    useState<IntegrationRegistryEntry | null>(null);
  const [confirmRequest, setConfirmRequest] =
    useState<WorkspaceMutationConfirmationRequest | null>(null);

  // Generic Webhook Modal state
  const [whDisplayName, setWhDisplayName] = useState('');
  const [whEndpointUrl, setWhEndpointUrl] = useState('');
  const [whAuthType, setWhAuthType] =
    useState<IntegrationAuthType>('hmac_sha256');
  const [whSecret, setWhSecret] = useState('');

  // Workforce Configuration Manager state
  const [workforceExpanded, setWorkforceExpanded] = useState(false);
  const [workforcePrompt, setWorkforcePrompt] = useState('');

  const openConnectorAction = (entry: IntegrationRegistryEntry) => {
    setBannerMessage(null);
    if (entry.providerKey === 'n8n_webhook') {
      const found = entry.integrationId
        ? integrations.find((i) => i.id === entry.integrationId) ?? null
        : integrations.find((i) => i.providerKey === 'n8n_webhook') ?? null;
      setN8nEditingIntegration(found);
      setN8nModalOpen(true);
      return;
    }

    if (entry.providerKey === 'custom_api') {
      setCustomApiModalOpen(true);
      return;
    }

    if (
      entry.connectorType === 'native_oauth' ||
      entry.connectorType === 'native_token'
    ) {
      setNativeEntryModal(entry);
      return;
    }

    // Standard Webhook Adapter (Make, Zapier, CRM, Payment, Custom Webhook)
    setWhDisplayName(entry.connectorName);
    const existing = entry.integrationId
      ? integrations.find((i) => i.id === entry.integrationId)
      : undefined;
    setWhEndpointUrl(existing?.configMetadata.endpointUrl || '');
    setWhAuthType(existing?.configMetadata.authType || 'hmac_sha256');
    setWhSecret('');
    setWebhookModalEntry(entry);
  };

  const handleTestConnector = async (entry: IntegrationRegistryEntry) => {
    if (!entry.integrationId) {
      openConnectorAction(entry);
      return;
    }
    setBusyKey(`test:${entry.connectorId}`);
    setBannerMessage(null);
    try {
      const res = await onTestIntegration(entry.integrationId);
      setBannerMessage({
        tone: res.success ? 'success' : 'error',
        text: `${entry.connectorName}: ${res.statusDetail}`,
      });
    } catch (err: unknown) {
      setBannerMessage({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : `Connection test failed for ${entry.connectorName}.`,
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleDisconnectConnector = (entry: IntegrationRegistryEntry) => {
    if (!entry.integrationId) return;
    const isGoogle =
      entry.providerKey === 'gmail_native' ||
      entry.providerKey === 'google_calendar_native' ||
      entry.providerKey === 'google_drive_native';

    setConfirmRequest({
      title: `Disconnect ${entry.connectorName}?`,
      description: isGoogle
        ? 'This revokes Task.ai access to your Google Workspace session token and deletes the workspace integration binding.'
        : 'This permanently deletes the encrypted credentials and disables task routing through this connector in this workspace.',
      targetSummary: `${entry.connectorName} (${entry.providerKey})`,
      confirmLabel: 'Disconnect & Revoke',
      isDestructive: true,
      onConfirm: async () => {
        setBusyKey(`disconnect:${entry.connectorId}`);
        try {
          await api.disconnectIntegration(entry.integrationId!, isGoogle);
          if (isGoogle) {
            clearGoogleWorkspaceAccessToken();
          }
          setConfirmRequest(null);
          setBannerMessage({
            tone: 'neutral',
            text: `Disconnected ${entry.connectorName} and purged workspace credentials.`,
          });
          await onRefreshWorkspace();
        } catch (err: unknown) {
          setBannerMessage({
            tone: 'error',
            text:
              err instanceof Error
                ? err.message
                : 'Failed to disconnect integration.',
          });
          setConfirmRequest(null);
        } finally {
          setBusyKey(null);
        }
      },
    });
  };

  const handleSaveGenericWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!webhookModalEntry || !whEndpointUrl.trim()) return;
    setBusyKey('save:webhook');
    setBannerMessage(null);
    try {
      await onCreateWebhookIntegration({
        providerKey: webhookModalEntry.providerKey as IntegrationProviderKey,
        displayName: whDisplayName.trim() || webhookModalEntry.connectorName,
        connectionMode: 'user_owned',
        endpointUrl: whEndpointUrl.trim(),
        authType: whAuthType,
        secret: whSecret.trim() || undefined,
        capabilities: webhookModalEntry.availableCapabilities,
      });
      setWebhookModalEntry(null);
      setBannerMessage({
        tone: 'success',
        text: `Saved ${whDisplayName.trim() || webhookModalEntry.connectorName} (encrypted at rest). Run Test Connection to verify readiness.`,
      });
    } catch (err: unknown) {
      setBannerMessage({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to save webhook connector.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleEvaluateWorkforce = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workforcePrompt.trim()) return;
    setBusyKey('workforce:evaluate');
    setBannerMessage(null);
    try {
      const res = await api.evaluateWorkforce({
        workspaceId,
        prompt: workforcePrompt.trim(),
      });
      setWorkforcePrompt('');
      setWorkforceExpanded(true);
      setBannerMessage({
        tone: res.workforceConfig.status === 'operational' ? 'success' : 'neutral',
        text:
          res.workforceConfig.status === 'operational'
            ? `Workforce "${res.workforceConfig.title}" is operational across all required capabilities.`
            : `Evaluated "${res.workforceConfig.title}". Authorize and live-test recommended connectors before activation.`,
      });
      await onRefreshWorkspace();
    } catch (err: unknown) {
      setBannerMessage({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to evaluate workforce configuration.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleWorkforceDecision = async (
    workforceId: string,
    action: 'approve' | 'reject' | 'modify',
    providerKey?: IntegrationProviderKey,
    replacementProviderKey?: IntegrationProviderKey
  ) => {
    setBusyKey(`wf:${workforceId}:${action}:${providerKey ?? ''}`);
    try {
      await api.decideWorkforceConnector(workforceId, {
        action,
        providerKey,
        replacementProviderKey,
      });
      await onRefreshWorkspace();
    } catch (err: unknown) {
      setBannerMessage({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to update workforce decision.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleActivateWorkforce = async (workforceId: string) => {
    setBusyKey(`wf:activate:${workforceId}`);
    setBannerMessage(null);
    try {
      const res = await api.activateWorkforce(workforceId);
      setBannerMessage({
        tone: res.activated ? 'success' : 'error',
        text: res.activated
          ? `Workforce "${res.workforceConfig.title}" passed all capability checks and is now operational.`
          : res.workforceConfig.activationBlockerReason ||
              'Workforce activation blocked: one or more required capabilities are not yet operational.',
      });
      await onRefreshWorkspace();
    } catch (err: unknown) {
      setBannerMessage({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Workforce capability verification failed.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleAiProviderHealth = async (providerId: AiProviderId) => {
    setBusyKey(`ai:health:${providerId}`);
    setBannerMessage(null);
    try {
      const res = await api.checkAiProviderHealth(providerId, workspaceId);
      setBannerMessage({
        tone: res.healthy ? 'success' : 'error',
        text: `${res.provider.name}: ${res.detail}`,
      });
      await onRefreshWorkspace();
    } catch (err: unknown) {
      setBannerMessage({
        tone: 'error',
        text:
          err instanceof Error ? err.message : 'AI provider health check failed.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleUpdateAiProvider = async (
    providerId: AiProviderId,
    patch: {
      enabled?: boolean;
      preferredModel?: string;
      fallbackPriority?: number;
    }
  ) => {
    setBusyKey(`ai:update:${providerId}`);
    try {
      await api.updateAiProvider(providerId, {
        workspaceId,
        ...patch,
      });
      await onRefreshWorkspace();
    } catch (err: unknown) {
      setBannerMessage({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to update AI provider configuration.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  // Filter registry items for the selected category
  const visibleEntries = registry.filter((entry) => {
    if (entry.connectorType === 'built_in') return false;
    if (activeCategory === 'recommended') return entry.recommended;
    if (activeCategory === 'connected_apps') {
      return (
        entry.category === 'connected_apps' ||
        entry.connectionStatus === 'connected'
      );
    }
    if (activeCategory === 'automation_platforms') {
      return entry.category === 'automation_platforms';
    }
    if (activeCategory === 'custom_api') {
      return entry.providerKey === 'custom_api' || entry.category === 'custom_api';
    }
    if (activeCategory === 'webhooks') {
      return (
        entry.connectorType === 'webhook' &&
        (entry.category === 'webhooks' || entry.integrationId !== null)
      );
    }
    return false;
  });

  const operationalCount = registry.filter(
    (r) => r.connectorType !== 'built_in' && r.capabilityReadiness === 'operational'
  ).length;
  const configuredCount = registry.filter(
    (r) => r.connectorType !== 'built_in' && r.integrationId !== null
  ).length;

  return (
    <div className="space-y-6">
      {/* Top Summary & Intelligent Workforce Configuration Manager Bar */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              Unified Integration Center &amp; Workforce Manager
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {operationalCount} operational connectors · {configuredCount}{' '}
              workspace bindings · {workforceConfigs.length} workforce blueprints
              · Multi-tenant AES-256-GCM vault active
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setWorkforceExpanded((prev) => !prev)}
              aria-expanded={workforceExpanded}
              className="min-h-[38px] px-3.5 py-2 text-xs font-medium rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>
                Workforce Configuration Manager ({workforceConfigs.length})
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                const found =
                  integrations.find((i) => i.providerKey === 'n8n_webhook') ??
                  null;
                setN8nEditingIntegration(found);
                setN8nModalOpen(true);
              }}
              className="min-h-[38px] px-3.5 py-2 text-xs font-medium rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>Configure n8n</span>
            </button>
            <button
              type="button"
              onClick={() => setCustomApiModalOpen(true)}
              className="min-h-[38px] px-3.5 py-2 text-xs font-semibold rounded-xl bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white text-white dark:text-slate-950 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Custom API</span>
            </button>
          </div>
        </div>

        {/* Intelligent Workforce Configuration Manager Section */}
        {workforceExpanded && (
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-4">
            <form
              onSubmit={handleEvaluateWorkforce}
              className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5"
            >
              <label htmlFor="workforce-prompt-input" className="sr-only">
                Describe AI employee or workforce role
              </label>
              <input
                id="workforce-prompt-input"
                type="text"
                value={workforcePrompt}
                onChange={(e) => setWorkforcePrompt(e.target.value)}
                placeholder="e.g., Create an AI employee that manages my customer support, emails, and calendar bookings"
                className="flex-1 min-h-[40px] px-3.5 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
              <button
                type="submit"
                disabled={
                  busyKey === 'workforce:evaluate' || !workforcePrompt.trim()
                }
                className="min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                {busyKey === 'workforce:evaluate'
                  ? 'Analyzing Capabilities...'
                  : 'Evaluate Workforce'}
              </button>
            </form>

            {workforceConfigs.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                No workforce configurations evaluated yet. Describe an AI
                employee above (or ask in Chat) to inspect required
                capabilities, connector recommendations, and live readiness
                gates.
              </p>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 border-t border-slate-200 dark:border-slate-800">
                {workforceConfigs.map((wf) => (
                  <div key={wf.id} className="py-4 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="font-semibold text-slate-900 dark:text-slate-100">
                            {wf.title}
                          </span>
                          <span aria-hidden="true" className="text-slate-400">
                            ·
                          </span>
                          <span
                            className={
                              wf.status === 'operational'
                                ? 'font-medium text-emerald-700 dark:text-emerald-400'
                                : wf.status === 'rejected'
                                  ? 'font-medium text-red-700 dark:text-red-400'
                                  : 'font-medium text-amber-700 dark:text-amber-400'
                            }
                          >
                            {wf.status === 'operational'
                              ? 'Operational'
                              : wf.status === 'rejected'
                                ? 'Rejected'
                                : 'Awaiting Operational Capabilities'}
                          </span>
                          <span aria-hidden="true" className="text-slate-400">
                            ·
                          </span>
                          <span className="text-slate-500 font-mono text-[11px]">
                            Required: {wf.requiredCapabilities.join(', ')}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 dark:text-slate-400">
                          {wf.roleSummary}
                        </p>
                      </div>

                      {wf.status !== 'operational' && (
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() => void handleActivateWorkforce(wf.id)}
                          className="min-h-[34px] px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                        >
                          <Play className="w-3.5 h-3.5" />
                          <span>Verify &amp; Activate Workforce</span>
                        </button>
                      )}
                    </div>

                    {/* Recommended Connectors with Approve / Modify / Reject */}
                    {wf.recommendedConnectors.length > 0 && (
                      <div className="space-y-2 pl-3 border-l border-slate-200 dark:border-slate-800">
                        {wf.recommendedConnectors.map((rec) => {
                          const tone = getReadinessTone(rec.currentReadiness);
                          const matchingReg =
                            registry.find(
                              (r) => r.providerKey === rec.providerKey
                            ) ?? null;
                          return (
                            <div
                              key={rec.providerKey}
                              className="flex flex-wrap items-center justify-between gap-3 py-1.5 text-xs"
                            >
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                                    {rec.connectorName}
                                  </span>
                                  <span
                                    aria-hidden="true"
                                    className="text-slate-400"
                                  >
                                    ·
                                  </span>
                                  <span className={`font-medium ${tone.textClass}`}>
                                    {tone.label}
                                  </span>
                                  <span
                                    aria-hidden="true"
                                    className="text-slate-400"
                                  >
                                    ·
                                  </span>
                                  <span className="text-slate-500 capitalize">
                                    Decision: {rec.decision}
                                  </span>
                                </div>
                                <p className="text-slate-600 dark:text-slate-400">
                                  {rec.reasonNeeded}
                                </p>
                              </div>

                              <div className="flex flex-wrap items-center gap-2 shrink-0">
                                {matchingReg &&
                                  rec.currentReadiness !== 'operational' && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        openConnectorAction(matchingReg)
                                      }
                                      className="min-h-[30px] px-2.5 py-1 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer"
                                    >
                                      Connect / Configure
                                    </button>
                                  )}

                                {rec.alternativeProviderKeys.length > 0 && (
                                  <select
                                    aria-label={`Modify connector for ${rec.connectorName}`}
                                    value=""
                                    onChange={(e) => {
                                      if (!e.target.value) return;
                                      void handleWorkforceDecision(
                                        wf.id,
                                        'modify',
                                        rec.providerKey,
                                        e.target.value as IntegrationProviderKey
                                      );
                                    }}
                                    className="min-h-[30px] px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                                  >
                                    <option value="">Modify connector...</option>
                                    {rec.alternativeProviderKeys.map((alt) => (
                                      <option key={alt} value={alt}>
                                        Switch to {alt}
                                      </option>
                                    ))}
                                  </select>
                                )}

                                <button
                                  type="button"
                                  disabled={busyKey !== null}
                                  onClick={() =>
                                    void handleWorkforceDecision(
                                      wf.id,
                                      'approve',
                                      rec.providerKey
                                    )
                                  }
                                  className="min-h-[30px] px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer"
                                >
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  disabled={busyKey !== null}
                                  onClick={() =>
                                    void handleWorkforceDecision(
                                      wf.id,
                                      'reject',
                                      rec.providerKey
                                    )
                                  }
                                  className="min-h-[30px] px-2.5 py-1 text-xs text-slate-600 dark:text-slate-400 hover:text-red-600 rounded-lg cursor-pointer"
                                >
                                  Reject
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {wf.activationBlockerReason && wf.status !== 'operational' && (
                      <p className="text-xs text-amber-800 dark:text-amber-300 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{wf.activationBlockerReason}</span>
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {bannerMessage && (
        <div
          role="status"
          className={`p-3.5 rounded-xl border text-xs flex items-center justify-between gap-3 ${
            bannerMessage.tone === 'error'
              ? 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300'
              : bannerMessage.tone === 'success'
                ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300'
          }`}
        >
          <span>{bannerMessage.text}</span>
          <button
            type="button"
            onClick={() => setBannerMessage(null)}
            className="underline font-medium shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 7 Category Navigation Bar */}
      <nav
        aria-label="Integration Center categories"
        className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-900 overflow-x-auto"
      >
        {CATEGORY_TABS.map((tab) => {
          const isActive = activeCategory === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveCategory(tab.id)}
              className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors cursor-pointer ${
                isActive
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* TAB D: AI PROVIDERS (Separate from ordinary application connectors) */}
      {activeCategory === 'ai_providers' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                AI Model Providers &amp; Runtime Fallback Gateway
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Google Gemini is active out-of-the-box via the built-in
                server-side runtime (no user API key required). Optional
                secondary providers use server-side environment keys only.
              </p>
            </div>
          </div>

          <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
            {aiProviders.map((prov) => (
              <div key={prov.providerId} className="p-5 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {prov.name}
                      </span>
                      <span aria-hidden="true" className="text-slate-400">
                        ·
                      </span>
                      <span
                        className={
                          prov.serverKeyConfigured && prov.enabled
                            ? 'font-medium text-emerald-700 dark:text-emerald-400'
                            : 'font-medium text-slate-500 dark:text-slate-400'
                        }
                      >
                        {prov.isBuiltInDefault
                          ? 'Active Built-in Default'
                          : prov.serverKeyConfigured
                            ? prov.enabled
                              ? 'Enabled (Server Key Ready)'
                              : 'Disabled (Server Key Ready)'
                            : 'Server Environment Key Not Configured'}
                      </span>
                      <span aria-hidden="true" className="text-slate-400">
                        ·
                      </span>
                      <span className="text-slate-500 tabular-nums">
                        Health: {prov.healthStatus}
                        {prov.lastLatencyMs !== null
                          ? ` (${prov.lastLatencyMs} ms)`
                          : ''}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      {prov.description}
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                      Usage: {prov.totalRequests} requests · {prov.failedRequests}{' '}
                      failures · Last checked:{' '}
                      {formatTimestamp(prov.lastCheckedAt)}
                      {prov.lastErrorMessage
                        ? ` · Error: ${prov.lastErrorMessage}`
                        : ''}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <label
                      htmlFor={`ai-model-${prov.providerId}`}
                      className="sr-only"
                    >
                      Preferred model for {prov.name}
                    </label>
                    <select
                      id={`ai-model-${prov.providerId}`}
                      value={prov.preferredModel}
                      onChange={(e) =>
                        void handleUpdateAiProvider(prov.providerId, {
                          preferredModel: e.target.value,
                        })
                      }
                      className="min-h-[36px] px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
                    >
                      {prov.supportedModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>

                    <label
                      htmlFor={`ai-priority-${prov.providerId}`}
                      className="sr-only"
                    >
                      Fallback priority for {prov.name}
                    </label>
                    <select
                      id={`ai-priority-${prov.providerId}`}
                      value={prov.fallbackPriority}
                      onChange={(e) =>
                        void handleUpdateAiProvider(prov.providerId, {
                          fallbackPriority: Number(e.target.value),
                        })
                      }
                      className="min-h-[36px] px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 tabular-nums"
                    >
                      <option value={1}>Priority 1</option>
                      <option value={2}>Priority 2</option>
                      <option value={3}>Priority 3</option>
                    </select>

                    {!prov.isBuiltInDefault && (
                      <button
                        type="button"
                        disabled={!prov.serverKeyConfigured || busyKey !== null}
                        onClick={() =>
                          void handleUpdateAiProvider(prov.providerId, {
                            enabled: !prov.enabled,
                          })
                        }
                        className="min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer disabled:opacity-50"
                      >
                        {prov.enabled ? 'Disable' : 'Enable'}
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={busyKey === `ai:health:${prov.providerId}`}
                      onClick={() =>
                        void handleAiProviderHealth(prov.providerId)
                      }
                      className="min-h-[36px] px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <Activity className="w-3.5 h-3.5" />
                      <span>
                        {busyKey === `ai:health:${prov.providerId}`
                          ? 'Checking...'
                          : 'Test Health'}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB G: CONNECTION HEALTH, 7-STATE CAPABILITY MATRIX & TELEMETRY */}
      {activeCategory === 'health' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                7-State Workspace Capability Readiness Matrix
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Distinguishes available, connected, authorized, configured,
                tested, operational, and unavailable capabilities in real time.
              </p>
            </div>
            <button
              type="button"
              onClick={async () => {
                const res = await onRotateWorkspaceKeys();
                setBannerMessage({
                  tone: 'success',
                  text: `Vault key rotation completed: ${res.rotatedCount} re-encrypted, ${res.alreadyCurrentCount} current.`,
                });
              }}
              className="min-h-[36px] px-3.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>Rotate AES-256-GCM Vault Keys</span>
            </button>
          </div>

          <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
            {capabilityEntries.map((cap) => {
              const tone = getReadinessTone(cap.state);
              return (
                <div
                  key={cap.capability}
                  className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-0.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-slate-900 dark:text-slate-100">
                        {cap.label}
                      </span>
                      <span aria-hidden="true" className="text-slate-400">
                        ·
                      </span>
                      <span className="font-mono text-[11px] text-slate-500">
                        {cap.capability}
                      </span>
                    </div>
                    <p className="text-slate-600 dark:text-slate-400">
                      {cap.detail}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className={`font-semibold ${tone.textClass}`}>
                      {tone.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Live Integration Activity Log */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Recent Connector &amp; Health Activity ({activityLogs.length})
            </h3>
            {activityLogs.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                No connector activity recorded in this workspace yet. Run a
                connection test or authorize an application to populate live
                telemetry.
              </p>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
                {activityLogs.map((log) => (
                  <div
                    key={log.id}
                    className="p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                          {log.providerKey}
                        </span>
                        <span aria-hidden="true" className="text-slate-400">
                          ·
                        </span>
                        <span className="text-slate-500">{log.operation}</span>
                        <span aria-hidden="true" className="text-slate-400">
                          ·
                        </span>
                        <span
                          className={
                            log.status === 'success'
                              ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                              : 'text-red-700 dark:text-red-400 font-medium'
                          }
                        >
                          {log.status}
                          {log.httpStatus !== null
                            ? ` (HTTP ${log.httpStatus})`
                            : ''}
                        </span>
                      </div>
                      <p className="text-slate-600 dark:text-slate-400 break-words">
                        {log.summary}
                      </p>
                    </div>
                    <span className="text-[11px] text-slate-500 tabular-nums shrink-0">
                      {log.durationMs !== null ? `${log.durationMs} ms · ` : ''}
                      {formatTimestamp(log.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TABS A, B, C, E, F: CONNECTOR DIRECTORY LIST */}
      {activeCategory !== 'ai_providers' &&
        activeCategory !== 'health' && (
          <div className="space-y-4">
            {activeCategory === 'custom_api' && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  Connect internal or third-party HTTPS REST APIs with custom
                  headers, query parameters, JSON body validation, and encrypted
                  credentials.
                </p>
                <button
                  type="button"
                  onClick={() => setCustomApiModalOpen(true)}
                  className="min-h-[36px] px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 inline-flex items-center gap-1.5 cursor-pointer shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Register Custom API</span>
                </button>
              </div>
            )}

            {visibleEntries.length === 0 ? (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center space-y-2">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  No connectors in this view yet
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Connect an application from Recommended Integrations or add a
                  Custom API / Webhook endpoint.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
                {visibleEntries.map((entry) => {
                  const readinessTone = getReadinessTone(
                    entry.capabilityReadiness
                  );
                  const isConnectedOrBound = entry.integrationId !== null;
                  const isTesting = busyKey === `test:${entry.connectorId}`;

                  return (
                    <article
                      key={entry.connectorId}
                      aria-label={entry.connectorName}
                      className="p-5 space-y-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="space-y-1.5 min-w-0 flex-1">
                          {/* Title + Unboxed Metadata Row (Zero-Pill Discipline) */}
                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                              {entry.connectorName}
                            </h3>
                            <span aria-hidden="true" className="text-slate-400">
                              ·
                            </span>
                            <span className="text-slate-500 dark:text-slate-400">
                              {CATEGORY_HUMAN_NAMES[entry.category]}
                            </span>
                            <span aria-hidden="true" className="text-slate-400">
                              ·
                            </span>
                            <span
                              className={`font-medium ${readinessTone.textClass}`}
                            >
                              {readinessTone.label}
                            </span>
                            <span aria-hidden="true" className="text-slate-400">
                              ·
                            </span>
                            <span className="text-slate-500 dark:text-slate-400">
                              Connection: {entry.connectionStatus}
                            </span>
                            <span aria-hidden="true" className="text-slate-400">
                              ·
                            </span>
                            <span className="text-slate-500 dark:text-slate-400">
                              Auth: {entry.authorizationStatus}
                            </span>
                          </div>

                          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                            {entry.description}
                          </p>

                          {/* Capabilities & Telemetry Metadata */}
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                            <span className="font-mono">
                              Capabilities:{' '}
                              {entry.availableCapabilities.join(', ')}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>
                              Last verified:{' '}
                              {formatTimestamp(entry.lastSuccessfulConnection)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>
                              Last activity:{' '}
                              {formatTimestamp(entry.lastActivity)}
                            </span>
                            {typeof entry.registeredWorkflowCount ===
                              'number' && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>
                                  Registered workflows:{' '}
                                  {entry.registeredWorkflowCount}
                                </span>
                              </>
                            )}
                          </div>

                          {/* Error / Reconnect Status */}
                          {entry.failureInformation && (
                            <p className="text-xs text-red-700 dark:text-red-400 flex items-start gap-1.5 pt-0.5">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                              <span className="break-words">
                                Error: {entry.failureInformation}
                              </span>
                            </p>
                          )}
                        </div>

                        {/* Action Controls: Connect/Disconnect, Configure, Test Connection, Reconnect */}
                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          {entry.reconnectRequired && (
                            <button
                              type="button"
                              onClick={() => openConnectorAction(entry)}
                              className="min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              <span>Reconnect</span>
                            </button>
                          )}

                          {!isConnectedOrBound ? (
                            <button
                              type="button"
                              onClick={() => openConnectorAction(entry)}
                              className="min-h-[36px] px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white text-white dark:text-slate-950 cursor-pointer"
                            >
                              {entry.connectorType === 'webhook' ||
                              entry.connectorType === 'custom_api'
                                ? 'Configure'
                                : 'Connect'}
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={isTesting}
                                onClick={() => void handleTestConnector(entry)}
                                className="min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                              >
                                <ShieldCheck className="w-3.5 h-3.5" />
                                <span>
                                  {isTesting
                                    ? 'Testing...'
                                    : 'Test Connection'}
                                </span>
                              </button>

                              <button
                                type="button"
                                onClick={() => openConnectorAction(entry)}
                                className="min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer"
                              >
                                Configure
                              </button>

                              <button
                                type="button"
                                onClick={() => handleDisconnectConnector(entry)}
                                aria-label={`Disconnect ${entry.connectorName}`}
                                className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-400 border border-slate-300 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                              >
                                <Unplug className="w-3.5 h-3.5" />
                                <span>Disconnect</span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

      {/* Generic Webhook Adapter Modal (Make, Zapier, CRM, Payment, Custom Webhook) */}
      {webhookModalEntry && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="generic-webhook-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
        >
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xl p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2
                  id="generic-webhook-modal-title"
                  className="text-base font-semibold tracking-tight"
                >
                  Configure {webhookModalEntry.connectorName}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {webhookModalEntry.description}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setWebhookModalEntry(null)}
                aria-label="Close webhook configuration dialog"
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveGenericWebhook} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="wh-modal-name"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Connection Label
                </label>
                <input
                  id="wh-modal-name"
                  type="text"
                  required
                  value={whDisplayName}
                  onChange={(e) => setWhDisplayName(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="wh-modal-url"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  HTTPS Webhook Endpoint URL
                </label>
                <input
                  id="wh-modal-url"
                  type="url"
                  required
                  value={whEndpointUrl}
                  onChange={(e) => setWhEndpointUrl(e.target.value)}
                  placeholder="https://hooks.example.com/taskai"
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="wh-modal-auth"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Authentication / Signing Mode
                </label>
                <select
                  id="wh-modal-auth"
                  value={whAuthType}
                  onChange={(e) =>
                    setWhAuthType(e.target.value as IntegrationAuthType)
                  }
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  <option value="hmac_sha256">HMAC-SHA256 Signature</option>
                  <option value="bearer_token">Bearer Token</option>
                  <option value="header_secret">Custom Header Secret</option>
                  <option value="none">None</option>
                </select>
              </div>

              {whAuthType !== 'none' && (
                <div className="space-y-1.5">
                  <label
                    htmlFor="wh-modal-secret"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Signing Secret / Token (Encrypted Server-Side)
                  </label>
                  <input
                    id="wh-modal-secret"
                    type="password"
                    value={whSecret}
                    onChange={(e) => setWhSecret(e.target.value)}
                    placeholder="Enter webhook secret"
                    className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
                  />
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setWebhookModalEntry(null)}
                  className="min-h-[40px] px-4 py-2 text-xs font-medium rounded-xl border border-slate-300 dark:border-slate-700 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyKey === 'save:webhook'}
                  className="min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 cursor-pointer disabled:opacity-50"
                >
                  {busyKey === 'save:webhook' ? 'Saving...' : 'Save Webhook'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Specialized Modals */}
      <NativeConnectModal
        isOpen={Boolean(nativeEntryModal)}
        entry={nativeEntryModal}
        workspaceId={workspaceId}
        onClose={() => setNativeEntryModal(null)}
        onConnected={onRefreshWorkspace}
      />

      <N8nConfigModal
        isOpen={n8nModalOpen}
        workspaceId={workspaceId}
        existingIntegration={n8nEditingIntegration}
        workflows={n8nWorkflows}
        onClose={() => setN8nModalOpen(false)}
        onUpdated={onRefreshWorkspace}
      />

      <CustomApiModal
        isOpen={customApiModalOpen}
        workspaceId={workspaceId}
        onClose={() => setCustomApiModalOpen(false)}
        onCreated={onRefreshWorkspace}
      />

      <WorkspaceMutationConfirmModal
        request={confirmRequest}
        busy={busyKey?.startsWith('disconnect:') ?? false}
        onCancel={() => setConfirmRequest(null)}
      />
    </div>
  );
};
