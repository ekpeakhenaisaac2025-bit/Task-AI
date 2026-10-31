import crypto from 'node:crypto';
import {
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
import {
  detectRequiresApproval,
  normalizeActionCategory,
  normalizeCapabilities,
  normalizeToolId,
  validateAndNormalizePlan,
  type NormalizedPlannedTask,
} from '../lib/domain-rules.ts';
import {
  applyReasoningSafetyGuardrails,
  buildReasoningSituationDiagnostics,
} from '../lib/reasoning-guardrails.ts';
import type {
  CapabilityId,
  ChatAttachmentRecord,
  ChatModelId,
  GoalMetricValueRecord,
  GoalRecord,
  IntegrationProviderKey,
  NextActionProposalRecord,
  OutcomeEvidenceRecord,
  TaskAttemptRecord,
  TaskRecord,
} from '../types.ts';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim() || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server. Please check or select an API key in the Settings > Secrets panel.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 25000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isGeminiConfigured(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;
  return Boolean(apiKey && apiKey.trim() && apiKey !== 'MY_GEMINI_API_KEY');
}

export interface GeminiAttemptSpec {
  model: 'gemini-3.8-flash' | 'gemini-3.1-flash-lite' | 'gemini-flash-latest';
  thinkingLevel?: ThinkingLevel;
  timeoutMs: number;
  delayBeforeMs: number;
}

const MODEL_COOLDOWN_MS = 120_000;
const modelCooldownUntilMs = new Map<string, number>();

function markModelTransientFailure(model: string): void {
  modelCooldownUntilMs.set(model, Date.now() + MODEL_COOLDOWN_MS);
}

function clearModelCooldown(model: string): void {
  modelCooldownUntilMs.delete(model);
}

function isModelInCooldown(model: string): boolean {
  const until = modelCooldownUntilMs.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    modelCooldownUntilMs.delete(model);
    return false;
  }
  return true;
}

export function getResilientFlashAttemptSpecs(): GeminiAttemptSpec[] {
  return [
    {
      model: 'gemini-3.8-flash',
      thinkingLevel: ThinkingLevel.LOW,
      timeoutMs: 6000,
      delayBeforeMs: 0,
    },
    {
      model: 'gemini-3.1-flash-lite',
      thinkingLevel: ThinkingLevel.MINIMAL,
      timeoutMs: 12000,
      delayBeforeMs: 150,
    },
    {
      model: 'gemini-flash-latest',
      timeoutMs: 12000,
      delayBeforeMs: 300,
    },
    {
      model: 'gemini-3.1-flash-lite',
      thinkingLevel: ThinkingLevel.MINIMAL,
      timeoutMs: 15000,
      delayBeforeMs: 800,
    },
  ];
}

export function formatGeminiApiError(err: unknown): Error {
  const rawMessage =
    err instanceof Error ? err.message : String(err ?? 'Unknown Gemini error');
  const upper = rawMessage.toUpperCase();

  if (
    upper.includes('API_KEY_INVALID') ||
    upper.includes('PERMISSION_DENIED') ||
    upper.includes('API KEY NOT VALID') ||
    /\b403\b/.test(rawMessage)
  ) {
    return new Error(
      'Gemini API authentication failed (invalid or unauthorized key). Please check your GEMINI_API_KEY in the Settings > Secrets panel.'
    );
  }

  if (upper.includes('RESOURCE_EXHAUSTED') || /\b429\b/.test(rawMessage)) {
    return new Error(
      'Gemini API quota reached (429 RESOURCE_EXHAUSTED). Please retry shortly or select a billing-enabled API key in the Settings > Secrets panel.'
    );
  }

  return err instanceof Error
    ? err
    : new Error('Gemini API request failed across configured models.');
}

function isTransientGeminiUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const upper = msg.toUpperCase();
  if (
    upper.includes('API_KEY_INVALID') ||
    upper.includes('PERMISSION_DENIED') ||
    upper.includes('API KEY NOT VALID') ||
    upper.includes('RESOURCE_EXHAUSTED') ||
    /\b(?:400|401|403|429)\b/.test(msg)
  ) {
    return false;
  }
  return (
    upper.includes('UNAVAILABLE') ||
    /\b(?:502|503|504)\b/.test(msg) ||
    upper.includes('HIGH DEMAND') ||
    upper.includes('ABORTED') ||
    upper.includes('TIMED OUT') ||
    upper.includes('TIMEOUT') ||
    upper.includes('FETCH FAILED')
  );
}

