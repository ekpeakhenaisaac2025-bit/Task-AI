import crypto from 'node:crypto';
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
  listN8nWorkflowsByWorkspace,
  recordN8nWorkflowExecutionStatus,
  upsertN8nWorkflowForIntegration,
} from '../../db/integrations-repository.ts';
import {
  safeOutboundHttpRequest,
  validateDestinationUrlSync,
  type SafeOutboundHttpRequestParams,
  type SafeOutboundHttpResponse,
} from '../ssrf-guard.ts';
import type {
  CapabilityId,
  CustomApiHttpMethod,
  N8nRegisteredWorkflowRecord,
  TaskRecord,
} from '../../types.ts';

export type N8nHttpTransportFn = (
  params: SafeOutboundHttpRequestParams
) => Promise<SafeOutboundHttpResponse>;

function inferCapabilitiesFromWorkflowName(name: string): CapabilityId[] {
  const lower = name.toLowerCase();
  const caps = new Set<CapabilityId>(['workflow_automation']);
  if (/(email|gmail|mail|outreach|reply|support)/.test(lower)) {
    caps.add('message_dispatch');
  }
  if (/(crm|hubspot|pipedrive|salesforce|lead|contact)/.test(lower)) {
    caps.add('crm_sync');
  }
  if (/(prospect|scrape|apollo|linkedin|enrich)/.test(lower)) {
    caps.add('prospect_search');
  }
  if (/(calendar|schedule|meeting|booking)/.test(lower)) {
    caps.add('calendar_booking');
  }
  if (/(payment|stripe|paystack|invoice|billing)/.test(lower)) {
    caps.add('payment_verification');
  }
  if (/(slack|telegram|teams|alert|notify)/.test(lower)) {
    caps.add('team_messaging');
  }
  return Array.from(caps);
}

