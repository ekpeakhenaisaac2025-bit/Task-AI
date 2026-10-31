import 'dotenv/config';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../db/index.ts';
import { getOrCreateUser } from '../db/users.ts';
import {
  createGoalForUser,
  createSingleTaskForGoal,
  createUserIntegration,
  ensureDefaultWorkspaceForUser,
  getExecutableIntegrationForServer,
  getIntegrationByIdForUser,
  listIntegrationsByUser,
  recordApprovalDecision,
} from '../db/repository.ts';
import {
  consumeOAuthStateToken,
  createOAuthStateToken,
  createWorkforceConfigurationRow,
  deleteN8nWorkflowForUser,
  getWorkforceConfigurationByIdForUser,
  listIntegrationActivityLogs,
  listN8nWorkflowsByWorkspace,
  upsertN8nWorkflowForIntegration,
} from '../db/integrations-repository.ts';
import {
  buildWorkspaceIntegrationRegistry,
  computeIntegrationReadinessState,
  evaluateWorkspaceCapabilities,
  getCatalogItemForProvider,
} from '../lib/integration-registry.ts';
import {
  analyzeWorkforceRequest,
  detectWorkforceOrConnectorIntent,
  evaluateWorkforceReadiness,
} from '../lib/workforce-manager.ts';
import { resolveExecutionRoute } from '../lib/domain-rules.ts';
import {
  validateCustomApiConfig,
  validatePayloadAgainstBodySchema,
} from './connectors/custom-api-connector.ts';
import { discoverN8nInstanceWorkflows } from './connectors/n8n-connector.ts';
import {
  executeRoutedTask,
  testUserIntegrationConnection,
} from './execution-router.ts';
import {
  listWorkspaceAiProviders,
  runAiProviderHealthCheck,
  updateWorkspaceAiProviderSettings,
} from './ai-providers.ts';
import type { SafeOutboundHttpRequestParams } from './ssrf-guard.ts';

const runSuffix = crypto.randomUUID().slice(0, 8);

async function createIsolatedTenant(label: string) {
  const uid = `mc_test_${label}_${runSuffix}`;
  const email = `${uid}@taskai-test.local`;
  await getOrCreateUser(uid, email);
  const ws = await ensureDefaultWorkspaceForUser(uid);
  return { uid, email, workspaceId: ws.id };
}

