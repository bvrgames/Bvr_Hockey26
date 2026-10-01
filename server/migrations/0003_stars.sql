-- BVR Hockey 26: in-game stars bought for Telegram Stars (XTR), docs/EVENTS.md «Звёзды».
-- Apply: cd server && ../node_modules/.bin/wrangler d1 migrations apply DB --remote

-- one order = one invoice (createInvoiceLink, payload = id); stars and price are copied from the pack at the time
CREATE TABLE star_orders (
  id           TEXT    PRIMARY KEY,            -- 24 hex; the invoice payload ('u_<charge>' for an unmatched payment)
  user_id      INTEGER NOT NULL REFERENCES users(user_id),
  pack         TEXT    NOT NULL,               -- 's50' | 's120' | 's300' | '?' (unmatched)
  stars        INTEGER NOT NULL,               -- in-game stars the order gives
  price        INTEGER NOT NULL,               -- Telegram Stars paid (XTR)
  status       TEXT    NOT NULL,               -- 'pending' | 'paid' | 'refunded' | 'failed' | 'unmatched'
  charge_id    TEXT,                           -- telegram_payment_charge_id (refundStarPayment needs it)
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER,
  refunded_at  INTEGER,
  refund_short INTEGER NOT NULL DEFAULT 0,     -- stars a refund could not take back (already spent)
  note         TEXT
);
CREATE UNIQUE INDEX star_orders_charge ON star_orders(charge_id);
CREATE INDEX star_orders_user ON star_orders(user_id, created_at);
CREATE INDEX star_orders_status ON star_orders(status, created_at);

-- the stars balance never goes below zero (a refund takes at most what is left)
CREATE TRIGGER users_stars_nonneg BEFORE UPDATE OF stars ON users
WHEN NEW.stars < 0
BEGIN
  SELECT RAISE(ABORT, 'insufficient stars');
END;
