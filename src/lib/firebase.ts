import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserPopupRedirectResolver,
  getAuth,
  GoogleAuthProvider,
  initializeAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Auth,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const googleAuthProvider = new GoogleAuthProvider();

export const GOOGLE_WORKSPACE_SCOPES = {
  gmailReadonly: 'https://www.googleapis.com/auth/gmail.readonly',
  gmailCompose: 'https://www.googleapis.com/auth/gmail.compose',
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
  driveFile: 'https://www.googleapis.com/auth/drive.file',
} as const;

export const WORKSPACE_CONNECTOR_SCOPES: Record<
  'gmail_native' | 'google_calendar_native' | 'google_drive_native',
  string[]
> = {
  gmail_native: [
    GOOGLE_WORKSPACE_SCOPES.gmailReadonly,
    GOOGLE_WORKSPACE_SCOPES.gmailCompose,
  ],
  google_calendar_native: [GOOGLE_WORKSPACE_SCOPES.calendarEvents],
  google_drive_native: [GOOGLE_WORKSPACE_SCOPES.driveFile],
};

let cachedAuthInstance: Auth | null = null;
let legacyPersistencePurged = false;
let authListenerBound = false;
let isSigningInWorkspacePopup = false;

// Strictly in-memory Google Workspace OAuth access token cache (NEVER persisted to Web Storage)
let cachedGoogleWorkspaceAccessToken: string | null = null;
let cachedGoogleWorkspaceScopes = new Set<string>();
let cachedGoogleWorkspaceEmail: string | null = null;

/**
 * Purges legacy browser-persisted Firebase Auth credentials (`firebaseLocalStorageDb`
 * in IndexedDB and `firebase:authUser:*` keys in Web Storage) so expired cached STS
 * tokens never trigger background `securetoken.googleapis.com` refresh errors on boot.
 */
export function purgeLegacyFirebaseAuthPersistence(): void {
  if (legacyPersistencePurged || typeof window === 'undefined') {
    return;
  }
  legacyPersistencePurged = true;

  for (const storage of [
    (() => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    })(),
    (() => {
      try {
        return window.sessionStorage;
      } catch {
        return null;
      }
    })(),
  ]) {
    if (!storage) continue;
    try {
      const keysToDelete: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (
          key &&
          (key.startsWith('firebase:authUser:') ||
            key.startsWith('firebase:host:') ||
            key.startsWith('firebase:previous_websocket_failure'))
        ) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        storage.removeItem(key);
      }
    } catch {
      // Ignore storage restrictions in sandboxed iframes
    }
  }

  try {
    if (
      typeof window.indexedDB !== 'undefined' &&
      typeof window.indexedDB.deleteDatabase === 'function'
    ) {
      window.indexedDB.deleteDatabase('firebaseLocalStorageDb');
    }
  } catch {
    // Ignore IndexedDB restrictions in sandboxed iframes
  }
}

/**
 * Lazily initializes Firebase Auth using strictly in-memory persistence so page load
 * never probes `securetoken.googleapis.com` for stale IndexedDB sessions.
 */
export function getFirebaseAuth(): Auth {
  purgeLegacyFirebaseAuthPersistence();
  if (cachedAuthInstance) {
    return cachedAuthInstance;
  }

  const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  try {
    cachedAuthInstance = initializeAuth(app, {
      persistence: inMemoryPersistence,
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    cachedAuthInstance = getAuth(app);
  }

  if (!authListenerBound && typeof window !== 'undefined') {
    authListenerBound = true;
    onAuthStateChanged(cachedAuthInstance, (user) => {
      if (!user && !isSigningInWorkspacePopup) {
        cachedGoogleWorkspaceAccessToken = null;
        cachedGoogleWorkspaceScopes = new Set<string>();
        cachedGoogleWorkspaceEmail = null;
      }
    });
  }

  return cachedAuthInstance;
}

/**
 * Opens the official Firebase Google OAuth popup requesting the exact Google Workspace
 * scopes needed for the selected native connector(s) (merged with any already granted scopes)
 * and caches the resulting OAuth access token strictly in browser memory.
 */
export async function connectGoogleWorkspacePopup(
  requestedScopes: string[]
): Promise<{
  accessToken: string;
  grantedScopes: string[];
  email: string | null;
}> {
  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'consent' });

  const combinedScopes = new Set<string>([
    ...cachedGoogleWorkspaceScopes,
    ...requestedScopes,
  ]);
  for (const scope of combinedScopes) {
    provider.addScope(scope);
  }

  try {
    isSigningInWorkspacePopup = true;
    const result = await signInWithPopup(
      auth,
      provider,
      browserPopupRedirectResolver
    );
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error(
        'Google Sign-In completed without returning an OAuth access token. Please approve the requested permissions.'
      );
    }

    cachedGoogleWorkspaceAccessToken = credential.accessToken;
    cachedGoogleWorkspaceScopes = combinedScopes;
    cachedGoogleWorkspaceEmail = result.user?.email ?? null;

    return {
      accessToken: credential.accessToken,
      grantedScopes: Array.from(cachedGoogleWorkspaceScopes),
      email: cachedGoogleWorkspaceEmail,
    };
  } finally {
    isSigningInWorkspacePopup = false;
  }
}

export function getGoogleWorkspaceAccessToken(): string | null {
  return cachedGoogleWorkspaceAccessToken;
}

export function getGoogleWorkspaceSessionInfo(): {
  hasLiveToken: boolean;
  grantedScopes: string[];
  email: string | null;
} {
  return {
    hasLiveToken: Boolean(cachedGoogleWorkspaceAccessToken),
    grantedScopes: Array.from(cachedGoogleWorkspaceScopes),
    email: cachedGoogleWorkspaceEmail,
  };
}

export function clearGoogleWorkspaceAccessToken(): void {
  cachedGoogleWorkspaceAccessToken = null;
  cachedGoogleWorkspaceScopes = new Set<string>();
  cachedGoogleWorkspaceEmail = null;
}

export async function signOutFirebaseIfInitialized(): Promise<void> {
  clearGoogleWorkspaceAccessToken();
  if (!cachedAuthInstance) return;
  try {
    await signOut(cachedAuthInstance);
  } catch {
    // Ignore sign-out errors on already invalidated in-memory sessions
  }
}
