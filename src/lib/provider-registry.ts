import type {
  CapabilityId,
  IntegrationProviderKey,
  ProviderImplementationClass,
  ProviderRateLimitInfo,
  ToolId,
  ToolRegistryItem,
  UserIntegrationRecord,
  VerificationMethodType,
} from '../types.ts';

export interface ProviderDescriptor {
  id: Exclude<ToolId, 'unsupported'>;
  name: string;
  scope: 'built_in' | 'tenant_configurable';
  description: string;
  defaultCapabilities: CapabilityId[];
  authenticationMethod: string;
  executionInterface:
    | 'built_in_runtime'
    | 'https_json_webhook'
    | 'rest_api_bearer';
  verificationCapabilities: VerificationMethodType[];
  rateLimit: ProviderRateLimitInfo;
  supportedOperations: string[];
  implementationStatus:
    | 'implemented_and_tested'
    | 'implemented_requires_external_credentials';
  integrationClassification: ProviderImplementationClass;
}

export const INTEGRATION_PROVIDER_KEYS: ReadonlySet<IntegrationProviderKey> =
  new Set<IntegrationProviderKey>([
    'custom_webhook',
    'n8n_webhook',
    'make_webhook',
    'zapier_webhook',
    'crm_webhook',
    'gmail_api',
    'google_calendar_api',
    'payment_webhook',
    'gmail_native',
    'google_calendar_native',
    'google_drive_native',
    'slack_native',
    'telegram_native',
    'microsoft_outlook_native',
    'microsoft_teams_native',
    'custom_api',
  ]);

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    id: 'llm_reasoning',
    name: 'AI Reasoning & Drafting Provider',
    scope: 'built_in',
    description:
      'Native built-in server-side Gemini SDK runtime for goal decomposition, ICP qualification rubrics, outreach drafting, and continuous cycle analysis.',
    defaultCapabilities: [
      'ai_reasoning',
      'content_drafting',
      'prospect_qualification',
    ],
    authenticationMethod: 'Server-managed GEMINI_API_KEY (never exposed to client)',
    executionInterface: 'built_in_runtime',
    verificationCapabilities: ['deterministic', 'ai_assisted_recommendation'],
    rateLimit: { requestsPerMinute: 60, burstLimit: 10 },
    supportedOperations: [
      'plan_generation',
      'qualification_rubric',
      'message_drafting',
      'continuous_cycle_reasoning',
      'advisory_evidence_review',
    ],
    implementationStatus: 'implemented_and_tested',
    integrationClassification: 'native_implemented',
  },
  {
    id: 'internal_test_tool',
    name: 'Deterministic Diagnostic & Checksum Provider',
    scope: 'built_in',
    description:
      'Native built-in deterministic SHA-256 checksum provider for internal pre-flight checks and fault-injection recovery testing. Isolated from business outcome metrics.',
    defaultCapabilities: ['diagnostic_verification'],
    authenticationMethod: 'Workspace session & database lock isolation',
    executionInterface: 'built_in_runtime',
    verificationCapabilities: ['deterministic'],
    rateLimit: { requestsPerMinute: 600, burstLimit: 100 },
    supportedOperations: [
      'sha256_checksum_verification',
      'prerequisite_artifact_validation',
      'controlled_fault_injection',
    ],
    implementationStatus: 'implemented_and_tested',
    integrationClassification: 'native_implemented',
  },
  {
    id: 'custom_webhook',
    name: 'Custom HTTPS Webhook Adapter',
    scope: 'tenant_configurable',
    description:
      'Generic HTTPS JSON webhook adapter with HMAC-SHA256 / Bearer / custom header signing, IP-pinned SSRF protection, and signed inbound callback ingestion.',
    defaultCapabilities: [
      'workflow_automation',
      'http_request',
      'message_dispatch',
      'crm_sync',
    ],
    authenticationMethod:
      'Per-workspace AES-256-GCM secret (HMAC-SHA256, Bearer, or Header)',
    executionInterface: 'https_json_webhook',
    verificationCapabilities: [
      'evidence_based',
      'human_review',
      'ai_assisted_recommendation',
    ],
    rateLimit: { requestsPerMinute: 120, burstLimit: 20 },
    supportedOperations: [
      'outbound_signed_dispatch',
      'connection_probe',
      'inbound_signed_evidence_webhook',
    ],
    implementationStatus: 'implemented_and_tested',
    integrationClassification: 'generic_webhook_adapter',
  },
  {
    id: 'n8n_webhook',
    name: 'n8n Workflow Webhook Adapter (Optional)',
    scope: 'tenant_configurable',
    description:
      'Generic HTTPS JSON webhook adapter for per-workspace n8n webhook triggers (user-owned or administrator-configured isolated shared n8n workflows).',
    defaultCapabilities: [
      'workflow_automation',
      'message_dispatch',
      'crm_sync',
    ],
    authenticationMethod:
      'HMAC-SHA256 / Bearer / Header secret (+ platform HMAC on shared n8n)',
    executionInterface: 'https_json_webhook',
    verificationCapabilities: [
      'evidence_based',
      'human_review',
      'ai_assisted_recommendation',
    ],
    rateLimit: { requestsPerMinute: 120, burstLimit: 20 },
    supportedOperations: [
      'isolated_workflow_dispatch',
      'connection_probe',
      'inbound_signed_evidence_webhook',
    ],
    implementationStatus: 'implemented_and_tested',
    integrationClassification: 'generic_webhook_adapter',
  },
  {
    id: 'make_webhook',
    name: 'Make.com Custom Webhook Adapter',
    scope: 'tenant_configurable',
    description:
      'Generic HTTPS JSON webhook adapter targeting a Make.com Custom Webhook URL (not a native Make REST API SDK integration).',
    defaultCapabilities: [
      'workflow_automation',
      'http_request',
      'message_dispatch',
      'crm_sync',
    ],
    authenticationMethod: 'Per-workspace Header Secret or HMAC-SHA256 signature',
    executionInterface: 'https_json_webhook',
    verificationCapabilities: ['evidence_based', 'human_review'],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
    supportedOperations: [
      'scenario_webhook_post_dispatch',
      'connection_probe',
      'inbound_outcome_callback',
    ],
    implementationStatus: 'implemented_requires_external_credentials',
    integrationClassification: 'generic_webhook_adapter',
  },
  {
    id: 'zapier_webhook',
    name: 'Zapier Catch Hook Webhook Adapter',
    scope: 'tenant_configurable',
    description:
      'Generic HTTPS JSON webhook adapter targeting a Zapier Catch Hook URL (not a native Zapier OAuth App integration).',
    defaultCapabilities: [
      'workflow_automation',
      'http_request',
      'message_dispatch',
      'crm_sync',
    ],
    authenticationMethod: 'Per-workspace Header Secret or HMAC-SHA256 signature',
    executionInterface: 'https_json_webhook',
    verificationCapabilities: ['evidence_based', 'human_review'],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
    supportedOperations: [
      'zap_catch_hook_post_dispatch',
      'connection_probe',
      'inbound_outcome_callback',
    ],
    implementationStatus: 'implemented_requires_external_credentials',
    integrationClassification: 'generic_webhook_adapter',
  },
  {
    id: 'crm_webhook',
    name: 'CRM HTTPS Webhook Adapter',
    scope: 'tenant_configurable',
    description:
      'Generic HTTPS JSON webhook adapter for forwarding lead/deal task payloads to a user-configured CRM webhook gateway and receiving deal callbacks.',
    defaultCapabilities: ['crm_sync', 'prospect_search', 'http_request'],
    authenticationMethod: 'Bearer Token or HMAC-SHA256 webhook secret',
    executionInterface: 'https_json_webhook',
    verificationCapabilities: ['evidence_based', 'human_review'],
    rateLimit: { requestsPerMinute: 90, burstLimit: 15 },
    supportedOperations: [
      'lead_webhook_post_dispatch',
      'deal_stage_webhook_verification',
      'connection_probe',
    ],
    implementationStatus: 'implemented_requires_external_credentials',
    integrationClassification: 'generic_webhook_adapter',
  },
  {
    id: 'gmail_api',
    name: 'Email Dispatch HTTPS Relay Bridge (Non-Native)',
    scope: 'tenant_configurable',
    description:
      'Partially implemented via generic HTTPS JSON relay bridge (does NOT implement Google OAuth 2.0 or native Gmail users.messages.send MIME API directly). Requires an external HTTPS email relay endpoint.',
    defaultCapabilities: ['message_dispatch', 'http_request'],
    authenticationMethod: 'Relay Bearer Token or HMAC-SHA256 Signing Secret',
    executionInterface: 'https_json_webhook',
    verificationCapabilities: ['evidence_based', 'human_review'],
    rateLimit: { requestsPerMinute: 30, burstLimit: 5 },
    supportedOperations: [
      'https_relay_message_dispatch',
      'delivery_receipt_webhook_ingestion',
      'reply_event_webhook_ingestion',
    ],
    implementationStatus: 'implemented_requires_external_credentials',
    integrationClassification: 'partially_implemented',
  },
  {
    id: 'google_calendar_api',
    name: 'Calendar Scheduling HTTPS Relay Bridge (Non-Native)',
    scope: 'tenant_configurable',
    description:
      'Partially implemented via generic HTTPS JSON relay bridge (does NOT implement Google OAuth 2.0 or native Google Calendar events.insert REST API directly). Requires an external scheduling webhook relay.',
    defaultCapabilities: ['calendar_booking', 'http_request'],
    authenticationMethod: 'Relay Bearer Token or HMAC-SHA256 Signing Secret',
    executionInterface: 'https_json_webhook',
    verificationCapabilities: ['evidence_based', 'human_review'],
    rateLimit: { requestsPerMinute: 60, burstLimit: 10 },
    supportedOperations: [
      'https_relay_booking_dispatch',
      'booking_confirmation_webhook_ingestion',
    ],
    implementationStatus: 'implemented_requires_external_credentials',
    integrationClassification: 'partially_implemented',
  },
  {
    id: 'payment_webhook',
    name: 'Payment Gateway HTTPS Webhook Adapter',
    scope: 'tenant_configurable',
    description:
      'Generic HTTPS JSON webhook adapter for dispatching checkout/invoice task payloads to a payment relay and ingesting corroborated settlement/refund webhooks.',
    defaultCapabilities: ['payment_verification', 'http_request'],
    authenticationMethod: 'Bearer Secret + Inbound HMAC-SHA256 Webhook Secret',
    executionInterface: 'https_json_webhook',
    verificationCapabilities: ['evidence_based', 'human_review'],
    rateLimit: { requestsPerMinute: 60, burstLimit: 15 },
    supportedOperations: [
      'checkout_webhook_post_dispatch',
      'settled_payment_webhook_verification',
    ],
    implementationStatus: 'implemented_requires_external_credentials',
    integrationClassification: 'generic_webhook_adapter',
  },
];

