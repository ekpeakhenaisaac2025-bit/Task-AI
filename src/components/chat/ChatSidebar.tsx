import React, { useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Blocks,
  Check,
  CheckSquare,
  FolderKanban,
  History,
  LogOut,
  MessageSquare,
  MessageSquarePlus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Settings,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AuthSessionUser,
  ConversationRecord,
  WorkspaceRecord,
} from '../../types';

export type SidebarSection =
  | 'chat'
  | 'projects'
  | 'tasks'
  | 'history'
  | 'apps'
  | 'settings';

interface ChatSidebarProps {
  user: AuthSessionUser;
  workspaces: WorkspaceRecord[];
  selectedWorkspaceId: string | null;
  conversations: ConversationRecord[];
  activeConversationId: string | null;
  activeSection: SidebarSection;
  collapsed: boolean;
  mobileOpen: boolean;
  searchQuery: string;
  showArchived: boolean;
  theme: 'light' | 'dark';
  projectsCount: number;
  pendingTasksCount: number;
  connectedAppsCount: number;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
  onNewChat: () => Promise<void>;
  onSelectConversation: (conversationId: string) => Promise<void>;
  onRenameConversation: (
    conversationId: string,
    newTitle: string
  ) => Promise<void>;
  onToggleArchiveConversation: (
    conversationId: string,
    archived: boolean
  ) => Promise<void>;
  onDeleteConversation: (conversationId: string) => Promise<void>;
  onSearchChange: (query: string) => void;
  onToggleShowArchived: (archived: boolean) => void;
  onSelectSection: (section: SidebarSection) => void;
  onSwitchWorkspace: (workspaceId: string) => Promise<void>;
  onToggleTheme: () => void;
  onSignOut: () => Promise<void>;
}

