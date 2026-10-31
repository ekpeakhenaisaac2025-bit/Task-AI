import type {
  ArtifactType,
  ChatAttachmentRecord,
  ChatExecutionTrace,
  ChatModelId,
  ConversationArtifactRecord,
  ExecutionRunRecord,
  ExecutionStageItem,
  ExecutionStageKey,
  GoalRecord,
  OutcomeEvidenceRecord,
  TaskRecord,
} from '../types.ts';

export const SUPPORTED_CHAT_MODELS: ReadonlyArray<{
  id: ChatModelId;
  label: string;
  description: string;
}> = [
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    description: 'Balanced reasoning, planning & multimodal analysis',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash Lite',
    description: 'Fastest low-latency conversational responses',
  },
  {
    id: 'gemini-flash-latest',
    label: 'Gemini Flash Latest',
    description: 'Latest rolling Flash release',
  },
];

const VALID_CHAT_MODEL_IDS = new Set<string>(
  SUPPORTED_CHAT_MODELS.map((m) => m.id)
);

export function normalizeChatModel(raw: unknown): ChatModelId {
  if (typeof raw === 'string' && VALID_CHAT_MODEL_IDS.has(raw.trim())) {
    return raw.trim() as ChatModelId;
  }
  return 'gemini-3.8-flash';
}

export function deriveConversationTitle(firstPrompt: string): string {
  const cleaned = firstPrompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return 'New conversation';
  }

  if (cleaned.length <= 54) {
    return cleaned.replace(/[.,;:!?]+$/, '').trim() || 'New conversation';
  }

  const words = cleaned.split(' ');
  let acc = '';
  for (const word of words) {
    const candidate = acc ? `${acc} ${word}` : word;
    if (candidate.length > 52) break;
    acc = candidate;
  }
  const base = (acc || cleaned.slice(0, 52)).replace(/[.,;:!?]+$/, '').trim();
  return `${base}...`;
}

/**
 * Determines whether a user's message should invoke the full Task.ai
 * Goal Planner + Orchestrator + Verification pipeline vs. conversational analysis.
 */
export function detectComplexExecutionIntent(
  prompt: string,
  explicitMode: 'auto' | 'chat' | 'execute' = 'auto'
): {
  shouldExecute: boolean;
  inferredTargetMetric: string;
  reason: string;
} {
  const trimmed = prompt.trim();

  if (explicitMode === 'chat') {
    return {
      shouldExecute: false,
      inferredTargetMetric: '',
      reason: 'User selected conversational response mode.',
    };
  }

  const metricMatch =
    trimmed.match(
      /\b(\d+(?:,\d{3})*(?:\.\d+)?\s*(?:qualified\s+leads?|leads?|prospects?|customers?|meetings?|demos?|deals?|replies|bookings?|signups?|conversions?|subscribers?|%\s*[a-zA-Z]+))/i
    ) ||
    trimmed.match(
      /(?:(?:\$|€|£|₦|USD\s*|EUR\s*|GBP\s*|NGN\s*)\d+(?:,\d{3})*(?:\.\d+)?(?:\s*[kKmM])?(?:\s*(?:in\s+)?(?:revenue|ARR|MRR|sales|pipeline))?)/i
    );

  const inferredTargetMetric = metricMatch
    ? metricMatch[0].trim()
    : '1 verified deliverable outcome matching the stated objective';

  if (explicitMode === 'execute') {
    return {
      shouldExecute: true,
      inferredTargetMetric,
      reason: 'User explicitly requested autonomous task execution.',
    };
  }

  // Pure questions, greetings, or code/explanation prompts should remain fast chat unless explicitly asking to execute a workflow
  const lower = trimmed.toLowerCase();
  if (trimmed.length < 18) {
    return {
      shouldExecute: false,
      inferredTargetMetric: '',
      reason: 'Short conversational message.',
    };
  }

  const pureQuestionStart =
    /^(?:what|why|how\s+does|who|when|where|can\s+you\s+explain|explain|define|summarize\s+this|translate|hi\b|hello\b|hey\b|thanks\b)/i.test(
      trimmed
    );

  const actionWorkflowSignals = [
    /\b(?:launch|execute|orchestrate|automate|dispatch|run\s+a\s+campaign|run\s+outreach|start\s+a\s+campaign|build\s+and\s+execute|plan\s+and\s+execute|create\s+an?\s+execution\s+plan)\b/i,
    /\b(?:acquire|generate|book|close|convert|collect)\s+\d+/i,
    /\b(?:outreach\s+campaign|lead\s+generation|prospect\s+qualification|webhook\s+workflow|crm\s+sync|calendar\s+booking|follow-up\s+sequence)\b/i,
    /\b(?:break\s+this\s+into\s+tasks|decompose\s+into\s+tasks|create\s+a\s+goal|schedule\s+tasks)\b/i,
  ];

  const matchedSignals = actionWorkflowSignals.filter((re) =>
    re.test(trimmed)
  ).length;

  if (
    matchedSignals >= 1 &&
    (!pureQuestionStart || /\b(?:and\s+execute|and\s+run|plan\s+for)\b/i.test(lower))
  ) {
    return {
      shouldExecute: true,
      inferredTargetMetric,
      reason:
        'Detected actionable multi-step objective requiring Task.ai planning, routing, execution, and verification.',
    };
  }

  return {
    shouldExecute: false,
    inferredTargetMetric: '',
    reason: 'Direct conversational analysis or Q&A request.',
  };
}

