import {
  detectRequiresApproval,
  isExternalProviderTool,
  normalizeActionCategory,
  normalizeCapabilities,
  normalizeToolId,
} from './domain-rules.ts';
import type {
  CapabilityId,
  GoalMetricValueRecord,
  GoalRecord,
  IntegrationProviderKey,
  NextActionProposalRecord,
  OutcomeEvidenceRecord,
  TaskAttemptRecord,
  TaskRecord,
} from '../types.ts';

export interface ReasoningSituationDiagnostics {
  verifiedPrimarySatisfied: boolean;
  hasUnquantifiedTarget: boolean;
  deadlineExpired: boolean;
  deadlineHoursRemaining: number | null;
  repeatedProviderFailureTaskIds: string[];
  uncertainReconciliationTaskIds: string[];
  conflictingEvidenceIds: string[];
  reversalEvidenceCount: number;
  uncorroboratedEvidenceCount: number;
  missingCapabilitiesForBlockedTasks: CapabilityId[];
  completedTasksZeroBusinessResults: boolean;
  incompletePrerequisiteTaskIds: string[];
  unrealisticTargetVelocityWarning: boolean;
  insufficientResourceSignal: boolean;
  diagnosticFlags: string[];
}

export interface RawReasoningModelOutput {
  currentAssessment?: string;
  goalAchievedRecommendation?: boolean;
  humanInterventionRequired?: boolean;
  confidenceLevel?: string;
  reasoningSummary?: string;
  findings?: string[];
  recommendedNextActions?: string[];
  proposals?: Array<{
    proposalType?: string;
    title?: string;
    description?: string;
    proposedTool?: string;
    actionCategory?: string;
    requiredCapabilities?: string[];
    dependencies?: string[];
    targetTaskId?: string;
    approvalRequired?: boolean;
    expectedOutcome?: string;
    verificationMethod?: string;
  }>;
}

export interface ValidatedReasoningOutput {
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
  diagnostics: ReasoningSituationDiagnostics;
}

const INSUFFICIENT_RESOURCE_REGEX =
  /\b(zero budget|\$0 budget|no budget|insufficient budget|insufficient funds|quota exceeded|credit exhausted|no ad spend|rate limit|out of credits|no leads list|empty prospect list)\b/i;

/**
 * Computes deterministic anomaly & operational diagnostics across goal, tasks, attempts,
 * evidence trust tiers, capabilities, and deadlines BEFORE and AFTER Gemini reasoning.
 */
