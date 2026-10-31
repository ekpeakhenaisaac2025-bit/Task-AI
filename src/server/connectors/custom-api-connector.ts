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
  validateDestinationUrlSync,
  type SafeOutboundHttpRequestParams,
  type SafeOutboundHttpResponse,
} from '../ssrf-guard.ts';
import type {
  CustomApiConfigMetadata,
  CustomApiHttpMethod,
  IntegrationAuthType,
  TaskRecord,
} from '../../types.ts';

export type CustomApiTransportFn = (
  params: SafeOutboundHttpRequestParams
) => Promise<SafeOutboundHttpResponse>;

const ALLOWED_HTTP_METHODS: ReadonlySet<CustomApiHttpMethod> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

const FORBIDDEN_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
]);

export function validateCustomApiConfig(input: {
  displayName: string;
  authType: IntegrationAuthType;
  customApi: Partial<CustomApiConfigMetadata>;
  hasSecret: boolean;
}): {
  valid: boolean;
  normalized?: CustomApiConfigMetadata;
  normalizedFullUrl?: string;
  destinationOrigin?: string;
  error?: string;
} {
  if (!input.displayName || input.displayName.trim().length < 2) {
    return {
      valid: false,
      error: 'Integration name must be at least 2 characters.',
    };
  }

  const baseUrlRaw = (input.customApi.baseUrl || '').trim().replace(/\/+$/, '');
  const endpointPathRaw = (input.customApi.endpointPath || '/').trim();
  const normalizedPath = endpointPathRaw.startsWith('/')
    ? endpointPathRaw
    : `/${endpointPathRaw}`;

  const combinedUrl = `${baseUrlRaw}${normalizedPath}`;
  const urlCheck = validateDestinationUrlSync(combinedUrl);
  if (!urlCheck.valid || !urlCheck.origin || !urlCheck.normalizedUrl) {
    return {
      valid: false,
      error: urlCheck.error || 'API Base URL + Endpoint must be a safe HTTPS URL.',
    };
  }

  const method = (input.customApi.httpMethod || 'POST').toUpperCase() as CustomApiHttpMethod;
  if (!ALLOWED_HTTP_METHODS.has(method)) {
    return {
      valid: false,
      error: 'HTTP method must be one of GET, POST, PUT, PATCH, or DELETE.',
    };
  }

  if (
    input.authType !== 'none' &&
    !input.hasSecret
  ) {
    return {
      valid: false,
      error: `Authentication method "${input.authType}" requires an API key, token, or password.`,
    };
  }

  if (
    input.authType === 'basic_auth' &&
    !(input.customApi.basicAuthUsername || '').trim()
  ) {
    return {
      valid: false,
      error: 'Basic Auth requires a non-empty username.',
    };
  }

  const cleanHeaders: Record<string, string> = {};
  if (input.customApi.requestHeaders) {
    for (const [k, v] of Object.entries(input.customApi.requestHeaders)) {
      const key = k.trim();
      if (!key) continue;
      if (!/^[a-zA-Z0-9-]+$/.test(key) || FORBIDDEN_HEADER_NAMES.has(key.toLowerCase())) {
        return {
          valid: false,
          error: `Request header "${key}" is invalid or restricted.`,
        };
      }
      cleanHeaders[key] = String(v);
    }
  }

  const cleanParams: Record<string, string> = {};
  if (input.customApi.requestParams) {
    for (const [k, v] of Object.entries(input.customApi.requestParams)) {
      const key = k.trim();
      if (!key) continue;
      cleanParams[key] = String(v);
    }
  }

  const timeoutMs = Math.max(
    1000,
    Math.min(Number(input.customApi.timeoutMs || 10000), 25000)
  );

  const allowedOperations = Array.isArray(input.customApi.allowedOperations)
    ? input.customApi.allowedOperations
        .map((s) => String(s).trim())
        .filter(Boolean)
    : [method];

  if (allowedOperations.length === 0) {
    return {
      valid: false,
      error: 'Specify at least one allowed operation for this Custom API.',
    };
  }

  return {
    valid: true,
    destinationOrigin: urlCheck.origin,
    normalizedFullUrl: urlCheck.normalizedUrl,
    normalized: {
      baseUrl: urlCheck.origin,
      httpMethod: method,
      endpointPath: normalizedPath,
      requestHeaders: cleanHeaders,
      requestParams: cleanParams,
      requestBodySchema: input.customApi.requestBodySchema ?? null,
      timeoutMs,
      allowedOperations,
      apiKeyHeaderName: input.customApi.apiKeyHeaderName?.trim() || 'X-API-Key',
      basicAuthUsername: input.customApi.basicAuthUsername?.trim() || undefined,
    },
  };
}

