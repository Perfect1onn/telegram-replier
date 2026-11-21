import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { AdminAuth } from '../../src/infrastructure/admin/admin-auth.ts';

test('admin challenge requires the matching private key and is single use', async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const auth = new AdminAuth(
    pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    's'.repeat(64),
  );
  const challenge = auth.createChallenge();
  const wrong = sign('sha256', Buffer.from(challenge.message), {
    key: other.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');

  assert.equal(await auth.exchange(challenge.id, wrong), null);
  assert.equal(await auth.exchange(challenge.id, wrong), null);

  const next = auth.createChallenge();
  const signature = sign('sha256', Buffer.from(next.message), {
    key: pair.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const jwt = await auth.exchange(next.id, signature);

  assert.ok(jwt);
  assert.equal(await auth.accepts(jwt), true);
  assert.equal(await auth.exchange(next.id, signature), null);
  assert.equal(await auth.accepts(`${jwt}x`), false);
  assert.equal(
    await new AdminAuth(
      pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      't'.repeat(64),
    ).accepts(jwt),
    false,
  );
});
