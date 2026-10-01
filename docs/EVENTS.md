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

# Итог матча и бэкенд

Сделано: `/v1/match`, `/v1/profile` — правила в `server/coins.js` (без Cloudflare), D1-хранилище `server/coins-d1.js`,
склейка Worker'а `server/api.js`; D1 `bvr-hockey` (APAC, схема — `server/migrations/`),
тест `npm run smoke:api`. Ставки и покупки — ещё нет.

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
  room: 'ABCD' | null,           // код комнаты сетевого матча — Worker сверяет счёт серверного матча с Durable Object
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

Клиент (`index.html`):
- `STATS_API` — адрес Worker'а (`bvr-hockey-relay`); на localhost пусто (автотесты и разработка в боевой API не ходят),
  там можно указать свой: `?api=http://127.0.0.1:8799` (так делает `smoke:api`);
- итог кладётся в очередь `localStorage['bvr_pending_matches']` (не больше 10) и отправляется сразу, при запуске
  приложения и при старте следующего матча. 2xx и 4xx убирают итог из очереди, 429 (рано после прошлого), 5xx и
  ошибки сети — оставляют;
- без `Telegram.WebApp.initData` (браузер вне Telegram) не отправляется, `test: true` — тоже;
- ответ сервера приходит событием `match:reward`: баланс (`COINS`, копия в `localStorage['bvr_coins']`) и строка
  «+N монет · всего M» на экране итога (или «дневной лимит монет набран»);
- при запуске после очереди — `GET /v1/profile`: баланс в Профиле и Магазине, статистика профиля (берётся копия, где
  больше матчей, как с CloudStorage).

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
| `POST` | `/v1/match` | `match:summary` | `200 { accepted: true, coins: +N, balance, verdict: 'ok'\|'capped'\|'left'\|'unverified', kind: 'match_ai'\|'match_duo', day: { coins, cap }, parts: { res, base, bonus }, stake: { n, out: 'win'\|'loss'\|'back'\|'pending', delta } \| null }` — `parts`: за что монеты (результат; голы и передачи — экран итога), `stake`: ставка на этот матч, как её видит игрок (`delta` — что вернулось при расчёте) · `401` подпись · `409` этот `id` уже принят · `422 { reason }` неправдоподобный итог · `429 { reason: 'gap'\|'day' }` слишком часто — клиент оставляет итог в очереди и пробует позже |
| `GET` | `/v1/profile` | — | `{ user: { id, name }, coins, stars, totals: { m, w, d, l, g, ga, streak, best, online }, inventory: [...], equipped, day: { coins, cap } }` — `totals` в тех же полях, что профиль клиента (`PROF`); `g`/`ga` — голы команды игрока / пропущенные, `left` считается поражением |
| `GET` | `/v1/stars/packs` | — | `{ packs: [{ id, stars, price }] }` — пакеты звёзд (то же приходит в `/v1/profile` полем `packs`) |
| `POST` | `/v1/stars/invoice` | `{ pack: 's50' }` | `200 { order, link, pack, stars, price }` — заказ записан `pending`, `link` — счёт Bot API `createInvoiceLink` для `Telegram.WebApp.openInvoice` · `422` нет такого пакета · `429` больше 20 счетов в час · `502` Bot API не ответил (заказ → `failed`) |
| `GET` | `/v1/stars/order?id=` | — | `{ id, status: 'pending'\|'paid'\|'refunded'\|'failed', stars, price, balance }` — свой заказ и баланс звёзд; чужой / нет — `404` |
| `POST` | `/tg/webhook` | апдейт Telegram | вебхук бота, заголовок `X-Telegram-Bot-Api-Secret-Token` = секрет `TG_WEBHOOK_SECRET`, иначе `403`; раздел «Звёзды» |
| `GET` | `/v1/admin/*` | — | страница разработчика, только чтение: `403` всем, кроме `ADMIN_IDS` (раздел «Страница разработчика») |
| `POST` | `/v1/purchase` | `{ item: 'jersey_retro_01', idem: '<uuid>' }` | `200 { balance, inventory }` · `402` мало монет · `409` уже куплено (фаза магазина) |

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
матчах на двоих в серверной схеме**, где итог даёт комната. Полная защита — когда симуляция уйдёт на сервер (Phase 3,
`PHASE3_MULTIPLAYER_ARCHITECTURE.md`).

