import { GoogleGenAI } from '@google/genai';
import {
  listAiProviderConfigsForWorkspace,
  upsertAiProviderConfigForWorkspace,
} from '../db/integrations-repository.ts';
import { isGeminiConfigured } from './gemini.ts';
import { redactSecretsFromText } from './crypto-vault.ts';
import {
  safeOutboundHttpRequest,
  type SafeOutboundHttpRequestParams,
  type SafeOutboundHttpResponse,
} from './ssrf-guard.ts';
import type {
  AiProviderId,
  AiProviderStatusRecord,
  ConnectorHealthStatus,
} from '../types.ts';

interface AiProviderCatalogDef {
  providerId: AiProviderId;
  name: string;
  description: string;
  isBuiltInDefault: boolean;
  defaultModel: string;
  supportedModels: string[];
  defaultPriority: number;
  envVarName: string;
}

const AI_PROVIDER_CATALOG: readonly AiProviderCatalogDef[] = [
  {
    providerId: 'gemini',
    name: 'Google Gemini (Built-In Runtime)',
    description:
      'Primary server-side AI reasoning, task planning, streaming chat, and outcome analysis engine. Provisioned automatically — no user API key required.',
    isBuiltInDefault: true,
    defaultModel: 'gemini-3-flash-preview',
    supportedModels: [
      'gemini-3-flash-preview',
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-flash-latest',
    ],
    defaultPriority: 1,
    envVarName: 'GEMINI_API_KEY',
  },
  {
    providerId: 'openai',
    name: 'OpenAI (Optional Server Fallback)',
    description:
      'Optional secondary reasoning provider configured via server-side OPENAI_API_KEY environment variable.',
    isBuiltInDefault: false,
    defaultModel: 'gpt-4o-mini',
    supportedModels: ['gpt-4o-mini', 'gpt-4o'],
    defaultPriority: 2,
    envVarName: 'OPENAI_API_KEY',
  },
  {
    providerId: 'anthropic',
    name: 'Anthropic Claude (Optional Server Fallback)',
    description:
      'Optional tertiary reasoning provider configured via server-side ANTHROPIC_API_KEY environment variable.',
    isBuiltInDefault: false,
    defaultModel: 'claude-3-5-sonnet-latest',
    supportedModels: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
    defaultPriority: 3,
    envVarName: 'ANTHROPIC_API_KEY',
  },
];

function isServerKeyPresent(
  providerId: AiProviderId,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (providerId === 'gemini') {
    return isGeminiConfigured();
  }
  if (providerId === 'openai') {
    const val = env.OPENAI_API_KEY?.trim() ?? '';
    return Boolean(val && val !== 'MY_OPENAI_API_KEY');
  }
  const val = env.ANTHROPIC_API_KEY?.trim() ?? '';
  return Boolean(val && val !== 'MY_ANTHROPIC_API_KEY');
}