test('1. Multi-user independent n8n instances & explicit /api/v1/workflows discovery', async () => {
  await createPool();
  const tenantA = await createIsolatedTenant('n8n_a');
  const tenantB = await createIsolatedTenant('n8n_b');

  const secretA = `n8n_api_secret_A_${runSuffix}`;
  const secretB = `n8n_hmac_secret_B_${runSuffix}`;

  // Tenant A connects an existing n8n instance
  const n8nA = await createUserIntegration({
    userId: tenantA.uid,
    workspaceId: tenantA.workspaceId,
    providerKey: 'n8n_webhook',
    displayName: 'Tenant A n8n Cloud',
    connectionMode: 'user_owned',
    connectorType: 'webhook',
    connectorCategory: 'automation_platforms',
    authStatus: 'configured',
    grantedScopes: ['n8n:api:workflows'],
    healthStatus: 'untested',
    capabilities: ['workflow_automation', 'crm_sync'],
    configMetadata: {
      authType: 'api_key',
      n8nSetupMode: 'existing_instance',
      n8nBaseUrl: 'https://n8n-alpha.example.com',
      destinationOrigin: 'https://n8n-alpha.example.com',
    },
    plaintextSecret: secretA,
  });

  // Tenant B configures a manual signed webhook independently
  const n8nB = await createUserIntegration({
    userId: tenantB.uid,
    workspaceId: tenantB.workspaceId,
    providerKey: 'n8n_webhook',
    displayName: 'Tenant B Signed Webhook',
    connectionMode: 'user_owned',
    connectorType: 'webhook',
    connectorCategory: 'automation_platforms',
    authStatus: 'configured',
    grantedScopes: ['n8n:webhook:signed'],
    healthStatus: 'untested',
    capabilities: ['workflow_automation'],
    configMetadata: {
      authType: 'hmac_sha256',
      n8nSetupMode: 'manual_webhook',
      endpointUrl: 'https://n8n-beta.example.com/webhook/orders',
      destinationOrigin: 'https://n8n-beta.example.com',
      workflowId: 'wf-beta-orders',
    },
    plaintextSecret: secretB,
  });

  await upsertN8nWorkflowForIntegration({
    userId: tenantB.uid,
    workspaceId: tenantB.workspaceId,
    integrationId: n8nB.id,
    workflowExternalId: 'wf-beta-orders',
    name: 'Beta Orders Webhook',
    webhookUrlOrPath: 'https://n8n-beta.example.com/webhook/orders',
    httpMethod: 'POST',
    capabilities: ['workflow_automation'],
    active: true,
    discoveredViaApi: false,
  });

  // Discover workflows for Tenant A via mock /api/v1/workflows:
  // Includes 1 webhook-triggered workflow and 1 cron-only workflow (which MUST NOT be assumed exposed!)
  const execA = await getExecutableIntegrationForServer(n8nA.id, tenantA.uid);
  assert.ok(execA);

  const discovery = await discoverN8nInstanceWorkflows({
    executable: execA,
    userId: tenantA.uid,
    transport: async (req) => {
      assert.equal(req.url, 'https://n8n-alpha.example.com/api/v1/workflows');
      assert.equal(req.headers?.['X-N8N-API-KEY'], secretA);
      return {
        ok: true,
        status: 200,
        destinationOrigin: 'https://n8n-alpha.example.com',
        headers: {},
        responseText: JSON.stringify({
          data: [
            {
              id: 'wf-crm-sync-101',
              name: 'HubSpot CRM Lead Sync',
              active: true,
              nodes: [
                {
                  type: 'n8n-nodes-base.webhook',
                  parameters: {
                    path: 'crm-lead-sync',
                    httpMethod: 'POST',
                  },
                },
              ],
            },
            {
              id: 'wf-nightly-cleanup-102',
              name: 'Nightly Cron Cleanup (No Webhook)',
              active: true,
              nodes: [
                {
                  type: 'n8n-nodes-base.scheduleTrigger',
                  parameters: {},
                },
              ],
            },
          ],
        }),
      };
    },
  });

  assert.equal(discovery.discoveredCount, 1);
  assert.equal(discovery.skippedWithoutWebhookNode, 1);
  assert.equal(
    discovery.registeredWorkflows[0]?.webhookUrlOrPath,
    'https://n8n-alpha.example.com/webhook/crm-lead-sync'
  );
  assert.ok(discovery.registeredWorkflows[0]?.capabilities.includes('crm_sync'));

  // Verify Tenant A and Tenant B workflow registries never bleed into each other
  const workflowsA = await listN8nWorkflowsByWorkspace({
    userId: tenantA.uid,
    workspaceId: tenantA.workspaceId,
  });
  const workflowsB = await listN8nWorkflowsByWorkspace({
    userId: tenantB.uid,
    workspaceId: tenantB.workspaceId,
  });

  assert.equal(workflowsA.length, 1);
  assert.equal(workflowsA[0]?.workflowExternalId, 'wf-crm-sync-101');
  assert.equal(workflowsB.length, 1);
  assert.equal(workflowsB[0]?.workflowExternalId, 'wf-beta-orders');
});

