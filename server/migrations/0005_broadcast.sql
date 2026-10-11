-- BVR Hockey 26: news to the players — a push from the bot to everyone who played (docs/EVENTS.md «Рассылка»).
-- Apply: cd server && ../node_modules/.bin/wrangler d1 migrations apply DB --remote

-- 1: the bot cannot write to this player (blocked it, never opened its chat, deleted the account): later news skip
-- them; cleared when they write to the bot (coins.js botMessage → botBack)
ALTER TABLE users ADD COLUMN bot_gone INTEGER NOT NULL DEFAULT 0;

-- who got which news: one row per (news, player), so a repeat never sends the same news twice
CREATE TABLE bcast_sent (
  bcast    TEXT    NOT NULL,                  -- the news id ('upd-1310')
  user_id  INTEGER NOT NULL,
  status   TEXT    NOT NULL,                  -- 'sent' | 'gone' | 'fail'
  at       INTEGER NOT NULL,                  -- unix, s
  PRIMARY KEY (bcast, user_id)
);