/**
 * Validates an outbound JSON payload against an optional JSON-Schema-like object
 * (`required: string[]`, `properties: { [key]: { type } }`).
 */
export function validatePayloadAgainstBodySchema(
  payload: Record<string, unknown>,
  schema: Record<string, unknown> | null | undefined
): { valid: boolean; error?: string } {
  if (!schema || typeof schema !== 'object') {
    return { valid: true };
  }

  if (Array.isArray(schema.required)) {
    for (const reqKey of schema.required) {
      if (
        typeof reqKey === 'string' &&
        (payload[reqKey] === undefined || payload[reqKey] === null)
      ) {
        return {
          valid: false,
          error: `Custom API request body is missing required schema property "${reqKey}".`,
        };
      }
    }
  }

  if (schema.properties && typeof schema.properties === 'object') {
    const props = schema.properties as Record<string, unknown>;
    for (const [propName, propSpec] of Object.entries(props)) {
      if (payload[propName] === undefined || !propSpec || typeof propSpec !== 'object') {
        continue;
      }
      const expectedType = (propSpec as Record<string, unknown>).type;
      if (typeof expectedType === 'string') {
        const actualVal = payload[propName];
        const actualType = Array.isArray(actualVal) ? 'array' : typeof actualVal;
        if (expectedType !== actualType) {
          return {
            valid: false,
            error: `Custom API schema mismatch on "${propName}": expected ${expectedType}, received ${actualType}.`,
          };
        }
      }
    }
  }

  return { valid: true };
}

