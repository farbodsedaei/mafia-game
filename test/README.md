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
node test/scenarios/04-full-game-village-win.js   # just one scenario
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

## Current coverage (core set)

1. `01-lobby-join-and-role-assignment` — lobby creation, players joining by
   room code, role assignment dealing the configured Mafia/villager split.
2. `02-day-voting-elimination` — a full round-1 + round-2 day vote
   eliminating a non-Mafia target; confirms the game correctly continues.
3. `03-night-mafia-kill` — a real night kill via `night-action`, independent
   of any win condition.
4. `04-full-game-village-win` — a complete game ending when the village
   votes out the Mafia.
5. `05-full-game-mafia-win` — a complete game ending when a night kill
   brings the village down to Mafia's own numbers.
6. `06-disconnect-reconnect-lobby` — a dropped connection mid-lobby that
   self-heals with no user action, then continues into a normal game.
7. `07-twelve-player-mafia-and-zodiac` — a larger (12-player), longer
   (3-day) game with 2 Mafia and a زودیاک (independent role): every day
   vote has at least half of the currently-alive players actually casting a
   ballot, every night past the first has real decisions from both
   night-acting roles (Mafia's kill, زودیاک's own independent shot), and it
   ends in a **زودیاک win** — a third, distinct outcome from the village/
   Mafia wins `04`/`05` cover, which only happens when Mafia is wiped out
   while زودیاک is still alive (see `checkWinner` in `index.html`).
8. `08-fourteen-player-full-role-roster` — the "kitchen sink": 14 players,
   3 Mafia, زودیاک, and every civilian special role at once (دکتر, کاراگاه,
   حرفه‌ای, کنستانتین, اوشن, تفنگدار), across a 3-day game where each role
   actually DOES its thing at least once rather than just being dealt:
   دکتر blocks a kill, کنستانتین revives a same-day vote-out, کاراگاه
   investigates twice (both correctly positive), تفنگدار hands off the gun
   for a real day-gun kill the next day, اوشن recruits and triggers the
   nightly talk step, and حرفه‌ای/زودیاک together wipe out Mafia for a
   second زودیاک-win ending. Every day vote again has at least half of the
   currently-alive players actually voting.

9. `09-day-gun-reveals-zodiac-son` — regression test for a reported bug:
   the day-gun's public team reveal (Mafia/villager/زودیاک) used to key off
   `entry.independent`, which is only ever true for the CURRENT main
   زودیاک (itself immune to the gun outright, so that branch could never
   really fire) — meaning a زودیاک پسر killed by the gun before succession
   wrongly announced as a plain civilian. Fixed in `resolveDayGunAction` by
   checking role identity instead; this test hands the gun to a bystander,
   has them shoot زودیاک پسر specifically, and asserts the announcement
   says زودیاک everywhere it's shown (host banner + a bystander's own
   device), not "شهروند". Mafia is dealt as ماتادور + پدر خوانده here
   (not plain مافیا ساده), so this is also the only scenario so far
   exercising پدر خوانده's deterministic kill-decision (no random pick
   needed when a Godfather is alive — see `startMafiaPhaseStep`) and
   ماتادور's own independent block, both resolving alongside تفنگدار's
   handoff the same night.

10. `10-zodiac-son-requires-zodiac` — regression test for a reported bug:
    the role checklist used to let a host select زودیاک پسر on its own,
    leaving it in play with no زودیاک for it to ever succeed. Fixed with
    `enforceZodiacSonDependency` in `renderRoleChecklist()`: the two are now
    linked in both directions right at the checkbox — selecting پسر without
    زودیاک also selects زودیاک, and deselecting زودیاک while پسر is still
    selected also deselects پسر — each with its own explanatory toast, so
    the invalid combination can never actually be reached. This scenario
    drives the checklist directly (no lobby/game needed) and asserts both
    directions, plus that selecting them in the already-valid order (زودیاک
    first) needs no correction and that زودیاک alone (no پسر) is untouched.

Not yet covered (candidates for a follow-up pass): ساول گودمن (the one
remaining Mafia-side special role — recruiting a villager instead of
shooting), the morning inquiry vote
(deliberately turned off in scenarios 07/08 — see their own comments), a
doctor self-save / a professional backfire / a زودیاک-پسر succession, and
the structural `verify.js`-style static checks (brace/paren balance, fa/en
STRINGS parity) an earlier pass of this harness also had.

**God Mode / No God Mode entirely** is the biggest structural gap: there's
no driving infrastructure yet for the host-self card (`#host-self-section`,
`App.hostSelfSubmitVote`/`hostSelfSubmitNightAction`, etc.) the way
`device.js` drives a real player's screens. A second reported bug — God
Mode's host-self had no way to open vote history at all (fixed by adding a
`#host-self-vote-history-btn` alongside the existing My Role/My Activity
links, using the same `App.viewVoteHistory()` real players use) — was
verified by hand rather than by an automated test for exactly this reason.
Building that driving layer is the natural next investment if God Mode
keeps coming up.
