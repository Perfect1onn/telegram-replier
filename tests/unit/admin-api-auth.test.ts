import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createAdminApi } from '../../src/infrastructure/admin/admin-api.ts';
import type { PrismaWorkflowStore } from '../../src/infrastructure/persistence/prisma-workflow.store.ts';
import type { OutboundDispatcher } from '../../src/application/outbound-dispatcher.ts';
import type { ITelegramGateway } from '../../src/ports/contracts.ts';

test('browser-style P-256 login issues a JWT that gates API routes', async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const gateway = {
    listPrivateDialogs: async () => [{ chatId: '123456', title: 'Алиса' }],
  } as ITelegramGateway;
  const app = createAdminApi({
    jwtSecret: 'j'.repeat(64),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    db: {
      systemState: { findUnique: async () => ({ paused: true }) },
      jobOutbox: { count: async () => 0 },
      replyOperation: { count: async () => 0 },
    } as unknown as PrismaClient,
    store: {} as PrismaWorkflowStore,
    dispatcher: {} as OutboundDispatcher,
    gateway,
    ready: async () => true,
  });

  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/status' })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/telegram/dialogs' })).statusCode,
      401,
    );

    const challenge = (await app.inject({ method: 'POST', url: '/auth/challenge' })).json();
    const browserKey = await webcrypto.subtle.importKey(
      'pkcs8',
      pair.privateKey.export({ type: 'pkcs8', format: 'der' }),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        browserKey,
        new TextEncoder().encode(challenge.message),
      ),
    ).toString('base64url');
    const login = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { id: challenge.id, signature },
    });

    assert.equal(login.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/verify',
          payload: { id: challenge.id, signature },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/status',
          headers: { authorization: `Bearer ${login.json().token}` },
        })
      ).statusCode,
      200,
    );

    const dialogs = await app.inject({
      method: 'GET',
      url: '/api/telegram/dialogs',
      headers: { authorization: `Bearer ${login.json().token}` },
    });

    assert.equal(dialogs.statusCode, 200);
    assert.deepEqual(dialogs.json(), { items: [{ chatId: '123456', title: 'Алиса' }] });
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/status',
          headers: { authorization: 'Bearer bad' },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