async function generateWithResilientFlash(
  ai: GoogleGenAI,
  baseParams: Omit<GenerateContentParameters, 'model'>
): Promise<{ response: GenerateContentResponse; modelUsed: string }> {
  const rawAttempts = getResilientFlashAttemptSpecs();
  const attempts = [
    ...rawAttempts.filter((s) => !isModelInCooldown(s.model)),
    ...rawAttempts.filter((s) => isModelInCooldown(s.model)),
  ];

  let lastError: unknown = null;

  for (let idx = 0; idx < attempts.length; idx++) {
    const step = attempts[idx]!;
    if (idx > 0 && step.delayBeforeMs > 0) {
      await new Promise((r) => setTimeout(r, step.delayBeforeMs));
    }
    try {
      const response = await ai.models.generateContent({
        ...baseParams,
        model: step.model,
        config: {
          ...baseParams.config,
          ...(step.thinkingLevel !== undefined
            ? {
                thinkingConfig: {
                  thinkingLevel: step.thinkingLevel,
                },
              }
            : {}),
          abortSignal: AbortSignal.timeout(step.timeoutMs),
        },
      });
      if (response.text) {
        clearModelCooldown(step.model);
        return { response, modelUsed: step.model };
      }
    } catch (err: unknown) {
      lastError = err;
      const upper = (
        err instanceof Error ? err.message : String(err)
      ).toUpperCase();
      if (
        upper.includes('API_KEY_INVALID') ||
        upper.includes('API KEY NOT VALID')
      ) {
        break;
      }
      if (isTransientGeminiUnavailableError(err)) {
        markModelTransientFailure(step.model);
      }
      console.warn(
        `Model ${step.model} attempt failed, trying next fallback:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  throw formatGeminiApiError(lastError);
}

/**
 * Generates a structured, integration-independent JSON task plan.
 * Receives ONLY sanitized capability enums and provider categories — NEVER secrets, URLs, or headers.
 */
export async function generateValidatedPlanWithGemini(params: {
  goalId: string;
  problem: string;
  targetMetric: string;
  deadline?: string | null;
  availableCapabilities?: CapabilityId[];
  preferredExternalProvider?: IntegrationProviderKey | null;
}): Promise<NormalizedPlannedTask[]> {
  const ai = getGeminiClient();

  const capabilitiesSummary =
    params.availableCapabilities && params.availableCapabilities.length > 0
      ? params.availableCapabilities.join(', ')
      : 'ai_reasoning, content_drafting, prospect_qualification, diagnostic_verification';

  const externalToolGuidance = params.preferredExternalProvider
    ? `"${params.preferredExternalProvider}" (currently verified in this user's workspace)`
    : '"custom_webhook", "n8n_webhook", "make_webhook", "zapier_webhook", "crm_webhook", "gmail_api", "google_calendar_api", or "payment_webhook" (requires workspace provider configuration before execution)';

  const systemInstruction = `You are the server-side AI Planner for Task.ai, an integration-independent multi-tenant task execution platform.
Convert the user's goal into a structured JSON array of 4 concrete tasks.

STRICT RULES:
1. ONLY use these exact values for "tool" (the proposed execution provider type):
   - "llm_reasoning": Built-in server LLM for defining criteria, researching strategy, or drafting outreach messages/templates.
   - "internal_test_tool": Built-in deterministic pre-flight verification tool for checking readiness and artifacts.
   - "custom_webhook", "n8n_webhook", "make_webhook", "zapier_webhook", "crm_webhook", "gmail_api", "google_calendar_api", "payment_webhook": Workspace-configurable external execution adapters.
   - "unsupported": For actions requiring unconfigured live web scraping or ad spend with no compatible capability.
   NEVER invent any other tool names. Note: External workflow steps should propose ${externalToolGuidance}.
2. Every task MUST specify "required_capabilities" using ONLY values from:
   - "ai_reasoning", "content_drafting", "prospect_qualification", "diagnostic_verification", "workflow_automation", "message_dispatch", "crm_sync", "prospect_search", "http_request", "calendar_booking", "payment_verification"
3. ONLY use these exact values for "action_category":
   - "prospect_research", "prospect_qualification", "message_draft", "message_send", "calendar_booking", "crm_update", "payment_collection", "external_workflow", "internal_test", "analysis", "unsupported"
4. Structure a logical dependency chain using "step_id" ("step_1", "step_2", "step_3", "step_4") in "dependencies":
   - step_1: Qualification rubric / execution strategy ("llm_reasoning", capabilities: ["ai_reasoning", "prospect_qualification"], dependencies: [], approval_required: false).
   - step_2: Draft concrete outreach or deliverable assets ("llm_reasoning", "message_draft", capabilities: ["ai_reasoning", "content_drafting"], dependencies: ["step_1"], approval_required: false).
   - step_3: Run harmless internal pre-flight verification ("internal_test_tool", "internal_test", capabilities: ["diagnostic_verification"], dependencies: ["step_2"], approval_required: true).
   - step_4: Consequential external execution (propose ${params.preferredExternalProvider ? `"${params.preferredExternalProvider}"` : '"custom_webhook"'}, capabilities: ["workflow_automation", "message_dispatch"], dependencies: ["step_3"], approval_required: true).
5. Any task that contacts people, sends messages, spends money, books meetings, updates CRM records, or triggers external webhooks MUST set "approval_required": true and populate "proposed_action", "target_recipient", "estimated_cost", and "consequence_explanation".
6. Never confuse target_metric with an already-achieved result.`;

  const deadlineLine = params.deadline
    ? `Goal Deadline: ${params.deadline}`
    : 'Goal Deadline: None specified';

  const prompt = `Goal ID: ${params.goalId}
Goal Description / Problem: ${params.problem}
Desired Target Metric (NOT yet achieved): ${params.targetMetric}
${deadlineLine}
Verified Capabilities Currently Active in User Workspace: ${capabilitiesSummary}

Generate the structured JSON task plan.`;

  const { response } = await generateWithResilientFlash(ai, {
    contents: prompt,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            step_id: {
              type: Type.STRING,
              description: 'Sequential identifier such as step_1, step_2',
            },
            description: {
              type: Type.STRING,
              description: 'Clear actionable description of the task',
            },
            tool: {
              type: Type.STRING,
              description:
                'Proposed provider: llm_reasoning, internal_test_tool, custom_webhook, n8n_webhook, or unsupported',
            },
            required_capabilities: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description:
                'Required capabilities such as ["ai_reasoning", "content_drafting"] or ["workflow_automation", "message_dispatch"]',
            },
            action_category: {
              type: Type.STRING,
              description:
                'Must be one of: analysis, prospect_qualification, message_draft, internal_test, message_send, external_workflow, unsupported',
            },
            dependencies: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Prerequisite step_ids such as ["step_1"]',
            },
            approval_required: {
              type: Type.BOOLEAN,
              description:
                'True if contacting people, sending messages, spending money, publishing, or changing external systems',
            },
            proposed_action: {
              type: Type.STRING,
              description: 'Exact action to show in the Approval Gate',
            },
            target_recipient: {
              type: Type.STRING,
              description: 'Intended audience, recipient, or external endpoint',
            },
            estimated_cost: {
              type: Type.STRING,
              description: 'Known or estimated monetary cost',
            },
            consequence_explanation: {
              type: Type.STRING,
              description:
                'Plain-language explanation of what will happen upon execution',
            },
            expected_result: {
              type: Type.STRING,
              description:
                'Concrete artifact or measurable output expected from this task',
            },
            verification_method: {
              type: Type.STRING,
              description:
                'Verification criteria used to confirm the expected outcome',
            },
          },
          required: [
            'step_id',
            'description',
            'tool',
            'required_capabilities',
            'action_category',
            'dependencies',
            'approval_required',
            'expected_result',
            'verification_method',
          ],
        },
      },
    },
  });

  const rawText = response.text;
  if (!rawText) {
    throw new Error('Gemini AI planner returned an empty response.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error('Gemini AI planner returned invalid JSON syntax.', {
      cause: err,
    });
  }

  return validateAndNormalizePlan(parsed, params.goalId, () =>
    crypto.randomUUID()
  );
}