### Матч против ИИ

| | значение по умолчанию (конфиг Worker'а) |
|---|---|
| победа / ничья / поражение | 10 / 5 / 3 монеты за матч 3 мин; множитель `max(0.4, min(len, 300) / 180)`: 1 мин ×0.4, 5 мин ×1.67 |
| бонус | +1 за гол, +1 за передачу игрока своей команды, не больше +5 за матч |
| потолок за матч | `AI_COIN_CAP_MATCH` = 15 × тот же множитель (6 / 15 / 25) |
| не вернулся после обрыва (`result: 'left'`) | 0 монет, `verdict: 'left'`, в статистике — поражение |
| **дневной лимит на игрока** | `AI_COIN_CAP_DAY` = 100 (≈ 10 матчей); сверх — матч и статистика пишутся, монет 0, `verdict: 'capped'` |
| сутки | по UTC, считаются по `ledger` (`reason = 'match_ai'`) |

Ставок в матчах с ИИ нет.

### Матч на двоих без ставки

Награда как за матч с ИИ, но из своего дневного лимита `DUO_COIN_CAP_DAY` = 100 (`ledger.reason = 'match_duo'`).
Отчёты двух игроков **не сверяются друг с другом**: матч в серверном режиме считает Durable Object, и он же — источник
правды. По концу матча комната сохраняет `{ id, len, score, left }` в своём хранилище (последние 8 матчей,
`worker.js`, `saveResult`); Worker при `POST /v1/match` с `net: 'server'` спрашивает комнату по `room` (код комнаты
в `match:summary`) и `id`:
- счёт и `len` совпали — `kind: 'match_duo'`, `verdict: 'ok'` (или `capped`);
- не совпали — `422 { reason: 'mismatch' }`;
- комната такого матча не знает (хост-схема, другой сервер, старый матч) — платится как матч с ИИ, из лимита ИИ,
  `verdict: 'unverified'`; так же — все матчи хост-схемы (`net: 'host'`);
- `team` в сетевом матче обязан быть 0 у хоста и 1 у гостя (`422 { reason: 'team' }`).

### Ставка на матч с другом (сделано 02.10.2026)

Только серверная схема (`net=server`): матч считает Durable Object, оба игрока равны, итог даёт комната — сверять
отчёты не нужно. В хост-схеме ставок нет (строки ставки на подготовке нет; запасной переход в хост-схему ставку не
переносит — заблокированная ставка вернётся по сроку, ниже).

- **Ставятся только монеты.** Звёзды (Telegram Stars) — только донат: за них в будущем оформление льда, форма команды,
  отключение рекламы. Звёзды не участвуют в ставках и не обмениваются на монеты — иначе это азартная игра на реальные
  деньги. В коде ставки звёзд нет нигде.
- Суммы: 0 (без ставки), 10, 25, 50, 100. Выбирает хост на подготовке матча (суммы больше его баланса пропускаются);
  гость видит ставку и принимает её кнопкой «Принять ставку». Без подтверждения обоих матч на ставку не начинается
  (`err: 'confirm'`). Новая сумма сбрасывает подтверждение гостя; ушёл из комнаты — тоже.
- Кто есть кто: после `hello` (если Worker умеет ставки — `hello.stk: 1`) клиент шлёт по сокету
  `{t:'auth', d: initData}`; комната проверяет подпись тем же `verifyInitData`, что API, и запоминает Telegram id слота.
  Старому Worker'у initData не шлётся (он переслал бы его сопернику). Один Telegram-аккаунт с двух сторон — `err: 'same'`.
- Баланс проверяется при выборе (хост), при подтверждении (гость) и окончательно при старте. Не хватает — `err: 'funds'`.
- **Старт:** cfg хоста с суммой на столе → комната одним D1-батчем пишет `stakes` (`status 'locked'`), списывает сумму у
  обоих (`ledger.reason = 'stake'`; ниже нуля баланс не уходит — триггер `users_coins_nonneg` откатывает весь батч) и
  только потом начинает матч; обоим `{t:'stake', live:{id, n}}`. Идущий матч со ставкой не перезапускается.
  Реванш с экрана итога — без ставки (одна ставка — один матч); новую ставку — через подготовку.
- **Итог решает только результат комнаты** (`{ score, left }` из `MatchRoom.onEnd`), не клиент: победитель получает
  обе ставки (`stake_win`, +2n), ничья — каждому своя (`stake_back`, +n); вышел и не вернулся (`left`) — проигрыш
  ставки при любом счёте; оба не вернулись — обоим возврат. Комиссии нет.
- **Нет результата → возврат обоим:** матч не закончился (оба ушли — `onStop`), Durable Object перезапустился, сервер
  упал. Срок ставки — `2 × len + STAKE_GRACE` (900 с); по сроку её закрывает будильник комнаты (`alarm`) и, независимо
  от Cloudflare, любой `GET /v1/profile` / `POST /v1/match` одного из игроков (`stakeSweep`): есть результат комнаты —
  по нему, нет — возврат.
- **Идемпотентность:** одна ставка — один матч (`stakes.match_id` — первичный ключ, повтор → `duplicate`); расчёт
  только из `status 'locked'` (условие в каждом запросе батча) плюс уникальный `ledger(user_id, reason, ref)` —
  повторный расчёт (комната, API, будильник одновременно) и повторный отчёт ничего не платят.
- Ставка не входит в дневные лимиты монет за матчи (свои причины в `ledger`: `stake`, `stake_win`, `stake_back`).
- Экран итога: отдельная строка «Ставка выиграна +2n / проиграна −n / возвращена +n / итог позже» в той же анимации;
  «Итого» = монеты за матч + вернувшееся по ставке.

Где что: правила — `server/coins.js` (`StakeRoom` — предложение / подтверждение / старт, `stakeOutcome`, `stakePayout`,
`stakeFinish`, `stakeSweep`, `stakeView`; без Cloudflare), SQL — `server/coins-d1.js` (`stakeLock`, `stakeGet`,
`stakeSettle`, `stakesOverdue`), склейка — `server/worker.js` (сокет, хранилище и будильник Durable Object), схема —
`server/migrations/0002_stakes.sql`. Сообщения комнаты: `→ {t:'stake', n}` (хост), `→ {t:'stakeOk', n}` (гость),
`← {t:'stake', n, ok:[хост, гость], live?, err?}`, `← {t:'auth', ok}`. На VPS комната (Node) зовёт те же функции.

Чего нет (было в старом плане, в новых правилах не нужно — отдельной задачей при желании): комиссия с выигрыша,
лимит ставок в сутки и с одним соперником (защита от перекачки монет между своими аккаунтами).

### Звёзды за Telegram Stars (сделано 02.10.2026)

Звёзды игры — **только донат**: оформление льда, форма команды, отключение рекламы. Не меняются на монеты, не участвуют
в ставках, денежной стоимости не имеют (это же — в `/terms` бота). Покупаются за Telegram Stars (валюта `XTR`, без
платёжного провайдера).

**Пакеты** — `STAR_PACKS` в начале раздела «stars» `server/coins.js`, **одна правка** меняет цены у всех: клиент берёт
их только с сервера (`/v1/profile` → `packs`, `/v1/stars/packs`). Сейчас: 50 звёзд за 50 Stars, 120 за 100, 300 за 250
(бонус «+20 %» на карточке клиент считает сам из `stars / price`). Заказ хранит звёзды и цену своего пакета —
смена цен не трогает уже созданные счета (старый счёт оплачивается по старой цене).

**Покупка:**
1. Клиент (только в Telegram, где есть `openInvoice`; вне Telegram кнопки нет): «+» со звездой у звёзд в кошельке на
   главном и в профиле → экран «Пополнить звёзды» (три карточки) → `POST /v1/stars/invoice`.
2. Сервер пишет заказ (`star_orders`, `status 'pending'`, id — 24 hex, он же `payload` счёта; игрок — из initData) и
   создаёт счёт `createInvoiceLink` (`currency: 'XTR'`, `provider_token: ''`, `prices: [{ amount: price }]`, название на
   языке игрока).
3. Клиент открывает `Telegram.WebApp.openInvoice(link)`. Ответ окна `paid` (или `pending`) — **ещё не начисление**:
   клиент опрашивает `GET /v1/stars/order` раз в 1.2 с до 30 с, звёзды летят в кошелёк (анимация как у монет, звон)
   только при `status: 'paid'` от сервера; не дождался — «звёзды появятся чуть позже» (профиль перечитается).
   `cancelled` / `failed` — спокойное сообщение «ничего не списано».

**Вебхук бота** `POST /tg/webhook` (`allowed_updates: message, pre_checkout_query`):
- `pre_checkout_query` — заказ есть, `pending`, `from.id` — владелец заказа, `XTR` и сумма = цена заказа → `ok: true`;
  иначе `ok: false` и `error_message` на языке игрока («счёт уже недействителен…»), причина — в лог. Один запрос к D1 и
  один к Bot API — в 10 с укладывается с запасом.
- `successful_payment` — одним D1-батчем (транзакция), каждый запрос с условием «заказ ещё `pending`»: `users.stars +=
  stars`, строка `ledger` (`currency 'stars'`, `reason 'stars_buy'`, `ref` = заказ), заказ → `paid` с
  `telegram_payment_charge_id`. Повтор того же платежа (Telegram повторяет апдейт, если не получил 200) ничего не
  начисляет; ошибка записи → `500`, Telegram повторит. Платёж, который не сходится ни с одним заказом (чужой / нет
  такого / другая сумма), **не теряется**: строка `star_orders` со `status 'unmatched'` и charge id — видна на странице
  разработчика, звёзды не начисляются, разбор вручную.
- `refunded_payment` (приходит и после ручного `refundStarPayment`) — по charge id, только из `paid`: строка `ledger`
  `stars_refund` на то, что есть (`-MIN(stars, звёзды заказа)`), `users.stars = MAX(stars − звёзды заказа, 0)`, заказ →
  `refunded`; если часть уже потрачена — баланс 0, недостача — `star_orders.refund_short`, в логе `stars refunded` с
  `short`. Повтор ничего не списывает. Ниже нуля баланс не уходит и триггером `users_stars_nonneg`.
- `/paysupport`, `/terms` — тексты `BOT_TEXTS` в `coins.js` (ru / en / id по языку Telegram игрока; правятся там же).
  Остальные сообщения боту игнорируются.

**Настройка бота — один раз** (`POST /tg/setup`, заголовок `X-Setup-Secret` = `TG_WEBHOOK_SECRET`): `?do=info` —
текущий вебхук, команды, очередь `getUpdates` (без `offset` — ничего не подтверждает); `?do=install` — `setWebhook`
на `<Worker>/tg/webhook` с `secret_token`, команды `/paysupport`, `/terms` **добавляются** к уже заданным
(`getMyCommands` → `setMyCommands`). Если у бота уже другой вебхук — `409`, ничего не меняется.

Секреты Worker'а: `BOT_TOKEN`, `TG_WEBHOOK_SECRET` (`wrangler secret put`).

**Перевыпуск токена бота в @BotFather** ломает всё сразу: подпись initData сходится только с новым токеном (каждый
`/v1/*` → 401, `/v1/admin/*` → 403, монеты не начисляются), а Telegram **снимает вебхук**. После перевыпуска:
`cd server && ../node_modules/.bin/wrangler secret put BOT_TOKEN` (новый токен; деплой не нужен), затем
`POST /tg/setup?do=install` (вебхук обратно). Отказ подписи виден в `wrangler tail` строкой
`auth refused {"path", "why": "hash"}` (`hash` — подпись другого токена, `expired` — initData старше суток). Схема — `migrations/0003_stars.sql`.
Правила — `coins.js` (`STAR_PACKS`, `BOT_TEXTS`, `botApiFrom`, `checkoutCheck`, `onBotUpdate`, `handleBot`,
`handleBotSetup`), SQL — `coins-d1.js` (`starOrderNew`, `starOrderGet`, `starPaid`, `starRefund`, `starUnmatched`…),
склейка — `api.js` / `worker.js`. Ручной возврат: `refundStarPayment(user_id, telegram_payment_charge_id)` из Bot API
(charge id — на странице разработчика / в `star_orders`), списание сделает `refunded_payment`.

### Страница разработчика (сделано 02.10.2026)

**Кто:** числовой Telegram `user.id` из **проверенного** initData входит в секрет Worker'а `ADMIN_IDS` (через запятую,
сейчас `454163382`; `wrangler secret put ADMIN_IDS`). Не username, не то, что прислал клиент. Не в коде и не в клиенте.
Всем остальным — без подписи, с подписью другого бота, с подменённым `user` (подпись не сходится), любой другой id —
**`403` на каждый `/v1/admin/*`**, тело `{reason:'forbidden'}` без подробностей. Нет `ADMIN_IDS` — `403` всем.

