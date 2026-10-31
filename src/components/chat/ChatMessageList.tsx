import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  FileText,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RotateCcw,
} from 'lucide-react';
import { ArtifactCard } from './ArtifactCard';
import { ExecutionActivityPanel } from './ExecutionActivityPanel';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ChatIntegrationPromptCard } from '../integrations/ChatIntegrationPromptCard';
import type {
  ChatAttachmentRecord,
  ConversationArtifactRecord,
  ConversationMessageRecord,
  HydratedGoalExecutionContext,
  TaskRecord,
} from '../../types';

interface ChatMessageListProps {
  workspaceName: string;
  messages: ConversationMessageRecord[];
  artifacts: ConversationArtifactRecord[];
  selectedArtifactId: string | null;
  workspaceTasks: TaskRecord[];
  hydratedGoal: HydratedGoalExecutionContext | null;
  isStreaming: boolean;
  busyAction: string | null;
  onSelectStarterPrompt: (
    prompt: string,
    mode: 'auto' | 'chat' | 'execute'
  ) => void;
  onEditAndResend: (messageId: string, updatedContent: string) => Promise<void>;
  onRegenerateResponse: (assistantMessageId: string) => Promise<void>;
  onPreviewArtifact: (artifact: ConversationArtifactRecord) => void;
  onDownloadArtifact: (artifact: ConversationArtifactRecord) => void;
  onDecideApproval: (
    taskId: string,
    decision: 'approved' | 'rejected'
  ) => Promise<void>;
  onRunGoalWave: (goalId: string) => Promise<void>;
  onInspectProject: (goalId: string) => void;
  onOpenIntegrations: () => void;
  onRefreshWorkspace: () => Promise<void>;
}

