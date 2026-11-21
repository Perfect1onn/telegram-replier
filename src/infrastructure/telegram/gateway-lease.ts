import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export class GatewayLease {
  private redis: Redis;
  private key: string;
  private token = randomUUID();
  private timer: ReturnType<typeof setInterval> | null = null;
  private held = false;
  private onLost: () => void;

  constructor(redisUrl: string, accountId: string, onLost: () => void) {
    if (!/^[1-9]\d*$/.test(accountId)) throw new Error('Invalid account ID');

    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', () => {});
    this.key = `telegram-replier:gateway:${accountId}`;
    this.onLost = onLost;
  }

  async acquire(): Promise<void> {
    if (this.held) throw new Error('Gateway lease already held');

    if (this.redis.status === 'wait') await this.redis.connect();

    if ((await this.redis.set(this.key, this.token, 'PX', 30000, 'NX')) !== 'OK')
      throw new Error('Telegram gateway already owned');

    this.held = true;
    this.timer = setInterval(() => {
      void this.renew();
    }, 10000);
  }

  async renew(): Promise<boolean> {
    if (!this.held) return false;

    try {
      const result = await this.redis.eval(RENEW, 1, this.key, this.token, '30000');

      if (result === 1) return true;
    } catch {
      this.lose();

      return false;
    }

    this.lose();

    return false;
  }

  isHeld(): boolean {
    return this.held;
  }

  private lose(): void {
    if (!this.held) return;

    this.held = false;

    if (this.timer) clearInterval(this.timer);

    this.timer = null;
    this.onLost();
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);

    this.timer = null;

    const wasHeld = this.held;

    this.held = false;

    try {
      if (wasHeld) await this.redis.eval(RELEASE, 1, this.key, this.token);

      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
