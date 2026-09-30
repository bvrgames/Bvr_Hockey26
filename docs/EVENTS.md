# Шина игровых событий

Симуляция только сообщает, что произошло. Всё остальное — звук, вибро, тряска камеры, надписи, статистика, сетевая
пересылка, итог матча — подписывается на события и геймплейный код не трогает. Схема взята из INKWAVE (Jayden Davis,
MIT, см. `THIRD_PARTY.md`).

```js
var off = EV.on('shot', function(e, name){ ... });   // возвращает функцию отписки
EV.on('*', function(e, name){ ... });                 // все события
EV.emit('shot', { p: 3, t: 0, ... });                 // возвращает payload
```

Правила:
- **payload — только простые данные**: номер игрока в `players[]` (`p`, `-1` = нет), команда (`t`: 0/1), числа, строки,
  флаги 0/1. Без ссылок на объекты: те же события уходят гостю по сети, а итог матча — на сервер.
- Ошибка в подписчике не роняет симуляцию: она попадает в `console.error` и `__hk.errors()` (smoke упадёт).
- Подписчики не меняют payload.
- Номер `seq` есть только у пересылаемых событий (по нему гость отбрасывает повторы). `remote: 1` — событие пришло от
  хоста.

## События

Сеть: **да** — хост пересылает событие гостю, у гостя оно вызывает те же подписчики (звук, надписи, статистика).
**нет** — каждая сторона генерирует событие сама.

| событие | payload | где | сеть |
|---|---|---|---|
| `match:start` | `{ id, mode: 'ai'\|'online', role: 'solo'\|'host'\|'guest', team, len, clubs: [a, b], difficulty }` | кнопка «Играть», реванш, у гостя — приход `cfg` | нет |
| `faceoff` | `{ x, z }` — шайба вброшена (переход `face → play`) | `sim` | да |
| `pass` | `{ p, t, to, x, z, power, lift, lead }` — `to` — кому адресован (`-1` — в сторону), `lead` — пас в разрез | `doPass` | да |
| `pass:recv` | `{ p, t, from, aimed, lead }` — пас дошёл до своего (≤ 3 с после паса); `aimed` — принял именно адресат | подбор шайбы | да |
| `pickup` | `{ p, t, prev, turnover?, intercept? }` — полевой подобрал шайбу; `turnover` — до этого касался соперник, `intercept` — перехват паса | подбор шайбы | да |
| `shot` | `{ p, t, x, z, power, dist }` | `doShot` | да |
| `save` | `{ g, t, by, kind: 'line'\|'body', shot, noShot }` — `t` — команда вратаря; `shot: 1` — сейв после броска (идёт в статистику); `noShot: 1` — шайба шла в створ без `doShot` (пас, рикошет) | пересечение створа / подбор вратарём | да |
| `post` | `{ t, p, bar }` — штанга (`bar` — перекладина); `t`, `p` — кто касался последним | `sim` | да |
| `goal` | `{ t, p, assist, own, noShot, z, score: [a, b], clock }` — `p` — автор (последний коснувшийся из забившей команды), `assist` — отдавший ему пас ≤ 10 с назад, `own` — последним касался соперник | `sim` | да |
| `hit` | `{ p, t, v, vt, clean, hard, x, z }` — силовой `p` → `v`; `hard: 1` — кнопкой / `doCheck`, `0` — сбил ИИ на ходу; `clean: 0` — нарушение (за ним идёт `penalty`) | `doCheck`, ИИ | да |
| `poke` | `{ p, t, from, btn? }` — выбил шайбу у владельца; `btn` — кнопкой | `doPoke`, ИИ | да |
| `penalty` | `{ p, t, reason }` — `reason: 'interference'` | `penalize` | да |
| `stoppage` | `{ reason: 'offside'\|'icing'\|'penalty', t }` — свисток и вбрасывание; `t` — команда-нарушитель | `whistle` | да |
| `match:end` | `{ score: [a, b], reason: 'time' }` | конец времени | да |
| `match:abort` | `{ score }` — вышли в меню посреди матча (итог не отправляется) | `backToMenu` | нет |
| `match:summary` | итог матча, см. ниже | подписчик `match:end` | нет |
| `match:reward` | ответ Worker'а на итог (`{ coins, balance, ... }`) | после отправки | нет |

