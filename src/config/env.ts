export interface Settings {
  autoreplyEnabled: boolean;
  adminHost: string;
  adminPort: number;
  adminJwtSecret: string;
  adminPublicKeyFile: string;
  telegramApiId: number;
  telegramApiHash: string;
  expectedAccountId: string;
  sessionFile: string;
  openaiApiKey: string;
  model: string;
  embeddingModel: string;
  databaseUrl: string;
  redisUrl: string;
  workerConcurrency: number;
  retentionDays: number;
  dailyBudgetUsd: number;
  prices: { input: number; output: number; cached: number };
  priceVersion: string;
  priceEffectiveAt: Date;
}

export function loadSettings(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Settings> {
  const required = (key: string): string => {
    const value = env[key]?.trim();

    if (!value) throw new Error(`Missing configuration: ${key}`);

    return value;
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const value = env[key] ?? String(fallback);

    if (!/^\d+$/.test(value)) throw new Error(`Invalid configuration: ${key}`);

    const number = Number(value);

    if (!Number.isSafeInteger(number) || number < min || number > max)
      throw new Error(`Invalid configuration: ${key}`);

    return number;
  };
  const url = (key: string, protocols: string[]): string => {
    const value = required(key);

    try {
      if (!protocols.includes(new URL(value).protocol)) throw new Error();
    } catch {
      throw new Error(`Invalid configuration: ${key}`);
    }

    return value;
  };
  const enabled = env.AUTOREPLY_ENABLED ?? 'false';

  if (enabled !== 'true' && enabled !== 'false')
    throw new Error('Invalid configuration: AUTOREPLY_ENABLED');

  const money = (key: string): number => {
    const value = env[key] ?? '0';

    if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error(`Invalid configuration: ${key}`);

    const number = Number(value);

    if (!Number.isFinite(number) || number > 10000)
      throw new Error(`Invalid configuration: ${key}`);

    return number;
  };
  const priceVersion = env.LLM_PRICE_VERSION ?? '';
  const priceDate = env.LLM_PRICE_EFFECTIVE_DATE ?? '';

  if (
    enabled === 'true' &&
    (!/^[A-Za-z0-9._-]{1,64}$/.test(priceVersion) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(priceDate) ||
      !Number.isFinite(Date.parse(priceDate)) ||
      !env.LLM_DAILY_BUDGET_USD ||
      !env.LLM_INPUT_USD_PER_MILLION ||
      !env.LLM_OUTPUT_USD_PER_MILLION ||
      !env.LLM_CACHED_USD_PER_MILLION)
  )
    throw new Error('Missing LLM budget or pricing configuration');

  const adminHost = env.ADMIN_HOST ?? '127.0.0.1';

  if (
    adminHost !== '127.0.0.1' &&
    adminHost !== '::1' &&
    !(adminHost === '0.0.0.0' && env.ADMIN_ALLOW_CONTAINER_BIND === 'true')
  )
    throw new Error('Admin API requires loopback binding');

  const adminJwtSecret = required('ADMIN_JWT_SECRET');

  if (Buffer.byteLength(adminJwtSecret) < 32 || /replace|placeholder/i.test(adminJwtSecret))
    throw new Error('Invalid configuration: ADMIN_JWT_SECRET');

  const expectedAccountId = required('TELEGRAM_EXPECTED_ACCOUNT_ID');

  if (!/^[1-9]\d*$/.test(expectedAccountId))
    throw new Error('Invalid configuration: TELEGRAM_EXPECTED_ACCOUNT_ID');

  const telegramApiHash = required('TELEGRAM_API_HASH');

  if (!/^[a-f\d]{32}$/i.test(telegramApiHash))
    throw new Error('Invalid configuration: TELEGRAM_API_HASH');

  return Object.freeze({
    autoreplyEnabled: enabled === 'true',
    adminHost,
    adminPort: integer('ADMIN_PORT', 8787, 1, 65535),
    adminJwtSecret,
    adminPublicKeyFile: required('ADMIN_PUBLIC_KEY_FILE'),
    telegramApiId: integer('TELEGRAM_API_ID', 0, 1, 2147483647),
    telegramApiHash,
    expectedAccountId,
    sessionFile: env.TELEGRAM_SESSION_FILE ?? '.telegram-session',
    openaiApiKey: required('OPENAI_API_KEY'),
    model: required('OPENAI_MODEL'),
    embeddingModel: required('OPENAI_EMBEDDING_MODEL'),
    databaseUrl: url('DATABASE_URL', ['postgres:', 'postgresql:']),
    redisUrl: url('REDIS_URL', ['redis:', 'rediss:']),
    workerConcurrency: integer('WORKER_CONCURRENCY', 2, 1, 16),
    retentionDays: integer('RETENTION_DAYS', 30, 1, 365),
    dailyBudgetUsd: money('LLM_DAILY_BUDGET_USD'),
    prices: {
      input: money('LLM_INPUT_USD_PER_MILLION'),
      output: money('LLM_OUTPUT_USD_PER_MILLION'),
      cached: money('LLM_CACHED_USD_PER_MILLION'),
    },
    priceVersion,
    priceEffectiveAt: new Date(priceDate || '1970-01-01'),
  });
}
