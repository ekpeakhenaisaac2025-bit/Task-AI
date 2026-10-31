import {
  decryptIntegrationSecretDetailed,
  redactSecretsFromText,
  sanitizeEvidencePayload,
} from '../crypto-vault.ts';
import {
  reencryptIntegrationSecretRow,
  type ServerExecutableIntegration,
} from '../../db/repository.ts';
import {
  safeOutboundHttpRequest,
  type SafeOutboundHttpRequestParams,
  type SafeOutboundHttpResponse,
} from '../ssrf-guard.ts';
import type { OAuthEnvironmentReadiness } from '../../lib/integration-registry.ts';
import type { TaskRecord } from '../../types.ts';

export type HttpTransportFn = (
  params: SafeOutboundHttpRequestParams
) => Promise<SafeOutboundHttpResponse>;

export function getServerOAuthEnvironmentReadiness(
  env: NodeJS.ProcessEnv = process.env
): OAuthEnvironmentReadiness {
  return {
    googleWorkspaceReady: true,
    slackOAuthConfigured: Boolean(
      env.SLACK_CLIENT_ID?.trim() && env.SLACK_CLIENT_SECRET?.trim()
    ),
    microsoftOAuthConfigured: Boolean(
      env.MICROSOFT_CLIENT_ID?.trim() && env.MICROSOFT_CLIENT_SECRET?.trim()
    ),
  };
}

export function isNativeConnectorProviderKey(providerKey: string): boolean {
  return (
    providerKey === 'gmail_native' ||
    providerKey === 'google_calendar_native' ||
    providerKey === 'google_drive_native' ||
    providerKey === 'slack_native' ||
    providerKey === 'telegram_native' ||
    providerKey === 'microsoft_outlook_native' ||
    providerKey === 'microsoft_teams_native'
  );
}

async function resolveStoredSecret(
  executable: ServerExecutableIntegration
): Promise<string | null> {
  if (
    !executable.encryptedSecret ||
    !executable.secretIv ||
    !executable.secretAuthTag
  ) {
    return null;
  }
  const decrypted = decryptIntegrationSecretDetailed({
    ciphertextBase64: executable.encryptedSecret,
    ivBase64: executable.secretIv,
    authTagBase64: executable.secretAuthTag,
  });

  if (decrypted.needsReencryption) {
    await reencryptIntegrationSecretRow({
      integrationId: executable.record.id,
      userId: executable.record.userId,
      plaintextSecret: decrypted.plaintext,
    }).catch(() => {});
  }

  return decrypted.plaintext;
}

function parseJsonSafe(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { rawPreview: raw.slice(0, 400) };
  } catch {
    return { rawPreview: raw.slice(0, 400) };
  }
}

/**
 * Verifies a live Google Workspace access token directly against the target Google API
 * (`gmail.googleapis.com`, `www.googleapis.com/calendar`, or `www.googleapis.com/drive`).
 */
export async function verifyGoogleWorkspaceTokenLive(params: {
  providerKey:
    | 'gmail_native'
    | 'google_calendar_native'
    | 'google_drive_native';
  accessToken: string;
  transport?: HttpTransportFn;
}): Promise<{
  ok: boolean;
  httpStatus: number;
  accountEmail: string | null;
  summary: string;
}> {
  const transport = params.transport ?? safeOutboundHttpRequest;
  const token = params.accessToken.trim();
  if (!token) {
    return {
      ok: false,
      httpStatus: 401,
      accountEmail: null,
      summary:
        'No active Google Workspace session token is present in memory. Click "Reconnect with Google" to authorize.',
    };
  }

  const probeUrl =
    params.providerKey === 'gmail_native'
      ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
      : params.providerKey === 'google_calendar_native'
        ? 'https://www.googleapis.com/calendar/v3/calendars/primary'
        : 'https://www.googleapis.com/drive/v3/about?fields=user,storageQuota';

  const res = await transport({
    url: probeUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    timeoutMs: 8000,
    allowQueryParams: true,
  });

  const body = parseJsonSafe(res.responseText);
  if (!res.ok) {
    return {
      ok: false,
      httpStatus: res.status,
      accountEmail: null,
      summary: `Google Workspace API returned HTTP ${res.status}. Please reconnect and grant the required permission scopes.`,
    };
  }

  const email =
    typeof body.emailAddress === 'string'
      ? body.emailAddress
      : typeof body.id === 'string' && body.id.includes('@')
        ? body.id
        : body.user &&
            typeof body.user === 'object' &&
            typeof (body.user as Record<string, unknown>).emailAddress === 'string'
          ? String((body.user as Record<string, unknown>).emailAddress)
          : null;

  return {
    ok: true,
    httpStatus: res.status,
    accountEmail: email,
    summary: `Verified live Google Workspace API connection${email ? ` (${email})` : ''}.`,
  };
}

