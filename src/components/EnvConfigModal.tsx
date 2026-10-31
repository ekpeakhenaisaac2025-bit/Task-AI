import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import type {
  EnvironmentDiagnosticsResponse,
  EnvironmentVariableDiagnostic,
} from '../types';

interface EnvConfigModalProps {
  isOpen: boolean;
  workspaceName: string;
  diagnostics: EnvironmentDiagnosticsResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onRotateKeys: () => Promise<{
    rotatedCount: number;
    alreadyCurrentCount: number;
    noSecretCount: number;
  }>;
}

export const EnvConfigModal: React.FC<EnvConfigModalProps> = ({
  isOpen,
  workspaceName,
  diagnostics,
  loading,
  error,
  onClose,
  onRefresh,
  onRotateKeys,
}) => {
  const [copiedVar, setCopiedVar] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotationNotice, setRotationNotice] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setRotationNotice(null);
      setCopiedVar(null);
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCopyCommand = async (varName: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedVar(varName);
      window.setTimeout(() => {
        setCopiedVar((prev) => (prev === varName ? null : prev));
      }, 2000);
    } catch {
      // Clipboard API unavailable in restricted iframe contexts; no-op gracefully
    }
  };

  const handleRotate = async () => {
    setRotating(true);
    setRotationNotice(null);
    try {
      const res = await onRotateKeys();
      setRotationNotice({
        tone: 'success',
        text: `Key rotation check completed for ${workspaceName}: ${res.rotatedCount} credential(s) re-encrypted under active key, ${res.alreadyCurrentCount} already current, ${res.noSecretCount} without stored secret.`,
      });
      await onRefresh();
    } catch (err: unknown) {
      setRotationNotice({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to rotate stored workspace credentials.',
      });
    } finally {
      setRotating(false);
    }
  };

  const renderStateIndicator = (item: EnvironmentVariableDiagnostic) => {
    if (item.state === 'configured_valid') {
      return (
        <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>Configured & Valid</span>
        </span>
      );
    }
    if (item.state === 'optional_blank') {
      return (
        <span className="inline-flex items-center gap-1 text-slate-600 font-medium">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-slate-400" />
          <span>Optional · Blank</span>
        </span>
      );
    }
    if (item.state === 'dev_persisted_key') {
      return (
        <span className="inline-flex items-center gap-1 text-amber-800 font-semibold">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Dev Keyfile Active · Set Before Production</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        <span>Action Required</span>
      </span>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="env-config-modal-title"
        className="bg-white border border-slate-200 rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4 shrink-0">
          <div className="space-y-1">
            <h2
              id="env-config-modal-title"
              className="text-lg font-bold text-slate-900"
            >
              Server Environment Configuration
            </h2>
            <p className="text-xs text-slate-600 max-w-2xl leading-relaxed">
              Read-only validation status for server-side cryptographic and
              integration environment variables. Actual secret values are never
              transmitted to the browser, logs, or API responses. Configure
              values in your deployment Secrets / Environment Variables panel.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onRefresh()}
              disabled={loading}
              aria-label="Refresh environment diagnostics"
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
              />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close environment configuration dialog"
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-200">
          {/* Runtime Summary Strip */}
          {diagnostics && (
            <div className="px-6 py-3.5 bg-slate-50 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  Runtime mode:{' '}
                  <strong className="font-mono text-slate-900">
                    {diagnostics.runtimeMode}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Operates without n8n:{' '}
                  <strong className="text-emerald-700">Yes</strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Platform-shared n8n:{' '}
                  <strong className="text-slate-900">
                    {diagnostics.sharedN8nEnabled
                      ? 'Enabled'
                      : 'Disabled (Optional)'}
                  </strong>
                </span>
              </div>

              <button
                type="button"
                onClick={handleRotate}
                disabled={rotating || loading}
                className="px-3 py-1.5 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>
                  {rotating
                    ? 'Rotating Keys...'
                    : 'Rotate Stored Workspace Keys'}
                </span>
              </button>
            </div>
          )}

          {rotationNotice && (
            <div
              role="status"
              className={`px-6 py-3 text-xs ${
                rotationNotice.tone === 'success'
                  ? 'bg-emerald-50 text-emerald-900'
                  : 'bg-red-50 text-red-900'
              }`}
            >
              {rotationNotice.text}
            </div>
          )}

          {error && (
            <div role="alert" className="px-6 py-4 bg-red-50 text-xs text-red-900">
              {error}
            </div>
          )}

          {loading && !diagnostics && (
            <div className="px-6 py-10 text-center text-sm text-slate-500">
              Checking server environment configuration...
            </div>
          )}

          {/* Variable Specifications List */}
          {diagnostics &&
            diagnostics.variables.map((item) => (
              <div key={item.name} className="px-6 py-5 space-y-3">
                {/* Variable Header Metadata Line (Zero-Pill Clean Separators) */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <code className="font-mono text-sm font-bold text-slate-900">
                      {item.name}
                    </code>
                    <span aria-hidden="true" className="text-slate-400">
                      ·
                    </span>
                    <span
                      className={
                        item.requirement === 'required_in_production'
                          ? 'font-semibold text-slate-900'
                          : 'text-slate-600 font-medium'
                      }
                    >
                      {item.requirementLabel}
                    </span>
                    <span aria-hidden="true" className="text-slate-400">
                      ·
                    </span>
                    {renderStateIndicator(item)}
                  </div>

                  <span className="text-xs text-slate-500">
                    Safe to leave blank:{' '}
                    <strong
                      className={
                        item.safeToLeaveBlank
                          ? 'text-emerald-700'
                          : 'text-slate-900'
                      }
                    >
                      {item.safeToLeaveBlank ? 'Yes' : 'No (in production)'}
                    </strong>
                  </span>
                </div>

                {/* Current Validation Summary */}
                <p className="text-xs text-slate-700 leading-relaxed">
                  {item.statusSummary}
                </p>

                {/* Structured Specification Rows */}
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 pt-2 text-xs">
                  <div>
                    <dt className="font-semibold text-slate-900">
                      Expected format
                    </dt>
                    <dd className="text-slate-600 mt-0.5 leading-relaxed">
                      {item.expectedFormat}
                    </dd>
                  </div>

                  <div>
                    <dt className="font-semibold text-slate-900">
                      Dependent features
                    </dt>
                    <dd className="text-slate-600 mt-0.5 leading-relaxed">
                      {item.dependentFeatures}
                    </dd>
                  </div>

                  <div>
                    <dt className="font-semibold text-slate-900">
                      Blank-value policy
                    </dt>
                    <dd className="text-slate-600 mt-0.5 leading-relaxed">
                      {item.safeToLeaveBlankDetail}
                    </dd>
                  </div>

                  <div>
                    <dt className="font-semibold text-slate-900">
                      How to generate locally
                    </dt>
                    <dd className="text-slate-600 mt-0.5 leading-relaxed">
                      {item.generateCommand ? (
                        <div className="inline-flex items-center gap-2 mt-0.5">
                          <code className="font-mono text-xs bg-slate-100 text-slate-900 px-2 py-1 rounded">
                            {item.generateCommand}
                          </code>
                          <button
                            type="button"
                            onClick={() =>
                              handleCopyCommand(
                                item.name,
                                item.generateCommand!
                              )
                            }
                            aria-label={`Copy generation command for ${item.name}`}
                            className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
                          >
                            {copiedVar === item.name ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-700" />
                                <span className="text-emerald-700">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                      ) : (
                        <span>
                          Not a generated random secret — leave blank unless
                          needed.
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}

          {/* Safe Key Rotation Guide */}
          <div className="px-6 py-4 bg-slate-50 text-xs text-slate-600 space-y-1 leading-relaxed">
            <p className="font-semibold text-slate-900">
              Zero-Downtime Encryption Key Rotation Procedure
            </p>
            <p>
              To rotate{' '}
              <code className="font-mono text-slate-800">
                INTEGRATION_ENCRYPTION_KEY
              </code>{' '}
              without invalidating existing credentials: (1) copy the retiring
              64-character hex key into{' '}
              <code className="font-mono text-slate-800">
                INTEGRATION_ENCRYPTION_KEY_PREVIOUS
              </code>
              , (2) set a newly generated 64-character hex value in{' '}
              <code className="font-mono text-slate-800">
                INTEGRATION_ENCRYPTION_KEY
              </code>
              , (3) restart and click{' '}
              <strong className="text-slate-900">
                Rotate Stored Workspace Keys
              </strong>{' '}
              above, then (4) clear{' '}
              <code className="font-mono text-slate-800">
                INTEGRATION_ENCRYPTION_KEY_PREVIOUS
              </code>
              .
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-white flex items-center justify-between gap-4 shrink-0">
          <span className="text-xs text-slate-500">
            Secrets are validated server-side on startup and never echoed in
            errors or logs.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
