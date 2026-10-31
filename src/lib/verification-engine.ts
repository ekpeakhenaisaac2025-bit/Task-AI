import crypto from 'node:crypto';
import type {
  EvidenceProvenanceClass,
  EvidenceTrustTier,
  EvidenceType,
  TaskRecord,
  TaskStatus,
  ToolId,
  VerificationMethodType,
} from '../types.ts';
import { INTEGRATION_PROVIDER_KEYS } from './provider-registry.ts';

export const INBOUND_SIGNATURE_HEADER = 'x-taskai-signature';
export const INBOUND_PROVIDER_SIGNATURE_HEADER = 'x-taskai-provider-signature';
export const INBOUND_TIMESTAMP_HEADER = 'x-taskai-timestamp';
export const DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

export const VALID_EVIDENCE_TYPES: ReadonlySet<EvidenceType> =
  new Set<EvidenceType>([
    'message_delivered',
    'reply_received',
    'qualified_lead',
    'prospect_identified',
    'meeting_booked',
    'payment_confirmed',
    'customer_acquired',
    'custom_outcome',
    'api_dispatch_ack',
    'diagnostic_checksum',
    'outcome_reversal',
  ]);

const SYNTHETIC_REFERENCE_PATTERNS: readonly RegExp[] = [
  /^ref_demo(?:$|[_-])/i,
  /^evt_demo(?:$|[_-])/i,
  /^(?:test|demo|mock|fake|sample|sandbox|dummy|placeholder)(?:$|[_-])/i,
  /[_-](?:test|demo|mock|fake|sandbox)$/i,
];

const PROVIDER_ALLOWED_EVIDENCE_DOMAINS: Readonly<
  Record<string, ReadonlySet<EvidenceType>>
> = {
  gmail_api: new Set<EvidenceType>([
    'message_delivered',
    'reply_received',
    'api_dispatch_ack',
    'outcome_reversal',
  ]),
  google_calendar_api: new Set<EvidenceType>([
    'meeting_booked',
    'api_dispatch_ack',
    'outcome_reversal',
  ]),
  payment_webhook: new Set<EvidenceType>([
    'payment_confirmed',
    'customer_acquired',
    'api_dispatch_ack',
    'outcome_reversal',
  ]),
  crm_webhook: new Set<EvidenceType>([
    'prospect_identified',
    'qualified_lead',
    'customer_acquired',
    'meeting_booked',
    'custom_outcome',
    'api_dispatch_ack',
    'outcome_reversal',
  ]),
  custom_webhook: new Set<EvidenceType>([
    'message_delivered',
    'reply_received',
    'qualified_lead',
    'prospect_identified',
    'meeting_booked',
    'payment_confirmed',
    'customer_acquired',
    'custom_outcome',
    'api_dispatch_ack',
    'outcome_reversal',
  ]),
  n8n_webhook: new Set<EvidenceType>([
    'message_delivered',
    'reply_received',
    'qualified_lead',
    'prospect_identified',
    'meeting_booked',
    'payment_confirmed',
    'customer_acquired',
    'custom_outcome',
    'api_dispatch_ack',
    'outcome_reversal',
  ]),
  make_webhook: new Set<EvidenceType>([
    'message_delivered',
    'reply_received',
    'qualified_lead',
    'prospect_identified',
    'meeting_booked',
    'payment_confirmed',
    'customer_acquired',
    'custom_outcome',
    'api_dispatch_ack',
    'outcome_reversal',
  ]),
  zapier_webhook: new Set<EvidenceType>([
    'message_delivered',
    'reply_received',
    'qualified_lead',
    'prospect_identified',
    'meeting_booked',
    'payment_confirmed',
    'customer_acquired',
    'custom_outcome',
    'api_dispatch_ack',
    'outcome_reversal',
  ]),
};

export function isProviderDomainCompatibleWithEvidence(
  provider: string | undefined | null,
  evidenceType: EvidenceType
): boolean {
  if (!provider) return false;
  const normalized = provider.trim().toLowerCase();
  const allowed = PROVIDER_ALLOWED_EVIDENCE_DOMAINS[normalized];
  if (!allowed) return false;
  return allowed.has(evidenceType);
}