test('2. Strict cross-tenant isolation & single-use OAuth state anti-CSRF protection', async () => {
  const owner = await createIsolatedTenant('iso_owner');
  const intruder = await createIsolatedTenant('iso_intruder');

  const conn = await createUserIntegration({
    userId: owner.uid,
    workspaceId: owner.workspaceId,
    providerKey: 'slack_native',
    displayName: 'Owner Slack Workspace',
    connectionMode: 'user_owned',
    connectorType: 'native_token',
    connectorCategory: 'connected_apps',
    authStatus: 'configured',
    healthStatus: 'untested',
    capabilities: ['team_messaging'],
    configMetadata: { authType: 'bot_token', slackDefaultChannel: '#ops' },
    plaintextSecret: 'xoxb-owner-super-secret-token',
  });

  const wfConfig = await createWorkforceConfigurationRow({
    userId: owner.uid,
    workspaceId: owner.workspaceId,
    title: 'Owner Support Workforce',
    requestPrompt: 'Manage owner customer support',
    roleSummary: 'Owner support agent',
    status: 'awaiting_authorization',
    requiredCapabilities: ['email_read', 'team_messaging'],
    recommendedConnectors: [],
    capabilityMatrix: {} as never,
    activationBlockerReason: 'Missing Gmail',
  });

  // Intruder cannot read, get executable secret, test, or delete Owner's resources
  const intruderRead = await getIntegrationByIdForUser(conn.id, intruder.uid);
  assert.equal(intruderRead, null);

  const intruderExec = await getExecutableIntegrationForServer(
    conn.id,
    intruder.uid
  );
  assert.equal(intruderExec, null);

  await assert.rejects(
    () =>
      testUserIntegrationConnection({
        userId: intruder.uid,
        integrationId: conn.id,
      }),
    /Integration not found or access denied/
  );

  const intruderWf = await getWorkforceConfigurationByIdForUser({
    configId: wfConfig.id,
    userId: intruder.uid,
  });
  assert.equal(intruderWf, null);

  const deletedCrossTenant = await deleteN8nWorkflowForUser({
    workflowId: 'nonexistent-or-cross-tenant',
    userId: intruder.uid,
    workspaceId: owner.workspaceId,
  });
  assert.equal(deletedCrossTenant, false);

  // Single-use OAuth state token replay defense
  const stateToken = await createOAuthStateToken({
    userId: owner.uid,
    workspaceId: owner.workspaceId,
    providerKey: 'slack_native',
    redirectUri: 'https://ais-dev.run.app/auth/oauth/callback',
    requestedScopes: ['chat:write'],
  });

  const firstConsume = await consumeOAuthStateToken(stateToken);
  assert.ok(firstConsume);
  assert.equal(firstConsume.userId, owner.uid);

  const replayConsume = await consumeOAuthStateToken(stateToken);
  assert.equal(
    replayConsume,
    null,
    'Replaying an already consumed OAuth state token must be rejected'
  );
});

test('3. Connection testing & honest status transitions (configured -> unhealthy on 502 -> operational on 200)', async () => {
  const tenant = await createIsolatedTenant('conn_test');

  const created = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    providerKey: 'custom_webhook',
    displayName: 'Acme Ops Webhook',
    connectionMode: 'user_owned',
    connectorType: 'webhook',
    connectorCategory: 'webhooks',
    authStatus: 'configured',
    healthStatus: 'untested',
    capabilities: ['workflow_automation'],
    configMetadata: {
      authType: 'bearer_token',
      endpointUrl: 'https://hooks.acme-ops.example.com/taskai',
      destinationOrigin: 'https://hooks.acme-ops.example.com',
    },
    plaintextSecret: 'tok_live_secret_xyz987',
  });

  // Initially configured & untested — NEVER operational
  const initialState = computeIntegrationReadinessState({
    catalogItem: getCatalogItemForProvider('custom_webhook'),
    integration: created,
    oauthEnv: {
      googleWorkspaceReady: true,
      slackOAuthConfigured: false,
      microsoftOAuthConfigured: false,
    },
  });
  assert.equal(initialState.readiness, 'configured');

  // Failed probe (HTTP 502) keeps verified=false and non-operational
  const failedTest = await testUserIntegrationConnection({
    userId: tenant.uid,
    integrationId: created.id,
    httpTransport: async () => ({
      ok: false,
      status: 502,
      responseText: 'Bad Gateway',
      destinationOrigin: 'https://hooks.acme-ops.example.com',
    }),
  });
  assert.equal(failedTest.success, false);
  assert.equal(failedTest.integration.verified, false);

  const afterFailState = computeIntegrationReadinessState({
    catalogItem: getCatalogItemForProvider('custom_webhook'),
    integration: failedTest.integration,
    oauthEnv: {
      googleWorkspaceReady: true,
      slackOAuthConfigured: false,
      microsoftOAuthConfigured: false,
    },
  });
  assert.notEqual(afterFailState.readiness, 'operational');

  // Successful probe (HTTP 200) promotes to verified=true & operational
  const passedTest = await testUserIntegrationConnection({
    userId: tenant.uid,
    integrationId: created.id,
    httpTransport: async () => ({
      ok: true,
      status: 200,
      responseText: '{"ok":true}',
      destinationOrigin: 'https://hooks.acme-ops.example.com',
    }),
  });
  assert.equal(passedTest.success, true);
  assert.equal(passedTest.integration.verified, true);

  const afterPassState = computeIntegrationReadinessState({
    catalogItem: getCatalogItemForProvider('custom_webhook'),
    integration: passedTest.integration,
    oauthEnv: {
      googleWorkspaceReady: true,
      slackOAuthConfigured: false,
      microsoftOAuthConfigured: false,
    },
  });
  assert.equal(afterPassState.readiness, 'operational');
});

