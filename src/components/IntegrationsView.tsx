import React, { useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Plus,
  Trash2,
  ShieldCheck,
  AlertCircle,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { EnvConfigModal } from './EnvConfigModal';
import type {
  CapabilityId,
  EnvironmentDiagnosticsResponse,
  IntegrationAuthType,
  IntegrationConnectionMode,
  IntegrationProviderKey,
  PlatformCapabilitiesInfo,
  ToolRegistryItem,
  UserIntegrationRecord,
} from '../types';

interface IntegrationsViewProps {
  workspaceName: string;
  tools: ToolRegistryItem[];
  integrations: UserIntegrationRecord[];
  platformCapabilities: PlatformCapabilitiesInfo | null;
  onCreateIntegration: (payload: {
    providerKey: IntegrationProviderKey;
    displayName: string;
    connectionMode: IntegrationConnectionMode;
    endpointUrl?: string;
    webhookPath?: string;
    workflowId?: string;
    authType: IntegrationAuthType;
    secretHeaderName?: string;
    secret?: string;
    capabilities: CapabilityId[];
  }) => Promise<void>;
  onToggleIntegration: (integrationId: string, enabled: boolean) => Promise<void>;
  onDeleteIntegration: (integrationId: string) => Promise<void>;
  onTestIntegration: (integrationId: string) => Promise<{
    success: boolean;
    statusDetail: string;
  }>;
  onFetchEnvironmentDiagnostics: () => Promise<EnvironmentDiagnosticsResponse>;
  onRotateWorkspaceKeys: () => Promise<{
    rotatedCount: number;
    alreadyCurrentCount: number;
    noSecretCount: number;
  }>;
}

const PROVIDER_OPTIONS: Array<{
  value: IntegrationProviderKey;
  label: string;
  defaultCaps: CapabilityId[];
}> = [
  {
    value: 'custom_webhook',
    label: 'Custom HTTPS Webhook Adapter (Provider-Agnostic)',
    defaultCaps: ['workflow_automation', 'http_request'],
  },
  {
    value: 'n8n_webhook',
    label: 'n8n Workflow Execution Adapter (Optional)',
    defaultCaps: ['workflow_automation', 'message_dispatch', 'crm_sync'],
  },
  {
    value: 'make_webhook',
    label: 'Make.com Scenario Webhook Adapter',
    defaultCaps: ['workflow_automation', 'http_request'],
  },
  {
    value: 'zapier_webhook',
    label: 'Zapier Catch Hook Adapter',
    defaultCaps: ['workflow_automation', 'http_request'],
  },
  {
    value: 'crm_webhook',
    label: 'CRM Lead & Deal Sync Adapter',
    defaultCaps: ['crm_sync', 'prospect_search', 'http_request'],
  },
  {
    value: 'gmail_api',
    label: 'Email / Gmail HTTPS Relay Bridge (Non-Native OAuth)',
    defaultCaps: ['message_dispatch', 'http_request'],
  },
  {
    value: 'google_calendar_api',
    label: 'Calendar Booking HTTPS Relay Bridge (Non-Native OAuth)',
    defaultCaps: ['calendar_booking', 'http_request'],
  },
  {
    value: 'payment_webhook',
    label: 'Payment & Checkout Verification Adapter',
    defaultCaps: ['payment_verification', 'http_request'],
  },
];

function formatProviderClassification(
  cls: ToolRegistryItem['integrationClassification']
): string {
  switch (cls) {
    case 'native_implemented':
      return 'Native Runtime Implemented';
    case 'generic_webhook_adapter':
      return 'Generic HTTPS Webhook Adapter';
    case 'partially_implemented':
      return 'HTTPS Relay Bridge (Partial · Non-Native SDK)';
    case 'registered_unavailable':
    default:
      return 'Registered · Unavailable';
  }
}

const EXTERNAL_CAPABILITIES: Array<{
  id: CapabilityId;
  label: string;
  hint: string;
}> = [
  {
    id: 'workflow_automation',
    label: 'workflow_automation',
    hint: 'Multi-step external automation workflows',
  },
  {
    id: 'message_dispatch',
    label: 'message_dispatch',
    hint: 'Approved outbound email or message delivery',
  },
  {
    id: 'crm_sync',
    label: 'crm_sync',
    hint: 'CRM lead & deal record synchronization',
  },
  {
    id: 'prospect_search',
    label: 'prospect_search',
    hint: 'External prospect discovery & enrichment',
  },
  {
    id: 'calendar_booking',
    label: 'calendar_booking',
    hint: 'Discovery call & calendar booking dispatch',
  },
  {
    id: 'payment_verification',
    label: 'payment_verification',
    hint: 'Checkout dispatch & settled payment verification',
  },
  {
    id: 'http_request',
    label: 'http_request',
    hint: 'Authenticated HTTPS webhook invocation',
  },
];

export const IntegrationsView: React.FC<IntegrationsViewProps> = ({
  workspaceName,
  tools,
  integrations,
  platformCapabilities,
  onCreateIntegration,
  onToggleIntegration,
  onDeleteIntegration,
  onTestIntegration,
  onFetchEnvironmentDiagnostics,
  onRotateWorkspaceKeys,
}) => {
  const [formOpen, setFormOpen] = useState(false);
  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [envDiagnostics, setEnvDiagnostics] =
    useState<EnvironmentDiagnosticsResponse | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const [providerKey, setProviderKey] =
    useState<IntegrationProviderKey>('custom_webhook');
  const [connectionMode, setConnectionMode] =
    useState<IntegrationConnectionMode>('user_owned');
  const [displayName, setDisplayName] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [webhookPath, setWebhookPath] = useState('');
  const [authType, setAuthType] = useState<IntegrationAuthType>('hmac_sha256');
  const [secretHeaderName, setSecretHeaderName] = useState(
    'X-TaskAI-Webhook-Secret'
  );
  const [secret, setSecret] = useState('');
  const [selectedCaps, setSelectedCaps] = useState<CapabilityId[]>([
    'workflow_automation',
    'http_request',
  ]);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyIntegrationId, setBusyIntegrationId] = useState<string | null>(
    null
  );
  const [banner, setBanner] = useState<{
    tone: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);

  const loadEnvironmentDiagnostics = async () => {
    setEnvLoading(true);
    setEnvError(null);
    try {
      const data = await onFetchEnvironmentDiagnostics();
      setEnvDiagnostics(data);
    } catch (err: unknown) {
      setEnvError(
        err instanceof Error
          ? err.message
          : 'Failed to inspect server environment configuration.'
      );
    } finally {
      setEnvLoading(false);
    }
  };

  const handleOpenEnvModal = () => {
    setEnvModalOpen(true);
    void loadEnvironmentDiagnostics();
  };

  const toggleCapability = (cap: CapabilityId) => {
    setSelectedCaps((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]
    );
  };

  const resetForm = () => {
    setDisplayName('');
    setEndpointUrl('');
    setWorkflowId('');
    setWebhookPath('');
    setSecret('');
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBanner(null);

    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setFormError('Please provide a display name for this integration.');
      return;
    }
    if (selectedCaps.length === 0) {
      setFormError(
        'Select at least one capability that this integration provides.'
      );
      return;
    }

    const effectiveMode: IntegrationConnectionMode =
      providerKey === 'n8n_webhook' ? connectionMode : 'user_owned';

    if (effectiveMode === 'user_owned' && !endpointUrl.trim()) {
      setFormError('Please enter a valid HTTPS destination URL.');
      return;
    }

    if (effectiveMode === 'platform_shared' && !workflowId.trim()) {
      setFormError(
        'Platform-shared n8n mode requires an isolated workflow identifier.'
      );
    }

    if (
      effectiveMode === 'user_owned' &&
      authType !== 'none' &&
      !secret.trim()
    ) {
      setFormError(
        'Enter the signing secret or token for the selected authentication method, or choose "None".'
      );
      return;
    }

    setSubmitting(true);
    try {
      await onCreateIntegration({
        providerKey,
        displayName: trimmedName,
        connectionMode: effectiveMode,
        endpointUrl:
          effectiveMode === 'user_owned' ? endpointUrl.trim() : undefined,
        workflowId: workflowId.trim() || undefined,
        webhookPath:
          effectiveMode === 'platform_shared'
            ? webhookPath.trim() || undefined
            : undefined,
        authType,
        secretHeaderName:
          authType === 'header_secret'
            ? secretHeaderName.trim() || 'X-TaskAI-Webhook-Secret'
            : undefined,
        secret: secret.trim() || undefined,
        capabilities: selectedCaps,
      });

      resetForm();
      setFormOpen(false);
      setBanner({
        tone: 'success',
        text: `Saved integration "${trimmedName}" for ${workspaceName}. Run "Test Connection" to verify reachability before routing live tasks.`,
      });
    } catch (err: unknown) {
      setFormError(
        err instanceof Error ? err.message : 'Failed to save integration.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async (integration: UserIntegrationRecord) => {
    setBusyIntegrationId(`test:${integration.id}`);
    setBanner(null);
    try {
      const res = await onTestIntegration(integration.id);
      setBanner({
        tone: res.success ? 'success' : 'warning',
        text: `[${integration.displayName}] ${res.statusDetail}`,
      });
    } catch (err: unknown) {
      setBanner({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Integration connection probe failed.',
      });
    } finally {
      setBusyIntegrationId(null);
    }
  };

  const handleToggle = async (integration: UserIntegrationRecord) => {
    setBusyIntegrationId(`toggle:${integration.id}`);
    setBanner(null);
    try {
      await onToggleIntegration(integration.id, !integration.enabled);
      setBanner({
        tone: 'success',
        text: `Integration "${integration.displayName}" ${
          integration.enabled ? 'disabled' : 'enabled'
        }.`,
      });
    } catch (err: unknown) {
      setBanner({
        tone: 'error',
        text:
          err instanceof Error ? err.message : 'Failed to update integration.',
      });
    } finally {
      setBusyIntegrationId(null);
    }
  };

  const handleDelete = async (integration: UserIntegrationRecord) => {
    setBusyIntegrationId(`delete:${integration.id}`);
    setBanner(null);
    try {
      await onDeleteIntegration(integration.id);
      setBanner({
        tone: 'success',
        text: `Removed integration "${integration.displayName}" from ${workspaceName}.`,
      });
    } catch (err: unknown) {
      setBanner({
        tone: 'error',
        text:
          err instanceof Error ? err.message : 'Failed to remove integration.',
      });
    } finally {
      setBusyIntegrationId(null);
    }
  };

  const sharedN8nAvailable = Boolean(
    platformCapabilities?.sharedN8nAvailable
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-slate-900">
            Integration Manager &amp; Execution Router
          </h1>
          <p className="text-sm text-slate-600 max-w-3xl">
            Configure provider-agnostic automation adapters independently for{' '}
            <span className="font-semibold text-slate-900">{workspaceName}</span>
            . Credentials are encrypted server-side and never exposed to the
            browser, AI prompts, logs, or other users.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={handleOpenEnvModal}
            className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Environment Configuration</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setFormError(null);
              setFormOpen((prev) => !prev);
            }}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {formOpen ? (
              <>
                <X className="w-3.5 h-3.5" />
                <span>Close Form</span>
              </>
            ) : (
              <>
                <Plus className="w-3.5 h-3.5" />
                <span>Connect Integration</span>
              </>
            )}
          </button>
        </div>
      </div>

      {banner && (
        <div
          role="status"
          className={`p-4 rounded-xl border text-sm ${
            banner.tone === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : banner.tone === 'error'
                ? 'bg-red-50 border-red-200 text-red-900'
                : 'bg-amber-50 border-amber-200 text-amber-900'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* Connect New Workspace Integration Form */}
      {formOpen && (
        <section
          aria-labelledby="connect-integration-heading"
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
        >
          <div className="space-y-1">
            <h2
              id="connect-integration-heading"
              className="text-base font-semibold text-slate-900"
            >
              Connect Workspace Integration
            </h2>
            <p className="text-xs text-slate-500">
              All outbound destinations must use HTTPS and pass server-side SSRF
              validation. n8n is optional—custom webhooks, Make, Zapier, CRM,
              email, calendar, and payment adapters all use a common
              capability-routed interface.
            </p>
          </div>

          {formError && (
            <div
              role="alert"
              className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 flex items-start gap-2.5"
            >
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{formError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="integration-provider-select"
                  className="block text-sm font-medium text-slate-800"
                >
                  Execution Provider Adapter
                </label>
                <select
                  id="integration-provider-select"
                  value={providerKey}
                  onChange={(e) => {
                    const next = e.target.value as IntegrationProviderKey;
                    setProviderKey(next);
                    if (next !== 'n8n_webhook') {
                      setConnectionMode('user_owned');
                    }
                    const match = PROVIDER_OPTIONS.find(
                      (p) => p.value === next
                    );
                    if (match) {
                      setSelectedCaps(match.defaultCaps);
                    }
                  }}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {PROVIDER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="integration-display-name"
                  className="block text-sm font-medium text-slate-800"
                >
                  Integration Display Name
                </label>
                <input
                  id="integration-display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g., Outbound CRM Dispatch Webhook"
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  required
                />
              </div>
            </div>

            {providerKey === 'n8n_webhook' && (
              <div className="space-y-1.5">
                <label
                  htmlFor="n8n-connection-mode"
                  className="block text-sm font-medium text-slate-800"
                >
                  n8n Instance Ownership Mode
                </label>
                <select
                  id="n8n-connection-mode"
                  value={connectionMode}
                  onChange={(e) =>
                    setConnectionMode(
                      e.target.value as IntegrationConnectionMode
                    )
                  }
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="user_owned">
                    User-Owned / Workspace n8n Instance (Direct HTTPS Webhook)
                  </option>
                  <option
                    value="platform_shared"
                    disabled={!sharedN8nAvailable}
                  >
                    Platform-Shared n8n Instance (Isolated Workflow Route
                    {sharedN8nAvailable
                      ? ` · ${platformCapabilities?.sharedN8nOrigin}`
                      : ' · Not enabled by platform admin'}
                    )
                  </option>
                </select>
              </div>
            )}

            {providerKey === 'n8n_webhook' &&
            connectionMode === 'platform_shared' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="shared-workflow-id"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Isolated Workflow Identifier
                  </label>
                  <input
                    id="shared-workflow-id"
                    type="text"
                    value={workflowId}
                    onChange={(e) => setWorkflowId(e.target.value)}
                    placeholder="e.g., wf_lead_enrichment_v2"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="shared-webhook-path"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Isolated Webhook Path (Optional)
                  </label>
                  <input
                    id="shared-webhook-path"
                    type="text"
                    value={webhookPath}
                    onChange={(e) => setWebhookPath(e.target.value)}
                    placeholder="/webhook/wf_lead_enrichment_v2"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-2 space-y-1.5">
                  <label
                    htmlFor="integration-endpoint-url"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Destination HTTPS Endpoint URL
                  </label>
                  <input
                    id="integration-endpoint-url"
                    type="url"
                    value={endpointUrl}
                    onChange={(e) => setEndpointUrl(e.target.value)}
                    placeholder="https://automations.example.com/webhook/task-dispatch"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="integration-workflow-id"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Workflow / Scenario ID (Optional)
                  </label>
                  <input
                    id="integration-workflow-id"
                    type="text"
                    value={workflowId}
                    onChange={(e) => setWorkflowId(e.target.value)}
                    placeholder="e.g., outbound-seq-01"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>
            )}

            {/* Request Authentication & Write-Only Secret */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-100">
              <div className="space-y-1.5">
                <label
                  htmlFor="integration-auth-type"
                  className="block text-sm font-medium text-slate-800"
                >
                  Request Authentication
                </label>
                <select
                  id="integration-auth-type"
                  value={authType}
                  onChange={(e) =>
                    setAuthType(e.target.value as IntegrationAuthType)
                  }
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="hmac_sha256">
                    HMAC-SHA256 Signature (X-TaskAI-Signature)
                  </option>
                  <option value="bearer_token">
                    Authorization: Bearer Token
                  </option>
                  <option value="header_secret">Custom Secret Header</option>
                  <option value="none">None</option>
                </select>
              </div>

              {authType === 'header_secret' && (
                <div className="space-y-1.5">
                  <label
                    htmlFor="integration-header-name"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Secret Header Name
                  </label>
                  <input
                    id="integration-header-name"
                    type="text"
                    value={secretHeaderName}
                    onChange={(e) => setSecretHeaderName(e.target.value)}
                    placeholder="X-TaskAI-Webhook-Secret"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 font-mono focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              )}

              {authType !== 'none' && (
                <div
                  className={
                    authType === 'header_secret'
                      ? 'space-y-1.5'
                      : 'sm:col-span-2 space-y-1.5'
                  }
                >
                  <label
                    htmlFor="integration-secret-input"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Webhook Signing Secret / Token (Write-Only)
                  </label>
                  <input
                    id="integration-secret-input"
                    type="password"
                    autoComplete="new-password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="Encrypted server-side; never returned after save"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              )}
            </div>

            {/* Capabilities Checkboxes */}
            <fieldset className="space-y-2 pt-2 border-t border-slate-100">
              <legend className="text-sm font-medium text-slate-800">
                Supported Execution Capabilities
              </legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {EXTERNAL_CAPABILITIES.map((cap) => (
                  <label
                    key={cap.id}
                    className="flex items-start gap-2.5 p-2.5 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedCaps.includes(cap.id)}
                      onChange={() => toggleCapability(cap.id)}
                      className="mt-0.5 rounded border-slate-300 text-slate-900 focus:ring-blue-600"
                    />
                    <span className="space-y-0.5">
                      <span className="block text-xs font-mono font-semibold text-slate-900">
                        {cap.label}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {cap.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="pt-2 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  setFormOpen(false);
                }}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {submitting ? 'Encrypting & Saving...' : 'Save Integration'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Workspace Connected Integrations */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900 tabular-nums">
              Connected Workspace Integrations ({integrations.length})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Scoped exclusively to {workspaceName}. Unverified or disabled
              integrations are never selected by the Execution Router.
            </p>
          </div>
        </div>

        {integrations.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-sm font-medium text-slate-800">
              No external integrations connected in {workspaceName}.
            </p>
            <p className="text-xs text-slate-500 max-w-lg mx-auto">
              Built-in server-side AI reasoning and deterministic SHA-256
              verification run without external webhooks. Connect a workspace
              provider adapter above when your tasks require external dispatch
              or automation.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {integrations.map((item) => {
              const isTesting = busyIntegrationId === `test:${item.id}`;
              const isToggling = busyIntegrationId === `toggle:${item.id}`;
              const isDeleting = busyIntegrationId === `delete:${item.id}`;
              const anyBusy = isTesting || isToggling || isDeleting;

              return (
                <div key={item.id} className="p-6 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1 max-w-2xl">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="font-mono font-semibold text-slate-800">
                          {item.providerKey}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {item.connectionMode === 'platform_shared'
                            ? 'Platform-Shared Isolated Workflow'
                            : 'User-Owned HTTPS Endpoint'}
                        </span>
                        <span aria-hidden="true">·</span>
                        {!item.enabled ? (
                          <span className="text-slate-500 font-semibold">
                            Disabled
                          </span>
                        ) : item.verified ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            <span>Verified</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-800 font-semibold">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>Unverified (Test Required)</span>
                          </span>
                        )}
                      </div>

                      <h3 className="text-base font-semibold text-slate-900">
                        {item.displayName}
                      </h3>

                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 font-mono">
                        <span>
                          {item.configMetadata.endpointUrl ||
                            `${item.configMetadata.destinationOrigin ?? ''}${
                              item.configMetadata.webhookPath ?? ''
                            }`}
                        </span>
                        {item.configMetadata.workflowId && (
                          <>
                            <span aria-hidden="true" className="text-slate-300">
                              ·
                            </span>
                            <span>
                              workflow: {item.configMetadata.workflowId}
                            </span>
                          </>
                        )}
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span>auth: {item.configMetadata.authType}</span>
                        {item.hasSecret && item.secretMaskedHint && (
                          <>
                            <span aria-hidden="true" className="text-slate-300">
                              ·
                            </span>
                            <span>secret: {item.secretMaskedHint}</span>
                          </>
                        )}
                      </div>

                      <p className="text-xs text-slate-500">
                        Capabilities:{' '}
                        <span className="font-mono text-slate-700">
                          {item.capabilities.join(' · ')}
                        </span>
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={anyBusy || !item.enabled}
                        onClick={() => handleTest(item)}
                        aria-label={`Test connection for ${item.displayName}`}
                        className="px-3 py-1.5 text-xs font-semibold text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${
                            isTesting ? 'animate-spin' : ''
                          }`}
                        />
                        <span>
                          {isTesting ? 'Testing...' : 'Test Connection'}
                        </span>
                      </button>

                      <button
                        type="button"
                        disabled={anyBusy}
                        onClick={() => handleToggle(item)}
                        aria-label={`${
                          item.enabled ? 'Disable' : 'Enable'
                        } integration ${item.displayName}`}
                        className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {item.enabled ? 'Disable' : 'Enable'}
                      </button>

                      <button
                        type="button"
                        disabled={anyBusy}
                        onClick={() => handleDelete(item)}
                        aria-label={`Remove integration ${item.displayName}`}
                        className="p-1.5 text-slate-500 hover:text-red-700 border border-slate-200 hover:border-red-200 rounded-lg disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                    <span>{item.statusDetail}</span>
                    {item.lastTestedAt && (
                      <span className="font-mono tabular-nums">
                        Last probed:{' '}
                        {new Date(item.lastTestedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Execution Router Provider Registry */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">
            Provider-Agnostic Execution Router Registry
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Common provider descriptor interface across built-in runtimes and
            workspace-configurable external adapters.
          </p>
        </div>

        <div className="divide-y divide-slate-200">
          {tools.map((tool) => {
            const isReady = tool.configured && tool.verified;

            return (
              <div key={tool.id} className="p-6 space-y-2.5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1 max-w-2xl">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                      <span className="font-mono font-semibold text-slate-800">
                        {tool.id}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {tool.scope === 'built_in'
                          ? 'Built-In Platform Provider'
                          : formatProviderClassification(
                              tool.integrationClassification
                            )}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">
                        {tool.rateLimit.requestsPerMinute} RPM
                      </span>
                      <span aria-hidden="true">·</span>
                      {isReady ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                          <span>Ready for Routing</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-800 font-semibold">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          <span>
                            {tool.configured
                              ? 'Configured · Pending Verification'
                              : 'Not Configured in Workspace'}
                          </span>
                        </span>
                      )}
                    </div>

                    <h3 className="text-sm font-semibold text-slate-900">
                      {tool.name}
                    </h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      {tool.description}
                    </p>
                    <p className="text-xs text-slate-500">
                      Auth: {tool.authenticationMethod} · Interface:{' '}
                      <span className="font-mono">
                        {tool.executionInterface}
                      </span>{' '}
                      · Verification:{' '}
                      <span className="font-mono">
                        {tool.verificationCapabilities.join(', ')}
                      </span>
                    </p>
                  </div>

                  <div className="text-xs text-slate-500 font-mono">
                    {tool.capabilities.join(' · ')}
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-100 text-xs text-slate-500">
                  {tool.statusDetail}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Tenant Security & SSRF Protection Summary */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3 max-w-4xl">
          <ShieldCheck className="w-5 h-5 text-slate-700 shrink-0 mt-0.5" />
          <div className="space-y-1 text-xs text-slate-600 leading-relaxed">
            <p className="font-semibold text-slate-900">
              Tenant Isolation &amp; Outbound Destination Guardrails
            </p>
            <p>
              Every integration credential is encrypted at rest using AES-256-GCM
              before persistence and decrypted exclusively inside the server-side
              Execution Router at dispatch time. Outbound webhook calls enforce
              HTTPS, block private/loopback/metadata IP ranges and DNS rebinding,
              disable redirects, and attach tenant attribution headers (
              <code className="font-mono text-slate-800">X-TaskAI-User-Id</code>,{' '}
              <code className="font-mono text-slate-800">
                X-TaskAI-Workspace-Id
              </code>
              ,{' '}
              <code className="font-mono text-slate-800">X-Idempotency-Key</code>
              ).
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleOpenEnvModal}
          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          Inspect Server Variables
        </button>
      </section>

      <EnvConfigModal
        isOpen={envModalOpen}
        workspaceName={workspaceName}
        diagnostics={envDiagnostics}
        loading={envLoading}
        error={envError}
        onClose={() => setEnvModalOpen(false)}
        onRefresh={loadEnvironmentDiagnostics}
        onRotateKeys={onRotateWorkspaceKeys}
      />
    </div>
  );
};
