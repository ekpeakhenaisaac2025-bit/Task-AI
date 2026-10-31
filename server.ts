import './src/server/load-env.ts';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  ensureGoalMetricsInitialized,
  getExecutionMonitorSnapshot,
  getWorkspaceInboundWebhookPublicConfig,
  listGoalMetricsByWorkspace,
  listOutcomeEvidenceByWorkspace,
  recalculateAndPersistGoalProgress,
  rotateWorkspaceInboundWebhookSecret,
} from './src/db/milestone2-repository.ts';
import {
  createGoalForUser,
  createSingleTaskForGoal,
  createUserIntegration,
  createWorkspaceForUser,
  deleteUserIntegration,
  ensureDefaultWorkspaceForUser,
  getGoalByIdForUser,
  getIntegrationByIdForUser,
  getWorkspaceByIdForUser,
  listActionLogsByUser,
  listGoalsByUser,
  listIntegrationsByUser,
  listTasksByUser,
  listWorkspacesByUser,
  recordApprovalDecision,
  rotateUserIntegrationSecrets,
  savePlannedTasksForGoal,
  updateGoalForUser,
  updateUserIntegration,
} from './src/db/repository.ts';
import {
  computeResultsReport,
  detectRequiresApproval,
  normalizeActionCategory,
  normalizeCapabilities,
  normalizeToolId,
  VALID_CAPABILITIES,
} from './src/lib/domain-rules.ts';
import { INTEGRATION_PROVIDER_KEYS } from './src/lib/provider-registry.ts';
import {
  INBOUND_PROVIDER_SIGNATURE_HEADER,
  VALID_EVIDENCE_TYPES,
} from './src/lib/verification-engine.ts';
import {
  createSignedIsolatedToken,
  createSignedSessionToken,
  ISOLATED_COOKIE_NAME,
  requireAuth,
  verifySignedSessionToken,
  type AuthRequest,
} from './src/middleware/auth.ts';
import { redactSecretsFromText } from './src/server/crypto-vault.ts';
import {
  assertValidServerEnvironment,
  getPublicEnvironmentDiagnostics,
  resolveOptionalSharedN8nConfig,
} from './src/server/env-config.ts';
import {
  buildWorkspaceToolRegistry,
  collectVerifiedWorkspaceCapabilities,
  getPlatformCapabilities,
  testUserIntegrationConnection,
} from './src/server/execution-router.ts';
import { generateValidatedPlanWithGemini } from './src/server/gemini.ts';
import {
  controlGoalExecution,
  decideNextActionProposal,
  ingestSignedInboundEvidence,
  reconcileUncertainTask,
  retryTaskManually,
  reviewOutcomeEvidenceByHuman,
  runAiAssistedVerificationOnEvidence,
  runContinuousReasoningForGoal,
  runOrchestratorCycle,
  submitManualWorkspaceEvidence,
} from './src/server/orchestrator.ts';
import { createExpressRateLimitMiddleware } from './src/server/rate-limiter.ts';
import { validateDestinationUrlSync } from './src/server/ssrf-guard.ts';
import {
  runWorkerOnSpecificTask,
  runWorkerQueueNext,
} from './src/server/worker.ts';
import { registerChatAndArtifactRoutes } from './src/server/chat-routes.ts';
import type {
  CapabilityId,
  EvidenceType,
  GoalStatus,
  IntegrationAuthType,
  IntegrationConnectionMode,
  IntegrationProviderKey,
  IntegrationPublicMetadata,
  ProposedActionDetails,
} from './src/types.ts';
import {
  buildEnrichedWorkspaceIntegrationBundle,
  registerMultiConnectorRoutes,
} from './src/server/integration-routes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VALID_GOAL_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'planning',
  'active',
  'blocked',
  'completed',
  'failed',
]);

const VALID_PROVIDER_KEYS: ReadonlySet<string> =
  INTEGRATION_PROVIDER_KEYS as ReadonlySet<string>;

const VALID_AUTH_TYPES: ReadonlySet<string> = new Set([
  'none',
  'header_secret',
  'bearer_token',
  'hmac_sha256',
  'api_key',
  'oauth2',
  'basic_auth',
  'bot_token',
  'google_workspace_oauth',
]);

const SAFE_WEBHOOK_PATH_REGEX = /^[a-zA-Z0-9/_-]+$/;

function parseOptionalDeadline(raw: unknown): {
  valid: boolean;
  date: Date | null | undefined;
  error?: string;
} {
  if (raw === undefined) {
    return { valid: true, date: undefined };
  }
  if (raw === null || raw === '') {
    return { valid: true, date: null };
  }
  if (typeof raw !== 'string') {
    return {
      valid: false,
      date: null,
      error: 'Deadline must be an ISO date string.',
    };
  }
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    return { valid: false, date: null, error: 'Invalid deadline date format.' };
  }
  return { valid: true, date: parsed };
}

async function resolveTargetWorkspaceId(
  userId: string,
  requestedWorkspaceId: unknown
): Promise<string | null> {
  if (
    typeof requestedWorkspaceId === 'string' &&
    requestedWorkspaceId.trim().length > 0
  ) {
    const owned = await getWorkspaceByIdForUser(
      requestedWorkspaceId.trim(),
      userId
    );
    return owned ? owned.id : null;
  }
  const defaultWs = await ensureDefaultWorkspaceForUser(userId);
  return defaultWs.id;
}

