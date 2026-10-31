import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractInitialFirebaseIdToken,
  formatClientAuthError,
  isFirebaseTokenServiceDisabledError,
} from './auth-errors';
import {
  createSignedIsolatedToken,
  createSignedSessionToken,
  verifySignedSessionToken,
} from '../middleware/auth';

function makeTestEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    SESSION_HMAC_SECRET: crypto.randomBytes(32).toString('hex'),
    INTEGRATION_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  };
}

test('isFirebaseTokenServiceDisabledError detects disabled securetoken.googleapis.com STS error', () => {
  const stsError = Object.assign(
    new Error(
      'Firebase: Error (auth/token-service-api-has-not-been-used-in-project-636338969072-before-or-it-is-disabled.-enable-it-by-visiting-https://console.developers.google.com/apis/api/securetoken.googleapis.com/overview?project=636338969072-then-retry.-if-you-enabled-this-api-recently,-wait-a-few-minutes-for-the-action-to-propagate-to-our-systems-and-retry.).'
    ),
    {
      code: 'auth/token-service-api-has-not-been-used-in-project-636338969072-before-or-it-is-disabled.',
    }
  );

  assert.equal(isFirebaseTokenServiceDisabledError(stsError), true);

  const formatted = formatClientAuthError(stsError);
  assert.equal(formatted.cancelled, false);
  assert.equal(formatted.suggestIsolatedFallback, true);
  assert.match(formatted.message, /securetoken\.googleapis\.com/i);
  assert.match(formatted.message, /Isolated Workspace/i);
});

test('formatClientAuthError suppresses user-cancelled popups and formats blocked popups cleanly', () => {
  const closedErr = Object.assign(
    new Error('Firebase: Error (auth/popup-closed-by-user).'),
    { code: 'auth/popup-closed-by-user' }
  );
  const formattedClosed = formatClientAuthError(closedErr);
  assert.equal(formattedClosed.cancelled, true);
  assert.equal(formattedClosed.message, '');

  const blockedErr = Object.assign(
    new Error('Firebase: Error (auth/popup-blocked).'),
    { code: 'auth/popup-blocked' }
  );
  const formattedBlocked = formatClientAuthError(blockedErr);
  assert.equal(formattedBlocked.cancelled, false);
  assert.equal(formattedBlocked.suggestIsolatedFallback, true);
  assert.match(formattedBlocked.message, /popup was blocked/i);
});

test('extractInitialFirebaseIdToken falls back to _tokenResponse.idToken when STS refresh is disabled', async () => {
  const tokenFromSts = await extractInitialFirebaseIdToken({
    user: {
      getIdToken: async () => 'fresh-jwt-from-sts',
    },
    _tokenResponse: {
      idToken: 'fallback-jwt-from-idp',
    },
  });
  assert.equal(tokenFromSts, 'fresh-jwt-from-sts');

  const tokenFromFallback = await extractInitialFirebaseIdToken({
    user: {
      getIdToken: async () => {
        throw new Error(
          'Firebase: Error (auth/token-service-api-has-not-been-used-in-project-636338969072).'
        );
      },
    },
    _tokenResponse: {
      idToken: 'initial-idp-jwt-token',
    },
  });
  assert.equal(tokenFromFallback, 'initial-idp-jwt-token');

  await assert.rejects(
    () =>
      extractInitialFirebaseIdToken({
        user: {
          getIdToken: async () => {
            throw new Error('STS failed with no _tokenResponse');
          },
        },
      }),
    /STS failed/
  );
});

test('createSignedSessionToken and verifySignedSessionToken verify Google and legacy isolated sessions and reject expired/tampered tokens', () => {
  const env = makeTestEnv();
  const baseNow = 1_760_000_000_000;

  const googleToken = createSignedSessionToken(
    {
      uid: 'google-uid-998877',
      email: 'founder@company.io',
      authMode: 'google',
      maxAgeMs: 60_000,
      nowMs: baseNow,
    },
    env
  );

  const verifiedGoogle = verifySignedSessionToken(
    googleToken,
    env,
    undefined,
    baseNow + 30_000
  );
  assert.deepEqual(verifiedGoogle, {
    uid: 'google-uid-998877',
    email: 'founder@company.io',
    authMode: 'google',
  });

  // Expired token rejected
  assert.equal(
    verifySignedSessionToken(googleToken, env, undefined, baseNow + 60_001),
    null
  );

  // Tampered signature rejected
  const tampered = `${googleToken.slice(0, -2)}zz`;
  assert.equal(
    verifySignedSessionToken(tampered, env, undefined, baseNow + 1_000),
    null
  );

  // Backwards-compatible legacy iso.* token verification
  const legacyIsoToken = createSignedIsolatedToken(
    'iso_aabbccddeeff0011',
    'workspace-aabbcc@isolated.task.ai',
    env
  );
  assert.deepEqual(verifySignedSessionToken(legacyIsoToken, env), {
    uid: 'iso_aabbccddeeff0011',
    email: 'workspace-aabbcc@isolated.task.ai',
    authMode: 'isolated_session',
  });
});