**Обычному игроку не уходит ничего:** в `index.html` нет ни кода страницы, ни её текстов. Клиент в Telegram один раз
спрашивает `GET /v1/admin/me`; `403` (и любой 4xx) — и всё, до перезапуска не повторяется. Сетевая ошибка, 5xx или нет
ответа 10 с — повтор через 2, 5 и 12 с, потом по разу при каждом возврате в главное меню (не больше 8 запросов за
запуск). `200` (`{ id, name, label }`) — в главном меню появляется пункт с
подписью из ответа; по нажатию клиент берёт **сам экран у Worker'а** — `GET /v1/admin/ui.js` (текст
`server/admin-ui.js`, тоже только `ADMIN_IDS`, `cache-control: no-store`) и выполняет его с узким набором функций
меню (`K`: запрос к API с подписью, шапка, перерисовка). Экран — `MSCR.ext` (пустой контейнер), действия `x`.

**Только чтение:** ни одного запроса, который что-то меняет; кнопок начисления, возврата, бана нет.

| запрос | что |
|---|---|
| `GET /v1/admin/me` | `{ id, name, label }` |
| `GET /v1/admin/ui.js` | текст экрана |
| `GET /v1/admin/overview` | игроки: всего, новых сегодня / 7 / 30 дней (+ по дням, 30 дней), активных за день / неделю / месяц (`last_seen`); матчи: сегодня и по дням — с ИИ / двое · сервер / двое · хост (по `id` матча, отчёты двух игроков — один матч; режим — из `summary.net`), за 30 дней, средняя длина, доля доигранных (`result ≠ left`); монеты: выдано (`match_*`, `admin`, `reward`), потрачено (`purchase`), в обороте (`SUM(users.coins)`), в ставках сейчас; ставки: матчей, банк, возвраты; звёзды: покупок, продано звёзд, Stars за день / 30 дней / всё время (`paid` + `refunded` + `unmatched`), возвраты, неопознанные платежи; платформы (iOS / Android / ПК / Веб) и языки. Считается **не чаще раза в минуту** на процесс (`ADMIN_CACHE`, 60 с), один D1-батч |
| `GET /v1/admin/players?q=&sort=&page=` | 50 на страницу; поиск — имя, username (`@` можно), точный id; сортировка `seen` (последний вход), `matches`, `coins`, `stars`, `bought` (куплено Stars), `new` |
| `GET /v1/admin/player?id=` | карточка: всё из списка + голы, язык, premium; последние 20 матчей (режим, счёт, результат, награда, `verdict`), 20 ставок (сумма, роль, итог, соперник), 50 строк `ledger` (монеты и звёзды), 50 заказов звёзд |
| `GET /v1/admin/payments?status=&page=` | все заказы звёзд (50 на страницу, фильтр по статусу): игрок, звёзды, Stars, статус, когда оплачен / возвращён, `telegram_payment_charge_id`, недостача при возврате |

