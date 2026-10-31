import {
  CAPABILITY_LABELS,
  CONNECTOR_CATALOG,
  evaluateWorkspaceCapabilities,
} from './integration-registry.ts';
import type {
  CapabilityId,
  CapabilityReadinessState,
  ChatInteractivePromptPayload,
  IntegrationProviderKey,
  IntegrationRegistryEntry,
  WorkforceConfigurationRecord,
  WorkforceConnectorRecommendation,
} from '../types.ts';

export interface AnalyzedWorkforceBlueprint {
  title: string;
  roleSummary: string;
  requiredCapabilities: CapabilityId[];
  connectorReasons: Partial<Record<IntegrationProviderKey, string>>;
}

const CAPABILITY_PRIMARY_CONNECTOR_MAP: Record<
  CapabilityId,
  {
    primary: IntegrationProviderKey | null;
    alternatives: IntegrationProviderKey[];
    defaultReason: string;
  }
> = {
  ai_reasoning: {
    primary: null,
    alternatives: [],
    defaultReason: 'Provided automatically by Task.ai Built-In Gemini Reasoning.',
  },
  content_drafting: {
    primary: null,
    alternatives: [],
    defaultReason: 'Provided automatically by Task.ai Built-In Gemini Reasoning.',
  },
  prospect_qualification: {
    primary: null,
    alternatives: [],
    defaultReason: 'Provided automatically by Task.ai Built-In Gemini Reasoning.',
  },
  diagnostic_verification: {
    primary: null,
    alternatives: [],
    defaultReason: 'Provided automatically by Deterministic Diagnostic Worker.',
  },
  email_read: {
    primary: 'gmail_native',
    alternatives: ['microsoft_outlook_native', 'custom_api'],
    defaultReason:
      'Required to read incoming inbox threads, customer inquiries, and email context.',
  },
  message_dispatch: {
    primary: 'gmail_native',
    alternatives: [
      'slack_native',
      'microsoft_outlook_native',
      'n8n_webhook',
      'gmail_api',
    ],
    defaultReason:
      'Required to draft and send approved email replies or outbound notifications.',
  },
  calendar_read: {
    primary: 'google_calendar_native',
    alternatives: ['microsoft_outlook_native'],
    defaultReason:
      'Required to inspect calendar availability and prevent double-booking.',
  },
  calendar_booking: {
    primary: 'google_calendar_native',
    alternatives: [
      'microsoft_outlook_native',
      'n8n_webhook',
      'google_calendar_api',
    ],
    defaultReason:
      'Required to schedule confirmed meetings and send calendar invitations.',
  },
  file_storage: {
    primary: 'google_drive_native',
    alternatives: ['custom_api'],
    defaultReason:
      'Required to archive generated documents, spreadsheets, and reports in cloud storage.',
  },
  team_messaging: {
    primary: 'slack_native',
    alternatives: ['telegram_native', 'microsoft_teams_native', 'n8n_webhook'],
    defaultReason:
      'Required to post real-time escalations, status summaries, and team alerts.',
  },
  crm_sync: {
    primary: 'n8n_webhook',
    alternatives: ['crm_webhook', 'custom_api', 'make_webhook', 'zapier_webhook'],
    defaultReason:
      'Required to synchronize customer records, ticket statuses, and pipeline updates.',
  },
  prospect_search: {
    primary: 'n8n_webhook',
    alternatives: ['custom_api', 'make_webhook', 'custom_webhook'],
    defaultReason:
      'Required to query external lead databases and enrich prospect profiles.',
  },
  workflow_automation: {
    primary: 'n8n_webhook',
    alternatives: ['make_webhook', 'zapier_webhook', 'custom_webhook'],
    defaultReason:
      'Required to orchestrate multi-app background workflows with signed webhook callbacks.',
  },
  payment_verification: {
    primary: 'payment_webhook',
    alternatives: ['n8n_webhook', 'custom_api'],
    defaultReason:
      'Required to verify settled invoices and payment events before recording revenue.',
  },
  custom_api_execution: {
    primary: 'custom_api',
    alternatives: ['n8n_webhook', 'custom_webhook'],
    defaultReason:
      'Required to execute authenticated requests against your custom business REST API.',
  },
  http_request: {
    primary: 'custom_api',
    alternatives: ['custom_webhook', 'n8n_webhook'],
    defaultReason:
      'Required to call external HTTPS endpoints with SSRF protection.',
  },
};

/**
 * Detects whether a conversational user prompt is requesting workforce setup
 * or application connector configuration (e.g., "Create an AI employee that manages my customer support",
 * "Connect my Google Calendar", "Use n8n for lead follow-up").
 */