async function decryptN8nSecret(
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

/**
 * Discovers workflows from a user's own n8n instance via the official n8n REST API
 * (`GET <n8nBaseUrl>/api/v1/workflows`).
 * IMPORTANT: Never assumes a single webhook URL exposes all workflows. Only workflows
 * containing an explicit `n8n-nodes-base.webhook` trigger node with a path are registered
 * with concrete webhook paths; others require explicit webhook path registration.
 */
export async function discoverN8nInstanceWorkflows(params: {
  executable: ServerExecutableIntegration;
  userId: string;
  transport?: N8nHttpTransportFn;
}): Promise<{
  discoveredCount: number;
  registeredWorkflows: N8nRegisteredWorkflowRecord[];
  skippedWithoutWebhookNode: number;
}> {
  const { executable, userId } = params;
  const transport = params.transport ?? safeOutboundHttpRequest;

  if (executable.record.userId !== userId) {
    throw new Error('Cross-user n8n workflow discovery denied.');
  }

  const baseUrlRaw =
    executable.record.configMetadata.n8nBaseUrl ||
    executable.record.configMetadata.endpointUrl ||
    '';
  const syncCheck = validateDestinationUrlSync(baseUrlRaw);
  if (!syncCheck.valid || !syncCheck.origin) {
    throw new Error(
      syncCheck.error ||
        'A valid HTTPS n8n instance base URL is required to discover workflows.'
    );
  }

  const apiKey = await decryptN8nSecret(executable);
  if (!apiKey) {
    throw new Error(
      'An encrypted n8n API key is required to query /api/v1/workflows on your n8n instance.'
    );
  }

  const apiUrl = `${syncCheck.origin}/api/v1/workflows`;
  const res = await transport({
    url: apiUrl,
    method: 'GET',
    queryParams: { limit: '50' },
    headers: {
      'X-N8N-API-KEY': apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
    timeoutMs: 10000,
    allowQueryParams: true,
  });

  if (!res.ok) {
    throw new Error(
      `n8n REST API workflow discovery returned HTTP ${res.status} from ${syncCheck.origin}.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.responseText);
  } catch {
    throw new Error('n8n /api/v1/workflows did not return valid JSON.');
  }

  const rawList: unknown[] =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as Record<string, unknown>).data)
      ? ((parsed as Record<string, unknown>).data as unknown[])
      : Array.isArray(parsed)
        ? parsed
        : [];

  const registeredWorkflows: N8nRegisteredWorkflowRecord[] = [];
  let skippedWithoutWebhookNode = 0;

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const wf = item as Record<string, unknown>;
    const wfId = String(wf.id ?? '').trim();
    const wfName = String(wf.name ?? 'Untitled n8n Workflow').trim();
    const wfActive = Boolean(wf.active ?? true);
    const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];

    // Locate an explicit webhook trigger node inside the n8n workflow definition
    let webhookPath = '';
    let webhookMethod: CustomApiHttpMethod = 'POST';

    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const nodeObj = n as Record<string, unknown>;
      const nodeType = String(nodeObj.type ?? '').toLowerCase();
      if (nodeType.includes('webhook')) {
        const nodeParams =
          nodeObj.parameters && typeof nodeObj.parameters === 'object'
            ? (nodeObj.parameters as Record<string, unknown>)
            : {};
        const rawPath = String(nodeParams.path ?? '').trim().replace(/^\/+/, '');
        const rawMethod = String(nodeParams.httpMethod ?? 'POST')
          .trim()
          .toUpperCase();
        if (rawPath) {
          webhookPath = `${syncCheck.origin}/webhook/${rawPath}`;
          if (
            rawMethod === 'GET' ||
            rawMethod === 'POST' ||
            rawMethod === 'PUT' ||
            rawMethod === 'PATCH' ||
            rawMethod === 'DELETE'
          ) {
            webhookMethod = rawMethod;
          }
          break;
        }
      }
    }

    if (!wfId || !webhookPath) {
      skippedWithoutWebhookNode += 1;
      continue;
    }

    const saved = await upsertN8nWorkflowForIntegration({
      userId,
      workspaceId: executable.record.workspaceId,
      integrationId: executable.record.id,
      workflowExternalId: wfId,
      name: wfName,
      description: `Discovered from ${syncCheck.origin} via n8n REST API`,
      webhookUrlOrPath: webhookPath,
      httpMethod: webhookMethod,
      capabilities: inferCapabilitiesFromWorkflowName(wfName),
      active: wfActive,
      discoveredViaApi: true,
    });
    registeredWorkflows.push(saved);
  }

  return {
    discoveredCount: registeredWorkflows.length,
    registeredWorkflows,
    skippedWithoutWebhookNode,
  };
}

/**
 * Tests an n8n integration in `existing_instance` mode via `/api/v1/workflows?limit=1`.
 */
export async function testN8nExistingInstanceConnection(params: {
  executable: ServerExecutableIntegration;
  transport?: N8nHttpTransportFn;
}): Promise<{
  success: boolean;
  httpStatus: number | null;
  statusDetail: string;
}> {
  const { executable } = params;
  const transport = params.transport ?? safeOutboundHttpRequest;

  const baseUrlRaw =
    executable.record.configMetadata.n8nBaseUrl ||
    executable.record.configMetadata.endpointUrl ||
    '';
  const syncCheck = validateDestinationUrlSync(baseUrlRaw);
  if (!syncCheck.valid || !syncCheck.origin) {
    return {
      success: false,
      httpStatus: null,
      statusDetail:
        syncCheck.error || 'Invalid n8n instance HTTPS base URL.',
    };
  }

  try {
    const apiKey = await decryptN8nSecret(executable);
    if (!apiKey) {
      return {
        success: false,
        httpStatus: null,
        statusDetail:
          'n8n instance mode requires an encrypted n8n API key or Bearer token.',
      };
    }

    const res = await transport({
      url: `${syncCheck.origin}/api/v1/workflows`,
      method: 'GET',
      queryParams: { limit: '1' },
      headers: {
        'X-N8N-API-KEY': apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      timeoutMs: 8000,
      allowQueryParams: true,
    });

    if (!res.ok) {
      return {
        success: false,
        httpStatus: res.status,
        statusDetail: `n8n instance API returned HTTP ${res.status} from ${syncCheck.origin}. Verify your n8n API key.`,
      };
    }

    return {
      success: true,
      httpStatus: res.status,
      statusDetail: `Connected to n8n instance ${syncCheck.origin} (HTTP ${res.status}). Discover or register workflows to enable execution.`,
    };
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? redactSecretsFromText(err.message) : 'Network error';
    return {
      success: false,
      httpStatus: null,
      statusDetail: `n8n instance connection failed: ${msg}`,
    };
  }
}

/**
 * Selects the best matching registered n8n workflow for a task's required capabilities,
 * falling back to the integration's primary webhook URL when configured in `manual_webhook` mode.
 */
export async function executeN8nWorkflowTask(params: {
  executable: ServerExecutableIntegration;
  userId: string;
  task: TaskRecord;
  outboundPayload: Record<string, unknown>;
  transport?: N8nHttpTransportFn;
}): Promise<{
  completedSummary: string;
  outputData: Record<string, unknown>;
  matchedWorkflow: N8nRegisteredWorkflowRecord | null;
}> {
  const { executable, userId, task, outboundPayload } = params;
  const transport = params.transport ?? safeOutboundHttpRequest;

  const workflows = await listN8nWorkflowsByWorkspace({
    userId,
    workspaceId: executable.record.workspaceId,
    integrationId: executable.record.id,
  });

  const activeWorkflows = workflows.filter((w) => w.active);
  let matchedWorkflow: N8nRegisteredWorkflowRecord | null = null;

  for (const wf of activeWorkflows) {
    const overlaps = task.requiredCapabilities.some((cap) =>
      wf.capabilities.includes(cap)
    );
    if (overlaps) {
      matchedWorkflow = wf;
      break;
    }
  }
  if (!matchedWorkflow && activeWorkflows.length > 0) {
    matchedWorkflow = activeWorkflows[0];
  }

  let targetUrl = '';
  let httpMethod: CustomApiHttpMethod = 'POST';

  if (matchedWorkflow) {
    if (matchedWorkflow.webhookUrlOrPath.startsWith('https://')) {
      targetUrl = matchedWorkflow.webhookUrlOrPath;
    } else {
      const baseOrigin = validateDestinationUrlSync(
        executable.record.configMetadata.n8nBaseUrl ||
          executable.record.configMetadata.endpointUrl ||
          ''
      ).origin;
      if (!baseOrigin) {
        throw new Error(
          `Registered n8n workflow "${matchedWorkflow.name}" uses a relative path, but no valid n8n base URL is configured.`
        );
      }
      targetUrl = `${baseOrigin}/webhook/${matchedWorkflow.webhookUrlOrPath.replace(/^\/+/, '')}`;
    }
    httpMethod = matchedWorkflow.httpMethod || 'POST';
  } else if (executable.record.configMetadata.endpointUrl?.trim()) {
    targetUrl = executable.record.configMetadata.endpointUrl.trim();
  } else {
    throw new Error(
      `n8n integration "${executable.record.displayName}" has no registered active workflow or manual webhook URL.`
    );
  }

  const secret = await decryptN8nSecret(executable);
  const timestampSec = String(Math.floor(Date.now() / 1000));
  const payloadWithWorkflow = {
    ...outboundPayload,
    n8nWorkflow: matchedWorkflow
      ? {
          id: matchedWorkflow.workflowExternalId,
          name: matchedWorkflow.name,
        }
      : null,
  };
  const serialized = JSON.stringify(payloadWithWorkflow);

  const headers: Record<string, string> = {
    'X-TaskAI-Event': 'task_execution',
    'X-Idempotency-Key': task.idempotencyKey,
    'X-TaskAI-User-Id': userId,
    'X-TaskAI-Workspace-Id': executable.record.workspaceId,
    'X-TaskAI-Integration-Id': executable.record.id,
    'X-TaskAI-Timestamp': timestampSec,
  };

  if (matchedWorkflow) {
    headers['X-TaskAI-Workflow-Id'] = matchedWorkflow.workflowExternalId;
  } else if (executable.record.configMetadata.workflowId) {
    headers['X-TaskAI-Workflow-Id'] = executable.record.configMetadata.workflowId;
  }

  if (secret) {
    const authType = executable.record.configMetadata.authType;
    if (authType === 'hmac_sha256') {
      const sig = crypto
        .createHmac('sha256', secret)
        .update(`${timestampSec}.${serialized}`)
        .digest('hex');
      headers['X-TaskAI-Signature'] = `t=${timestampSec},v1=${sig}`;
    } else if (authType === 'bearer_token' || authType === 'api_key') {
      headers['Authorization'] = `Bearer ${secret}`;
      headers['X-N8N-API-KEY'] = secret;
    } else if (authType === 'header_secret') {
      const hdr =
        executable.record.configMetadata.secretHeaderName?.trim() ||
        'X-TaskAI-Webhook-Secret';
      headers[hdr] = secret;
    }
  }

  const timeoutMs =
    task.executionTimeoutMs > 0
      ? Math.min(task.executionTimeoutMs, 25000)
      : 12000;

  // Controlled retry with backoff on transient 502 / 503 / 504 gateway errors
  let lastStatus = 0;
  let lastResponse: SafeOutboundHttpResponse | null = null;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await transport({
      url: targetUrl,
      method: httpMethod,
      headers,
      body: httpMethod === 'GET' ? null : payloadWithWorkflow,
      timeoutMs,
    });
    lastResponse = res;
    lastStatus = res.status;

    if (res.ok) {
      break;
    }
    if (
      attempt < maxAttempts &&
      (res.status === 502 || res.status === 503 || res.status === 504)
    ) {
      await new Promise((r) => setTimeout(r, 350 * attempt));
      continue;
    }
    break;
  }

  if (!lastResponse || !lastResponse.ok) {
    if (matchedWorkflow) {
      await recordN8nWorkflowExecutionStatus({
        workflowId: matchedWorkflow.id,
        userId,
        status: `failed_http_${lastStatus}`,
      }).catch(() => {});
    }
    throw new Error(
      `n8n workflow "${matchedWorkflow?.name || executable.record.displayName}" returned HTTP ${lastStatus}: ${(lastResponse?.responseText || '').slice(0, 200)}`
    );
  }

  if (matchedWorkflow) {
    await recordN8nWorkflowExecutionStatus({
      workflowId: matchedWorkflow.id,
      userId,
      status: `succeeded_http_${lastResponse.status}`,
    }).catch(() => {});
  }

  return {
    completedSummary: `Triggered n8n workflow "${matchedWorkflow?.name || executable.record.displayName}" (HTTP ${lastResponse.status} from ${lastResponse.destinationOrigin}). Task is pending independent outcome verification.`,
    outputData: sanitizeEvidencePayload({
      providerKey: 'n8n_webhook',
      integrationId: executable.record.id,
      integrationName: executable.record.displayName,
      workflowId:
        matchedWorkflow?.workflowExternalId ??
        executable.record.configMetadata.workflowId ??
        null,
      workflowName: matchedWorkflow?.name ?? null,
      destinationOrigin: lastResponse.destinationOrigin,
      httpStatus: lastResponse.status,
      externalDispatchConfirmed: true,
      responsePreview: lastResponse.responseText.slice(0, 400),
      idempotencyKey: task.idempotencyKey,
    }),
    matchedWorkflow,
  };
}
