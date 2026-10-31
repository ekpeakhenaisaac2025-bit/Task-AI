import type {
  GoalMetricValueRecord,
  GoalRecord,
  OutcomeEvidenceRecord,
  TaskAttemptRecord,
  TaskRecord,
} from '../types.ts';

export type MetricUnit = 'count' | 'USD' | 'NGN' | 'EUR' | 'GBP' | 'percent';

export interface ParsedMetricDefinition {
  metricKey: string;
  metricLabel: string;
  unit: MetricUnit;
  isPrimaryTarget: boolean;
  targetValue: number;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  fifty: 50,
  hundred: 100,
};

function parseNumericMagnitude(rawNumber: string, suffix?: string): number | null {
  const cleaned = Number(rawNumber.replace(/,/g, ''));
  if (!Number.isFinite(cleaned) || cleaned < 0) return null;
  const lowerSuffix = (suffix || '').toLowerCase();
  if (lowerSuffix === 'k') return cleaned * 1_000;
  if (lowerSuffix === 'm') return cleaned * 1_000_000;
  if (lowerSuffix === 'b') return cleaned * 1_000_000_000;
  return cleaned;
}

function extractWordNumber(clauseLower: string): number | null {
  for (const [word, val] of Object.entries(NUMBER_WORDS)) {
    const rx = new RegExp(`\\b${word}\\b`, 'i');
    if (rx.test(clauseLower)) {
      return val;
    }
  }
  return null;
}

function detectCurrencyCode(text: string): 'USD' | 'NGN' | 'EUR' | 'GBP' | null {
  if (/₦|\bngn\b|\bnaira\b/i.test(text)) return 'NGN';
  if (/€|\beur\b|\beuros?\b/i.test(text)) return 'EUR';
  if (/£|\bgbp\b|\bpounds?\b/i.test(text)) return 'GBP';
  if (/\$|\busd\b|\bdollars?\b/i.test(text)) return 'USD';
  return null;
}