Не события (остались прямыми вызовами, потому что чисто локальные): отскок от бортов (`SFX.stick`), смена игрока
(`SFX.swap`), предупреждение об отложенном офсайде.

## Подписчики сейчас

| подписчик | что делает |
|---|---|
| звук / вибро / камера / надписи | ровно то, что раньше было вписано в симуляцию (`SFX.*`, `buzz`, `cam.shake`, `flash`) |
| статистика `STATS` | считает всё по событиям, одинаково у хоста и гостя |
| сеть | хост кладёт пересылаемые события в снимок, гость проигрывает их у себя |
| итог | на `match:end` строит `match:summary`, ставит в очередь отправки |

## Статистика матча

`__hk.stats()` — полная, `__hk.snap().stats` — кратко, по командам `[команда 0, команда 1]`.

| поле | как считается |
|---|---|
| `shots` | броски (`shot`) + голы и сейвы с `noShot` — гол всегда считается броском |
| `sog` | броски в створ = голы команды (кроме автоголов) + сейвы вратаря соперника |
| `goals` | `goal.t` |
| `passes` / `passesDone` | `pass` / `pass:recv` |
| `saves` | `save` с `shot: 1` (подбор случайной шайбы вратарём сейвом не считается; один бросок — не больше одного сейва) |
| `hits` | `hit` (оба вида) |
| `pokes`, `takeaways`, `penalties`, `posts` | `poke`, `pickup.turnover`, `penalty`, `post` |
| `faceoffs`, `events` | число вбрасываний / всех событий за матч |

По игрокам (`STATS.players[i]`): `g` голы, `a` передачи, `s` броски, `h` силовые.

Проверяется автоматически: `npm run smoke` (голы в статистике = счёт, `sog ≤ shots`, `sog ≥ сейвы соперника`,
дошедших пасов не больше, чем пасов) и `npm run smoke:online` (статистика гостя = статистике хоста).

## Сеть

Хост добавляет в снимок `{t:'s', d:[...], e:[[name, payload], ...]}`. Каждое событие едет в трёх снимках подряд
(на случай потери), гость проигрывает только события с `seq` больше последнего увиденного (`NET.evSeen`, сбрасывается
на `cfg`). После конца матча хост продолжает слать снимки (6 в секунду), чтобы до гостя дошли финальное состояние и
`match:end`. Id матча хост передаёт в `cfg` (`id`), у обоих клиентов он одинаковый — сервер по нему сверит два отчёта.

Протокол релея не меняется: `server/worker.js` пересылает сообщения как есть. Локальная копия для тестов —
`tools/relay-mock.mjs`.

---

# Итог матча и бэкенд (план; сервер делается отдельной фазой)

Архитектура:
- live-матч на двоих — Cloudflare Worker `bvr-hockey-relay` (как сейчас), симуляция у хоста;
- **монеты, звёзды, статистика, покупки — Cloudflare Worker + D1**. Каждый запрос подписан Telegram `initData`,
  Worker проверяет подпись (HMAC с токеном бота). **Клиент монеты не начисляет** — он сообщает, как прошёл матч,
  а сколько начислить, решает сервер;
- Telegram CloudStorage — только настройки, выбранный скин и кэш профиля.

## `match:summary` (клиент → Worker)