export const ChatSidebar: React.FC<ChatSidebarProps> = ({
  user,
  workspaces,
  selectedWorkspaceId,
  conversations,
  activeConversationId,
  activeSection,
  collapsed,
  mobileOpen,
  searchQuery,
  showArchived,
  theme,
  projectsCount,
  pendingTasksCount,
  connectedAppsCount,
  onToggleCollapse,
  onCloseMobile,
  onNewChat,
  onSelectConversation,
  onRenameConversation,
  onToggleArchiveConversation,
  onDeleteConversation,
  onSearchChange,
  onToggleShowArchived,
  onSelectSection,
  onSwitchWorkspace,
  onToggleTheme,
  onSignOut,
}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const navItems: Array<{
    id: Exclude<SidebarSection, 'chat'>;
    label: string;
    count?: number;
    icon: React.ReactNode;
  }> = [
    {
      id: 'projects',
      label: 'Projects',
      count: projectsCount > 0 ? projectsCount : undefined,
      icon: <FolderKanban className="w-4 h-4 shrink-0" />,
    },
    {
      id: 'tasks',
      label: 'Tasks',
      count: pendingTasksCount > 0 ? pendingTasksCount : undefined,
      icon: <CheckSquare className="w-4 h-4 shrink-0" />,
    },
    {
      id: 'history',
      label: 'Execution History',
      icon: <History className="w-4 h-4 shrink-0" />,
    },
    {
      id: 'apps',
      label: 'Connected Apps',
      count: connectedAppsCount > 0 ? connectedAppsCount : undefined,
      icon: <Blocks className="w-4 h-4 shrink-0" />,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: <Settings className="w-4 h-4 shrink-0" />,
    },
  ];

  const renderExpandedContent = (isMobileDrawer: boolean) => (
    <div className="flex flex-col h-full bg-slate-50 dark:bg-[#080b11] text-slate-900 dark:text-slate-100 select-none">
      {/* Top Brand + Collapse/Close */}
      <div className="h-14 px-3.5 flex items-center justify-between gap-2 border-b border-slate-200/80 dark:border-slate-800/80 shrink-0">
        <button
          type="button"
          onClick={() => {
            onSelectSection('chat');
            if (isMobileDrawer) onCloseMobile();
          }}
          className="flex items-center gap-2.5 text-left cursor-pointer group"
        >
          <span className="w-7 h-7 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 font-bold text-xs flex items-center justify-center shrink-0">
            T
          </span>
          <span className="text-base font-bold tracking-tight text-slate-900 dark:text-white">
            Task.ai
          </span>
        </button>

        {isMobileDrawer ? (
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation menu"
            className="min-h-[40px] min-w-[40px] p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="min-h-[36px] min-w-[36px] p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* New Chat + Search Conversations */}
      <div className="p-3 space-y-2.5 shrink-0">
        <button
          type="button"
          onClick={async () => {
            await onNewChat();
            if (isMobileDrawer) onCloseMobile();
          }}
          className="w-full min-h-[40px] px-3.5 py-2 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white text-sm font-semibold flex items-center gap-2.5 transition-colors cursor-pointer"
        >
          <MessageSquarePlus className="w-4 h-4 shrink-0" />
          <span>New Chat</span>
        </button>

        <div className="relative">
          <Search
            aria-hidden="true"
            className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
          />
          <label
            htmlFor={
              isMobileDrawer
                ? 'mobile-sidebar-search'
                : 'desktop-sidebar-search'
            }
            className="sr-only"
          >
            Search conversations
          </label>
          <input
            id={
              isMobileDrawer
                ? 'mobile-sidebar-search'
                : 'desktop-sidebar-search'
            }
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search conversations..."
            className="w-full min-h-[38px] pl-8 pr-7 py-1.5 text-xs rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-slate-400 dark:focus:border-slate-600"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              aria-label="Clear conversation search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Middle: Recent Conversations + Workspace Navigation */}
      <div className="flex-1 overflow-y-auto px-2.5 pb-3 space-y-5">
        {/* Recent Conversations */}
        <section aria-label="Conversations list" className="space-y-1">
          <div className="px-2 py-1 flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-semibold text-slate-600 dark:text-slate-300">
              {showArchived ? 'Archived Chats' : 'Recent Conversations'}
            </span>
            <button
              type="button"
              onClick={() => onToggleShowArchived(!showArchived)}
              className="text-[11px] font-medium hover:text-slate-900 dark:hover:text-white underline-offset-2 hover:underline cursor-pointer"
            >
              {showArchived ? 'Show Active' : 'Archived'}
            </button>
          </div>

          {conversations.length === 0 ? (
            <p className="px-2.5 py-3 text-xs text-slate-500 dark:text-slate-500">
              {searchQuery
                ? 'No matching conversations found.'
                : showArchived
                  ? 'No archived conversations.'
                  : 'No conversations yet. Start a new chat above.'}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((conv) => {
                const isSelected =
                  activeSection === 'chat' && activeConversationId === conv.id;
                const isRenaming = renamingId === conv.id;
                const isConfirmingDelete = confirmDeleteId === conv.id;

                if (isRenaming) {
                  return (
                    <li
                      key={conv.id}
                      className="p-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                    >
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const next = renameDraft.trim();
                          if (next) {
                            await onRenameConversation(conv.id, next);
                          }
                          setRenamingId(null);
                          setRenameDraft('');
                        }}
                        className="flex items-center gap-1"
                      >
                        <label
                          htmlFor={`rename-conv-${conv.id}`}
                          className="sr-only"
                        >
                          Rename conversation {conv.title}
                        </label>
                        <input
                          id={`rename-conv-${conv.id}`}
                          type="text"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          autoFocus
                          className="flex-1 min-w-0 px-2 py-1 text-xs bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none"
                        />
                        <button
                          type="submit"
                          aria-label={`Save title for ${conv.title}`}
                          className="p-1 rounded text-emerald-700 dark:text-emerald-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingId(null);
                            setRenameDraft('');
                          }}
                          aria-label="Cancel rename"
                          className="p-1 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </form>
                    </li>
                  );
                }

                return (
                  <li key={conv.id} className="group relative">
                    <div
                      className={`flex items-center justify-between gap-1 rounded-lg px-2.5 py-2 text-xs transition-colors ${
                        isSelected
                          ? 'bg-slate-200/80 dark:bg-slate-800 text-slate-900 dark:text-white font-semibold'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/50 dark:hover:bg-slate-800/60'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={async () => {
                          await onSelectConversation(conv.id);
                          if (isMobileDrawer) onCloseMobile();
                        }}
                        className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                      >
                        <MessageSquare className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                        <span className="truncate">{conv.title}</span>
                      </button>

                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={async () => {
                              setConfirmDeleteId(null);
                              await onDeleteConversation(conv.id);
                            }}
                            aria-label={`Confirm delete '${conv.title}'`}
                            className="px-1.5 py-0.5 rounded bg-red-600 text-white text-[11px] font-semibold cursor-pointer"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            aria-label="Cancel delete"
                            className="p-0.5 text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div
                          className={`flex items-center gap-0.5 shrink-0 ${
                            isSelected
                              ? 'opacity-100'
                              : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'
                          } transition-opacity`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setRenamingId(conv.id);
                              setRenameDraft(conv.title);
                            }}
                            aria-label={`Rename '${conv.title}'`}
                            title="Rename"
                            className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-300/50 dark:hover:bg-slate-700 cursor-pointer"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onToggleArchiveConversation(
                                conv.id,
                                !conv.archived
                              )
                            }
                            aria-label={
                              conv.archived
                                ? `Restore '${conv.title}'`
                                : `Archive '${conv.title}'`
                            }
                            title={conv.archived ? 'Restore' : 'Archive'}
                            className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-300/50 dark:hover:bg-slate-700 cursor-pointer"
                          >
                            {conv.archived ? (
                              <ArchiveRestore className="w-3 h-3" />
                            ) : (
                              <Archive className="w-3 h-3" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(conv.id)}
                            aria-label={`Delete '${conv.title}'`}
                            title="Delete"
                            className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-300/50 dark:hover:bg-slate-700 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Platform Workspace Navigation */}
        <nav aria-label="Workspace platform sections" className="space-y-0.5">
          <div className="px-2 py-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
            Workspace
          </div>
          {navItems.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelectSection(item.id);
                  if (isMobileDrawer) onCloseMobile();
                }}
                className={`w-full min-h-[38px] px-2.5 py-2 rounded-lg text-xs flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                  active
                    ? 'bg-slate-200/80 dark:bg-slate-800 text-slate-900 dark:text-white font-semibold'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/50 dark:hover:bg-slate-800/60'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  <span className="text-slate-500 dark:text-slate-400">
                    {item.icon}
                  </span>
                  <span className="truncate">{item.label}</span>
                </span>
                {item.count !== undefined && (
                  <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* User Profile & Workspace Footer */}
      <div className="p-3 border-t border-slate-200/80 dark:border-slate-800/80 space-y-2.5 shrink-0">
        {workspaces.length > 0 && (
          <div>
            <label
              htmlFor={
                isMobileDrawer
                  ? 'mobile-workspace-switcher'
                  : 'desktop-workspace-switcher'
              }
              className="sr-only"
            >
              Active workspace
            </label>
            <select
              id={
                isMobileDrawer
                  ? 'mobile-workspace-switcher'
                  : 'desktop-workspace-switcher'
              }
              aria-label="Active workspace"
              value={selectedWorkspaceId ?? ''}
              onChange={(e) => onSwitchWorkspace(e.target.value)}
              className="w-full min-h-[36px] px-2.5 py-1.5 text-xs font-medium rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer"
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  Workspace: {ws.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-0.5">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div
              aria-hidden="true"
              className="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-semibold flex items-center justify-center shrink-0 uppercase"
            >
              {user.email.slice(0, 1)}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                {user.email}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {user.authMode === 'google'
                  ? 'Google Account'
                  : 'Isolated Session'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={
                theme === 'dark'
                  ? 'Switch to light theme'
                  : 'Switch to dark theme'
              }
              title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
              className="min-h-[34px] min-w-[34px] p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer"
            >
              {theme === 'dark' ? (
                <Sun className="w-4 h-4" />
              ) : (
                <Moon className="w-4 h-4" />
              )}
            </button>

            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out"
              className="min-h-[34px] min-w-[34px] p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-200/60 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile Slide-Out Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            aria-hidden="true"
            onClick={onCloseMobile}
            className="fixed inset-0 bg-slate-950/55"
          />
          <aside
            aria-label="Mobile navigation drawer"
            className="relative z-10 w-[284px] max-w-[85vw] h-full border-r border-slate-200 dark:border-slate-800 shadow-2xl"
          >
            {renderExpandedContent(true)}
          </aside>
        </div>
      )}

      {/* Desktop Collapsible Sidebar */}
      <aside
        aria-label="Primary sidebar"
        className={`hidden md:flex shrink-0 flex-col border-r border-slate-200 dark:border-slate-800/80 bg-slate-50 dark:bg-[#080b11] h-full ${
          collapsed ? 'w-[60px]' : 'w-[268px]'
        }`}
      >
        {collapsed ? (
          <div className="flex flex-col items-center justify-between h-full py-3 px-2">
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label="Expand sidebar"
                title="Expand sidebar"
                className="min-h-[40px] min-w-[40px] rounded-xl text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer"
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={onNewChat}
                aria-label="New Chat"
                title="New Chat"
                className="min-h-[40px] min-w-[40px] rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white flex items-center justify-center cursor-pointer"
              >
                <MessageSquarePlus className="w-4 h-4" />
              </button>

              <div className="w-6 border-t border-slate-200 dark:border-slate-800 my-1" />

              {navItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectSection(item.id)}
                  aria-label={item.label}
                  title={item.label}
                  className={`min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                    activeSection === item.id
                      ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-white'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
                  }`}
                >
                  {item.icon}
                </button>
              ))}
            </div>

            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={onToggleTheme}
                aria-label={
                  theme === 'dark'
                    ? 'Switch to light theme'
                    : 'Switch to dark theme'
                }
                title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
                className="min-h-[40px] min-w-[40px] rounded-xl text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer"
              >
                {theme === 'dark' ? (
                  <Sun className="w-4 h-4" />
                ) : (
                  <Moon className="w-4 h-4" />
                )}
              </button>

              <button
                type="button"
                onClick={onSignOut}
                aria-label="Sign out"
                title="Sign out"
                className="min-h-[40px] min-w-[40px] rounded-xl text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-200/60 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : (
          renderExpandedContent(false)
        )}
      </aside>
    </>
  );
};