test('4. Custom API Connector SSRF protection, auth validation, and JSON body schema validation', () => {
  // Reject non-HTTPS
  const httpAttempt = validateCustomApiConfig({
    displayName: 'Insecure API',
    authType: 'bearer_token',
    hasSecret: true,
    customApi: {
      baseUrl: 'http://api.example.com',
      endpointPath: '/v1/items',
      httpMethod: 'GET',
    },
  });
  assert.equal(httpAttempt.valid, false);

  // Reject localhost / metadata SSRF
  const localhostAttempt = validateCustomApiConfig({
    displayName: 'Loopback SSRF',
    authType: 'none',
    hasSecret: false,
    customApi: {
      baseUrl: 'https://localhost:8443',
      endpointPath: '/admin',
      httpMethod: 'GET',
    },
  });
  assert.equal(localhostAttempt.valid, false);

  const metadataAttempt = validateCustomApiConfig({
    displayName: 'Cloud Metadata SSRF',
    authType: 'none',
    hasSecret: false,
    customApi: {
      baseUrl: 'https://169.254.169.254',
      endpointPath: '/computeMetadata/v1/',
      httpMethod: 'GET',
    },
  });
  assert.equal(metadataAttempt.valid, false);

  // Reject missing secret when bearer_token selected
  const missingSecret = validateCustomApiConfig({
    displayName: 'CRM REST API',
    authType: 'bearer_token',
    hasSecret: false,
    customApi: {
      baseUrl: 'https://api.crm-cloud.example.com',
      endpointPath: '/v1/contacts',
      httpMethod: 'POST',
    },
  });
  assert.equal(missingSecret.valid, false);

  // Valid HTTPS Custom API config
  const validApi = validateCustomApiConfig({
    displayName: 'Enterprise Billing API',
    authType: 'api_key',
    hasSecret: true,
    customApi: {
      baseUrl: 'https://api.billing-cloud.example.com',
      endpointPath: 'v2/invoices',
      httpMethod: 'POST',
      apiKeyHeaderName: 'X-Billing-Key',
      requestHeaders: { 'X-Client-Version': '2026-10' },
      requestParams: { tenant: 'acme' },
      requestBodySchema: {
        type: 'object',
        required: ['customerId', 'amountCents'],
        properties: {
          customerId: { type: 'string' },
          amountCents: { type: 'number' },
        },
      },
      timeoutMs: 9000,
      allowedOperations: ['create_invoice'],
    },
  });
  assert.equal(validApi.valid, true);
  assert.equal(
    validApi.normalizedFullUrl,
    'https://api.billing-cloud.example.com/v2/invoices'
  );
  assert.equal(validApi.normalized?.endpointPath, '/v2/invoices');

  // Body schema validation
  const schema = validApi.normalized!.requestBodySchema!;
  const badPayload = validatePayloadAgainstBodySchema(
    { customerId: 'cust_1' },
    schema
  );
  assert.equal(badPayload.valid, false);

  const goodPayload = validatePayloadAgainstBodySchema(
    { customerId: 'cust_1', amountCents: 4900 },
    schema
  );
  assert.equal(goodPayload.valid, true);
});