export async function executeLlmReasoningTask(params: {
  problem: string;
  targetMetric: string;
  task: TaskRecord;
  prerequisiteOutputs: Array<{
    stepOrder: number;
    description: string;
    outputData: Record<string, unknown> | null;
  }>;
}): Promise<{
  summary: string;
  outputData: Record<string, unknown>;
}> {
  const ai = getGeminiClient();

  const prereqContext =
    params.prerequisiteOutputs.length > 0
      ? params.prerequisiteOutputs
          .map(
            (p) =>
              `Step ${p.stepOrder} (${p.description}): ${JSON.stringify(p.outputData ?? {})}`
          )
          .join('\n')
      : 'None (root task)';

  if (params.task.actionCategory === 'message_draft') {
    const { response, modelUsed } = await generateWithResilientFlash(ai, {
      contents: `Goal Problem: ${params.problem}
Target Metric: ${params.targetMetric}
Prerequisite Outputs:
${prereqContext}

Execute Task: ${params.task.description}
Expected Result: ${params.task.expectedResult}

Produce 3 concrete, ready-to-review outreach message drafts tailored to the problem. Remember: these are DRAFTS ONLY and have NOT been sent to anyone.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: {
              type: Type.STRING,
              description: 'Concise summary of the drafted messages',
            },
            draftedMessages: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  targetPersona: { type: Type.STRING },
                  subjectLine: { type: Type.STRING },
                  messageBody: { type: Type.STRING },
                },
                required: ['targetPersona', 'subjectLine', 'messageBody'],
              },
            },
          },
          required: ['summary', 'draftedMessages'],
        },
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error(
        'LLM reasoning tool returned empty message draft output.'
      );
    }
    const parsed = JSON.parse(text) as {
      summary: string;
      draftedMessages: Array<{
        targetPersona: string;
        subjectLine: string;
        messageBody: string;
      }>;
    };

    return {
      summary: `${parsed.summary} (${parsed.draftedMessages.length} drafts saved; 0 messages sent)`,
      outputData: {
        executionModel: modelUsed,
        deliveryState: 'drafted_only_not_sent',
        draftedMessages: parsed.draftedMessages,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  const { response, modelUsed } = await generateWithResilientFlash(ai, {
    contents: `Goal Problem: ${params.problem}
Target Metric: ${params.targetMetric}
Prerequisite Outputs:
${prereqContext}

Execute Reasoning Task: ${params.task.description}
Expected Result: ${params.task.expectedResult}

Produce concrete, structured analytical criteria and actionable deliverables. Never fabricate external customer wins, sent emails, or live scraped contacts.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          keyCriteria: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          deliverableMarkdown: { type: Type.STRING },
          verificationCheck: { type: Type.STRING },
        },
        required: [
          'summary',
          'keyCriteria',
          'deliverableMarkdown',
          'verificationCheck',
        ],
      },
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('LLM reasoning tool returned empty output.');
  }
  const parsed = JSON.parse(text) as {
    summary: string;
    keyCriteria: string[];
    deliverableMarkdown: string;
    verificationCheck: string;
  };

  return {
    summary: parsed.summary,
    outputData: {
      executionModel: modelUsed,
      keyCriteria: parsed.keyCriteria,
      deliverable: parsed.deliverableMarkdown,
      verificationCheck: parsed.verificationCheck,
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Advisory AI-Assisted Verification Analysis.
 * Evaluates external evidence consistency against goal/task success criteria.
 * NEVER fabricates evidence or promotes unverified claims to verified outcomes—returns advisory
 * `recommended_verify` or `recommended_reject` for audit logging and human review.
 */
export async function analyzeEvidenceWithGemini(params: {
  goalProblem: string;
  goalTargetMetric: string;
  taskDescription: string | null;
  taskVerificationCriteria: string | null;
  evidence: Pick<
    OutcomeEvidenceRecord,
    | 'sourceType'
    | 'provider'
    | 'evidenceType'
    | 'externalReferenceId'
    | 'summary'
    | 'structuredMetrics'
    | 'verificationState'
  > &
    Partial<
      Pick<
        OutcomeEvidenceRecord,
        'provenanceClass' | 'trustTier' | 'hasConflict' | 'sanitizedPayload'
      >
    >;
}): Promise<{
  modelUsed: string;
  recommendation: 'recommended_verify' | 'recommended_reject';
  confidenceLevel: 'low' | 'medium' | 'high';
  reasoningNotes: string;
  consistencyFlags: string[];
}> {
  const ai = getGeminiClient();

  const hardReject =
    params.evidence.evidenceType === 'api_dispatch_ack' ||
    params.evidence.evidenceType === 'diagnostic_checksum' ||
    params.evidence.hasConflict === true ||
    params.evidence.structuredMetrics?.unverifiedClaim === true ||
    params.evidence.structuredMetrics?.livemode === false ||
    params.evidence.sanitizedPayload?.livemode === false;

  const systemInstruction = `You are the AI-Assisted Outcome Verification Auditor for Task.ai.
Your role is STRICTLY ADVISORY. You evaluate whether submitted outcome evidence is consistent with the goal's target metric and the task's verification criteria.
STRICT INVARIANTS:
- Never fabricate external proof.
- Mere HTTP 200 API dispatch acknowledgements ("api_dispatch_ack"), internal diagnostics ("diagnostic_checksum"), or drafted messages do NOT prove delivery, replies, meetings, or revenue; recommend "recommended_reject".
- If hasConflict is true, livemode is false, unverifiedClaim is true, or externalReferenceId is synthetic/demo/missing without concrete settled metrics, flag the discrepancy and recommend "recommended_reject".
- Keep reasoningNotes concise (2-3 sentences).`;

  const prompt = `Goal Problem: ${params.goalProblem}
Goal Target Metric: ${params.goalTargetMetric}
Task Description: ${params.taskDescription ?? 'Workspace-level goal evidence'}
Task Verification Criteria: ${params.taskVerificationCriteria ?? 'Match goal target metric with concrete external reference'}

Submitted Evidence Record (Sanitized):
${JSON.stringify(params.evidence, null, 2)}

Evaluate consistency and return structured JSON.`;

  let modelUsed = 'deterministic_auditor_fallback';
  let parsed: {
    recommendation?: string;
    confidenceLevel?: string;
    reasoningNotes?: string;
    consistencyFlags?: string[];
  };

  try {
    const res = await generateWithResilientFlash(ai, {
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendation: {
              type: Type.STRING,
              description: 'Must be "recommended_verify" or "recommended_reject"',
            },
            confidenceLevel: {
              type: Type.STRING,
              description: 'Must be "low", "medium", or "high"',
            },
            reasoningNotes: {
              type: Type.STRING,
              description: 'Concise audit explanation of evidence consistency',
            },
            consistencyFlags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Specific observations or discrepancies found',
            },
          },
          required: [
            'recommendation',
            'confidenceLevel',
            'reasoningNotes',
            'consistencyFlags',
          ],
        },
      },
    });
    modelUsed = res.modelUsed;
    const text = res.response.text;
    if (!text) {
      throw new Error('Gemini evidence consistency auditor returned empty output.');
    }
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    if (!isTransientGeminiUnavailableError(err)) {
      throw err;
    }
    const hasConcreteRef =
      typeof params.evidence.externalReferenceId === 'string' &&
      params.evidence.externalReferenceId.trim().length >= 3 &&
      !/^(?:ref_demo|evt_demo|test|demo|mock|fake|sandbox)/i.test(
        params.evidence.externalReferenceId.trim()
      );
    const flags: string[] = [
      'Upstream Gemini service experienced transient 503/timeout load; deterministic consistency rules applied.',
    ];
    if (hardReject) {
      flags.push(
        'Hard consistency rejection triggered (conflict, test/sandbox flag, unverified claim, or non-outcome event type).'
      );
    } else if (!hasConcreteRef) {
      flags.push('Missing or synthetic externalReferenceId.');
    }
    parsed = {
      recommendation:
        !hardReject && hasConcreteRef
          ? 'recommended_verify'
          : 'recommended_reject',
      confidenceLevel: 'low',
      reasoningNotes: hardReject
        ? 'Deterministic consistency audit flagged conflicting, non-live, or non-outcome evidence while upstream Gemini was temporarily unavailable; human review required.'
        : hasConcreteRef
          ? 'Deterministic consistency audit confirmed concrete external reference alignment while upstream Gemini was temporarily unavailable; explicit human verification is still required.'
          : 'Deterministic consistency audit could not confirm a concrete live external reference while upstream Gemini was temporarily unavailable; recommend rejection or human inspection.',
      consistencyFlags: flags,
    };
  }

  const recommendation =
    !hardReject && parsed.recommendation === 'recommended_verify'
      ? 'recommended_verify'
      : 'recommended_reject';

  const confidenceLevel =
    parsed.confidenceLevel === 'high' || parsed.confidenceLevel === 'medium'
      ? parsed.confidenceLevel
      : 'low';

  return {
    modelUsed,
    recommendation,
    confidenceLevel,
    reasoningNotes:
      parsed.reasoningNotes?.trim() ||
      'Advisory consistency check completed.',
    consistencyFlags: Array.isArray(parsed.consistencyFlags)
      ? parsed.consistencyFlags.slice(0, 6)
      : [],
  };
}

