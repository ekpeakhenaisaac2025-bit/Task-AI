import crypto from 'node:crypto';
import { and, asc, desc, eq, gt, ilike, inArray, or } from 'drizzle-orm';
import { db } from './index.ts';
import {
  conversationArtifacts,
  conversationMessages,
  conversations,
} from './schema.ts';
import { normalizeChatModel } from '../lib/chat-utils.ts';
import type {
  ArtifactType,
  ChatAttachmentRecord,
  ChatExecutionTrace,
  ChatModelId,
  ConversationArtifactRecord,
  ConversationMessageRecord,
  ConversationRecord,
} from '../types.ts';

function mapConversationRow(
  row: typeof conversations.$inferSelect,
  messagePreview?: string | null
): ConversationRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    goalId: row.goalId ?? null,
    title: row.title,
    model: normalizeChatModel(row.model),
    archived: row.archived,
    pinned: row.pinned,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(messagePreview !== undefined ? { messagePreview } : {}),
  };
}

function mapMessageRow(
  row: typeof conversationMessages.$inferSelect
): ConversationMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    model: row.model ?? null,
    status:
      row.status === 'streaming' ||
      row.status === 'stopped' ||
      row.status === 'error'
        ? row.status
        : 'completed',
    attachments: Array.isArray(row.attachmentsJson) ? row.attachmentsJson : [],
    executionTrace: row.executionTraceJson ?? null,
    artifactIds: Array.isArray(row.artifactIdsJson) ? row.artifactIdsJson : [],
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapArtifactRow(
  row: typeof conversationArtifacts.$inferSelect
): ConversationArtifactRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId ?? null,
    goalId: row.goalId ?? null,
    taskId: row.taskId ?? null,
    userId: row.userId,
    workspaceId: row.workspaceId,
    title: row.title,
    artifactType: row.artifactType as ArtifactType,
    mimeType: row.mimeType,
    filename: row.filename,
    content: row.content,
    metadata:
      row.metadataJson && typeof row.metadataJson === 'object'
        ? row.metadataJson
        : {},
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listConversationsForWorkspace(params: {
  userId: string;
  workspaceId: string;
  search?: string;
  includeArchived?: boolean;
  archivedOnly?: boolean;
}): Promise<ConversationRecord[]> {
  const {
    userId,
    workspaceId,
    search,
    includeArchived = false,
    archivedOnly = false,
  } = params;

  const trimmedSearch = search?.trim() ?? '';

  let matchingConvIdsFromMessages: string[] = [];
  if (trimmedSearch.length > 0) {
    const escapedPattern = `%${trimmedSearch.replace(/[%_]/g, '\\$&')}%`;
    const msgHits = await db
      .select({ conversationId: conversationMessages.conversationId })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.userId, userId),
          eq(conversationMessages.workspaceId, workspaceId),
          ilike(conversationMessages.content, escapedPattern)
        )
      )
      .limit(100);
    matchingConvIdsFromMessages = Array.from(
      new Set(msgHits.map((m) => m.conversationId))
    );
  }

  const conditions = [
    eq(conversations.userId, userId),
    eq(conversations.workspaceId, workspaceId),
  ];

  if (archivedOnly) {
    conditions.push(eq(conversations.archived, true));
  } else if (!includeArchived) {
    conditions.push(eq(conversations.archived, false));
  }

  if (trimmedSearch.length > 0) {
    const escapedPattern = `%${trimmedSearch.replace(/[%_]/g, '\\$&')}%`;
    if (matchingConvIdsFromMessages.length > 0) {
      conditions.push(
        or(
          ilike(conversations.title, escapedPattern),
          inArray(conversations.id, matchingConvIdsFromMessages)
        )!
      );
    } else {
      conditions.push(ilike(conversations.title, escapedPattern));
    }
  }

  const rows = await db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.pinned), desc(conversations.lastMessageAt))
    .limit(150);

  return rows.map((r) => mapConversationRow(r));
}

