import type {
  CapabilityId,
  CapabilityReadinessState,
  CapabilityStatusEntry,
  ConnectorAuthStatus,
  ConnectorHealthStatus,
  ConnectorType,
  IntegrationCenterCategory,
  IntegrationProviderKey,
  IntegrationRegistryEntry,
  N8nRegisteredWorkflowRecord,
  ProviderRateLimitInfo,
  ToolId,
  UserIntegrationRecord,
} from '../types.ts';

export interface ConnectorCatalogItem {
  providerKey: ToolId;
  name: string;
  description: string;
  connectorType: ConnectorType;
  category: IntegrationCenterCategory;
  recommended: boolean;
  authenticationType: string;
  defaultScopes: string[];
  capabilities: CapabilityId[];
  supportedOperations: string[];
  rateLimit: ProviderRateLimitInfo;
  requiresServerOAuthClient?: 'slack' | 'microsoft';
  supportsTokenFallback?: boolean;
}

export const CAPABILITY_LABELS: Record<CapabilityId, string> = {
  ai_reasoning: 'AI Reasoning & Analysis',
  content_drafting: 'Content & Outreach Drafting',
  prospect_qualification: 'Prospect Qualification',
  diagnostic_verification: 'Deterministic Diagnostic Verification',
  workflow_automation: 'Multi-Step Workflow Automation',
  message_dispatch: 'Email & Outbound Message Dispatch',
  crm_sync: 'CRM Record Sync & Updates',
  prospect_search: 'Prospect & Lead Discovery',
  http_request: 'External HTTPS Request Execution',
  calendar_booking: 'Calendar Event Scheduling',
  payment_verification: 'Payment & Invoice Verification',
  email_read: 'Inbox Reading & Triage',
  calendar_read: 'Calendar Availability Lookup',
  file_storage: 'Cloud Document & File Storage',
  team_messaging: 'Team Chat & Channel Alerts',
  custom_api_execution: 'Custom REST API Operations',
};