export async function listWorkspaceAiProviders(params: {
  userId: string;
  workspaceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AiProviderStatusRecord[]> {
  const env = params.env ?? process.env;
  const rows = await listAiProviderConfigsForWorkspace({
    userId: params.userId,
    workspaceId: params.workspaceId,
  });

  const rowMap = new Map(rows.map((r) => [r.providerId as AiProviderId, r]));

  return AI_PROVIDER_CATALOG.map((cat) => {
    const row = rowMap.get(cat.providerId);
    const keyConfigured = isServerKeyPresent(cat.providerId, env);
    const enabled = row ? row.enabled : cat.isBuiltInDefault && keyConfigured;

    let healthStatus: ConnectorHealthStatus = 'untested';
    if (!keyConfigured) {
      healthStatus = 'disabled';
    } else if (!enabled) {
      healthStatus = 'disabled';
    } else if (row?.lastHealthStatus) {
      healthStatus =
        row.lastHealthStatus === 'untested' && cat.providerId === 'gemini'
          ? 'healthy'
          : (row.lastHealthStatus as ConnectorHealthStatus);
    } else if (cat.providerId === 'gemini') {
      healthStatus = 'healthy';
    }

    return {
      providerId: cat.providerId,
      workspaceId: params.workspaceId,
      name: cat.name,
      description: cat.description,
      isBuiltInDefault: cat.isBuiltInDefault,
      serverKeyConfigured: keyConfigured,
      enabled,
      preferredModel: row?.preferredModel ?? cat.defaultModel,
      supportedModels: [...cat.supportedModels],
      fallbackPriority: row?.fallbackPriority ?? cat.defaultPriority,
      healthStatus,
      totalRequests: row?.totalRequests ?? 0,
      failedRequests: row?.failedRequests ?? 0,
      lastLatencyMs: row?.lastLatencyMs ?? null,
      lastCheckedAt: row?.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
      lastErrorMessage: keyConfigured
        ? row?.lastErrorMessage ?? null
        : cat.providerId === 'gemini'
          ? 'Built-in server-side Gemini runtime is not configured.'
          : `Server environment variable ${cat.envVarName} is not configured.`,
    };
  }).sort((a, b) => a.fallbackPriority - b.fallbackPriority);
}

export async function updateWorkspaceAiProviderSettings(params: {
  userId: string;
  workspaceId: string;
  providerId: AiProviderId;
  enabled?: boolean;
  preferredModel?: string;
  fallbackPriority?: number;
}): Promise<AiProviderStatusRecord[]> {
  const cat = AI_PROVIDER_CATALOG.find((c) => c.providerId === params.providerId);
  if (!cat) {
    throw new Error(`Unknown AI provider "${params.providerId}".`);
  }

  if (
    params.preferredModel &&
    !cat.supportedModels.includes(params.preferredModel)
  ) {
    throw new Error(
      `Model "${params.preferredModel}" is not supported for ${cat.name}.`
    );
  }

  await upsertAiProviderConfigForWorkspace({
    userId: params.userId,
    workspaceId: params.workspaceId,
    providerId: params.providerId,
    enabled: params.enabled,
    preferredModel: params.preferredModel,
    fallbackPriority: params.fallbackPriority,
  });

  return listWorkspaceAiProviders({
    userId: params.userId,
    workspaceId: params.workspaceId,
  });
}

export async function runAiProviderHealthCheck(params: {
  userId: string;
  workspaceId: string;
  providerId: AiProviderId;
  env?: NodeJS.ProcessEnv;
  transport?: (
    req: SafeOutboundHttpRequestParams
  ) => Promise<SafeOutboundHttpResponse>;
}): Promise<{
  healthy: boolean;
  latencyMs: number;
  detail: string;
  providers: AiProviderStatusRecord[];
}> {
  const env = params.env ?? process.env;
  const transport = params.transport ?? safeOutboundHttpRequest;
  const started = Date.now();
  const checkedAt = new Date();

  if (!isServerKeyPresent(params.providerId, env)) {
    const detail = `Server-side API key is not configured for ${params.providerId}.`;
    await upsertAiProviderConfigForWorkspace({
      userId: params.userId,
      workspaceId: params.workspaceId,
      providerId: params.providerId,
      lastHealthStatus: 'disabled',
      lastCheckedAt: checkedAt,
      lastErrorMessage: detail,
    });
    return {
      healthy: false,
      latencyMs: 0,
      detail,
      providers: await listWorkspaceAiProviders({
        userId: params.userId,
        workspaceId: params.workspaceId,
        env,
      }),
    };
  }

  try {
    if (params.providerId === 'gemini') {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const resp = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: 'Reply with OK',
      });
      const latencyMs = Date.now() - started;
      const ok = Boolean(resp.text && resp.text.trim().length > 0);
      const detail = ok
        ? `Gemini runtime responded in ${latencyMs}ms.`
        : 'Gemini runtime returned an empty response.';

      await upsertAiProviderConfigForWorkspace({
        userId: params.userId,
        workspaceId: params.workspaceId,
        providerId: 'gemini',
        lastHealthStatus: ok ? 'healthy' : 'degraded',
        lastLatencyMs: latencyMs,
        lastCheckedAt: checkedAt,
        lastErrorMessage: ok ? null : detail,
        incrementTotal: true,
        incrementFailed: !ok,
      });

      return {
        healthy: ok,
        latencyMs,
        detail,
        providers: await listWorkspaceAiProviders({
          userId: params.userId,
          workspaceId: params.workspaceId,
          env,
        }),
      };
    }

    if (params.providerId === 'openai') {
      const res = await transport({
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY!.trim()}`,
        },
        timeoutMs: 8000,
      });
      const latencyMs = Date.now() - started;
      const detail = res.ok
        ? `OpenAI API verified (HTTP ${res.status} in ${latencyMs}ms).`
        : `OpenAI API health check returned HTTP ${res.status}.`;

      await upsertAiProviderConfigForWorkspace({
        userId: params.userId,
        workspaceId: params.workspaceId,
        providerId: 'openai',
        lastHealthStatus: res.ok ? 'healthy' : 'unhealthy',
        lastLatencyMs: latencyMs,
        lastCheckedAt: checkedAt,
        lastErrorMessage: res.ok ? null : detail,
        incrementTotal: true,
        incrementFailed: !res.ok,
      });

      return {
        healthy: res.ok,
        latencyMs,
        detail,
        providers: await listWorkspaceAiProviders({
          userId: params.userId,
          workspaceId: params.workspaceId,
          env,
        }),
      };
    }

    // anthropic
    const res = await transport({
      url: 'https://api.anthropic.com/v1/models',
      method: 'GET',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY!.trim(),
        'anthropic-version': '2023-06-01',
      },
      timeoutMs: 8000,
    });
    const latencyMs = Date.now() - started;
    const detail = res.ok
      ? `Anthropic API verified (HTTP ${res.status} in ${latencyMs}ms).`
      : `Anthropic API health check returned HTTP ${res.status}.`;

    await upsertAiProviderConfigForWorkspace({
      userId: params.userId,
      workspaceId: params.workspaceId,
      providerId: 'anthropic',
      lastHealthStatus: res.ok ? 'healthy' : 'unhealthy',
      lastLatencyMs: latencyMs,
      lastCheckedAt: checkedAt,
      lastErrorMessage: res.ok ? null : detail,
      incrementTotal: true,
      incrementFailed: !res.ok,
    });

    return {
      healthy: res.ok,
      latencyMs,
      detail,
      providers: await listWorkspaceAiProviders({
        userId: params.userId,
        workspaceId: params.workspaceId,
        env,
      }),
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - started;
    const safeMsg =
      err instanceof Error
        ? redactSecretsFromText(err.message, env)
        : 'Health check failed.';

    await upsertAiProviderConfigForWorkspace({
      userId: params.userId,
      workspaceId: params.workspaceId,
      providerId: params.providerId,
      lastHealthStatus: 'unhealthy',
      lastLatencyMs: latencyMs,
      lastCheckedAt: checkedAt,
      lastErrorMessage: safeMsg,
      incrementTotal: true,
      incrementFailed: true,
    });

    return {
      healthy: false,
      latencyMs,
      detail: safeMsg,
      providers: await listWorkspaceAiProviders({
        userId: params.userId,
        workspaceId: params.workspaceId,
        env,
      }),
    };
  }
}
