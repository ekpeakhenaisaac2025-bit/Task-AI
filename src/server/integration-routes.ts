import type { Express, RequestHandler } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth.ts';
import {
  createUserIntegration,
  deleteUserIntegration,
  ensureDefaultWorkspaceForUser,
  getExecutableIntegrationForServer,
  getIntegrationByIdForUser,
  getWorkspaceByIdForUser,
  listIntegrationsByUser,
  updateUserIntegration,
} from '../db/repository.ts';
import {
  consumeOAuthStateToken,
  createOAuthStateToken,
  createWorkforceConfigurationRow,
  deleteN8nWorkflowForUser,
  getWorkforceConfigurationByIdForUser,
  listIntegrationActivityLogs,
  listN8nWorkflowsByWorkspace,
  listWorkforceConfigurationsForWorkspace,
  recordIntegrationActivityLog,
  updateWorkforceConfigurationRow,
  upsertN8nWorkflowForIntegration,
} from '../db/integrations-repository.ts';
import {
  buildWorkspaceIntegrationRegistry,
  evaluateWorkspaceCapabilities,
  getCatalogItemForProvider,
} from '../lib/integration-registry.ts';
import {
  analyzeWorkforceRequest,
  evaluateWorkforceReadiness,
} from '../lib/workforce-manager.ts';
import { normalizeCapabilities } from '../lib/domain-rules.ts';
import { isGeminiConfigured } from './gemini.ts';
import { redactSecretsFromText } from './crypto-vault.ts';
import { validateDestinationUrlSync } from './ssrf-guard.ts';
import { testUserIntegrationConnection } from './execution-router.ts';
import {
  buildThirdPartyOAuthUrl,
  exchangeThirdPartyOAuthCode,
  getServerOAuthEnvironmentReadiness,
  revokeGoogleWorkspaceToken,
  verifyGoogleWorkspaceTokenLive,
} from './connectors/native-connectors.ts';
import { discoverN8nInstanceWorkflows } from './connectors/n8n-connector.ts';
import { validateCustomApiConfig } from './connectors/custom-api-connector.ts';
import {
  listWorkspaceAiProviders,
  runAiProviderHealthCheck,
  updateWorkspaceAiProviderSettings,
} from './ai-providers.ts';
import type {
  AiProviderId,
  CapabilityId,
  CustomApiHttpMethod,
  IntegrationAuthType,
  IntegrationProviderKey,
} from '../types.ts';

async function resolveOwnedWorkspace(userId: string, rawWorkspaceId: unknown) {
  if (typeof rawWorkspaceId === 'string' && rawWorkspaceId.trim()) {
    return getWorkspaceByIdForUser(rawWorkspaceId.trim(), userId);
  }
  return ensureDefaultWorkspaceForUser(userId);
}

function resolveOAuthCallbackRedirectUri(reqOrigin?: string): string {
  const configuredAppUrl = process.env.APP_URL?.trim();
  if (
    configuredAppUrl &&
    configuredAppUrl !== 'MY_APP_URL' &&
    configuredAppUrl.startsWith('http')
  ) {
    return `${configuredAppUrl.replace(/\/+$/, '')}/auth/oauth/callback`;
  }
  if (reqOrigin && reqOrigin.startsWith('http')) {
    return `${reqOrigin.replace(/\/+$/, '')}/auth/oauth/callback`;
  }
  return 'http://localhost:3000/auth/oauth/callback';
}

export async function buildEnrichedWorkspaceIntegrationBundle(params: {
  userId: string;
  workspaceId: string;
  hasLiveGoogleToken: boolean;
}) {
  const [
    integrations,
    n8nWorkflows,
    aiProviders,
    activityLogs,
    workforceConfigs,
  ] = await Promise.all([
    listIntegrationsByUser(params.userId, params.workspaceId),
    listN8nWorkflowsByWorkspace({
      userId: params.userId,
      workspaceId: params.workspaceId,
    }),
    listWorkspaceAiProviders({
      userId: params.userId,
      workspaceId: params.workspaceId,
    }),
    listIntegrationActivityLogs({
      userId: params.userId,
      workspaceId: params.workspaceId,
      limit: 35,
    }),
    listWorkforceConfigurationsForWorkspace({
      userId: params.userId,
      workspaceId: params.workspaceId,
    }),
  ]);

  const oauthEnv = getServerOAuthEnvironmentReadiness();
  const registry = buildWorkspaceIntegrationRegistry({
    workspaceId: params.workspaceId,
    geminiReady: isGeminiConfigured(),
    workspaceIntegrations: integrations,
    n8nWorkflows,
    oauthEnv,
    hasLiveGoogleToken: params.hasLiveGoogleToken,
  });

  const capEval = evaluateWorkspaceCapabilities(registry);

  return {
    integrations,
    registry,
    capabilityEntries: capEval.entries,
    capabilityMatrix: capEval.matrix,
    n8nWorkflows,
    aiProviders,
    activityLogs,
    workforceConfigs,
    oauthEnv,
  };
}

