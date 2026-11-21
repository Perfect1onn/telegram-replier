CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE allowed_chats (
 chat_id text PRIMARY KEY CHECK (chat_id ~ '^[0-9]+$'), enabled boolean NOT NULL DEFAULT false,
 mode text NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF','DRAFT','AUTO')),
 system_prompt text, reply_delay_ms integer NOT NULL DEFAULT 12000 CHECK(reply_delay_ms BETWEEN 1000 AND 300000),
 recent_message_limit integer NOT NULL DEFAULT 15 CHECK(recent_message_limit BETWEEN 1 AND 50),
 cancel_on_manual_reply boolean NOT NULL DEFAULT true,
 max_replies_per_hour integer NOT NULL DEFAULT 20 CHECK(max_replies_per_hour BETWEEN 1 AND 100),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE messages (
 chat_id text NOT NULL REFERENCES allowed_chats(chat_id), message_id text NOT NULL,
 sender_id text NOT NULL, direction text NOT NULL CHECK(direction IN ('INCOMING','OUTGOING')),
 source text NOT NULL CHECK(source IN ('TELEGRAM','AI')), text text NOT NULL,
 occurred_at timestamptz NOT NULL, reply_to_message_id text, edited_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(chat_id,message_id)
);
CREATE INDEX messages_recent ON messages(chat_id,occurred_at DESC,message_id DESC);
CREATE TABLE chat_runtime_state (
 chat_id text PRIMARY KEY REFERENCES allowed_chats(chat_id), generation bigint NOT NULL DEFAULT 0,
 last_manual_outgoing_at timestamptz, last_telegram_message_id text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sync_checkpoints (
 chat_id text NOT NULL REFERENCES allowed_chats(chat_id), kind text NOT NULL CHECK(kind IN ('BACKFILL','CATCHUP')),
 cursor text, state text NOT NULL DEFAULT 'PENDING', last_success_at timestamptz, last_error_code text,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(chat_id,kind)
);
CREATE TABLE conversation_chunks (
 id uuid PRIMARY KEY, chat_id text NOT NULL REFERENCES allowed_chats(chat_id), content text NOT NULL,
 first_message_id text NOT NULL, last_message_id text NOT NULL, message_ids text[] NOT NULL,
 status text NOT NULL CHECK(status IN ('OPEN','FINALIZED')), token_count integer NOT NULL CHECK(token_count>=0),
 embedding_model text NOT NULL, embedding vector(1536), content_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(chat_id,content_hash,embedding_model)
);
CREATE INDEX chunks_chat ON conversation_chunks(chat_id);
CREATE TABLE reply_operations (
 id uuid PRIMARY KEY, chat_id text NOT NULL REFERENCES allowed_chats(chat_id), generation bigint NOT NULL,
 config_version integer NOT NULL, trigger_message_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('PENDING','GENERATING','DRAFT','SENDING','SENT','UNKNOWN','CANCELLED','REJECTED')),
 dedupe_key text NOT NULL UNIQUE, generated_text text, telegram_message_id text, attempts integer NOT NULL DEFAULT 0,
 error_category text, due_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(chat_id,generation)
);
CREATE UNIQUE INDEX one_unresolved_send ON reply_operations(chat_id) WHERE status IN ('SENDING','UNKNOWN');
CREATE TABLE drafts (
 id uuid PRIMARY KEY REFERENCES reply_operations(id), chat_id text NOT NULL REFERENCES allowed_chats(chat_id),
 trigger_message_id text NOT NULL, text text NOT NULL, status text NOT NULL DEFAULT 'PENDING'
 CHECK(status IN ('PENDING','APPROVED','REJECTED','EXPIRED')), generation bigint NOT NULL, config_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE llm_usage (
 request_id uuid PRIMARY KEY, chat_id text NOT NULL REFERENCES allowed_chats(chat_id), model text NOT NULL,
 input_tokens integer NOT NULL CHECK(input_tokens>=0), output_tokens integer NOT NULL CHECK(output_tokens>=0),
 cached_input_tokens integer NOT NULL CHECK(cached_input_tokens>=0 AND cached_input_tokens<=input_tokens),
 estimated_cost_usd numeric(20,10), price_version text, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor text NOT NULL, action text NOT NULL,
 chat_id text, outcome text NOT NULL, reason text NOT NULL, correlation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE system_state (
 id integer PRIMARY KEY CHECK(id=1), paused boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_state(id) VALUES(1);
CREATE TABLE job_outbox (
 id uuid PRIMARY KEY, chat_id text NOT NULL REFERENCES allowed_chats(chat_id), task_type text NOT NULL,
 generation bigint NOT NULL, payload jsonb NOT NULL, due_at timestamptz NOT NULL,
 published_at timestamptz, attempts integer NOT NULL DEFAULT 0, UNIQUE(chat_id,generation,task_type)
);