export const CONNECTOR_CATALOG: readonly ConnectorCatalogItem[] = [
  {
    providerKey: 'gmail_native',
    name: 'Gmail',
    description:
      'Read inbox threads, triage incoming customer emails, create drafts, and dispatch user-confirmed messages via Google Workspace OAuth 2.0.',
    connectorType: 'native_oauth',
    category: 'connected_apps',
    recommended: true,
    authenticationType: 'Google Workspace OAuth 2.0 (In-Memory Token)',
    defaultScopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
    capabilities: ['email_read', 'message_dispatch'],
    supportedOperations: [
      'read_profile',
      'list_messages',
      'create_draft',
      'send_message_confirmed',
    ],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
  },
  {
    providerKey: 'google_calendar_native',
    name: 'Google Calendar',
    description:
      'Check primary calendar availability, inspect upcoming meetings, and schedule or update events with explicit user confirmation.',
    connectorType: 'native_oauth',
    category: 'connected_apps',
    recommended: true,
    authenticationType: 'Google Workspace OAuth 2.0 (In-Memory Token)',
    defaultScopes: ['https://www.googleapis.com/auth/calendar.events'],
    capabilities: ['calendar_read', 'calendar_booking'],
    supportedOperations: [
      'read_primary_calendar',
      'list_upcoming_events',
      'create_event_confirmed',
    ],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
  },
  {
    providerKey: 'google_drive_native',
    name: 'Google Drive',
    description:
      'Store Task.ai generated reports, spreadsheets, and deliverables directly in Google Drive (`drive.file` least-privilege scope).',
    connectorType: 'native_oauth',
    category: 'connected_apps',
    recommended: true,
    authenticationType: 'Google Workspace OAuth 2.0 (In-Memory Token)',
    defaultScopes: ['https://www.googleapis.com/auth/drive.file'],
    capabilities: ['file_storage'],
    supportedOperations: [
      'get_drive_quota',
      'list_app_files',
      'upload_file_confirmed',
    ],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
  },
  {
    providerKey: 'slack_native',
    name: 'Slack',
    description:
      'Post operational updates, approval notifications, and support summaries to Slack channels via Slack OAuth 2.0 or an encrypted Bot Token.',
    connectorType: 'native_oauth',
    category: 'connected_apps',
    recommended: true,
    authenticationType: 'Slack OAuth 2.0 / Encrypted Bot Token (xoxb)',
    defaultScopes: ['chat:write', 'channels:read'],
    capabilities: ['team_messaging', 'message_dispatch'],
    supportedOperations: ['auth_test', 'post_channel_message'],
    rateLimit: { requestsPerMinute: 50, burstLimit: 12 },
    requiresServerOAuthClient: 'slack',
    supportsTokenFallback: true,
  },
  {
    providerKey: 'telegram_native',
    name: 'Telegram Bot',
    description:
      'Send real-time workforce alerts and customer notifications through an encrypted Telegram Bot API token.',
    connectorType: 'native_token',
    category: 'connected_apps',
    recommended: false,
    authenticationType: 'Telegram Bot Token (AES-256-GCM Encrypted)',
    defaultScopes: ['bot:getMe', 'bot:sendMessage'],
    capabilities: ['team_messaging', 'message_dispatch'],
    supportedOperations: ['get_bot_identity', 'send_chat_message'],
    rateLimit: { requestsPerMinute: 30, burstLimit: 10 },
  },
  {
    providerKey: 'microsoft_outlook_native',
    name: 'Microsoft Outlook',
    description:
      'Read Outlook mail, send replies, and coordinate Microsoft 365 calendar bookings via Microsoft Graph OAuth 2.0.',
    connectorType: 'native_oauth',
    category: 'connected_apps',
    recommended: false,
    authenticationType: 'Microsoft Graph OAuth 2.0',
    defaultScopes: [
      'offline_access',
      'User.Read',
      'Mail.ReadWrite',
      'Mail.Send',
      'Calendars.ReadWrite',
    ],
    capabilities: [
      'email_read',
      'message_dispatch',
      'calendar_read',
      'calendar_booking',
    ],
    supportedOperations: ['read_profile', 'list_messages', 'send_mail', 'create_event'],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
    requiresServerOAuthClient: 'microsoft',
    supportsTokenFallback: false,
  },
  {
    providerKey: 'microsoft_teams_native',
    name: 'Microsoft Teams',
    description:
      'Deliver workforce alerts and collaborate across Microsoft Teams channels via Microsoft Graph OAuth 2.0.',
    connectorType: 'native_oauth',
    category: 'connected_apps',
    recommended: false,
    authenticationType: 'Microsoft Graph OAuth 2.0',
    defaultScopes: ['offline_access', 'User.Read', 'Chat.ReadWrite', 'ChannelMessage.Send'],
    capabilities: ['team_messaging', 'message_dispatch'],
    supportedOperations: ['read_profile', 'send_channel_message'],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
    requiresServerOAuthClient: 'microsoft',
    supportsTokenFallback: false,
  },
  {
    providerKey: 'n8n_webhook',
    name: 'n8n Automation Platform',
    description:
      'Connect an existing n8n instance with API workflow discovery or configure isolated signed HTTPS webhook workflows per workspace.',
    connectorType: 'webhook',
    category: 'automation_platforms',
    recommended: true,
    authenticationType: 'n8n REST API Key + HMAC-SHA256 / Bearer Webhook Signing',
    defaultScopes: ['workflow:execute', 'webhook:signed'],
    capabilities: [
      'workflow_automation',
      'message_dispatch',
      'crm_sync',
      'prospect_search',
      'http_request',
      'calendar_booking',
      'payment_verification',
      'custom_api_execution',
    ],
    supportedOperations: [
      'discover_workflows',
      'register_workflow',
      'trigger_signed_workflow',
      'receive_inbound_evidence',
    ],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
  },
  {
    providerKey: 'make_webhook',
    name: 'Make (Integromat)',
    description:
      'Trigger multi-app Make scenarios over SSRF-protected HTTPS webhooks with idempotency and callback verification.',
    connectorType: 'webhook',
    category: 'automation_platforms',
    recommended: false,
    authenticationType: 'Header Secret / Bearer / HMAC-SHA256',
    defaultScopes: ['scenario:webhook'],
    capabilities: [
      'workflow_automation',
      'message_dispatch',
      'crm_sync',
      'prospect_search',
      'http_request',
    ],
    supportedOperations: ['connection_probe', 'trigger_scenario'],
    rateLimit: { requestsPerMinute: 45, burstLimit: 12 },
  },
  {
    providerKey: 'zapier_webhook',
    name: 'Zapier',
    description:
      'Dispatch structured Task.ai execution payloads to Zapier Catch Hooks with retry safety and deduplication.',
    connectorType: 'webhook',
    category: 'automation_platforms',
    recommended: false,
    authenticationType: 'Header Secret / Bearer / HMAC-SHA256',
    defaultScopes: ['zap:catch_hook'],
    capabilities: [
      'workflow_automation',
      'message_dispatch',
      'crm_sync',
      'calendar_booking',
    ],
    supportedOperations: ['connection_probe', 'trigger_zap'],
    rateLimit: { requestsPerMinute: 45, burstLimit: 12 },
  },
  {
    providerKey: 'custom_api',
    name: 'Custom REST API Connector',
    description:
      'Connect any HTTPS REST endpoint (GET, POST, PUT, PATCH, DELETE) with Bearer, API Key, OAuth2, or Basic Auth, schema validation, and SSRF protection.',
    connectorType: 'custom_api',
    category: 'custom_api',
    recommended: true,
    authenticationType: 'Bearer / API Key / OAuth2 Token / Basic Auth (Encrypted)',
    defaultScopes: ['api:custom_operations'],
    capabilities: [
      'custom_api_execution',
      'http_request',
      'crm_sync',
      'prospect_search',
      'message_dispatch',
    ],
    supportedOperations: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
  },
  {
    providerKey: 'custom_webhook',
    name: 'Custom HTTPS Webhook',
    description:
      'Send HMAC-SHA256 signed JSON event envelopes to your own internal microservice or serverless HTTPS endpoint.',
    connectorType: 'webhook',
    category: 'webhooks',
    recommended: false,
    authenticationType: 'HMAC-SHA256 / Bearer / Custom Header Secret',
    defaultScopes: ['webhook:post'],
    capabilities: [
      'http_request',
      'workflow_automation',
      'message_dispatch',
      'crm_sync',
      'prospect_search',
    ],
    supportedOperations: ['connection_probe', 'signed_post_dispatch'],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
  },
  {
    providerKey: 'crm_webhook',
    name: 'CRM Sync Webhook',
    description:
      'Synchronize qualified leads, contact stages, and deal updates with HubSpot, Pipedrive, Salesforce, or custom CRMs.',
    connectorType: 'webhook',
    category: 'webhooks',
    recommended: false,
    authenticationType: 'Bearer Token / Header Secret / HMAC-SHA256',
    defaultScopes: ['crm:leads:write'],
    capabilities: ['crm_sync', 'prospect_search'],
    supportedOperations: ['connection_probe', 'sync_crm_record'],
    rateLimit: { requestsPerMinute: 40, burstLimit: 10 },
  },
  {
    providerKey: 'payment_webhook',
    name: 'Payment Verification Webhook',
    description:
      'Dispatch invoice links and ingest signed payment confirmation webhooks from Stripe, Paystack, or Flutterwave bridges.',
    connectorType: 'webhook',
    category: 'webhooks',
    recommended: false,
    authenticationType: 'HMAC-SHA256 / Bearer Token',
    defaultScopes: ['payment:verify'],
    capabilities: ['payment_verification', 'http_request'],
    supportedOperations: ['connection_probe', 'verify_payment_event'],
    rateLimit: { requestsPerMinute: 30, burstLimit: 8 },
  },
  {
    providerKey: 'gmail_api',
    name: 'Outbound Email Webhook Bridge',
    description:
      'Send transactional or outreach emails through an external HTTPS mail relay or transactional email bridge.',
    connectorType: 'webhook',
    category: 'webhooks',
    recommended: false,
    authenticationType: 'Bearer Token / HMAC-SHA256',
    defaultScopes: ['email:relay'],
    capabilities: ['message_dispatch'],
    supportedOperations: ['connection_probe', 'relay_email'],
    rateLimit: { requestsPerMinute: 30, burstLimit: 8 },
  },
  {
    providerKey: 'google_calendar_api',
    name: 'Calendar Booking Webhook Bridge',
    description:
      'Dispatch meeting booking requests to an external scheduling webhook bridge.',
    connectorType: 'webhook',
    category: 'webhooks',
    recommended: false,
    authenticationType: 'Bearer Token / HMAC-SHA256',
    defaultScopes: ['calendar:relay'],
    capabilities: ['calendar_booking'],
    supportedOperations: ['connection_probe', 'relay_calendar_booking'],
    rateLimit: { requestsPerMinute: 30, burstLimit: 8 },
  },
];

