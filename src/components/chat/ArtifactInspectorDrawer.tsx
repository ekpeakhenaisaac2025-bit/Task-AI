import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, X } from 'lucide-react';
import { parseCsvPreviewRows } from '../../lib/chat-utils';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { ConversationArtifactRecord } from '../../types';

interface ArtifactInspectorDrawerProps {
  artifact: ConversationArtifactRecord | null;
  onClose: () => void;
  onDownload: (artifact: ConversationArtifactRecord) => void;
}

export const ArtifactInspectorDrawer: React.FC<ArtifactInspectorDrawerProps> = ({
  artifact,
  onClose,
  onDownload,
}) => {
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview');
  const [copied, setCopied] = useState(false);

  const isSpreadsheet =
    artifact?.artifactType === 'spreadsheet' ||
    artifact?.mimeType === 'text/csv';

  const parsedCsv = useMemo(() => {
    if (!artifact || !isSpreadsheet) return null;
    return parseCsvPreviewRows(artifact.content, 100);
  }, [artifact, isSpreadsheet]);

  if (!artifact) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = artifact.content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  const renderBody = () => {
    if (viewMode === 'source' || artifact.artifactType === 'code') {
      return (
        <pre className="text-xs leading-relaxed font-mono text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          {artifact.content}
        </pre>
      );
    }

    if (isSpreadsheet && parsedCsv && parsedCsv.headers.length > 0) {
      return (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto bg-white dark:bg-slate-950/60">
          <table className="w-full text-left border-collapse text-xs tabular-nums">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300">
              <tr>
                {parsedCsv.headers.map((header, idx) => (
                  <th
                    key={`${header}-${idx}`}
                    className="px-3 py-2.5 font-semibold whitespace-nowrap"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
              {parsedCsv.rows.map((row, rIdx) => (
                <tr
                  key={rIdx}
                  className="hover:bg-slate-50/80 dark:hover:bg-slate-900/40"
                >
                  {parsedCsv.headers.map((_, cIdx) => (
                    <td
                      key={cIdx}
                      className="px-3 py-2 text-slate-700 dark:text-slate-300 align-top"
                    >
                      {row[cIdx] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    return <MarkdownRenderer content={artifact.content} />;
  };

  return (
    <>
      {/* Mobile / Tablet Modal Sheet Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-slate-950/50 lg:hidden"
      />

      <aside
        aria-label={`Artifact preview: ${artifact.title}`}
        className="fixed inset-x-0 bottom-0 top-10 z-50 rounded-t-2xl lg:rounded-none lg:static lg:z-auto lg:w-[420px] xl:w-[460px] shrink-0 flex flex-col bg-white dark:bg-[#0d121c] border-t lg:border-t-0 lg:border-l border-slate-200 dark:border-slate-800 shadow-xl lg:shadow-none"
      >
        {/* Mobile grab handle */}
        <div
          aria-hidden="true"
          className="w-10 h-1 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto mt-2.5 lg:hidden"
        />

        {/* Header */}
        <div className="px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
              {artifact.title}
            </h2>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-mono truncate max-w-[200px]">
                {artifact.filename}
              </span>
              <span aria-hidden="true">·</span>
              <span>{artifact.mimeType}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close artifact preview"
            className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Action & Mode Bar */}
        <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 flex items-center justify-between gap-2">
          <div
            role="group"
            aria-label="Artifact display mode"
            className="flex items-center gap-1 p-0.5 bg-slate-200/70 dark:bg-slate-800 rounded-lg"
          >
            <button
              type="button"
              onClick={() => setViewMode('preview')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'preview'
                  ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setViewMode('source')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'source'
                  ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Source
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy artifact content"
              className="min-h-[34px] px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => onDownload(artifact)}
              aria-label={`Download ${artifact.filename}`}
              className="min-h-[34px] px-3 py-1 text-xs font-semibold text-white dark:text-slate-950 bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">{renderBody()}</div>
      </aside>
    </>
  );
};
