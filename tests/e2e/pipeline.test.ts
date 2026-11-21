import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultChat } from '../../src/domain/types.ts';
import type { ChatMessage, ReplyMode } from '../../src/domain/types.ts';
import { MemoryStore } from '../../src/infrastructure/testing/memory-store.ts';
import { EmptyRag, FakeGateway, FakeProvider } from '../../src/infrastructure/testing/fakes.ts';
import { PolicyEngine } from '../../src/application/policy-engine.ts';
import { MessageIngestionService } from '../../src/application/message-ingestion.service.ts';
import { ContextBuilder } from '../../src/application/context-builder.ts';
import { AIService } from '../../src/application/ai.service.ts';
import { OutboundDispatcher } from '../../src/application/outbound-dispatcher.ts';
import { ReplyProcessor } from '../../src/application/reply-processor.ts';
import { Synchronizer } from '../../src/application/synchronizer.ts';

function fixture(mode: ReplyMode = 'AUTO') {
  const store = new MemoryStore();

  store.chats.set('1', { ...defaultChat('1'), mode });

  const gateway = new FakeGateway();
  const provider = new FakeProvider();
  const policy = new PolicyEngine(store, () => !store.paused);
  const ingestion = new MessageIngestionService(policy, store);
  const dispatcher = new OutboundDispatcher(store, policy, gateway);
  const processor = new ReplyProcessor({
    store,
    policy,
    dispatcher,
    context: new ContextBuilder(store, policy, new EmptyRag()),
    ai: new AIService(provider),
  });
  const message = (id: number, direction: 'INCOMING' | 'OUTGOING' = 'INCOMING'): ChatMessage => ({
    chatId: '1',
    messageId: String(id),
    senderId: '2',
    direction,
    source: 'TELEGRAM',
    text: 'hello',
    occurredAt: new Date(id * 1000),
  });
  const drain = async () => {
    for (const job of [...store.operations.values()]) await processor.process(job);
  };

  return { store, gateway, provider, policy, ingestion, processor, dispatcher, message, drain };
}

test('clean install is globally paused', async () => {
  const f = fixture();

  await f.ingestion.handle(f.message(1));
  await f.drain();
  assert.equal(f.provider.calls, 0);
  assert.equal(f.gateway.sent.length, 0);
});
test('unknown, disabled and OFF chats never persist text', async () => {
  const f = fixture('OFF');

  await f.ingestion.handle(f.message(1));
  f.store.chats.clear();
  await f.ingestion.handle(f.message(2));
  f.store.chats.set('1', { ...defaultChat('1'), enabled: false, mode: 'AUTO' });
  await f.ingestion.handle(f.message(3));
  assert.equal(f.store.messages.size, 0);
});

for (const count of [1, 5, 100])
  test(`${count} incoming messages debounce into one send`, async () => {
    const f = fixture();

    f.store.paused = false;

    for (let id = 1; id <= count; id++) await f.ingestion.handle(f.message(id));

    await f.drain();
    await f.drain();
    assert.equal(f.gateway.sent.length, 1);
    assert.equal(f.provider.calls, 1);
  });

test('duplicates are ignored and manual reply cancels', async () => {
  const f = fixture();

  f.store.paused = false;
  await f.ingestion.handle(f.message(1));
  await f.ingestion.handle(f.message(1));
  assert.equal(f.store.operations.size, 1);
  await f.ingestion.handle(f.message(2, 'OUTGOING'));
  await f.drain();
  assert.equal(f.gateway.sent.length, 0);
});
test('pause or manual reply during model generation prevents dispatch', async () => {
  const f = fixture();

  f.store.paused = false;
  await f.ingestion.handle(f.message(1));
  f.provider.beforeAnswer = async () => {
    await f.ingestion.handle(f.message(2, 'OUTGOING'));
  };
  await f.drain();
  assert.equal(f.gateway.sent.length, 0);
});
test('DRAFT needs explicit approval and sends once', async () => {
  const f = fixture('DRAFT');

  f.store.paused = false;
  await f.ingestion.handle(f.message(1));
  await f.drain();
  assert.equal(f.gateway.sent.length, 0);

  const job = [...f.store.operations.values()][0];

  assert.ok(job?.answer);
  await f.dispatcher.dispatch(job, job.answer, true);
  await f.dispatcher.dispatch(job, job.answer, true);
  assert.equal(f.gateway.sent.length, 1);
});
test('unknown send never retries and blocks following sends', async () => {
  const f = fixture();

  f.store.paused = false;
  f.gateway.fail = true;
  await f.ingestion.handle(f.message(1));
  await f.drain();
  await f.drain();
  await f.ingestion.handle(f.message(2));
  await f.drain();
  assert.equal(f.gateway.sent.length, 1);
  assert.equal([...f.store.operations.values()][0]?.status, 'UNKNOWN');
});
test('config version change during generation prevents dispatch', async () => {
  const f = fixture();

  f.store.paused = false;
  await f.ingestion.handle(f.message(1));
  f.provider.beforeAnswer = async () => {
    f.store.update({ ...defaultChat('1'), mode: 'OFF' }, 1);
  };
  await f.drain();
  assert.equal(f.gateway.sent.length, 0);
});
test('backfill persists history without reply jobs', async () => {
  const f = fixture();

  f.gateway.history = [f.message(1), f.message(2)];
  await new Synchronizer(f.store, f.policy, f.gateway).backfillChat('1');
  assert.equal(f.store.messages.get('1')?.size, 2);
  assert.equal(f.store.operations.size, 0);
});
test('policy repository failure is closed', async () => {
  const policy = new PolicyEngine(
    {
      getChat: async () => {
        throw new Error('database unavailable');
      },
    },
    () => true,
  );

  assert.equal(await policy.canIngest('1'), false);
  assert.equal(await policy.canSend('1', 1, false), false);
});
test('retrieval outage falls back to recent messages and other-chat memories are allowed', async () => {
  const f = fixture();

  f.store.paused = false;
  await f.ingestion.handle(f.message(1));

  const failed = new ContextBuilder(f.store, f.policy, {
    searchRelevantContext: async () => {
      throw new Error('unavailable');
    },
  });

  assert.deepEqual((await failed.buildContext('1', '1')).retrievedMemories, []);

  const hostile = new ContextBuilder(f.store, f.policy, {
    searchRelevantContext: async () => [
      { id: 'x', chatId: 'other', content: 'writing style', messageIds: ['1'], score: 1 },
    ],
  });

  const context = await hostile.buildContext('1', '1');

  assert.equal(context.retrievedMemories[0]?.chatId, 'other');
  assert.ok(context.recentMessages.every((message) => message.chatId === '1'));
});
test('hourly limit denies subsequent sends', async () => {
  const f = fixture();

  f.store.paused = false;
  f.store.chats.set('1', { ...defaultChat('1'), mode: 'AUTO', maxRepliesPerHour: 1 });
  await f.ingestion.handle(f.message(1));
  await f.drain();
  await f.ingestion.handle(f.message(2));
  await f.drain();
  assert.equal(f.gateway.sent.length, 1);
});
