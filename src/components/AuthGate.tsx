import React, { useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import { ShieldCheck, Lock, ArrowRight, AlertCircle } from 'lucide-react';
import { getFirebaseAuth, googleAuthProvider } from '../lib/firebase';
import {
  extractInitialFirebaseIdToken,
  formatClientAuthError,
} from '../lib/auth-errors';
import { api } from '../lib/api';
import type { AuthSessionUser } from '../types';

interface AuthGateProps {
  onAuthenticated: (user: AuthSessionUser) => void;
}

export const AuthGate: React.FC<AuthGateProps> = ({ onAuthenticated }) => {
  const [loadingMode, setLoadingMode] = useState<'google' | 'isolated' | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [suggestIsolated, setSuggestIsolated] = useState(false);

  const handleGoogleSignIn = async () => {
    setError(null);
    setSuggestIsolated(false);
    setLoadingMode('google');
    try {
      const auth = getFirebaseAuth();
      const credential = await signInWithPopup(auth, googleAuthProvider);
      const idToken = await extractInitialFirebaseIdToken(credential);
      const { user } = await api.exchangeGoogleSession(idToken);
      onAuthenticated(user);
    } catch (err: unknown) {
      const formatted = formatClientAuthError(err);
      if (!formatted.cancelled) {
        setError(formatted.message);
        setSuggestIsolated(formatted.suggestIsolatedFallback);
      }
    } finally {
      setLoadingMode(null);
    }
  };

  const handleIsolatedSession = async () => {
    setError(null);
    setSuggestIsolated(false);
    setLoadingMode('isolated');
    try {
      const { user } = await api.createIsolatedSession();
      onAuthenticated(user);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Could not initialize isolated session.';
      setError(msg);
    } finally {
      setLoadingMode(null);
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-[#0b0f17] text-slate-900 dark:text-slate-100 flex flex-col justify-between">
      <header className="flex items-center justify-between gap-8 px-6 py-4 bg-white dark:bg-[#0b0f17] border-b border-slate-200 dark:border-slate-800">
        <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0">
          Task.ai
        </span>
        <nav
          aria-label="Product overview"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400"
        >
          <a
            href="#architecture"
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Conversational Execution
          </a>
          <a
            href="#approval-gate"
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Approval Gate
          </a>
          <a
            href="#verification"
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Verification
          </a>
          <a
            href="#isolation"
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Isolation
          </a>
        </nav>
        <div className="shrink-0">
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loadingMode !== null}
            className="px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 bg-slate-900 dark:bg-slate-100 rounded-lg hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Sign in with Google
          </button>
        </div>
      </header>

      <main className="max-w-5xl w-full mx-auto px-6 py-16 grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
        <section className="lg:col-span-7 space-y-6">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Chat-First AI Execution Platform · Evidence-Backed Outcomes
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-white leading-tight">
            Chat to plan, orchestrate, and verify real business tasks.
          </h1>
          <p className="text-base text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
            Ask questions naturally, attach documents or images, generate
            downloadable reports, or dispatch multi-step task plans through a
            gated, evidence-verified execution engine.
          </p>

          <div
            id="architecture"
            className="pt-6 border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-6"
          >
            <div id="approval-gate" className="space-y-1.5">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                01. Mandatory Approval Gate
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                Actions that send messages, call external webhooks, or mutate
                systems pause inline in chat until you explicitly approve them.
              </p>
            </div>
            <div id="verification" className="space-y-1.5">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                02. Honest Outcome Accounting
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                Tasks are never presented as completed without real execution
                and verification evidence. Drafts are never counted as sent.
              </p>
            </div>
            <div id="isolation" className="space-y-1.5 sm:col-span-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                03. Workspace-Scoped Conversations &amp; Artifacts
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                Every conversation thread, downloadable artifact, goal, task,
                and encrypted credential is isolated strictly to your workspace.
              </p>
            </div>
          </div>
        </section>

        <section className="lg:col-span-5 bg-slate-50/70 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 sm:p-8 space-y-6">
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              Open Task.ai
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Sign in with Google for persistent account access, or launch an
              isolated workspace session immediately.
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-sm text-amber-900 dark:text-amber-200 space-y-2"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
              {suggestIsolated && (
                <div className="pl-6">
                  <button
                    type="button"
                    onClick={handleIsolatedSession}
                    disabled={loadingMode !== null}
                    className="text-xs font-semibold text-slate-900 dark:text-white underline cursor-pointer"
                  >
                    Start Isolated Workspace now →
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="space-y-3">
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={loadingMode !== null}
              className="w-full min-h-[44px] px-4 py-2.5 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-sm font-semibold rounded-xl hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 transition-colors flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>
                {loadingMode === 'google'
                  ? 'Signing in with Google...'
                  : 'Sign in with Google'}
              </span>
            </button>

            <button
              type="button"
              onClick={handleIsolatedSession}
              disabled={loadingMode !== null}
              className={`w-full min-h-[44px] px-4 py-2.5 text-sm font-medium rounded-xl disabled:opacity-50 transition-colors flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer ${
                suggestIsolated
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 font-semibold'
                  : 'bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-900'
              }`}
            >
              <span>
                {loadingMode === 'isolated'
                  ? 'Starting Isolated Session...'
                  : 'Continue in Isolated Workspace'}
              </span>
              <ArrowRight className="w-4 h-4 shrink-0" />
            </button>
          </div>

          <div className="pt-4 border-t border-slate-200/80 dark:border-slate-800 flex items-start gap-2.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            <Lock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <span>
              API keys and database credentials remain strictly server-side.
              Each isolated workspace receives a cryptographically signed
              user-scoped session cookie.
            </span>
          </div>
        </section>
      </main>

      <footer className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0b0f17] text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center justify-between gap-4">
        <span>Task.ai Conversational Execution Platform</span>
        <span>Multi-Tenant Workspaces · Server-Side AI Provider Gateway</span>
      </footer>
    </div>
  );
};
