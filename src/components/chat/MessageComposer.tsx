import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Cpu,
  FileText,
  Paperclip,
  Square,
  X,
} from 'lucide-react';
import { SUPPORTED_CHAT_MODELS } from '../../lib/chat-utils';
import type { ChatAttachmentRecord, ChatModelId } from '../../types';

interface MessageComposerProps {
  selectedModel: ChatModelId;
  executionMode: 'auto' | 'chat' | 'execute';
  isStreaming: boolean;
  runningTasksCount: number;
  pendingApprovalsCount: number;
  onModelChange: (model: ChatModelId) => void;
  onExecutionModeChange: (mode: 'auto' | 'chat' | 'execute') => void;
  onSendMessage: (
    content: string,
    attachments: ChatAttachmentRecord[]
  ) => Promise<void>;
  onStopGeneration: () => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export const MessageComposer: React.FC<MessageComposerProps> = ({
  selectedModel,
  executionMode,
  isStreaming,
  runningTasksCount,
  pendingApprovalsCount,
  onModelChange,
  onExecutionModeChange,
  onSendMessage,
  onStopGeneration,
}) => {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-expand textarea height smoothly as user types
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight, 200);
    el.style.height = `${Math.max(44, nextHeight)}px`;
  }, [text]);

  const handleFilesSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    setAttachError(null);
    const incoming: ChatAttachmentRecord[] = [];

    for (const file of Array.from(fileList)) {
      if (attachments.length + incoming.length >= 5) {
        setAttachError('Up to 5 attachments can be included per message.');
        break;
      }

      if (file.size > 4 * 1024 * 1024) {
        setAttachError(`"${file.name}" exceeds the 4 MB attachment limit.`);
        continue;
      }

      const isImage = file.type.startsWith('image/');
      try {
        if (isImage) {
          const dataUrl = await readFileAsDataUrl(file);
          incoming.push({
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: file.name,
            mimeType: file.type || 'image/png',
            sizeBytes: file.size,
            kind: 'image',
            dataUrl,
          });
        } else {
          const rawText = await file.text();
          incoming.push({
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: file.name,
            mimeType: file.type || 'text/plain',
            sizeBytes: file.size,
            kind: 'file',
            textContent: rawText.slice(0, 48_000),
          });
        }
      } catch {
        setAttachError(`Could not read "${file.name}".`);
      }
    }

    if (incoming.length > 0) {
      setAttachments((prev) => [...prev, ...incoming].slice(0, 5));
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isStreaming) return;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    const currentAttachments = attachments;
    setText('');
    setAttachments([]);
    setAttachError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = '44px';
    }
    await onSendMessage(trimmed, currentAttachments);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !isStreaming;

  return (
    <div className="w-full px-3 sm:px-6 pb-3 sm:pb-4 pt-2 bg-white dark:bg-[#0b0f17]">
      <div className="max-w-3xl w-full mx-auto space-y-2">
        {attachError && (
          <div
            role="alert"
            className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2"
          >
            <span>{attachError}</span>
            <button
              type="button"
              onClick={() => setAttachError(null)}
              aria-label="Dismiss attachment warning"
              className="p-1 hover:underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-slate-300 dark:border-slate-700/90 bg-white dark:bg-slate-900 focus-within:border-slate-500 dark:focus-within:border-slate-500 shadow-xs transition-colors"
        >
          {/* Attachment Preview Strip */}
          {attachments.length > 0 && (
            <div className="px-3.5 pt-3 pb-1 flex flex-wrap items-center gap-2">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="relative flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-200 max-w-[220px]"
                >
                  {att.kind === 'image' && att.dataUrl ? (
                    <img
                      src={att.dataUrl}
                      alt={att.name}
                      referrerPolicy="no-referrer"
                      className="w-7 h-7 rounded-md object-cover shrink-0"
                    />
                  ) : (
                    <FileText className="w-4 h-4 text-slate-500 shrink-0" />
                  )}
                  <span className="truncate font-medium">{att.name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setAttachments((prev) =>
                        prev.filter((item) => item.id !== att.id)
                      )
                    }
                    aria-label={`Remove attachment ${att.name}`}
                    className="min-h-[26px] min-w-[26px] p-1 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-700 flex items-center justify-center shrink-0 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Auto-Expanding Multiline Input */}
          <div className="px-3.5 pt-2.5 pb-1">
            <label htmlFor="chat-composer-textarea" className="sr-only">
              Message Task.ai
            </label>
            <textarea
              id="chat-composer-textarea"
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything or describe a goal to execute..."
              className="w-full min-h-[40px] max-h-[200px] py-2 bg-transparent text-[15px] leading-6 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none resize-none overflow-y-auto"
            />
          </div>

          {/* Bottom Controls Bar */}
          <div className="px-2.5 pb-2.5 pt-1 flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1 sm:gap-1.5 min-w-0 flex-1">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.csv,.json,.tsv,.log,.js,.ts,.tsx,.py,.sql,.html,.xml,.yaml,.yml"
                onChange={handleFilesSelected}
                className="hidden"
              />

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach files or images"
                title="Attach images, CSVs, Markdown, or code files"
                className="min-h-[38px] min-w-[38px] px-2 sm:px-2.5 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
              >
                <Paperclip className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline">Attach</span>
              </button>

              {/* Task Execution Mode & Live Engine Indicator */}
              <div className="inline-flex items-center min-w-0">
                <label htmlFor="composer-execution-mode" className="sr-only">
                  Task execution mode
                </label>
                <div className="relative inline-flex items-center min-w-0">
                  <Cpu
                    aria-hidden="true"
                    className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 absolute left-2.5 pointer-events-none"
                  />
                  <select
                    id="composer-execution-mode"
                    aria-label="Task execution mode"
                    value={executionMode}
                    onChange={(e) =>
                      onExecutionModeChange(
                        e.target.value as 'auto' | 'chat' | 'execute'
                      )
                    }
                    className="min-h-[38px] max-w-[116px] sm:max-w-none truncate pl-7 pr-2 sm:pr-2.5 py-1.5 text-xs font-medium rounded-xl bg-slate-100/80 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-transparent hover:border-slate-300 dark:hover:border-slate-700 focus:outline-none cursor-pointer"
                  >
                    <option value="auto">Auto (Chat + Execute)</option>
                    <option value="execute">Execute Task Plan</option>
                    <option value="chat">Chat Only</option>
                  </select>
                </div>
              </div>

              {/* Optional Model Selector */}
              <div className="inline-flex items-center min-w-0">
                <label htmlFor="composer-model-select" className="sr-only">
                  AI model selector
                </label>
                <select
                  id="composer-model-select"
                  aria-label="Select AI model"
                  value={selectedModel}
                  onChange={(e) => onModelChange(e.target.value as ChatModelId)}
                  className="min-h-[38px] px-1.5 sm:px-2.5 py-1.5 text-xs font-medium rounded-xl bg-transparent hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 focus:outline-none cursor-pointer max-w-[112px] sm:max-w-[168px] truncate"
                >
                  {SUPPORTED_CHAT_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              {/* Honest Task Execution Indicator */}
              {(runningTasksCount > 0 || pendingApprovalsCount > 0) && (
                <span className="hidden md:inline text-xs text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                  {runningTasksCount > 0
                    ? `${runningTasksCount} task running`
                    : `${pendingApprovalsCount} awaiting approval`}
                </span>
              )}

              {isStreaming ? (
                <button
                  type="button"
                  onClick={onStopGeneration}
                  aria-label="Stop generation"
                  className="min-h-[38px] px-3 sm:px-3.5 py-1.5 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Square className="w-3 h-3 fill-current" />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  aria-label="Send message"
                  className="min-h-[38px] min-w-[38px] px-3 py-1.5 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 transition-colors shrink-0 cursor-pointer"
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </form>

        <p className="text-[11px] text-center text-slate-400 dark:text-slate-500 truncate">
          <span className="hidden sm:inline">
            Enter to send · Shift + Enter for new line ·{' '}
          </span>
          Tasks only report completion with verified execution evidence
        </p>
      </div>
    </div>
  );
};