**Что ещё собирается об игроках** (`migrations/0004_players.sql`): на каждый подписанный запрос к API (`touch`) —
`username`, `language_code`, `is_premium` из initData, платформа Telegram (`Telegram.WebApp.platform`, заголовок
`X-Tg-Platform`, только `[a-z_]{1,16}`), `last_seen`; строка игрока создаётся при первом запросе (`created_at`).
Пишется, только если что-то изменилось или `last_seen` старше 5 минут. **Больше ничего** (ни фото, ни телефона, ни
IP).

Экран: горизонталь, только русский, стиль меню; вкладки «Обзор / Игроки / Платежи» (касание, Q/E, LB/RB), карточка
игрока по нажатию на строку (в «Игроках» и «Платежах»), «Назад» — из карточки к списку. Графики по дням — столбики
(матчи — три ряда с легендой, цвета проверены на тёмном фоне), касание дня — числа под графиком. Время — местное,
сутки в подсчётах — UTC.

Где что: правила и маршруты — `coins.js` («admin»: `adminIds`, `overviewShape`, `adminRoute`), SQL — `coins-d1.js`
(`touch`, `adminOverview`, `adminPlayers`, `adminPlayer`, `adminPayments`), склейка — `api.js` (`ADMIN_IDS`, текст
экрана через правило `Text` в `wrangler.toml`), экран — `server/admin-ui.js`. Скриншоты на тестовых данных —
`node tools/dev-shots.mjs` → `shots/dev/`.