export interface OAuthEnvironmentReadiness {
  googleWorkspaceReady: boolean;
  slackOAuthConfigured: boolean;
  microsoftOAuthConfigured: boolean;
}

export function getCatalogItemForProvider(
  providerKey: string
): ConnectorCatalogItem | undefined {
  return CONNECTOR_CATALOG.find((item) => item.providerKey === providerKey);
}

const READINESS_RANK: Record<CapabilityReadinessState, number> = {
  unavailable: 0,
  available: 1,
  connected: 2,
  authorized: 3,
  configured: 4,
  tested: 5,
  operational: 6,
};

export function isGoogleWorkspaceProviderKey(providerKey: string): boolean {
  return (
    providerKey === 'gmail_native' ||
    providerKey === 'google_calendar_native' ||
    providerKey === 'google_drive_native'
  );
}

/**
 * Computes the exact 7-state capability readiness for a single workspace integration
 * without ever reading or exposing secret values.
 */
export function computeIntegrationReadinessState(params: {
  catalogItem?: ConnectorCatalogItem;
  integration: UserIntegrationRecord | null;
  oauthEnv: OAuthEnvironmentReadiness;
  hasLiveGoogleToken?: boolean;
  activeN8nWorkflowCount?: number;
}): {
  readiness: CapabilityReadinessState;
  connectionStatus: IntegrationRegistryEntry['connectionStatus'];
  authStatus: ConnectorAuthStatus;
  healthStatus: ConnectorHealthStatus;
  oauthAppConfigured: boolean;
  reconnectRequired: boolean;
} {
  const {
    catalogItem,
    integration,
    oauthEnv,
    hasLiveGoogleToken = false,
    activeN8nWorkflowCount = 0,
  } = params;

  const oauthAppConfigured = catalogItem?.requiresServerOAuthClient
    ? catalogItem.requiresServerOAuthClient === 'slack'
      ? oauthEnv.slackOAuthConfigured
      : oauthEnv.microsoftOAuthConfigured
    : true;

  if (!integration) {
    const canConnect =
      oauthAppConfigured || Boolean(catalogItem?.supportsTokenFallback);
    return {
      readiness: canConnect ? 'available' : 'unavailable',
      connectionStatus: 'not_connected',
      authStatus: 'not_connected',
      healthStatus: 'untested',
      oauthAppConfigured,
      reconnectRequired: false,
    };
  }

  if (!integration.enabled) {
    return {
      readiness: 'unavailable',
      connectionStatus: 'disabled',
      authStatus: integration.authStatus ?? 'configured',
      healthStatus: 'disabled',
      oauthAppConfigured,
      reconnectRequired: false,
    };
  }

  const rawAuth: ConnectorAuthStatus =
    integration.authStatus ?? (integration.verified ? 'authorized' : 'configured');
  const rawHealth: ConnectorHealthStatus =
    integration.healthStatus ?? (integration.verified ? 'healthy' : 'untested');

  if (rawAuth === 'revoked' || rawAuth === 'error') {
    return {
      readiness: 'unavailable',
      connectionStatus: 'error',
      authStatus: rawAuth,
      healthStatus: 'unhealthy',
      oauthAppConfigured,
      reconnectRequired: true,
    };
  }

  if (rawAuth === 'reconnect_required') {
    return {
      readiness: 'authorized',
      connectionStatus: 'connected',
      authStatus: 'reconnect_required',
      healthStatus: 'degraded',
      oauthAppConfigured,
      reconnectRequired: true,
    };
  }

  // Google Workspace connectors use browser in-memory tokens (unless an encrypted token is stored in test harnesses)
  if (
    isGoogleWorkspaceProviderKey(integration.providerKey) &&
    !hasLiveGoogleToken &&
    !integration.hasSecret
  ) {
    return {
      readiness: 'authorized',
      connectionStatus: 'connected',
      authStatus: 'reconnect_required',
      healthStatus: integration.verified ? 'degraded' : 'untested',
      oauthAppConfigured: oauthEnv.googleWorkspaceReady,
      reconnectRequired: true,
    };
  }

  if (!integration.verified) {
    if (rawHealth === 'unhealthy') {
      return {
        readiness: 'configured',
        connectionStatus: 'error',
        authStatus: rawAuth,
        healthStatus: 'unhealthy',
        oauthAppConfigured,
        reconnectRequired: rawAuth === 'authorized',
      };
    }
    if (rawAuth === 'connected') {
      return {
        readiness: 'connected',
        connectionStatus: 'connected',
        authStatus: 'connected',
        healthStatus: rawHealth,
        oauthAppConfigured,
        reconnectRequired: false,
      };
    }
    if (rawAuth === 'authorized') {
      return {
        readiness: 'authorized',
        connectionStatus: 'connected',
        authStatus: 'authorized',
        healthStatus: rawHealth,
        oauthAppConfigured,
        reconnectRequired: false,
      };
    }
    return {
      readiness: 'configured',
      connectionStatus: 'configured',
      authStatus: rawAuth,
      healthStatus: rawHealth,
      oauthAppConfigured,
      reconnectRequired: false,
    };
  }

  // Integration IS verified (`integration.verified === true`)
  // Special check for n8n in `existing_instance` mode without any endpointUrl and 0 registered workflows:
  if (
    integration.providerKey === 'n8n_webhook' &&
    integration.configMetadata.n8nSetupMode === 'existing_instance' &&
    !integration.configMetadata.endpointUrl &&
    activeN8nWorkflowCount === 0
  ) {
    return {
      readiness: 'tested',
      connectionStatus: 'connected',
      authStatus: rawAuth,
      healthStatus: 'healthy',
      oauthAppConfigured,
      reconnectRequired: false,
    };
  }

  if (rawHealth === 'degraded') {
    return {
      readiness: 'tested',
      connectionStatus: 'connected',
      authStatus: rawAuth,
      healthStatus: 'degraded',
      oauthAppConfigured,
      reconnectRequired: false,
    };
  }

  if (rawHealth === 'unhealthy') {
    return {
      readiness: 'unavailable',
      connectionStatus: 'error',
      authStatus: rawAuth,
      healthStatus: 'unhealthy',
      oauthAppConfigured,
      reconnectRequired: true,
    };
  }

  return {
    readiness: 'operational',
    connectionStatus: 'connected',
    authStatus: rawAuth === 'configured' ? 'configured' : 'authorized',
    healthStatus: 'healthy',
    oauthAppConfigured,
    reconnectRequired: false,
  };
}