export async function createConversationForWorkspace(params: {
  userId: string;
  workspaceId: string;
  title?: string;
  model?: ChatModelId;
  goalId?: string | null;
}): Promise<ConversationRecord> {
  const id = `conv_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const now = new Date();
  const title = params.title?.trim().slice(0, 120) || 'New conversation';
  const model = normalizeChatModel(params.model);

  const [inserted] = await db
    .insert(conversations)
    .values({
      id,
      userId: params.userId,
      workspaceId: params.workspaceId,
      goalId: params.goalId ?? null,
      title,
      model,
      archived: false,
      pinned: false,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return mapConversationRow(inserted);
}

export async function getConversationByIdForUser(params: {
  conversationId: string;
  userId: string;
  workspaceId?: string;
}): Promise<ConversationRecord | null> {
  const conditions = [
    eq(conversations.id, params.conversationId),
    eq(conversations.userId, params.userId),
  ];
  if (params.workspaceId) {
    conditions.push(eq(conversations.workspaceId, params.workspaceId));
  }

  const [row] = await db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .limit(1);

  return row ? mapConversationRow(row) : null;
}

export async function updateConversationForUser(params: {
  conversationId: string;
  userId: string;
  workspaceId?: string;
  title?: string;
  archived?: boolean;
  pinned?: boolean;
  model?: ChatModelId;
  goalId?: string | null;
  touchLastMessageAt?: boolean;
}): Promise<ConversationRecord | null> {
  const existing = await getConversationByIdForUser({
    conversationId: params.conversationId,
    userId: params.userId,
    workspaceId: params.workspaceId,
  });
  if (!existing) return null;

  const now = new Date();
  const patch: Partial<typeof conversations.$inferInsert> = {
    updatedAt: now,
  };

  if (params.title !== undefined) {
    const clean = params.title.trim().slice(0, 120);
    if (clean) patch.title = clean;
  }
  if (typeof params.archived === 'boolean') {
    patch.archived = params.archived;
  }
  if (typeof params.pinned === 'boolean') {
    patch.pinned = params.pinned;
  }
  if (params.model !== undefined) {
    patch.model = normalizeChatModel(params.model);
  }
  if (params.goalId !== undefined) {
    patch.goalId = params.goalId;
  }
  if (params.touchLastMessageAt) {
    patch.lastMessageAt = now;
  }

  const [updated] = await db
    .update(conversations)
    .set(patch)
    .where(
      and(
        eq(conversations.id, existing.id),
        eq(conversations.userId, params.userId)
      )
    )
    .returning();

  return updated ? mapConversationRow(updated) : null;
}

export async function deleteConversationForUser(params: {
  conversationId: string;
  userId: string;
  workspaceId?: string;
}): Promise<boolean> {
  const existing = await getConversationByIdForUser({
    conversationId: params.conversationId,
    userId: params.userId,
    workspaceId: params.workspaceId,
  });
  if (!existing) return false;

  const deleted = await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.id, existing.id),
        eq(conversations.userId, params.userId)
      )
    )
    .returning({ id: conversations.id });

  return deleted.length > 0;
}

export async function listMessagesForConversation(params: {
  conversationId: string;
  userId: string;
  workspaceId: string;
}): Promise<ConversationMessageRecord[]> {
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, params.conversationId),
        eq(conversationMessages.userId, params.userId),
        eq(conversationMessages.workspaceId, params.workspaceId)
      )
    )
    .orderBy(
      asc(conversationMessages.createdAt),
      asc(conversationMessages.id)
    );

  return rows.map(mapMessageRow);
}

export async function createConversationMessage(params: {
  conversationId: string;
  userId: string;
  workspaceId: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string | null;
  status?: 'streaming' | 'completed' | 'stopped' | 'error';
  attachments?: ChatAttachmentRecord[];
  executionTrace?: ChatExecutionTrace | null;
  artifactIds?: string[];
  createdAt?: Date;
}): Promise<ConversationMessageRecord> {
  const id = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const now = params.createdAt ?? new Date();

  const [inserted] = await db
    .insert(conversationMessages)
    .values({
      id,
      conversationId: params.conversationId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      role: params.role,
      content: params.content,
      model: params.model ?? null,
      status: params.status ?? 'completed',
      attachmentsJson: params.attachments ?? [],
      executionTraceJson: params.executionTrace ?? null,
      artifactIdsJson: params.artifactIds ?? [],
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await db
    .update(conversations)
    .set({
      lastMessageAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(conversations.id, params.conversationId),
        eq(conversations.userId, params.userId)
      )
    );

  return mapMessageRow(inserted);
}

export async function updateConversationMessage(params: {
  messageId: string;
  conversationId: string;
  userId: string;
  content?: string;
  model?: string | null;
  status?: 'streaming' | 'completed' | 'stopped' | 'error';
  attachments?: ChatAttachmentRecord[];
  executionTrace?: ChatExecutionTrace | null;
  artifactIds?: string[];
  markEdited?: boolean;
}): Promise<ConversationMessageRecord | null> {
  const now = new Date();
  const patch: Partial<typeof conversationMessages.$inferInsert> = {
    updatedAt: now,
  };
  if (params.content !== undefined) patch.content = params.content;
  if (params.model !== undefined) patch.model = params.model;
  if (params.status !== undefined) patch.status = params.status;
  if (params.attachments !== undefined) {
    patch.attachmentsJson = params.attachments;
  }
  if (params.executionTrace !== undefined) {
    patch.executionTraceJson = params.executionTrace;
  }
  if (params.artifactIds !== undefined) {
    patch.artifactIdsJson = params.artifactIds;
  }
  if (params.markEdited) {
    patch.editedAt = now;
  }

  const [updated] = await db
    .update(conversationMessages)
    .set(patch)
    .where(
      and(
        eq(conversationMessages.id, params.messageId),
        eq(conversationMessages.conversationId, params.conversationId),
        eq(conversationMessages.userId, params.userId)
      )
    )
    .returning();

  return updated ? mapMessageRow(updated) : null;
}

export async function getConversationMessageForUser(params: {
  messageId: string;
  conversationId: string;
  userId: string;
}): Promise<ConversationMessageRecord | null> {
  const [row] = await db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, params.messageId),
        eq(conversationMessages.conversationId, params.conversationId),
        eq(conversationMessages.userId, params.userId)
      )
    )
    .limit(1);

  return row ? mapMessageRow(row) : null;
}

/**
 * Deletes all messages strictly after a given timestamp (and optional message itself)
 * when editing & resending a user message or regenerating an assistant response.
 */
export async function pruneMessagesFromTurn(params: {
  conversationId: string;
  userId: string;
  workspaceId: string;
  fromCreatedAtIso: string;
  includeMessageId?: string;
}): Promise<void> {
  const pivotDate = new Date(params.fromCreatedAtIso);

  // Also remove artifacts generated by pruned messages
  const allMsgs = await listMessagesForConversation({
    conversationId: params.conversationId,
    userId: params.userId,
    workspaceId: params.workspaceId,
  });

  const idsToDelete = allMsgs
    .filter((m) => {
      if (params.includeMessageId && m.id === params.includeMessageId) {
        return true;
      }
      const t = new Date(m.createdAt).getTime();
      return t > pivotDate.getTime();
    })
    .map((m) => m.id);

  if (idsToDelete.length === 0) return;

  await db
    .delete(conversationArtifacts)
    .where(
      and(
        eq(conversationArtifacts.conversationId, params.conversationId),
        eq(conversationArtifacts.userId, params.userId),
        inArray(conversationArtifacts.messageId, idsToDelete)
      )
    );

  await db
    .delete(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, params.conversationId),
        eq(conversationMessages.userId, params.userId),
        inArray(conversationMessages.id, idsToDelete)
      )
    );
}

export async function createConversationArtifactsBatch(
  items: Array<Omit<ConversationArtifactRecord, 'id' | 'createdAt'>>
): Promise<ConversationArtifactRecord[]> {
  if (items.length === 0) return [];
  const now = new Date();
  const values = items.map((item) => ({
    id: `art_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    conversationId: item.conversationId,
    messageId: item.messageId ?? null,
    goalId: item.goalId ?? null,
    taskId: item.taskId ?? null,
    userId: item.userId,
    workspaceId: item.workspaceId,
    title: item.title,
    artifactType: item.artifactType,
    mimeType: item.mimeType,
    filename: item.filename,
    content: item.content,
    metadataJson: item.metadata ?? {},
    createdAt: now,
  }));

  const inserted = await db
    .insert(conversationArtifacts)
    .values(values)
    .returning();

  return inserted.map(mapArtifactRow);
}