function parseSingleMetricClause(clauseText: string): ParsedMetricDefinition | null {
  const text = clauseText.trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  let unit: MetricUnit = 'count';
  let parsedTarget: number | null = null;

  // 1. Currency prefix/code match (e.g. "$15,000", "₦2.5m", "500 EUR", "£1,200")
  const currencyMatch = text.match(
    /(?:(\$|₦|€|£)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmMbB])?)|(?:([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmMbB])?\s*(USD|NGN|EUR|GBP|naira|dollars?|euros?|pounds?)\b)/i
  );

  if (currencyMatch) {
    const sym = currencyMatch[1];
    const codeRaw = currencyMatch[6]?.toLowerCase() ?? '';
    if (sym === '₦' || codeRaw === 'ngn' || codeRaw === 'naira') unit = 'NGN';
    else if (sym === '€' || codeRaw === 'eur' || codeRaw.startsWith('euro'))
      unit = 'EUR';
    else if (sym === '£' || codeRaw === 'gbp' || codeRaw.startsWith('pound'))
      unit = 'GBP';
    else unit = 'USD';

    const numStr = currencyMatch[2] ?? currencyMatch[4];
    const suf = currencyMatch[3] ?? currencyMatch[5];
    if (numStr) {
      parsedTarget = parseNumericMagnitude(numStr, suf);
    }
  } else {
    const percentMatch = text.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*%/);
    if (percentMatch) {
      unit = 'percent';
      parsedTarget = parseNumericMagnitude(percentMatch[1]);
    } else {
      const genericNumMatch = text.match(
        /(?:^|[^0-9.])([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmMbB])?\b/
      );
      if (genericNumMatch) {
        parsedTarget = parseNumericMagnitude(
          genericNumMatch[1],
          genericNumMatch[2]
        );
      } else {
        parsedTarget = extractWordNumber(lower);
      }
      const detectedCurr = detectCurrencyCode(text);
      if (detectedCurr) {
        unit = detectedCurr;
      }
    }
  }

  let metricKey = 'custom_target_outcomes';
  let metricLabel = 'Verified Target Outcomes';

  if (
    unit === 'USD' ||
    unit === 'NGN' ||
    unit === 'EUR' ||
    unit === 'GBP' ||
    /\b(revenue|mrr|arr|sales|payment|payments|paid invoice|income|gmv)\b/.test(
      lower
    )
  ) {
    if (unit === 'count') {
      unit = detectCurrencyCode(text) ?? 'USD';
    }
    metricKey =
      unit === 'USD' ? 'revenue_earned' : `revenue_earned_${unit.toLowerCase()}`;
    metricLabel = `Verified Revenue (${unit})`;
  } else if (
    /\b(customer|customers|client|clients|deal|deals|subscriber|subscribers|buyer|buyers)\b/.test(
      lower
    )
  ) {
    metricKey = 'paying_customers';
    metricLabel = 'Paying Customers Acquired';
  } else if (
    /\b(meeting|meetings|call|calls|demo|demos|appointment|appointments|booking|bookings)\b/.test(
      lower
    )
  ) {
    metricKey = 'meetings_booked';
    metricLabel = 'Discovery Meetings Booked';
  } else if (/\b(reply|replies|response|responses)\b/.test(lower)) {
    metricKey = 'replies_received';
    metricLabel = 'Verified Replies Received';
  } else if (/\b(qualified|sql|sqls)\b/.test(lower)) {
    metricKey = 'qualified_leads';
    metricLabel = 'Qualified Prospects';
  } else if (/\b(prospect|prospects|lead|leads)\b/.test(lower)) {
    metricKey = 'prospects_identified';
    metricLabel = 'Verified Prospects Found';
  } else if (
    /\b(message|messages|email|emails|outreach|delivered)\b/.test(lower)
  ) {
    metricKey = 'messages_delivered';
    metricLabel = 'Verified Messages Delivered';
  } else if (/\b(checksum|diagnostic|verification test)\b/.test(lower)) {
    metricKey = 'diagnostic_verifications';
    metricLabel = 'Deterministic Diagnostic Checks';
  }

  // CRITICAL: Unquantified or ambiguous natural-language goals (e.g. "Maximize enterprise revenue")
  // MUST receive targetValue = 0 rather than silently defaulting to 1, preventing false auto-completion!
  const targetValue =
    parsedTarget !== null && parsedTarget > 0 ? parsedTarget : 0;

  return {
    metricKey,
    metricLabel,
    unit,
    isPrimaryTarget: true,
    targetValue,
  };
}

/**
 * Parses a goal's stated `targetMetric` string into one or more independent primary target metrics
 * plus standard supporting funnel metrics.
 *
 * - Supports compound multi-metric goals ("Book 10 calls and close 3 customers and $15,000 USD").
 * - Supports NGN, USD, EUR, and GBP without cross-currency conflation.
 * - Assigns `targetValue: 0` when a goal lacks a concrete numeric target so ambiguous goals never auto-complete.
 */
