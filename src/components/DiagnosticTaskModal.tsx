import React, { useState, useEffect } from 'react';
import { X, AlertCircle } from 'lucide-react';
import type {
  CapabilityId,
  TaskActionCategory,
  TaskRecord,
  ToolId,
} from '../types';

interface DiagnosticTaskModalProps {
  isOpen: boolean;
  existingTasks: TaskRecord[];
  onClose: () => void;
  onCreateTask: (payload: {
    description: string;
    tool: ToolId;
    requiredCapabilities: CapabilityId[];
    actionCategory: TaskActionCategory;
    dependencies: string[];
    approvalRequired: boolean;
    proposedAction?: string;
    targetRecipient?: string;
    estimatedCost?: string;
    explanation?: string;
    expectedResult: string;
    verificationMethod: string;
  }) => Promise<void>;
}

const CAPABILITY_OPTIONS: Array<{ id: CapabilityId; label: string }> = [
  { id: 'diagnostic_verification', label: 'diagnostic_verification' },
  { id: 'ai_reasoning', label: 'ai_reasoning' },
  { id: 'content_drafting', label: 'content_drafting' },
  { id: 'prospect_qualification', label: 'prospect_qualification' },
  { id: 'workflow_automation', label: 'workflow_automation' },
  { id: 'message_dispatch', label: 'message_dispatch' },
  { id: 'crm_sync', label: 'crm_sync' },
  { id: 'prospect_search', label: 'prospect_search' },
  { id: 'calendar_booking', label: 'calendar_booking' },
  { id: 'payment_verification', label: 'payment_verification' },
  { id: 'http_request', label: 'http_request' },
];

