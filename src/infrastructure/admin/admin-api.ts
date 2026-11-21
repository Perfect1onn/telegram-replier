import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { AccessDeniedError, ConflictError } from '../../domain/types.ts';
import type { ChatPatch } from '../../application/chat-config.ts';
import { PrismaWorkflowStore } from '../persistence/prisma-workflow.store.ts';
import { mapChat } from '../persistence/message.mapper.ts';
import type { OutboundDispatcher } from '../../application/outbound-dispatcher.ts';
import type { ITelegramGateway } from '../../ports/contracts.ts';
import { AdminAuth } from './admin-auth.ts';

interface AdminOptions {
  jwtSecret: string;
  publicKeyPem: string;
  autoreplyEnabled?: boolean;
  embeddingModel: string;
  db: PrismaClient;
  store: PrismaWorkflowStore;
  dispatcher: OutboundDispatcher;
  gateway: ITelegramGateway;
  ready: () => Promise<boolean>;
}

function validChatId(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && value.length <= 20;
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

interface ProfileInput {
  name: string;
  about: string;
  work: string;
  interests: string;
  style: string;
  boundaries: string;
}

function validProfile(value: unknown): value is ProfileInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const row = value as Record<string, unknown>;
  const maxLengths: Record<keyof ProfileInput, number> = {
    name: 200,
    about: 4000,
    work: 2000,
    interests: 2000,
    style: 2000,
    boundaries: 2000,
  };

  return (
    Object.keys(row).every((key) => key in maxLengths) &&
    Object.entries(maxLengths).every(
      ([key, max]) => typeof row[key] === 'string' && row[key].length <= max,
    )
  );
}

