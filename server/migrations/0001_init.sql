-- BVR Hockey 26: coins and player stats (docs/EVENTS.md, «Схема D1»).
-- Apply: cd server && ../node_modules/.bin/wrangler d1 migrations apply DB --remote

CREATE TABLE users (
  user_id     INTEGER PRIMARY KEY,            -- Telegram user.id
  name        TEXT,
  coins       INTEGER NOT NULL DEFAULT 0,
  stars       INTEGER NOT NULL DEFAULT 0,
  matches     INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  draws       INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,     -- 'left' counts as a loss
  goals       INTEGER NOT NULL DEFAULT 0,     -- goals of the player's team
  goals_against INTEGER NOT NULL DEFAULT 0,
  streak      INTEGER NOT NULL DEFAULT 0,     -- wins in a row now
  best_streak INTEGER NOT NULL DEFAULT 0,
  online      INTEGER NOT NULL DEFAULT 0,     -- matches against a person
  created_at  INTEGER NOT NULL,               -- unix, s
  updated_at  INTEGER NOT NULL
);

CREATE TABLE matches (
  user_id     INTEGER NOT NULL REFERENCES users(user_id),
  match_id    TEXT    NOT NULL,
  mode        TEXT    NOT NULL,               -- 'ai' | 'online'
  role        TEXT    NOT NULL,               -- 'solo' | 'host' | 'guest'
  team        INTEGER NOT NULL,
  len         INTEGER NOT NULL,
  played      INTEGER NOT NULL,
  score_my    INTEGER NOT NULL,
  score_op    INTEGER NOT NULL,
  result      TEXT    NOT NULL,               -- 'win' | 'loss' | 'draw' | 'left'
  summary     TEXT    NOT NULL,               -- the whole match:summary (JSON)
  reward      INTEGER NOT NULL DEFAULT 0,
  verdict     TEXT    NOT NULL,               -- 'ok' | 'capped' | 'left' | 'rejected:<reason>'
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, match_id)
);
CREATE INDEX matches_by_user_time ON matches(user_id, created_at);
CREATE INDEX matches_by_id ON matches(match_id);

-- every balance change: a row here + UPDATE users in one batch
CREATE TABLE ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(user_id),
  delta         INTEGER NOT NULL,
  currency      TEXT    NOT NULL DEFAULT 'coins',
  reason        TEXT    NOT NULL,               -- 'match_ai' | 'match_duo' | 'purchase' | 'admin' | …
  ref           TEXT,                           -- match_id / item / idempotency key
  balance_after INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX ledger_idem ON ledger(user_id, reason, ref);
CREATE INDEX ledger_by_user_time ON ledger(user_id, reason, created_at);

CREATE TABLE inventory (                         -- shop phase
  user_id     INTEGER NOT NULL REFERENCES users(user_id),
  item_id     TEXT    NOT NULL,
  source      TEXT    NOT NULL,                  -- 'purchase' | 'reward' | 'gift'
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
