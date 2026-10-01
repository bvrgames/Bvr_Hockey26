-- BVR Hockey 26: coin stakes on a match with a friend (server mode), docs/EVENTS.md «Ставка на матч».
-- Apply: cd server && ../node_modules/.bin/wrangler d1 migrations apply DB --remote

-- one stake = one match (the match id is the key): locked from both before the start, settled once by the room's result
CREATE TABLE stakes (
  match_id    TEXT    PRIMARY KEY,
  room        TEXT    NOT NULL,
  amount      INTEGER NOT NULL,              -- coins from each player
  host_uid    INTEGER NOT NULL REFERENCES users(user_id),   -- slot 0, team 0
  guest_uid   INTEGER NOT NULL REFERENCES users(user_id),   -- slot 1, team 1
  len         INTEGER NOT NULL,              -- match length, s
  status      TEXT    NOT NULL,              -- 'locked' | 'settled'
  outcome     TEXT,                          -- 'host' | 'guest' (took both stakes) | 'draw' | 'refund'
  created_at  INTEGER NOT NULL,
  deadline    INTEGER NOT NULL,              -- still locked after this (no result from the room) → refund
  settled_at  INTEGER
);
CREATE INDEX stakes_host_open ON stakes(host_uid, status);
CREATE INDEX stakes_guest_open ON stakes(guest_uid, status);

-- a balance never goes below zero: a stake (or a purchase later) the player cannot pay aborts its whole batch
CREATE TRIGGER users_coins_nonneg BEFORE UPDATE OF coins ON users
WHEN NEW.coins < 0
BEGIN
  SELECT RAISE(ABORT, 'insufficient coins');
END;
