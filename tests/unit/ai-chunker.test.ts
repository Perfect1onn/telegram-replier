import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationChunker } from '../../src/application/conversation-chunker.ts';
import { AIService, estimateCost, requiresReview } from '../../src/application/ai.service.ts';
import type { ChatMessage } from '../../src/domain/types.ts';

const message = (id: number): ChatMessage => ({
  chatId: '1',
  messageId: String(id),
  senderId: '2',
  text: 'hello 😀',
  source: 'TELEGRAM',
  direction: 'INCOMING',
  occurredAt: new Date(id * 1000),
});

test('cost includes discounted cached tokens', () => {
  assert.equal(
    estimateCost(
      { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100 },
      { input: 2, cached: 1, output: 10 },
    ),
    0.0025,
  );
});
test('sensitive commitments and uncertainty require review', () => {
  for (const text of ['I promise payment', 'пароль abc', 'Я не уверен', 'Meet tomorrow'])
    assert.equal(requiresReview(text), true);

  assert.equal(requiresReview('Спасибо'), false);
});
test('generated answer preserves text without adding a marker', async () => {
  const service = new AIService({
    async generate() {
      return {
        text: 'Спасибо',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      };
    },
  });
  const currentMessage = message(1);

  assert.equal(
    (
      await service.generateAnswer({
        chatId: '1',
        instructions: '',
        recentMessages: [],
        retrievedMemories: [],
        currentMessage,
      })
    ).text,
    'Спасибо',
  );
});
test('chunk boundaries, duplicate, Unicode and deterministic hash', () => {
  const chunker = new ConversationChunker(300);
  const first = chunker.append(null, message(1));

  assert.equal(chunker.append(first.state, message(1)).state.ids.size, 1);
  assert.deepEqual(chunker.finalize(first.state), chunker.finalize(first.state));
  assert.throws(() => chunker.append(first.state, { ...message(2), chatId: 'other' }));
  assert.throws(() => chunker.append(first.state, message(0)));

  const gap = chunker.append(first.state, { ...message(2), occurredAt: new Date(3600000) });

  assert.equal(gap.finalized.length, 1);
});
test('long Unicode message is segmented without loss or oversized chunks', () => {
  const chunker = new ConversationChunker(300);
  const text = '😀 "hello"\\\n'.repeat(150);
  const result = chunker.append(null, { ...message(1), text });
  const chunks = [...result.finalized, ...chunker.finalize(result.state)];
  const pieces = chunks.map((chunk) => {
    assert.ok(Buffer.byteLength(chunk.content) <= 300);
    assert.deepEqual(chunk.messageIds, ['1']);

    return JSON.parse(chunk.content) as { text: string; part: number };
  });

  assert.deepEqual(
    pieces.map((piece) => piece.part),
    pieces.map((_piece, i) => i),
  );
  assert.equal(pieces.map((piece) => piece.text).join(''), text);
});
test('10000 messages are processed with bounded open state', () => {
  const chunker = new ConversationChunker();
  let state = null;
  let finalized = 0;

  for (let id = 1; id <= 10000; id++) {
    const result = chunker.append(state, message(id));

    state = result.state;
    finalized += result.finalized.length;
    assert.ok(state.charCount <= 700);
  }

  assert.ok(finalized > 100);
});