export function parseGoalTargetMetrics(
  targetMetricText: string
): ParsedMetricDefinition[] {
  const text = (targetMetricText || '').trim();
  const clauses = text
    .split(/\s*(?:\b(?:and|plus|while)\b|&|;|,(?!\d))\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const primaryDefinitions: ParsedMetricDefinition[] = [];
  const seenKeys = new Set<string>();

  for (const clause of clauses) {
    const parsed = parseSingleMetricClause(clause);
    if (!parsed) continue;
    // If a secondary clause had no recognized domain noun AND no number, skip noise
    if (
      clauses.length > 1 &&
      parsed.metricKey === 'custom_target_outcomes' &&
      parsed.targetValue === 0
    ) {
      continue;
    }
    if (seenKeys.has(parsed.metricKey)) {
      const existing = primaryDefinitions.find(
        (d) => d.metricKey === parsed.metricKey
      );
      if (existing && parsed.targetValue > existing.targetValue) {
        existing.targetValue = parsed.targetValue;
      }
      continue;
    }
    seenKeys.add(parsed.metricKey);
    primaryDefinitions.push(parsed);
  }

  if (primaryDefinitions.length === 0) {
    const fallback = parseSingleMetricClause(text) ?? {
      metricKey: 'custom_target_outcomes',
      metricLabel: 'Verified Target Outcomes',
      unit: 'count' as MetricUnit,
      isPrimaryTarget: true,
      targetValue: 0,
    };
    primaryDefinitions.push(fallback);
    seenKeys.add(fallback.metricKey);
  }

  const primaryCurrencyUnit =
    primaryDefinitions.find(
      (d) =>
        d.unit === 'NGN' ||
        d.unit === 'EUR' ||
        d.unit === 'GBP' ||
        d.unit === 'USD'
    )?.unit ?? 'USD';

  const revenueSupportingKey =
    primaryCurrencyUnit === 'USD'
      ? 'revenue_earned'
      : `revenue_earned_${primaryCurrencyUnit.toLowerCase()}`;

  const supporting: Array<{
    metricKey: string;
    metricLabel: string;
    unit: MetricUnit;
  }> = [
    {
      metricKey: 'messages_delivered',
      metricLabel: 'Verified Messages Delivered',
      unit: 'count',
    },
    {
      metricKey: 'qualified_leads',
      metricLabel: 'Qualified Prospects',
      unit: 'count',
    },
    {
      metricKey: 'meetings_booked',
      metricLabel: 'Discovery Meetings Booked',
      unit: 'count',
    },
    {
      metricKey: 'paying_customers',
      metricLabel: 'Paying Customers Acquired',
      unit: 'count',
    },
    {
      metricKey: revenueSupportingKey,
      metricLabel: `Verified Revenue (${primaryCurrencyUnit})`,
      unit: primaryCurrencyUnit,
    },
  ];

  const definitions: ParsedMetricDefinition[] = [...primaryDefinitions];
  for (const sup of supporting) {
    if (!seenKeys.has(sup.metricKey)) {
      seenKeys.add(sup.metricKey);
      definitions.push({
        metricKey: sup.metricKey,
        metricLabel: sup.metricLabel,
        unit: sup.unit,
        isPrimaryTarget: false,
        targetValue: 0,
      });
    }
  }

  return definitions;
}

function readSignedNumber(
  obj: Record<string, unknown>,
  keys: string[],
  fallback: number | null = null
): number | null {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }
  return fallback;
}

export function detectEvidenceCurrency(
  m: Record<string, unknown>
): 'USD' | 'NGN' | 'EUR' | 'GBP' | null {
  if (typeof m.currency === 'string' && m.currency.trim()) {
    const c = m.currency.trim().toUpperCase();
    if (c === 'USD' || c === 'NGN' || c === 'EUR' || c === 'GBP') {
      return c;
    }
    return null;
  }
  const hasUsd =
    typeof m.amountUsd === 'number' ||
    typeof m.revenueUsd === 'number' ||
    typeof m.verifiedRevenueUsd === 'number' ||
    typeof m.refundAmountUsd === 'number';
  const hasNgn =
    typeof m.amountNgn === 'number' ||
    typeof m.revenueNgn === 'number' ||
    typeof m.refundAmountNgn === 'number';
  const hasEur =
    typeof m.amountEur === 'number' ||
    typeof m.revenueEur === 'number' ||
    typeof m.refundAmountEur === 'number';
  const hasGbp =
    typeof m.amountGbp === 'number' ||
    typeof m.revenueGbp === 'number' ||
    typeof m.refundAmountGbp === 'number';

  const countSpecific = [hasUsd, hasNgn, hasEur, hasGbp].filter(Boolean).length;
  if (countSpecific === 1) {
    if (hasUsd) return 'USD';
    if (hasNgn) return 'NGN';
    if (hasEur) return 'EUR';
    if (hasGbp) return 'GBP';
  }
  return null;
}