export function buildReasoningSituationDiagnostics(params: {
  goal: GoalRecord;
  tasks: TaskRecord[];
  metrics: GoalMetricValueRecord[];
  recentAttempts: TaskAttemptRecord[];
  recentEvidence: OutcomeEvidenceRecord[];
  verifiedCapabilities: CapabilityId[];
  nowMs?: number;
}): ReasoningSituationDiagnostics {
  const nowMs = params.nowMs ?? Date.now();
  const primaryMetrics = params.metrics.filter((m) => m.isPrimaryTarget);
  const hasUnquantifiedTarget =
    primaryMetrics.length === 0 || primaryMetrics.some((m) => m.targetValue <= 0);

  const conflictingEvidenceIds = params.recentEvidence
    .filter((e) => e.hasConflict && e.verificationState !== 'rejected')
    .map((e) => e.id);

  const reversalEvidenceCount = params.recentEvidence.filter(
    (e) =>
      e.evidenceType === 'outcome_reversal' && e.verificationState !== 'rejected'
  ).length;

  const uncorroboratedEvidenceCount = params.recentEvidence.filter(
    (e) =>
      e.verificationState === 'pending_verification' &&
      e.evidenceType !== 'api_dispatch_ack' &&
      e.provenanceClass !== 'internal_diagnostic'
  ).length;

  const verifiedPrimarySatisfied =
    !hasUnquantifiedTarget &&
    conflictingEvidenceIds.length === 0 &&
    primaryMetrics.every(
      (m) => m.targetValue > 0 && m.verifiedValue >= m.targetValue
    );

  let deadlineExpired = false;
  let deadlineHoursRemaining: number | null = null;
  if (params.goal.deadline) {
    const dlMs = new Date(params.goal.deadline).getTime();
    if (!Number.isNaN(dlMs)) {
      deadlineHoursRemaining = Number(((dlMs - nowMs) / 3_600_000).toFixed(2));
      if (dlMs <= nowMs && !verifiedPrimarySatisfied) {
        deadlineExpired = true;
      }
    }
  }

  const uncertainReconciliationTaskIds = params.tasks
    .filter((t) => t.reconciliationRequired)
    .map((t) => t.id);

  const repeatedProviderFailureTaskIds = params.tasks
    .filter(
      (t) =>
        !t.reconciliationRequired &&
        (t.status === 'failed' || t.retryCount >= Math.max(2, t.maxRetries))
    )
    .map((t) => t.id);

  const verifiedCapSet = new Set<CapabilityId>(params.verifiedCapabilities);
  const missingCapsSet = new Set<CapabilityId>();
  for (const t of params.tasks) {
    if (
      t.status === 'blocked' ||
      t.status === 'queued' ||
      t.status === 'approved'
    ) {
      for (const c of t.requiredCapabilities) {
        if (!verifiedCapSet.has(c)) {
          missingCapsSet.add(c);
        }
      }
    }
  }
  const missingCapabilitiesForBlockedTasks = Array.from(missingCapsSet);

  const tasksById = new Map(params.tasks.map((t) => [t.id, t]));
  const incompletePrerequisiteTaskIds: string[] = [];
  for (const t of params.tasks) {
    if (
      t.status === 'queued' ||
      t.status === 'approved' ||
      t.status === 'blocked'
    ) {
      for (const depId of t.dependencies) {
        const dep = tasksById.get(depId);
        if (!dep || (dep.status !== 'completed' && dep.status !== 'verified')) {
          if (!incompletePrerequisiteTaskIds.includes(t.id)) {
            incompletePrerequisiteTaskIds.push(t.id);
          }
        }
      }
    }
  }

  const finishedExecutionCount = params.tasks.filter(
    (t) =>
      t.tool !== 'internal_test_tool' &&
      (t.status === 'completed' ||
        t.status === 'pending_verification' ||
        t.status === 'verified')
  ).length;
  const totalPrimaryVerified = primaryMetrics.reduce(
    (sum, m) => sum + m.verifiedValue,
    0
  );
  const completedTasksZeroBusinessResults =
    finishedExecutionCount >= 1 &&
    totalPrimaryVerified === 0 &&
    !verifiedPrimarySatisfied;

  // Detect unrealistic target relative to remaining time or scale
  const unrealisticTargetVelocityWarning = primaryMetrics.some((pm) => {
    if (pm.targetValue <= 0 || pm.verifiedValue >= pm.targetValue) return false;
    const remainingGap = pm.targetValue - pm.verifiedValue;
    if (
      deadlineHoursRemaining !== null &&
      deadlineHoursRemaining > 0 &&
      deadlineHoursRemaining <= 48 &&
      ((pm.unit === 'count' && remainingGap >= 100) ||
        (pm.unit === 'USD' && remainingGap >= 100_000) ||
        (pm.unit === 'EUR' && remainingGap >= 100_000) ||
        (pm.unit === 'GBP' && remainingGap >= 100_000) ||
        (pm.unit === 'NGN' && remainingGap >= 150_000_000))
    ) {
      return true;
    }
    if (pm.unit === 'percent' && pm.targetValue > 100) {
      return true;
    }
    return false;
  });

  const combinedText = [
    params.goal.problem,
    params.goal.targetMetric,
    ...params.tasks.map((t) => `${t.description} ${t.statusReason ?? ''}`),
    ...params.recentAttempts.map(
      (a) => `${a.errorMessage ?? ''} ${a.outputSummary ?? ''}`
    ),
  ].join(' ');
  const insufficientResourceSignal =
    INSUFFICIENT_RESOURCE_REGEX.test(combinedText);

  const diagnosticFlags: string[] = [];
  if (hasUnquantifiedTarget) {
    diagnosticFlags.push(
      'Goal lacks a quantified numeric target metric; human target clarification required before goal can auto-complete.'
    );
  }
  if (deadlineExpired) {
    diagnosticFlags.push(
      `Goal deadline (${params.goal.deadline}) has expired without meeting primary verified target.`
    );
  }
  if (uncertainReconciliationTaskIds.length > 0) {
    diagnosticFlags.push(
      `${uncertainReconciliationTaskIds.length} external task(s) halted in reconciliation_required after timeout/crash; NEVER propose blind retry before reconciliation.`
    );
  }
  if (repeatedProviderFailureTaskIds.length > 0) {
    diagnosticFlags.push(
      `${repeatedProviderFailureTaskIds.length} task(s) exhausted retries or repeatedly failed; diagnose root cause or switch capability provider rather than blind retry.`
    );
  }
  if (conflictingEvidenceIds.length > 0) {
    diagnosticFlags.push(
      `${conflictingEvidenceIds.length} evidence record(s) have conflicting claims on the same externalReferenceId and are quarantined pending human review.`
    );
  }
  if (reversalEvidenceCount > 0) {
    diagnosticFlags.push(
      `${reversalEvidenceCount} outcome reversal / refund / cancellation event(s) reduced net verified progress.`
    );
  }
  if (uncorroboratedEvidenceCount > 0) {
    diagnosticFlags.push(
      `${uncorroboratedEvidenceCount} outcome claim(s) are held in pending_verification awaiting provider corroboration or human review.`
    );
  }
  if (missingCapabilitiesForBlockedTasks.length > 0) {
    diagnosticFlags.push(
      `Missing verified workspace capabilities: [${missingCapabilitiesForBlockedTasks.join(', ')}].`
    );
  }
  if (completedTasksZeroBusinessResults) {
    diagnosticFlags.push(
      'Tasks completed execution (drafts/dispatches), but verified business outcomes remain 0; pivot messaging/targeting or collect verification callbacks.'
    );
  }
  if (incompletePrerequisiteTaskIds.length > 0) {
    diagnosticFlags.push(
      `${incompletePrerequisiteTaskIds.length} downstream task(s) are waiting on incomplete/blocked prerequisite steps.`
    );
  }
  if (unrealisticTargetVelocityWarning) {
    diagnosticFlags.push(
      'Target magnitude vs remaining deadline appears unrealistic under current conversion velocity; recommend scope/timeline recalibration.'
    );
  }
  if (insufficientResourceSignal) {
    diagnosticFlags.push(
      'Resource/budget/quota constraint detected in goal or provider error history.'
    );
  }

  return {
    verifiedPrimarySatisfied,
    hasUnquantifiedTarget,
    deadlineExpired,
    deadlineHoursRemaining,
    repeatedProviderFailureTaskIds,
    uncertainReconciliationTaskIds,
    conflictingEvidenceIds,
    reversalEvidenceCount,
    uncorroboratedEvidenceCount,
    missingCapabilitiesForBlockedTasks,
    completedTasksZeroBusinessResults,
    incompletePrerequisiteTaskIds,
    unrealisticTargetVelocityWarning,
    insufficientResourceSignal,
    diagnosticFlags,
  };
}