/**
 * Continuous AI Reasoning Engine.
 * Evaluates execution cycle results, verified vs target metrics, task failures/blocks,
 * and proposes concrete next actions without ever bypassing the Approval Gate or
 * falsely declaring an unverified goal achieved.
 */
export async function analyzeExecutionCycleWithGemini(params: {
  goal: GoalRecord;
  tasks: TaskRecord[];
  metrics: GoalMetricValueRecord[];
  recentAttempts: TaskAttemptRecord[];
  recentEvidence: OutcomeEvidenceRecord[];
  verifiedCapabilities: CapabilityId[];
  preferredExternalProvider: IntegrationProviderKey | null;
  nowMs?: number;
}): Promise<{
  modelUsed: string;
  currentAssessment: string;
  goalAchievedRecommendation: boolean;
  humanInterventionRequired: boolean;
  confidenceLevel: 'low' | 'medium' | 'high';
  reasoningSummary: string;
  findings: string[];
  recommendedNextActions: string[];
  proposals: Array<{
    proposalType: NextActionProposalRecord['proposalType'];
    title: string;
    description: string;
    proposedTool: TaskRecord['tool'];
    actionCategory: TaskRecord['actionCategory'];
    requiredCapabilities: CapabilityId[];
    dependencies: string[];
    targetTaskId: string | null;
    approvalRequired: boolean;
    expectedOutcome: string;
    verificationMethod: string;
  }>;
}> {
  const ai = getGeminiClient();

  const preDiagnostics = buildReasoningSituationDiagnostics({
    goal: params.goal,
    tasks: params.tasks,
    metrics: params.metrics,
    recentAttempts: params.recentAttempts,
    recentEvidence: params.recentEvidence,
    verifiedCapabilities: params.verifiedCapabilities,
    nowMs: params.nowMs,
  });

  const sanitizedTasks = params.tasks.map((t) => ({
    id: t.id,
    stepOrder: t.stepOrder,
    description: t.description,
    tool: t.tool,
    actionCategory: t.actionCategory,
    requiredCapabilities: t.requiredCapabilities,
    dependencies: t.dependencies,
    approvalRequired: t.approvalRequired,
    approvalStatus: t.approvalStatus,
    status: t.status,
    verificationStatus: t.verificationStatus,
    reconciliationRequired: t.reconciliationRequired,
    retryCount: t.retryCount,
    maxRetries: t.maxRetries,
    statusReason: t.statusReason,
  }));

  const sanitizedMetrics = params.metrics.map((m) => ({
    metricKey: m.metricKey,
    metricLabel: m.metricLabel,
    unit: m.unit,
    isPrimaryTarget: m.isPrimaryTarget,
    targetValue: m.targetValue,
    attemptedValue: m.attemptedValue,
    completedValue: m.completedValue,
    verifiedValue: m.verifiedValue,
    estimatedValue: m.estimatedValue,
  }));

  const sanitizedAttempts = params.recentAttempts.slice(0, 10).map((a) => ({
    taskId: a.taskId,
    attemptNumber: a.attemptNumber,
    providerKey: a.providerKey,
    status: a.status,
    errorMessage: a.errorMessage,
    outputSummary: a.outputSummary,
  }));

  const sanitizedEvidence = params.recentEvidence.slice(0, 10).map((e) => ({
    evidenceType: e.evidenceType,
    provider: e.provider,
    externalReferenceId: e.externalReferenceId,
    provenanceClass: e.provenanceClass,
    trustTier: e.trustTier,
    hasConflict: e.hasConflict,
    verificationState: e.verificationState,
    requiresHumanReview: e.requiresHumanReview,
    summary: e.summary,
    structuredMetrics: e.structuredMetrics,
  }));

  const systemInstruction = `You are the Continuous AI Reasoning Engine for Task.ai.
Analyze the goal's current execution state, verified outcome metrics, task failures/blocks, evidence provenance/trust tiers, and operational situation diagnostics.
STRICT SAFETY & HONESTY INVARIANTS:
1. NEVER set "goalAchievedRecommendation": true unless all quantified primary target metrics have targetValue > 0 and verifiedValue >= targetValue with zero conflicting evidence. Completed tasks, internal SHA-256 diagnostics ("internal_diagnostic"), or uncorroborated "authenticated_webhook" claims NEVER achieve a business goal on their own.
2. NEVER propose "retry_task" for any task where reconciliationRequired is true (timed-out or crashed external execution with uncertain side effects). Instead propose "human_intervention" to reconcile external logs/evidence first.
3. When a provider repeatedly fails or exhausts retries, diagnose root cause, propose switching capability adapters, or request human credential inspection instead of blind repetitive retries.
4. When tasks completed execution (drafts or HTTP 200 dispatches) with zero verified business results, diagnose funnel/messaging/targeting bottlenecks or missing verification callbacks.
5. When resources/budget are insufficient, deadlines have expired, targets are unquantified/unrealistic, or required integrations are missing, set "humanInterventionRequired": true and propose concrete "human_intervention" or prerequisite diagnostic steps.
6. Preserve prerequisite ordering by populating "dependencies" with upstream task IDs when proposing follow-up tasks.
7. Proposal "proposalType" MUST be one of: "new_task", "retry_task", "update_dependencies", "human_intervention".
8. Proposal "proposedTool" MUST be one of: "llm_reasoning", "internal_test_tool", "custom_webhook", "n8n_webhook", "make_webhook", "zapier_webhook", "crm_webhook", "gmail_api", "google_calendar_api", "payment_webhook".
9. Any proposal that contacts people, sends messages, books calendar events, updates CRM records, collects payments, or triggers external webhooks MUST set "approvalRequired": true.
10. Never invent secrets, URLs, or fake customer conversions.`;

  const diagnosticsBlock =
    preDiagnostics.diagnosticFlags.length > 0
      ? preDiagnostics.diagnosticFlags.map((f) => `- ${f}`).join('\n')
      : '- No critical anomalies detected.';

  const prompt = `Goal ID: ${params.goal.id}
Goal Problem: ${params.goal.problem}
Stated Target Metric: ${params.goal.targetMetric}
Goal Deadline: ${params.goal.deadline ?? 'None specified'}
Current Goal Status: ${params.goal.status} (Engine: ${params.goal.executionState}, Verified Progress: ${params.goal.progressPercent}%)
Primary Target Verified Satisfied: ${preDiagnostics.verifiedPrimarySatisfied}
Workspace Verified Capabilities: ${params.verifiedCapabilities.join(', ') || 'diagnostic_verification'}
Preferred External Provider: ${params.preferredExternalProvider ?? 'None verified in workspace'}

Deterministic Situation Diagnostics:
${diagnosticsBlock}

Multi-Metric Progress Breakdown:
${JSON.stringify(sanitizedMetrics, null, 2)}

Current Tasks:
${JSON.stringify(sanitizedTasks, null, 2)}

Recent Execution Attempts:
${JSON.stringify(sanitizedAttempts, null, 2)}

Recent Outcome Evidence (with Provenance & Trust Tiers):
${JSON.stringify(sanitizedEvidence, null, 2)}

Analyze what succeeded, what failed or stalled, whether assumptions hold, whether human approval, reconciliation, conflict resolution, or provider configuration is needed, and generate structured next-action proposals.`;

  let modelUsed = 'deterministic_guardrail_fallback';
  let parsed: Record<string, unknown> = {};

  try {
    const res = await generateWithResilientFlash(ai, {
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            currentAssessment: {
              type: Type.STRING,
              description: 'One-sentence executive status assessment',
            },
            goalAchievedRecommendation: {
              type: Type.BOOLEAN,
              description:
                'True ONLY if verified primary target metrics meet or exceed targetValue',
            },
            humanInterventionRequired: {
              type: Type.BOOLEAN,
              description:
                'True if tasks are blocked on human approval, reconciliation, evidence conflict/review, expired deadline, or missing workspace integration credentials',
            },
            confidenceLevel: {
              type: Type.STRING,
              description: 'low, medium, or high',
            },
            reasoningSummary: {
              type: Type.STRING,
              description:
                '2-4 sentence causal analysis of outcomes, assumptions, and bottlenecks',
            },
            findings: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '3-5 specific factual findings from tasks and metrics',
            },
            recommendedNextActions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Summary list of recommended next steps',
            },
            proposals: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  proposalType: {
                    type: Type.STRING,
                    description:
                      'new_task, retry_task, update_dependencies, or human_intervention',
                  },
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  proposedTool: { type: Type.STRING },
                  actionCategory: { type: Type.STRING },
                  requiredCapabilities: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  dependencies: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description:
                      'Optional prerequisite task IDs belonging to this goal',
                  },
                  targetTaskId: {
                    type: Type.STRING,
                    description:
                      'Existing task ID if proposalType is retry_task/human_intervention or empty string',
                  },
                  approvalRequired: { type: Type.BOOLEAN },
                  expectedOutcome: { type: Type.STRING },
                  verificationMethod: { type: Type.STRING },
                },
                required: [
                  'proposalType',
                  'title',
                  'description',
                  'proposedTool',
                  'actionCategory',
                  'requiredCapabilities',
                  'approvalRequired',
                  'expectedOutcome',
                  'verificationMethod',
                ],
              },
            },
          },
          required: [
            'currentAssessment',
            'goalAchievedRecommendation',
            'humanInterventionRequired',
            'confidenceLevel',
            'reasoningSummary',
            'findings',
            'recommendedNextActions',
            'proposals',
          ],
        },
      },
    });
    modelUsed = res.modelUsed;
    const text = res.response.text;
    if (!text) {
      throw new Error('Continuous AI Reasoning Engine returned empty output.');
    }
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    if (!isTransientGeminiUnavailableError(err)) {
      throw err;
    }
    parsed = {
      confidenceLevel: 'low',
      reasoningSummary:
        'Upstream Gemini model pool returned transient 503/timeout unavailability; synthesized deterministic situation assessment and safe next-action proposals via reasoning guardrails.',
    };
  }

  const validated = applyReasoningSafetyGuardrails({
    raw: parsed,
    goal: params.goal,
    tasks: params.tasks,
    metrics: params.metrics,
    recentAttempts: params.recentAttempts,
    recentEvidence: params.recentEvidence,
    verifiedCapabilities: params.verifiedCapabilities,
    preferredExternalProvider: params.preferredExternalProvider,
    nowMs: params.nowMs,
  });

  return {
    modelUsed,
    currentAssessment: validated.currentAssessment,
    goalAchievedRecommendation: validated.goalAchievedRecommendation,
    humanInterventionRequired: validated.humanInterventionRequired,
    confidenceLevel: validated.confidenceLevel,
    reasoningSummary: validated.reasoningSummary,
    findings: validated.findings,
    recommendedNextActions: validated.recommendedNextActions,
    proposals: validated.proposals,
  };
}