test('5. Centralized Integration Registry zero-secret guarantee & 7-state capability resolution', async () => {
  const tenant = await createIsolatedTenant('registry_check');
  const superSecretValue = `sk_live_NEVER_EXPOSE_${runSuffix}`;

  const n8nInstance = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    providerKey: 'n8n_webhook',
    displayName: 'Verified n8n Instance Without Workflows Yet',
    connectionMode: 'user_owned',
    connectorType: 'webhook',
    connectorCategory: 'automation_platforms',
    authStatus: 'authorized',
    healthStatus: 'healthy',
    verified: true,
    capabilities: ['workflow_automation'],
    configMetadata: {
      authType: 'api_key',
      n8nSetupMode: 'existing_instance',
      n8nBaseUrl: 'https://n8n-verified.example.com',
    },
    plaintextSecret: superSecretValue,
  });

  const integrations = await listIntegrationsByUser(
    tenant.uid,
    tenant.workspaceId
  );

  // Before registering any workflow on an `existing_instance` n8n, readiness is `tested` (NOT `operational`)
  const registryBeforeWf = buildWorkspaceIntegrationRegistry({
    workspaceId: tenant.workspaceId,
    geminiReady: true,
    workspaceIntegrations: integrations,
    n8nWorkflows: [],
    oauthEnv: {
      googleWorkspaceReady: true,
      slackOAuthConfigured: false,
      microsoftOAuthConfigured: false,
    },
    hasLiveGoogleToken: false,
  });

  const serialized = JSON.stringify(registryBeforeWf);
  assert.equal(
    serialized.includes(superSecretValue),
    false,
    'Centralized Integration Registry must NEVER expose plaintext secrets'
  );
  assert.equal(
    serialized.includes('encryptedSecret'),
    false,
    'Centralized Integration Registry must NEVER expose ciphertexts'
  );

  const n8nEntryBefore = registryBeforeWf.find(
    (r) => r.integrationId === n8nInstance.id
  );
  assert.ok(n8nEntryBefore);
  assert.equal(
    n8nEntryBefore.capabilityReadiness,
    'tested',
    'n8n existing_instance with 0 registered workflows must be tested, not operational'
  );

  // Microsoft Outlook without server MICROSOFT_CLIENT_ID must report `unavailable`
  const outlookEntry = registryBeforeWf.find(
    (r) => r.providerKey === 'microsoft_outlook_native'
  );
  assert.equal(outlookEntry?.capabilityReadiness, 'unavailable');

  // Gmail with OAuth configured on server but not yet connected by user must report `available`
  const gmailEntry = registryBeforeWf.find(
    (r) => r.providerKey === 'gmail_native'
  );
  assert.equal(gmailEntry?.capabilityReadiness, 'available');

  // Registering an active workflow promotes n8n to `operational`
  const wf = await upsertN8nWorkflowForIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    integrationId: n8nInstance.id,
    workflowExternalId: 'wf-active-1',
    name: 'Active Support Workflow',
    webhookUrlOrPath: 'https://n8n-verified.example.com/webhook/support',
    httpMethod: 'POST',
    capabilities: ['workflow_automation'],
    active: true,
    discoveredViaApi: false,
  });

  const registryAfterWf = buildWorkspaceIntegrationRegistry({
    workspaceId: tenant.workspaceId,
    geminiReady: true,
    workspaceIntegrations: integrations,
    n8nWorkflows: [wf],
    oauthEnv: {
      googleWorkspaceReady: true,
      slackOAuthConfigured: false,
      microsoftOAuthConfigured: false,
    },
    hasLiveGoogleToken: false,
  });

  const n8nEntryAfter = registryAfterWf.find(
    (r) => r.integrationId === n8nInstance.id
  );
  assert.equal(n8nEntryAfter?.capabilityReadiness, 'operational');

  const capEval = evaluateWorkspaceCapabilities(registryAfterWf);
  assert.equal(capEval.matrix.workflow_automation, 'operational');
  assert.equal(capEval.matrix.ai_reasoning, 'operational');
});