export function isSyntheticOrTestEvidence(params: {
  externalReferenceId: string | null;
  externalEventId?: string | null;
  structuredMetrics: Record<string, unknown>;
}): boolean {
  const m = params.structuredMetrics ?? {};
  if (
    m.unverifiedClaim === true ||
    m.livemode === false ||
    m.testMode === true ||
    m.sandbox === true ||
    m.synthetic === true ||
    m.isTestEvent === true ||
    (typeof m.environment === 'string' &&
      /^(?:test|sandbox|staging|demo)$/i.test(m.environment.trim()))
  ) {
    return true;
  }

  const ref = (params.externalReferenceId || '').trim();
  if (ref && SYNTHETIC_REFERENCE_PATTERNS.some((rx) => rx.test(ref))) {
    return true;
  }

  const evt = (params.externalEventId || '').trim();
  if (evt && SYNTHETIC_REFERENCE_PATTERNS.some((rx) => rx.test(evt))) {
    return true;
  }

  return false;
}

/**
 * Generates the canonical Task.ai inbound webhook HMAC-SHA256 signature header value:
 * `t=<unix_seconds>,v1=<hex_hmac_sha256>` over `<unix_seconds>.<raw_body>`.
 */
export function computeInboundWebhookSignature(
  signingSecret: string,
  timestampSec: string | number,
  rawBody: string
): string {
  const ts = String(timestampSec).trim();
  const digest = crypto
    .createHmac('sha256', signingSecret)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  return `t=${ts},v1=${digest}`;
}

export type WebhookAuthVerificationResult =
  | {
      valid: true;
      timestampSec: number;
    }
  | {
      valid: false;
      code:
        | 'missing_signature'
        | 'invalid_timestamp'
        | 'replay_window_expired'
        | 'invalid_signature';
      error: string;
    };

/**
 * Verifies inbound webhook authenticity using constant-time HMAC-SHA256 comparison
 * and enforces a strict timestamp skew window for replay-attack protection.
 */