async function startServer() {
  // Fail-closed startup verification: rejects missing secrets in production and invalid formats in all environments.
  const startupEnv = assertValidServerEnvironment();
  if (startupEnv.sharedN8n.configurationIssue) {
    console.warn(
      `[Task.ai Config] Optional shared n8n disabled: ${redactSecretsFromText(
        startupEnv.sharedN8n.configurationIssue
      )}`
    );
  }

  const app = express();
  const PORT = 3000;

  const defaultJsonParser = express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody =
        buf.toString('utf8');
    },
  });
  const chatAttachmentJsonParser = express.json({ limit: '8mb' });

  // Preserve exact 256KB rawBody limit on webhooks & API routes, while allowing multimodal attachments on /api/conversations
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/conversations')) {
      return chatAttachmentJsonParser(req, res, next);
    }
    return defaultJsonParser(req, res, next);
  });

  // Sanitized JSON & payload-size error handler (never leaks internal stack traces)
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (
        err &&
        typeof err === 'object' &&
        (err as { type?: string }).type === 'entity.too.large'
      ) {
        const capLabel = req.path.startsWith('/api/conversations')
          ? '8MB'
          : '256KB';
        return res.status(413).json({
          error: `Payload exceeds maximum allowed size (${capLabel}).`,
        });
      }
      if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({
          error: 'Malformed JSON request body.',
        });
      }
      return next(err);
    }
  );

  const authSessionRateLimiter = createExpressRateLimitMiddleware({
    namespace: 'auth_session',
    requestsPerMinute: 30,
    burstLimit: 12,
  });

  const inboundWebhookRateLimiter = createExpressRateLimitMiddleware({
    namespace: 'inbound_webhook',
    requestsPerMinute: 120,
    burstLimit: 25,
    keyExtractor: (req) =>
      `${req.params.workspaceId || 'ws'}:${req.ip || req.socket.remoteAddress || 'anon'}`,
  });

  const aiOperationRateLimiter = createExpressRateLimitMiddleware({
    namespace: 'ai_orchestration',
    requestsPerMinute: 30,
    burstLimit: 10,
    keyExtractor: (req) =>
      (req as AuthRequest).authUser?.uid ||
      req.ip ||
      req.socket.remoteAddress ||
      'anon',
  });

  // Create an isolated per-browser session
  app.post(
    '/api/auth/isolated-session',
    authSessionRateLimiter,
    async (req, res) => {
    try {
      const uid = `iso_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const email = `workspace-${uid.slice(4, 10)}@isolated.task.ai`;
      const token = createSignedIsolatedToken(uid, email);

      const isHttps =
        req.protocol === 'https' ||
        req.headers['x-forwarded-proto'] === 'https';

      const cookieParts = [
        `${ISOLATED_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'Max-Age=604800',
        isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax',
      ];
      res.setHeader('Set-Cookie', cookieParts.join('; '));

      res.status(201).json({
        user: {
          uid,
          email,
          authMode: 'isolated_session',
        },
        token,
      });
    } catch (error: unknown) {
      console.error('Failed to initialize isolated session:', error);
      res.status(500).json({ error: 'Failed to create isolated session.' });
    }
  });

  // Exchange a verified Firebase Google ID token for a durable server-signed session cookie + in-memory token
  app.post(
    '/api/auth/google-session',
    authSessionRateLimiter,
    async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      const bearerToken =
        authHeader && authHeader.startsWith('Bearer ')
          ? authHeader.slice('Bearer '.length).trim()
          : typeof req.body?.idToken === 'string'
            ? req.body.idToken.trim()
            : '';

      if (!bearerToken) {
        return res
          .status(400)
          .json({ error: 'Missing Google Sign-In ID token.' });
      }

      const { getOrCreateUser } = await import('./src/db/users.ts');
      const { adminAuth } = await import('./src/lib/firebase-admin.ts');

      const decoded = await adminAuth.verifyIdToken(bearerToken);
      const email = decoded.email || `${decoded.uid}@authenticated.user`;
      await getOrCreateUser(decoded.uid, email);

      const sessionToken = createSignedSessionToken({
        uid: decoded.uid,
        email,
        authMode: 'google',
      });

      const isHttps =
        req.protocol === 'https' ||
        req.headers['x-forwarded-proto'] === 'https';

      const cookieParts = [
        `${ISOLATED_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
        'Path=/',
        'HttpOnly',
        'Max-Age=604800',
        isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax',
      ];
      res.setHeader('Set-Cookie', cookieParts.join('; '));

      return res.json({
        user: {
          uid: decoded.uid,
          email,
          authMode: 'google',
        },
        token: sessionToken,
      });
    } catch (error: unknown) {
      console.error(
        'Failed to verify Google ID token for session exchange:',
        error
      );
      return res.status(401).json({
        error: 'Unauthorized: Could not verify Google Sign-In token.',
      });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const isHttps =
      req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    const cookieParts = [
      `${ISOLATED_COOKIE_NAME}=`,
      'Path=/',
      'HttpOnly',
      'Max-Age=0',
      isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax',
    ];
    res.setHeader('Set-Cookie', cookieParts.join('; '));
    res.json({ ok: true });
  });

  app.get('/api/auth/session', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      const bearerToken =
        authHeader && authHeader.startsWith('Bearer ')
          ? authHeader.slice('Bearer '.length).trim()
          : null;

      const cookieHeader = req.headers.cookie || '';
      let cookieToken: string | null = null;
      for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const k = part.slice(0, idx).trim();
        if (k === ISOLATED_COOKIE_NAME) {
          cookieToken = decodeURIComponent(part.slice(idx + 1).trim());
        }
      }

      const token = bearerToken || cookieToken;
      if (!token) {
        return res.json({ authenticated: false, user: null });
      }

      const { getOrCreateUser } = await import('./src/db/users.ts');

      if (token.startsWith('iso.') || token.startsWith('ses.')) {
        const verified = verifySignedSessionToken(token);
        if (!verified) {
          return res.json({ authenticated: false, user: null });
        }
        await getOrCreateUser(verified.uid, verified.email);
        return res.json({
          authenticated: true,
          user: verified,
        });
      }

      const { adminAuth } = await import('./src/lib/firebase-admin.ts');
      const decoded = await adminAuth.verifyIdToken(token);
      const email = decoded.email || `${decoded.uid}@authenticated.user`;
      await getOrCreateUser(decoded.uid, email);
      return res.json({
        authenticated: true,
        user: {
          uid: decoded.uid,
          email,
          authMode: 'google',
        },
      });
    } catch {
      return res.json({ authenticated: false, user: null });
    }
  });

  app.get('/api/auth/me', requireAuth, async (req: AuthRequest, res) => {
    res.json({ user: req.authUser });
  });

  // --- WORKSPACES ---
  app.get('/api/workspaces', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaces = await listWorkspacesByUser(req.authUser!.uid);
      res.json({ workspaces });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to load workspaces.';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/workspaces', requireAuth, async (req: AuthRequest, res) => {
    try {
      const name =
        typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name || name.length > 60) {
        return res.status(400).json({
          error: 'Workspace name is required (1–60 characters).',
        });
      }
      const workspace = await createWorkspaceForUser({
        userId: req.authUser!.uid,
        name,
      });
      res.status(201).json({ workspace });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to create workspace.';
      res.status(500).json({ error: msg });
    }
  });

  // --- GOALS ---
  app.get('/api/goals', requireAuth, async (req: AuthRequest, res) => {
    try {
      await ensureDefaultWorkspaceForUser(req.authUser!.uid);
      const workspaceId =
        typeof req.query.workspaceId === 'string' &&
        req.query.workspaceId.trim()
          ? req.query.workspaceId.trim()
          : undefined;

      if (workspaceId) {
        const owned = await getWorkspaceByIdForUser(
          workspaceId,
          req.authUser!.uid
        );
        if (!owned) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }
      }

      const goals = await listGoalsByUser(req.authUser!.uid, workspaceId);
      res.json({ goals });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to load goals.';
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/goals/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const goal = await getGoalByIdForUser(req.params.id, req.authUser!.uid);
      if (!goal) {
        return res.status(404).json({ error: 'Goal not found.' });
      }
      res.json({ goal });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to load goal.';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/goals', requireAuth, async (req: AuthRequest, res) => {
    try {
      const rawDesc =
        typeof req.body?.problem === 'string' && req.body.problem.trim()
          ? req.body.problem.trim()
          : typeof req.body?.description === 'string'
            ? req.body.description.trim()
            : '';
      const targetMetric =
        typeof req.body?.targetMetric === 'string'
          ? req.body.targetMetric.trim()
          : '';
      const rawStatus =
        typeof req.body?.status === 'string' ? req.body.status.trim() : 'draft';
      const deadlineCheck = parseOptionalDeadline(req.body?.deadline);

      if (!rawDesc) {
        return res.status(400).json({
          error: 'Please enter a goal description / problem to solve.',
        });
      }
      if (!targetMetric) {
        return res.status(400).json({
          error: 'Please specify a measurable desired target metric.',
        });
      }
      if (!VALID_GOAL_STATUSES.has(rawStatus)) {
        return res.status(400).json({ error: 'Invalid goal status.' });
      }
      if (rawStatus === 'completed') {
        return res.status(400).json({
          error:
            'New goals cannot start as completed without verified outcome evidence.',
        });
      }
      if (!deadlineCheck.valid) {
        return res.status(400).json({ error: deadlineCheck.error });
      }

      const workspaceId = await resolveTargetWorkspaceId(
        req.authUser!.uid,
        req.body?.workspaceId
      );
      if (!workspaceId) {
        return res.status(404).json({ error: 'Workspace not found.' });
      }

      const goal = await createGoalForUser({
        userId: req.authUser!.uid,
        workspaceId,
        problem: rawDesc,
        targetMetric,
        deadline: deadlineCheck.date ?? null,
        status: rawStatus as GoalStatus,
      });

      await ensureGoalMetricsInitialized({
        userId: req.authUser!.uid,
        workspaceId,
        goal,
      });

      res.status(201).json({ goal });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to create goal.';
      res.status(500).json({ error: msg });
    }
  });

  app.patch('/api/goals/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const existing = await getGoalByIdForUser(
        req.params.id,
        req.authUser!.uid
      );
      if (!existing) {
        return res.status(404).json({ error: 'Goal not found.' });
      }

      const rawProblem =
        typeof req.body?.problem === 'string'
          ? req.body.problem.trim()
          : typeof req.body?.description === 'string'
            ? req.body.description.trim()
            : undefined;
      const targetMetric =
        typeof req.body?.targetMetric === 'string'
          ? req.body.targetMetric.trim()
          : undefined;
      const status =
        typeof req.body?.status === 'string'
          ? req.body.status.trim()
          : undefined;
      const deadlineCheck = parseOptionalDeadline(req.body?.deadline);

      if (rawProblem !== undefined && !rawProblem) {
        return res
          .status(400)
          .json({ error: 'Goal description cannot be empty.' });
      }
      if (targetMetric !== undefined && !targetMetric) {
        return res
          .status(400)
          .json({ error: 'Target metric cannot be empty.' });
      }
      if (status !== undefined && !VALID_GOAL_STATUSES.has(status)) {
        return res.status(400).json({ error: 'Invalid goal status value.' });
      }
      if (!deadlineCheck.valid) {
        return res.status(400).json({ error: deadlineCheck.error });
      }

      if (status === 'completed') {
        const progressCheck = await recalculateAndPersistGoalProgress({
          userId: req.authUser!.uid,
          goalId: existing.id,
        });
        if (!progressCheck.isGoalAchieved) {
          return res.status(400).json({
            error:
              'Goal can only be marked completed when primary target metrics are satisfied by verified outcomes.',
          });
        }
      }

      const updated = await updateGoalForUser({
        goalId: req.params.id,
        userId: req.authUser!.uid,
        problem: rawProblem,
        targetMetric,
        deadline: deadlineCheck.date,
        status: status as GoalStatus | undefined,
      });

      if (!updated) {
        return res.status(404).json({ error: 'Goal not found.' });
      }

      if (targetMetric !== undefined) {
        const synced = await recalculateAndPersistGoalProgress({
          userId: req.authUser!.uid,
          goalId: updated.id,
        });
        return res.json({ goal: synced.goal ?? updated });
      }

      res.json({ goal: updated });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to update goal.';
      res.status(500).json({ error: msg });
    }
  });

  // --- AI PLANNER ---
  app.post(
    '/api/goals/:id/plan',
    requireAuth,
    aiOperationRateLimiter,
    async (req: AuthRequest, res) => {
      try {
        const goal = await getGoalByIdForUser(req.params.id, req.authUser!.uid);
        if (!goal) {
          return res.status(404).json({ error: 'Goal not found.' });
        }

        const wsId =
          goal.workspaceId ??
          (await ensureDefaultWorkspaceForUser(req.authUser!.uid)).id;
        const workspaceIntegrations = await listIntegrationsByUser(
          req.authUser!.uid,
          wsId
        );

        // Pass ONLY sanitized capability names and provider enum — never secrets or URLs!
        const availableCapabilities = collectVerifiedWorkspaceCapabilities(
          workspaceIntegrations
        );
        const verifiedExternal = workspaceIntegrations.find(
          (i) => i.enabled && i.verified
        );

        const plannedTasks = await generateValidatedPlanWithGemini({
          goalId: goal.id,
          problem: goal.problem,
          targetMetric: goal.targetMetric,
          deadline: goal.deadline,
          availableCapabilities,
          preferredExternalProvider: verifiedExternal?.providerKey ?? null,
        });

        const saved = await savePlannedTasksForGoal({
          userId: req.authUser!.uid,
          goalId: goal.id,
          plannedTasks,
        });

        await ensureGoalMetricsInitialized({
          userId: req.authUser!.uid,
          workspaceId: wsId,
          goal: saved.goal,
        });

        res.status(201).json({
          goal: saved.goal,
          tasks: saved.tasks,
          message: `Saved ${saved.tasks.length} capability-routed tasks. Tasks are queued and will NOT execute automatically until the goal is active and required approvals are granted.`,
        });
      } catch (error: unknown) {
        console.error('AI Planner error:', error);
        const msg =
          error instanceof Error ? error.message : 'AI Planner failed.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // --- TASKS & DIAGNOSTIC TASK CREATION ---
  app.get('/api/tasks', requireAuth, async (req: AuthRequest, res) => {
    try {
      const goalId =
        typeof req.query.goalId === 'string' && req.query.goalId.trim()
          ? req.query.goalId.trim()
          : undefined;
      const workspaceId =
        typeof req.query.workspaceId === 'string' &&
        req.query.workspaceId.trim()
          ? req.query.workspaceId.trim()
          : undefined;

      const tasks = await listTasksByUser(
        req.authUser!.uid,
        goalId,
        workspaceId
      );
      res.json({ tasks });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to load tasks.';
      res.status(500).json({ error: msg });
    }
  });

  app.post(
    '/api/goals/:id/tasks',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const goal = await getGoalByIdForUser(req.params.id, req.authUser!.uid);
        if (!goal) {
          return res.status(404).json({ error: 'Goal not found.' });
        }

        const description =
          typeof req.body?.description === 'string'
            ? req.body.description.trim()
            : '';
        if (!description) {
          return res
            .status(400)
            .json({ error: 'Task description is required.' });
        }

        const tool = normalizeToolId(req.body?.tool ?? 'internal_test_tool');
        const actionCategory = normalizeActionCategory(
          req.body?.actionCategory,
          tool
        );
        const requiredCapabilities = normalizeCapabilities(
          req.body?.requiredCapabilities,
          tool,
          actionCategory
        );
        const dependencies = Array.isArray(req.body?.dependencies)
          ? req.body.dependencies.filter(
              (d: unknown): d is string =>
                typeof d === 'string' && d.trim().length > 0
            )
          : [];

        const assignedIntegrationId =
          typeof req.body?.assignedIntegrationId === 'string' &&
          req.body.assignedIntegrationId.trim()
            ? req.body.assignedIntegrationId.trim()
            : null;

        const approvalRequired = detectRequiresApproval({
          tool,
          actionCategory,
          description,
          requiredCapabilities,
          llmFlaggedApproval: Boolean(req.body?.approvalRequired),
        });

        const expectedResult =
          typeof req.body?.expectedResult === 'string' &&
          req.body.expectedResult.trim()
            ? req.body.expectedResult.trim()
            : 'Deterministic SHA-256 verification digest recorded in action log.';
        const verificationMethod =
          typeof req.body?.verificationMethod === 'string' &&
          req.body.verificationMethod.trim()
            ? req.body.verificationMethod.trim()
            : 'Independent server-side SHA-256 checksum comparison.';

        const proposedActionDetails: ProposedActionDetails | null =
          approvalRequired
            ? {
                proposedAction:
                  typeof req.body?.proposedAction === 'string' &&
                  req.body.proposedAction.trim()
                    ? req.body.proposedAction.trim()
                    : description,
                targetRecipient:
                  typeof req.body?.targetRecipient === 'string' &&
                  req.body.targetRecipient.trim()
                    ? req.body.targetRecipient.trim()
                    : 'Configured workspace target',
                estimatedCost:
                  typeof req.body?.estimatedCost === 'string' &&
                  req.body.estimatedCost.trim()
                    ? req.body.estimatedCost.trim()
                    : '$0.00',
                explanation:
                  typeof req.body?.explanation === 'string' &&
                  req.body.explanation.trim()
                    ? req.body.explanation.trim()
                    : 'Requires explicit human approval before the Execution Router dispatches this task.',
              }
            : null;

        const maxRetries =
          typeof req.body?.maxRetries === 'number' &&
          Number.isFinite(req.body.maxRetries)
            ? Math.max(0, Math.min(10, Math.floor(req.body.maxRetries)))
            : undefined;
        const backoffBaseMs =
          typeof req.body?.backoffBaseMs === 'number' &&
          Number.isFinite(req.body.backoffBaseMs)
            ? Math.max(100, Math.floor(req.body.backoffBaseMs))
            : undefined;
        const executionTimeoutMs =
          typeof req.body?.executionTimeoutMs === 'number' &&
          Number.isFinite(req.body.executionTimeoutMs)
            ? Math.max(500, Math.floor(req.body.executionTimeoutMs))
            : undefined;

        const created = await createSingleTaskForGoal({
          userId: req.authUser!.uid,
          goalId: goal.id,
          description,
          tool,
          requiredCapabilities,
          assignedIntegrationId,
          actionCategory,
          dependencies,
          approvalRequired,
          proposedActionDetails,
          expectedResult,
          verificationMethod,
          maxRetries,
          backoffBaseMs,
          executionTimeoutMs,
        });

        res.status(201).json({ task: created });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Failed to create task.';
        res.status(400).json({ error: msg });
      }
    }
  );

  // --- APPROVAL GATE ---
  app.post(
    '/api/tasks/:id/approval',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const decision = req.body?.decision;
        if (decision !== 'approved' && decision !== 'rejected') {
          return res.status(400).json({
            error: 'Decision must be explicitly "approved" or "rejected".',
          });
        }

        const updated = await recordApprovalDecision({
          userId: req.authUser!.uid,
          taskId: req.params.id,
          decision,
        });

        if (!updated) {
          return res.status(404).json({ error: 'Task not found.' });
        }
        res.json({ task: updated });
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : 'Failed to record approval decision.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // --- SAFE TASK RETRY / REQUEUE & UNCERTAIN TASK RECONCILIATION ---
  app.post(
    '/api/tasks/:id/requeue',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const updated = await retryTaskManually({
          taskId: req.params.id,
          userId: req.authUser!.uid,
          confirmExternalNotExecuted: Boolean(
            req.body?.confirmExternalNotExecuted
          ),
        });
        if (!updated) {
          return res.status(404).json({ error: 'Task not found.' });
        }
        res.json({ task: updated });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Failed to requeue task.';
        const status = msg.includes('Uncertain execution outcome') ? 409 : 500;
        res.status(status).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/tasks/:id/retry',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const updated = await retryTaskManually({
          taskId: req.params.id,
          userId: req.authUser!.uid,
          confirmExternalNotExecuted: Boolean(
            req.body?.confirmExternalNotExecuted
          ),
        });
        if (!updated) {
          return res.status(404).json({ error: 'Task not found.' });
        }
        res.json({ task: updated });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Failed to retry task.';
        const status = msg.includes('Uncertain execution outcome') ? 409 : 500;
        res.status(status).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/tasks/:id/reconcile',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const resolution = req.body?.resolution;
        if (
          resolution !== 'reconcile_from_evidence' &&
          resolution !== 'mark_dispatched_pending_verification' &&
          resolution !== 'confirm_not_executed_requeue'
        ) {
          return res.status(400).json({
            error:
              'Resolution must be "reconcile_from_evidence", "mark_dispatched_pending_verification", or "confirm_not_executed_requeue".',
          });
        }

        const notes =
          typeof req.body?.notes === 'string'
            ? req.body.notes.trim().slice(0, 500)
            : undefined;

        const reconciled = await reconcileUncertainTask({
          userId: req.authUser!.uid,
          taskId: req.params.id,
          resolution,
          notes,
        });
        res.json(reconciled);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to reconcile task.';
        const status = msg.includes('not found') ? 404 : 400;
        res.status(status).json({ error: msg });
      }
    }
  );

  // --- SERVER-SIDE WORKER & EXECUTION ROUTER ---
  app.post(
    '/api/tasks/:id/execute',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const result = await runWorkerOnSpecificTask({
          userId: req.authUser!.uid,
          taskId: req.params.id,
        });
        if (result.outcomeCode === 'not_found') {
          return res.status(404).json({ error: result.message });
        }
        res.json(result);
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Worker execution failed.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/worker/run-next',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const goalId =
          typeof req.body?.goalId === 'string' && req.body.goalId.trim()
            ? req.body.goalId.trim()
            : undefined;
        const workspaceId =
          typeof req.body?.workspaceId === 'string' &&
          req.body.workspaceId.trim()
            ? req.body.workspaceId.trim()
            : undefined;

        const result = await runWorkerQueueNext({
          userId: req.authUser!.uid,
          goalId,
          workspaceId,
        });
        res.json(result);
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Queue worker failed.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // --- MILESTONE 2: EXECUTION ORCHESTRATOR & MONITOR ---
  app.get(
    '/api/execution-monitor',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const workspaceId = await resolveTargetWorkspaceId(
          req.authUser!.uid,
          req.query.workspaceId
        );
        if (!workspaceId) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const workspaceIntegrations = await listIntegrationsByUser(
          req.authUser!.uid,
          workspaceId
        );
        const tools = buildWorkspaceToolRegistry(workspaceIntegrations);
        const snapshot = await getExecutionMonitorSnapshot({
          userId: req.authUser!.uid,
          workspaceId,
          tools,
        });

        res.json({ snapshot });
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to load execution monitor snapshot.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/goals/:id/orchestrate',
    requireAuth,
    aiOperationRateLimiter,
    async (req: AuthRequest, res) => {
      try {
        const goal = await getGoalByIdForUser(req.params.id, req.authUser!.uid);
        if (!goal) {
          return res.status(404).json({ error: 'Goal not found.' });
        }

        const concurrencyMode =
          req.body?.concurrencyMode === 'sequential'
            ? 'sequential'
            : 'parallel_safe';
        const autoRunReasoning = Boolean(req.body?.autoRunReasoning);

        const result = await runOrchestratorCycle({
          userId: req.authUser!.uid,
          goalId: goal.id,
          concurrencyMode,
          triggerType: autoRunReasoning ? 'continuous_cycle' : 'manual_cycle',
          autoRunReasoning,
        });

        res.json(result);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Execution orchestrator cycle failed.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/goals/:id/execution-control',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const action = req.body?.action;
        if (
          action !== 'pause' &&
          action !== 'resume' &&
          action !== 'cancel'
        ) {
          return res.status(400).json({
            error: 'Control action must be "pause", "resume", or "cancel".',
          });
        }

        const updated = await controlGoalExecution({
          userId: req.authUser!.uid,
          goalId: req.params.id,
          action,
        });
        if (!updated) {
          return res.status(404).json({ error: 'Goal not found.' });
        }

        res.json({ goal: updated });
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : 'Failed to update goal execution state.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // --- MILESTONE 2: INBOUND EVIDENCE WEBHOOKS & OUTCOME VERIFICATION ---
  app.get(
    '/api/workspaces/:workspaceId/inbound-webhook',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const owned = await getWorkspaceByIdForUser(
          req.params.workspaceId,
          req.authUser!.uid
        );
        if (!owned) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const config = await getWorkspaceInboundWebhookPublicConfig({
          userId: req.authUser!.uid,
          workspaceId: owned.id,
        });
        res.json({ config });
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to load inbound webhook configuration.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/workspaces/:workspaceId/inbound-webhook/rotate',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const owned = await getWorkspaceByIdForUser(
          req.params.workspaceId,
          req.authUser!.uid
        );
        if (!owned) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const rotated = await rotateWorkspaceInboundWebhookSecret({
          userId: req.authUser!.uid,
          workspaceId: owned.id,
        });
        res.status(201).json(rotated);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to rotate inbound webhook signing secret.';
        res.status(400).json({ error: msg });
      }
    }
  );

  // Public HMAC-SHA256 verified inbound webhook receiver (replay-guarded, rate-limited & workspace-isolated)
  app.post(
    '/api/webhooks/inbound/:workspaceId',
    inboundWebhookRateLimiter,
    async (req, res) => {
      try {
        const rawBody = (req as express.Request & { rawBody?: string }).rawBody;
        if (typeof rawBody !== 'string' || rawBody.length === 0) {
          return res.status(400).json({
            error:
              'Inbound webhook requires a raw UTF-8 JSON body with Content-Type: application/json.',
          });
        }
        if (Buffer.byteLength(rawBody, 'utf8') > 131_072) {
          return res.status(413).json({
            error: 'Inbound webhook payload exceeds 128KB maximum size.',
          });
        }

        const outcome = await ingestSignedInboundEvidence({
          workspaceId: req.params.workspaceId,
          rawBody,
          parsedBody: req.body,
          signatureHeader: req.header('x-taskai-signature') ?? undefined,
          providerSignatureHeader:
            req.header(INBOUND_PROVIDER_SIGNATURE_HEADER) ?? undefined,
          timestampHeader: req.header('x-taskai-timestamp') ?? undefined,
        });

        res.status(outcome.httpStatus).json(outcome.body);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to process inbound evidence webhook.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // Authenticated manual evidence submission (always flagged for human review; never auto-verified)
  app.post(
    '/api/workspaces/:workspaceId/evidence',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const owned = await getWorkspaceByIdForUser(
          req.params.workspaceId,
          req.authUser!.uid
        );
        if (!owned) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const goalId =
          typeof req.body?.goalId === 'string' ? req.body.goalId.trim() : '';
        if (!goalId) {
          return res
            .status(400)
            .json({ error: 'Goal selection (goalId) is required.' });
        }

        const evidenceTypeRaw =
          typeof req.body?.evidenceType === 'string'
            ? req.body.evidenceType.trim()
            : '';
        if (
          !VALID_EVIDENCE_TYPES.has(evidenceTypeRaw as EvidenceType) ||
          evidenceTypeRaw === 'diagnostic_checksum'
        ) {
          return res.status(400).json({ error: 'Invalid evidence type.' });
        }

        const summary =
          typeof req.body?.summary === 'string' ? req.body.summary.trim() : '';
        if (!summary) {
          return res
            .status(400)
            .json({ error: 'Evidence summary is required.' });
        }

        const taskId =
          typeof req.body?.taskId === 'string' && req.body.taskId.trim()
            ? req.body.taskId.trim()
            : null;
        const provider =
          typeof req.body?.provider === 'string' && req.body.provider.trim()
            ? req.body.provider.trim()
            : 'manual_workspace_entry';
        const externalReferenceId =
          typeof req.body?.externalReferenceId === 'string' &&
          req.body.externalReferenceId.trim()
            ? req.body.externalReferenceId.trim()
            : null;
        const structuredMetrics =
          req.body?.structuredMetrics &&
          typeof req.body.structuredMetrics === 'object' &&
          !Array.isArray(req.body.structuredMetrics)
            ? (req.body.structuredMetrics as Record<string, unknown>)
            : {};

        const result = await submitManualWorkspaceEvidence({
          userId: req.authUser!.uid,
          workspaceId: owned.id,
          goalId,
          taskId,
          provider,
          evidenceType: evidenceTypeRaw as EvidenceType,
          summary,
          externalReferenceId,
          structuredMetrics,
        });

        res.status(201).json(result);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to submit outcome evidence.';
        res.status(400).json({ error: msg });
      }
    }
  );

  // Human Verification Review
  app.post(
    '/api/evidence/:id/review',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const decision = req.body?.decision;
        if (decision !== 'verified' && decision !== 'rejected') {
          return res.status(400).json({
            error: 'Verification decision must be "verified" or "rejected".',
          });
        }
        const notes =
          typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
        if (notes.length < 3) {
          return res.status(400).json({
            error:
              'Reviewer notes (minimum 3 characters) are required to verify or reject evidence.',
          });
        }

        const reviewed = await reviewOutcomeEvidenceByHuman({
          userId: req.authUser!.uid,
          evidenceId: req.params.id,
          reviewerEmail: req.authUser!.email,
          decision,
          notes,
        });
        res.json(reviewed);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to record human verification decision.';
        const status = msg.includes('not found') ? 404 : 400;
        res.status(status).json({ error: msg });
      }
    }
  );

  // AI-Assisted Evidence Consistency Check (Advisory Only)
  app.post(
    '/api/evidence/:id/ai-verify',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const result = await runAiAssistedVerificationOnEvidence({
          userId: req.authUser!.uid,
          evidenceId: req.params.id,
        });
        res.json(result);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'AI consistency review failed.';
        const status = msg.includes('not found') ? 404 : 500;
        res.status(status).json({ error: msg });
      }
    }
  );

  // --- MILESTONE 2: CONTINUOUS AI REASONING & NEXT-ACTION PROPOSALS ---
  app.post(
    '/api/goals/:id/reasoning',
    requireAuth,
    aiOperationRateLimiter,
    async (req: AuthRequest, res) => {
      try {
        const goal = await getGoalByIdForUser(req.params.id, req.authUser!.uid);
        if (!goal) {
          return res.status(404).json({ error: 'Goal not found.' });
        }

        const result = await runContinuousReasoningForGoal({
          userId: req.authUser!.uid,
          goalId: goal.id,
          triggerSource: 'manual',
        });
        res.status(201).json(result);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Continuous AI reasoning failed.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/proposals/:id/decision',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const decision = req.body?.decision;
        if (decision !== 'accept' && decision !== 'reject') {
          return res.status(400).json({
            error: 'Proposal decision must be "accept" or "reject".',
          });
        }

        const decided = await decideNextActionProposal({
          userId: req.authUser!.uid,
          proposalId: req.params.id,
          decision,
        });
        res.json(decided);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to decide next-action proposal.';
        const status = msg.includes('not found')
          ? 404
          : msg.includes('already')
            ? 409
            : 400;
        res.status(status).json({ error: msg });
      }
    }
  );

  // --- ACTION LOGS ---
  app.get('/api/action-logs', requireAuth, async (req: AuthRequest, res) => {
    try {
      const goalId =
        typeof req.query.goalId === 'string' && req.query.goalId.trim()
          ? req.query.goalId.trim()
          : undefined;
      const workspaceId =
        typeof req.query.workspaceId === 'string' &&
        req.query.workspaceId.trim()
          ? req.query.workspaceId.trim()
          : undefined;

      const logs = await listActionLogsByUser(
        req.authUser!.uid,
        goalId,
        workspaceId
      );
      res.json({ logs });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to load action logs.';
      res.status(500).json({ error: msg });
    }
  });

  // --- RESULTS REPORT ---
  app.get('/api/results-report', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = await resolveTargetWorkspaceId(
        req.authUser!.uid,
        req.query.workspaceId
      );
      if (!workspaceId) {
        return res.status(404).json({ error: 'Workspace not found.' });
      }

      const [
        goals,
        tasks,
        actionLogs,
        workspaceIntegrations,
        outcomeEvidence,
        goalMetrics,
      ] = await Promise.all([
        listGoalsByUser(req.authUser!.uid, workspaceId),
        listTasksByUser(req.authUser!.uid, undefined, workspaceId),
        listActionLogsByUser(req.authUser!.uid, undefined, workspaceId),
        listIntegrationsByUser(req.authUser!.uid, workspaceId),
        listOutcomeEvidenceByWorkspace({
          userId: req.authUser!.uid,
          workspaceId,
        }),
        listGoalMetricsByWorkspace({
          userId: req.authUser!.uid,
          workspaceId,
        }),
      ]);

      const tools = buildWorkspaceToolRegistry(workspaceIntegrations);
      const report = computeResultsReport({
        goals,
        tasks,
        actionLogs,
        tools,
        outcomeEvidence,
        goalMetrics,
      });
      res.json({ report });
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : 'Failed to generate results report.';
      res.status(500).json({ error: msg });
    }
  });

  // --- MULTI-USER INTEGRATION MANAGER & UNIFIED REGISTRY ---
  app.get('/api/integrations', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = await resolveTargetWorkspaceId(
        req.authUser!.uid,
        req.query.workspaceId
      );
      if (!workspaceId) {
        return res.status(404).json({ error: 'Workspace not found.' });
      }

      const liveGoogleToken = (
        req.header('x-google-access-token') || ''
      ).trim();

      const bundle = await buildEnrichedWorkspaceIntegrationBundle({
        userId: req.authUser!.uid,
        workspaceId,
        hasLiveGoogleToken: Boolean(liveGoogleToken),
      });

      const tools = buildWorkspaceToolRegistry(bundle.integrations);
      const platformCapabilities = getPlatformCapabilities(
        req.authUser!.email
      );

      res.json({
        workspaceId,
        tools,
        platformCapabilities,
        ...bundle,
      });
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? redactSecretsFromText(error.message)
          : 'Failed to load workspace integrations.';
      res.status(500).json({ error: msg });
    }
  });

  // Sanitized server environment configuration diagnostics (never exposes secret values)
  app.get(
    '/api/config/environment',
    requireAuth,
    async (_req: AuthRequest, res) => {
      try {
        const diagnostics = getPublicEnvironmentDiagnostics();
        res.json(diagnostics);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to inspect environment configuration.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // Safe key-rotation endpoint: re-encrypts caller's stored credentials under current INTEGRATION_ENCRYPTION_KEY
  app.post(
    '/api/integrations/rotate-keys',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const workspaceId = await resolveTargetWorkspaceId(
          req.authUser!.uid,
          req.body?.workspaceId
        );
        if (!workspaceId) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }
        const summary = await rotateUserIntegrationSecrets({
          userId: req.authUser!.uid,
          workspaceId,
        });
        res.json(summary);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? redactSecretsFromText(error.message)
            : 'Failed to rotate stored integration credentials.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.post('/api/integrations', requireAuth, async (req: AuthRequest, res) => {
    try {
      const workspaceId = await resolveTargetWorkspaceId(
        req.authUser!.uid,
        req.body?.workspaceId
      );
      if (!workspaceId) {
        return res.status(404).json({ error: 'Workspace not found.' });
      }

      const providerKeyRaw =
        typeof req.body?.providerKey === 'string'
          ? req.body.providerKey.trim()
          : '';
      if (!VALID_PROVIDER_KEYS.has(providerKeyRaw)) {
        return res.status(400).json({
          error: `Unsupported provider key "${providerKeyRaw}".`,
        });
      }
      const providerKey = providerKeyRaw as IntegrationProviderKey;

      const displayName =
        typeof req.body?.displayName === 'string'
          ? req.body.displayName.trim()
          : '';
      if (!displayName || displayName.length > 80) {
        return res.status(400).json({
          error: 'Integration display name is required (1–80 characters).',
        });
      }

      const connectionModeRaw =
        typeof req.body?.connectionMode === 'string'
          ? req.body.connectionMode.trim()
          : 'user_owned';
      if (
        connectionModeRaw !== 'user_owned' &&
        connectionModeRaw !== 'platform_shared'
      ) {
        return res.status(400).json({ error: 'Invalid connection mode.' });
      }
      const connectionMode = connectionModeRaw as IntegrationConnectionMode;

      const authTypeRaw =
        typeof req.body?.authType === 'string'
          ? req.body.authType.trim()
          : 'none';
      if (!VALID_AUTH_TYPES.has(authTypeRaw)) {
        return res.status(400).json({ error: 'Invalid authentication type.' });
      }
      const authType = authTypeRaw as IntegrationAuthType;

      const plaintextSecret =
        typeof req.body?.secret === 'string' ? req.body.secret.trim() : '';
      if (authType !== 'none' && !plaintextSecret) {
        return res.status(400).json({
          error: `Please provide the secret / credential for "${authType}" authentication.`,
        });
      }

      const rawCaps = Array.isArray(req.body?.capabilities)
        ? req.body.capabilities.filter(
            (c: unknown): c is CapabilityId =>
              typeof c === 'string' && VALID_CAPABILITIES.has(c.trim())
          )
        : [];
      const capabilities: CapabilityId[] =
        rawCaps.length > 0
          ? rawCaps
          : ['workflow_automation', 'http_request'];

      const workflowId =
        typeof req.body?.workflowId === 'string' && req.body.workflowId.trim()
          ? req.body.workflowId.trim()
          : undefined;
      const secretHeaderName =
        typeof req.body?.secretHeaderName === 'string' &&
        /^[a-zA-Z0-9-]+$/.test(req.body.secretHeaderName.trim())
          ? req.body.secretHeaderName.trim()
          : 'X-TaskAI-Webhook-Secret';

      let configMetadata: IntegrationPublicMetadata;

      if (connectionMode === 'platform_shared') {
        if (providerKey !== 'n8n_webhook') {
          return res.status(400).json({
            error:
              'Platform-shared connection mode is only supported for n8n workflows.',
          });
        }
        const sharedEnv = resolveOptionalSharedN8nConfig();
        const platform = getPlatformCapabilities(req.authUser!.email);
        if (!platform.sharedN8nAvailable) {
          return res.status(400).json({
            error:
              sharedEnv.configurationIssue ||
              'Platform-shared n8n instance is not configured by the platform administrator (requires valid PLATFORM_SHARED_N8N_BASE_URL and PLATFORM_SHARED_N8N_SIGNING_SECRET). Use "user_owned" mode to connect your own instance.',
          });
        }
        if (sharedEnv.adminEmails.length > 0 && !platform.isPlatformAdmin) {
          return res.status(403).json({
            error:
              'Only listed platform administrators (PLATFORM_ADMIN_EMAILS) can bind platform-shared n8n workflows. Use "user_owned" mode for workspace-owned webhooks.',
          });
        }
        const webhookPath =
          typeof req.body?.webhookPath === 'string'
            ? req.body.webhookPath.trim().replace(/^\/+/, '')
            : '';
        if (!webhookPath || !SAFE_WEBHOOK_PATH_REGEX.test(webhookPath)) {
          return res.status(400).json({
            error:
              'Shared n8n mode requires a valid isolated webhook path (alphanumeric, hyphens, slashes).',
          });
        }
        if (!workflowId) {
          return res.status(400).json({
            error:
              'Shared n8n mode requires an isolated workflow ID to prevent cross-workflow ambiguity.',
          });
        }
        configMetadata = {
          destinationOrigin: platform.sharedN8nOrigin ?? undefined,
          webhookPath,
          workflowId,
          authType,
          secretHeaderName:
            authType === 'header_secret' ? secretHeaderName : undefined,
        };
      } else {
        const endpointUrl =
          typeof req.body?.endpointUrl === 'string'
            ? req.body.endpointUrl.trim()
            : '';
        const urlValidation = validateDestinationUrlSync(endpointUrl);
        if (!urlValidation.valid || !urlValidation.normalizedUrl) {
          return res.status(400).json({
            error:
              urlValidation.error || 'Unsafe or invalid destination URL.',
          });
        }
        configMetadata = {
          endpointUrl: urlValidation.normalizedUrl,
          destinationOrigin: urlValidation.origin,
          workflowId,
          authType,
          secretHeaderName:
            authType === 'header_secret' ? secretHeaderName : undefined,
        };
      }

      const integration = await createUserIntegration({
        userId: req.authUser!.uid,
        workspaceId,
        providerKey,
        displayName,
        connectionMode,
        capabilities,
        configMetadata,
        plaintextSecret: plaintextSecret || undefined,
      });

      const allIntegrations = await listIntegrationsByUser(
        req.authUser!.uid,
        workspaceId
      );

      res.status(201).json({
        integration,
        tools: buildWorkspaceToolRegistry(allIntegrations),
      });
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : 'Failed to create integration.';
      res.status(400).json({ error: msg });
    }
  });

  app.patch(
    '/api/integrations/:id',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const existing = await getIntegrationByIdForUser(
          req.params.id,
          req.authUser!.uid
        );
        if (!existing) {
          return res.status(404).json({ error: 'Integration not found.' });
        }

        const displayName =
          typeof req.body?.displayName === 'string'
            ? req.body.displayName.trim()
            : undefined;
        if (
          displayName !== undefined &&
          (!displayName || displayName.length > 80)
        ) {
          return res
            .status(400)
            .json({ error: 'Display name must be 1–80 characters.' });
        }

        const enabled =
          typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined;

        const capabilities = Array.isArray(req.body?.capabilities)
          ? req.body.capabilities.filter(
              (c: unknown): c is CapabilityId =>
                typeof c === 'string' && VALID_CAPABILITIES.has(c.trim())
            )
          : undefined;

        let nextMeta: IntegrationPublicMetadata | undefined = undefined;
        if (
          req.body?.endpointUrl !== undefined ||
          req.body?.workflowId !== undefined ||
          req.body?.authType !== undefined
        ) {
          const authTypeRaw =
            typeof req.body?.authType === 'string'
              ? req.body.authType.trim()
              : existing.configMetadata.authType;
          if (!VALID_AUTH_TYPES.has(authTypeRaw)) {
            return res
              .status(400)
              .json({ error: 'Invalid authentication type.' });
          }

          if (existing.connectionMode === 'user_owned') {
            const candidateUrl =
              typeof req.body?.endpointUrl === 'string'
                ? req.body.endpointUrl.trim()
                : existing.configMetadata.endpointUrl || '';
            const check = validateDestinationUrlSync(candidateUrl);
            if (!check.valid || !check.normalizedUrl) {
              return res.status(400).json({
                error: check.error || 'Unsafe destination URL.',
              });
            }
            nextMeta = {
              ...existing.configMetadata,
              endpointUrl: check.normalizedUrl,
              destinationOrigin: check.origin,
              workflowId:
                typeof req.body?.workflowId === 'string'
                  ? req.body.workflowId.trim() || undefined
                  : existing.configMetadata.workflowId,
              authType: authTypeRaw as IntegrationAuthType,
            };
          } else {
            nextMeta = {
              ...existing.configMetadata,
              workflowId:
                typeof req.body?.workflowId === 'string'
                  ? req.body.workflowId.trim() || undefined
                  : existing.configMetadata.workflowId,
              authType: authTypeRaw as IntegrationAuthType,
            };
          }
        }

        const plaintextSecret =
          typeof req.body?.secret === 'string' ? req.body.secret : undefined;

        const updated = await updateUserIntegration({
          integrationId: existing.id,
          userId: req.authUser!.uid,
          displayName,
          enabled,
          capabilities,
          configMetadata: nextMeta,
          plaintextSecret,
        });

        if (!updated) {
          return res.status(404).json({ error: 'Integration not found.' });
        }

        const allIntegrations = await listIntegrationsByUser(
          req.authUser!.uid,
          updated.workspaceId
        );

        res.json({
          integration: updated,
          tools: buildWorkspaceToolRegistry(allIntegrations),
        });
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : 'Failed to update integration.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.delete(
    '/api/integrations/:id',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const existing = await getIntegrationByIdForUser(
          req.params.id,
          req.authUser!.uid
        );
        if (!existing) {
          return res.status(404).json({ error: 'Integration not found.' });
        }

        await deleteUserIntegration(existing.id, req.authUser!.uid);
        const remaining = await listIntegrationsByUser(
          req.authUser!.uid,
          existing.workspaceId
        );

        res.json({
          deleted: true,
          tools: buildWorkspaceToolRegistry(remaining),
        });
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : 'Failed to delete integration.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/integrations/:id/test',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const existing = await getIntegrationByIdForUser(
          req.params.id,
          req.authUser!.uid
        );
        if (!existing) {
          return res.status(404).json({ error: 'Integration not found.' });
        }

        const liveGoogleToken = (
          req.header('x-google-access-token') || ''
        ).trim();

        const outcome = await testUserIntegrationConnection({
          userId: req.authUser!.uid,
          integrationId: existing.id,
          googleAccessToken: liveGoogleToken || null,
        });

        const workspaceIntegrations = await listIntegrationsByUser(
          req.authUser!.uid,
          existing.workspaceId
        );

        res.json({
          ...outcome,
          tools: buildWorkspaceToolRegistry(workspaceIntegrations),
        });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Connection test failed.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // Backwards-compatible workspace n8n test endpoint (never reads a global URL; checks caller's workspace only)
  app.post(
    '/api/integrations/n8n/test',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const workspaceId = await resolveTargetWorkspaceId(
          req.authUser!.uid,
          req.body?.workspaceId
        );
        if (!workspaceId) {
          return res.status(404).json({ error: 'Workspace not found.' });
        }

        const workspaceIntegrations = await listIntegrationsByUser(
          req.authUser!.uid,
          workspaceId
        );
        const targetN8n = workspaceIntegrations.find(
          (i) => i.providerKey === 'n8n_webhook' && i.enabled
        );

        if (!targetN8n) {
          return res.json({
            success: false,
            statusDetail:
              'No n8n integration is configured for your workspace. Add a per-workspace n8n workflow or Custom HTTPS Webhook in Integrations.',
            httpStatus: null,
            testedAt: new Date().toISOString(),
            tools: buildWorkspaceToolRegistry(workspaceIntegrations),
          });
        }

        const outcome = await testUserIntegrationConnection({
          userId: req.authUser!.uid,
          integrationId: targetN8n.id,
        });
        const refreshed = await listIntegrationsByUser(
          req.authUser!.uid,
          workspaceId
        );
        res.json({
          ...outcome,
          tools: buildWorkspaceToolRegistry(refreshed),
        });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Connection test failed.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // --- MULTI-CONNECTOR INTEGRATION ARCHITECTURE & WORKFORCE MANAGER ---
  registerMultiConnectorRoutes(app, aiOperationRateLimiter);

  // --- CONVERSATIONAL AI, STREAMING EXECUTION & ARTIFACTS ---
  registerChatAndArtifactRoutes(app, aiOperationRateLimiter);

  // Vite middleware in development; static bundle in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Task.ai server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err: unknown) => {
  const safeMsg =
    err instanceof Error
      ? redactSecretsFromText(err.message)
      : 'Fatal server startup configuration error.';
  console.error(`[Task.ai Startup Aborted] ${safeMsg}`);
  process.exit(1);
});
