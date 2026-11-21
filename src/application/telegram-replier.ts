import type { ChatMessage } from '../domain/types.ts';
import type { ITelegramGateway } from '../ports/contracts.ts';

export class TelegramReplier {
  private gateway: ITelegramGateway;
  private handle: (message: ChatMessage) => Promise<void>;
  private unsubscribe: (() => Promise<void>) | null = null;
  private accepting = false;
  private starting = false;
  private inflight = new Set<Promise<void>>();
  private onError: () => void;
  private concurrency: number;

  constructor(deps: {
    gateway: ITelegramGateway;
    handle: (message: ChatMessage) => Promise<void>;
    onError: () => void;
    concurrency?: number;
  }) {
    this.gateway = deps.gateway;
    this.handle = deps.handle;
    this.onError = deps.onError;
    this.concurrency = deps.concurrency ?? 16;

    if (!Number.isInteger(this.concurrency) || this.concurrency < 1)
      throw new Error('Invalid concurrency');
  }

  isRunning(): boolean {
    return this.accepting;
  }

  async start(): Promise<void> {
    if (this.accepting || this.starting) throw new Error('Already started');

    this.starting = true;

    try {
      await this.gateway.connect();
      this.accepting = true;
      this.unsubscribe = await this.gateway.subscribeMessages((message) => this.receive(message));
    } catch (error) {
      this.accepting = false;
      await this.gateway.disconnect();

      throw error;
    } finally {
      this.starting = false;
    }
  }

  private async receive(message: ChatMessage): Promise<void> {
    if (!this.accepting) return;

    if (this.inflight.size >= this.concurrency) {
      this.onError();

      return;
    }

    const task = this.handle(message);

    this.inflight.add(task);

    try {
      await task;
    } catch {
      this.onError();
    } finally {
      this.inflight.delete(task);
    }
  }

  async stop(timeoutMs = 10000): Promise<void> {
    if (this.starting) throw new Error('Startup still in progress');

    this.accepting = false;

    const unsubscribe = this.unsubscribe;

    this.unsubscribe = null;

    try {
      await unsubscribe?.();

      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          Promise.allSettled(this.inflight),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Drain timed out')), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await this.gateway.disconnect();
    }
  }
}
