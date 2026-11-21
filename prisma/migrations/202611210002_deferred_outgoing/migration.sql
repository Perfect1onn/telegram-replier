CREATE TABLE deferred_outgoing (
  chat_id text NOT NULL REFERENCES allowed_chats(chat_id),
  message_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (chat_id, message_id),
  FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, message_id)
);
