CREATE TABLE indexing_state (
  chat_id text PRIMARY KEY REFERENCES allowed_chats(chat_id),
  version integer NOT NULL DEFAULT 0,
  last_occurred_at timestamptz,
  last_message_id text,
  open_parts text[] NOT NULL DEFAULT '{}',
  open_ids text[] NOT NULL DEFAULT '{}',
  open_last_at timestamptz,
  open_last_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((last_occurred_at IS NULL) = (last_message_id IS NULL)),
  CHECK ((open_last_at IS NULL) = (open_last_id IS NULL))
);