function buildMessageParts(
  text: string,
  attachments: ChatAttachmentRecord[] = []
): Part[] {
  const parts: Part[] = [];

  for (const att of attachments) {
    if (att.kind === 'image' && att.dataUrl) {
      const match = att.dataUrl.match(
        /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/
      );
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2].replace(/\s+/g, ''),
          },
        });
      }
    } else if (att.textContent) {
      parts.push({
        text: `[Attached File: ${att.name} (${att.mimeType})]\n\`\`\`\n${att.textContent}\n\`\`\``,
      });
    } else {
      parts.push({
        text: `[Attached File Metadata: ${att.name} (${att.mimeType}, ${att.sizeBytes} bytes)]`,
      });
    }
  }

  if (text.trim().length > 0 || parts.length === 0) {
    parts.push({
      text: text.trim() || 'Please analyze the attached file(s).',
    });
  }

  return parts;
}

/**
 * Streams a conversational AI response through Task.ai's unified server-side Gemini gateway,
 * preserving multi-turn history, multimodal image/file attachments, workspace memory,
 * and honest execution verification constraints.
 */
export async function streamConversationalTurnWithGemini(params: {
  requestedModel: ChatModelId;
  workspaceContextSummary: string;
  history: Array<{
    role: 'user' | 'assistant';
    content: string;
    attachments?: ChatAttachmentRecord[];
  }>;
  currentPrompt: string;
  currentAttachments?: ChatAttachmentRecord[];
  executionSummaryContext?: string | null;
  abortSignal?: AbortSignal;
  onTextDelta: (delta: string) => void;
}): Promise<{ fullText: string; modelUsed: string }> {
  const ai = getGeminiClient();

  const systemInstruction = `You are Task.ai, an autonomous execution and outcome-verification AI assistant.
You communicate with clarity, precision, and executive polish in clean Markdown (headings, concise lists, tables, and fenced code blocks with language tags when helpful).

WORKSPACE MEMORY & CONTEXT:
${params.workspaceContextSummary}

STRICT HONESTY & EXECUTION RULES:
1. Never claim an external action (sending emails, contacting leads, booking meetings, updating CRMs, charging payments, or firing external webhooks) has been executed or verified unless the live execution record explicitly shows verified evidence.
2. When discussing or reporting on workspace tasks and goals, always distinguish between:
   - Drafted / analytical outputs (saved in the workspace as downloadable artifacts, 0 external messages sent).
   - Tasks paused at the Approval Gate (awaiting explicit human authorization).
   - Tasks dispatched to external webhooks awaiting independent verification callbacks ("pending_verification").
   - Authoritatively verified outcomes ("verified").
3. For general conversational questions, coding help, or file summarization where no execution pipeline ran, answer directly and naturally without appending artificial "Workspace Status" footers.
4. When producing reports, spreadsheets, rubrics, or technical specifications, structure them cleanly with Markdown headings or tables so the user can also download them as workspace artifacts.`;

  const contents: Content[] = [];
  const recentHistory = params.history.slice(-16);

  for (const turn of recentHistory) {
    if (!turn.content.trim() && (!turn.attachments || turn.attachments.length === 0)) {
      continue;
    }
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: buildMessageParts(turn.content, turn.attachments),
    });
  }

  const finalPromptText = params.executionSummaryContext
    ? `${params.currentPrompt}\n\n---\n[LIVE SERVER EXECUTION & VERIFICATION RECORD — GROUND YOUR RESPONSE STRICTLY IN THIS DATA]:\n${params.executionSummaryContext}`
    : params.currentPrompt;

  contents.push({
    role: 'user',
    parts: buildMessageParts(finalPromptText, params.currentAttachments),
  });

  const baseCandidates: ChatModelId[] = Array.from(
    new Set<ChatModelId>([
      params.requestedModel,
      'gemini-3.1-flash-lite',
      'gemini-3.8-flash',
      'gemini-flash-latest',
    ])
  );
  const candidateModels: ChatModelId[] = [
    ...baseCandidates.filter((m) => !isModelInCooldown(m)),
    ...baseCandidates.filter((m) => isModelInCooldown(m)),
  ];

  let lastError: unknown = null;

  for (const model of candidateModels) {
    if (params.abortSignal?.aborted) {
      return { fullText: '', modelUsed: model };
    }

    let emittedAny = false;
    let accumulated = '';
    const firstTokenAbort = new AbortController();
    const firstTokenTimer = setTimeout(() => {
      firstTokenAbort.abort(new Error('Upstream first-token timed out'));
    }, 5500);

    const combinedSignal = params.abortSignal
      ? AbortSignal.any([params.abortSignal, firstTokenAbort.signal])
      : firstTokenAbort.signal;

    try {
      const thinkingConfig =
        model === 'gemini-3.8-flash'
          ? { thinkingLevel: ThinkingLevel.LOW }
          : model === 'gemini-3.1-flash-lite'
            ? { thinkingLevel: ThinkingLevel.MINIMAL }
            : undefined;

      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction,
          ...(thinkingConfig ? { thinkingConfig } : {}),
          abortSignal: combinedSignal,
        },
      });

      for await (const chunk of stream) {
        clearTimeout(firstTokenTimer);
        if (params.abortSignal?.aborted) {
          break;
        }
        const c = chunk as GenerateContentResponse;
        const delta = c.text;
        if (typeof delta === 'string' && delta.length > 0) {
          emittedAny = true;
          accumulated += delta;
          params.onTextDelta(delta);
        }
      }

      clearTimeout(firstTokenTimer);

      if (accumulated.length > 0 || params.abortSignal?.aborted) {
        if (accumulated.length > 0) {
          clearModelCooldown(model);
        }
        return { fullText: accumulated, modelUsed: model };
      }
    } catch (err: unknown) {
      clearTimeout(firstTokenTimer);
      if (params.abortSignal?.aborted) {
        return { fullText: accumulated, modelUsed: model };
      }
      lastError = err;
      const isFirstTokenTimeout = firstTokenAbort.signal.aborted;
      if (isFirstTokenTimeout || isTransientGeminiUnavailableError(err)) {
        markModelTransientFailure(model);
      }
      if (
        emittedAny ||
        (!isFirstTokenTimeout && !isTransientGeminiUnavailableError(err))
      ) {
        break;
      }
      console.warn(
        `[Task.ai Chat Stream] Model ${model} unavailable, falling back:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Deterministic resilient fallback if all upstream models return 503 during an execution turn
  if (params.executionSummaryContext && isTransientGeminiUnavailableError(lastError)) {
    const fallbackMd = `### Execution Cycle Summary\n\nTask.ai executed your request against the workspace orchestration engine while upstream language synthesis experienced transient load.\n\n${params.executionSummaryContext}`;
    params.onTextDelta(fallbackMd);
    return {
      fullText: fallbackMd,
      modelUsed: 'deterministic_execution_summary',
    };
  }

  throw formatGeminiApiError(lastError);
}