export function getProviderDescriptor(
  id: ToolId
): ProviderDescriptor | undefined {
  if (id === 'unsupported') return undefined;
  return PROVIDER_DESCRIPTORS.find((p) => p.id === id);
}

export function buildProviderRegistryItems(params: {
  geminiReady: boolean;
  workspaceIntegrations: UserIntegrationRecord[];
}): ToolRegistryItem[] {
  const { geminiReady, workspaceIntegrations } = params;

  return PROVIDER_DESCRIPTORS.map((desc) => {
    if (desc.id === 'llm_reasoning') {
      return {
        id: desc.id,
        name: desc.name,
        scope: desc.scope,
        description: desc.description,
        capabilities: [...desc.defaultCapabilities],
        authenticationMethod: desc.authenticationMethod,
        executionInterface: desc.executionInterface,
        verificationCapabilities: [...desc.verificationCapabilities],
        healthStatus: geminiReady ? 'healthy' : 'unconfigured',
        rateLimit: desc.rateLimit,
        supportedOperations: [...desc.supportedOperations],
        implementationStatus: desc.implementationStatus,
        integrationClassification: desc.integrationClassification,
        configured: geminiReady,
        verified: geminiReady,
        statusDetail: geminiReady
          ? 'Native built-in server-side Gemini SDK active.'
          : 'Server-side GEMINI_API_KEY is not configured.',
        activeIntegrationName: 'Built-in Server Gemini Runtime',
        lastTestedAt: null,
      };
    }

    if (desc.id === 'internal_test_tool') {
      return {
        id: desc.id,
        name: desc.name,
        scope: desc.scope,
        description: desc.description,
        capabilities: [...desc.defaultCapabilities],
        authenticationMethod: desc.authenticationMethod,
        executionInterface: desc.executionInterface,
        verificationCapabilities: [...desc.verificationCapabilities],
        healthStatus: 'healthy',
        rateLimit: desc.rateLimit,
        supportedOperations: [...desc.supportedOperations],
        implementationStatus: desc.implementationStatus,
        integrationClassification: desc.integrationClassification,
        configured: true,
        verified: true,
        statusDetail:
          'Active for internal SHA-256 diagnostics only (never counted as external business outcomes).',
        activeIntegrationName: 'Built-in Deterministic Diagnostic Verifier',
        lastTestedAt: null,
      };
    }

    const matchingAll = workspaceIntegrations.filter(
      (i) => i.providerKey === desc.id
    );
    const matchingEnabled = matchingAll.filter((i) => i.enabled);
    const verifiedMatch = matchingEnabled.find((i) => i.verified) ?? null;

    let healthStatus: ToolRegistryItem['healthStatus'] = 'unconfigured';
    if (verifiedMatch) {
      healthStatus = 'healthy';
    } else if (matchingEnabled.length > 0) {
      healthStatus = 'untested';
    } else if (matchingAll.length > 0) {
      healthStatus = 'disabled';
    }

    const classLabel =
      desc.integrationClassification === 'partially_implemented'
        ? 'HTTPS Relay Bridge (non-native OAuth API)'
        : 'Generic HTTPS Webhook Adapter';

    const statusDetail = verifiedMatch
      ? `Verified workspace adapter (${classLabel}): "${verifiedMatch.displayName}". HTTP execution enters pending_verification until corroborated outcome evidence is verified.`
      : matchingEnabled.length > 0
        ? `${matchingEnabled.length} adapter(s) saved in workspace (${classLabel}); run "Test Connection" to enable task routing.`
        : matchingAll.length > 0
          ? `Saved in workspace (${classLabel}) but currently disabled.`
          : `${classLabel}: connect an external HTTPS endpoint & credentials in this workspace to activate.`;

    return {
      id: desc.id,
      name: desc.name,
      scope: desc.scope,
      description: desc.description,
      capabilities: verifiedMatch
        ? verifiedMatch.capabilities
        : [...desc.defaultCapabilities],
      authenticationMethod: desc.authenticationMethod,
      executionInterface: desc.executionInterface,
      verificationCapabilities: [...desc.verificationCapabilities],
      healthStatus,
      rateLimit: desc.rateLimit,
      supportedOperations: [...desc.supportedOperations],
      implementationStatus: desc.implementationStatus,
      integrationClassification: desc.integrationClassification,
      configured: matchingEnabled.length > 0,
      verified: Boolean(verifiedMatch),
      statusDetail,
      activeIntegrationName: verifiedMatch?.displayName ?? null,
      lastTestedAt:
        verifiedMatch?.lastTestedAt ?? matchingAll[0]?.lastTestedAt ?? null,
    };
  });
}
