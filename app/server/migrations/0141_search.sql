-- P3 search (p3-design section 10, W6): FTS5 indexes over memories.text and chat_messages.text. Derived, never
-- canonical: external-content tables keyed on each source's `n`, kept in step by triggers, rebuilt from the source by
-- `rebuildSearchIndexes` (server/mcp/search-index.ts) after a restore. Triggers don't backfill, so each index is rebuilt
-- here once, over the rows written before this migration. D1 export refuses databases with virtual tables (P8 drops and
-- recreates them around an export).
CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='n');
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.n, new.text);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.n, old.text);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.n, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.n, new.text);
END;
CREATE VIRTUAL TABLE chat_messages_fts USING fts5(text, content='chat_messages', content_rowid='n');
CREATE TRIGGER chat_messages_fts_insert AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(rowid, text) VALUES (new.n, new.text);
END;
CREATE TRIGGER chat_messages_fts_delete AFTER DELETE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, text) VALUES ('delete', old.n, old.text);
END;
CREATE TRIGGER chat_messages_fts_update AFTER UPDATE OF text ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, text) VALUES ('delete', old.n, old.text);
  INSERT INTO chat_messages_fts(rowid, text) VALUES (new.n, new.text);
END;
INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('rebuild');
