/**
 * The coins store (server/coins.js, STORE) on Cloudflare D1. The SQL is plain SQLite (schema — migrations/), so the
 * same statements run on SQLite anywhere (node:sqlite / better-sqlite3 on a VPS); for Postgres — the notes in
 * docs/EVENTS.md «Перенос API». A D1 batch is one transaction: the match, the totals and the ledger row go in together.
 */
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
    async balance(uid) { const r = await one('SELECT coins FROM users WHERE user_id = ?', uid); return r ? r.coins : 0; },
    async profile(uid) {
      const u = await one('SELECT * FROM users WHERE user_id = ?', uid);
      if (!u) return null;
      const inv = (await db.prepare('SELECT item_id FROM inventory WHERE user_id = ? ORDER BY acquired_at').bind(uid).all()).results;
      return { ...u, inventory: inv.map((r) => r.item_id) };
    },
  };
}
