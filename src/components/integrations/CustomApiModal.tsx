import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../lib/api';
import type {
  CapabilityId,
  CustomApiHttpMethod,
  IntegrationAuthType,
} from '../../types';

interface CustomApiModalProps {
  isOpen: boolean;
  workspaceId: string | undefined;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

const CAPABILITY_OPTIONS: ReadonlyArray<{ id: CapabilityId; label: string }> = [
  { id: 'custom_api_execution', label: 'Custom API Execution' },
  { id: 'http_request', label: 'HTTP Request' },
  { id: 'crm_sync', label: 'CRM Lead / Ticket Sync' },
  { id: 'message_dispatch', label: 'Message Dispatch' },
  { id: 'payment_verification', label: 'Payment Verification' },
  { id: 'prospect_search', label: 'Prospect Search' },
];

export const CustomApiModal: React.FC<CustomApiModalProps> = ({
  isOpen,
  workspaceId,
  onClose,
  onCreated,
}) => {
  const [displayName, setDisplayName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [endpointPath, setEndpointPath] = useState('/v1/resources');
  const [httpMethod, setHttpMethod] = useState<CustomApiHttpMethod>('POST');
  const [authType, setAuthType] = useState<IntegrationAuthType>('bearer_token');
  const [apiKeyHeaderName, setApiKeyHeaderName] = useState('X-API-Key');
  const [basicAuthUsername, setBasicAuthUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [headersJson, setHeadersJson] = useState('{"Accept": "application/json"}');
  const [paramsJson, setParamsJson] = useState('{}');
  const [bodySchemaJson, setBodySchemaJson] = useState(
    '{\n  "type": "object",\n  "required": []\n}'
  );
  const [timeoutMs, setTimeoutMs] = useState(10000);
  const [allowedOpsText, setAllowedOpsText] = useState('read, create, sync');
  const [selectedCaps, setSelectedCaps] = useState<CapabilityId[]>([
    'custom_api_execution',
    'http_request',
  ]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
  }, [isOpen]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    let parsedHeaders: Record<string, string> = {};
    let parsedParams: Record<string, string> = {};
    let parsedBodySchema: Record<string, unknown> = {};

    try {
      const h = JSON.parse(headersJson || '{}');
      if (!h || typeof h !== 'object' || Array.isArray(h)) {
        throw new Error('Request headers must be a JSON object.');
      }
      parsedHeaders = Object.fromEntries(
        Object.entries(h).map(([k, v]) => [k, String(v)])
      );
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Invalid JSON in Request Headers.'
      );
      return;
    }

    try {
      const p = JSON.parse(paramsJson || '{}');
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        throw new Error('Request parameters must be a JSON object.');
      }
      parsedParams = Object.fromEntries(
        Object.entries(p).map(([k, v]) => [k, String(v)])
      );
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Invalid JSON in Request Parameters.'
      );
      return;
    }