### Экран итога: начисление

По ответу `/v1/match`: строки «за что» (`parts`, ставка, пометка о дневном лимите), «Итого» набирается счётчиком,
монеты летят к балансу в шапке экрана, звон на каждую (громкость звуков из Настроек). Пока ответа нет — «Начисляем
монеты…»; 429 / 5xx / нет сети / нет ответа 8 с — «Монеты начислятся позже» (итог в очереди); 4xx — блок скрыт.
Начислено 0 — без летящих монет. Вне Telegram и в автотестах итог не отправляется — блока нет.

## Схема D1

Действующая схема — `server/migrations/0001_init.sql` (там же новые миграции; применить —
`cd server && ../node_modules/.bin/wrangler d1 migrations apply DB --remote`). Отличия от наброска ниже: в `users` поля
под профиль клиента (`goals_against`, `streak`, `best_streak`, `online` вместо `assists`/`shots`), вместо `wagers` —
`stakes` (`0002_stakes.sql`, раздел выше), заказы звёзд — `star_orders` (`0003_stars.sql`, раздел «Звёзды»), сведения об игроке для страницы разработчика —
`0004_players.sql` (`username`, `language_code`, `is_premium`, `platform`, `last_seen`). Набросок (старый, ещё со `wagers`):

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

## Перенос API (план, ничего не перенесено)