async function buildCustomApiAuthHeaders(
  executable: ServerExecutableIntegration
): Promise<Record<string, string>> {
  const meta = executable.record.configMetadata;
  const custom = meta.customApi;
  const headers: Record<string, string> = {
    ...(custom?.requestHeaders ?? {}),
  };

  if (meta.authType === 'none') {
    return headers;
  }

  if (
    !executable.encryptedSecret ||
    !executable.secretIv ||
    !executable.secretAuthTag
  ) {
    throw new Error(
      `Custom API "${executable.record.displayName}" requires ${meta.authType} credentials, but no secret is stored.`
    );
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

  const secret = decrypted.plaintext;

  if (meta.authType === 'bearer_token' || meta.authType === 'oauth2') {
    headers['Authorization'] = `Bearer ${secret}`;
  } else if (meta.authType === 'api_key' || meta.authType === 'header_secret') {
    const headerName =
      custom?.apiKeyHeaderName?.trim() ||
      meta.secretHeaderName?.trim() ||
      'X-API-Key';
    headers[headerName] = secret;
  } else if (meta.authType === 'basic_auth') {
    const username = custom?.basicAuthUsername || 'api';
    const token = Buffer.from(`${username}:${secret}`, 'utf8').toString(
      'base64'
    );
    headers['Authorization'] = `Basic ${token}`;
  }

  return headers;
}

export async function testCustomApiConnection(params: {
  executable: ServerExecutableIntegration;
  transport?: CustomApiTransportFn;
}): Promise<{
  success: boolean;
  httpStatus: number | null;
  statusDetail: string;
}> {
  const { executable } = params;
  const transport = params.transport ?? safeOutboundHttpRequest;
  const custom = executable.record.configMetadata.customApi;
  if (!custom) {
    return {
      success: false,
      httpStatus: null,
      statusDetail: 'Custom API metadata is missing.',
    };
  }

  try {
    const targetUrl = `${custom.baseUrl.replace(/\/+$/, '')}${
      custom.endpointPath.startsWith('/')
        ? custom.endpointPath
        : `/${custom.endpointPath}`
    }`;
    const authHeaders = await buildCustomApiAuthHeaders(executable);

    // For safe connection probing: if configured method is GET, execute GET; otherwise send harmless probe payload
    const method = custom.httpMethod;
    const probeBody: Record<string, unknown> | null =
      method === 'GET'
        ? null
        : {
            event: 'task_ai_custom_api_probe',
            workspaceId: executable.record.workspaceId,
            integrationId: executable.record.id,
            timestamp: new Date().toISOString(),
          };

    const res = await transport({
      url: targetUrl,
      method,
      queryParams: custom.requestParams,
      headers: {
        ...authHeaders,
        'X-TaskAI-Event': 'connection_test',
      },
      body: probeBody,
      timeoutMs: custom.timeoutMs || 8000,
    });

    if (!res.ok) {
      return {
        success: false,
        httpStatus: res.status,
        statusDetail: `Custom API responded with HTTP ${res.status} from ${res.destinationOrigin}.`,
      };
    }

    return {
      success: true,
      httpStatus: res.status,
      statusDetail: `Custom API verified (${method} ${res.destinationOrigin}${custom.endpointPath} -> HTTP ${res.status}).`,
    };
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? redactSecretsFromText(err.message) : 'Network failure';
    return {
      success: false,
      httpStatus: null,
      statusDetail: `Custom API test failed: ${msg}`,
    };
  }
}

export async function executeCustomApiTask(params: {
  executable: ServerExecutableIntegration;
  task: TaskRecord;
  prerequisiteOutputs: Array<{
    stepOrder: number;
    description: string;
    outputData: Record<string, unknown> | null;
  }>;
  transport?: CustomApiTransportFn;
}): Promise<{
  completedSummary: string;
  outputData: Record<string, unknown>;
}> {
  const { executable, task } = params;
  const transport = params.transport ?? safeOutboundHttpRequest;
  const custom = executable.record.configMetadata.customApi;
  if (!custom) {
    throw new Error(
      `Custom API connector "${executable.record.displayName}" is missing endpoint configuration.`
    );
  }

  const targetUrl = `${custom.baseUrl.replace(/\/+$/, '')}${
    custom.endpointPath.startsWith('/')
      ? custom.endpointPath
      : `/${custom.endpointPath}`
  }`;

  const authHeaders = await buildCustomApiAuthHeaders(executable);
  const bodyPayload: Record<string, unknown> = {
    taskId: task.id,
    goalId: task.goalId,
    idempotencyKey: task.idempotencyKey,
    operation: custom.allowedOperations[0] || custom.httpMethod,
    description: task.description,
    proposedActionDetails: task.proposedActionDetails,
    expectedResult: task.expectedResult,
    prerequisiteOutputs: params.prerequisiteOutputs,
  };

  if (custom.httpMethod !== 'GET' && custom.requestBodySchema) {
    const schemaCheck = validatePayloadAgainstBodySchema(
      bodyPayload,
      custom.requestBodySchema
    );
    if (!schemaCheck.valid) {
      throw new Error(schemaCheck.error || 'Custom API request body failed schema validation.');
    }
  }

  const res = await transport({
    url: targetUrl,
    method: custom.httpMethod,
    queryParams: custom.requestParams,
    headers: {
      ...authHeaders,
      'X-Idempotency-Key': task.idempotencyKey,
      'X-TaskAI-Workspace-Id': executable.record.workspaceId,
    },
    body: custom.httpMethod === 'GET' ? null : bodyPayload,
    timeoutMs: custom.timeoutMs || 10000,
  });

  if (!res.ok) {
    throw new Error(
      `Custom API "${executable.record.displayName}" returned HTTP ${res.status}: ${res.responseText.slice(0, 200)}`
    );
  }

  return {
    completedSummary: `Executed ${custom.httpMethod} ${res.destinationOrigin}${custom.endpointPath} via Custom API "${executable.record.displayName}" (HTTP ${res.status}).`,
    outputData: sanitizeEvidencePayload({
      providerKey: 'custom_api',
      integrationId: executable.record.id,
      integrationName: executable.record.displayName,
      httpMethod: custom.httpMethod,
      endpointPath: custom.endpointPath,
      destinationOrigin: res.destinationOrigin,
      httpStatus: res.status,
      responsePreview: res.responseText.slice(0, 500),
      idempotencyKey: task.idempotencyKey,
    }),
  };
}
