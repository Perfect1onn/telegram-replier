import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { GatewayLease } from '../../src/infrastructure/telegram/gateway-lease.ts';
import { Redis } from 'ioredis';

const redisUrl = process.env.TEST_REDIS_URL;

if (!redisUrl) throw new Error('TEST_REDIS_URL is required');

const accountId = String(BigInt(`5${Date.now()}5`));
let lost = false;
const first = new GatewayLease(redisUrl, accountId, () => {
  lost = true;
});
const second = new GatewayLease(redisUrl, accountId, () => {});

after(async () => {
  await first.release();
  await second.release();
});

test('one gateway owns a session lease and renews it', async () => {
  await first.acquire();

  assert.equal(await first.renew(), true);
  await assert.rejects(second.acquire(), /already owned/);
  assert.equal(second.isHeld(), false);
  await first.release();
  await second.acquire();

  assert.equal(await second.renew(), true);
  assert.equal(lost, false);
});

test('loss of Redis ownership closes the send gate', async () => {
  const id = String(BigInt(`6${Date.now()}6`));
  let lostLease = false;
  const lease = new GatewayLease(redisUrl, id, () => {
    lostLease = true;
  });
  const redis = new Redis(redisUrl);

  try {
    await lease.acquire();
    await redis.del(`telegram-replier:gateway:${id}`);

    assert.equal(await lease.renew(), false);
    assert.equal(lease.isHeld(), false);
    assert.equal(lostLease, true);
  } finally {
    await lease.release();
    await redis.quit();
  }
});
