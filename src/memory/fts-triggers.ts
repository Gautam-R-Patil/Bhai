// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Triggers that keep the standalone FTS5 mirrors in sync on delete/update.
// The FTS tables have no content= table, so rows are removed with a plain
// DELETE: FTS5's 'delete' command only exists for external-content tables, and
// using it made every UPDATE/DELETE on the source table fail with
// "SQL logic error". Each is dropped first so existing databases get these
// bodies (CREATE ... IF NOT EXISTS would keep the broken ones).

export const MEMORIES_FTS_SYNC_SQL = `
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_au;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = old.id;
  DELETE FROM memories_fts_trigram WHERE rowid = old.id;
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = old.id;
  INSERT OR REPLACE INTO memories_fts(rowid, content, category, tags)
  VALUES (new.id, new.content, new.category, new.tags);
  DELETE FROM memories_fts_trigram WHERE rowid = old.id;
  INSERT OR REPLACE INTO memories_fts_trigram(rowid, content, category, tags)
  VALUES (new.id, new.content, new.category, new.tags);
END;
`;

export const CONVERSATIONS_FTS_SYNC_SQL = `
DROP TRIGGER IF EXISTS conv_msg_ad;
CREATE TRIGGER conv_msg_ad AFTER DELETE ON conversation_messages BEGIN
  DELETE FROM conversations_fts WHERE rowid = old.id;
  DELETE FROM conversations_fts_trigram WHERE rowid = old.id;
END;
`;