export function detectWorkforceOrConnectorIntent(prompt: string): {
  matched: boolean;
  kind: 'workforce_configuration' | 'connector_authorization';
  targetProviderKey: IntegrationProviderKey | null;
} {
  const lower = prompt.trim().toLowerCase();
  if (!lower) {
    return {
      matched: false,
      kind: 'workforce_configuration',
      targetProviderKey: null,
    };
  }

  const isWorkforcePhrase =
    /\b(ai employee|ai workforce|workforce|ai agent|autonomous agent|virtual assistant|support agent|sales agent|set up an ai|create an ai)\b/.test(
      lower
    );

  const isExplicitConnectPhrase =
    /\b(connect|integrate|link|authorize|hook up|enable|configure)\b/.test(
      lower
    ) &&
    /\b(gmail|google calendar|calendar|google drive|drive|slack|telegram|outlook|teams|n8n|zapier|make|custom api|webhook)\b/.test(
      lower
    );

  const isUseConnectorForWorkflow =
    /\buse\s+(n8n|slack|gmail|google calendar|google drive|telegram|outlook|custom api)\b/.test(
      lower
    );

  if (!isWorkforcePhrase && !isExplicitConnectPhrase && !isUseConnectorForWorkflow) {
    return {
      matched: false,
      kind: 'workforce_configuration',
      targetProviderKey: null,
    };
  }

  let targetProviderKey: IntegrationProviderKey | null = null;
  if (lower.includes('google calendar') || /\bconnect\b.*\bcalendar\b/.test(lower)) {
    targetProviderKey = 'google_calendar_native';
  } else if (lower.includes('gmail')) {
    targetProviderKey = 'gmail_native';
  } else if (lower.includes('google drive') || /\bconnect\b.*\bdrive\b/.test(lower)) {
    targetProviderKey = 'google_drive_native';
  } else if (lower.includes('slack')) {
    targetProviderKey = 'slack_native';
  } else if (lower.includes('telegram')) {
    targetProviderKey = 'telegram_native';
  } else if (lower.includes('outlook')) {
    targetProviderKey = 'microsoft_outlook_native';
  } else if (lower.includes('teams')) {
    targetProviderKey = 'microsoft_teams_native';
  } else if (lower.includes('n8n')) {
    targetProviderKey = 'n8n_webhook';
  } else if (lower.includes('custom api')) {
    targetProviderKey = 'custom_api';
  }

  return {
    matched: true,
    kind:
      isExplicitConnectPhrase && !isWorkforcePhrase
        ? 'connector_authorization'
        : 'workforce_configuration',
    targetProviderKey,
  };
}

/**
 * Pure deterministic analyzer mapping any natural-language AI employee / workforce / connector
 * request to required capabilities, plain-English role summary, and connector rationale.
 */