function hasAnyExplicitForeignCurrency(
  m: Record<string, unknown>,
  expectedCurrency: 'USD' | 'NGN' | 'EUR' | 'GBP'
): boolean {
  if (typeof m.currency === 'string' && m.currency.trim()) {
    return m.currency.trim().toUpperCase() !== expectedCurrency;
  }
  const foreignMap: Record<'USD' | 'NGN' | 'EUR' | 'GBP', string[]> = {
    USD: [
      'amountNgn',
      'revenueNgn',
      'refundAmountNgn',
      'amountEur',
      'revenueEur',
      'refundAmountEur',
      'amountGbp',
      'revenueGbp',
      'refundAmountGbp',
    ],
    NGN: [
      'amountUsd',
      'revenueUsd',
      'verifiedRevenueUsd',
      'refundAmountUsd',
      'amountEur',
      'revenueEur',
      'refundAmountEur',
      'amountGbp',
      'revenueGbp',
      'refundAmountGbp',
    ],
    EUR: [
      'amountUsd',
      'revenueUsd',
      'verifiedRevenueUsd',
      'refundAmountUsd',
      'amountNgn',
      'revenueNgn',
      'refundAmountNgn',
      'amountGbp',
      'revenueGbp',
      'refundAmountGbp',
    ],
    GBP: [
      'amountUsd',
      'revenueUsd',
      'verifiedRevenueUsd',
      'refundAmountUsd',
      'amountNgn',
      'revenueNgn',
      'refundAmountNgn',
      'amountEur',
      'revenueEur',
      'refundAmountEur',
    ],
  };

  for (const fk of foreignMap[expectedCurrency]) {
    if (typeof m[fk] === 'number' && Number.isFinite(m[fk])) {
      return true;
    }
  }
  return false;
}

function extractRevenueForCurrency(
  ev: OutcomeEvidenceRecord,
  currency: 'USD' | 'NGN' | 'EUR' | 'GBP'
): number {
  const m = ev.structuredMetrics ?? {};
  const isReversal = ev.evidenceType === 'outcome_reversal';

  const specificPositiveKeys: Record<'USD' | 'NGN' | 'EUR' | 'GBP', string[]> = {
    USD: ['amountUsd', 'revenueUsd', 'verifiedRevenueUsd'],
    NGN: ['amountNgn', 'revenueNgn'],
    EUR: ['amountEur', 'revenueEur'],
    GBP: ['amountGbp', 'revenueGbp'],
  };
  const specificRefundKeys: Record<'USD' | 'NGN' | 'EUR' | 'GBP', string[]> = {
    USD: ['refundAmountUsd'],
    NGN: ['refundAmountNgn'],
    EUR: ['refundAmountEur'],
    GBP: ['refundAmountGbp'],
  };

  // Explicit currency mismatch check
  if (
    typeof m.currency === 'string' &&
    m.currency.trim() &&
    m.currency.trim().toUpperCase() !== currency
  ) {
    // Only allow if an explicit field for THIS currency was also passed alongside
    const explicitForTarget = readSignedNumber(m, specificPositiveKeys[currency]);
    if (explicitForTarget === null) {
      const explicitRefund = readSignedNumber(m, specificRefundKeys[currency]);
      if (explicitRefund !== null) return -Math.abs(explicitRefund);
      return 0;
    }
    return isReversal && explicitForTarget > 0
      ? -explicitForTarget
      : explicitForTarget;
  }

  const refundSpecific = readSignedNumber(m, specificRefundKeys[currency]);
  if (refundSpecific !== null && refundSpecific !== 0) {
    return -Math.abs(refundSpecific);
  }

  const specificVal = readSignedNumber(m, specificPositiveKeys[currency]);
  if (specificVal !== null) {
    return isReversal && specificVal > 0 ? -specificVal : specificVal;
  }

  // Do NOT fall back to generic `amount` / `revenue` / `value` if a foreign currency key is present!
  if (hasAnyExplicitForeignCurrency(m, currency)) {
    return 0;
  }

  // Require explicit currency match for non-USD generic `amount` unless currency was declared
  if (currency !== 'USD') {
    const declared = detectEvidenceCurrency(m);
    if (declared !== currency) {
      return 0;
    }
  }

  const genericRefund = readSignedNumber(m, ['refundAmount']);
  if (genericRefund !== null && genericRefund !== 0) {
    return -Math.abs(genericRefund);
  }

  const genericVal = readSignedNumber(m, ['revenue', 'amount', 'value']);
  if (genericVal === null) return 0;
  return isReversal && genericVal > 0 ? -genericVal : genericVal;
}

