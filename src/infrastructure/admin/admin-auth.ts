import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'telegram-replier-admin';
const AUDIENCE = 'telegram-replier-api';
const CHALLENGE_TTL_MS = 60_000;
const MAX_CHALLENGES = 256;

interface PendingChallenge {
  message: string;
  expiresAt: number;
}

export class AdminAuth {
  private readonly publicKey;
  private readonly keyId: string;
  private readonly jwtSecret: Uint8Array;
  private readonly challenges = new Map<string, PendingChallenge>();

  constructor(publicKeyPem: string, jwtSecret: string) {
    if (Buffer.byteLength(jwtSecret) < 32) throw new Error('Invalid JWT secret');

    this.publicKey = createPublicKey(publicKeyPem);

    if (
      this.publicKey.asymmetricKeyType !== 'ec' ||
      this.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    )
      throw new Error('Admin public key must use P-256');

    this.keyId = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    this.jwtSecret = new TextEncoder().encode(jwtSecret);
  }

  createChallenge(): { id: string; message: string; expiresAt: number } {
    const now = Date.now();

    for (const [id, pending] of this.challenges)
      if (pending.expiresAt <= now) this.challenges.delete(id);

    if (this.challenges.size >= MAX_CHALLENGES) throw new Error('Too many pending challenges');

    const id = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = now + CHALLENGE_TTL_MS;
    const message = `telegram-replier-admin:v1:${id}:${nonce}`;

    this.challenges.set(id, { message, expiresAt });

    return { id, message, expiresAt };
  }

  async exchange(id: string, signature: string): Promise<string | null> {
    const pending = this.challenges.get(id);

    this.challenges.delete(id);

    if (!pending || pending.expiresAt <= Date.now() || !/^[A-Za-z0-9_-]{86}$/.test(signature))
      return null;

    const valid = verify(
      'sha256',
      Buffer.from(pending.message),
      { key: this.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );

    if (!valid) return null;

    return new SignJWT({ scope: 'admin' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(this.keyId)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(this.jwtSecret);
  }

  async accepts(token: string): Promise<boolean> {
    try {
      const { payload } = await jwtVerify(token, this.jwtSecret, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        maxTokenAge: '15m',
      });

      return payload.sub === this.keyId && payload.scope === 'admin';
    } catch {
      return false;
    }
  }
}