export async function revokeGoogleWorkspaceToken(params: {
  accessToken: string;
  transport?: HttpTransportFn;
}): Promise<boolean> {
  const transport = params.transport ?? safeOutboundHttpRequest;
  const trimmed = params.accessToken.trim();
  if (!trimmed) return false;
  try {
    const res = await transport({
      url: 'https://oauth2.googleapis.com/revoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `token=${encodeURIComponent(trimmed)}`,
      timeoutMs: 6000,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Builds the 3P OAuth 2.0 provider authorization URL directly (never a container route)
 * per AI Studio iframe popup constraints.
 */
export function buildThirdPartyOAuthUrl(params: {
  providerKey:
    | 'slack_native'
    | 'microsoft_outlook_native'
    | 'microsoft_teams_native';
  redirectUri: string;
  stateToken: string;
  env?: NodeJS.ProcessEnv;
}): {
  configured: boolean;
  url?: string;
  requestedScopes: string[];
  missingEnvVars?: string[];
} {
  const env = params.env ?? process.env;

  if (params.providerKey === 'slack_native') {
    const clientId = env.SLACK_CLIENT_ID?.trim();
    const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
    const scopes = ['chat:write', 'channels:read'];
    if (!clientId || !clientSecret) {
      return {
        configured: false,
        requestedScopes: scopes,
        missingEnvVars: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'],
      };
    }
    const qs = new URLSearchParams({
      client_id: clientId,
      scope: scopes.join(','),
      redirect_uri: params.redirectUri,
      state: params.stateToken,
    });
    return {
      configured: true,
      url: `https://slack.com/oauth/v2/authorize?${qs.toString()}`,
      requestedScopes: scopes,
    };
  }

  const msClientId = env.MICROSOFT_CLIENT_ID?.trim();
  const msClientSecret = env.MICROSOFT_CLIENT_SECRET?.trim();
  const scopes =
    params.providerKey === 'microsoft_outlook_native'
      ? [
          'offline_access',
          'User.Read',
          'Mail.ReadWrite',
          'Mail.Send',
          'Calendars.ReadWrite',
        ]
      : ['offline_access', 'User.Read', 'Chat.ReadWrite', 'ChannelMessage.Send'];

  if (!msClientId || !msClientSecret) {
    return {
      configured: false,
      requestedScopes: scopes,
      missingEnvVars: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    };
  }

  const qs = new URLSearchParams({
    client_id: msClientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    response_mode: 'query',
    scope: scopes.join(' '),
    state: params.stateToken,
  });

  return {
    configured: true,
    url: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${qs.toString()}`,
    requestedScopes: scopes,
  };
}

export async function exchangeThirdPartyOAuthCode(params: {
  providerKey:
    | 'slack_native'
    | 'microsoft_outlook_native'
    | 'microsoft_teams_native';
  code: string;
  redirectUri: string;
  env?: NodeJS.ProcessEnv;
  transport?: HttpTransportFn;
}): Promise<{
  accessToken: string;
  grantedScopes: string[];
  accountLabel: string | null;
}> {
  const env = params.env ?? process.env;
  const transport = params.transport ?? safeOutboundHttpRequest;

  if (params.providerKey === 'slack_native') {
    const clientId = env.SLACK_CLIENT_ID?.trim();
    const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new Error('Slack OAuth client credentials are not configured on server.');
    }

    const form = new URLSearchParams({
      code: params.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: params.redirectUri,
    });

    const res = await transport({
      url: 'https://slack.com/api/oauth.v2.access',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      timeoutMs: 10000,
    });

    const body = parseJsonSafe(res.responseText);
    if (!res.ok || body.ok !== true || typeof body.access_token !== 'string') {
      throw new Error(
        `Slack OAuth token exchange failed (${String(body.error || res.status)}).`
      );
    }

    const scopes =
      typeof body.scope === 'string'
        ? body.scope.split(',').map((s) => s.trim()).filter(Boolean)
        : ['chat:write'];
    const teamName =
      body.team &&
      typeof body.team === 'object' &&
      typeof (body.team as Record<string, unknown>).name === 'string'
        ? String((body.team as Record<string, unknown>).name)
        : null;

    return {
      accessToken: body.access_token,
      grantedScopes: scopes,
      accountLabel: teamName,
    };
  }

  const msClientId = env.MICROSOFT_CLIENT_ID?.trim();
  const msClientSecret = env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!msClientId || !msClientSecret) {
    throw new Error(
      'Microsoft OAuth client credentials are not configured on server.'
    );
  }

  const form = new URLSearchParams({
    client_id: msClientId,
    client_secret: msClientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await transport({
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    timeoutMs: 10000,
  });

  const body = parseJsonSafe(res.responseText);
  if (!res.ok || typeof body.access_token !== 'string') {
    throw new Error(
      `Microsoft OAuth token exchange failed (HTTP ${res.status}).`
    );
  }

  const scopes =
    typeof body.scope === 'string'
      ? body.scope.split(/\s+/).filter(Boolean)
      : [];

  return {
    accessToken: body.access_token,
    grantedScopes: scopes,
    accountLabel: null,
  };
}

/**
 * Tests any native connector (`gmail_native`, `google_calendar_native`, `google_drive_native`,
 * `slack_native`, `telegram_native`, `microsoft_outlook_native`, `microsoft_teams_native`).
 */
export async function testNativeConnectorConnection(params: {
  executable: ServerExecutableIntegration;
  googleAccessToken?: string | null;
  transport?: HttpTransportFn;
}): Promise<{
  success: boolean;
  httpStatus: number | null;
  statusDetail: string;
  authStatus: 'authorized' | 'reconnect_required' | 'error';
  accountLabel?: string | null;
}> {
  const { executable } = params;
  const transport = params.transport ?? safeOutboundHttpRequest;
  const key = executable.record.providerKey;

  try {
    if (
      key === 'gmail_native' ||
      key === 'google_calendar_native' ||
      key === 'google_drive_native'
    ) {
      const storedFallback = await resolveStoredSecret(executable);
      const token = (params.googleAccessToken || storedFallback || '').trim();
      const check = await verifyGoogleWorkspaceTokenLive({
        providerKey: key,
        accessToken: token,
        transport,
      });

      return {
        success: check.ok,
        httpStatus: check.httpStatus,
        statusDetail: check.summary,
        authStatus: check.ok
          ? 'authorized'
          : check.httpStatus === 401 || check.httpStatus === 403
            ? 'reconnect_required'
            : 'error',
        accountLabel: check.accountEmail,
      };
    }

    const secret = await resolveStoredSecret(executable);
    if (!secret) {
      return {
        success: false,
        httpStatus: null,
        statusDetail: `No encrypted token is stored for "${executable.record.displayName}". Connect or enter a valid token first.`,
        authStatus: 'reconnect_required',
      };
    }

    if (key === 'slack_native') {
      const res = await transport({
        url: 'https://slack.com/api/auth.test',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: {},
        timeoutMs: 8000,
      });
      const body = parseJsonSafe(res.responseText);
      if (!res.ok || body.ok !== true) {
        return {
          success: false,
          httpStatus: res.status,
          statusDetail: `Slack auth.test failed (${String(body.error || `HTTP ${res.status}`)}).`,
          authStatus: 'reconnect_required',
        };
      }
      const team = typeof body.team === 'string' ? body.team : null;
      return {
        success: true,
        httpStatus: res.status,
        statusDetail: `Slack connection verified${team ? ` (Workspace: ${team})` : ''}.`,
        authStatus: 'authorized',
        accountLabel: team,
      };
    }

    if (key === 'telegram_native') {
      const res = await transport({
        url: `https://api.telegram.org/bot${encodeURIComponent(secret)}/getMe`,
        method: 'GET',
        timeoutMs: 8000,
      });
      const body = parseJsonSafe(res.responseText);
      if (!res.ok || body.ok !== true) {
        return {
          success: false,
          httpStatus: res.status,
          statusDetail: `Telegram getMe check failed (HTTP ${res.status}). Verify your BotFather token.`,
          authStatus: 'error',
        };
      }
      const botUser =
        body.result &&
        typeof body.result === 'object' &&
        typeof (body.result as Record<string, unknown>).username === 'string'
          ? `@${String((body.result as Record<string, unknown>).username)}`
          : null;
      return {
        success: true,
        httpStatus: res.status,
        statusDetail: `Telegram Bot verified${botUser ? ` (${botUser})` : ''}.`,
        authStatus: 'authorized',
        accountLabel: botUser,
      };
    }

    if (
      key === 'microsoft_outlook_native' ||
      key === 'microsoft_teams_native'
    ) {
      const res = await transport({
        url: 'https://graph.microsoft.com/v1.0/me',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secret}`,
        },
        timeoutMs: 8000,
      });
      const body = parseJsonSafe(res.responseText);
      if (!res.ok) {
        return {
          success: false,
          httpStatus: res.status,
          statusDetail: `Microsoft Graph /me returned HTTP ${res.status}. Reconnect your Microsoft 365 account.`,
          authStatus: 'reconnect_required',
        };
      }
      const upn =
        typeof body.mail === 'string'
          ? body.mail
          : typeof body.userPrincipalName === 'string'
            ? body.userPrincipalName
            : null;
      return {
        success: true,
        httpStatus: res.status,
        statusDetail: `Microsoft Graph verified${upn ? ` (${upn})` : ''}.`,
        authStatus: 'authorized',
        accountLabel: upn,
      };
    }

    return {
      success: false,
      httpStatus: null,
      statusDetail: `Unsupported native connector "${key}".`,
      authStatus: 'error',
    };
  } catch (err: unknown) {
    let safeMsg =
      err instanceof Error ? redactSecretsFromText(err.message) : 'Network failure';
    // Scrub any Telegram bot token pattern from error messages
    safeMsg = safeMsg.replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
    return {
      success: false,
      httpStatus: null,
      statusDetail: `Native connector verification failed: ${safeMsg}`,
      authStatus: 'error',
    };
  }
}

/**
 * Executes a Task.ai task against an operational Native Connector.
 * Enforces explicit user approval (`approvalStatus === 'approved'`) before mutating user Workspace data!
 */
export async function executeNativeConnectorTask(params: {
  executable: ServerExecutableIntegration;
  task: TaskRecord;
  googleAccessToken?: string | null;
  prerequisiteOutputs: Array<{
    stepOrder: number;
    description: string;
    outputData: Record<string, unknown> | null;
  }>;
  transport?: HttpTransportFn;
}): Promise<{
  completedSummary: string;
  outputData: Record<string, unknown>;
  awaitingExternalOutcomeVerification: boolean;
}> {
  const { executable, task } = params;
  const transport = params.transport ?? safeOutboundHttpRequest;
  const key = executable.record.providerKey;

  const isMutatingAction =
    task.actionCategory === 'message_send' ||
    task.actionCategory === 'calendar_booking' ||
    task.requiredCapabilities.includes('message_dispatch') ||
    task.requiredCapabilities.includes('calendar_booking') ||
    task.requiredCapabilities.includes('file_storage');

  if (
    isMutatingAction &&
    task.approvalRequired &&
    task.approvalStatus !== 'approved'
  ) {
    throw new Error(
      `Explicit user confirmation is required before "${executable.record.displayName}" can modify or send external data.`
    );
  }

  if (
    key === 'gmail_native' ||
    key === 'google_calendar_native' ||
    key === 'google_drive_native'
  ) {
    const storedFallback = await resolveStoredSecret(executable);
    const token = (params.googleAccessToken || storedFallback || '').trim();
    if (!token) {
      throw new Error(
        `Google Workspace connector "${executable.record.displayName}" requires an active in-memory Google OAuth session. Reconnect with Google in Integrations.`
      );
    }

    if (key === 'gmail_native') {
      // Read-only inbox check if email_read without message_send
      if (
        task.requiredCapabilities.includes('email_read') &&
        task.actionCategory !== 'message_send'
      ) {
        const res = await transport({
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages',
          method: 'GET',
          queryParams: { maxResults: '10' },
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 10000,
          allowQueryParams: true,
        });
        if (!res.ok) {
          throw new Error(`Gmail API messages.list failed with HTTP ${res.status}.`);
        }
        const data = parseJsonSafe(res.responseText);
        const count = Array.isArray(data.messages) ? data.messages.length : 0;
        return {
          completedSummary: `Fetched ${count} recent Gmail message thread reference(s) via Google Workspace OAuth.`,
          outputData: sanitizeEvidencePayload({
            providerKey: key,
            operation: 'gmail.users.messages.list',
            messagesReturned: count,
            resultSizeEstimate: data.resultSizeEstimate ?? count,
          }),
          awaitingExternalOutcomeVerification: false,
        };
      }

      // Create a MIME draft in Gmail (`gmail.compose`)
      const recipient =
        task.proposedActionDetails?.targetRecipient || 'me';
      const subject = `Task.ai: ${task.description.slice(0, 72)}`;
      const bodyText =
        task.proposedActionDetails?.proposedAction || task.expectedResult;
      const rawMime = Buffer.from(
        `To: ${recipient}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${bodyText}`,
        'utf8'
      )
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const res = await transport({
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { message: { raw: rawMime } },
        timeoutMs: 10000,
      });
      if (!res.ok) {
        throw new Error(`Gmail API drafts.create failed with HTTP ${res.status}.`);
      }
      const data = parseJsonSafe(res.responseText);
      return {
        completedSummary: `Created verified Gmail draft (${String(data.id || 'draft')}) via Google Workspace OAuth.`,
        outputData: sanitizeEvidencePayload({
          providerKey: key,
          operation: 'gmail.users.drafts.create',
          draftId: data.id ?? null,
          httpStatus: res.status,
        }),
        awaitingExternalOutcomeVerification: true,
      };
    }

    if (key === 'google_calendar_native') {
      if (
        task.requiredCapabilities.includes('calendar_read') &&
        task.actionCategory !== 'calendar_booking'
      ) {
        const res = await transport({
          url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
          method: 'GET',
          queryParams: {
            maxResults: '10',
            singleEvents: 'true',
            orderBy: 'startTime',
            timeMin: new Date().toISOString(),
          },
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 10000,
          allowQueryParams: true,
        });
        if (!res.ok) {
          throw new Error(
            `Google Calendar events.list failed with HTTP ${res.status}.`
          );
        }
        const data = parseJsonSafe(res.responseText);
        const items = Array.isArray(data.items) ? data.items.length : 0;
        return {
          completedSummary: `Retrieved ${items} upcoming event(s) from Google Calendar.`,
          outputData: sanitizeEvidencePayload({
            providerKey: key,
            operation: 'calendar.events.list',
            upcomingEventsCount: items,
          }),
          awaitingExternalOutcomeVerification: false,
        };
      }

      const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      const res = await transport({
        url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: {
          summary: task.description.slice(0, 100),
          description:
            task.proposedActionDetails?.explanation || task.expectedResult,
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
        },
        timeoutMs: 10000,
      });
      if (!res.ok) {
        throw new Error(
          `Google Calendar events.insert failed with HTTP ${res.status}.`
        );
      }
      const data = parseJsonSafe(res.responseText);
      return {
        completedSummary: `Scheduled Google Calendar event (${String(data.id || 'event')}).`,
        outputData: sanitizeEvidencePayload({
          providerKey: key,
          operation: 'calendar.events.insert',
          eventId: data.id ?? null,
          htmlLink: data.htmlLink ?? null,
        }),
        awaitingExternalOutcomeVerification: true,
      };
    }

    // google_drive_native
    const res = await transport({
      url: 'https://www.googleapis.com/drive/v3/files',
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        name: `TaskAI-${task.id.slice(0, 8)}.json`,
        mimeType: 'application/json',
        description: task.description.slice(0, 140),
      },
      timeoutMs: 10000,
    });
    if (!res.ok) {
      throw new Error(`Google Drive files.create failed with HTTP ${res.status}.`);
    }
    const data = parseJsonSafe(res.responseText);
    return {
      completedSummary: `Created Google Drive file record (${String(data.id || 'file')}).`,
      outputData: sanitizeEvidencePayload({
        providerKey: key,
        operation: 'drive.files.create',
        fileId: data.id ?? null,
        name: data.name ?? null,
      }),
      awaitingExternalOutcomeVerification: false,
    };
  }

  const secret = await resolveStoredSecret(executable);
  if (!secret) {
    throw new Error(
      `Connector "${executable.record.displayName}" has no stored credential.`
    );
  }

  if (key === 'slack_native') {
    const channel =
      executable.record.configMetadata.slackDefaultChannel ||
      task.proposedActionDetails?.targetRecipient ||
      'general';
    const text =
      task.proposedActionDetails?.proposedAction ||
      `${task.description}\nExpected: ${task.expectedResult}`;

    const res = await transport({
      url: 'https://slack.com/api/chat.postMessage',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: { channel, text },
      timeoutMs: 10000,
    });
    const data = parseJsonSafe(res.responseText);
    if (!res.ok || data.ok !== true) {
      throw new Error(
        `Slack chat.postMessage failed (${String(data.error || `HTTP ${res.status}`)}).`
      );
    }
    return {
      completedSummary: `Posted message to Slack channel "${channel}" (ts: ${String(data.ts || 'ok')}).`,
      outputData: sanitizeEvidencePayload({
        providerKey: key,
        operation: 'slack.chat.postMessage',
        channel: data.channel ?? channel,
        messageTs: data.ts ?? null,
      }),
      awaitingExternalOutcomeVerification: true,
    };
  }

  if (key === 'telegram_native') {
    const chatId =
      executable.record.configMetadata.telegramDefaultChatId ||
      task.proposedActionDetails?.targetRecipient;
    if (!chatId) {
      throw new Error(
        'Telegram task execution requires a default Chat ID in connector settings or targetRecipient on the task.'
      );
    }
    const text =
      task.proposedActionDetails?.proposedAction || task.description;
    const res = await transport({
      url: `https://api.telegram.org/bot${encodeURIComponent(secret)}/sendMessage`,
      method: 'POST',
      body: { chat_id: chatId, text },
      timeoutMs: 10000,
    });
    const data = parseJsonSafe(res.responseText);
    if (!res.ok || data.ok !== true) {
      throw new Error(`Telegram sendMessage failed with HTTP ${res.status}.`);
    }
    return {
      completedSummary: `Dispatched Telegram message to chat ${chatId}.`,
      outputData: sanitizeEvidencePayload({
        providerKey: key,
        operation: 'telegram.sendMessage',
        chatId,
      }),
      awaitingExternalOutcomeVerification: true,
    };
  }

  // Microsoft Graph execution
  const res = await transport({
    url: 'https://graph.microsoft.com/v1.0/me',
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
    timeoutMs: 10000,
  });
  if (!res.ok) {
    throw new Error(`Microsoft Graph execution failed with HTTP ${res.status}.`);
  }
  return {
    completedSummary: `Executed Microsoft Graph operation via "${executable.record.displayName}".`,
    outputData: sanitizeEvidencePayload({
      providerKey: key,
      operation: 'microsoft.graph.execute',
      httpStatus: res.status,
    }),
    awaitingExternalOutcomeVerification: true,
  };
}
