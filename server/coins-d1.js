/**
 * The coins store (server/coins.js, STORE) on Cloudflare D1. The SQL is plain SQLite (schema — migrations/), so the
 * same statements run on SQLite anywhere (node:sqlite / better-sqlite3 on a VPS); for Postgres — the notes in
 * docs/EVENTS.md «Перенос API». A D1 batch is one transaction: the match, the totals and the ledger row go in together;
 * a stake's lock and its settlement are one batch each (schema — migrations/0002_stakes.sql), so are a star payment and
 * its refund (migrations/0003_stars.sql).
 */
const stakeRow = (r) => ({ id: r.match_id, room: r.room, amount: r.amount, uids: [r.host_uid, r.guest_uid], len: r.len,
  status: r.status, outcome: r.outcome, created: r.created_at, deadline: r.deadline });
const orderRow = (r) => ({ id: r.id, uid: r.user_id, pack: r.pack, stars: r.stars, price: r.price, status: r.status, charge: r.charge_id,
  created: r.created_at, paid: r.paid_at, refunded: r.refunded_at, short: r.refund_short });

export function d1Store(db) {
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  return {
    async matchSeen(uid, id) { return !!(await one('SELECT 1 FROM matches WHERE user_id = ? AND match_id = ?', uid, id)); },
    async lastMatch(uid) {
      const r = await one('SELECT created_at, len FROM matches WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', uid);
      return r ? { at: r.created_at, len: r.len } : null;
    },
    async matchesSince(uid, t) {
      const r = await one('SELECT COUNT(*) AS n FROM matches WHERE user_id = ? AND created_at >= ?', uid, t);
      return r ? r.n : 0;
    },
    async coinsSince(uid, reason, t) {
      const r = await one('SELECT COALESCE(SUM(delta), 0) AS c FROM ledger WHERE user_id = ? AND reason = ? AND created_at >= ?', uid, reason, t);
      return r ? r.c : 0;
    },
    async recordMatch(m) {
      const q = [
        db.prepare('INSERT OR IGNORE INTO users (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(m.uid, m.name, m.now, m.now),
        db.prepare(`INSERT INTO matches (user_id, match_id, mode, role, team, len, played, score_my, score_op, result, summary, reward, verdict, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(m.uid, m.id, m.mode, m.role, m.team, m.len, m.played, m.my, m.op, m.result, m.summary, m.coins, m.verdict, m.now),
        db.prepare(`UPDATE users SET name = ?, coins = coins + ?, matches = matches + 1, wins = wins + ?, draws = draws + ?, losses = losses + ?,
                      goals = goals + ?, goals_against = goals_against + ?,
                      streak = CASE WHEN ? THEN streak + 1 ELSE 0 END,
                      best_streak = MAX(best_streak, CASE WHEN ? THEN streak + 1 ELSE 0 END),
                      online = online + ?, updated_at = ? WHERE user_id = ?`)
          .bind(m.name, m.coins, m.win, m.draw, 1 - m.win - m.draw, m.my, m.op, m.win, m.win, m.online, m.now, m.uid),
      ];
      if (m.coins > 0) {
        q.push(db.prepare(`INSERT INTO ledger (user_id, delta, reason, ref, balance_after, created_at)
                           VALUES (?, ?, ?, ?, (SELECT coins FROM users WHERE user_id = ?), ?)`).bind(m.uid, m.coins, m.reason, m.id, m.uid, m.now));
      }
      try { await db.batch(q); }
      catch (e) {
        // two copies of one request at once: the primary key lets only one through
        if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e && e.message))) return 'duplicate';
        throw e;
      }
      return 'ok';
    },
    // ---- stakes (coins.js «stakes»): the lock and the settlement are one D1 batch each = one transaction
    async stakeLock(s) {
      const q = [
        db.prepare(`INSERT INTO stakes (match_id, room, amount, host_uid, guest_uid, len, status, created_at, deadline)
                    VALUES (?, ?, ?, ?, ?, ?, 'locked', ?, ?)`).bind(s.id, s.room, s.amount, s.uids[0], s.uids[1], s.len, s.now, s.deadline),
      ];
      for (const uid of s.uids) {
        // below zero → the trigger users_coins_nonneg aborts the whole batch; a player without a row → balance_after NULL aborts it
        q.push(db.prepare('UPDATE users SET coins = coins - ?, updated_at = ? WHERE user_id = ?').bind(s.amount, s.now, uid));
        q.push(db.prepare(`INSERT INTO ledger (user_id, delta, reason, ref, balance_after, created_at)
                           VALUES (?, ?, 'stake', ?, (SELECT coins FROM users WHERE user_id = ?), ?)`).bind(uid, -s.amount, s.id, uid, s.now));
      }
      try { await db.batch(q); }
      catch (e) {
        const m = String(e && e.message);
        if (/insufficient|NOT NULL/i.test(m)) return 'funds';
        if (/UNIQUE|PRIMARY KEY|constraint/i.test(m)) return 'duplicate';
        throw e;
      }
      return 'ok';
    },
    async stakeGet(id) {
      const r = await one('SELECT * FROM stakes WHERE match_id = ?', id);
      return r ? stakeRow(r) : null;
    },
    async stakeSettle(id, outcome, pays, now) {
      const locked = "EXISTS (SELECT 1 FROM stakes WHERE match_id = ? AND status = 'locked')";
      const q = [];
      for (const [uid, delta, reason] of pays) {
        q.push(db.prepare(`UPDATE users SET coins = coins + ?, updated_at = ? WHERE user_id = ? AND ${locked}`).bind(delta, now, uid, id));
        q.push(db.prepare(`INSERT INTO ledger (user_id, delta, reason, ref, balance_after, created_at)
                           SELECT ?, ?, ?, ?, (SELECT coins FROM users WHERE user_id = ?), ? WHERE ${locked}`).bind(uid, delta, reason, id, uid, now, id));
      }
      q.push(db.prepare("UPDATE stakes SET status = 'settled', outcome = ?, settled_at = ? WHERE match_id = ? AND status = 'locked'").bind(outcome, now, id));
      try { await db.batch(q); }
      catch (e) { if (/UNIQUE|constraint/i.test(String(e && e.message))) return 'done'; throw e; }
      return 'ok';
    },
    async stakesOverdue(uid, now) {
      const r = await db.prepare(`SELECT * FROM stakes WHERE status = 'locked' AND deadline <= ? AND (host_uid = ? OR guest_uid = ?)`).bind(now, uid, uid).all();
      return r.results.map(stakeRow);
    },
    // ---- stars (coins.js «stars», schema — migrations/0003_stars.sql). Payment and refund are one batch each; every
    // statement of it is guarded by the order's status, and the last one moves the status — a repeat changes nothing.
    async starOrderNew(o) {
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO users (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(o.uid, o.name, o.now, o.now),
        db.prepare(`INSERT INTO star_orders (id, user_id, pack, stars, price, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
          .bind(o.id, o.uid, o.pack, o.stars, o.price, o.now),
      ]);
    },
    async starOrderGet(id) { const r = await one('SELECT * FROM star_orders WHERE id = ?', id); return r ? orderRow(r) : null; },
    async starOrderFail(id, now) { await db.prepare("UPDATE star_orders SET status = 'failed', note = 'no invoice' WHERE id = ? AND status = 'pending'").bind(id).run(); },
    async starOrdersSince(uid, t) {
      const r = await one('SELECT COUNT(*) AS n FROM star_orders WHERE user_id = ? AND created_at >= ?', uid, t);
      return r ? r.n : 0;
    },
    async starPaid(p) {
      const pending = "EXISTS (SELECT 1 FROM star_orders WHERE id = ? AND user_id = ? AND status = 'pending')";
      const res = await db.batch([
        db.prepare(`UPDATE users SET stars = stars + ?, updated_at = ? WHERE user_id = ? AND ${pending}`).bind(p.stars, p.now, p.uid, p.id, p.uid),
        db.prepare(`INSERT INTO ledger (user_id, delta, currency, reason, ref, balance_after, created_at)
                    SELECT ?, ?, 'stars', 'stars_buy', ?, (SELECT stars FROM users WHERE user_id = ?), ? WHERE ${pending}`).bind(p.uid, p.stars, p.id, p.uid, p.now, p.id, p.uid),
        db.prepare("UPDATE star_orders SET status = 'paid', charge_id = ?, paid_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'").bind(p.charge, p.now, p.id, p.uid),
      ]);
      return res[2].meta.changes ? 'ok' : 'repeat';
    },
    async starRefund(p) {
      const o = await one('SELECT * FROM star_orders WHERE charge_id = ?', p.charge);
      if (!o) return { r: 'unknown' };
      if (o.status !== 'paid') return { r: 'repeat', id: o.id };
      const paid = "EXISTS (SELECT 1 FROM star_orders WHERE id = ? AND status = 'paid')";
      const res = await db.batch([
        // the ledger row first: it sees the balance before the refund (taken = what is there, at most the order's stars)
        db.prepare(`INSERT INTO ledger (user_id, delta, currency, reason, ref, balance_after, created_at)
                    SELECT user_id, -MIN(stars, ?), 'stars', 'stars_refund', ?, MAX(stars - ?, 0), ? FROM users WHERE user_id = ? AND ${paid}`)
          .bind(o.stars, o.id, o.stars, p.now, o.user_id, o.id),
        db.prepare(`UPDATE star_orders SET refund_short = ? + COALESCE((SELECT delta FROM ledger WHERE user_id = ? AND reason = 'stars_refund' AND ref = ?), 0)
                    WHERE id = ? AND status = 'paid'`).bind(o.stars, o.user_id, o.id, o.id),
        db.prepare(`UPDATE users SET stars = MAX(stars - ?, 0), updated_at = ? WHERE user_id = ? AND ${paid}`).bind(o.stars, p.now, o.user_id, o.id),
        db.prepare("UPDATE star_orders SET status = 'refunded', refunded_at = ? WHERE id = ? AND status = 'paid'").bind(p.now, o.id),
      ]);
      if (!res[3].meta.changes) return { r: 'repeat', id: o.id };
      const after = await one('SELECT refund_short FROM star_orders WHERE id = ?', o.id);
      const short = after ? after.refund_short : 0;
      return { r: 'ok', id: o.id, uid: o.user_id, taken: o.stars - short, short };
    },
    async starUnmatched(p) {
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO users (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(p.uid, p.name || null, p.now, p.now),
        db.prepare(`INSERT OR IGNORE INTO star_orders (id, user_id, pack, stars, price, status, charge_id, created_at, paid_at, note)
                    VALUES (?, ?, '?', 0, ?, 'unmatched', ?, ?, ?, ?)`).bind('u_' + p.charge.slice(0, 60), p.uid, p.amount, p.charge, p.now, p.now, 'payload ' + p.payload),
      ]);
    },
    async starsBalance(uid) { const r = await one('SELECT stars FROM users WHERE user_id = ?', uid); return r ? r.stars : 0; },
    async balance(uid) { const r = await one('SELECT coins FROM users WHERE user_id = ?', uid); return r ? r.coins : 0; },
    async profile(uid) {
      const u = await one('SELECT * FROM users WHERE user_id = ?', uid);
      if (!u) return null;
      const inv = (await db.prepare('SELECT item_id FROM inventory WHERE user_id = ? ORDER BY acquired_at').bind(uid).all()).results;
      return { ...u, inventory: inv.map((r) => r.item_id) };
    },
  };
}