export const DiagnosticTaskModal: React.FC<DiagnosticTaskModalProps> = ({
  isOpen,
  existingTasks,
  onClose,
  onCreateTask,
}) => {
  const [description, setDescription] = useState('');
  const [tool, setTool] = useState<ToolId>('internal_test_tool');
  const [capabilities, setCapabilities] = useState<CapabilityId[]>([
    'diagnostic_verification',
  ]);
  const [actionCategory, setActionCategory] =
    useState<TaskActionCategory>('internal_test');
  const [selectedDepId, setSelectedDepId] = useState<string>('');
  const [extraDepIds, setExtraDepIds] = useState<string[]>([]);
  const [approvalRequired, setApprovalRequired] = useState(true);
  const [targetRecipient, setTargetRecipient] = useState(
    'Internal Verification Sandbox'
  );
  const [estimatedCost, setEstimatedCost] = useState('$0.00');
  const [expectedResult, setExpectedResult] = useState(
    'Deterministic SHA-256 verification digest recorded in action log.'
  );
  const [verificationMethod, setVerificationMethod] = useState(
    'Independent server-side SHA-256 checksum comparison.'
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setDescription(
        'Run harmless internal pipeline & payload verification test'
      );
      setTool('internal_test_tool');
      setCapabilities(['diagnostic_verification']);
      setActionCategory('internal_test');
      setSelectedDepId('');
      setExtraDepIds([]);
      setApprovalRequired(true);
      setTargetRecipient('Internal Verification Sandbox');
      setEstimatedCost('$0.00');
      setExpectedResult(
        'Deterministic SHA-256 verification digest recorded in action log.'
      );
      setVerificationMethod(
        'Independent server-side SHA-256 checksum comparison.'
      );
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isExternalTool =
    tool !== 'internal_test_tool' &&
    tool !== 'llm_reasoning' &&
    tool !== 'unsupported';

  const toggleCapability = (cap: CapabilityId) => {
    setCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]
    );
  };

  const applyPreset = (
    preset:
      | 'harmless_approved'
      | 'unmet_dependency'
      | 'simulated_failure'
      | 'custom_webhook'
      | 'external_n8n'
  ) => {
    setError(null);
    if (preset === 'harmless_approved') {
      setDescription(
        'Run harmless internal pipeline & payload verification test'
      );
      setTool('internal_test_tool');
      setCapabilities(['diagnostic_verification']);
      setActionCategory('internal_test');
      setSelectedDepId('');
      setApprovalRequired(true);
      setTargetRecipient('Internal Verification Sandbox');
      setEstimatedCost('$0.00');
      setExpectedResult(
        'Deterministic SHA-256 verification digest recorded in action log.'
      );
      setVerificationMethod(
        'Independent server-side SHA-256 checksum comparison.'
      );
    } else if (preset === 'unmet_dependency') {
      const unfinished =
        existingTasks.find(
          (t) => t.status !== 'completed' && t.status !== 'verified'
        ) ?? existingTasks[0];
      setDescription(
        'Validate prerequisite artifact completion before downstream dispatch'
      );
      setTool('internal_test_tool');
      setCapabilities(['diagnostic_verification']);
      setActionCategory('internal_test');
      setSelectedDepId(unfinished ? unfinished.id : '');
      setApprovalRequired(false);
      setExpectedResult('Prerequisite validation check');
      setVerificationMethod('Verify prerequisite step completion');
    } else if (preset === 'simulated_failure') {
      setDescription(
        'Execute fault-injection check [SIMULATE_FAILURE] to verify retry & recovery'
      );
      setTool('internal_test_tool');
      setCapabilities(['diagnostic_verification']);
      setActionCategory('internal_test');
      setSelectedDepId('');
      setApprovalRequired(false);
      setExpectedResult('Controlled error captured cleanly with backoff retry');
      setVerificationMethod('Verify attempt history and exponential backoff');
    } else if (preset === 'custom_webhook') {
      setDescription(
        'Dispatch approved payload through workspace Custom HTTPS Webhook'
      );
      setTool('custom_webhook');
      setCapabilities(['workflow_automation', 'http_request']);
      setActionCategory('external_workflow');
      setSelectedDepId('');
      setApprovalRequired(true);
      setTargetRecipient('Workspace HTTPS Webhook Endpoint');
      setEstimatedCost('$0.00 platform fee');
      setExpectedResult('Pending verification until signed outcome webhook');
      setVerificationMethod('Signed inbound webhook outcome receipt');
    } else if (preset === 'external_n8n') {
      setDescription(
        'Send outreach campaign payload via workspace n8n workflow'
      );
      setTool('n8n_webhook');
      setCapabilities(['workflow_automation', 'message_dispatch']);
      setActionCategory('message_send');
      setSelectedDepId('');
      setApprovalRequired(true);
      setTargetRecipient('External prospects via workspace workflow');
      setEstimatedCost('$0.00 platform fee (provider message rates apply)');
      setExpectedResult('Pending verification until delivery receipt');
      setVerificationMethod('Verify provider delivery receipt callback');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!description.trim()) {
      setError('Task description is required.');
      return;
    }

    setSubmitting(true);
    try {
      const mergedDeps = Array.from(
        new Set([
          ...(selectedDepId ? [selectedDepId] : []),
          ...extraDepIds,
        ])
      );
      await onCreateTask({
        description: description.trim(),
        tool,
        requiredCapabilities:
          capabilities.length > 0 ? capabilities : ['workflow_automation'],
        actionCategory,
        dependencies: mergedDeps,
        approvalRequired: approvalRequired || isExternalTool,
        proposedAction: description.trim(),
        targetRecipient: targetRecipient.trim(),
        estimatedCost: estimatedCost.trim(),
        explanation: isExternalTool
          ? 'Dispatches task payload to an external execution provider configured in your workspace.'
          : 'Requires explicit human approval before worker execution.',
        expectedResult: expectedResult.trim(),
        verificationMethod: verificationMethod.trim(),
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-task-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/55"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-xl w-full p-6 space-y-4 shadow-xl max-h-[90vh] overflow-y-auto text-slate-900 dark:text-slate-100 [&_input]:dark:bg-slate-950 [&_input]:dark:border-slate-700 [&_input]:dark:text-slate-100 [&_select]:dark:bg-slate-950 [&_select]:dark:border-slate-700 [&_select]:dark:text-slate-100 [&_label]:dark:text-slate-200 [&_legend]:dark:text-slate-300">
        <div className="flex items-center justify-between gap-4">
          <h2
            id="add-task-modal-title"
            className="text-lg font-semibold text-slate-900 dark:text-white"
          >
            Add Queued Task
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close add task dialog"
            className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-slate-500">
            Quick Task Templates
          </span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => applyPreset('harmless_approved')}
              className="px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Harmless Test (Approval Gate)
            </button>
            <button
              type="button"
              onClick={() => applyPreset('simulated_failure')}
              className="px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Fault-Injection Failure Test
            </button>
            {existingTasks.length > 0 && (
              <button
                type="button"
                onClick={() => applyPreset('unmet_dependency')}
                className="px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Dependent Task
              </button>
            )}
            <button
              type="button"
              onClick={() => applyPreset('custom_webhook')}
              className="px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Custom HTTPS Webhook Task
            </button>
            <button
              type="button"
              onClick={() => applyPreset('external_n8n')}
              className="px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Optional n8n Task
            </button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 flex items-start gap-2"
          >
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
          <div className="space-y-1">
            <label
              htmlFor="task-desc-input"
              className="block text-sm font-medium text-slate-800"
            >
              Task Description
            </label>
            <input
              id="task-desc-input"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label
                htmlFor="task-tool-select"
                className="block text-sm font-medium text-slate-800"
              >
                Proposed Execution Provider
              </label>
              <select
                id="task-tool-select"
                value={tool}
                onChange={(e) => setTool(e.target.value as ToolId)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value="internal_test_tool">
                  internal_test_tool (Built-in Diagnostic)
                </option>
                <option value="llm_reasoning">
                  llm_reasoning (Built-in LLM Reasoning)
                </option>
                <option value="custom_webhook">
                  custom_webhook (Workspace HTTPS Webhook)
                </option>
                <option value="n8n_webhook">
                  n8n_webhook (Optional Workspace n8n)
                </option>
                <option value="make_webhook">
                  make_webhook (Make.com Scenario)
                </option>
                <option value="zapier_webhook">
                  zapier_webhook (Zapier Catch Hook)
                </option>
                <option value="crm_webhook">crm_webhook (CRM Adapter)</option>
                <option value="gmail_api">gmail_api (Email Relay)</option>
                <option value="google_calendar_api">
                  google_calendar_api (Calendar Booking)
                </option>
                <option value="payment_webhook">
                  payment_webhook (Payment Gateway)
                </option>
                <option value="unsupported">
                  unsupported (Unconfigured Capability)
                </option>
              </select>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="task-dep-select"
                className="block text-sm font-medium text-slate-800"
              >
                Prerequisite Task (Optional)
              </label>
              <select
                id="task-dep-select"
                value={selectedDepId}
                onChange={(e) => setSelectedDepId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value="">None (No prerequisite)</option>
                {existingTasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    Step {t.stepOrder}: {t.description.slice(0, 42)} ({t.status}
                    )
                  </option>
                ))}
              </select>
            </div>
          </div>

          {existingTasks.length > 1 && (
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium text-slate-700">
                Additional Prerequisites (Join Multiple Upstream Tasks)
              </legend>
              <div className="flex flex-wrap gap-3 pt-0.5">
                {existingTasks
                  .filter((t) => t.id !== selectedDepId)
                  .map((t) => (
                    <label
                      key={t.id}
                      className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={extraDepIds.includes(t.id)}
                        onChange={() =>
                          setExtraDepIds((prev) =>
                            prev.includes(t.id)
                              ? prev.filter((id) => id !== t.id)
                              : [...prev, t.id]
                          )
                        }
                        className="w-3.5 h-3.5 rounded border-slate-300 text-slate-900"
                      />
                      <span>
                        Step {t.stepOrder}: {t.description.slice(0, 28)}
                      </span>
                    </label>
                  ))}
              </div>
            </fieldset>
          )}

          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-slate-700">
              Required Capabilities (used by Execution Router)
            </legend>
            <div className="flex flex-wrap gap-3 pt-0.5">
              {CAPABILITY_OPTIONS.map((cap) => (
                <label
                  key={cap.id}
                  className="inline-flex items-center gap-1.5 text-xs font-mono text-slate-700 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={capabilities.includes(cap.id)}
                    onChange={() => toggleCapability(cap.id)}
                    className="w-3.5 h-3.5 rounded border-slate-300 text-slate-900"
                  />
                  <span>{cap.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex items-center gap-2.5 pt-1">
            <input
              id="task-approval-checkbox"
              type="checkbox"
              checked={approvalRequired || isExternalTool}
              disabled={isExternalTool}
              onChange={(e) => setApprovalRequired(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-blue-600"
            />
            <label
              htmlFor="task-approval-checkbox"
              className="text-sm text-slate-800"
            >
              Require explicit user approval in Approval Gate before execution
            </label>
          </div>

          {(approvalRequired || isExternalTool) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <label
                  htmlFor="task-recipient-input"
                  className="block text-xs font-medium text-slate-700"
                >
                  Intended Target / Recipient
                </label>
                <input
                  id="task-recipient-input"
                  type="text"
                  value={targetRecipient}
                  onChange={(e) => setTargetRecipient(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg text-slate-900"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="task-cost-input"
                  className="block text-xs font-medium text-slate-700"
                >
                  Known Cost
                </label>
                <input
                  id="task-cost-input"
                  type="text"
                  value={estimatedCost}
                  onChange={(e) => setEstimatedCost(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg text-slate-900"
                />
              </div>
            </div>
          )}

          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {submitting ? 'Adding...' : 'Add Task to Queue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
