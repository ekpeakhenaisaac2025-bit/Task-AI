import React, { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import type {
  CapabilityId,
  CustomApiHttpMethod,
  IntegrationAuthType,
  N8nRegisteredWorkflowRecord,
  UserIntegrationRecord,
} from '../../types';

interface N8nConfigModalProps {
  isOpen: boolean;
  workspaceId: string | undefined;
  existingIntegration: UserIntegrationRecord | null;
  workflows: N8nRegisteredWorkflowRecord[];
  onClose: () => void;
  onUpdated: () => Promise<void>;
}

const CAPABILITY_OPTIONS: ReadonlyArray<{ id: CapabilityId; label: string }> = [
  { id: 'workflow_automation', label: 'Workflow Automation' },
  { id: 'message_dispatch', label: 'Message & Email Dispatch' },
  { id: 'crm_sync', label: 'CRM Lead / Ticket Sync' },
  { id: 'calendar_booking', label: 'Calendar Booking' },
  { id: 'http_request', label: 'Outbound HTTP Execution' },
  { id: 'payment_verification', label: 'Payment Verification' },
];

export const N8nConfigModal: React.FC<N8nConfigModalProps> = ({
  isOpen,
  workspaceId,
  existingIntegration,
  workflows,
  onClose,
  onUpdated,
}) => {
  const [setupMode, setSetupMode] = useState<
    'existing_instance' | 'manual_webhook'
  >('manual_webhook');
  const [displayName, setDisplayName] = useState('n8n Automation Instance');
  const [n8nBaseUrl, setN8nBaseUrl] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [workflowId, setWorkflowId] = useState('support-triage-wf');
  const [authType, setAuthType] = useState<IntegrationAuthType>('hmac_sha256');
  const [secret, setSecret] = useState('');
  const [selectedCaps, setSelectedCaps] = useState<CapabilityId[]>([
    'workflow_automation',
    'message_dispatch',
  ]);

  // Explicit workflow registration form
  const [wfName, setWfName] = useState('');
  const [wfExtId, setWfExtId] = useState('');
  const [wfWebhookPath, setWfWebhookPath] = useState('');
  const [wfMethod, setWfMethod] = useState<CustomApiHttpMethod>('POST');
  const [wfCap, setWfCap] = useState<CapabilityId>('workflow_automation');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setMessage(null);
    if (existingIntegration) {
      setDisplayName(existingIntegration.displayName);
      const mode =
        existingIntegration.configMetadata.n8nSetupMode === 'existing_instance'
          ? 'existing_instance'
          : 'manual_webhook';
      setSetupMode(mode);
      setN8nBaseUrl(existingIntegration.configMetadata.n8nBaseUrl || '');
      setEndpointUrl(existingIntegration.configMetadata.endpointUrl || '');
      setWorkflowId(
        existingIntegration.configMetadata.workflowId || 'support-triage-wf'
      );
      setAuthType(existingIntegration.configMetadata.authType || 'hmac_sha256');
      setSelectedCaps(
        existingIntegration.capabilities.length > 0
          ? existingIntegration.capabilities
          : ['workflow_automation']
      );
    } else {
      setDisplayName('n8n Automation Instance');
      setSetupMode('manual_webhook');
      setN8nBaseUrl('');
      setEndpointUrl('');
      setWorkflowId('support-triage-wf');
      setAuthType('hmac_sha256');
      setSecret('');
      setSelectedCaps(['workflow_automation', 'message_dispatch']);
    }
  }, [isOpen, existingIntegration]);

  if (!isOpen) return null;

  const toggleCapability = (cap: CapabilityId) => {
    setSelectedCaps((prev) =>
      prev.includes(cap)
        ? prev.length > 1
          ? prev.filter((c) => c !== cap)
          : prev
        : [...prev, cap]
    );
  };

  const boundWorkflows = existingIntegration
    ? workflows.filter((w) => w.integrationId === existingIntegration.id)
    : [];

  const handleSaveConnector = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.configureN8nIntegration({
        workspaceId,
        setupMode,
        displayName: displayName.trim(),
        n8nBaseUrl:
          setupMode === 'existing_instance' ? n8nBaseUrl.trim() : undefined,
        endpointUrl:
          setupMode === 'manual_webhook' ? endpointUrl.trim() : undefined,
        workflowId:
          setupMode === 'manual_webhook' ? workflowId.trim() : undefined,
        authType,
        secret: secret.trim() || undefined,
        capabilities: selectedCaps,
      });
      setSecret('');
      setMessage(
        setupMode === 'existing_instance'
          ? 'n8n instance saved (untested). Discover or register explicit workflows below, then run Test Connection.'
          : 'n8n signed webhook saved and workflow registered (untested). Run Test Connection in Integration Center to verify.'
      );
      await onUpdated();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to save n8n configuration.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDiscoverWorkflows = async () => {
    if (!existingIntegration) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.discoverN8nWorkflows(existingIntegration.id);
      setMessage(
        `Discovered ${res.discoveredCount} webhook-triggered workflow(s) via /api/v1/workflows (${res.skippedWithoutWebhookNode} non-webhook workflow(s) skipped).`
      );
      await onUpdated();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Workflow discovery failed.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRegisterWorkflow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!existingIntegration || !wfName.trim() || !wfWebhookPath.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.registerN8nWorkflow(existingIntegration.id, {
        name: wfName.trim(),
        workflowExternalId: wfExtId.trim() || undefined,
        webhookUrlOrPath: wfWebhookPath.trim(),
        httpMethod: wfMethod,
        capabilities: [wfCap],
      });
      setWfName('');
      setWfExtId('');
      setWfWebhookPath('');
      setMessage('Explicit n8n workflow registered for capability routing.');
      await onUpdated();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to register workflow.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteWorkflow = async (wfId: string) => {
    if (!existingIntegration) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteN8nWorkflow(existingIntegration.id, wfId);
      await onUpdated();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete workflow.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="n8n-config-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2
              id="n8n-config-modal-title"
              className="text-base font-semibold tracking-tight"
            >
              Configure n8n Automation Connector
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Each workspace maintains independent n8n credentials, HMAC signing
              secrets, and explicitly registered workflows. Task.ai never
              assumes one webhook exposes all workflows.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close n8n configuration modal"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-900 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Setup Path Switcher */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-900">
          <button
            type="button"
            onClick={() => setSetupMode('existing_instance')}
            className={`flex-1 min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
              setupMode === 'existing_instance'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Connect Existing n8n Instance
          </button>
          <button
            type="button"
            onClick={() => setSetupMode('manual_webhook')}
            className={`flex-1 min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
              setupMode === 'manual_webhook'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Configure Webhook Manually
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-800 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {message && (
          <div className="p-3 rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-800 dark:text-emerald-300">
            {message}
          </div>
        )}

        <form onSubmit={handleSaveConnector} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="n8n-display-name"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Connector Label
              </label>
              <input
                id="n8n-display-name"
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Production n8n Cloud"
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>

            {setupMode === 'existing_instance' ? (
              <div className="space-y-1.5">
                <label
                  htmlFor="n8n-base-url"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  n8n Instance HTTPS Base URL
                </label>
                <input
                  id="n8n-base-url"
                  type="url"
                  required
                  value={n8nBaseUrl}
                  onChange={(e) => setN8nBaseUrl(e.target.value)}
                  placeholder="https://n8n.yourcompany.com"
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <label
                  htmlFor="n8n-webhook-id"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Explicit Workflow Identifier
                </label>
                <input
                  id="n8n-webhook-id"
                  type="text"
                  required
                  value={workflowId}
                  onChange={(e) => setWorkflowId(e.target.value)}
                  placeholder="wf-customer-support-triage"
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
                />
              </div>
            )}
          </div>

          {setupMode === 'manual_webhook' && (
            <div className="space-y-1.5">
              <label
                htmlFor="n8n-manual-webhook-url"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                n8n Production Webhook HTTPS URL
              </label>
              <input
                id="n8n-manual-webhook-url"
                type="url"
                required
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                placeholder="https://n8n.yourcompany.com/webhook/support-intake"
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {setupMode === 'manual_webhook' && (
              <div className="space-y-1.5">
                <label
                  htmlFor="n8n-auth-type"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Webhook Signing / Auth Method
                </label>
                <select
                  id="n8n-auth-type"
                  value={authType}
                  onChange={(e) =>
                    setAuthType(e.target.value as IntegrationAuthType)
                  }
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  <option value="hmac_sha256">
                    HMAC-SHA256 Signature (X-TaskAI-Signature)
                  </option>
                  <option value="bearer_token">Bearer Token</option>
                  <option value="header_secret">Custom Header Secret</option>
                  <option value="none">None (Public Webhook)</option>
                </select>
              </div>
            )}

            <div
              className={
                setupMode === 'existing_instance'
                  ? 'sm:col-span-2 space-y-1.5'
                  : 'space-y-1.5'
              }
            >
              <label
                htmlFor="n8n-secret-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                {setupMode === 'existing_instance'
                  ? 'n8n REST API Key (X-N8N-API-KEY — Encrypted Server-Side)'
                  : 'Webhook Signing Secret / Token (Encrypted Server-Side)'}
              </label>
              <input
                id="n8n-secret-input"
                type="password"
                required={setupMode === 'existing_instance' && !existingIntegration}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={
                  setupMode === 'existing_instance'
                    ? 'n8n_api_...'
                    : 'Enter shared HMAC signing secret'
                }
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Exposed Capabilities for AI Planner Routing
            </span>
            <div className="flex flex-wrap gap-2">
              {CAPABILITY_OPTIONS.map((cap) => {
                const active = selectedCaps.includes(cap.id);
                return (
                  <button
                    key={cap.id}
                    type="button"
                    onClick={() => toggleCapability(cap.id)}
                    className={`min-h-[34px] px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                      active
                        ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                        : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900'
                    }`}
                  >
                    {cap.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] px-4 py-2 text-xs font-medium rounded-xl border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={busy}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white text-white dark:text-slate-950 transition-colors cursor-pointer disabled:opacity-50"
            >
              {busy ? 'Saving...' : 'Save n8n Configuration'}
            </button>
          </div>
        </form>

        {/* Registered Workflows Registry & Discovery */}
        {existingIntegration && (
          <div className="pt-5 border-t border-slate-200 dark:border-slate-800 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">
                  Explicitly Registered Workflows ({boundWorkflows.length})
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Only registered workflows are exposed to the Task Orchestrator
                  and AI Planner.
                </p>
              </div>
              {existingIntegration.configMetadata.n8nSetupMode ===
                'existing_instance' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleDiscoverWorkflows()}
                  className="min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Discover via /api/v1/workflows</span>
                </button>
              )}
            </div>

            {boundWorkflows.length > 0 && (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 border-y border-slate-200 dark:border-slate-800">
                {boundWorkflows.map((wf) => (
                  <div
                    key={wf.id}
                    className="py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {wf.name}
                      </p>
                      <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                        {wf.httpMethod} · {wf.webhookUrlOrPath} ·{' '}
                        {wf.capabilities.join(', ')}
                        {wf.lastStatus ? ` · Last: ${wf.lastStatus}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteWorkflow(wf.id)}
                      aria-label={`Remove workflow ${wf.name}`}
                      className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form
              onSubmit={handleRegisterWorkflow}
              className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end"
            >
              <div className="sm:col-span-4 space-y-1">
                <label
                  htmlFor="n8n-wf-name"
                  className="block text-[11px] font-medium text-slate-600 dark:text-slate-400"
                >
                  Workflow Name
                </label>
                <input
                  id="n8n-wf-name"
                  type="text"
                  required
                  value={wfName}
                  onChange={(e) => setWfName(e.target.value)}
                  placeholder="Lead Enrichment Flow"
                  className="w-full px-2.5 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>
              <div className="sm:col-span-5 space-y-1">
                <label
                  htmlFor="n8n-wf-path"
                  className="block text-[11px] font-medium text-slate-600 dark:text-slate-400"
                >
                  Webhook URL or Path
                </label>
                <input
                  id="n8n-wf-path"
                  type="text"
                  required
                  value={wfWebhookPath}
                  onChange={(e) => setWfWebhookPath(e.target.value)}
                  placeholder="/webhook/lead-enrich or https://..."
                  className="w-full px-2.5 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
                />
              </div>
              <div className="sm:col-span-3">
                <button
                  type="submit"
                  disabled={busy || !wfName.trim() || !wfWebhookPath.trim()}
                  className="w-full min-h-[36px] px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Workflow</span>
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