function isInternalDiagnosticEvidence(ev: OutcomeEvidenceRecord): boolean {
  return (
    ev.provenanceClass === 'internal_diagnostic' ||
    ev.trustTier === 'diagnostic_only' ||
    ev.sourceType === 'deterministic_execution' ||
    ev.evidenceType === 'diagnostic_checksum'
  );
}

export function extractEvidenceContributionForMetric(
  ev: OutcomeEvidenceRecord,
  metricKey: string,
  metricUnit: MetricUnit
): number {
  const m = ev.structuredMetrics ?? {};
  const isReversal = ev.evidenceType === 'outcome_reversal';

  // Hard boundary: Internal SHA-256 diagnostics NEVER contribute to external business metrics
  if (isInternalDiagnosticEvidence(ev)) {
    if (metricKey === 'diagnostic_verifications') {
      const v = readSignedNumber(m, ['count', 'value'], 1) ?? 1;
      return v;
    }
    return 0;
  }

  if (metricKey === 'diagnostic_verifications') {
    return 0;
  }

  // Explicit metricKey override inside structuredMetrics (still subject to currency isolation for revenue)
  if (
    typeof m.metricKey === 'string' &&
    m.metricKey.trim() === metricKey &&
    !metricKey.startsWith('revenue_earned') &&
    typeof m.value === 'number' &&
    Number.isFinite(m.value) &&
    m.value !== 0
  ) {
    return isReversal && m.value > 0 ? -m.value : m.value;
  }

  if (
    metricKey === 'revenue_earned' ||
    metricKey === 'revenue_earned_usd' ||
    metricKey === 'revenue_earned_ngn' ||
    metricKey === 'revenue_earned_eur' ||
    metricKey === 'revenue_earned_gbp'
  ) {
    if (
      ev.evidenceType !== 'payment_confirmed' &&
      ev.evidenceType !== 'customer_acquired' &&
      ev.evidenceType !== 'custom_outcome' &&
      ev.evidenceType !== 'outcome_reversal'
    ) {
      return 0;
    }
    const targetCurrency: 'USD' | 'NGN' | 'EUR' | 'GBP' =
      metricUnit === 'NGN' || metricKey === 'revenue_earned_ngn'
        ? 'NGN'
        : metricUnit === 'EUR' || metricKey === 'revenue_earned_eur'
          ? 'EUR'
          : metricUnit === 'GBP' || metricKey === 'revenue_earned_gbp'
            ? 'GBP'
            : 'USD';

    return extractRevenueForCurrency(ev, targetCurrency);
  }

  switch (metricKey) {
    case 'paying_customers': {
      if (ev.evidenceType === 'customer_acquired') {
        const v =
          readSignedNumber(
            m,
            [
              'customersAcquired',
              'customers',
              'dealsWon',
              'verifiedDealsWon',
              'count',
              'value',
            ],
            1
          ) ?? 1;
        return v;
      }
      if (ev.evidenceType === 'payment_confirmed') {
        return (
          readSignedNumber(m, ['customersAcquired', 'customers', 'dealsWon'], 0) ??
          0
        );
      }
      if (isReversal) {
        const v = readSignedNumber(
          m,
          ['customersAcquired', 'customers', 'dealsWon', 'customersChurned'],
          null
        );
        if (v !== null && v !== 0) {
          return v > 0 ? -v : v;
        }
      }
      return 0;
    }

    case 'meetings_booked': {
      if (ev.evidenceType === 'meeting_booked') {
        return (
          readSignedNumber(
            m,
            [
              'meetingsBooked',
              'meetings',
              'verifiedMeetingsBooked',
              'count',
              'value',
            ],
            1
          ) ?? 1
        );
      }
      if (isReversal) {
        const v = readSignedNumber(
          m,
          ['meetingsBooked', 'meetings', 'meetingsCancelled'],
          null
        );
        if (v !== null && v !== 0) {
          return v > 0 ? -v : v;
        }
      }
      return 0;
    }

    case 'replies_received': {
      if (ev.evidenceType === 'reply_received') {
        return (
          readSignedNumber(
            m,
            [
              'repliesReceived',
              'replies',
              'verifiedRepliesReceived',
              'count',
              'value',
            ],
            1
          ) ?? 1
        );
      }
      return 0;
    }

    case 'qualified_leads': {
      if (ev.evidenceType === 'qualified_lead') {
        return (
          readSignedNumber(
            m,
            [
              'qualifiedLeads',
              'leads',
              'verifiedQualifiedProspects',
              'count',
              'value',
            ],
            1
          ) ?? 1
        );
      }
      return 0;
    }

    case 'prospects_identified': {
      if (ev.evidenceType === 'prospect_identified') {
        return (
          readSignedNumber(
            m,
            [
              'prospectsFound',
              'prospects',
              'leads',
              'verifiedProspectsFound',
              'count',
              'value',
            ],
            1
          ) ?? 1
        );
      }
      return 0;
    }

    case 'messages_delivered': {
      if (ev.evidenceType === 'message_delivered') {
        return (
          readSignedNumber(
            m,
            [
              'messagesDelivered',
              'messages',
              'verifiedMessagesDelivered',
              'count',
              'value',
            ],
            1
          ) ?? 1
        );
      }
      return 0;
    }

    case 'custom_target_outcomes': {
      if (ev.evidenceType === 'custom_outcome') {
        return readSignedNumber(m, ['count', 'value'], 1) ?? 1;
      }
      if (isReversal && m.metricKey === 'custom_target_outcomes') {
        const v = readSignedNumber(m, ['count', 'value'], 0) ?? 0;
        return v > 0 ? -v : v;
      }
      return 0;
    }

    default:
      return 0;
  }
}