Основная аудитория — Россия, а Cloudflare там работает нестабильно. API монет, скорее всего, переедет на VPS в Москве
(Node.js + SQLite или Postgres). Live-матчи на двоих (Durable Object `Room`) — отдельный вопрос, этот план только про
`/v1/*`.

**Как код готов к переезду (01.10.2026):**

| файл | что | при переезде |
|---|---|---|
| `server/coins.js` | правила целиком: проверка initData (WebCrypto), правдоподобие итога, формула награды, дневные лимиты, частота, обработчик `/v1/*` на стандартных `Request`/`Response`; ставки (02.10): `StakeRoom`, расчёт по результату комнаты, возврат по сроку; звёзды (02.10): пакеты, счёт, вебхук бота `handleBot` (Bot API — обычный `fetch`) | **переносится как есть** — в нём нет ничего от Cloudflare; `smoke:api` гоняет его в чистом Node.js с хранилищем в памяти |
| `server/coins-d1.js` | хранилище (интерфейс `STORE` в шапке `coins.js`): 12 методов (4 — ставки, 7 — звёзды, 5 — игрок и страница разработчика), SQL — обычный SQLite; «не ниже нуля» — триггер `users_coins_nonneg` (Postgres: `CHECK (coins >= 0)`) | SQLite — те же запросы через `node:sqlite` / `better-sqlite3` (`db.batch` → транзакция); Postgres — новый файл, отличия ниже |
| `server/api.js` | склейка Cloudflare: секрет `BOT_TOKEN`, привязка `DB`, переменные Worker'а как лимиты, итог серверного матча — из Durable Object комнаты | пишется заново (~30 строк): HTTP-сервер Node → `new Request(...)` → `handleCoins(...)` → ответ; секрет и лимиты — из переменных окружения |

