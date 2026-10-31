import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db } from '../db/index';
import { users } from '../db/schema';
import {
  createWorkspaceForUser,
  ensureDefaultWorkspaceForUser,
} from '../db/repository';
import {
  createConversationArtifactsBatch,
  createConversationForWorkspace,
  createConversationMessage,
  deleteConversationForUser,
  getArtifactByIdForUser,
  getConversationByIdForUser,
  listArtifactsForWorkspace,
  listConversationsForWorkspace,
  listMessagesForConversation,
  pruneMessagesFromTurn,
  updateConversationForUser,
} from '../db/conversations-repository';

test('Conversation & Artifact Persistence, Search, Edit Pruning, and Multi-Tenant Isolation', async (t) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userA = `test_conv_user_a_${suffix}`;
  const userB = `test_conv_user_b_${suffix}`;

  await db.insert(users).values([
    { uid: userA, email: `a.${suffix}@taskai.test` },
    { uid: userB, email: `b.${suffix}@taskai.test` },
  ]);

  t.after(async () => {
    await db.delete(users).where(inArray(users.uid, [userA, userB]));
  });

  const wsA1 = await ensureDefaultWorkspaceForUser(userA);
  const wsA2 = await createWorkspaceForUser({
    userId: userA,
    name: 'Secondary Isolated Workspace',
  });
  const wsB1 = await ensureDefaultWorkspaceForUser(userB);

  // 1. Create, rename, and list conversation in Workspace A1
  const convA1 = await createConversationForWorkspace({
    userId: userA,
    workspaceId: wsA1.id,
    title: 'New conversation',
    model: 'gemini-3.8-flash',
  });
  assert.equal(convA1.title, 'New conversation');
  assert.equal(convA1.archived, false);

  const renamed = await updateConversationForUser({
    conversationId: convA1.id,
    userId: userA,
    title: 'Enterprise SaaS Outbound Strategy',
  });
  assert.equal(renamed?.title, 'Enterprise SaaS Outbound Strategy');

  // 2. Persist messages + artifact, then search by message body content
  const t0 = new Date(Date.now() - 5000);
  const msgUser1 = await createConversationMessage({
    conversationId: convA1.id,
    userId: userA,
    workspaceId: wsA1.id,
    role: 'user',
    content: 'Analyze cohort retention for FinTech verticalCode992',
    createdAt: t0,
  });

  const t1 = new Date(Date.now() - 3000);
  const msgAssistant1 = await createConversationMessage({
    conversationId: convA1.id,
    userId: userA,
    workspaceId: wsA1.id,
    role: 'assistant',
    content: 'Here is the FinTech retention breakdown.',
    createdAt: t1,
  });

  const [artifact1] = await createConversationArtifactsBatch([
    {
      conversationId: convA1.id,
      messageId: msgAssistant1.id,
      goalId: null,
      taskId: null,
      userId: userA,
      workspaceId: wsA1.id,
      title: 'FinTech Cohort Matrix',
      artifactType: 'spreadsheet',
      mimeType: 'text/csv',
      filename: 'fintech-cohort.csv',
      content: 'Cohort,Retention\nQ1,92%',
      metadata: { rowCount: 1 },
    },
  ]);
  assert.ok(artifact1.id.startsWith('art_'));

  // Search by message content keyword
  const searchHits = await listConversationsForWorkspace({
    userId: userA,
    workspaceId: wsA1.id,
    search: 'verticalCode992',
  });
  assert.equal(searchHits.length, 1);
  assert.equal(searchHits[0].id, convA1.id);

  // 3. Multi-workspace & Cross-user isolation
  const wsA2List = await listConversationsForWorkspace({
    userId: userA,
    workspaceId: wsA2.id,
  });
  assert.equal(wsA2List.length, 0);

  const crossTenantRead = await getConversationByIdForUser({
    conversationId: convA1.id,
    userId: userB,
  });
  assert.equal(crossTenantRead, null);

  const crossTenantRename = await updateConversationForUser({
    conversationId: convA1.id,
    userId: userB,
    title: 'Hijacked Title',
  });
  assert.equal(crossTenantRename, null);

  const crossTenantArtifact = await getArtifactByIdForUser({
    artifactId: artifact1.id,
    userId: userB,
  });
  assert.equal(crossTenantArtifact, null);

  const userBArtifacts = await listArtifactsForWorkspace({
    userId: userB,
    workspaceId: wsB1.id,
  });
  assert.equal(userBArtifacts.length, 0);

  // 4. Archive and restore conversation
  await updateConversationForUser({
    conversationId: convA1.id,
    userId: userA,
    archived: true,
  });
  const activeAfterArchive = await listConversationsForWorkspace({
    userId: userA,
    workspaceId: wsA1.id,
  });
  assert.equal(activeAfterArchive.length, 0);

  const archivedOnlyList = await listConversationsForWorkspace({
    userId: userA,
    workspaceId: wsA1.id,
    archivedOnly: true,
  });
  assert.equal(archivedOnlyList.length, 1);

  await updateConversationForUser({
    conversationId: convA1.id,
    userId: userA,
    archived: false,
  });

  // 5. Edit/regenerate pruning removes downstream assistant message & associated artifact
  await pruneMessagesFromTurn({
    conversationId: convA1.id,
    userId: userA,
    workspaceId: wsA1.id,
    fromCreatedAtIso: msgUser1.createdAt,
  });

  const remainingMessages = await listMessagesForConversation({
    conversationId: convA1.id,
    userId: userA,
    workspaceId: wsA1.id,
  });
  assert.equal(remainingMessages.length, 1);
  assert.equal(remainingMessages[0].id, msgUser1.id);

  const remainingArtifacts = await listArtifactsForWorkspace({
    userId: userA,
    workspaceId: wsA1.id,
    conversationId: convA1.id,
  });
  assert.equal(remainingArtifacts.length, 0);

  // 6. Cross-user delete rejected; owner delete succeeds
  const crossDelete = await deleteConversationForUser({
    conversationId: convA1.id,
    userId: userB,
  });
  assert.equal(crossDelete, false);

  const ownerDelete = await deleteConversationForUser({
    conversationId: convA1.id,
    userId: userA,
  });
  assert.equal(ownerDelete, true);
});