function isAuthoritativeBusinessVerification(ev: OutcomeEvidenceRecord): boolean {
  if (ev.verificationState !== 'verified') return false;
  if (ev.hasConflict) return false;
  if (isInternalDiagnosticEvidence(ev)) {
    return false;
  }
  // If provenanceClass is populated, require provider_confirmed or human_confirmed
  if (ev.provenanceClass) {
    return (
      ev.provenanceClass === 'provider_confirmed' ||
      ev.provenanceClass === 'human_confirmed'
    );
  }
  return true;
}

export interface ComputedGoalProgressSummary {
  metrics: Array<
    Omit<GoalMetricValueRecord, 'id' | 'userId' | 'workspaceId' | 'updatedAt'>
  >;
  progressPercent: number;
  isGoalAchieved: boolean;
}

/**
 * Goal Progress Intelligence Engine.
 * Strictly separates:
 *  - targetValue (stated target; 0 when ambiguous/unquantified)
 *  - attemptedValue (task attempts / dispatches)
 *  - completedValue (completed executions / HTTP 2xx dispatches — NEVER counted as verified outcomes)
 *  - verifiedValue (corroborated provider_confirmed / human_confirmed outcome_evidence ONLY, net of reversals, deduplicated & conflict-quarantined)
 *  - estimatedValue (pending_verification or conflict-quarantined outcome_evidence)
 */
