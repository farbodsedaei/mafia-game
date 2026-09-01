# Automated game-flow tests

Runs real, multi-device Mafia games against the **actual, unmodified**
`public/index.html` and a **real spawned `server.js`**, and asserts on what
each device ends up showing — the same way a human tester clicking through
several phones would, just scripted. Nothing here is a reimplementation of
the game's rules; every scenario drives the real `App.*` functions and reads
the real rendered DOM.

## Running

```
npm test                              # every scenario, with a pass/fail summary
node test/scenarios/<name>.js         # just one scenario
```

Each run writes a full, human-readable play-by-play transcript to
`test/logs/<scenario-name>.log` (gitignored — these are run artifacts, not
source). The console output during a run is the same transcript.

## How it works

- **`lib/server-runner.js`** spawns the real `server.js` as a child process
  on an ephemeral port, and can spawn it with `HOST_GRACE_MS_OVERRIDE` set
  for reconnect scenarios that don't want to wait the real 90 seconds.
- **`lib/mocks.js`** installs the browser APIs `index.html` needs that
  Node/jsdom don't provide, on each simulated device's `window`, *before*
  the app's own script runs (see `device.js`):
  - `window.WebSocket` — the real `ws` npm package, genuinely talking to the
    spawned server over a real socket. Not mocked.
  - `window.fetch` — Node's built-in fetch, resolved against the device's
    own `location` (for the one `/api/ice-config` request at load time).
  - `window.RTCPeerConnection` — genuinely mocked (there's no real WebRTC in
    Node): two mock peer connections find each other via the SDP payload
    they exchange over the real WebSocket signaling relay, then hand out a
    paired `MockDataChannel` that behaves like a real one (async, JSON
    strings in and out, a real `onclose`/`close()` propagation you can use
    to simulate a dropped connection).
- **`lib/device.js`**'s `createDevice()` loads `public/index.html` into a
  jsdom window with script execution deferred (`runScripts: 'outside-only'`),
  installs the mocks, then manually evaluates the app's own `<script>` —
  in that order, so the app's very first lines (which immediately try to
  open a WebSocket and fetch `/api/ice-config`) hit the mocks, not jsdom's
  own (missing/incomplete) versions of those APIs. It also exposes small
  DOM-driving helpers (`checkVoteCandidate`, `pickNightTarget`, `roleInfo`,
  `waitFor`, ...) that scenarios use instead of ever reaching into the app's
  internal (and deliberately closured-private) `state` object.
- **`lib/game-flow.js`** has the multi-device sequences every scenario needs
  (join the lobby, assign roles + begin, play through Day 1 into Night 1,
  cast a round of votes) so a scenario script reads as the story of one
  game, not connection plumbing.
- **`scenarios/*.js`** — one script per situation. Each is a standalone
  `node` process (run directly, or via `run-all.js`) so a crash in one can
  never affect another, and each ends with an explicit `process.exit()`
  since the mocked WebRTC layer and real sockets can otherwise leave the
  event loop alive.

## Adding a scenario

Copy the shape of an existing one: `runScenario(name, async (log) => { ... })`
from `lib/scenario.js` gives you a `Logger` (`log.step`/`log.info`/
`log.pass`/`log.fail`/`log.assert`), always saves the transcript, and always
exits with the right code. Use `lib/device.js` and `lib/game-flow.js` for the
actual driving; assert on rendered DOM (screen ids, element text, CSS
classes), not on anything internal to `index.html`.

## Current coverage

1. `01-fourteen-player-full-roster` — the full requested roster in one
   game: 14 players, Mafia dealt as پدر خوانده + ماتادور (not plain
   مافیا ساده), زودیاک, دکتر, حرفه‌ای, تفنگدار, کاراگاه, کنستانتین, اوشن,
   and 5 plain villagers. Every day vote has a real majority (strictly
   more than half) of the currently-alive players actually voting, and
   every role with no count limit (پدر خوانده's kill, ماتادور's block,
   زودیاک's shot, دکتر's other-directed saves, حرفه‌ای's shot, کاراگاه's
   investigation) acts on EVERY night it's prompted rather than skipping,
   while the roles that DO have a real limit (کنستانتین's once-per-game
   revive, تفنگدار's 2 handovers, اوشن's cap at `numOceanSlots`) are driven
   all the way to that limit. Along the way it exercises several mechanics
   no earlier pass of this harness ever had:
   - پدر خوانده's **detective immunity** — کاراگاه investigating the actual
     Godfather still reads negative (`isRealMafiaHit` excludes
     `ROLE_NAME_GODFATHER`).
   - پدر خوانده's own **shield** (`HARDCODED_ROLES`: `role-godfather` has
     `shield:true`) — the first hit against them just strips it (they
     survive); only a second hit afterward actually kills them.
   - حرفه‌ای's **backfire** — shooting a non-Mafia target kills the shooter
     instead of the target.
   - دکتر's once-per-game **self-save**, distinct from an ordinary
     other-directed save.
   - تفنگدار's gun **returning** to them when the current holder dies
     overnight before ever getting to decide (`startGunReturnedStep`).
   It ends in a زودیاک win once the returned gun finishes off the last
   Mafia member — a shield-stripped پدر خوانده, confirming the shield
   mechanic end to end.

Still not covered by anything: ساول گودمن (recruiting a villager instead of
shooting), the morning inquiry vote, a زودیاک-پسر succession, and the
structural `verify.js`-style static checks (brace/paren balance, fa/en
STRINGS parity) an earlier pass of this harness also had.

**A real gotcha hit building scenario 01**, worth not re-discovering: when a
kill (day-gun or otherwise) happens to also be the LAST Mafia member, the
target's own device receives `'eliminated'` immediately followed by
`'game-over'` (see `announceDayGunOutcome`'s own `App.showGameOver()` call)
— both queued back-to-back, so their screen lands on
`screen-player-game-over` and never visibly settles on
`screen-player-eliminated` at all. Assert on `screen-player-game-over`
directly for a target whose death ends the game, not the intermediate
elimination screen — a `waitFor` on the latter will simply time out.

**God Mode / No God Mode entirely** is the biggest structural gap: there's
no driving infrastructure yet for the host-self card (`#host-self-section`,
`App.hostSelfSubmitVote`/`hostSelfSubmitNightAction`, etc.) the way
`device.js` drives a real player's screens. Building that driving layer is
the natural next investment if God Mode needs test coverage.