**Шаги переноса базы:**
1. На VPS: Node.js ≥ 22, HTTPS (nginx/Caddy), процесс под systemd/pm2. `BOT_TOKEN` — переменная окружения, не в git.
2. Схема — те же `server/migrations/*.sql`. SQLite: применить как есть. Postgres: `INTEGER PRIMARY KEY AUTOINCREMENT` →
   `BIGSERIAL`, `user_id` — `BIGINT` (Telegram id не влезает в 32 бита), `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`,
   `MAX(a, b)` → `GREATEST(a, b)`, `?` → `$1…`, в `ledger.balance_after` подзапрос заменить на `RETURNING coins` из `UPDATE`.
3. Данные: `wrangler d1 export bvr-hockey --remote --output=dump.sql` — для SQLite импорт прямо (`sqlite3 db < dump.sql`),
   для Postgres — через `pgloader` или построчно (таблиц шесть: `users`, `matches`, `ledger`, `inventory`, `stakes`, `star_orders`). Перед
   экспортом — запись только на новом сервере или окно в пару минут без матчей; очередь итогов у клиента
   (`localStorage['bvr_pending_matches']`) переживёт простой: 503/сетевая ошибка — итог остаётся и уйдёт позже, дубль
   `409` безопасен (первичный ключ `(user_id, match_id)`).
4. Хранилище: `store-sqlite.js` / `store-pg.js` по интерфейсу `STORE`; `recordMatch` — одна транзакция (пользователь,
   матч, итоги, строка `ledger`), нарушение уникальности → `'duplicate'`.
5. Итог серверного матча (`roomResult`): пока матчи на двоих считает Durable Object — VPS спрашивает Worker по
   внутреннему адресу с общим секретом (сейчас это `X-Internal` только изнутри Worker'а — понадобится заголовок с
   секретом); если комнаты тоже переедут — их сервер отдаёт `{ len, score }` по `id` матча. Без этого серверные матчи
   платятся как матч с ИИ (`verdict: 'unverified'`), это безопасно.
6. Клиент: адрес API — `STATS_API` в `index.html` (одна строка; `?api=` — только на localhost); на время перехода
   старый Worker может отвечать 503 — клиент повторит позже.
6a. Ставки: склейка комнаты (`worker.js`: сокет `auth`/`stake`/`stakeOk`, `startMatch`, `stakeEnd`, `alarm`) живёт
   вместе с комнатами; пока они в Durable Object, ставки пишут в D1. Переезжает API, а комнаты нет — комнате нужен тот
   же `STORE` по сети (или ставки остаются в D1 до переезда комнат). Срок ставки на VPS закрывает `stakeSweep` при
   любом запросе игрока — будильник не обязателен.
6a'. Страница разработчика: тот же `handleCoins`; `ADMIN_IDS` — переменная окружения; текст экрана
   (`server/admin-ui.js`) склейка VPS читает с диска (`readFileSync`) и отдаёт в `adminUi`. В запросах `json_extract`
   (Postgres: `summary::json->>'net'`), `SUM(условие)` → `SUM(CASE WHEN … THEN 1 ELSE 0 END)`.
6b. Вебхук бота: на VPS тот же `handleBot` на пути `/tg/webhook`; после переезда — `POST /tg/setup?do=info` на старом
   адресе, затем `setWebhook` на новый (у бота один вебхук: старый перестанет получать платежи сразу). Счета, созданные
   до переезда, оплачиваются уже на новом адресе — заказы должны переехать вместе с базой.
7. Проверка: `smoke:api` (часть про ядро — без изменений; часть про HTTP — направить на новый адрес), затем один
   настоящий матч из Telegram и сверка строки в `matches`/`ledger`.

## Telegram CloudStorage (клиент, позже)

| ключ | что |
|---|---|
| `difficulty` | **уже используется**: `easy` / `normal` / `hard`, копия в `localStorage['bvr_difficulty']` (сразу при запуске и вне Telegram / Bot API < 6.9) |
| `settings` | язык, вибро, качество графики, сервер релея (сейчас это `localStorage`: `bvr_lang`, `bvr_vibro`, `bvr_srv`) |
| `skin` | выбранный `item_id` (надето). Что куплено — только в D1 |
| `profile` | кэш ответа `GET /v1/profile` + время, чтобы меню показывало монеты до ответа сервера. Источник правды — D1 |

Очередь неотправленных итогов остаётся в `localStorage`: это не настройки, а транспорт, и ей не нужна синхронизация
между устройствами.
