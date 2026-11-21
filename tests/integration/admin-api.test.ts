import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { createAdminApi } from '../../src/infrastructure/admin/admin-api.ts';
import { PrismaWorkflowStore } from '../../src/infrastructure/persistence/prisma-workflow.store.ts';
import { PersonalMemory } from '../../src/infrastructure/persistence/personal-memory.ts';
import { PolicyEngine } from '../../src/application/policy-engine.ts';
import { OutboundDispatcher } from '../../src/application/outbound-dispatcher.ts';
import { FakeGateway } from '../../src/infrastructure/testing/fakes.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const token = randomBytes(32).toString('hex');
const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const store = new PrismaWorkflowStore(db);
const adminGateway = new FakeGateway();
const dispatcher = new OutboundDispatcher(
  store,
  new PolicyEngine(store, () => false),
  adminGateway,
);
const app = createAdminApi({
  db,
  store,
  dispatcher,
  gateway: adminGateway,
  jwtSecret: token,
  embeddingModel: 'test-1536',
  publicKeyPem,
  ready: async () => true,
});

async function authHeaders(target = app): Promise<{ authorization: string }> {
  const challengeResponse = await target.inject({ method: 'POST', url: '/auth/challenge' });

  assert.equal(challengeResponse.statusCode, 200);

  const challenge = challengeResponse.json();
  const signature = sign('sha256', Buffer.from(challenge.message), {
    key: keyPair.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const response = await target.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { id: challenge.id, signature },
  });

  assert.equal(response.statusCode, 200);

  return { authorization: `Bearer ${response.json().token}` };
}

after(async () => {
  await app.close();
  await db.$disconnect();
});

test('admin API requires signed-key JWT auth and versioned chat updates', async () => {
  const chatId = String(BigInt(`4${Date.now()}`));
  const url = `/api/chats/${chatId}`;

  assert.equal((await app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);

  const adminPage = await app.inject({ method: 'GET', url: '/admin/' });

  assert.equal(adminPage.statusCode, 200);
  assert.match(adminPage.headers['content-security-policy'] ?? '', /default-src 'none'/);
  assert.match(adminPage.body, /Replier — управление/);
  assert.match(adminPage.body, /assets\//);
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer wrong' } }))
      .statusCode,
    401,
  );

  const headers = await authHeaders();

  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/chats?limit=5', headers })).statusCode,
    200,
  );

  const created = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { expectedVersion: 0, patch: { enabled: true, mode: 'DRAFT' } },
  });

  assert.equal(created.statusCode, 200);
  assert.equal(created.json().version, 1);

  const progress = await app.inject({ method: 'GET', url: `${url}/progress`, headers });

  assert.equal(progress.statusCode, 200);
  assert.equal(progress.json().history.state, 'NOT_STARTED');
  assert.equal(progress.json().storedMessages, 0);
  assert.equal(progress.json().indexedMessages, 0);
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url,
        headers,
        payload: { expectedVersion: 0, patch: { mode: 'AUTO' } },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url,
        headers,
        payload: { expectedVersion: 1, patch: { maxRepliesPerHour: 1000 } },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/system/pause', headers })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/status', headers })).json().paused,
    true,
  );
  assert.equal((await app.inject({ method: 'GET', url: '/api/usage', headers })).statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'POST', url: `${url}/backfill`, headers })).statusCode,
    202,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: `${url}/backfill`, headers })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/drafts?limit=10', headers })).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `${url}/data`,
        headers,
        payload: { confirm: 'wrong' },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `${url}/data`,
        headers,
        payload: { confirm: `PURGE ${chatId}` },
      })
    ).statusCode,
    200,
  );
  assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 404);
});