test('6. Intelligent Workforce Configuration Manager strict activation gating & AI Providers health', async () => {
  const tenant = await createIsolatedTenant('workforce_mgr');

  const intent = detectWorkforceOrConnectorIntent(
    'Create an AI employee that manages my customer support'
  );
  assert.equal(intent.matched, true);
  assert.equal(intent.kind, 'workforce_configuration');

  const blueprint = analyzeWorkforceRequest(
    'Create an AI employee that manages my customer support'
  );
  assert.ok(blueprint.requiredCapabilities.includes('email_read'));
  assert.ok(blueprint.requiredCapabilities.includes('message_dispatch'));
  assert.ok(blueprint.requiredCapabilities.includes('team_messaging'));
  assert.ok(blueprint.requiredCapabilities.includes('crm_sync'));

  // Evaluate against fresh workspace where external apps are NOT connected yet
  const emptyRegistry = buildWorkspaceIntegrationRegistry({
    workspaceId: tenant.workspaceId,
    geminiReady: true,
    workspaceIntegrations: [],
    n8nWorkflows: [],
    oauthEnv: {
      googleWorkspaceReady: true,
      slackOAuthConfigured: false,
      microsoftOAuthConfigured: false,
    },
    hasLiveGoogleToken: false,
  });

  const initialReadiness = evaluateWorkforceReadiness({
    blueprint,
    registry: emptyRegistry,
  });

  assert.equal(
    initialReadiness.allOperational,
    false,
    'Workforce MUST NOT be marked operational when required external capabilities are not connected and verified'
  );
  assert.ok(initialReadiness.activationBlockerReason);
  assert.ok(initialReadiness.recommendedConnectors.length >= 3);
  for (const rec of initialReadiness.recommendedConnectors) {
    assert.ok(
      rec.reasonNeeded.length > 10,
      'Each recommended connector must include a clear explanation of why it is needed'
    );
  }

  // Test Modify override: swap `slack_native` -> `telegram_native`
  const modifiedReadiness = evaluateWorkforceReadiness({
    blueprint,
    registry: emptyRegistry,
    preferredOverrides: { team_messaging: 'telegram_native' },
  });
  assert.ok(
    modifiedReadiness.recommendedConnectors.some(
      (r) => r.providerKey === 'telegram_native'
    )
  );

  // Now simulate all required connectors operational and verify workforce unlocks!
  const gmailConn = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    providerKey: 'gmail_native',
    displayName: 'Support Gmail',
    connectionMode: 'user_owned',
    connectorType: 'native_oauth',
    connectorCategory: 'connected_apps',
    authStatus: 'authorized',
    healthStatus: 'healthy',
    verified: true,
    capabilities: ['email_read', 'message_dispatch'],
    configMetadata: { authType: 'google_workspace_oauth' },
  });
  assert.ok(gmailConn);

  const telegramConn = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    providerKey: 'telegram_native',
    displayName: 'Support Escalation Bot',
    connectionMode: 'user_owned',
    connectorType: 'native_token',
    connectorCategory: 'connected_apps',
    authStatus: 'authorized',
    healthStatus: 'healthy',
    verified: true,
    capabilities: ['team_messaging'],
    configMetadata: { authType: 'bot_token', telegramDefaultChatId: '-100999' },
    plaintextSecret: '123456:ABCDEF_valid_bot_token',
  });
  assert.ok(telegramConn);

  const crmConn = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    providerKey: 'crm_webhook',
    displayName: 'Support CRM Sync',
    connectionMode: 'user_owned',
    connectorType: 'webhook',
    connectorCategory: 'webhooks',
    authStatus: 'authorized',
    healthStatus: 'healthy',
    verified: true,
    capabilities: ['crm_sync'],
    configMetadata: {
      authType: 'bearer_token',
      endpointUrl: 'https://crm.support.example.com/sync',
    },
    plaintextSecret: 'crm_secret_token_123',
  });
  assert.ok(crmConn);

  const populatedIntegrations = await listIntegrationsByUser(
    tenant.uid,
    tenant.workspaceId
  );
  const readyRegistry = buildWorkspaceIntegrationRegistry({
    workspaceId: tenant.workspaceId,
    geminiReady: true,
    workspaceIntegrations: populatedIntegrations,
    n8nWorkflows: [],
    oauthEnv: {
      googleWorkspaceReady: true,
      slackOAuthConfigured: false,
      microsoftOAuthConfigured: false,
    },
    hasLiveGoogleToken: true,
  });

  const operationalReadiness = evaluateWorkforceReadiness({
    blueprint,
    registry: readyRegistry,
    preferredOverrides: {
      team_messaging: 'telegram_native',
      crm_sync: 'crm_webhook',
    },
  });
  assert.equal(operationalReadiness.allOperational, true);
  assert.equal(operationalReadiness.activationBlockerReason, null);

  // Verify AI Providers configuration & Gemini default readiness
  const aiProviders = await listWorkspaceAiProviders({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
  });
  const geminiProv = aiProviders.find((p) => p.providerId === 'gemini');
  assert.ok(geminiProv);
  assert.equal(geminiProv.isBuiltInDefault, true);
  assert.equal(geminiProv.enabled, true);

  const updatedProviders = await updateWorkspaceAiProviderSettings({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    providerId: 'gemini',
    preferredModel: 'gemini-3.1-pro-preview',
    fallbackPriority: 1,
  });
  assert.equal(
    updatedProviders.find((p) => p.providerId === 'gemini')?.preferredModel,
    'gemini-3.1-pro-preview'
  );

  // Optional OpenAI without server env key returns honest health failure without crashing
  const openaiHealth = await runAiProviderHealthCheck({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    providerId: 'openai',
  });
  if (!process.env.OPENAI_API_KEY) {
    assert.equal(openaiHealth.healthy, false);
  }
});