export function createAdminApi(options: AdminOptions): FastifyInstance {
  const auth = new AdminAuth(options.publicKeyPem, options.jwtSecret);
  const requests = new Map<string, { start: number; count: number }>();
  const app = Fastify({ logger: false, bodyLimit: 16384, requestTimeout: 10000 });

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';

    if (
      path === '/health/live' ||
      path === '/health/ready' ||
      path === '/admin' ||
      path === '/admin/' ||
      /^\/admin\/assets\/[A-Za-z0-9._-]+$/.test(path)
    )
      return;

    const now = Date.now();
    const current = requests.get(request.ip);
    const next =
      current && now - current.start < 60000
        ? { start: current.start, count: current.count + 1 }
        : { start: now, count: 1 };

    if (requests.size > 1024) requests.clear();

    requests.set(request.ip, next);

    if (next.count > 120) return reply.code(429).send({ error: 'Rate limit exceeded' });

    if (path === '/auth/challenge' || path === '/auth/verify') return;

    const supplied = request.headers.authorization;

    if (!supplied?.startsWith('Bearer ') || !(await auth.accepts(supplied.slice(7))))
      return reply.code(401).send({ error: 'Unauthorized' });
  });

  app.setErrorHandler((error, _request, reply) => {
    const code =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status =
      error instanceof ConflictError
        ? 409
        : error instanceof AccessDeniedError
          ? 404
          : typeof code === 'number' && code >= 400 && code < 500
            ? code
            : 500;

    reply.code(status).send({
      error: status === 500 ? 'Internal error' : status === 409 ? 'Conflict' : 'Invalid request',
    });
  });

  app.get('/health/live', async () => ({ live: true }));

  app.get('/admin', async (_request, reply) => reply.redirect('/admin/'));

  const sendAsset = async (filename: string, reply: FastifyReply) => {
    const body = await readFile(new URL(`../../../admin-ui/dist/${filename}`, import.meta.url));
    const contentType = filename.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : filename.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'text/html; charset=utf-8';

    return reply
      .header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      )
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'no-store')
      .type(contentType)
      .send(body);
  };

  app.get('/admin/', async (_request, reply) => sendAsset('index.html', reply));
  app.get<{ Params: { filename: string } }>('/admin/assets/:filename', async (request, reply) => {
    if (!/^[A-Za-z0-9._-]+\.(js|css)$/.test(request.params.filename))
      return reply.code(404).send({ error: 'Not found' });

    return sendAsset(`assets/${request.params.filename}`, reply);
  });

  app.post('/auth/challenge', async (_request, reply) => {
    try {
      return auth.createChallenge();
    } catch {
      return reply.code(429).send({ error: 'Too many challenges' });
    }
  });

  app.post<{ Body: { id?: string; signature?: string } }>(
    '/auth/verify',
    async (request, reply) => {
      const { id, signature } = request.body ?? {};

      if (
        typeof id !== 'string' ||
        typeof signature !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(id) ||
        signature.length > 128
      )
        return reply.code(400).send({ error: 'Invalid request' });

      const token = await auth.exchange(id, signature);

      if (!token) return reply.code(401).send({ error: 'Unauthorized' });

      return { token, expiresIn: 900 };
    },
  );

  app.get('/health/ready', async (_request, reply) => {
    try {
      if (await options.ready()) return { ready: true };
    } catch {
      return reply.code(503).send({ ready: false });
    }

    return reply.code(503).send({ ready: false });
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/api/chats',
    async (request, reply) => {
      const limit = request.query.limit === undefined ? 20 : Number(request.query.limit);
      const cursor = request.query.cursor;

      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (cursor !== undefined && !validChatId(cursor)) ||
        Object.keys(request.query).some((key) => !['limit', 'cursor'].includes(key))
      )
        return reply.code(400).send({ error: 'Invalid request' });

      const rows = await options.db.allowedChat.findMany({
        orderBy: { chatId: 'asc' },
        take: limit + 1,
        ...(cursor ? { cursor: { chatId: cursor }, skip: 1 } : {}),
      });

      return {
        items: rows.slice(0, limit).map(mapChat),
        nextCursor: rows.length > limit ? rows[limit - 1]?.chatId : null,
      };
    },
  );

  app.get('/api/telegram/dialogs', async () => ({
    items: await options.gateway.listPrivateDialogs(),
  }));

  app.post<{ Body: { chatId?: string } }>('/api/chats', async (request, reply) => {
    const body = request.body;

    if (
      !body ||
      typeof body.chatId !== 'string' ||
      !validChatId(body.chatId) ||
      Object.keys(body).length !== 1
    )
      return reply.code(400).send({ error: 'Invalid request' });

    const chat = await options.store.updateChat(body.chatId, {}, 0);

    return reply.code(201).send(chat);
  });

  app.get<{ Params: { chatId: string } }>('/api/chats/:chatId', async (request, reply) => {
    const { chatId } = request.params;

    if (!validChatId(chatId)) return reply.code(400).send({ error: 'Invalid request' });

    const chat = await options.store.getChat(chatId);

    if (!chat) return reply.code(404).send({ error: 'Not found' });

    return chat;
  });

  app.post<{ Params: { chatId: string }; Body?: { restart?: boolean } }>(
    '/api/chats/:chatId/backfill',
    async (request, reply) => {
      const { chatId } = request.params;
      const body = request.body ?? {};

      if (
        !validChatId(chatId) ||
        Object.keys(body).some((key) => key !== 'restart') ||
        (body.restart !== undefined && typeof body.restart !== 'boolean')
      )
        return reply.code(400).send({ error: 'Invalid request' });

      const id = await options.store.enqueueBackfill(chatId, body.restart ?? false);

      return reply.code(202).send({ jobId: id });
    },
  );

  app.get<{ Params: { chatId: string } }>('/api/chats/:chatId/backfill', async (request, reply) => {
    const { chatId } = request.params;

    if (!validChatId(chatId)) return reply.code(400).send({ error: 'Invalid request' });

    if (!(await options.store.getChat(chatId))) return reply.code(404).send({ error: 'Not found' });

    return options.store.checkpoint(chatId);
  });

  app.get<{ Params: { chatId: string } }>('/api/chats/:chatId/progress', async (request, reply) => {
    const { chatId } = request.params;

    if (!validChatId(chatId)) return reply.code(400).send({ error: 'Invalid request' });

    if (!(await options.store.getChat(chatId))) return reply.code(404).send({ error: 'Not found' });

    const [history, storedMessages, index, chunks, summary] = await Promise.all([
      options.db.syncCheckpoint.findUnique({
        where: { chatId_kind: { chatId, kind: 'BACKFILL' } },
        select: { state: true, lastSuccessAt: true, updatedAt: true },
      }),
      options.db.message.count({ where: { chatId } }),
      options.db.indexingState.findUnique({
        where: { chatId },
        select: { updatedAt: true, openIds: true },
      }),
      options.db.$queryRaw<Array<{ indexed_messages: bigint; indexed_chunks: bigint }>>`
        SELECT COUNT(DISTINCT m.message_id) AS indexed_messages,
          COUNT(DISTINCT c.id) AS indexed_chunks
        FROM conversation_chunks c
        LEFT JOIN LATERAL unnest(c.message_ids) AS member(message_id) ON true
        LEFT JOIN messages m ON m.chat_id = c.chat_id AND m.message_id = member.message_id
        WHERE c.chat_id = ${chatId} AND c.status = 'FINALIZED'
          AND c.embedding_model = ${options.embeddingModel} AND c.embedding IS NOT NULL`,
      options.db.chatSummary.findUnique({
        where: { chatId },
        select: { status: true, processed: true, since: true, updatedAt: true },
      }),
    ]);

    return {
      history: {
        state: history?.state ?? 'NOT_STARTED',
        lastSuccessAt: history?.lastSuccessAt ?? null,
        updatedAt: history?.updatedAt ?? null,
      },
      storedMessages,
      indexedMessages: Number(chunks[0]?.indexed_messages ?? 0),
      indexedChunks: Number(chunks[0]?.indexed_chunks ?? 0),
      bufferedMessages: index?.openIds.length ?? 0,
      indexUpdatedAt: index?.updatedAt ?? null,
      summary: summary ?? { status: 'NOT_STARTED', processed: 0, since: null, updatedAt: null },
    };
  });

  app.get('/api/profile', async () => {
    const profile = await options.db.ownerProfile.findUnique({ where: { id: 1 } });

    return {
      name: profile?.name ?? '',
      about: profile?.about ?? '',
      work: profile?.work ?? '',
      interests: profile?.interests ?? '',
      style: profile?.style ?? '',
      boundaries: profile?.boundaries ?? 'Не раскрывать секреты и личные сведения собеседников.',
      updatedAt: profile?.updatedAt ?? null,
    };
  });

  app.put<{ Body: unknown }>('/api/profile', async (request, reply) => {
    const body = request.body;

    if (!validProfile(body)) return reply.code(400).send({ error: 'Invalid request' });

    const data = {
      name: body.name,
      about: body.about,
      work: body.work,
      interests: body.interests,
      style: body.style,
      boundaries: body.boundaries,
    };
    const profile = await options.db.ownerProfile.upsert({
      where: { id: 1 },
      create: { id: 1, ...data },
      update: { ...data, updatedAt: new Date() },
    });

    return { ...data, updatedAt: profile.updatedAt };
  });

  app.put<{ Params: { chatId: string }; Body: { expectedVersion?: number; patch?: ChatPatch } }>(
    '/api/chats/:chatId',
    async (request, reply) => {
      const { chatId } = request.params;
      const body = request.body;

      if (
        !validChatId(chatId) ||
        !body ||
        !Number.isSafeInteger(body.expectedVersion) ||
        typeof body.patch !== 'object' ||
        body.patch === null ||
        Array.isArray(body.patch) ||
        Object.keys(body).some((key) => !['expectedVersion', 'patch'].includes(key))
      )
        return reply.code(400).send({ error: 'Invalid request' });

      try {
        return await options.store.updateChat(chatId, body.patch, body.expectedVersion ?? -1);
      } catch (error) {
        if (error instanceof ConflictError) throw error;

        return reply.code(400).send({ error: 'Invalid request' });
      }
    },
  );

  app.post('/api/system/pause', async () => {
    await options.store.setPaused(true);

    return { paused: true };
  });

  app.post('/api/system/resume', async () => {
    await options.store.setPaused(false);

    return { paused: false };
  });

  app.get('/api/status', async () => {
    const [system, pendingOutbox, unknownSends] = await Promise.all([
      options.db.systemState.findUnique({ where: { id: 1 }, select: { paused: true } }),
      options.db.jobOutbox.count({ where: { publishedAt: null } }),
      options.db.replyOperation.count({ where: { status: 'UNKNOWN' } }),
    ]);

    return {
      paused: system?.paused ?? true,
      autoreplyEnabled: options.autoreplyEnabled ?? false,
      pendingOutbox,
      unknownSends,
    };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/sends/unknown', async (request, reply) => {
    const limit = request.query.limit === undefined ? 20 : Number(request.query.limit);

    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      Object.keys(request.query).some((key) => key !== 'limit')
    )
      return reply.code(400).send({ error: 'Invalid request' });

    const operations = await options.db.replyOperation.findMany({
      where: { status: 'UNKNOWN' },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        chatId: true,
        triggerMessageId: true,
        generatedText: true,
        updatedAt: true,
      },
    });

    return { items: operations };
  });

  app.post<{
    Params: { id: string };
    Body: {
      outcome?: 'SENT' | 'NOT_SENT';
      telegramMessageId?: string;
      confirm?: string;
    };
  }>('/api/sends/:id/reconcile', async (request, reply) => {
    const { id } = request.params;
    const body = request.body;

    if (
      !validUuid(id) ||
      !body ||
      body.confirm !== `RECONCILE ${id}` ||
      (body.outcome !== 'SENT' && body.outcome !== 'NOT_SENT') ||
      Object.keys(body).some((key) => !['outcome', 'telegramMessageId', 'confirm'].includes(key))
    )
      return reply.code(400).send({ error: 'Invalid request' });

    const operation = await options.db.replyOperation.findUnique({ where: { id } });

    if (!operation || operation.status !== 'UNKNOWN')
      return reply.code(404).send({ error: 'Not found' });

    if (body.outcome === 'SENT') {
      const messageId = body.telegramMessageId;

      if (!messageId || !/^\d+$/.test(messageId))
        return reply.code(400).send({ error: 'Invalid request' });

      const history = await options.gateway.getHistory(operation.chatId, undefined, 100);
      const match = history.items.find(
        (message) =>
          message.messageId === messageId &&
          message.direction === 'OUTGOING' &&
          message.text === operation.generatedText &&
          message.replyToMessageId === operation.triggerMessageId,
      );

      if (!match) return reply.code(409).send({ error: 'Conflict' });
    } else if (body.telegramMessageId !== undefined) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    if (!(await options.store.reconcileSend(id, body.outcome, body.telegramMessageId)))
      return reply.code(409).send({ error: 'Conflict' });

    return { status: body.outcome === 'SENT' ? 'SENT' : 'CANCELLED' };
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/api/drafts',
    async (request, reply) => {
      const limit = request.query.limit === undefined ? 20 : Number(request.query.limit);
      const cursor = request.query.cursor;

      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (cursor !== undefined && !validUuid(cursor)) ||
        Object.keys(request.query).some((key) => !['limit', 'cursor'].includes(key))
      )
        return reply.code(400).send({ error: 'Invalid request' });

      const rows = await options.db.draft.findMany({
        where: { status: 'PENDING' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      return {
        items: rows.slice(0, limit).map((row) => ({
          id: row.id,
          chatId: row.chatId,
          text: row.text,
          triggerMessageId: row.triggerMessageId,
          createdAt: row.createdAt,
        })),
        nextCursor: rows.length > limit ? rows[limit - 1]?.id : null,
      };
    },
  );

  app.post<{ Params: { id: string } }>('/api/drafts/:id/approve', async (request, reply) => {
    if (!validUuid(request.params.id)) return reply.code(400).send({ error: 'Invalid request' });

    const draft = await options.db.draft.findUnique({ where: { id: request.params.id } });

    if (!draft || draft.status !== 'PENDING') return reply.code(404).send({ error: 'Not found' });

    const generation = Number(draft.generation);

    if (!Number.isSafeInteger(generation)) return reply.code(409).send({ error: 'Conflict' });

    await options.dispatcher.dispatch(
      {
        chatId: draft.chatId,
        triggerMessageId: draft.triggerMessageId,
        generation,
        configVersion: draft.configVersion,
      },
      {
        text: draft.text,
        model: 'approved-draft',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      },
      true,
    );

    const updated = await options.db.draft.findUnique({ where: { id: draft.id } });

    if (updated?.status !== 'APPROVED') return reply.code(409).send({ error: 'Conflict' });

    return { status: 'APPROVED' };
  });

  app.post<{ Params: { id: string } }>('/api/drafts/:id/reject', async (request, reply) => {
    if (!validUuid(request.params.id)) return reply.code(400).send({ error: 'Invalid request' });

    if (!(await options.store.rejectDraft(request.params.id)))
      return reply.code(404).send({ error: 'Not found' });

    return { status: 'REJECTED' };
  });

  app.get('/api/usage', async () => {
    const usage = await options.db.llmUsage.aggregate({
      _count: { requestId: true },
      _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true },
    });

    return {
      requests: usage._count.requestId,
      inputTokens: usage._sum.inputTokens ?? 0,
      outputTokens: usage._sum.outputTokens ?? 0,
      estimatedCostUsd: usage._sum.estimatedCostUsd?.toString() ?? null,
    };
  });

  app.delete<{ Params: { chatId: string }; Body: { confirm?: string } }>(
    '/api/chats/:chatId/data',
    async (request, reply) => {
      const chatId = request.params.chatId;

      if (
        !validChatId(chatId) ||
        !request.body ||
        request.body.confirm !== `PURGE ${chatId}` ||
        Object.keys(request.body).length !== 1
      )
        return reply.code(400).send({ error: 'Invalid request' });

      if (!(await options.store.purgeChat(chatId)))
        return reply.code(404).send({ error: 'Not found' });

      return { purged: true };
    },
  );

  return app;
}