export function analyzeWorkforceRequest(prompt: string): AnalyzedWorkforceBlueprint {
  const lower = prompt.trim().toLowerCase();
  const caps = new Set<CapabilityId>(['ai_reasoning', 'content_drafting']);
  const reasons: Partial<Record<IntegrationProviderKey, string>> = {};

  let title = 'Autonomous AI Workforce';
  let roleSummary =
    'Coordinates reasoning, external tool execution, and verified outcome tracking across your connected workspace apps.';

  if (/(customer support|helpdesk|support ticket|inbox|triage|customer service)/.test(lower)) {
    title = 'Customer Support AI Specialist';
    roleSummary =
      'Monitors incoming customer support emails, drafts accurate responses, updates CRM ticket context, and escalates urgent issues to your team channel.';
    caps.add('email_read');
    caps.add('message_dispatch');
    caps.add('team_messaging');
    caps.add('crm_sync');
    reasons.gmail_native =
      'Read incoming customer support emails and create/send approved support replies.';
    reasons.slack_native =
      'Alert your internal support channel when high-priority or billing escalations arrive.';
    reasons.n8n_webhook =
      'Synchronize customer ticket records and multi-step support workflows with your CRM.';
  }

  if (/(email|gmail|inbox|follow-up|followup|outreach)/.test(lower)) {
    caps.add('email_read');
    caps.add('message_dispatch');
    if (title === 'Autonomous AI Workforce') {
      title = 'Executive Email & Follow-Up Coordinator';
      roleSummary =
        'Triages incoming emails, prepares context-aware follow-ups, and dispatches user-approved messages.';
    }
    reasons.gmail_native =
      reasons.gmail_native ??
      'Read inbox threads and prepare/send approved follow-up emails.';
  }

  if (/(schedule|calendar|meeting|appointment|book)/.test(lower)) {
    caps.add('calendar_read');
    caps.add('calendar_booking');
    if (
      title === 'Autonomous AI Workforce' ||
      title === 'Executive Email & Follow-Up Coordinator'
    ) {
      title = lower.includes('email')
        ? 'Executive Inbox & Meeting Scheduler'
        : 'Autonomous Scheduling Coordinator';
      roleSummary =
        'Coordinates availability checks, proposes meeting slots, and books confirmed calendar events.';
    }
    reasons.google_calendar_native =
      'Check primary calendar availability and book confirmed meeting invites.';
  }

  if (/(drive|document|report|file|archive|spreadsheet)/.test(lower)) {
    caps.add('file_storage');
    reasons.google_drive_native =
      'Save generated reports, summaries, and spreadsheets directly to Google Drive.';
  }

  if (/(sales|lead|prospect|sdr|outbound|pipeline)/.test(lower)) {
    caps.add('prospect_qualification');
    caps.add('prospect_search');
    caps.add('crm_sync');
    caps.add('message_dispatch');
    if (title === 'Autonomous AI Workforce') {
      title = 'Sales Development & Lead Follow-Up Workforce';
      roleSummary =
        'Finds and qualifies prospects, syncs CRM pipeline stages, and executes approved follow-up sequences.';
    }
    reasons.n8n_webhook =
      'Run lead enrichment, CRM synchronization, and automated follow-up workflows.';
  }

  if (/(n8n|workflow|automate|zapier|make)/.test(lower)) {
    caps.add('workflow_automation');
    reasons.n8n_webhook =
      reasons.n8n_webhook ??
      'Execute registered n8n automation workflows with HMAC-signed payloads.';
  }

  if (/(slack)/.test(lower)) {
    caps.add('team_messaging');
    reasons.slack_native =
      reasons.slack_native ??
      'Send operational notifications and summaries to Slack channels.';
  }

  if (/(telegram)/.test(lower)) {
    caps.add('team_messaging');
    reasons.telegram_native =
      'Deliver instant operational updates through your Telegram Bot.';
  }

  if (/(outlook|microsoft)/.test(lower)) {
    caps.add('email_read');
    caps.add('message_dispatch');
    reasons.microsoft_outlook_native =
      'Access Microsoft 365 Outlook mail and calendar events via Microsoft Graph.';
  }

  if (/(payment|invoice|revenue|billing|stripe|paystack)/.test(lower)) {
    caps.add('payment_verification');
    reasons.payment_webhook =
      'Verify settled customer invoices via authenticated payment webhooks.';
  }

  if (/(custom api|rest api|endpoint)/.test(lower)) {
    caps.add('custom_api_execution');
    reasons.custom_api =
      'Execute authenticated HTTP operations against your custom business API.';
  }

  // Ensure at least one external capability is included if user asked for an AI employee generically
  if (caps.size <= 2) {
    caps.add('email_read');
    caps.add('message_dispatch');
    caps.add('workflow_automation');
  }

  return {
    title,
    roleSummary,
    requiredCapabilities: Array.from(caps),
    connectorReasons: reasons,
  };
}

/**
 * Evaluates a Workforce Blueprint against the workspace's live Integration Registry,
 * producing exact 7-state capability matrices, connector recommendations, and honest
 * activation gating (refusing `operational` status until ALL required capabilities are `operational`).
 */
