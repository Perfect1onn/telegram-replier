import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FloodWaitError } from 'teleproto/errors';
import { retryFloodWait } from '../../src/infrastructure/telegram/teleproto.gateway.ts';

test('Telegram history waits for flood limit and resumes the same page', async () => {
  let attempts = 0;
  const waits: number[] = [];

  const result = await retryFloodWait(
    async () => {
      attempts += 1;

      if (attempts === 1)
        throw new FloodWaitError({ request: { className: 'messages.GetHistory' }, capture: 17 });

      return 'page';
    },
    async (ms) => {
      waits.push(ms);
    },
  );

  assert.equal(result, 'page');
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [18000]);
});