export async function listArtifactsForWorkspace(params: {
  userId: string;
  workspaceId: string;
  conversationId?: string;
}): Promise<ConversationArtifactRecord[]> {
  const conditions = [
    eq(conversationArtifacts.userId, params.userId),
    eq(conversationArtifacts.workspaceId, params.workspaceId),
  ];
  if (params.conversationId) {
    conditions.push(
      eq(conversationArtifacts.conversationId, params.conversationId)
    );
  }

  const rows = await db
    .select()
    .from(conversationArtifacts)
    .where(and(...conditions))
    .orderBy(desc(conversationArtifacts.createdAt))
    .limit(200);

  return rows.map(mapArtifactRow);
}

export async function getArtifactByIdForUser(params: {
  artifactId: string;
  userId: string;
  workspaceId?: string;
}): Promise<ConversationArtifactRecord | null> {
  const conditions = [
    eq(conversationArtifacts.id, params.artifactId),
    eq(conversationArtifacts.userId, params.userId),
  ];
  if (params.workspaceId) {
    conditions.push(eq(conversationArtifacts.workspaceId, params.workspaceId));
  }

  const [row] = await db
    .select()
    .from(conversationArtifacts)
    .where(and(...conditions))
    .limit(1);

  return row ? mapArtifactRow(row) : null;
}