```js
{ v: 1,                          // версия формата
  id: 'a6889b11fb5eac17e71dc3c1', // 96 бит случайно; у хоста и гостя одинаковый
  client: 1,                     // CLIENT_VER
  mode: 'ai' | 'online', role: 'solo' | 'host' | 'guest',
  team: 0 | 1,                   // за кого играл отправитель
  difficulty: 'easy' | 'normal' | 'hard' | null,   // уровень ИИ соперника; null — матч на двоих
  clubs: [3, 5],                 // индексы CLUBS
  len: 180,                      // заявленная длина, с
  played: 186,                   // реально прошло в матче (без меню и паузы), с
  startedAt, endedAt,            // Date.now() клиента, мс
  score: [2, 1], result: 'win' | 'loss' | 'draw' | 'left',   // result — с точки зрения team; 'left' — см. disconnect
  net: 'server' | 'host' | null, // кто считал сетевой матч
  disconnect: null | { self: 1, selfLeft: false, opp: true, oppLeft: false },
                                 // обрывы связи в сетевом матче (серверный режим): self — сколько раз отправитель
                                 // переподключался, opp — пропадал ли соперник (за него играл ИИ), selfLeft / oppLeft —
                                 // не вернулся за 30 с. У не вернувшегося result: 'left', score — на момент обрыва
  teams: [ { shots, sog, goals, passes, passesDone, saves, hits, penalties, pokes, takeaways, posts }, {...} ],
  players: [ { t, num, g, a, s, h }, ... ],          // только те, у кого что-то есть
  faceoffs, events,
  test: false }                  // true в автотестах (?autostart / ?autopilot / ?seed) — не отправляется
```

Клиент (`index.html`, уже сделано):
- `STATS_API = ''` — адрес Worker'а; пока пусто, ничего не отправляется;
- итог кладётся в очередь `localStorage['bvr_pending_matches']` (не больше 10) и отправляется сразу и при старте
  следующего матча. 2xx и 4xx убирают итог из очереди, 5xx и ошибки сети — оставляют;
- без `Telegram.WebApp.initData` (браузер вне Telegram) не отправляется;
- ответ сервера приходит событием `match:reward`.

## API Worker'а

Каждый запрос: заголовок `X-Telegram-Init-Data: <Telegram.WebApp.initData>`.

**Проверка initData** (на каждый запрос, до всего остального):
1. разобрать строку как query string, вынуть `hash`;
2. `data_check_string` = остальные пары `key=value`, отсортированные по ключу, через `\n`;
3. `secret = HMAC_SHA256(key = "WebAppData", msg = BOT_TOKEN)`;
4. `hex(HMAC_SHA256(key = secret, msg = data_check_string)) === hash` — сравнение за постоянное время
   (`crypto.subtle.timingSafeEqual`);
5. `auth_date` не старше 24 ч;
6. `user.id` из поля `user` (JSON) — единственный идентификатор игрока. Всё, что прислано в теле про пользователя,
   игнорируется.

`BOT_TOKEN` — секрет Worker'а (`wrangler secret put BOT_TOKEN`), в клиент не попадает.

| метод | путь | тело | ответ |
|---|---|---|---|
| `POST` | `/v1/match` | `match:summary` | `200 { accepted: true, coins: +N, balance, verdict: 'ok'\|'capped' }` · `401` подпись · `409` этот `id` уже принят · `422 { reason }` неправдоподобный итог · `429` слишком часто |
| `GET` | `/v1/profile` | — | `{ user: { id, name }, coins, stars, totals: { matches, wins, losses, draws, goals, assists, shots }, inventory: [...], equipped }` |
| `POST` | `/v1/purchase` | `{ item: 'jersey_retro_01', idem: '<uuid>' }` | `200 { balance, inventory }` · `402` мало монет · `409` уже куплено (фаза магазина) |
| `POST` | `/v1/wager` | `{ match: '<id>', room: 'ABCD', stake: 50 }` — ставка перед матчем на двоих | `200 { escrow, balance }` · `402` мало монет · `409` ставки соперников не совпадают · `422` не матч на двоих |
| `GET` | `/v1/wager/<id>` | — | `{ state: 'open'\|'locked'\|'settled'\|'refunded', stakes: {host, guest}, winner? }` |

