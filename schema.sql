-- 小豆邀请码公共码池 · D1 schema
CREATE TABLE IF NOT EXISTS codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  note        TEXT    DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'available', -- available | claimed | dead
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  donor       TEXT    NOT NULL,          -- 投码人 IP 的哈希
  claimed_at  INTEGER,
  claimer     TEXT,                      -- 领码人 IP 的哈希
  ok_votes    INTEGER NOT NULL DEFAULT 0,
  used_votes  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_codes_pool ON codes (status, expires_at, created_at);

CREATE TABLE IF NOT EXISTS actions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  who     TEXT    NOT NULL,              -- IP 哈希
  kind    TEXT    NOT NULL,              -- give | claim | feedback
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_who ON actions (who, kind, at);