/**
 * Builds the 7-stage Execution Activity Panel trace strictly from real persisted
 * Goal, Task, ExecutionRun, and OutcomeEvidence records.
 *
 * CRITICAL INVARIANT: Never marks a task or objective as completed/verified without
 * actual execution evidence. Consequential tasks halted at the Approval Gate or
 * awaiting external callbacks are surfaced with exact, honest states.
 */
export function buildHonestExecutionTrace(params: {
  goal: GoalRecord;
  tasks: TaskRecord[];
  run?: ExecutionRunRecord | null;
  evidence?: OutcomeEvidenceRecord[];
  stageOverrides?: Partial<Record<ExecutionStageKey, Partial<ExecutionStageItem>>>;
}): ChatExecutionTrace {
  const { goal, tasks, run = null, evidence = [], stageOverrides = {} } = params;
  const nowIso = new Date().toISOString();

  const sortedTasks = [...tasks].sort((a, b) => a.stepOrder - b.stepOrder);
  const totalTasks = sortedTasks.length;

  const awaitingApprovalTasks = sortedTasks.filter(
    (t) =>
      t.approvalRequired &&
      t.approvalStatus === 'pending' &&
      t.status !== 'rejected'
  );
  const completedOrFurtherTasks = sortedTasks.filter(
    (t) =>
      t.status === 'completed' ||
      t.status === 'pending_verification' ||
      t.status === 'verified'
  );
  const pendingVerificationTasks = sortedTasks.filter(
    (t) =>
      t.status === 'pending_verification' ||
      t.verificationStatus === 'pending_verification'
  );
  const verifiedTasks = sortedTasks.filter(
    (t) => t.status === 'verified' || t.verificationStatus === 'verified'
  );
  const blockedOrFailedTasks = sortedTasks.filter(
    (t) => t.status === 'blocked' || t.status === 'failed'
  );
  const runningTasks = sortedTasks.filter((t) => t.status === 'running');

  const verifiedExternalEvidence = evidence.filter(
    (e) =>
      e.verificationState === 'verified' &&
      e.provenanceClass !== 'internal_diagnostic'
  );
  const diagnosticEvidence = evidence.filter(
    (e) => e.provenanceClass === 'internal_diagnostic'
  );
  const pendingEvidence = evidence.filter(
    (e) => e.verificationState === 'pending_verification'
  );

  // Stage 1: Understanding objective
  const stage1: ExecutionStageItem = {
    key: 'understanding_objective',
    label: 'Understanding objective',
    status: 'completed',
    summary: `Parsed objective and target metric: "${goal.targetMetric}".`,
    details: [
      `Objective: ${goal.problem}`,
      `Target metric (unachieved baseline): ${goal.targetMetric}`,
      `Goal status: ${goal.status} · Engine state: ${goal.executionState}`,
    ],
    updatedAt: goal.createdAt || nowIso,
    ...stageOverrides.understanding_objective,
  };

  // Stage 2: Planning
  const stage2: ExecutionStageItem = {
    key: 'planning',
    label: 'Planning',
    status: totalTasks > 0 ? 'completed' : 'running',
    summary:
      totalTasks > 0
        ? `Generated dependency-validated execution plan (${totalTasks} steps).`
        : 'Synthesizing execution plan with AI Planner...',
    details:
      totalTasks > 0
        ? [
            `Goal ID: ${goal.id}`,
            `DAG nodes created: ${totalTasks}`,
            `Approval-gated consequential steps: ${sortedTasks.filter((t) => t.approvalRequired).length}`,
          ]
        : undefined,
    updatedAt: goal.updatedAt || nowIso,
    ...stageOverrides.planning,
  };

  // Stage 3: Task breakdown
  const stage3: ExecutionStageItem = {
    key: 'task_breakdown',
    label: 'Task breakdown',
    status: totalTasks > 0 ? 'completed' : 'pending',
    summary:
      totalTasks > 0
        ? `${totalTasks} ordered tasks structured with explicit dependencies and verification criteria.`
        : 'Waiting for task decomposition.',
    details: sortedTasks.map((t) => {
      const gateTag = t.approvalRequired
        ? `Approval: ${t.approvalStatus}`
        : 'Auto-eligible';
      return `Step ${t.stepOrder}: ${t.description} (${t.actionCategory} · ${gateTag})`;
    }),
    updatedAt: nowIso,
    ...stageOverrides.task_breakdown,
  };

  // Stage 4: Tool selection
  const uniqueTools = Array.from(new Set(sortedTasks.map((t) => t.tool)));
  const unsupportedCount = sortedTasks.filter(
    (t) => t.tool === 'unsupported'
  ).length;
  const stage4: ExecutionStageItem = {
    key: 'tool_selection',
    label: 'Tool selection',
    status:
      totalTasks === 0
        ? 'pending'
        : unsupportedCount > 0
          ? 'blocked'
          : 'completed',
    summary:
      totalTasks > 0
        ? `Capability router bound ${uniqueTools.length} provider adapter(s): ${uniqueTools.join(', ')}.`
        : 'Awaiting capability routing.',
    details: sortedTasks.map(
      (t) =>
        `Step ${t.stepOrder} → ${t.assignedProvider || t.tool} [capabilities: ${t.requiredCapabilities.join(', ')}]`
    ),
    updatedAt: nowIso,
    ...stageOverrides.tool_selection,
  };

  // Stage 5: Execution
  let execStatus: ExecutionStageItem['status'] = 'pending';
  let execSummary = 'No tasks dispatched yet.';
  if (runningTasks.length > 0) {
    execStatus = 'running';
    execSummary = `Executing ${runningTasks.length} task(s) via server orchestrator...`;
  } else if (awaitingApprovalTasks.length > 0) {
    execStatus = 'awaiting_approval';
    execSummary = `${completedOrFurtherTasks.length}/${totalTasks} task(s) executed; ${awaitingApprovalTasks.length} consequential task(s) paused at Approval Gate.`;
  } else if (blockedOrFailedTasks.length > 0) {
    execStatus = blockedOrFailedTasks.some((t) => t.status === 'failed')
      ? 'failed'
      : 'blocked';
    execSummary = `${completedOrFurtherTasks.length}/${totalTasks} task(s) executed; ${blockedOrFailedTasks.length} task(s) blocked or failed.`;
  } else if (totalTasks > 0 && completedOrFurtherTasks.length === totalTasks) {
    execStatus = 'completed';
    execSummary = `All ${totalTasks} planned task(s) completed worker execution.`;
  } else if (completedOrFurtherTasks.length > 0) {
    execStatus = 'running';
    execSummary = `${completedOrFurtherTasks.length}/${totalTasks} task(s) executed.`;
  }

  const stage5: ExecutionStageItem = {
    key: 'execution',
    label: 'Execution',
    status: execStatus,
    summary: execSummary,
    details: [
      ...(run
        ? [
            `Orchestrator Run ${run.id.slice(0, 8)}: ${run.tasksDispatched} dispatched, ${run.tasksSucceeded} succeeded, ${run.tasksFailed} failed (${run.status})`,
          ]
        : []),
      ...sortedTasks.map(
        (t) =>
          `Step ${t.stepOrder} [${t.status}]: ${t.statusReason || t.description}`
      ),
    ],
    updatedAt: nowIso,
    ...stageOverrides.execution,
  };

  // Stage 6: Verification
  let verifStatus: ExecutionStageItem['status'] = 'pending';
  let verifSummary =
    'No verified business outcome evidence recorded yet.';
  if (verifiedExternalEvidence.length > 0 && goal.status === 'completed') {
    verifStatus = 'completed';
    verifSummary = `${verifiedExternalEvidence.length} external outcome evidence record(s) verified (${goal.progressPercent}% of target).`;
  } else if (
    pendingVerificationTasks.length > 0 ||
    pendingEvidence.length > 0
  ) {
    verifStatus = 'pending_verification';
    verifSummary = `Awaiting independent outcome verification (${pendingVerificationTasks.length} task(s) pending callback/review; ${verifiedExternalEvidence.length} verified external outcome(s)).`;
  } else if (verifiedExternalEvidence.length > 0) {
    verifStatus = 'pending_verification';
    verifSummary = `${verifiedExternalEvidence.length} verified outcome record(s) logged (${goal.progressPercent}% of target metric).`;
  } else if (diagnosticEvidence.length > 0) {
    verifStatus =
      awaitingApprovalTasks.length > 0 ? 'awaiting_approval' : 'pending_verification';
    verifSummary = `${diagnosticEvidence.length} internal SHA-256 diagnostic check(s) passed (diagnostic_only — excluded from external business outcome metrics).`;
  } else if (completedOrFurtherTasks.length > 0) {
    verifStatus =
      awaitingApprovalTasks.length > 0 ? 'awaiting_approval' : 'pending_verification';
    verifSummary = `Internal drafts/analyses persisted (${completedOrFurtherTasks.length} step(s)); unverified drafts are never counted as sent or achieved outcomes.`;
  }

  const stage6: ExecutionStageItem = {
    key: 'verification',
    label: 'Verification',
    status: verifStatus,
    summary: verifSummary,
    details: [
      `Verified business outcomes: ${verifiedExternalEvidence.length}`,
      `Internal diagnostic checks: ${diagnosticEvidence.length} (diagnostic_only)`,
      `Tasks verified: ${verifiedTasks.length}/${totalTasks} · Pending verification: ${pendingVerificationTasks.length}`,
    ],
    updatedAt: nowIso,
    ...stageOverrides.verification,
  };

  // Stage 7: Completed results (Strictly honest!)
  const goalAchievedByEvidence =
    goal.status === 'completed' && verifiedExternalEvidence.length > 0;
  let resultsStatus: ExecutionStageItem['status'] = 'pending';
  let honestCompletionNote = '';

  if (goalAchievedByEvidence) {
    resultsStatus = 'completed';
    honestCompletionNote = `Target metric achieved (${goal.progressPercent}%) backed by ${verifiedExternalEvidence.length} verified outcome evidence record(s).`;
  } else if (awaitingApprovalTasks.length > 0) {
    resultsStatus = 'awaiting_approval';
    honestCompletionNote = `Execution paused honestly at Approval Gate: ${completedOrFurtherTasks.length} preparatory task(s) finished (drafts/strategy saved, 0 external actions falsely claimed), and ${awaitingApprovalTasks.length} consequential task(s) require your explicit approval before dispatch.`;
  } else if (blockedOrFailedTasks.length > 0) {
    resultsStatus = blockedOrFailedTasks.some((t) => t.status === 'failed')
      ? 'failed'
      : 'blocked';
    honestCompletionNote = `Execution halted with ${blockedOrFailedTasks.length} blocked/failed task(s). Verified target progress remains ${goal.progressPercent}%. Inspect provider configuration or reconciliation controls.`;
  } else if (
    completedOrFurtherTasks.length > 0 &&
    verifiedExternalEvidence.length === 0
  ) {
    resultsStatus = 'pending_verification';
    honestCompletionNote = `${completedOrFurtherTasks.length}/${totalTasks} task(s) executed, but 0 external business outcomes have been independently verified yet (verified target progress: ${goal.progressPercent}%).`;
  } else {
    resultsStatus = 'pending';
    honestCompletionNote = `Verified target progress: ${goal.progressPercent}%. Tasks will only report completion once backed by real execution and verification evidence.`;
  }

  const stage7: ExecutionStageItem = {
    key: 'completed_results',
    label: 'Completed results',
    status: resultsStatus,
    summary: honestCompletionNote,
    details: [
      `Verified Goal Progress: ${goal.progressPercent}%`,
      `Target Metric: ${goal.targetMetric}`,
      `Completed Steps: ${completedOrFurtherTasks.length}/${totalTasks} · Awaiting Approval: ${awaitingApprovalTasks.length}`,
    ],
    updatedAt: nowIso,
    ...stageOverrides.completed_results,
  };

  return {
    mode: 'autonomous_execution',
    goalId: goal.id,
    goalProblem: goal.problem,
    targetMetric: goal.targetMetric,
    runId: run?.id ?? null,
    stages: [stage1, stage2, stage3, stage4, stage5, stage6, stage7],
    honestCompletionNote,
    hasVerifiedBusinessOutcome: verifiedExternalEvidence.length > 0,
    awaitingApprovalCount: awaitingApprovalTasks.length,
    pendingVerificationCount: pendingVerificationTasks.length,
  };
}