    try {
      const s = JSON.parse(bodySchemaJson || '{}');
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        throw new Error('Request body schema must be a JSON object.');
      }
      parsedBodySchema = s as Record<string, unknown>;
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Invalid JSON in Request Body Schema.'
      );
      return;
    }

    const allowedOperations = allowedOpsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    setBusy(true);
    try {
      await api.createCustomApiIntegration({
        workspaceId,
        displayName: displayName.trim(),
        authType,
        secret: secret.trim() || undefined,
        capabilities: selectedCaps,
        customApi: {
          baseUrl: baseUrl.trim(),
          endpointPath: endpointPath.trim() || '/',
          httpMethod,
          requestHeaders: parsedHeaders,
          requestParams: parsedParams,
          requestBodySchema: parsedBodySchema,
          timeoutMs: Number(timeoutMs) || 10000,
          allowedOperations:
            allowedOperations.length > 0 ? allowedOperations : ['execute'],
          apiKeyHeaderName:
            authType === 'api_key' ? apiKeyHeaderName.trim() : undefined,
          basicAuthUsername:
            authType === 'basic_auth' ? basicAuthUsername.trim() : undefined,
        },
      });
      await onCreated();
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to validate and save Custom API connector.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-api-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2
              id="custom-api-modal-title"
              className="text-base font-semibold tracking-tight"
            >
              Register Custom REST API Connector
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Validated against SSRF rules (HTTPS required; private/loopback IPs
              blocked), encrypted with AES-256-GCM, and schema-checked before
              execution.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Custom API modal"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-900 cursor-pointer"
          >
            <X className="w-4 h-4" />
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

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="custom-api-name"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Integration Name
              </label>
              <input
                id="custom-api-name"
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g., Internal Billing & CRM API"
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="custom-api-base-url"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                API HTTPS Base URL
              </label>
              <input
                id="custom-api-base-url"
                type="text"
                required
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.yourcompany.com"
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div className="sm:col-span-3 space-y-1.5">
              <label
                htmlFor="custom-api-method"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                HTTP Method
              </label>
              <select
                id="custom-api-method"
                value={httpMethod}
                onChange={(e) =>
                  setHttpMethod(e.target.value as CustomApiHttpMethod)
                }
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>

            <div className="sm:col-span-6 space-y-1.5">
              <label
                htmlFor="custom-api-endpoint"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Endpoint Path
              </label>
              <input
                id="custom-api-endpoint"
                type="text"
                required
                value={endpointPath}
                onChange={(e) => setEndpointPath(e.target.value)}
                placeholder="/v1/tickets"
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>

            <div className="sm:col-span-3 space-y-1.5">
              <label
                htmlFor="custom-api-timeout"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Timeout (ms)
              </label>
              <input
                id="custom-api-timeout"
                type="number"
                min={1000}
                max={30000}
                step={500}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono tabular-nums"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="custom-api-auth-type"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Authentication Method
              </label>
              <select
                id="custom-api-auth-type"
                value={authType}
                onChange={(e) =>
                  setAuthType(e.target.value as IntegrationAuthType)
                }
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="bearer_token">Bearer Token</option>
                <option value="api_key">API Key Header</option>
                <option value="oauth2">OAuth 2.0 Access Token</option>
                <option value="basic_auth">HTTP Basic Auth</option>
                <option value="none">No Authentication</option>
              </select>
            </div>

            {authType !== 'none' && (
              <div className="space-y-1.5">
                <label
                  htmlFor="custom-api-secret"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  {authType === 'basic_auth'
                    ? 'Basic Auth Password / Token (Encrypted)'
                    : 'Credential / Token (Encrypted Server-Side)'}
                </label>
                <input
                  id="custom-api-secret"
                  type="password"
                  required
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="Enter secret token"
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
                />
              </div>
            )}
          </div>

          {authType === 'api_key' && (
            <div className="space-y-1.5">
              <label
                htmlFor="custom-api-key-header"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                API Key Header Name
              </label>
              <input
                id="custom-api-key-header"
                type="text"
                required
                value={apiKeyHeaderName}
                onChange={(e) => setApiKeyHeaderName(e.target.value)}
                placeholder="X-API-Key"
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
          )}

          {authType === 'basic_auth' && (
            <div className="space-y-1.5">
              <label
                htmlFor="custom-api-basic-user"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Basic Auth Username
              </label>
              <input
                id="custom-api-basic-user"
                type="text"
                required
                value={basicAuthUsername}
                onChange={(e) => setBasicAuthUsername(e.target.value)}
                placeholder="api-service-user"
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="custom-api-headers"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Static Request Headers (JSON)
              </label>
              <textarea
                id="custom-api-headers"
                rows={2}
                value={headersJson}
                onChange={(e) => setHeadersJson(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="custom-api-params"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Default Query Parameters (JSON)
              </label>
              <textarea
                id="custom-api-params"
                rows={2}
                value={paramsJson}
                onChange={(e) => setParamsJson(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="custom-api-body-schema"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Request Body Schema (JSON)
              </label>
              <textarea
                id="custom-api-body-schema"
                rows={3}
                value={bodySchemaJson}
                onChange={(e) => setBodySchemaJson(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="custom-api-allowed-ops"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Allowed Operations (comma-separated)
              </label>
              <input
                id="custom-api-allowed-ops"
                type="text"
                value={allowedOpsText}
                onChange={(e) => setAllowedOpsText(e.target.value)}
                placeholder="list_tickets, create_ticket, update_status"
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 pt-1">
                Exposed as structured metadata in the Centralized Integration
                Registry without exposing credentials.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Registered Capabilities
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
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !displayName.trim() || !baseUrl.trim()}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white text-white dark:text-slate-950 transition-colors cursor-pointer disabled:opacity-50"
            >
              {busy ? 'Validating & Saving...' : 'Register Custom API'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
