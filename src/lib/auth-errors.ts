export interface FormattedAuthError {
  message: string;
  suggestIsolatedFallback: boolean;
  cancelled: boolean;
}

interface FirebaseCredentialLike {
  user?: {
    getIdToken?: (forceRefresh?: boolean) => Promise<string>;
  };
  _tokenResponse?: {
    idToken?: string;
  };
}

export function extractAuthErrorDetails(err: unknown): {
  code: string;
  rawMessage: string;
} {
  if (!err || typeof err !== 'object') {
    return {
      code: '',
      rawMessage: typeof err === 'string' ? err : '',
    };
  }

  const candidate = err as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code.trim() : '';
  const rawMessage =
    typeof candidate.message === 'string' ? candidate.message.trim() : '';

  return { code, rawMessage };
}

export function isFirebaseTokenServiceDisabledError(err: unknown): boolean {
  const { code, rawMessage } = extractAuthErrorDetails(err);
  const combined = `${code} ${rawMessage}`.toLowerCase();

  return (
    combined.includes('token-service-api-has-not-been-used') ||
    combined.includes('securetoken.googleapis.com') ||
    combined.includes('identity-toolkit-api-has-not-been-used') ||
    combined.includes('identitytoolkit.googleapis.com') ||
    combined.includes('api-not-activated')
  );
}

/**
 * Extracts a fresh Firebase ID token immediately after `signInWithPopup`.
 * If `user.getIdToken(false)` fails because `securetoken.googleapis.com` is disabled
 * on the host Cloud project, falls back to the initial `idToken` already issued by
 * `identitytoolkit.googleapis.com` inside `_tokenResponse`.
 */
export async function extractInitialFirebaseIdToken(
  credential: unknown
): Promise<string> {
  const cred = (credential ?? {}) as FirebaseCredentialLike;
  const fallbackToken =
    typeof cred._tokenResponse?.idToken === 'string' &&
    cred._tokenResponse.idToken.trim().length > 0
      ? cred._tokenResponse.idToken.trim()
      : null;

  if (typeof cred.user?.getIdToken === 'function') {
    try {
      const token = await cred.user.getIdToken(false);
      if (typeof token === 'string' && token.trim().length > 0) {
        return token.trim();
      }
    } catch (err) {
      if (fallbackToken) {
        return fallbackToken;
      }
      throw err;
    }
  }

  if (fallbackToken) {
    return fallbackToken;
  }

  throw new Error('Google Sign-In did not return a valid ID token.');
}

export function formatClientAuthError(err: unknown): FormattedAuthError {
  const { code, rawMessage } = extractAuthErrorDetails(err);
  const combined = `${code} ${rawMessage}`.toLowerCase();

  if (
    combined.includes('auth/popup-closed-by-user') ||
    combined.includes('auth/cancelled-popup-request')
  ) {
    return {
      message: '',
      suggestIsolatedFallback: false,
      cancelled: true,
    };
  }

  if (combined.includes('auth/popup-blocked')) {
    return {
      message:
        'The Google Sign-In popup was blocked by your browser. Allow popups for this page or continue in an Isolated Workspace below.',
      suggestIsolatedFallback: true,
      cancelled: false,
    };
  }

  if (isFirebaseTokenServiceDisabledError(err)) {
    return {
      message:
        'Google Sign-In token service (securetoken.googleapis.com) is currently disabled on the host Google Cloud project. Continue in an Isolated Workspace below for immediate access, or enable the Token Service API in Google Cloud Console.',
      suggestIsolatedFallback: true,
      cancelled: false,
    };
  }

  if (
    combined.includes('auth/unauthorized-domain') ||
    combined.includes('auth/operation-not-allowed')
  ) {
    return {
      message:
        'Google Sign-In is not authorized for this domain in the current Firebase configuration. You can continue immediately in an Isolated Workspace below.',
      suggestIsolatedFallback: true,
      cancelled: false,
    };
  }

  if (combined.includes('auth/network-request-failed')) {
    return {
      message:
        'Network error while contacting Google Sign-In. Check your connection or continue in an Isolated Workspace below.',
      suggestIsolatedFallback: true,
      cancelled: false,
    };
  }

  const cleaned = rawMessage
    .replace(/^Firebase:\s*Error\s*\(([^)]+)\)\.?\s*/i, '$1')
    .trim();

  return {
    message: cleaned || 'Google Sign-In could not be completed.',
    suggestIsolatedFallback: true,
    cancelled: false,
  };
}