export function verifyInboundWebhookAuth(params: {
  signingSecret: string;
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader?: string | undefined;
  nowMs?: number;
  maxSkewSeconds?: number;
}): WebhookAuthVerificationResult {
  const {
    signingSecret,
    rawBody,
    signatureHeader,
    timestampHeader,
    nowMs = Date.now(),
    maxSkewSeconds = DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS,
  } = params;

  if (!signingSecret || !signatureHeader || !signatureHeader.trim()) {
    return {
      valid: false,
      code: 'missing_signature',
      error:
        'Missing X-TaskAI-Signature header. Inbound webhooks must be signed with your workspace HMAC secret.',
    };
  }

  let extractedTs = timestampHeader?.trim() ?? '';
  let extractedV1 = '';

  const rawSig = signatureHeader.trim();
  if (rawSig.includes('v1=')) {
    for (const part of rawSig.split(',')) {
      const [k, v] = part.split('=').map((s) => s.trim());
      if (k === 't' && v) extractedTs = v;
      if (k === 'v1' && v) extractedV1 = v;
    }
  } else if (/^[0-9a-fA-F]{64}$/.test(rawSig)) {
    extractedV1 = rawSig;
  }

  if (!extractedTs || !/^\d{9,12}$/.test(extractedTs)) {
    return {
      valid: false,
      code: 'invalid_timestamp',
      error:
        'Missing or invalid webhook Unix timestamp (provide t=<unix_sec>,v1=<hex> or X-TaskAI-Timestamp).',
    };
  }

  const timestampSec = Number(extractedTs);
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - timestampSec) > maxSkewSeconds) {
    return {
      valid: false,
      code: 'replay_window_expired',
      error: `Webhook timestamp falls outside the ${maxSkewSeconds}s replay-protection window.`,
    };
  }

  if (!/^[0-9a-fA-F]{64}$/.test(extractedV1)) {
    return {
      valid: false,
      code: 'invalid_signature',
      error: 'Malformed HMAC-SHA256 signature digest.',
    };
  }

  const expectedHex = crypto
    .createHmac('sha256', signingSecret)
    .update(`${extractedTs}.${rawBody}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(extractedV1.toLowerCase(), 'hex');

  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return {
      valid: false,
      code: 'invalid_signature',
      error: 'Inbound webhook HMAC-SHA256 signature verification failed.',
    };
  }

  return {
    valid: true,
    timestampSec,
  };
}

export interface ValidatedInboundEvidencePayload {
  provider: string;
  externalEventId: string;
  idempotencyKey: string;
  goalId: string | null;
  taskId: string | null;
  evidenceType: EvidenceType;
  externalReferenceId: string | null;
  summary: string;
  requiresHumanReview: boolean;
  observedAt: Date;
  structuredMetrics: Record<string, unknown>;
}

export type InboundPayloadValidationResult =
  | {
      valid: true;
      data: ValidatedInboundEvidencePayload;
    }
  | {
      valid: false;
      error: string;
    };

export function validateInboundEvidencePayload(
  raw: unknown,
  now: Date = new Date()
): InboundPayloadValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      error: 'Inbound webhook body must be a JSON object.',
    };
  }

  const obj = raw as Record<string, unknown>;

  const provider =
    typeof obj.provider === 'string' ? obj.provider.trim() : '';
  if (!provider || provider.length > 80) {
    return {
      valid: false,
      error: 'Field "provider" is required (1–80 characters).',
    };
  }

  const externalEventId =
    typeof obj.externalEventId === 'string'
      ? obj.externalEventId.trim()
      : typeof obj.eventId === 'string'
        ? obj.eventId.trim()
        : '';
  if (!externalEventId || externalEventId.length > 160) {
    return {
      valid: false,
      error: 'Field "externalEventId" is required (1–160 characters).',
    };
  }

  const evidenceTypeRaw =
    typeof obj.evidenceType === 'string' ? obj.evidenceType.trim() : '';
  if (
    !VALID_EVIDENCE_TYPES.has(evidenceTypeRaw as EvidenceType) ||
    evidenceTypeRaw === 'diagnostic_checksum'
  ) {
    return {
      valid: false,
      error: `Field "evidenceType" must be a valid external outcome type.`,
    };
  }
  const evidenceType = evidenceTypeRaw as EvidenceType;

  const goalId =
    typeof obj.goalId === 'string' && obj.goalId.trim()
      ? obj.goalId.trim()
      : null;
  const taskId =
    typeof obj.taskId === 'string' && obj.taskId.trim()
      ? obj.taskId.trim()
      : null;

  if (!goalId && !taskId) {
    return {
      valid: false,
      error:
        'Inbound evidence must reference at least one of "goalId" or "taskId" within the workspace.',
    };
  }

  const idempotencyKey =
    typeof obj.idempotencyKey === 'string' && obj.idempotencyKey.trim()
      ? obj.idempotencyKey.trim().slice(0, 200)
      : `${provider}:${externalEventId}`;

  const summary =
    typeof obj.summary === 'string' && obj.summary.trim()
      ? obj.summary.trim().slice(0, 500)
      : `${provider} reported ${evidenceType} (${externalEventId})`;

  const externalReferenceId =
    typeof obj.externalReferenceId === 'string' &&
    obj.externalReferenceId.trim()
      ? obj.externalReferenceId.trim().slice(0, 160)
      : null;

  const requiresHumanReview = Boolean(obj.requiresHumanReview);

  let observedAt = now;
  if (typeof obj.observedAt === 'string' && obj.observedAt.trim()) {
    const parsedDate = new Date(obj.observedAt.trim());
    if (Number.isNaN(parsedDate.getTime())) {
      return {
        valid: false,
        error: 'Field "observedAt" must be a valid ISO-8601 timestamp.',
      };
    }
    observedAt = parsedDate;
  }

  const baseMetrics =
    obj.structuredMetrics &&
    typeof obj.structuredMetrics === 'object' &&
    !Array.isArray(obj.structuredMetrics)
      ? { ...(obj.structuredMetrics as Record<string, unknown>) }
      : {};

  // Preserve top-level provider sandbox/non-live flags (e.g. Stripe `livemode: false`)
  if (obj.livemode === false && baseMetrics.livemode === undefined) {
    baseMetrics.livemode = false;
  }
  if (obj.testMode === true && baseMetrics.testMode === undefined) {
    baseMetrics.testMode = true;
  }
  if (obj.sandbox === true && baseMetrics.sandbox === undefined) {
    baseMetrics.sandbox = true;
  }
  if (obj.synthetic === true && baseMetrics.synthetic === undefined) {
    baseMetrics.synthetic = true;
  }
  if (obj.isTestEvent === true && baseMetrics.isTestEvent === undefined) {
    baseMetrics.isTestEvent = true;
  }
  if (
    obj.unverifiedClaim === true &&
    baseMetrics.unverifiedClaim === undefined
  ) {
    baseMetrics.unverifiedClaim = true;
  }
  if (
    typeof obj.environment === 'string' &&
    baseMetrics.environment === undefined
  ) {
    baseMetrics.environment = obj.environment.trim();
  }

  const structuredMetrics = baseMetrics;

  return {
    valid: true,
    data: {
      provider,
      externalEventId,
      idempotencyKey,
      goalId,
      taskId,
      evidenceType,
      externalReferenceId,
      summary,
      requiresHumanReview,
      observedAt,
      structuredMetrics,
    },
  };
}

export interface VerificationEvaluationOutcome {
  verificationState: 'pending_verification' | 'verified' | 'rejected';
  verificationMethod: VerificationMethodType;
  decision: 'verified' | 'pending_verification' | 'rejected';
  provenanceClass: EvidenceProvenanceClass;
  trustTier: EvidenceTrustTier;
  requiresHumanReview: boolean;
  taskNextStatus: TaskStatus | null;
  notes: string;
}

function hasConcreteOutcomeProof(params: {
  evidenceType: EvidenceType;
  externalReferenceId: string | null;
  structuredMetrics: Record<string, unknown>;
}): boolean {
  if (params.structuredMetrics.unverifiedClaim === true) {
    return false;
  }
  if (!params.externalReferenceId || params.externalReferenceId.trim().length < 3) {
    return false;
  }

  const numericKeys = [
    'count',
    'value',
    'customersAcquired',
    'customers',
    'dealsWon',
    'amountUsd',
    'amountNgn',
    'amountEur',
    'amountGbp',
    'revenueUsd',
    'revenueNgn',
    'revenueEur',
    'revenueGbp',
    'amount',
    'revenue',
    'refundAmountUsd',
    'refundAmountNgn',
    'refundAmountEur',
    'refundAmountGbp',
    'meetingsBooked',
    'messagesDelivered',
    'repliesReceived',
    'qualifiedLeads',
    'prospectsFound',
  ];

  let sawAnyMetric = false;
  for (const key of numericKeys) {
    const val = params.structuredMetrics[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      if (params.evidenceType === 'outcome_reversal' && val !== 0) {
        return true;
      }
      if (val > 0) {
        return true;
      }
      if (val < 0) {
        return true;
      }
      sawAnyMetric = true;
    }
  }

  // If explicit zero was sent (e.g. customersAcquired: 0), do not treat as positive outcome proof
  if (sawAnyMetric) {
    return false;
  }

  // Discrete event types with a concrete externalReferenceId (e.g. booking ID / message ID) carry implicit unit 1
  return (
    params.evidenceType !== 'payment_confirmed' &&
    params.evidenceType !== 'outcome_reversal'
  );
}

function isCorroboratedTaskExecution(params: {
  provider?: string;
  associatedTask:
    | (Pick<
        TaskRecord,
        'id' | 'status' | 'approvalRequired' | 'approvalStatus'
      > & { tool?: ToolId })
    | null;
}): boolean {
  const { provider, associatedTask } = params;
  if (!associatedTask) return false;
  if (
    associatedTask.approvalRequired &&
    associatedTask.approvalStatus !== 'approved'
  ) {
    return false;
  }
  const executedStates: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
    'pending_verification',
    'completed',
    'running',
    'blocked',
    'verified',
  ]);
  if (!executedStates.has(associatedTask.status)) {
    return false;
  }

  if (associatedTask.tool) {
    const isExt = INTEGRATION_PROVIDER_KEYS.has(
      associatedTask.tool as Parameters<typeof INTEGRATION_PROVIDER_KEYS.has>[0]
    );
    if (!isExt) return false;
    if (
      provider &&
      associatedTask.tool !== provider &&
      provider !== 'custom_webhook' &&
      provider !== 'n8n_webhook'
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Outcome Verification Engine & 6-Class Evidence Trust Architecture.
 *
 * CRITICAL INVARIANTS:
 * 1. A valid workspace HMAC signature (`signatureVerified: true`) proves ONLY transport authenticity
 *    (`authenticated_webhook` / `transport_authenticated`), NEVER automatic business outcome truth.
 * 2. Internal SHA-256 checksums (`deterministic_execution`) are classified as `internal_diagnostic`
 *    (`diagnostic_only`) and never count toward external business outcomes.
 * 3. Promotion to `provider_confirmed` (`provider_verified` / `verified`) requires:
 *    - Valid transport HMAC signature
 *    - Connected, enabled & verified workspace integration matching `provider`
 *    - Domain-compatible `(provider, evidenceType)` pair
 *    - Concrete, non-synthetic `externalReferenceId` (rejects missing IDs, `ref_demo_*`, `test_*`, `livemode: false`)
 *    - Zero conflicting claims (`!hasConflict`) and `!requiresHumanReview`
 *    - Independent provider secret signature (`providerSignatureVerified`) OR correlation to an approved, executed external task
 */
export function evaluateEvidenceVerification(params: {
  sourceType: 'inbound_webhook' | 'deterministic_execution' | 'manual_submission';
  provider?: string;
  signatureVerified: boolean;
  providerSignatureVerified?: boolean;
  verifiedWorkspaceIntegrationPresent?: boolean;
  evidenceType: EvidenceType;
  externalEventId?: string | null;
  externalReferenceId: string | null;
  requiresHumanReview: boolean;
  hasConflict?: boolean;
  structuredMetrics: Record<string, unknown>;
  associatedTask: Pick<
    TaskRecord,
    'id' | 'status' | 'approvalRequired' | 'approvalStatus'
  > & { tool?: ToolId } | null;
}): VerificationEvaluationOutcome {
  const {
    sourceType,
    provider,
    signatureVerified,
    providerSignatureVerified = false,
    verifiedWorkspaceIntegrationPresent = false,
    evidenceType,
    externalEventId = null,
    externalReferenceId,
    requiresHumanReview,
    hasConflict = false,
    structuredMetrics,
    associatedTask,
  } = params;

  // Invariant 1: Unapproved consequential tasks can never record verified outcomes
  if (
    associatedTask &&
    associatedTask.approvalRequired &&
    associatedTask.approvalStatus !== 'approved'
  ) {
    return {
      verificationState: 'rejected',
      verificationMethod: 'deterministic',
      decision: 'rejected',
      provenanceClass: 'unverified_claim',
      trustTier: 'untrusted',
      requiresHumanReview: false,
      taskNextStatus:
        associatedTask.approvalStatus === 'rejected' ? 'rejected' : 'blocked',
      notes:
        'Verification rejected: associated consequential task was not approved in the Approval Gate.',
    };
  }

  // Invariant 2: Internal SHA-256 deterministic execution is strictly diagnostic_only
  if (
    sourceType === 'deterministic_execution' ||
    evidenceType === 'diagnostic_checksum'
  ) {
    return {
      verificationState: 'verified',
      verificationMethod: 'deterministic',
      decision: 'verified',
      provenanceClass: 'internal_diagnostic',
      trustTier: 'diagnostic_only',
      requiresHumanReview: false,
      taskNextStatus: associatedTask ? 'verified' : null,
      notes:
        'Internal SHA-256 diagnostic invariant verified (diagnostic_only; excluded from external business outcome metrics).',
    };
  }

  // Invariant 3: Mere HTTP 200 / API dispatch acknowledgement NEVER counts as a verified business outcome
  if (evidenceType === 'api_dispatch_ack') {
    return {
      verificationState: 'pending_verification',
      verificationMethod: 'evidence_based',
      decision: 'pending_verification',
      provenanceClass: signatureVerified
        ? 'authenticated_webhook'
        : 'unverified_claim',
      trustTier: signatureVerified ? 'transport_authenticated' : 'untrusted',
      requiresHumanReview: false,
      taskNextStatus: associatedTask ? 'pending_verification' : null,
      notes:
        'API dispatch acknowledgement recorded (HTTP 2xx). Task remains pending_verification until corroborated delivery, reply, booking, or payment outcome evidence arrives.',
    };
  }

  // Invariant 4: Manual evidence submissions are unverified claims until explicitly reviewed by a human
  if (sourceType === 'manual_submission') {
    return {
      verificationState: 'pending_verification',
      verificationMethod: 'human_review',
      decision: 'pending_verification',
      provenanceClass: 'unverified_claim',
      trustTier: 'untrusted',
      requiresHumanReview: true,
      taskNextStatus: associatedTask ? 'pending_verification' : null,
      notes:
        'Manual claim recorded as unverified_claim (untrusted); requires explicit human verification review.',
    };
  }

  // Invariant 5: Unsigned inbound payloads are unverified claims
  if (!signatureVerified) {
    return {
      verificationState: 'pending_verification',
      verificationMethod: 'evidence_based',
      decision: 'pending_verification',
      provenanceClass: 'unverified_claim',
      trustTier: 'untrusted',
      requiresHumanReview: true,
      taskNextStatus: associatedTask ? 'pending_verification' : null,
      notes:
        'Evidence lacks cryptographic signature verification; held in pending_verification.',
    };
  }

  // From here: signatureVerified === true (workspace HMAC transport verified -> at least authenticated_webhook)
  if (hasConflict) {
    return {
      verificationState: 'pending_verification',
      verificationMethod: 'human_review',
      decision: 'pending_verification',
      provenanceClass: 'authenticated_webhook',
      trustTier: 'transport_authenticated',
      requiresHumanReview: true,
      taskNextStatus: associatedTask ? 'pending_verification' : null,
      notes:
        'Conflicting outcome evidence detected for the same externalReferenceId; quarantined in pending_verification for human audit.',
    };
  }

  if (requiresHumanReview) {
    return {
      verificationState: 'pending_verification',
      verificationMethod: 'human_review',
      decision: 'pending_verification',
      provenanceClass: 'authenticated_webhook',
      trustTier: 'transport_authenticated',
      requiresHumanReview: true,
      taskNextStatus: associatedTask ? 'pending_verification' : null,
      notes:
        'Transport-authenticated webhook explicitly flagged for human verification review.',
    };
  }

  if (
    isSyntheticOrTestEvidence({
      externalReferenceId,
      externalEventId,
      structuredMetrics,
    })
  ) {
    return {
      verificationState: 'pending_verification',
      verificationMethod: 'human_review',
      decision: 'pending_verification',
      provenanceClass: 'authenticated_webhook',
      trustTier: 'transport_authenticated',
      requiresHumanReview: true,
      taskNextStatus: associatedTask ? 'pending_verification' : null,
      notes:
        'Transport-authenticated webhook carries a synthetic/demo/test reference or non-live flag; held in pending_verification (valid HMAC alone never proves a live business outcome).',
    };
  }

  if (
    !hasConcreteOutcomeProof({
      evidenceType,
      externalReferenceId,
      structuredMetrics,
    })
  ) {
    return {
      verificationState: 'pending_verification',
      verificationMethod: 'evidence_based',
      decision: 'pending_verification',
      provenanceClass: 'authenticated_webhook',
      trustTier: 'transport_authenticated',
      requiresHumanReview: true,
      taskNextStatus: associatedTask ? 'pending_verification' : null,
      notes:
        'Transport-authenticated webhook lacks a concrete externalReferenceId or non-zero outcome metric; held in pending_verification.',
    };
  }

  if (!isProviderDomainCompatibleWithEvidence(provider, evidenceType)) {
    return {
      verificationState: 'pending_verification',
      verificationMethod: 'human_review',
      decision: 'pending_verification',
      provenanceClass: 'authenticated_webhook',
      trustTier: 'transport_authenticated',
      requiresHumanReview: true,
      taskNextStatus: associatedTask ? 'pending_verification' : null,
      notes: `Provider "${provider || 'unknown'}" is not authoritative for "${evidenceType}" outcomes; held as authenticated_webhook pending human verification.`,
    };
  }

  if (!verifiedWorkspaceIntegrationPresent) {
    return {
      verificationState: 'pending_verification',
      verificationMethod: 'human_review',
      decision: 'pending_verification',
      provenanceClass: 'authenticated_webhook',
      trustTier: 'transport_authenticated',
      requiresHumanReview: true,
      taskNextStatus: associatedTask ? 'pending_verification' : null,
      notes: `Workspace HMAC verified, but no enabled & connection-verified "${provider}" integration exists in this workspace; held as authenticated_webhook pending human verification.`,
    };
  }

  const corroboratedByTask = isCorroboratedTaskExecution({
    provider,
    associatedTask,
  });

  if (!providerSignatureVerified && !corroboratedByTask) {
    return {
      verificationState: 'pending_verification',
      verificationMethod: 'human_review',
      decision: 'pending_verification',
      provenanceClass: 'authenticated_webhook',
      trustTier: 'transport_authenticated',
      requiresHumanReview: true,
      taskNextStatus: associatedTask ? 'pending_verification' : null,
      notes:
        'Workspace transport HMAC verified, but event is neither signed with a provider-specific secret (X-TaskAI-Provider-Signature) nor correlated to an executed external task; held in pending_verification.',
    };
  }

  return {
    verificationState: 'verified',
    verificationMethod: 'evidence_based',
    decision: 'verified',
    provenanceClass: 'provider_confirmed',
    trustTier: 'provider_verified',
    requiresHumanReview: false,
    taskNextStatus: associatedTask
      ? evidenceType === 'outcome_reversal'
        ? 'pending_verification'
        : 'verified'
      : null,
    notes: `Corroborated provider_confirmed ${evidenceType} evidence from verified "${provider}" adapter (ref: ${externalReferenceId}).`,
  };
}