/**
 * Enforces deterministic safety, approval, dependency, reconciliation, and honesty guardrails
 * on any Gemini reasoning output so LLM hallucinations or adversarial goal prompts can NEVER
 * bypass approval gates, verification gates, or uncertain-execution reconciliation.
 */
export function applyReasoningSafetyGuardrails(params: {
  raw: RawReasoningModelOutput;
  goal: GoalRecord;
  tasks: TaskRecord[];
  metrics: GoalMetricValueRecord[];
  recentAttempts: TaskAttemptRecord[];
  recentEvidence: OutcomeEvidenceRecord[];
  verifiedCapabilities: CapabilityId[];
  preferredExternalProvider: IntegrationProviderKey | null;
  nowMs?: number;
}): ValidatedReasoningOutput {
  const diagnostics = buildReasoningSituationDiagnostics({
    goal: params.goal,
    tasks: params.tasks,
    metrics: params.metrics,
    recentAttempts: params.recentAttempts,
    recentEvidence: params.recentEvidence,
    verifiedCapabilities: params.verifiedCapabilities,
    nowMs: params.nowMs,
  });

  const tasksById = new Map(params.tasks.map((t) => [t.id, t]));
  const validProposalTypes = new Set<NextActionProposalRecord['proposalType']>([
    'new_task',
    'retry_task',
    'update_dependencies',
    'human_intervention',
  ]);
  const verifiedCapSet = new Set<CapabilityId>(params.verifiedCapabilities);

  const anyPendingApproval = params.tasks.some(
    (t) => t.approvalRequired && t.approvalStatus === 'pending'
  );

  // Hard invariant 1: Goal achievement can NEVER be recommended unless all quantified primary metrics are verified
  const goalAchievedRecommendation =
    diagnostics.verifiedPrimarySatisfied &&
    Boolean(params.raw.goalAchievedRecommendation);

  // Hard invariant 2: Human intervention MUST be flagged when blocked on approval, reconciliation, conflicts, uncorroborated evidence, expired deadline, unquantified target, or missing integrations
  const mustRequireHumanIntervention =
    anyPendingApproval ||
    diagnostics.uncertainReconciliationTaskIds.length > 0 ||
    diagnostics.conflictingEvidenceIds.length > 0 ||
    diagnostics.uncorroboratedEvidenceCount > 0 ||
    diagnostics.missingCapabilitiesForBlockedTasks.length > 0 ||
    diagnostics.hasUnquantifiedTarget ||
    diagnostics.deadlineExpired ||
    diagnostics.unrealisticTargetVelocityWarning ||
    diagnostics.insufficientResourceSignal;

  const humanInterventionRequired =
    mustRequireHumanIntervention || Boolean(params.raw.humanInterventionRequired);

  // Confidence calibration: never claim 'high' confidence when evidence is conflicted or execution outcomes are uncertain
  let confidenceLevel: 'low' | 'medium' | 'high' =
    params.raw.confidenceLevel === 'high' ||
    params.raw.confidenceLevel === 'medium'
      ? params.raw.confidenceLevel
      : 'low';
  if (
    (diagnostics.conflictingEvidenceIds.length > 0 ||
      diagnostics.uncertainReconciliationTaskIds.length > 0) &&
    confidenceLevel === 'high'
  ) {
    confidenceLevel = 'medium';
  }

  const rawProposals = Array.isArray(params.raw.proposals)
    ? params.raw.proposals.slice(0, 4)
    : [];

  const sanitizedProposals: ValidatedReasoningOutput['proposals'] = [];

  for (const p of rawProposals) {
    let proposalType: NextActionProposalRecord['proposalType'] =
      validProposalTypes.has(
        p.proposalType as NextActionProposalRecord['proposalType']
      )
        ? (p.proposalType as NextActionProposalRecord['proposalType'])
        : 'new_task';

    let targetTaskId =
      typeof p.targetTaskId === 'string' && tasksById.has(p.targetTaskId.trim())
        ? p.targetTaskId.trim()
        : null;

    const targetTask = targetTaskId ? tasksById.get(targetTaskId) ?? null : null;

    let title = (p.title?.trim() || p.description?.trim() || 'Recommended Next Action').slice(
      0,
      140
    );
    let description =
      p.description?.trim() ||
      title ||
      'Execute recommended follow-up action toward verified target metric.';

    // Guardrail A: NEVER allow retry_task on a task with uncertain external outcome (reconciliationRequired)
    // or a task that already exhausted retries repeatedly or is already verified!
    if (proposalType === 'retry_task') {
      if (!targetTask) {
        proposalType = 'new_task';
      } else if (targetTask.reconciliationRequired) {
        proposalType = 'human_intervention';
        title = `Reconcile uncertain execution for Step ${targetTask.stepOrder}`.slice(
          0,
          140
        );
        description = `Inspect external provider logs/webhooks for "${targetTask.description}" before any retry so external side effects are not duplicated.`;
      } else if (
        targetTask.status === 'verified' ||
        targetTask.status === 'pending_verification'
      ) {
        proposalType = 'human_intervention';
        title = `Verify outcome evidence for Step ${targetTask.stepOrder}`.slice(
          0,
          140
        );
        description = `Do not re-dispatch "${targetTask.description}"; await or review external outcome verification instead of duplicating execution.`;
      } else if (
        targetTask.retryCount >= Math.max(2, targetTask.maxRetries + 1)
      ) {
        proposalType = 'human_intervention';
        title = `Diagnose repeated provider failure on Step ${targetTask.stepOrder}`.slice(
          0,
          140
        );
        description = `Task "${targetTask.description}" failed ${targetTask.retryCount} time(s). Inspect endpoint health, credentials, or switch workspace adapter before retrying.`;
      }
    }

    let proposedTool = normalizeToolId(
      proposalType === 'human_intervention'
        ? 'llm_reasoning'
        : (p.proposedTool ?? 'llm_reasoning')
    );
    if (proposedTool === 'unsupported') {
      proposedTool = 'llm_reasoning';
      if (proposalType === 'new_task') {
        proposalType = 'human_intervention';
      }
    }

    let actionCategory = normalizeActionCategory(
      proposalType === 'human_intervention' ? 'analysis' : p.actionCategory,
      proposedTool
    );

    const requiredCapabilities = normalizeCapabilities(
      p.requiredCapabilities,
      proposedTool,
      actionCategory
    );

    // Guardrail B: If external tool requires capabilities NOT available in verified workspace integrations,
    // convert unroutable external loops into explicit human_intervention configuration guidance unless user has preferredExternalProvider
    if (
      proposalType === 'new_task' &&
      isExternalProviderTool(proposedTool) &&
      !params.preferredExternalProvider &&
      requiredCapabilities.some((c) => !verifiedCapSet.has(c))
    ) {
      proposalType = 'human_intervention';
      proposedTool = 'llm_reasoning';
      actionCategory = 'analysis';
      description = `Connect and verify a workspace integration supporting [${requiredCapabilities.join(', ')}] before dispatching: ${description}`;
    }

    // Guardrail C: Preserve valid same-goal dependencies (never drop prerequisite ordering!)
    const cleanDependencies: string[] = [];
    if (Array.isArray(p.dependencies)) {
      for (const dep of p.dependencies) {
        if (typeof dep !== 'string') continue;
        const trimmed = dep.trim();
        if (
          trimmed &&
          trimmed !== targetTaskId &&
          tasksById.has(trimmed) &&
          !cleanDependencies.includes(trimmed)
        ) {
          cleanDependencies.push(trimmed);
        }
      }
    }

    // Guardrail D: Approval Gate enforcement — consequential actions ALWAYS require human approval
    const approvalRequired =
      proposalType === 'human_intervention'
        ? true
        : detectRequiresApproval({
            tool: proposedTool,
            actionCategory,
            description,
            requiredCapabilities,
            llmFlaggedApproval: Boolean(p.approvalRequired),
          });

    sanitizedProposals.push({
      proposalType,
      title,
      description,
      proposedTool,
      actionCategory,
      requiredCapabilities: normalizeCapabilities(
        requiredCapabilities,
        proposedTool,
        actionCategory
      ),
      dependencies: cleanDependencies,
      targetTaskId,
      approvalRequired,
      expectedOutcome:
        p.expectedOutcome?.trim() ||
        'Measurable, independently verified progress toward primary goal target.',
      verificationMethod:
        p.verificationMethod?.trim() ||
        'Corroborated provider_confirmed webhook or explicit human_confirmed review.',
    });
  }

  // Ensure at least one actionable proposal exists when the goal is NOT yet achieved
  if (!diagnostics.verifiedPrimarySatisfied && sanitizedProposals.length === 0) {
    if (diagnostics.uncertainReconciliationTaskIds.length > 0) {
      const tId = diagnostics.uncertainReconciliationTaskIds[0];
      sanitizedProposals.push({
        proposalType: 'human_intervention',
        title: 'Reconcile uncertain external task execution',
        description:
          'Check external webhook/provider logs to confirm whether the timed-out execution completed before deciding whether to reconcile or retry.',
        proposedTool: 'llm_reasoning',
        actionCategory: 'analysis',
        requiredCapabilities: ['ai_reasoning'],
        dependencies: [],
        targetTaskId: tId,
        approvalRequired: true,
        expectedOutcome:
          'Uncertain task safely reconciled without duplicate external side effects.',
        verificationMethod: 'Operator reconciliation decision + audit log.',
      });
    } else if (diagnostics.conflictingEvidenceIds.length > 0) {
      sanitizedProposals.push({
        proposalType: 'human_intervention',
        title: 'Resolve conflicting outcome evidence',
        description:
          'Audit conflicting outcome claims sharing the same externalReferenceId in the Monitor Evidence panel and record a human verification decision.',
        proposedTool: 'llm_reasoning',
        actionCategory: 'analysis',
        requiredCapabilities: ['ai_reasoning'],
        dependencies: [],
        targetTaskId: null,
        approvalRequired: true,
        expectedOutcome: 'Authoritative net verified metric restored.',
        verificationMethod: 'Explicit human_review verification record.',
      });
    } else {
      sanitizedProposals.push({
        proposalType: 'new_task',
        title: 'Diagnose conversion bottleneck and refine strategy',
        description:
          'Analyze current outreach/funnel assumptions, target gaps, and prerequisite outputs to formulate a higher-converting next action.',
        proposedTool: 'llm_reasoning',
        actionCategory: 'analysis',
        requiredCapabilities: ['ai_reasoning'],
        dependencies: [],
        targetTaskId: null,
        approvalRequired: false,
        expectedOutcome: 'Structured root-cause and conversion diagnosis.',
        verificationMethod: 'Completed diagnostic artifact in task output.',
      });
    }
  }

  // Merge critical diagnostic flags into findings if the LLM omitted them
  const findings = Array.isArray(params.raw.findings)
    ? params.raw.findings.map((f) => f.trim()).filter(Boolean).slice(0, 6)
    : [];
  for (const flag of diagnostics.diagnosticFlags) {
    if (findings.length >= 6) break;
    const prefix = flag.slice(0, 24).toLowerCase();
    if (!findings.some((f) => f.toLowerCase().includes(prefix))) {
      findings.push(flag);
    }
  }

  const recommendedNextActions = Array.isArray(params.raw.recommendedNextActions)
    ? params.raw.recommendedNextActions
        .map((a) => a.trim())
        .filter(Boolean)
        .slice(0, 6)
    : sanitizedProposals.map((p) => p.title);

  return {
    currentAssessment:
      params.raw.currentAssessment?.trim() ||
      (diagnostics.verifiedPrimarySatisfied
        ? 'Primary target metrics verified and satisfied.'
        : 'Goal remains active; verified target metrics are not yet satisfied.'),
    goalAchievedRecommendation,
    humanInterventionRequired,
    confidenceLevel,
    reasoningSummary:
      params.raw.reasoningSummary?.trim() ||
      'Evaluated task execution outcomes, evidence provenance, and remaining verified target gap.',
    findings,
    recommendedNextActions,
    proposals: sanitizedProposals,
    diagnostics,
  };
}
