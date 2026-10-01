-- BVR Hockey 26: who the player is, for the developer's page (docs/EVENTS.md «Страница разработчика»).
-- Filled on every signed API request (coins.js touch) from the verified initData and the X-Tg-Platform header.
-- Nothing else about players is collected.
-- Apply: cd server && ../node_modules/.bin/wrangler d1 migrations apply DB --remote

ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN language_code TEXT;
ALTER TABLE users ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN platform TEXT;          -- Telegram.WebApp.platform: ios, android, tdesktop, macos, weba, …
ALTER TABLE users ADD COLUMN last_seen INTEGER;      -- unix, s; refreshed at most every 5 minutes

CREATE INDEX users_last_seen ON users(last_seen);
CREATE INDEX users_created ON users(created_at);
CREATE INDEX matches_by_time ON matches(created_at);