test('personal questionnaire is JWT protected and validated', async () => {
  const url = '/api/profile';
  const headers = await authHeaders();

  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'PUT', url, headers, payload: { about: 'incomplete' } }))
      .statusCode,
    400,
  );

  const payload = {
    name: 'Perf',
    about: 'Люблю короткие ответы',
    work: 'Разработчик',
    interests: 'Музыка',
    style: 'пишу без точек',
    boundaries: 'Не переносить чужие личные детали',
  };
  const result = await app.inject({ method: 'PUT', url, headers, payload });

  assert.equal(result.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url, headers })).json().name, payload.name);
  assert.equal((await new PersonalMemory(db).getProfile()).about.includes('Разработчик'), true);
});

test('explicit draft approval sends only through the dispatcher', async () => {
  const chatId = String(BigInt(`7${Date.now()}`));
  const chat = await store.updateChat(chatId, { enabled: true, mode: 'DRAFT' }, 0);
  const now = Date.now();

  await store.ingest(
    {
      chatId,
      messageId: '700',
      senderId: chatId,
      direction: 'INCOMING',
      source: 'TELEGRAM',
      text: 'hello',
      occurredAt: new Date(now),
    },
    now,
  );

  const operation = await db.replyOperation.findFirstOrThrow({ where: { chatId } });
  const input = {
    chatId,
    triggerMessageId: '700',
    generation: Number(operation.generation),
    configVersion: chat.version,
  };

  await store.saveDraft(input, {
    text: 'hello',
    model: 'fake',
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
  });
  await store.setPaused(false);

  const gateway = new FakeGateway();
  const approvalApi = createAdminApi({
    db,
    store,
    jwtSecret: token,
    embeddingModel: 'test-1536',
    publicKeyPem,
    gateway,
    ready: async () => true,
    dispatcher: new OutboundDispatcher(store, new PolicyEngine(store, () => true), gateway),
  });

  try {
    const response = await approvalApi.inject({
      method: 'POST',
      url: `/api/drafts/${operation.id}/approve`,
      headers: await authHeaders(approvalApi),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(gateway.sent.length, 1);
    assert.equal(
      (await db.replyOperation.findUniqueOrThrow({ where: { id: operation.id } })).status,
      'SENT',
    );
    assert.equal(
      (
        await approvalApi.inject({
          method: 'POST',
          url: `/api/drafts/${operation.id}/approve`,
          headers: await authHeaders(approvalApi),
        })
      ).statusCode,
      404,
    );
  } finally {
    await approvalApi.close();
  }
});

test('UNKNOWN send requires explicit history-backed reconciliation', async () => {
  const chatId = String(BigInt(`3${Date.now()}3`));
  const chat = await store.updateChat(chatId, { enabled: true, mode: 'AUTO' }, 0);
  const now = Date.now();

  await store.ingest(
    {
      chatId,
      messageId: '900',
      senderId: chatId,
      direction: 'INCOMING',
      source: 'TELEGRAM',
      text: 'hello',
      occurredAt: new Date(now),
    },
    now,
  );

  const operation = await db.replyOperation.findFirstOrThrow({ where: { chatId } });
  const claim = await store.claimSend(
    {
      chatId,
      triggerMessageId: '900',
      generation: Number(operation.generation),
      configVersion: chat.version,
    },
    {
      text: 'reply',
      model: 'fake',
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    },
    false,
    now,
  );

  if (!claim) throw new Error('Send was not claimed');

  await store.finishSend(claim.id, null);

  const headers = await authHeaders();
  const url = `/api/sends/${claim.id}/reconcile`;
  const body = { outcome: 'SENT', telegramMessageId: '901', confirm: `RECONCILE ${claim.id}` };

  assert.equal((await app.inject({ method: 'POST', url, headers, payload: body })).statusCode, 409);

  adminGateway.history = [
    {
      chatId,
      messageId: '901',
      senderId: 'self',
      direction: 'OUTGOING',
      source: 'TELEGRAM',
      text: 'reply',
      replyToMessageId: '900',
      occurredAt: new Date(now + 1),
    },
  ];

  assert.equal((await app.inject({ method: 'POST', url, headers, payload: body })).statusCode, 200);
  assert.equal(
    (await db.replyOperation.findUniqueOrThrow({ where: { id: claim.id } })).status,
    'SENT',
  );
});
