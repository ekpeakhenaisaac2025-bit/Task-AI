import React from 'react';
import {
  Download,
  Eye,
  FileCode,
  FileSpreadsheet,
  FileText,
  ListChecks,
  Mail,
} from 'lucide-react';
import type { ArtifactType, ConversationArtifactRecord } from '../../types';

interface ArtifactCardProps {
  artifact: ConversationArtifactRecord;
  isSelected?: boolean;
  onPreview: (artifact: ConversationArtifactRecord) => void;
  onDownload: (artifact: ConversationArtifactRecord) => void;
}

function getArtifactMeta(type: ArtifactType): {
  label: string;
  icon: React.ReactNode;
} {
  switch (type) {
    case 'spreadsheet':
      return {
        label: 'Spreadsheet (CSV)',
        icon: (
          <FileSpreadsheet className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
        ),
      };
    case 'outreach_draft':
      return {
        label: 'Outreach Drafts',
        icon: (
          <Mail className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0" />
        ),
      };
    case 'plan':
      return {
        label: 'Execution Plan',
        icon: (
          <ListChecks className="w-4 h-4 text-blue-700 dark:text-blue-400 shrink-0" />
        ),
      };
    case 'code':
      return {
        label: 'Source File',
        icon: (
          <FileCode className="w-4 h-4 text-slate-700 dark:text-slate-300 shrink-0" />
        ),
      };
    case 'report':
      return {
        label: 'Report',
        icon: (
          <FileText className="w-4 h-4 text-blue-700 dark:text-blue-400 shrink-0" />
        ),
      };
    case 'document':
    default:
      return {
        label: 'Document',
        icon: (
          <FileText className="w-4 h-4 text-slate-700 dark:text-slate-300 shrink-0" />
        ),
      };
  }
}

export const ArtifactCard: React.FC<ArtifactCardProps> = ({
  artifact,
  isSelected = false,
  onPreview,
  onDownload,
}) => {
  const meta = getArtifactMeta(artifact.artifactType);
  const rowCount =
    typeof artifact.metadata?.rowCount === 'number'
      ? artifact.metadata.rowCount
      : null;
  const deliveryState =
    artifact.metadata?.deliveryState === 'drafted_only_not_sent'
      ? 'Drafted only (0 sent)'
      : null;

  return (
    <div
      className={`rounded-xl border px-4 py-3 flex flex-wrap items-center justify-between gap-3 transition-colors ${
        isSelected
          ? 'border-slate-900 dark:border-slate-300 bg-slate-50 dark:bg-slate-900'
          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 hover:border-slate-300 dark:hover:border-slate-700'
      }`}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <div className="w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex items-center justify-center shrink-0 mt-0.5">
          {meta.icon}
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
            {artifact.title}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            <span>{meta.label}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono truncate max-w-[180px]">
              {artifact.filename}
            </span>
            {rowCount !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span>{rowCount} rows</span>
              </>
            )}
            {deliveryState && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-amber-700 dark:text-amber-400 font-medium">
                  {deliveryState}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => onPreview(artifact)}
          aria-label={`Preview artifact ${artifact.title}`}
          className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Eye className="w-3.5 h-3.5" />
          <span>Preview</span>
        </button>
        <button
          type="button"
          onClick={() => onDownload(artifact)}
          aria-label={`Download ${artifact.filename}`}
          className="min-h-[36px] px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Download</span>
        </button>
      </div>
    </div>
  );
};
