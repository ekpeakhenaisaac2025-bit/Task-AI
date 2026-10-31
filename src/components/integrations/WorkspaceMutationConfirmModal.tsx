import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

export interface WorkspaceMutationConfirmationRequest {
  title: string;
  description: string;
  targetSummary?: string;
  affectedItems?: string[];
  confirmLabel: string;
  isDestructive?: boolean;
  onConfirm: () => Promise<void> | void;
}

interface WorkspaceMutationConfirmModalProps {
  request: WorkspaceMutationConfirmationRequest | null;
  busy?: boolean;
  onCancel: () => void;
}

export const WorkspaceMutationConfirmModal: React.FC<
  WorkspaceMutationConfirmModalProps
> = ({ request, busy = false, onCancel }) => {
  if (!request) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-mutation-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xl p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2
                id="workspace-mutation-dialog-title"
                className="text-base font-semibold tracking-tight"
              >
                {request.title}
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                {request.description}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close confirmation dialog"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-900 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {(request.targetSummary ||
          (request.affectedItems && request.affectedItems.length > 0)) && (
          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2 text-xs text-slate-700 dark:text-slate-300">
            {request.targetSummary && (
              <p className="font-mono break-words">{request.targetSummary}</p>
            )}
            {request.affectedItems && request.affectedItems.length > 0 && (
              <ul className="space-y-1 text-slate-600 dark:text-slate-400">
                {request.affectedItems.map((item, idx) => (
                  <li key={idx} className="truncate">
                    · {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-[40px] px-4 py-2 text-xs font-medium rounded-xl border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void request.onConfirm()}
            className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl transition-colors cursor-pointer disabled:opacity-50 ${
              request.isDestructive
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white text-white dark:text-slate-950'
            }`}
          >
            {busy ? 'Processing...' : request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
