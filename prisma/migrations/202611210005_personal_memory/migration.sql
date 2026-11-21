CREATE TABLE chat_summaries (
  chat_id text PRIMARY KEY,
  since timestamptz NOT NULL,
  cursor_at timestamptz,
  cursor_message_id text,
  content text NOT NULL DEFAULT '',
  processed integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE owner_profile (
  id integer PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  about text NOT NULL DEFAULT '',
  work text NOT NULL DEFAULT '',
  interests text NOT NULL DEFAULT '',
  style text NOT NULL DEFAULT '',
  boundaries text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