export function registerMultiConnectorRoutes(
  app: Express,
  rateLimiter: RequestHandler
): void {
  // 1. Unified Integration Registry & Health Snapshot
  app.get(
    '/api/integrations/registry',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const ws = await resolveOwnedWorkspace(
          req.authUser!.uid,
          req.query.workspaceId
        );
        if (!ws) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const liveGoogleToken = (
          req.header('x-google-access-token') || ''
        ).trim();
        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          hasLiveGoogleToken: Boolean(liveGoogleToken),
        });

        res.json({
          workspaceId: ws.id,
          ...bundle,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to load integration registry.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // 2. Connect / Verify Google Workspace Native Connector (Gmail, Google Calendar, Google Drive)
  app.post(
    '/api/integrations/native/google',
    requireAuth,
    rateLimiter,
    async (req: AuthRequest, res) => {
      try {
        const ws = await resolveOwnedWorkspace(
          req.authUser!.uid,
          req.body?.workspaceId
        );
        if (!ws) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const providerKey = req.body?.providerKey as
          | 'gmail_native'
          | 'google_calendar_native'
          | 'google_drive_native';

        if (
          providerKey !== 'gmail_native' &&
          providerKey !== 'google_calendar_native' &&
          providerKey !== 'google_drive_native'
        ) {
          return res.status(400).json({
            error:
              'providerKey must be gmail_native, google_calendar_native, or google_drive_native.',
          });
        }

        const accessToken = (req.header('x-google-access-token') || '').trim();
        if (!accessToken) {
          return res.status(400).json({
            error:
              'Sign in with Google and grant Workspace permissions first so a live session token is available.',
          });
        }

        const check = await verifyGoogleWorkspaceTokenLive({
          providerKey,
          accessToken,
        });

        if (!check.ok) {
          await recordIntegrationActivityLog({
            userId: req.authUser!.uid,
            workspaceId: ws.id,
            providerKey,
            operation: 'oauth_authorize',
            direction: 'auth',
            status: 'error',
            httpStatus: check.httpStatus,
            summary: check.summary,
            errorMessage: check.summary,
          }).catch(() => {});
          return res.status(400).json({ error: check.summary });
        }

        const cat = getCatalogItemForProvider(providerKey)!;
        const grantedScopes = Array.isArray(req.body?.grantedScopes)
          ? req.body.grantedScopes.map((s: unknown) => String(s))
          : cat.defaultScopes;

        const existingList = await listIntegrationsByUser(
          req.authUser!.uid,
          ws.id
        );
        const existing = existingList.find(
          (i) => i.providerKey === providerKey
        );

        let saved;
        if (existing) {
          saved = await updateUserIntegration({
            integrationId: existing.id,
            userId: req.authUser!.uid,
            displayName: cat.name,
            enabled: true,
            verified: true,
            authStatus: 'authorized',
            grantedScopes,
            healthStatus: 'healthy',
            statusDetail: check.summary,
            lastErrorMessage: null,
            configMetadata: {
              ...existing.configMetadata,
              authType: 'google_workspace_oauth',
              nativeAccountEmail: check.accountEmail ?? undefined,
            },
          });
        } else {
          saved = await createUserIntegration({
            userId: req.authUser!.uid,
            workspaceId: ws.id,
            providerKey,
            displayName: cat.name,
            connectionMode: 'user_owned',
            connectorType: 'native_oauth',
            connectorCategory: 'connected_apps',
            authStatus: 'authorized',
            grantedScopes,
            healthStatus: 'healthy',
            verified: true,
            statusDetail: check.summary,
            capabilities: [...cat.capabilities],
            configMetadata: {
              authType: 'google_workspace_oauth',
              nativeAccountEmail: check.accountEmail ?? undefined,
            },
          });
        }

        await recordIntegrationActivityLog({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          integrationId: saved?.id ?? null,
          providerKey,
          operation: 'oauth_authorize',
          direction: 'auth',
          status: 'success',
          httpStatus: check.httpStatus,
          summary: check.summary,
        }).catch(() => {});

        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          hasLiveGoogleToken: true,
        });

        res.status(201).json({
          integration: saved,
          ...bundle,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to authorize Google Workspace connector.';
        res.status(400).json({ error: msg });
      }
    }
  );

  // 3. Connect Native Bot Token Connector (Slack Bot Token / Telegram Bot Token)
  app.post(
    '/api/integrations/native/token',
    requireAuth,
    rateLimiter,
    async (req: AuthRequest, res) => {
      try {
        const ws = await resolveOwnedWorkspace(
          req.authUser!.uid,
          req.body?.workspaceId
        );
        if (!ws) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const providerKey = req.body?.providerKey as
          | 'slack_native'
          | 'telegram_native';
        if (
          providerKey !== 'slack_native' &&
          providerKey !== 'telegram_native'
        ) {
          return res.status(400).json({
            error: 'providerKey must be slack_native or telegram_native.',
          });
        }

        const token =
          typeof req.body?.botToken === 'string' ? req.body.botToken.trim() : '';
        if (!token || token.length < 10) {
          return res.status(400).json({
            error: 'A valid Bot Token is required.',
          });
        }

        const cat = getCatalogItemForProvider(providerKey)!;
        const displayName =
          typeof req.body?.displayName === 'string' &&
          req.body.displayName.trim()
            ? req.body.displayName.trim()
            : cat.name;

        const existingList = await listIntegrationsByUser(
          req.authUser!.uid,
          ws.id
        );
        const existing = existingList.find(
          (i) => i.providerKey === providerKey
        );

        const configMetadata = {
          authType: 'bot_token' as const,
          slackDefaultChannel:
            typeof req.body?.slackDefaultChannel === 'string'
              ? req.body.slackDefaultChannel.trim() || undefined
              : undefined,
          telegramDefaultChatId:
            typeof req.body?.telegramDefaultChatId === 'string'
              ? req.body.telegramDefaultChatId.trim() || undefined
              : undefined,
        };

        const saved = existing
          ? await updateUserIntegration({
              integrationId: existing.id,
              userId: req.authUser!.uid,
              displayName,
              enabled: true,
              capabilities: [...cat.capabilities],
              configMetadata,
              plaintextSecret: token,
            })
          : await createUserIntegration({
              userId: req.authUser!.uid,
              workspaceId: ws.id,
              providerKey,
              displayName,
              connectionMode: 'user_owned',
              connectorType: 'native_token',
              connectorCategory: 'connected_apps',
              authStatus: 'configured',
              grantedScopes: cat.defaultScopes,
              healthStatus: 'untested',
              capabilities: [...cat.capabilities],
              configMetadata,
              plaintextSecret: token,
            });

        // Immediately run live connection verification so user gets real-time readiness!
        const testOutcome = saved
          ? await testUserIntegrationConnection({
              userId: req.authUser!.uid,
              integrationId: saved.id,
            })
          : null;

        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          hasLiveGoogleToken: Boolean(
            (req.header('x-google-access-token') || '').trim()
          ),
        });

        res.status(201).json({
          integration: testOutcome?.integration ?? saved,
          testResult: testOutcome,
          ...bundle,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to configure native token connector.';
        res.status(400).json({ error: msg });
      }
    }
  );

  // 4. Disconnect & Revoke Integration
  app.post(
    '/api/integrations/:id/disconnect',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const existing = await getIntegrationByIdForUser(
          req.params.id,
          req.authUser!.uid
        );
        if (!existing) {
          return res.status(404).json({ error: 'Integration not found.' });
        }

        const liveGoogleToken = (
          req.header('x-google-access-token') || ''
        ).trim();
        if (
          liveGoogleToken &&
          Boolean(req.body?.revokeGoogleToken) &&
          (existing.providerKey === 'gmail_native' ||
            existing.providerKey === 'google_calendar_native' ||
            existing.providerKey === 'google_drive_native')
        ) {
          await revokeGoogleWorkspaceToken({ accessToken: liveGoogleToken });
        }

        await deleteUserIntegration(existing.id, req.authUser!.uid);

        await recordIntegrationActivityLog({
          userId: req.authUser!.uid,
          workspaceId: existing.workspaceId,
          providerKey: existing.providerKey,
          operation: 'disconnect',
          direction: 'auth',
          status: 'success',
          summary: `Disconnected "${existing.displayName}" and purged workspace credentials.`,
        }).catch(() => {});

        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: existing.workspaceId,
          hasLiveGoogleToken: Boolean(
            liveGoogleToken && !req.body?.revokeGoogleToken
          ),
        });

        res.json({
          disconnected: true,
          ...bundle,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to disconnect integration.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // 5. Third-Party OAuth 2.0 Popup Authorization URL (Slack, Microsoft Outlook, Microsoft Teams)
  app.get(
    '/api/oauth/:provider/url',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const ws = await resolveOwnedWorkspace(
          req.authUser!.uid,
          req.query.workspaceId
        );
        if (!ws) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const providerKey = req.params.provider as
          | 'slack_native'
          | 'microsoft_outlook_native'
          | 'microsoft_teams_native';

        if (
          providerKey !== 'slack_native' &&
          providerKey !== 'microsoft_outlook_native' &&
          providerKey !== 'microsoft_teams_native'
        ) {
          return res.status(400).json({
            error: 'Unsupported 3P OAuth provider.',
          });
        }

        const clientOrigin =
          typeof req.query.origin === 'string' ? req.query.origin : undefined;
        const redirectUri = resolveOAuthCallbackRedirectUri(clientOrigin);

        const cat = getCatalogItemForProvider(providerKey)!;
        const stateToken = await createOAuthStateToken({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          providerKey,
          redirectUri,
          requestedScopes: cat.defaultScopes,
        });

        const built = buildThirdPartyOAuthUrl({
          providerKey,
          redirectUri,
          stateToken,
        });

        if (!built.configured || !built.url) {
          return res.json({
            configured: false,
            redirectUri,
            missingEnvVars: built.missingEnvVars ?? [],
            message: `OAuth client credentials (${(built.missingEnvVars ?? []).join(', ')}) are not configured on the server yet.`,
          });
        }

        res.json({
          configured: true,
          url: built.url,
          redirectUri,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to generate OAuth authorization URL.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // 6. Third-Party OAuth 2.0 Callback Handler (postMessage to opener + auto-close)
  const oauthCallbackHandler: RequestHandler = async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
    const state =
      typeof req.query.state === 'string' ? req.query.state.trim() : '';
    const oauthErr =
      typeof req.query.error === 'string' ? req.query.error.trim() : '';

    const renderPopupHtml = (payload: {
      success: boolean;
      providerKey?: string;
      message: string;
    }) => {
      const safeJson = JSON.stringify({
        type: payload.success ? 'OAUTH_AUTH_SUCCESS' : 'OAUTH_AUTH_ERROR',
        providerKey: payload.providerKey ?? null,
        message: payload.message,
      }).replace(/</g, '\\u003c');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Task.ai Connector Authorization</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 24px; color: #0f172a;">
    <script>
      (function () {
        var data = ${safeJson};
        if (window.opener) {
          window.opener.postMessage(data, '*');
          window.close();
        }
      })();
    </script>
    <p>${payload.message.replace(/[<>&"]/g, '')}</p>
  </body>
</html>`);
    };

    if (oauthErr) {
      renderPopupHtml({
        success: false,
        message: `Authorization declined or failed (${oauthErr}).`,
      });
      return;
    }

    if (!code || !state) {
      renderPopupHtml({
        success: false,
        message: 'Missing OAuth authorization code or state parameter.',
      });
      return;
    }

    try {
      const stateRecord = await consumeOAuthStateToken(state);
      if (!stateRecord) {
        renderPopupHtml({
          success: false,
          message: 'OAuth state token is invalid or expired. Please try again.',
        });
        return;
      }

      const providerKey = stateRecord.providerKey as
        | 'slack_native'
        | 'microsoft_outlook_native'
        | 'microsoft_teams_native';

      const exchanged = await exchangeThirdPartyOAuthCode({
        providerKey,
        code,
        redirectUri: stateRecord.redirectUri,
      });

      const cat = getCatalogItemForProvider(providerKey)!;
      const existingList = await listIntegrationsByUser(
        stateRecord.userId,
        stateRecord.workspaceId
      );
      const existing = existingList.find((i) => i.providerKey === providerKey);

      const saved = existing
        ? await updateUserIntegration({
            integrationId: existing.id,
            userId: stateRecord.userId,
            displayName: cat.name,
            enabled: true,
            authStatus: 'authorized',
            grantedScopes: exchanged.grantedScopes,
            capabilities: [...cat.capabilities],
            configMetadata: {
              ...existing.configMetadata,
              authType: 'oauth2',
              nativeAccountLabel: exchanged.accountLabel ?? undefined,
            },
            plaintextSecret: exchanged.accessToken,
          })
        : await createUserIntegration({
            userId: stateRecord.userId,
            workspaceId: stateRecord.workspaceId,
            providerKey,
            displayName: cat.name,
            connectionMode: 'user_owned',
            connectorType: 'native_oauth',
            connectorCategory: 'connected_apps',
            authStatus: 'authorized',
            grantedScopes: exchanged.grantedScopes,
            healthStatus: 'untested',
            capabilities: [...cat.capabilities],
            configMetadata: {
              authType: 'oauth2',
              nativeAccountLabel: exchanged.accountLabel ?? undefined,
            },
            plaintextSecret: exchanged.accessToken,
          });

      if (saved) {
        await testUserIntegrationConnection({
          userId: stateRecord.userId,
          integrationId: saved.id,
        }).catch(() => {});
      }

      renderPopupHtml({
        success: true,
        providerKey,
        message: `${cat.name} connected and verified. This window will close automatically.`,
      });
    } catch (err: unknown) {
      const safeMsg =
        err instanceof Error
          ? redactSecretsFromText(err.message)
          : 'OAuth token exchange failed.';
      renderPopupHtml({
        success: false,
        message: safeMsg,
      });
    }
  };

  app.get(
    ['/auth/oauth/callback', '/auth/oauth/callback/'],
    oauthCallbackHandler
  );

  // 7. Custom API Connector Create & Update
  app.post(
    '/api/integrations/custom-api',
    requireAuth,
    rateLimiter,
    async (req: AuthRequest, res) => {
      try {
        const ws = await resolveOwnedWorkspace(
          req.authUser!.uid,
          req.body?.workspaceId
        );
        if (!ws) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const displayName =
          typeof req.body?.displayName === 'string'
            ? req.body.displayName.trim()
            : '';
        const authType = (req.body?.authType || 'bearer_token') as IntegrationAuthType;
        const secret =
          typeof req.body?.secret === 'string' ? req.body.secret.trim() : '';

        const validation = validateCustomApiConfig({
          displayName,
          authType,
          customApi: req.body?.customApi ?? {},
          hasSecret: Boolean(secret),
        });

        if (!validation.valid || !validation.normalized) {
          return res.status(400).json({
            error: validation.error || 'Invalid Custom API configuration.',
          });
        }

        const requestedCaps = normalizeCapabilities(
          req.body?.capabilities ?? ['custom_api_execution', 'http_request'],
          'custom_api',
          'external_workflow'
        );
        const capabilities: CapabilityId[] =
          requestedCaps.length > 0
            ? Array.from(new Set(['custom_api_execution', ...requestedCaps]))
            : ['custom_api_execution', 'http_request'];

        const created = await createUserIntegration({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          providerKey: 'custom_api',
          displayName,
          connectionMode: 'user_owned',
          connectorType: 'custom_api',
          connectorCategory: 'custom_api',
          authStatus: 'configured',
          grantedScopes: validation.normalized.allowedOperations,
          healthStatus: 'untested',
          capabilities,
          configMetadata: {
            authType,
            endpointUrl: validation.normalizedFullUrl,
            destinationOrigin: validation.destinationOrigin,
            secretHeaderName: validation.normalized.apiKeyHeaderName,
            customApi: validation.normalized,
          },
          plaintextSecret: secret || undefined,
        });

        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          hasLiveGoogleToken: Boolean(
            (req.header('x-google-access-token') || '').trim()
          ),
        });

        res.status(201).json({
          integration: created,
          ...bundle,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to create Custom API connector.';
        res.status(400).json({ error: msg });
      }
    }
  );

  // 8. Upgraded n8n Setup (Existing Instance vs Manual Webhook) + Workflow Registration & Discovery
  app.post(
    '/api/integrations/n8n/configure',
    requireAuth,
    rateLimiter,
    async (req: AuthRequest, res) => {
      try {
        const ws = await resolveOwnedWorkspace(
          req.authUser!.uid,
          req.body?.workspaceId
        );
        if (!ws) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const setupMode: 'existing_instance' | 'manual_webhook' =
          req.body?.setupMode === 'existing_instance'
            ? 'existing_instance'
            : 'manual_webhook';

        const displayName =
          typeof req.body?.displayName === 'string' &&
          req.body.displayName.trim()
            ? req.body.displayName.trim()
            : setupMode === 'existing_instance'
              ? 'n8n Instance'
              : 'n8n Signed Webhook';

        const secret =
          typeof req.body?.secret === 'string' ? req.body.secret.trim() : '';
        const capabilities = normalizeCapabilities(
          req.body?.capabilities ?? ['workflow_automation', 'message_dispatch'],
          'n8n_webhook',
          'external_workflow'
        );
        const safeCaps: CapabilityId[] =
          capabilities.length > 0 ? capabilities : ['workflow_automation'];

        if (setupMode === 'existing_instance') {
          const baseUrlRaw =
            typeof req.body?.n8nBaseUrl === 'string'
              ? req.body.n8nBaseUrl.trim()
              : '';
          const check = validateDestinationUrlSync(baseUrlRaw);
          if (!check.valid || !check.origin) {
            return res.status(400).json({
              error: check.error || 'A valid HTTPS n8n Base URL is required.',
            });
          }
          if (!secret) {
            return res.status(400).json({
              error:
                'An n8n API key is required when connecting an existing n8n instance.',
            });
          }

          const created = await createUserIntegration({
            userId: req.authUser!.uid,
            workspaceId: ws.id,
            providerKey: 'n8n_webhook',
            displayName,
            connectionMode: 'user_owned',
            connectorType: 'webhook',
            connectorCategory: 'automation_platforms',
            authStatus: 'configured',
            grantedScopes: ['n8n:api:workflows', 'n8n:webhook:execute'],
            healthStatus: 'untested',
            capabilities: safeCaps,
            configMetadata: {
              authType: 'api_key',
              n8nSetupMode: 'existing_instance',
              n8nBaseUrl: check.origin,
              destinationOrigin: check.origin,
            },
            plaintextSecret: secret,
          });

          const bundle = await buildEnrichedWorkspaceIntegrationBundle({
            userId: req.authUser!.uid,
            workspaceId: ws.id,
            hasLiveGoogleToken: Boolean(
              (req.header('x-google-access-token') || '').trim()
            ),
          });

          return res.status(201).json({
            integration: created,
            ...bundle,
          });
        }

        // Option B: Manual Webhook Setup
        const endpointRaw =
          typeof req.body?.endpointUrl === 'string'
            ? req.body.endpointUrl.trim()
            : '';
        const check = validateDestinationUrlSync(endpointRaw);
        if (!check.valid || !check.normalizedUrl || !check.origin) {
          return res.status(400).json({
            error: check.error || 'A valid HTTPS n8n webhook URL is required.',
          });
        }

        const authType = (req.body?.authType ||
          (secret ? 'hmac_sha256' : 'none')) as IntegrationAuthType;
        const workflowId =
          typeof req.body?.workflowId === 'string' && req.body.workflowId.trim()
            ? req.body.workflowId.trim()
            : 'manual-webhook-1';

        const created = await createUserIntegration({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          providerKey: 'n8n_webhook',
          displayName,
          connectionMode: 'user_owned',
          connectorType: 'webhook',
          connectorCategory: 'automation_platforms',
          authStatus: 'configured',
          grantedScopes: ['n8n:webhook:signed'],
          healthStatus: 'untested',
          capabilities: safeCaps,
          configMetadata: {
            authType,
            n8nSetupMode: 'manual_webhook',
            endpointUrl: check.normalizedUrl,
            destinationOrigin: check.origin,
            workflowId,
          },
          plaintextSecret: secret || undefined,
        });

        await upsertN8nWorkflowForIntegration({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          integrationId: created.id,
          workflowExternalId: workflowId,
          name: displayName,
          description: 'Explicitly registered n8n webhook workflow',
          webhookUrlOrPath: check.normalizedUrl,
          httpMethod: 'POST',
          capabilities: safeCaps,
          active: true,
          discoveredViaApi: false,
        });

        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          hasLiveGoogleToken: Boolean(
            (req.header('x-google-access-token') || '').trim()
          ),
        });

        res.status(201).json({
          integration: created,
          ...bundle,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to save n8n configuration.';
        res.status(400).json({ error: msg });
      }
    }
  );

  // Register an explicit workflow on an n8n integration
  app.post(
    '/api/integrations/:id/n8n/workflows',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const existing = await getIntegrationByIdForUser(
          req.params.id,
          req.authUser!.uid
        );
        if (!existing || existing.providerKey !== 'n8n_webhook') {
          return res.status(404).json({ error: 'n8n integration not found.' });
        }

        const name =
          typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const workflowExternalId =
          typeof req.body?.workflowExternalId === 'string' &&
          req.body.workflowExternalId.trim()
            ? req.body.workflowExternalId.trim()
            : `wf-${Date.now()}`;
        const webhookUrlOrPath =
          typeof req.body?.webhookUrlOrPath === 'string'
            ? req.body.webhookUrlOrPath.trim()
            : '';

        if (!name || !webhookUrlOrPath) {
          return res.status(400).json({
            error: 'Workflow name and webhook URL or path are required.',
          });
        }

        if (webhookUrlOrPath.startsWith('http')) {
          const check = validateDestinationUrlSync(webhookUrlOrPath);
          if (!check.valid) {
            return res
              .status(400)
              .json({ error: check.error || 'Unsafe workflow webhook URL.' });
          }
        }

        const caps = normalizeCapabilities(
          req.body?.capabilities ?? ['workflow_automation'],
          'n8n_webhook',
          'external_workflow'
        );
        const methodRaw = String(req.body?.httpMethod || 'POST').toUpperCase();
        const httpMethod: CustomApiHttpMethod =
          methodRaw === 'GET' ||
          methodRaw === 'POST' ||
          methodRaw === 'PUT' ||
          methodRaw === 'PATCH' ||
          methodRaw === 'DELETE'
            ? methodRaw
            : 'POST';

        const wf = await upsertN8nWorkflowForIntegration({
          userId: req.authUser!.uid,
          workspaceId: existing.workspaceId,
          integrationId: existing.id,
          workflowExternalId,
          name,
          description:
            typeof req.body?.description === 'string'
              ? req.body.description
              : '',
          webhookUrlOrPath,
          httpMethod,
          capabilities: caps.length > 0 ? caps : ['workflow_automation'],
          active: true,
          discoveredViaApi: false,
        });

        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: existing.workspaceId,
          hasLiveGoogleToken: Boolean(
            (req.header('x-google-access-token') || '').trim()
          ),
        });

        res.status(201).json({
          workflow: wf,
          ...bundle,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to register n8n workflow.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/integrations/:id/n8n/discover',
    requireAuth,
    rateLimiter,
    async (req: AuthRequest, res) => {
      try {
        const executable = await getExecutableIntegrationForServer(
          req.params.id,
          req.authUser!.uid
        );
        if (!executable || executable.record.providerKey !== 'n8n_webhook') {
          return res.status(404).json({ error: 'n8n integration not found.' });
        }

        const discovered = await discoverN8nInstanceWorkflows({
          executable,
          userId: req.authUser!.uid,
        });

        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: executable.record.workspaceId,
          hasLiveGoogleToken: Boolean(
            (req.header('x-google-access-token') || '').trim()
          ),
        });

        res.json({
          ...discovered,
          ...bundle,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'n8n workflow discovery failed.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.delete(
    '/api/integrations/:id/n8n/workflows/:workflowId',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const existing = await getIntegrationByIdForUser(
          req.params.id,
          req.authUser!.uid
        );
        if (!existing) {
          return res.status(404).json({ error: 'Integration not found.' });
        }

        await deleteN8nWorkflowForUser({
          workflowId: req.params.workflowId,
          userId: req.authUser!.uid,
          workspaceId: existing.workspaceId,
        });

        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: existing.workspaceId,
          hasLiveGoogleToken: Boolean(
            (req.header('x-google-access-token') || '').trim()
          ),
        });

        res.json({ deleted: true, ...bundle });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to remove workflow.';
        res.status(400).json({ error: msg });
      }
    }
  );

  // 9. AI Providers Management & Live Health Checks
  app.get('/api/ai-providers', requireAuth, async (req: AuthRequest, res) => {
    try {
      const ws = await resolveOwnedWorkspace(
        req.authUser!.uid,
        req.query.workspaceId
      );
      if (!ws) {
        return res.status(404).json({ error: 'Workspace not found.' });
      }

      const aiProviders = await listWorkspaceAiProviders({
        userId: req.authUser!.uid,
        workspaceId: ws.id,
      });
      res.json({ workspaceId: ws.id, aiProviders });
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? redactSecretsFromText(err.message)
          : 'Failed to load AI providers.';
      res.status(500).json({ error: msg });
    }
  });

  app.patch(
    '/api/ai-providers/:providerId',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const ws = await resolveOwnedWorkspace(
          req.authUser!.uid,
          req.body?.workspaceId
        );
        if (!ws) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const providerId = req.params.providerId as AiProviderId;
        const aiProviders = await updateWorkspaceAiProviderSettings({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          providerId,
          enabled:
            typeof req.body?.enabled === 'boolean'
              ? req.body.enabled
              : undefined,
          preferredModel:
            typeof req.body?.preferredModel === 'string'
              ? req.body.preferredModel
              : undefined,
          fallbackPriority:
            typeof req.body?.fallbackPriority === 'number'
              ? req.body.fallbackPriority
              : undefined,
        });

        res.json({ workspaceId: ws.id, aiProviders });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to update AI provider configuration.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/ai-providers/:providerId/health-check',
    requireAuth,
    rateLimiter,
    async (req: AuthRequest, res) => {
      try {
        const ws = await resolveOwnedWorkspace(
          req.authUser!.uid,
          req.body?.workspaceId
        );
        if (!ws) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const providerId = req.params.providerId as AiProviderId;
        const outcome = await runAiProviderHealthCheck({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          providerId,
        });

        await recordIntegrationActivityLog({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          providerKey: `ai:${providerId}`,
          operation: 'ai_provider_health_check',
          direction: 'health_check',
          status: outcome.healthy ? 'success' : 'error',
          durationMs: outcome.latencyMs,
          summary: outcome.detail,
          errorMessage: outcome.healthy ? null : outcome.detail,
        }).catch(() => {});

        res.json(outcome);
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'AI provider health check failed.';
        res.status(400).json({ error: msg });
      }
    }
  );

  // 10. Intelligent Workforce Configuration Manager Endpoints
  app.post(
    '/api/workforce/evaluate',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const ws = await resolveOwnedWorkspace(
          req.authUser!.uid,
          req.body?.workspaceId
        );
        if (!ws) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const prompt =
          typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
        if (!prompt || prompt.length < 4) {
          return res.status(400).json({
            error:
              'Describe the AI employee or workforce you want to configure.',
          });
        }

        const hasLiveGoogleToken = Boolean(
          (req.header('x-google-access-token') || '').trim()
        );
        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          hasLiveGoogleToken,
        });

        const blueprint = analyzeWorkforceRequest(prompt);
        const readiness = evaluateWorkforceReadiness({
          blueprint,
          registry: bundle.registry,
        });

        const created = await createWorkforceConfigurationRow({
          userId: req.authUser!.uid,
          workspaceId: ws.id,
          conversationId:
            typeof req.body?.conversationId === 'string'
              ? req.body.conversationId
              : null,
          title: blueprint.title,
          requestPrompt: prompt,
          roleSummary: blueprint.roleSummary,
          status: readiness.allOperational
            ? 'operational'
            : 'awaiting_authorization',
          requiredCapabilities: blueprint.requiredCapabilities,
          recommendedConnectors: readiness.recommendedConnectors,
          capabilityMatrix: readiness.capabilityMatrix,
          activationBlockerReason: readiness.activationBlockerReason,
        });

        res.status(201).json({
          workforceConfig: created,
          workforceConfigs: [
            created,
            ...bundle.workforceConfigs.filter((c) => c.id !== created.id),
          ],
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to evaluate workforce configuration.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/workforce/:id/decision',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const existing = await getWorkforceConfigurationByIdForUser({
          configId: req.params.id,
          userId: req.authUser!.uid,
        });
        if (!existing) {
          return res
            .status(404)
            .json({ error: 'Workforce configuration not found.' });
        }

        const action = req.body?.action as 'approve' | 'reject' | 'modify';
        const providerKey = req.body?.providerKey as
          | IntegrationProviderKey
          | undefined;
        const replacementProviderKey = req.body?.replacementProviderKey as
          | IntegrationProviderKey
          | undefined;

        let approvedList = [...existing.approvedConnectorIds];
        let rejectedList = [...existing.rejectedProviders];

        if (action === 'reject') {
          if (providerKey) {
            rejectedList = Array.from(new Set([...rejectedList, providerKey]));
            approvedList = approvedList.filter((k) => k !== providerKey);
          } else {
            const updated = await updateWorkforceConfigurationRow({
              configId: existing.id,
              userId: req.authUser!.uid,
              status: 'rejected',
              activationBlockerReason:
                'Workforce configuration was rejected by the workspace owner.',
            });
            return res.json({ workforceConfig: updated });
          }
        } else if (action === 'approve' && providerKey) {
          approvedList = Array.from(new Set([...approvedList, providerKey]));
          rejectedList = rejectedList.filter((k) => k !== providerKey);
        } else if (action === 'approve' && !providerKey) {
          approvedList = existing.recommendedConnectors.map(
            (r) => r.providerKey
          );
        }

        const hasLiveGoogleToken = Boolean(
          (req.header('x-google-access-token') || '').trim()
        );
        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: existing.workspaceId,
          hasLiveGoogleToken,
        });

        const blueprint = analyzeWorkforceRequest(existing.requestPrompt);
        const overrides: Partial<Record<CapabilityId, IntegrationProviderKey>> =
          {};
        if (action === 'modify' && providerKey && replacementProviderKey) {
          for (const rec of existing.recommendedConnectors) {
            if (rec.providerKey === providerKey) {
              for (const c of rec.requiredForCapabilities) {
                overrides[c] = replacementProviderKey;
              }
            }
          }
          approvedList = Array.from(
            new Set([
              ...approvedList.filter((k) => k !== providerKey),
              replacementProviderKey,
            ])
          );
        }

        const readiness = evaluateWorkforceReadiness({
          blueprint,
          registry: bundle.registry,
          approvedProviderKeys: approvedList,
          rejectedProviderKeys: rejectedList,
          preferredOverrides: overrides,
        });

        const updated = await updateWorkforceConfigurationRow({
          configId: existing.id,
          userId: req.authUser!.uid,
          status: readiness.allOperational
            ? 'operational'
            : 'awaiting_authorization',
          recommendedConnectors: readiness.recommendedConnectors,
          approvedConnectorIds: approvedList,
          rejectedProviders: rejectedList,
          capabilityMatrix: readiness.capabilityMatrix,
          activationBlockerReason: readiness.activationBlockerReason,
          activatedAt: readiness.allOperational ? new Date() : null,
        });

        res.json({ workforceConfig: updated });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Failed to update workforce decision.';
        res.status(400).json({ error: msg });
      }
    }
  );

  // Test all bound integrations for a Workforce & attempt strict activation
  app.post(
    '/api/workforce/:id/activate',
    requireAuth,
    rateLimiter,
    async (req: AuthRequest, res) => {
      try {
        const existing = await getWorkforceConfigurationByIdForUser({
          configId: req.params.id,
          userId: req.authUser!.uid,
        });
        if (!existing) {
          return res
            .status(404)
            .json({ error: 'Workforce configuration not found.' });
        }

        const liveGoogleToken = (
          req.header('x-google-access-token') || ''
        ).trim();

        // Run live connection tests on any configured integrations referenced by this workforce
        for (const rec of existing.recommendedConnectors) {
          if (rec.integrationId && rec.decision !== 'rejected') {
            await testUserIntegrationConnection({
              userId: req.authUser!.uid,
              integrationId: rec.integrationId,
              googleAccessToken: liveGoogleToken || null,
            }).catch(() => {});
          }
        }

        const bundle = await buildEnrichedWorkspaceIntegrationBundle({
          userId: req.authUser!.uid,
          workspaceId: existing.workspaceId,
          hasLiveGoogleToken: Boolean(liveGoogleToken),
        });

        const blueprint = analyzeWorkforceRequest(existing.requestPrompt);
        const readiness = evaluateWorkforceReadiness({
          blueprint,
          registry: bundle.registry,
          approvedProviderKeys: existing.approvedConnectorIds,
          rejectedProviderKeys: existing.rejectedProviders,
        });

        const now = new Date();
        const nextStatus = readiness.allOperational
          ? 'operational'
          : 'awaiting_authorization';

        const updated = await updateWorkforceConfigurationRow({
          configId: existing.id,
          userId: req.authUser!.uid,
          status: nextStatus,
          recommendedConnectors: readiness.recommendedConnectors,
          capabilityMatrix: readiness.capabilityMatrix,
          activationBlockerReason: readiness.activationBlockerReason,
          lastTestedAt: now,
          activatedAt: readiness.allOperational ? now : null,
        });

        res.json({
          activated: readiness.allOperational,
          workforceConfig: updated,
          ...bundle,
        });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? redactSecretsFromText(err.message)
            : 'Workforce capability verification failed.';
        res.status(400).json({ error: msg });
      }
    }
  );
}