export function evaluateWorkforceReadiness(params: {
  blueprint: AnalyzedWorkforceBlueprint;
  registry: IntegrationRegistryEntry[];
  approvedProviderKeys?: string[];
  rejectedProviderKeys?: string[];
  preferredOverrides?: Partial<Record<CapabilityId, IntegrationProviderKey>>;
}): {
  capabilityMatrix: Record<CapabilityId, CapabilityReadinessState>;
  missingCapabilities: CapabilityId[];
  recommendedConnectors: WorkforceConnectorRecommendation[];
  allOperational: boolean;
  activationBlockerReason: string | null;
} {
  const { matrix } = evaluateWorkspaceCapabilities(params.registry);
  const rejectedSet = new Set(params.rejectedProviderKeys ?? []);
  const approvedSet = new Set(params.approvedProviderKeys ?? []);

  const connectorBuckets = new Map<
    IntegrationProviderKey,
    {
      caps: Set<CapabilityId>;
      reason: string;
      alternatives: Set<IntegrationProviderKey>;
    }
  >();

  for (const cap of params.blueprint.requiredCapabilities) {
    // If already operational via an active workspace integration (that wasn't rejected), still surface it if external, or skip if built-in
    const mapping = CAPABILITY_PRIMARY_CONNECTOR_MAP[cap];
    if (!mapping || !mapping.primary) {
      continue;
    }

    // Check if an already-operational connector in registry satisfies this capability
    const operationalEntry = params.registry.find(
      (r) =>
        r.connectorType !== 'built_in' &&
        r.capabilityReadiness === 'operational' &&
        r.availableCapabilities.includes(cap) &&
        !rejectedSet.has(r.providerKey)
    );

    let chosenKey: IntegrationProviderKey =
      params.preferredOverrides?.[cap] ??
      (operationalEntry
        ? (operationalEntry.providerKey as IntegrationProviderKey)
        : mapping.primary);

    if (rejectedSet.has(chosenKey)) {
      const fallback = mapping.alternatives.find((alt) => !rejectedSet.has(alt));
      if (fallback) {
        chosenKey = fallback;
      }
    }

    const existing = connectorBuckets.get(chosenKey);
    const reasonText =
      params.blueprint.connectorReasons[chosenKey] || mapping.defaultReason;

    if (existing) {
      existing.caps.add(cap);
    } else {
      connectorBuckets.set(chosenKey, {
        caps: new Set([cap]),
        reason: reasonText,
        alternatives: new Set(
          [mapping.primary, ...mapping.alternatives].filter(
            (k) => k !== chosenKey
          )
        ),
      });
    }
  }

  const recommendedConnectors: WorkforceConnectorRecommendation[] = [];

  for (const [providerKey, bucket] of connectorBuckets.entries()) {
    const regEntries = params.registry.filter(
      (r) => r.providerKey === providerKey
    );
    const primaryEntry =
      regEntries.find((r) => r.capabilityReadiness === 'operational') ??
      regEntries[0];

    const cat = CONNECTOR_CATALOG.find((c) => c.providerKey === providerKey);
    const readiness: CapabilityReadinessState =
      primaryEntry?.capabilityReadiness ?? 'available';

    const decision: WorkforceConnectorRecommendation['decision'] = rejectedSet.has(
      providerKey
    )
      ? 'rejected'
      : approvedSet.has(providerKey) || readiness === 'operational'
        ? 'approved'
        : 'pending';

    recommendedConnectors.push({
      providerKey,
      connectorName: primaryEntry?.connectorName || cat?.name || providerKey,
      connectorType: primaryEntry?.connectorType || cat?.connectorType || 'webhook',
      requiredForCapabilities: Array.from(bucket.caps),
      reasonNeeded: bucket.reason,
      currentReadiness: readiness,
      integrationId: primaryEntry?.integrationId ?? null,
      decision,
      alternativeProviderKeys: Array.from(bucket.alternatives),
    });
  }

  // Recompute effective capability readiness excluding rejected connectors
  const effectiveRegistry = params.registry.filter(
    (r) => !rejectedSet.has(r.providerKey)
  );
  const { matrix: effectiveMatrix } =
    evaluateWorkspaceCapabilities(effectiveRegistry);

  const scopedMatrix = {} as Record<CapabilityId, CapabilityReadinessState>;
  const missingCapabilities: CapabilityId[] = [];

  for (const cap of params.blueprint.requiredCapabilities) {
    const st = effectiveMatrix[cap] ?? matrix[cap] ?? 'unavailable';
    scopedMatrix[cap] = st;
    if (st !== 'operational') {
      missingCapabilities.push(cap);
    }
  }

  const allOperational = missingCapabilities.length === 0;
  let activationBlockerReason: string | null = null;

  if (!allOperational) {
    const parts = missingCapabilities.map(
      (c) => `${CAPABILITY_LABELS[c]} (${scopedMatrix[c]})`
    );
    activationBlockerReason = `Workforce cannot be marked operational until all required capabilities pass live verification. Non-operational capabilities: ${parts.join(', ')}.`;
  }

  return {
    capabilityMatrix: scopedMatrix,
    missingCapabilities,
    recommendedConnectors,
    allOperational,
    activationBlockerReason,
  };
}

export function buildInteractivePromptFromWorkforce(params: {
  kind: 'workforce_configuration' | 'connector_authorization';
  config: WorkforceConfigurationRecord;
  targetProviderKey?: IntegrationProviderKey | null;
}): ChatInteractivePromptPayload {
  return {
    kind: params.kind,
    workforceConfigId: params.config.id,
    targetProviderKey: params.targetProviderKey ?? null,
    title: params.config.title,
    summary: params.config.roleSummary,
    requiredCapabilities: params.config.requiredCapabilities,
    recommendedConnectors: params.config.recommendedConnectors,
    status: params.config.status,
    activationBlockerReason: params.config.activationBlockerReason,
  };
}