/**
 * Builds the sanitized Centralized Integration Registry for a workspace.
 * Safe for AI Planner inspection and frontend rendering — NEVER contains secrets.
 */
export function buildWorkspaceIntegrationRegistry(params: {
  workspaceId: string;
  geminiReady: boolean;
  workspaceIntegrations: UserIntegrationRecord[];
  n8nWorkflows?: N8nRegisteredWorkflowRecord[];
  oauthEnv?: OAuthEnvironmentReadiness;
  hasLiveGoogleToken?: boolean;
}): IntegrationRegistryEntry[] {
  const oauthEnv: OAuthEnvironmentReadiness = params.oauthEnv ?? {
    googleWorkspaceReady: true,
    slackOAuthConfigured: false,
    microsoftOAuthConfigured: false,
  };
  const workflows = params.n8nWorkflows ?? [];
  const entries: IntegrationRegistryEntry[] = [];

  // 1. Built-in Gemini Reasoning Engine
  entries.push({
    connectorId: `builtin:${params.workspaceId}:llm_reasoning`,
    workspaceId: params.workspaceId,
    providerKey: 'llm_reasoning',
    connectorName: 'Task.ai Built-In Gemini Reasoning',
    description:
      'Server-side Gemini reasoning, planning, drafting, and qualification runtime.',
    connectorType: 'built_in',
    category: 'ai_providers',
    recommended: true,
    authenticationType: 'Server-Side Managed API Key',
    connectionStatus: params.geminiReady ? 'connected' : 'error',
    authorizationStatus: params.geminiReady ? 'authorized' : 'not_connected',
    authorizationScopes: ['ai:generateContent'],
    availableCapabilities: [
      'ai_reasoning',
      'content_drafting',
      'prospect_qualification',
    ],
    supportedOperations: ['plan_goal', 'draft_content', 'reason_outcomes'],
    rateLimit: { requestsPerMinute: 30, burstLimit: 10 },
    healthStatus: params.geminiReady ? 'healthy' : 'unhealthy',
    capabilityReadiness: params.geminiReady ? 'operational' : 'unavailable',
    lastSuccessfulConnection: null,
    lastActivity: null,
    failureInformation: params.geminiReady
      ? null
      : 'Server GEMINI_API_KEY is not configured.',
    integrationId: null,
    oauthAppConfigured: true,
    reconnectRequired: false,
  });

  // 2. Built-in Deterministic Verification Worker
  entries.push({
    connectorId: `builtin:${params.workspaceId}:internal_test_tool`,
    workspaceId: params.workspaceId,
    providerKey: 'internal_test_tool',
    connectorName: 'Deterministic Diagnostic Worker',
    description:
      'Built-in harmless diagnostic and SHA-256 invariant verification worker.',
    connectorType: 'built_in',
    category: 'connected_apps',
    recommended: false,
    authenticationType: 'Internal Runtime Isolation',
    connectionStatus: 'connected',
    authorizationStatus: 'authorized',
    authorizationScopes: ['internal:diagnostic'],
    availableCapabilities: ['diagnostic_verification'],
    supportedOperations: ['verify_sha256_invariant'],
    rateLimit: { requestsPerMinute: 120, burstLimit: 30 },
    healthStatus: 'healthy',
    capabilityReadiness: 'operational',
    lastSuccessfulConnection: null,
    lastActivity: null,
    failureInformation: null,
    integrationId: null,
    oauthAppConfigured: true,
    reconnectRequired: false,
  });

  const handledIntegrationIds = new Set<string>();

  // 3. Catalog Connectors + Bound Workspace Instances
  for (const cat of CONNECTOR_CATALOG) {
    const matching = params.workspaceIntegrations.filter(
      (i) => i.providerKey === cat.providerKey
    );

    if (matching.length === 0) {
      const state = computeIntegrationReadinessState({
        catalogItem: cat,
        integration: null,
        oauthEnv,
        hasLiveGoogleToken: params.hasLiveGoogleToken,
      });

      entries.push({
        connectorId: `catalog:${params.workspaceId}:${cat.providerKey}`,
        workspaceId: params.workspaceId,
        providerKey: cat.providerKey,
        connectorName: cat.name,
        description: cat.description,
        connectorType: cat.connectorType,
        category: cat.category,
        recommended: cat.recommended,
        authenticationType: cat.authenticationType,
        connectionStatus: state.connectionStatus,
        authorizationStatus: state.authStatus,
        authorizationScopes: cat.defaultScopes,
        availableCapabilities: [...cat.capabilities],
        supportedOperations: [...cat.supportedOperations],
        rateLimit: cat.rateLimit,
        healthStatus: state.healthStatus,
        capabilityReadiness: state.readiness,
        lastSuccessfulConnection: null,
        lastActivity: null,
        failureInformation: state.oauthAppConfigured
          ? null
          : cat.supportsTokenFallback
            ? null
            : `Requires server OAuth client configuration (${cat.requiresServerOAuthClient?.toUpperCase()}_CLIENT_ID).`,
        integrationId: null,
        oauthAppConfigured: state.oauthAppConfigured,
        reconnectRequired: false,
        registeredWorkflowCount:
          cat.providerKey === 'n8n_webhook' ? 0 : undefined,
      });
      continue;
    }

    for (const integ of matching) {
      handledIntegrationIds.add(integ.id);
      const integWorkflows = workflows.filter(
        (w) => w.integrationId === integ.id && w.active
      );
      const workflowCaps = new Set<CapabilityId>(integ.capabilities);
      for (const wf of integWorkflows) {
        for (const c of wf.capabilities) {
          workflowCaps.add(c);
        }
      }

      const state = computeIntegrationReadinessState({
        catalogItem: cat,
        integration: integ,
        oauthEnv,
        hasLiveGoogleToken: params.hasLiveGoogleToken,
        activeN8nWorkflowCount: integWorkflows.length,
      });

      const customOps =
        integ.providerKey === 'custom_api' &&
        integ.configMetadata.customApi?.allowedOperations?.length
          ? integ.configMetadata.customApi.allowedOperations
          : cat.supportedOperations;

      entries.push({
        connectorId: integ.id,
        workspaceId: params.workspaceId,
        providerKey: cat.providerKey,
        connectorName: integ.displayName || cat.name,
        description: cat.description,
        connectorType: integ.connectorType ?? cat.connectorType,
        category: integ.connectorCategory ?? cat.category,
        recommended: cat.recommended,
        authenticationType: cat.authenticationType,
        connectionStatus: state.connectionStatus,
        authorizationStatus: state.authStatus,
        authorizationScopes:
          integ.grantedScopes && integ.grantedScopes.length > 0
            ? integ.grantedScopes
            : cat.defaultScopes,
        availableCapabilities: Array.from(workflowCaps),
        supportedOperations: [...customOps],
        rateLimit: {
          requestsPerMinute: integ.rateLimitRpm ?? cat.rateLimit.requestsPerMinute,
          burstLimit: cat.rateLimit.burstLimit,
        },
        healthStatus: state.healthStatus,
        capabilityReadiness: state.readiness,
        lastSuccessfulConnection:
          integ.lastSuccessAt ?? (integ.verified ? integ.lastTestedAt : null),
        lastActivity: integ.lastActivityAt ?? integ.updatedAt,
        failureInformation: state.reconnectRequired
          ? integ.lastErrorMessage ||
            'Session token expired or missing. Reconnect to restore live execution.'
          : integ.lastErrorMessage ??
            (!integ.verified && state.healthStatus === 'unhealthy'
              ? integ.statusDetail
              : null),
        integrationId: integ.id,
        oauthAppConfigured: state.oauthAppConfigured,
        reconnectRequired: state.reconnectRequired,
        registeredWorkflowCount:
          cat.providerKey === 'n8n_webhook' ? integWorkflows.length : undefined,
      });
    }
  }

  // Include any uncatalogued custom integrations defensively
  for (const integ of params.workspaceIntegrations) {
    if (handledIntegrationIds.has(integ.id)) continue;
    const state = computeIntegrationReadinessState({
      integration: integ,
      oauthEnv,
      hasLiveGoogleToken: params.hasLiveGoogleToken,
    });
    entries.push({
      connectorId: integ.id,
      workspaceId: params.workspaceId,
      providerKey: integ.providerKey,
      connectorName: integ.displayName,
      description: 'Workspace integration connector.',
      connectorType: integ.connectorType ?? 'webhook',
      category: integ.connectorCategory ?? 'webhooks',
      recommended: false,
      authenticationType: integ.configMetadata.authType,
      connectionStatus: state.connectionStatus,
      authorizationStatus: state.authStatus,
      authorizationScopes: integ.grantedScopes ?? [],
      availableCapabilities: integ.capabilities,
      supportedOperations: ['execute'],
      rateLimit: {
        requestsPerMinute: integ.rateLimitRpm ?? 60,
        burstLimit: 15,
      },
      healthStatus: state.healthStatus,
      capabilityReadiness: state.readiness,
      lastSuccessfulConnection: integ.lastSuccessAt ?? null,
      lastActivity: integ.lastActivityAt ?? integ.updatedAt,
      failureInformation: integ.lastErrorMessage ?? null,
      integrationId: integ.id,
      oauthAppConfigured: true,
      reconnectRequired: state.reconnectRequired,
    });
  }

  return entries;
}