const STARTER_PROMPTS: ReadonlyArray<{
  title: string;
  subtitle: string;
  prompt: string;
  mode: 'auto' | 'chat' | 'execute';
}> = [
  {
    title: 'Launch B2B Outreach Execution Plan',
    subtitle: 'Decompose tasks, draft emails & gate external dispatch',
    prompt:
      'Launch an outreach campaign to acquire 5 qualified B2B SaaS leads: define the ideal customer qualification rubric, draft personalized cold outreach emails, and prepare webhook dispatch.',
    mode: 'execute',
  },
  {
    title: 'Run Diagnostic Verification Pipeline',
    subtitle: 'Execute internal SHA-256 verification & audit evidence tiers',
    prompt:
      'Create and execute an execution plan to run a deterministic internal diagnostic check and explain how Task.ai separates diagnostic checks from verified business outcomes.',
    mode: 'execute',
  },
  {
    title: 'Generate Pipeline Benchmark Report',
    subtitle: 'Create a structured report + downloadable CSV table',
    prompt:
      'Write a concise B2B SaaS pipeline conversion benchmark report with a Markdown table comparing 4 acquisition channels across CAC, conversion rate, and sales cycle days.',
    mode: 'chat',
  },
  {
    title: 'Configure AI Support & Scheduling Workforce',
    subtitle: 'Evaluate required connectors, permissions & readiness gates',
    prompt:
      'Create an AI employee that manages my customer support, triages incoming emails, and schedules follow-up meetings.',
    mode: 'auto',
  },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const AttachmentPreviewList: React.FC<{
  attachments: ChatAttachmentRecord[];
}> = ({ attachments }) => {
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap justify-end gap-2 mb-2 max-w-[85%] sm:max-w-[78%]">
      {attachments.map((att) => {
        if (att.kind === 'image' && att.dataUrl && !failedImages[att.id]) {
          return (
            <div
              key={att.id}
              className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 max-w-[220px]"
            >
              <img
                src={att.dataUrl}
                alt={att.name}
                referrerPolicy="no-referrer"
                onError={() =>
                  setFailedImages((prev) => ({ ...prev, [att.id]: true }))
                }
                className="max-h-44 w-auto object-cover block"
              />
              <div className="px-2.5 py-1 text-[11px] text-slate-600 dark:text-slate-300 truncate">
                {att.name}
              </div>
            </div>
          );
        }

        return (
          <div
            key={att.id}
            className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 text-xs text-slate-700 dark:text-slate-200 max-w-[260px]"
          >
            {att.kind === 'image' ? (
              <ImageIcon className="w-4 h-4 text-slate-500 shrink-0" />
            ) : (
              <FileText className="w-4 h-4 text-slate-500 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="font-medium truncate">{att.name}</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                {formatBytes(att.sizeBytes)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export const ChatMessageList: React.FC<ChatMessageListProps> = ({
  workspaceName,
  messages,
  artifacts,
  selectedArtifactId,
  workspaceTasks,
  hydratedGoal,
  isStreaming,
  busyAction,
  onSelectStarterPrompt,
  onEditAndResend,
  onRegenerateResponse,
  onPreviewArtifact,
  onDownloadArtifact,
  onDecideApproval,
  onRunGoalWave,
  onInspectProject,
  onOpenIntegrations,
  onRefreshWorkspace,
}) => {
  const bottomEndRef = useRef<HTMLDivElement | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    bottomEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isStreaming]);

  const handleCopyMessage = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
  };

  if (messages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-10 flex flex-col items-center justify-center">
        <div className="max-w-2xl w-full space-y-8">
          <div className="text-center space-y-2.5">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
              What should we plan, analyze, or execute?
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Active workspace: {workspaceName} · Consequential actions pause at
              the Approval Gate and require verified evidence
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {STARTER_PROMPTS.map((item) => (
              <button
                key={item.title}
                type="button"
                disabled={isStreaming}
                onClick={() => onSelectStarterPrompt(item.prompt, item.mode)}
                className="text-left p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/50 hover:bg-slate-50 dark:hover:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-colors space-y-1 cursor-pointer disabled:opacity-50"
              >
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {item.title}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  {item.subtitle}
                </p>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
      <div className="max-w-3xl w-full mx-auto space-y-7">
        {messages.map((msg) => {
          if (msg.role === 'user') {
            const isEditing = editingMessageId === msg.id;

            return (
              <article
                key={msg.id}
                aria-label="User message"
                className="flex flex-col items-end group"
              >
                <AttachmentPreviewList attachments={msg.attachments} />

                {isEditing ? (
                  <div className="w-full max-w-2xl rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-3.5 space-y-3">
                    <label
                      htmlFor={`edit-msg-${msg.id}`}
                      className="sr-only"
                    >
                      Edit message
                    </label>
                    <textarea
                      id={`edit-msg-${msg.id}`}
                      rows={3}
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      className="w-full text-[15px] leading-relaxed bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none resize-y"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMessageId(null);
                          setEditingText('');
                        }}
                        className="min-h-[34px] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!editingText.trim() || isStreaming}
                        onClick={async () => {
                          const nextContent = editingText.trim();
                          setEditingMessageId(null);
                          setEditingText('');
                          await onEditAndResend(msg.id, nextContent);
                        }}
                        className="min-h-[34px] px-3.5 py-1.5 text-xs font-semibold text-white dark:text-slate-950 bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
                      >
                        Save &amp; Resend
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {msg.content && (
                      <div className="max-w-[86%] sm:max-w-[78%] rounded-2xl px-4 py-3 bg-slate-100 dark:bg-slate-800/90 text-slate-900 dark:text-slate-100 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                        {msg.content}
                      </div>
                    )}

                    <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      {msg.editedAt && <span>Edited</span>}
                      <button
                        type="button"
                        onClick={() => handleCopyMessage(msg.id, msg.content)}
                        aria-label="Copy user message"
                        className="min-h-[30px] px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200 inline-flex items-center gap-1 transition-colors cursor-pointer"
                      >
                        {copiedId === msg.id ? (
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
                        disabled={isStreaming}
                        onClick={() => {
                          setEditingMessageId(msg.id);
                          setEditingText(msg.content);
                        }}
                        aria-label="Edit and resend message"
                        className="min-h-[30px] px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200 disabled:opacity-40 inline-flex items-center gap-1 transition-colors cursor-pointer"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        <span>Edit</span>
                      </button>
                    </div>
                  </>
                )}
              </article>
            );
          }

          // Assistant response (Left-Aligned)
          const turnArtifacts = artifacts.filter(
            (a) =>
              msg.artifactIds.includes(a.id) || a.messageId === msg.id
          );

          const traceGoalId = msg.executionTrace?.goalId ?? null;
          const matchingGoalTasks = traceGoalId
            ? hydratedGoal && hydratedGoal.goal.id === traceGoalId
              ? hydratedGoal.tasks
              : workspaceTasks.filter((t) => t.goalId === traceGoalId)
            : [];

          return (
            <article
              key={msg.id}
              aria-label="Task.ai response"
              className="flex items-start gap-3.5"
            >
              <div
                aria-hidden="true"
                className="w-7 h-7 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 font-semibold text-xs flex items-center justify-center shrink-0 mt-0.5 select-none"
              >
                T
              </div>

              <div className="min-w-0 flex-1 space-y-3.5">
                {/* Inline Intelligent Workforce / Connector Authorization Card */}
                {msg.executionTrace?.interactivePrompt && (
                  <ChatIntegrationPromptCard
                    prompt={msg.executionTrace.interactivePrompt}
                    onOpenIntegrations={onOpenIntegrations}
                    onRefreshWorkspace={onRefreshWorkspace}
                  />
                )}

                {/* Inline Autonomous Execution Activity Panel */}
                {msg.executionTrace &&
                  msg.executionTrace.stages &&
                  msg.executionTrace.stages.length > 0 && (
                    <ExecutionActivityPanel
                      trace={msg.executionTrace}
                      goalTasks={matchingGoalTasks}
                      busyAction={busyAction}
                      onDecideApproval={onDecideApproval}
                      onRunGoalWave={onRunGoalWave}
                      onInspectProject={onInspectProject}
                    />
                  )}

                {/* Streaming / Markdown Body */}
                {msg.status === 'error' ? (
                  <div
                    role="alert"
                    className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 p-3.5 text-sm text-red-800 dark:text-red-300 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                      <span className="break-words">{msg.content}</span>
                    </div>
                    <button
                      type="button"
                      disabled={isStreaming}
                      onClick={() => onRegenerateResponse(msg.id)}
                      className="min-h-[34px] px-3 py-1.5 text-xs font-semibold text-red-900 dark:text-red-200 bg-white dark:bg-red-900/40 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/60 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Retry</span>
                    </button>
                  </div>
                ) : msg.content ? (
                  <MarkdownRenderer content={msg.content} />
                ) : msg.status === 'streaming' ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 py-1">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>
                      {msg.executionTrace
                        ? 'Orchestrating plan and synthesizing grounded results...'
                        : 'Thinking...'}
                    </span>
                  </div>
                ) : null}

                {/* Associated Downloadable Artifacts */}
                {turnArtifacts.length > 0 && (
                  <div className="space-y-2 pt-1">
                    {turnArtifacts.map((artifact) => (
                      <ArtifactCard
                        key={artifact.id}
                        artifact={artifact}
                        isSelected={selectedArtifactId === artifact.id}
                        onPreview={onPreviewArtifact}
                        onDownload={onDownloadArtifact}
                      />
                    ))}
                  </div>
                )}

                {/* Assistant Action Bar */}
                {msg.status !== 'streaming' && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 pt-0.5">
                    {msg.content && (
                      <button
                        type="button"
                        onClick={() => handleCopyMessage(msg.id, msg.content)}
                        aria-label="Copy AI response"
                        className="min-h-[30px] px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        {copiedId === msg.id ? (
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
                    )}

                    <button
                      type="button"
                      disabled={isStreaming}
                      onClick={() => onRegenerateResponse(msg.id)}
                      aria-label="Regenerate AI response"
                      className="min-h-[30px] px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200 disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Regenerate</span>
                    </button>

                    {msg.model && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-[11px]">{msg.model}</span>
                      </>
                    )}

                    {msg.status === 'stopped' && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-amber-700 dark:text-amber-400">
                          Stopped
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}

        <div ref={bottomEndRef} className="h-2" />
      </div>
    </div>
  );
};
