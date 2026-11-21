import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../../src/domain/types.ts';
import { FakeGateway } from '../../src/infrastructure/testing/fakes.ts';
import { TelegramReplier } from '../../src/application/telegram-replier.ts';

class EventGateway extends FakeGateway {
  handler: ((message: ChatMessage) => Promise<void>) | null = null;
  disconnected = false;

  override async subscribeMessages(handler: (message: ChatMessage) => Promise<void>) {
    this.handler = handler;

    return async () => {
      this.handler = null;
    };
  }

  override async disconnect() {
    this.disconnected = true;
  }
}

const message: ChatMessage = {
  chatId: '1',
  messageId: '1',
  senderId: '2',
  direction: 'INCOMING',
  source: 'TELEGRAM',
  text: 'test',
  occurredAt: new Date(0),
};

test('lifecycle subscribes once, drains and unsubscribes on shutdown', async () => {
  const gateway = new EventGateway();
  let calls = 0;
  const replier = new TelegramReplier({
    gateway,
    handle: async () => {
      calls++;
    },
    onError: () => assert.fail('unexpected failure'),
  });

  await replier.start();
  await assert.rejects(replier.start());
  await gateway.handler?.(message);
  await replier.stop();
  assert.equal(calls, 1);
  assert.equal(gateway.handler, null);
  assert.equal(gateway.disconnected, true);
});
test('handler errors are reported without leaking message content', async () => {
  const gateway = new EventGateway();
  let failures = 0;
  const replier = new TelegramReplier({
    gateway,
    handle: async () => {
      throw new Error('sensitive text');
    },
    onError: () => {
      failures++;
    },
  });

  await replier.start();
  await gateway.handler?.(message);
  await replier.stop();
  assert.equal(failures, 1);
});
test('shutdown deadline disconnects even when handler is stuck', async () => {
  const gateway = new EventGateway();
  let finish: () => void = () => {};
  const task = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const replier = new TelegramReplier({ gateway, handle: async () => task, onError: () => {} });

  await replier.start();

  const pending = gateway.handler?.(message);

  await assert.rejects(replier.stop(5), /Drain timed out/);
  assert.equal(gateway.disconnected, true);
  finish();
  await pending;
});