/**
 * Evaluates workspace-wide capability readiness across all 16 CapabilityIds,
 * distinguishing `available`, `connected`, `authorized`, `configured`, `tested`,
 * `operational`, and `unavailable`.
 */
export function evaluateWorkspaceCapabilities(
  registry: IntegrationRegistryEntry[]
): {
  entries: CapabilityStatusEntry[];
  matrix: Record<CapabilityId, CapabilityReadinessState>;
} {
  const allCaps = Object.keys(CAPABILITY_LABELS) as CapabilityId[];
  const entries: CapabilityStatusEntry[] = [];
  const matrix = {} as Record<CapabilityId, CapabilityReadinessState>;

  for (const cap of allCaps) {
    const supporting = registry.filter((r) =>
      r.availableCapabilities.includes(cap)
    );
    let bestState: CapabilityReadinessState = 'unavailable';
    const operationalProviders: string[] = [];
    const candidateProviders: string[] = [];

    for (const r of supporting) {
      candidateProviders.push(r.connectorName);
      if (READINESS_RANK[r.capabilityReadiness] > READINESS_RANK[bestState]) {
        bestState = r.capabilityReadiness;
      }
      if (r.capabilityReadiness === 'operational') {
        operationalProviders.push(r.connectorName);
      }
    }

    matrix[cap] = bestState;
    const detail =
      bestState === 'operational'
        ? `Operational via ${operationalProviders.join(', ')}.`
        : bestState === 'tested'
          ? 'Connection tested; register an active workflow or resolve degraded health to make operational.'
          : bestState === 'configured'
            ? 'Connector configured; run Test Connection to verify live execution.'
            : bestState === 'authorized'
              ? 'OAuth permissions granted; reconnect or run Test Connection to verify live token.'
              : bestState === 'connected'
                ? 'Account linked; complete configuration and test connection.'
                : bestState === 'available'
                  ? `Available to connect via ${candidateProviders.slice(0, 3).join(', ')}.`
                  : 'No configured or available connector currently provides this capability.';

    entries.push({
      capability: cap,
      label: CAPABILITY_LABELS[cap],
      state: bestState,
      operationalProviders,
      candidateProviders,
      detail,
    });
  }

  return { entries, matrix };
}