**Лимиты и проверки `/v1/match`** (числа — конфиг Worker'а, не клиента):
- `len ≥ 60`, `played ≥ 0.9 × len`, `endedAt − startedAt ≥ played − 5 с` — нельзя сдать матч за секунду;
- частота: следующий итог не раньше чем через `0.8 × len` после предыдущего принятого, не больше 40 матчей в сутки;
- дубли: первичный ключ `(user_id, match_id)`;
- правдоподобие: `goals ≤ sog ≤ shots`, `score` = `teams[*].goals`, голов за матч ≤ 20, `passesDone ≤ passes`;
- онлайн: хост и гость присылают один `id`, отчёты сверяются (ниже);
- формула награды живёт только на сервере.

## Экономика монет

Честно о пределах: в игре против ИИ клиент может прислать выдуманный итог. Подпись initData доказывает только,
**кто** прислал, а не **что** было на льду. Поэтому монеты за матчи с ИИ **скромные и с дневным лимитом на игрока**:
подделкой нельзя получить больше потолка и чаще, чем позволяет реальная длина матча. **Ставки монетами — только в
матчах на двоих**, где есть второй независимый отчёт. Полная защита — когда симуляция уйдёт на сервер (Phase 3,
`PHASE3_MULTIPLAYER_ARCHITECTURE.md`).

### Матч против ИИ

| | значение по умолчанию (конфиг Worker'а) |
|---|---|
| победа / ничья / поражение | 10 / 5 / 3 монеты за матч 3 мин (`len` 60 с — ×0.4) |
| бонус | +1 за гол, +1 за передачу игрока своей команды, не больше +5 за матч |
| потолок за матч | `AI_COIN_CAP_MATCH` = 15 |
| **дневной лимит на игрока** | `AI_COIN_CAP_DAY` = 100 (≈ 10 матчей); сверх — матч и статистика пишутся, монет 0, `verdict: 'capped'` |
| сутки | по UTC, считаются по `ledger` (`reason = 'match_ai'`) |

Ставок в матчах с ИИ нет.

### Матч на двоих без ставки

Награда как за матч с ИИ (свой дневной лимит `DUO_COIN_CAP_DAY`, чтобы нельзя было «фармить» вдвоём бесконечно),
но начисляется **только после сверки**: оба отчёта с одним `id` пришли и совпали `score`, `len`, `clubs`, `team`
(у хоста и гостя разные) и итоги по командам (`goals` одинаковые, остальное ±10 % — события у гостя приходят те же).
- второго отчёта нет 10 мин — пришедшему начисляется награда как за матч с ИИ, в его лимит ИИ;
- отчёты расходятся — матч пишется у обоих с `verdict: 'rejected:mismatch'`, монет нет.

### Ставки (только на двоих)

> **Не включать, пока матч считает хост.** Сейчас (фаза 2 сети) хост решает всё с нулевой задержкой, а гость
> играет с опозданием на пинг: по замерам `npm run smoke:lag` при RTT 150 мс ввод гостя доходит до хоста через
> ~90 мс, а картинка у гостя отстаёт на ~140 мс — в спорной шайбе, отборе и силовом у хоста фора в 60–100 см.
> Предсказание прячет задержку в ощущениях, но не в исходах. Ставки монетами включаются только когда матч
> считает сервер (Durable Object, `PHASE3_MULTIPLAYER_ARCHITECTURE.md`, фазы 3.1–3.5): тогда оба игрока равны,
> а итог матча для расчёта ставки даёт сервер, без сверки двух отчётов. До этого эндпоинт `/v1/wager` не
> реализуется, а в клиенте нет интерфейса ставок.

1. Перед стартом оба игрока отправляют `POST /v1/wager` с одним `match` (id из `cfg`) и одинаковой `stake`.
   Worker списывает ставку в резерв (`ledger`: `reason = 'wager_escrow'`, `delta = −stake`). Пока не пришли обе
   ставки, матч ставкой не считается: хост не начинает матч, пока `GET /v1/wager/<id>` не вернёт `locked`.
2. После матча оба присылают `/v1/match`. Сверка как выше. Если совпало:
   победитель получает `2 × stake − комиссия` (`WAGER_FEE` = 10 %, она и есть «сжигание» монет), ничья — обоим
   возврат ставки.
3. Не совпало, второго отчёта нет 10 мин, кто-то вышел до конца (`match:abort`), у кого-то `disconnect.selfLeft` /
   `oppLeft` (не вернулся после обрыва — матч доигран против ИИ) или матч короче `len` — **обоим возврат**
   (`reason = 'wager_refund'`). Спорная ставка никогда не уходит одной стороне.
4. Ограничения: ставка 10–500 монет, не больше `WAGER_DAY` = 5 ставок в сутки на игрока и не больше 3 ставок в сутки
   с одним и тем же соперником (против перекачки монет между своими аккаунтами).

## Схема D1

```sql
CREATE TABLE users (
  user_id     INTEGER PRIMARY KEY,            -- Telegram user.id
  name        TEXT,
  coins       INTEGER NOT NULL DEFAULT 0,
  stars       INTEGER NOT NULL DEFAULT 0,
  matches     INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  draws       INTEGER NOT NULL DEFAULT 0,
  goals       INTEGER NOT NULL DEFAULT 0,
  assists     INTEGER NOT NULL DEFAULT 0,
  shots       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,               -- unix, с
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
  result      TEXT    NOT NULL,               -- 'win' | 'loss' | 'draw'
  summary     TEXT    NOT NULL,               -- весь match:summary (JSON) для разборов
  reward      INTEGER NOT NULL DEFAULT 0,
  verdict     TEXT    NOT NULL,               -- 'ok' | 'capped' | 'pending_peer' | 'rejected:<причина>'
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, match_id)
);
CREATE INDEX matches_by_user_time ON matches(user_id, created_at);
CREATE INDEX matches_by_id ON matches(match_id);        -- сверка отчётов хоста и гостя

-- журнал всех изменений баланса: монеты меняются только записью сюда + UPDATE users в одном batch
CREATE TABLE ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(user_id),
  delta         INTEGER NOT NULL,
  currency      TEXT    NOT NULL DEFAULT 'coins', -- 'coins' | 'stars'
  reason        TEXT    NOT NULL,                 -- 'match_ai' | 'match_duo' | 'wager_escrow' | 'wager_win' | 'wager_refund' | 'purchase' | 'admin'
  ref           TEXT,                             -- match_id / item / idem-ключ
  balance_after INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX ledger_idem ON ledger(user_id, reason, ref);  -- повтор запроса не начислит дважды

CREATE TABLE wagers (                            -- ставки, только матчи на двоих
  match_id    TEXT    PRIMARY KEY,
  host_id     INTEGER REFERENCES users(user_id),
  guest_id    INTEGER REFERENCES users(user_id),
  stake       INTEGER NOT NULL,
  state       TEXT    NOT NULL,                  -- 'open' | 'locked' | 'settled' | 'refunded'
  winner_id   INTEGER,                           -- NULL — ничья или возврат
  created_at  INTEGER NOT NULL,
  settled_at  INTEGER
);

CREATE TABLE inventory (                         -- фаза магазина
  user_id     INTEGER NOT NULL REFERENCES users(user_id),
  item_id     TEXT    NOT NULL,                  -- строковый id, каталог только дописывается
  source      TEXT    NOT NULL,                  -- 'purchase' | 'reward' | 'gift'
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
```

## Telegram CloudStorage (клиент, позже)

| ключ | что |
|---|---|
| `difficulty` | **уже используется**: `easy` / `normal` / `hard`, копия в `localStorage['bvr_difficulty']` (сразу при запуске и вне Telegram / Bot API < 6.9) |
| `settings` | язык, вибро, качество графики, сервер релея (сейчас это `localStorage`: `bvr_lang`, `bvr_vibro`, `bvr_srv`) |
| `skin` | выбранный `item_id` (надето). Что куплено — только в D1 |
| `profile` | кэш ответа `GET /v1/profile` + время, чтобы меню показывало монеты до ответа сервера. Источник правды — D1 |

Очередь неотправленных итогов остаётся в `localStorage`: это не настройки, а транспорт, и ей не нужна синхронизация
между устройствами.
