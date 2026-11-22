-- Search matches word forms (eval R02: "return window policy" missed a fact that says "Returns"). 0141's indexes used
-- FTS5's default tokenizer (unicode61), which matches exact words only. FTS5's built-in porter tokenizer stems each
-- token, at index and at query time, so "return", "returns" and "returned" are one term
-- (https://www.sqlite.org/fts5.html, "The Porter Tokenizer"). 'porter unicode61' keeps unicode61 underneath (case
-- folding and diacritics as before). A tokenizer is fixed when the table is made, so each index is dropped and made
-- again. Only the derived indexes change: memories and chat_messages keep every row, and 0141's triggers stay (they
-- name the tables, so they write to the new ones). Then each index is rebuilt from its table, as 0141 did.
DROP TABLE memories_fts;
CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='n', tokenize='porter unicode61');
INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
DROP TABLE chat_messages_fts;
CREATE VIRTUAL TABLE chat_messages_fts USING fts5(text, content='chat_messages', content_rowid='n', tokenize='porter unicode61');
INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('rebuild');