export function computeGoalMetricsAndProgress(params: {
  goal: Pick<GoalRecord, 'id' | 'targetMetric'>;
  existingDefinitions?: ParsedMetricDefinition[];
  tasks: TaskRecord[];
  attempts: TaskAttemptRecord[];
  evidence: OutcomeEvidenceRecord[];
}): ComputedGoalProgressSummary {
  const { goal, tasks, attempts, evidence } = params;
  const definitions =
    params.existingDefinitions && params.existingDefinitions.length > 0
      ? params.existingDefinitions
      : parseGoalTargetMetrics(goal.targetMetric);

  const goalTasks = tasks.filter((t) => t.goalId === goal.id);
  const goalAttempts = attempts.filter((a) => a.goalId === goal.id);
  const goalEvidence = evidence.filter((e) => e.goalId === goal.id);

  const computedMetrics = definitions.map((def) => {
    let attemptedValue = 0;
    let completedValue = 0;
    let verifiedValue = 0;
    let estimatedValue = 0;

    for (const t of goalTasks) {
      const taskAttemptsCount = Math.max(
        goalAttempts.filter((a) => a.taskId === t.id).length,
        t.retryCount +
          (t.status === 'completed' ||
          t.status === 'pending_verification' ||
          t.status === 'verified'
            ? 1
            : 0)
      );
      const isFinishedExecution =
        t.status === 'completed' ||
        t.status === 'pending_verification' ||
        t.status === 'verified';

      const matchesCategory =
        (def.metricKey === 'messages_delivered' &&
          t.actionCategory === 'message_send') ||
        (def.metricKey === 'qualified_leads' &&
          t.actionCategory === 'prospect_qualification') ||
        (def.metricKey === 'prospects_identified' &&
          t.actionCategory === 'prospect_research') ||
        (def.metricKey === 'meetings_booked' &&
          t.actionCategory === 'calendar_booking') ||
        (def.metricKey === 'paying_customers' &&
          (t.actionCategory === 'crm_update' ||
            t.actionCategory === 'payment_collection')) ||
        (def.metricKey.startsWith('revenue_earned') &&
          t.actionCategory === 'payment_collection') ||
        (def.metricKey === 'diagnostic_verifications' &&
          t.actionCategory === 'internal_test') ||
        (def.metricKey === 'custom_target_outcomes' &&
          t.actionCategory === 'external_workflow');

      if (matchesCategory) {
        attemptedValue += taskAttemptsCount;
        if (isFinishedExecution) {
          completedValue += 1;
        }
      }
    }

    // Pre-scan positive non-reversal claims grouped by externalReferenceId to detect duplicates & conflicts
    const positiveRefClaims = new Map<
      string,
      Array<{ ev: OutcomeEvidenceRecord; delta: number }>
    >();

    for (const ev of goalEvidence) {
      if (ev.evidenceType === 'api_dispatch_ack') continue;
      if (ev.verificationState === 'rejected') continue;
      const delta = extractEvidenceContributionForMetric(
        ev,
        def.metricKey,
        def.unit
      );
      if (
        delta > 0 &&
        ev.evidenceType !== 'outcome_reversal' &&
        ev.externalReferenceId &&
        ev.externalReferenceId.trim()
      ) {
        const refKey = ev.externalReferenceId.trim();
        const list = positiveRefClaims.get(refKey) ?? [];
        list.push({ ev, delta });
        positiveRefClaims.set(refKey, list);
      }
    }

    const processedPositiveRefs = new Set<string>();

    for (const ev of goalEvidence) {
      if (ev.evidenceType === 'api_dispatch_ack') continue;
      if (ev.verificationState === 'rejected') continue;

      const delta = extractEvidenceContributionForMetric(
        ev,
        def.metricKey,
        def.unit
      );
      if (delta === 0) continue;

      // Diagnostic checksums only apply to diagnostic_verifications
      if (def.metricKey === 'diagnostic_verifications') {
        if (ev.verificationState === 'verified') {
          verifiedValue += delta;
        }
        continue;
      }

      // Negative adjustments (refunds, chargebacks, cancelled bookings)
      if (delta < 0) {
        if (isAuthoritativeBusinessVerification(ev)) {
          verifiedValue += delta;
        } else if (ev.verificationState === 'pending_verification') {
          estimatedValue += delta;
        }
        continue;
      }

      // Deduplicate & conflict-check positive claims sharing externalReferenceId
      const refKey = ev.externalReferenceId?.trim() || null;
      if (refKey && positiveRefClaims.has(refKey)) {
        if (processedPositiveRefs.has(refKey)) {
          continue;
        }
        processedPositiveRefs.add(refKey);

        const group = positiveRefClaims.get(refKey)!;
        const humanConfirmedInGroup = group.find(
          (g) =>
            g.ev.verificationState === 'verified' &&
            g.ev.provenanceClass === 'human_confirmed' &&
            !g.ev.hasConflict
        );
        if (humanConfirmedInGroup) {
          verifiedValue += humanConfirmedInGroup.delta;
          continue;
        }

        const distinctDeltas = new Set(group.map((g) => g.delta));
        const anyFlaggedConflict = group.some((g) => g.ev.hasConflict);
        if (distinctDeltas.size > 1 || anyFlaggedConflict) {
          // Conflicting claims for the same externalReferenceId: quarantine in estimatedValue until human resolves
          const maxClaim = Math.max(...group.map((g) => g.delta));
          estimatedValue += maxClaim;
          continue;
        }

        const verifiedMember = group.find((g) =>
          isAuthoritativeBusinessVerification(g.ev)
        );
        if (verifiedMember) {
          // Count once even if multiple distinct events reported the same externalReferenceId
          verifiedValue += verifiedMember.delta;
        } else {
          estimatedValue += group[0].delta;
        }
        continue;
      }

      if (ev.hasConflict) {
        estimatedValue += delta;
        continue;
      }

      if (isAuthoritativeBusinessVerification(ev)) {
        verifiedValue += delta;
      } else {
        estimatedValue += delta;
      }
    }

    verifiedValue = Math.max(0, Number(verifiedValue.toFixed(4)));
    estimatedValue = Math.max(0, Number(estimatedValue.toFixed(4)));

    return {
      goalId: goal.id,
      metricKey: def.metricKey,
      metricLabel: def.metricLabel,
      unit: def.unit,
      isPrimaryTarget: def.isPrimaryTarget,
      targetValue: def.targetValue,
      attemptedValue,
      completedValue,
      verifiedValue,
      estimatedValue,
    };
  });

  const allPrimaryDefinitions = computedMetrics.filter((m) => m.isPrimaryTarget);
  const quantifiedPrimaryMetrics = allPrimaryDefinitions.filter(
    (m) => m.targetValue > 0
  );

  // If ANY primary metric has no quantified numeric target (e.g. "Maximize revenue"),
  // do NOT auto-mark the goal achieved; compute partial progress only across quantified primaries if any.
  if (quantifiedPrimaryMetrics.length === 0) {
    return {
      metrics: computedMetrics,
      progressPercent: 0,
      isGoalAchieved: false,
    };
  }

  const hasUnquantifiedPrimary =
    quantifiedPrimaryMetrics.length < allPrimaryDefinitions.length;

  let ratioSum = 0;
  let allSatisfied = !hasUnquantifiedPrimary;

  for (const pm of quantifiedPrimaryMetrics) {
    const ratio = Math.min(1, Math.max(0, pm.verifiedValue / pm.targetValue));
    ratioSum += ratio;
    if (pm.verifiedValue < pm.targetValue) {
      allSatisfied = false;
    }
  }

  const progressPercent = allSatisfied
    ? 100
    : Math.min(
        99,
        Math.floor((ratioSum / allPrimaryDefinitions.length) * 100)
      );

  return {
    metrics: computedMetrics,
    progressPercent,
    isGoalAchieved: allSatisfied,
  };
}