test('7. End-to-end Orchestrator routing & execution across Custom API and Native Slack connectors', async () => {
  const tenant = await createIsolatedTenant('e2e_exec');

  // 1. Verified Custom REST API Connector
  const customApiConn = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    providerKey: 'custom_api',
    displayName: 'Order Fulfillment API',
    connectionMode: 'user_owned',
    connectorType: 'custom_api',
    connectorCategory: 'custom_api',
    authStatus: 'authorized',
    healthStatus: 'healthy',
    verified: true,
    capabilities: ['custom_api_execution', 'http_request'],
    configMetadata: {
      authType: 'bearer_token',
      endpointUrl: 'https://api.fulfillment.example.com/v1/orders',
      destinationOrigin: 'https://api.fulfillment.example.com',
      customApi: {
        baseUrl: 'https://api.fulfillment.example.com',
        httpMethod: 'POST',
        endpointPath: '/v1/orders',
        requestHeaders: { 'X-Source': 'TaskAI' },
        requestParams: { env: 'prod' },
        requestBodySchema: {
          type: 'object',
          required: ['taskId', 'description'],
        },
        timeoutMs: 8000,
        allowedOperations: ['create_order'],
      },
    },
    plaintextSecret: 'fulfillment_bearer_secret_777',
  });

  // 2. Verified Native Slack Connector
  const slackConn = await createUserIntegration({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    providerKey: 'slack_native',
    displayName: 'Ops Slack Bot',
    connectionMode: 'user_owned',
    connectorType: 'native_token',
    connectorCategory: 'connected_apps',
    authStatus: 'authorized',
    healthStatus: 'healthy',
    verified: true,
    capabilities: ['team_messaging', 'message_dispatch'],
    configMetadata: {
      authType: 'bot_token',
      slackDefaultChannel: '#fulfillment-alerts',
    },
    plaintextSecret: 'xoxb-test-slack-bot-token-999',
  });

  const wsIntegrations = await listIntegrationsByUser(
    tenant.uid,
    tenant.workspaceId
  );

  const goal = await createGoalForUser({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    problem: 'Dispatch order creation and notify Slack channel',
    targetMetric: '2 fulfilled orders',
  });

  const apiTask = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Create fulfillment order record via Custom API',
    tool: 'custom_api',
    requiredCapabilities: ['custom_api_execution'],
    actionCategory: 'external_workflow',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'POST /v1/orders',
      targetRecipient: 'https://api.fulfillment.example.com/v1/orders',
      estimatedCost: '$0',
      explanation: 'Dispatch fulfillment order via Custom REST API',
    },
    expectedResult: 'HTTP 201 order created',
    verificationMethod: 'webhook_delivery_receipt',
  });

  const slackTask = await createSingleTaskForGoal({
    userId: tenant.uid,
    goalId: goal.id,
    description: 'Post fulfillment alert to #fulfillment-alerts on Slack',
    tool: 'slack_native',
    requiredCapabilities: ['team_messaging'],
    actionCategory: 'message_send',
    dependencies: [],
    approvalRequired: true,
    proposedActionDetails: {
      proposedAction: 'Post Slack message',
      targetRecipient: '#fulfillment-alerts',
      estimatedCost: '$0',
      explanation: 'Notify ops team of order creation',
    },
    expectedResult: 'Slack message ts returned',
    verificationMethod: 'api_response_id',
  });

  // Approve both consequential tasks
  const approvedApiTask = await recordApprovalDecision({
    taskId: apiTask.id,
    userId: tenant.uid,
    decision: 'approved',
  });
  const approvedSlackTask = await recordApprovalDecision({
    taskId: slackTask.id,
    userId: tenant.uid,
    decision: 'approved',
  });
  assert.ok(approvedApiTask);
  assert.ok(approvedSlackTask);

  // Resolve routes via capability router
  const apiRoute = resolveExecutionRoute({
    task: approvedApiTask,
    userIntegrations: wsIntegrations,
    builtInProviders: { llmReasoningReady: true, internalTestReady: true },
  });
  assert.equal(apiRoute.routable, true);
  if (!apiRoute.routable) throw new Error('Expected routable custom_api');
  assert.equal(apiRoute.integrationId, customApiConn.id);

  const slackRoute = resolveExecutionRoute({
    task: approvedSlackTask,
    userIntegrations: wsIntegrations,
    builtInProviders: { llmReasoningReady: true, internalTestReady: true },
  });
  assert.equal(slackRoute.routable, true);
  if (!slackRoute.routable) throw new Error('Expected routable slack_native');
  assert.equal(slackRoute.integrationId, slackConn.id);

  // Execute Custom API task with mock transport
  const capturedCalls: SafeOutboundHttpRequestParams[] = [];
  const apiExecResult = await executeRoutedTask({
    userId: tenant.uid,
    problem: goal.problem,
    targetMetric: goal.targetMetric,
    task: approvedApiTask,
    route: apiRoute,
    prerequisiteOutputs: [],
    fullHttpTransport: async (req) => {
      capturedCalls.push(req);
      return {
        ok: true,
        status: 201,
        destinationOrigin: 'https://api.fulfillment.example.com',
        headers: {},
        responseText: JSON.stringify({ orderId: 'ord_9001', status: 'queued' }),
      };
    },
  });

  assert.equal(apiExecResult.awaitingExternalOutcomeVerification, true);
  assert.equal(capturedCalls[0]?.method, 'POST');
  assert.equal(
    capturedCalls[0]?.headers?.Authorization,
    'Bearer fulfillment_bearer_secret_777'
  );

  // Execute Native Slack task with mock transport
  const slackExecResult = await executeRoutedTask({
    userId: tenant.uid,
    problem: goal.problem,
    targetMetric: goal.targetMetric,
    task: approvedSlackTask,
    route: slackRoute,
    prerequisiteOutputs: [],
    fullHttpTransport: async (req) => {
      capturedCalls.push(req);
      return {
        ok: true,
        status: 200,
        destinationOrigin: 'https://slack.com',
        headers: {},
        responseText: JSON.stringify({
          ok: true,
          channel: 'C0123OPS',
          ts: '1730000123.000100',
        }),
      };
    },
  });

  assert.equal(slackExecResult.integrationId, slackConn.id);
  assert.ok(slackExecResult.completedSummary.includes('Slack'));

  // Activity logs persisted without secret leakage
  const logs = await listIntegrationActivityLogs({
    userId: tenant.uid,
    workspaceId: tenant.workspaceId,
    limit: 10,
  });
  assert.ok(logs.length >= 2);
  const logsJson = JSON.stringify(logs);
  assert.equal(logsJson.includes('fulfillment_bearer_secret_777'), false);
  assert.equal(logsJson.includes('xoxb-test-slack-bot-token-999'), false);
});
