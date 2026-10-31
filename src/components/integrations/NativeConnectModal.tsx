import React, { useEffect, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, KeyRound, ShieldCheck, X } from 'lucide-react';
import {
  connectGoogleWorkspacePopup,
  WORKSPACE_CONNECTOR_SCOPES,
} from '../../lib/firebase';
import { api } from '../../lib/api';
import type { IntegrationRegistryEntry } from '../../types';

interface NativeConnectModalProps {
  isOpen: boolean;
  entry: IntegrationRegistryEntry | null;
  workspaceId: string | undefined;
  onClose: () => void;
  onConnected: () => Promise<void>;
}

const GoogleLogoMark: React.FC = () => (
  <svg
    version="1.1"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 48 48"
    className="w-4 h-4 shrink-0 block"
    aria-hidden="true"
  >
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
);

export const NativeConnectModal: React.FC<NativeConnectModalProps> = ({
  isOpen,
  entry,
  workspaceId,
  onClose,
  onConnected,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [oauthSetupInfo, setOauthSetupInfo] = useState<{
    redirectUri: string;
    missingEnvVars: string[];
  } | null>(null);
  const [copiedUri, setCopiedUri] = useState(false);

  // Bot token form state (Slack / Telegram)
  const [authTab, setAuthTab] = useState<'oauth' | 'token'>('oauth');
  const [botToken, setBotToken] = useState('');
  const [slackChannel, setSlackChannel] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');

  useEffect(() => {
    if (!isOpen || !entry) return;
    setError(null);
    setStatusMessage(null);
    setOauthSetupInfo(null);
    setBotToken('');
    setSlackChannel('');
    setTelegramChatId('');
    if (entry.providerKey === 'telegram_native') {
      setAuthTab('token');
    } else if (
      entry.providerKey === 'slack_native' &&
      !entry.oauthAppConfigured
    ) {
      setAuthTab('token');
    } else {
      setAuthTab('oauth');
    }
  }, [isOpen, entry]);

  // Listen for 3P OAuth popup completion postMessage
  useEffect(() => {
    if (!isOpen) return;
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin || '';
      if (
        origin &&
        !origin.endsWith('.run.app') &&
        !origin.includes('localhost')
      ) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        setStatusMessage(
          event.data.message || 'Authorization verified. Refreshing workspace...'
        );
        void onConnected().then(() => onClose());
      } else if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        setError(
          event.data.message || 'OAuth authorization was cancelled or failed.'
        );
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isOpen, onConnected, onClose]);

  if (!isOpen || !entry) return null;

  const isGoogleWorkspace =
    entry.providerKey === 'gmail_native' ||
    entry.providerKey === 'google_calendar_native' ||
    entry.providerKey === 'google_drive_native';

  const isThirdPartyOAuth =
    entry.providerKey === 'slack_native' ||
    entry.providerKey === 'microsoft_outlook_native' ||
    entry.providerKey === 'microsoft_teams_native';

  const supportsBotToken =
    entry.providerKey === 'slack_native' ||
    entry.providerKey === 'telegram_native';

  const handleGoogleSignIn = async () => {
    if (!isGoogleWorkspace) return;
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const providerKey = entry.providerKey as
        | 'gmail_native'
        | 'google_calendar_native'
        | 'google_drive_native';
      const scopes = WORKSPACE_CONNECTOR_SCOPES[providerKey];
      const popupRes = await connectGoogleWorkspacePopup(scopes);

      await api.connectGoogleNative({
        workspaceId,
        providerKey,
        grantedScopes: popupRes.grantedScopes,
      });

      setStatusMessage(
        `${entry.connectorName} authorized and live API probe succeeded.`
      );
      await onConnected();
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Google Workspace authorization failed.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleThirdPartyOAuth = async () => {
    if (!isThirdPartyOAuth) return;
    setBusy(true);
    setError(null);
    setOauthSetupInfo(null);
    try {
      const providerKey = entry.providerKey as
        | 'slack_native'
        | 'microsoft_outlook_native'
        | 'microsoft_teams_native';
      const res = await api.getThirdPartyOAuthUrl(providerKey, workspaceId);

      if (!res.configured || !res.url) {
        setOauthSetupInfo({
          redirectUri: res.redirectUri,
          missingEnvVars: res.missingEnvVars ?? [],
        });
        return;
      }

      // Open OAuth provider URL directly in popup per iframe security constraints
      const popup = window.open(
        res.url,
        'taskai_oauth_popup',
        'width=600,height=720'
      );
      if (!popup) {
        setError(
          'Browser blocked the authorization popup. Allow popups for this site and click Connect again.'
        );
      } else {
        setStatusMessage(
          'Complete authorization in the provider window. It will close automatically upon verification.'
        );
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to start OAuth authorization.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSaveBotToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supportsBotToken || !botToken.trim()) return;
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const providerKey = entry.providerKey as
        | 'slack_native'
        | 'telegram_native';
      const res = await api.connectNativeBotToken({
        workspaceId,
        providerKey,
        botToken: botToken.trim(),
        displayName: entry.connectorName,
        slackDefaultChannel: slackChannel.trim() || undefined,
        telegramDefaultChatId: telegramChatId.trim() || undefined,
      });

      if (res.testResult && !res.testResult.success) {
        setError(
          `Saved encrypted token, but live verification failed: ${res.testResult.statusDetail}`
        );
        await onConnected();
        return;
      }

      await onConnected();
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to verify Bot Token.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCopyRedirectUri = async (uri: string) => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopiedUri(true);
      window.setTimeout(() => setCopiedUri(false), 1800);
    } catch {
      // ignore clipboard restrictions
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="native-connect-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
    >
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2
              id="native-connect-modal-title"
              className="text-base font-semibold tracking-tight"
            >
              Connect {entry.connectorName}
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {entry.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close native connector dialog"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-900 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Requested Scopes & Permission Notice */}
        <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-200">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>Least-Privilege Permission Scopes</span>
          </div>
          <p className="font-mono text-[11px] text-slate-600 dark:text-slate-400 break-words">
            {entry.authorizationScopes.join(' · ') || 'Scoped API access'}
          </p>
          <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
            Task.ai only accesses data with your explicit permission and pauses
            all mutating actions (drafting emails, booking calendar events,
            writing files, or sending messages) at the Approval Gate for your
            confirmation.
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-800 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {statusMessage && (
          <div className="p-3 rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{statusMessage}</span>
          </div>
        )}

        {/* Dual Auth Mode Switcher for Slack (OAuth 2.0 vs Bot Token) */}
        {entry.providerKey === 'slack_native' && (
          <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-900">
            <button
              type="button"
              onClick={() => setAuthTab('token')}
              className={`flex-1 min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                authTab === 'token'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Slack Bot Token (Instant)
            </button>
            <button
              type="button"
              onClick={() => setAuthTab('oauth')}
              className={`flex-1 min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                authTab === 'oauth'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Slack OAuth 2.0 App
            </button>
          </div>
        )}

        {/* 1. Google Workspace Official Sign-In Flow */}
        {isGoogleWorkspace && (
          <div className="space-y-3 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleGoogleSignIn()}
              className="w-full min-h-[42px] px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 text-sm font-medium inline-flex items-center justify-center gap-3 transition-colors cursor-pointer disabled:opacity-50"
            >
              <GoogleLogoMark />
              <span>
                {busy
                  ? 'Verifying Google Workspace permissions...'
                  : `Sign in with Google to authorize ${entry.connectorName}`}
              </span>
            </button>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 text-center">
              OAuth access tokens remain strictly in browser memory and are
              never written to localStorage or sessionStorage.
            </p>
          </div>
        )}

        {/* 2. Third-Party OAuth 2.0 Flow (Microsoft / Slack OAuth) */}
        {isThirdPartyOAuth && authTab === 'oauth' && (
          <div className="space-y-4 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleThirdPartyOAuth()}
              className="w-full min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white text-white dark:text-slate-950 inline-flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>
                {busy
                  ? 'Checking OAuth configuration...'
                  : `Authorize ${entry.connectorName} via OAuth 2.0`}
              </span>
            </button>

            {oauthSetupInfo && (
              <div className="p-4 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 space-y-2.5 text-xs text-amber-950 dark:text-amber-200">
                <p className="font-semibold">
                  Server OAuth App Credentials Required
                </p>
                <p className="leading-relaxed text-amber-900/90 dark:text-amber-200/80">
                  Task.ai never displays unconfigured OAuth apps as connected.
                  Configure these server environment variables in AI Studio to
                  enable 3P OAuth popup sign-in:
                </p>
                <p className="font-mono text-[11px]">
                  {oauthSetupInfo.missingEnvVars.join(' · ')}
                </p>
                <div className="space-y-1 pt-1">
                  <span className="text-[11px] font-medium block">
                    Authorized Redirect Callback URL:
                  </span>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-950 border border-amber-200 dark:border-amber-800 font-mono text-[11px] break-all">
                      {oauthSetupInfo.redirectUri}
                    </code>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopyRedirectUri(oauthSetupInfo.redirectUri)
                      }
                      aria-label="Copy OAuth redirect callback URL"
                      className="min-h-[34px] px-2.5 py-1.5 rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-900 text-xs font-medium inline-flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>{copiedUri ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 3. Native Encrypted Bot Token Flow (Slack / Telegram) */}
        {supportsBotToken && authTab === 'token' && (
          <form onSubmit={handleSaveBotToken} className="space-y-4 pt-1">
            <div className="space-y-1.5">
              <label
                htmlFor="native-bot-token-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                {entry.providerKey === 'slack_native'
                  ? 'Slack Bot User OAuth Token (xoxb-...)'
                  : 'Telegram Bot API Token (from @BotFather)'}
              </label>
              <input
                id="native-bot-token-input"
                type="password"
                required
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={
                  entry.providerKey === 'slack_native'
                    ? 'xoxb-your-workspace-bot-token'
                    : '123456789:ABCdefGHIjklMNOpqrsTUVwxyz'
                }
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-mono"
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                <KeyRound className="w-3 h-3 shrink-0" />
                <span>
                  Encrypted at rest with AES-256-GCM and tested immediately
                  against the live provider API.
                </span>
              </p>
            </div>

            {entry.providerKey === 'slack_native' ? (
              <div className="space-y-1.5">
                <label
                  htmlFor="native-slack-channel"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Default Channel ID or Name (Optional)
                </label>
                <input
                  id="native-slack-channel"
                  type="text"
                  value={slackChannel}
                  onChange={(e) => setSlackChannel(e.target.value)}
                  placeholder="e.g., C0123456789 or #customer-support"
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <label
                  htmlFor="native-telegram-chat-id"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Default Telegram Chat ID (Optional)
                </label>
                <input
                  id="native-telegram-chat-id"
                  type="text"
                  value={telegramChatId}
                  onChange={(e) => setTelegramChatId(e.target.value)}
                  placeholder="e.g., -1001234567890"
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-mono"
                />
              </div>
            )}

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
                disabled={busy || !botToken.trim()}
                className="min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white text-white dark:text-slate-950 transition-colors cursor-pointer disabled:opacity-50"
              >
                {busy ? 'Verifying Live API...' : 'Save & Verify Connection'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