function slugifyFilename(title: string, ext: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${base || 'taskai-artifact'}.${ext}`;
}

function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates persisted, downloadable workspace artifacts from executed task deliverables
 * or structured Markdown tables / reports in assistant turns.
 */
export function buildArtifactsForTurn(params: {
  conversationId: string;
  messageId: string;
  userId: string;
  workspaceId: string;
  goal?: GoalRecord | null;
  tasks?: TaskRecord[];
  assistantMarkdown: string;
}): Array<Omit<ConversationArtifactRecord, 'id' | 'createdAt'>> {
  const {
    conversationId,
    messageId,
    userId,
    workspaceId,
    goal = null,
    tasks = [],
    assistantMarkdown,
  } = params;

  const artifacts: Array<Omit<ConversationArtifactRecord, 'id' | 'createdAt'>> =
    [];

  if (goal && tasks.length > 0) {
    const sorted = [...tasks].sort((a, b) => a.stepOrder - b.stepOrder);

    // 1. Structured Task Execution Plan Spreadsheet (.csv)
    const csvHeader = [
      'Step',
      'Description',
      'Category',
      'Assigned Provider',
      'Approval Required',
      'Approval Status',
      'Execution Status',
      'Verification Status',
      'Expected Result',
    ].join(',');
    const csvRows = sorted.map((t) =>
      [
        t.stepOrder,
        t.description,
        t.actionCategory,
        t.assignedProvider || t.tool,
        t.approvalRequired ? 'Yes' : 'No',
        t.approvalStatus,
        t.status,
        t.verificationStatus,
        t.expectedResult,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
    artifacts.push({
      conversationId,
      messageId,
      goalId: goal.id,
      taskId: null,
      userId,
      workspaceId,
      title: `Execution Plan Matrix — ${deriveConversationTitle(goal.problem)}`,
      artifactType: 'spreadsheet',
      mimeType: 'text/csv',
      filename: slugifyFilename(`execution-plan-${goal.problem}`, 'csv'),
      content: [csvHeader, ...csvRows].join('\n'),
      metadata: {
        rowCount: sorted.length,
        targetMetric: goal.targetMetric,
        goalStatus: goal.status,
      },
    });

    // 2. Materialize concrete outputs produced by executed LLM reasoning / drafting tasks
    for (const task of sorted) {
      if (!task.outputData) continue;

      const draftedMessages = task.outputData.draftedMessages;
      if (Array.isArray(draftedMessages) && draftedMessages.length > 0) {
        const draftMdLines: string[] = [
          `# Outreach Drafts (Step ${task.stepOrder})`,
          '',
          `> **Delivery Status**: Drafted only — **0 messages sent**. External dispatch requires explicit Approval Gate authorization and configured provider credentials.`,
          '',
          `- **Objective**: ${goal.problem}`,
          `- **Target Metric**: ${goal.targetMetric}`,
          '',
        ];

        draftedMessages.forEach((item: unknown, idx: number) => {
          const rec = (item ?? {}) as Record<string, unknown>;
          draftMdLines.push(
            `## Draft ${idx + 1}: ${String(rec.targetPersona ?? 'Target Persona')}`
          );
          draftMdLines.push(
            `**Subject:** ${String(rec.subjectLine ?? '(No subject)')}`
          );
          draftMdLines.push('');
          draftMdLines.push(String(rec.messageBody ?? ''));
          draftMdLines.push('');
          draftMdLines.push('---');
          draftMdLines.push('');
        });

        artifacts.push({
          conversationId,
          messageId,
          goalId: goal.id,
          taskId: task.id,
          userId,
          workspaceId,
          title: `Outreach Message Drafts (${draftedMessages.length})`,
          artifactType: 'outreach_draft',
          mimeType: 'text/markdown',
          filename: slugifyFilename(
            `outreach-drafts-step-${task.stepOrder}`,
            'md'
          ),
          content: draftMdLines.join('\n'),
          metadata: {
            draftCount: draftedMessages.length,
            deliveryState: 'drafted_only_not_sent',
          },
        });
      } else if (
        typeof task.outputData.deliverable === 'string' &&
        task.outputData.deliverable.trim().length > 0
      ) {
        const criteria = Array.isArray(task.outputData.keyCriteria)
          ? (task.outputData.keyCriteria as unknown[]).map((c) => `- ${String(c)}`)
          : [];
        const docContent = [
          `# ${task.description}`,
          '',
          `- **Objective**: ${goal.problem}`,
          `- **Target Metric**: ${goal.targetMetric}`,
          `- **Verification Status**: ${task.verificationStatus} (Analytical deliverable)`,
          '',
          ...(criteria.length > 0
            ? ['## Key Qualification & Strategy Criteria', '', ...criteria, '']
            : []),
          '## Deliverable Specification',
          '',
          task.outputData.deliverable.trim(),
          '',
          ...(typeof task.outputData.verificationCheck === 'string'
            ? [
                '## Verification Criteria',
                '',
                task.outputData.verificationCheck.trim(),
              ]
            : []),
        ].join('\n');

        artifacts.push({
          conversationId,
          messageId,
          goalId: goal.id,
          taskId: task.id,
          userId,
          workspaceId,
          title: `Strategy & Rubric — Step ${task.stepOrder}`,
          artifactType: 'document',
          mimeType: 'text/markdown',
          filename: slugifyFilename(
            `strategy-deliverable-step-${task.stepOrder}`,
            'md'
          ),
          content: docContent,
          metadata: {
            stepOrder: task.stepOrder,
            executionModel: task.outputData.executionModel ?? null,
          },
        });
      }
    }

    return artifacts;
  }

  // Pure conversational turn: extract CSV spreadsheet from Markdown GFM tables or fenced csv blocks, or structured reports
  const fencedCsvMatch = assistantMarkdown.match(/```csv\s*\n([\s\S]+?)```/i);
  if (fencedCsvMatch && fencedCsvMatch[1].trim().split('\n').length >= 2) {
    const csvBody = fencedCsvMatch[1].trim();
    artifacts.push({
      conversationId,
      messageId,
      goalId: null,
      taskId: null,
      userId,
      workspaceId,
      title: 'Generated Spreadsheet Data',
      artifactType: 'spreadsheet',
      mimeType: 'text/csv',
      filename: 'generated-data.csv',
      content: csvBody,
      metadata: {
        rowCount: Math.max(0, csvBody.split('\n').length - 1),
      },
    });
  } else {
    // Check for Markdown pipe table with >= 3 data rows
    const mdTable = extractMarkdownTableAsCsv(assistantMarkdown);
    if (mdTable && mdTable.rowCount >= 2) {
      artifacts.push({
        conversationId,
        messageId,
        goalId: null,
        taskId: null,
        userId,
        workspaceId,
        title: mdTable.title,
        artifactType: 'spreadsheet',
        mimeType: 'text/csv',
        filename: slugifyFilename(mdTable.title, 'csv'),
        content: mdTable.csv,
        metadata: {
          rowCount: mdTable.rowCount,
        },
      });
    }
  }

  // Check if response is a substantial structured report/document (>= 650 chars & >= 2 headings)
  const headingMatches = assistantMarkdown.match(/^#{1,3}\s+.+$/gm) || [];
  if (assistantMarkdown.trim().length >= 650 && headingMatches.length >= 2) {
    const firstHeading = (headingMatches[0] ?? '')
      .replace(/^#{1,3}\s+/, '')
      .replace(/[*_`]/g, '')
      .trim();
    const baseReportTitle = firstHeading.slice(0, 56) || 'Generated Report';
    const hasSameTitle = artifacts.some(
      (a) => a.title.toLowerCase() === baseReportTitle.toLowerCase()
    );
    const reportTitle = hasSameTitle
      ? `${baseReportTitle} — Full Report`
      : baseReportTitle;
    const artifactType: ArtifactType = /report|audit|analysis|summary/i.test(
      baseReportTitle
    )
      ? 'report'
      : 'document';

    artifacts.push({
      conversationId,
      messageId,
      goalId: null,
      taskId: null,
      userId,
      workspaceId,
      title: reportTitle,
      artifactType,
      mimeType: 'text/markdown',
      filename: slugifyFilename(reportTitle, 'md'),
      content: assistantMarkdown.trim(),
      metadata: {
        charCount: assistantMarkdown.trim().length,
        sectionCount: headingMatches.length,
      },
    });
  }

  return artifacts;
}

function extractMarkdownTableAsCsv(markdown: string): {
  title: string;
  csv: string;
  rowCount: number;
} | null {
  const lines = markdown.split('\n');
  let tableStart = -1;
  for (let i = 0; i < lines.length - 2; i++) {
    const headerCand = lines[i].trim();
    const sepCand = lines[i + 1].trim();
    if (
      headerCand.startsWith('|') &&
      headerCand.endsWith('|') &&
      /^\|[\s:-]+(?:\|[\s:-]+)+\|$/.test(sepCand)
    ) {
      tableStart = i;
      break;
    }
  }
  if (tableStart === -1) return null;

  const parsePipeRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim().replace(/\*\*/g, ''));

  const headers = parsePipeRow(lines[tableStart]);
  const dataRows: string[][] = [];
  for (let j = tableStart + 2; j < lines.length; j++) {
    const rowLine = lines[j].trim();
    if (!rowLine.startsWith('|') || !rowLine.endsWith('|')) break;
    dataRows.push(parsePipeRow(rowLine));
  }

  if (headers.length === 0 || dataRows.length < 2) return null;

  let nearestHeading = 'Structured Table Export';
  for (let k = tableStart - 1; k >= 0; k--) {
    const h = lines[k].trim().match(/^#{1,4}\s+(.+)$/);
    if (h) {
      nearestHeading = h[1].replace(/[*_`]/g, '').trim();
      break;
    }
  }

  const csvLines = [
    headers.map(escapeCsvCell).join(','),
    ...dataRows.map((r) => r.map(escapeCsvCell).join(',')),
  ];

  return {
    title: nearestHeading,
    csv: csvLines.join('\n'),
    rowCount: dataRows.length,
  };
}

/**
 * Parses CSV text into headers and preview rows for interactive table rendering.
 */
export function parseCsvPreviewRows(
  csvContent: string,
  maxRows = 50
): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  const text = csvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentCell);
      currentCell = '';
    } else if (ch === '\n') {
      currentRow.push(currentCell);
      if (currentRow.some((c) => c.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
      if (rows.length >= maxRows + 1) break;
    } else {
      currentCell += ch;
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    if (currentRow.some((c) => c.length > 0) && rows.length < maxRows + 1) {
      rows.push(currentRow);
    }
  }

  if (rows.length === 0) {
    return { headers: [], rows: [] };
  }

  return {
    headers: rows[0],
    rows: rows.slice(1, maxRows + 1),
  };
}

const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_DATA_URL_LENGTH = 5_500_000; // ~4MB binary image
const MAX_TEXT_ATTACHMENT_CHARS = 48_000;

export function sanitizeMessageAttachments(
  raw: unknown
): ChatAttachmentRecord[] {
  if (!Array.isArray(raw)) return [];
  const sanitized: ChatAttachmentRecord[] = [];

  for (const item of raw.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name =
      typeof rec.name === 'string' && rec.name.trim()
        ? rec.name.trim().slice(0, 140)
        : 'attachment';
    const mimeType =
      typeof rec.mimeType === 'string' && rec.mimeType.trim()
        ? rec.mimeType.trim().slice(0, 100)
        : 'application/octet-stream';
    const sizeBytes =
      typeof rec.sizeBytes === 'number' && Number.isFinite(rec.sizeBytes)
        ? Math.max(0, Math.floor(rec.sizeBytes))
        : 0;
    const isImage =
      rec.kind === 'image' || mimeType.toLowerCase().startsWith('image/');

    let dataUrl: string | undefined;
    if (
      isImage &&
      typeof rec.dataUrl === 'string' &&
      /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/.test(
        rec.dataUrl.trim()
      ) &&
      rec.dataUrl.length <= MAX_DATA_URL_LENGTH
    ) {
      dataUrl = rec.dataUrl.trim();
    }

    let textContent: string | undefined;
    if (typeof rec.textContent === 'string' && rec.textContent.length > 0) {
      textContent = rec.textContent.slice(0, MAX_TEXT_ATTACHMENT_CHARS);
    }

    sanitized.push({
      id:
        typeof rec.id === 'string' && rec.id.trim()
          ? rec.id.trim().slice(0, 64)
          : `att_${Math.random().toString(36).slice(2, 10)}`,
      name,
      mimeType,
      sizeBytes,
      kind: isImage ? 'image' : 'file',
      ...(dataUrl ? { dataUrl } : {}),
      ...(textContent ? { textContent } : {}),
    });
  }

  return sanitized;
}
