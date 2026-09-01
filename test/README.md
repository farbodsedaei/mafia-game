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

2. `02-fourteen-player-longer-village-win` — the same roster and rules as
   01, played longer (4 full nights instead of 3) with two deliberate
   differences: حرفه‌ای never makes a mistake shot all game (three shots,
   all genuine Mafia targets — پدر خوانده twice, ماتادور once — zero
   backfires), and زودیاک is voted out on Day 3 while BOTH Mafia members
   are still alive, so the game ends in a plain **village win** once the
   last Mafia falls (independentAlive already false by then) — the
   opposite ending from 01's زودیاک win. New mechanics exercised here that
   01 never touched:
   - The **deferred ماتادور prompt**: once پدر خوانده is dead, ماتادور
     becomes Mafia's fallback kill-decider AND still has their own block —
     the same device gets two separate night-action prompts in a row (see
     `startMafiaPhaseStep`'s `deferredMatadorPrompt`). Needs a short
     `sleep()` between the two `nightAction()` calls so the second,
     server-sent prompt has landed before the test acts on it — the
     screen id doesn't change between the two prompts, so `waitFor`
     watching only the screen id would otherwise race ahead of it.
   - A genuine **wrong-target gun kill**: firing at an ordinary villager
     (as opposed to a shielded or independent target) is NOT a no-effect
     dud — it's a real, unavoidable death, on top of permanently
     cancelling any remaining handovers.
   - **دکتر's self-save is a whole-game limit**, not once-per-night — reused
     it by mistake while writing this scenario (see the debugging note
     below) before realizing the once-per-game cap also applies to the
     self-directed save, not just reviving/reviving-adjacent abilities.
   - اوشن's nightly talk step recurs on ANY night the team still has 2+
     alive members, even a night with no fresh recruit — easy to forget
     once اوشن itself is capped out and no longer acting.

3. `03-eighteen-player-god-mode` — the largest scenario yet: 18 players (17
   real devices + the host's own **God Mode** seat, played by the host
   in-process with no real device of its own), every Mafia special role
   (پدر خوانده + ماتادور + ساول گودمن), BOTH زودیاک roles (زودیاک + زودیاک
   پسر, so succession is actually reachable), every civilian special role
   (دکتر, کاراگاه, حرفه‌ای, کنستانتین, اوشن, تفنگدار), inquiries configured
   up to 5, and اوشن capped at 4 recruits (all 4 actually reached). This is
   also the first scenario to build and exercise full God Mode driving
   infrastructure (`device.js`'s `hostSelfRoleInfo`/`isHostSelfActionVisible`/
   `isHostSelfGunActionVisible`/`pickHostSelfCandidate`/
   `setHostSelfRecruitCheckbox`, `game-flow.js`'s `hostSelfVote`/
   `hostSelfNightAction`/`hostSelfInquiryVote`/`hostSelfDayGunDecision`, and
   the auto-pacing-aware `autoAssignRolesAndBegin`/
   `playDay1AndSkipNight1AutoPaced`/`fullVoteRound1`/`fullVoteFinal`). New
   mechanics exercised for the first time here:
   - ساول گودمن's **recruit-instead-of-shoot** checkbox — only appears on
     the Mafia kill-decider's own night-action prompt once ساول گودمن is
     alive and Mafia has already lost someone, and the target must
     presently hold `ROLE_NAME_PLAIN_VILLAGER` exactly or the recruit
     silently no-ops (`resolveNight`'s `mafiaRecruitId` branch).
   - The morning **inquiry vote**, including a genuinely DENIED result (a
     deliberately mixed vote that fails `yes >= floor(alive/2)`) as well as
     two granted ones — the denied path was never exercised before this
     scenario.
   - A real **زودیاک پسر succession**: voting out the original زودیاک while
     پسر is still alive transfers independence and the nightly shot to
     پسر (`transferZodiacLegacy`), and every following night's zodiac
     action correctly routes to پسر's new identity.
   - **God Mode itself**: the host's own seat plays a full role (this run,
     a plain villager who ends up voted out mid-game) alongside everyone
     else, including casting real votes, taking real night actions, and
     being correctly excluded from later rounds once eliminated.
   It ends in a زودیاک win: زودیاک پسر (having succeeded) delivers the
   final shot on a villager freshly recruited into Mafia by ساول گودمن,
   confirming both the succession AND the recruit mechanic all the way
   through to a correct game-over screen on every surviving device.

   A note on "5 daytime inquiries": `numInquiries` is configured up to 5,
   but only a GRANTED inquiry decrements `inquiriesRemaining` — a denied
   one doesn't consume the pool, yet still only re-offers once per day from
   the first elimination onward (`App.closeInquiryVote` in index.html).
   Exhausting all 5 offers literally would need 5 separate inquiry-eligible
   days, which doesn't fit alongside this scenario's other requirements
   (5 full day-votes, 4 اوشن recruits, etc.) without an impractically long
   game. This scenario offers 3 real inquiries — one denied, two granted —
   genuinely exercising both outcomes, with the config left at 5 to confirm
   the game supports that capacity even though this playthrough doesn't
   exhaust it.

Still not covered by anything: the structural `verify.js`-style static
checks (brace/paren balance, fa/en STRINGS parity) an earlier pass of this
harness also had.

**A real gotcha hit building scenario 01**, worth not re-discovering: when a
kill (day-gun or otherwise) happens to also be the LAST Mafia member, the
target's own device receives `'eliminated'` immediately followed by
`'game-over'` (see `announceDayGunOutcome`'s own `App.showGameOver()` call)
— both queued back-to-back, so their screen lands on
`screen-player-game-over` and never visibly settles on
`screen-player-eliminated` at all. Assert on `screen-player-game-over`
directly for a target whose death ends the game, not the intermediate
elimination screen — a `waitFor` on the latter will simply time out.

**God Mode / No God Mode** (`state.godMode`/`state.noGodMode`) both make
`autoPacingOn()` true, which changes the game's own pacing in exactly three
places (confirmed by grepping every `autoPacingOn()` call site in
`index.html`):
- `maybeAutoStartGame()` — deals roles and begins the game itself the
  instant every declared seat has a name, after two chained ~8s reveal
  pauses (so wait generously — `timeout: 20000` — rather than calling
  `App.assignRoles`/`beginGame` and waiting on those).
- `goToDayScreen()` — for any day > 1, calls `App.startVoting()` itself the
  moment the day screen would otherwise show. There is no stable
  `screen-host-day` to observe first; wait for the vote screen instead.
- `broadcastDefensePhase()` — calls `App.startFinalVote()` itself the
  instant round 1's tally closes. There is no stable `screen-host-defense`
  moment to observe or act on either, so round 1's own tally can't be read
  reliably — chain `fullVoteRound1` straight into `fullVoteFinal` and only
  read the tally after the FINAL round settles on `screen-host-result`.

Every other transition (`continueToNight`, `continueAfterEyesClosed`,
`announceMorning`, `proceedAfterNight`, `proceedAfterResult`,
`continueAfterInquiry`, `continueAfterOceanTalk`) is only ever armed as a
real timer under auto-pacing instead of a no-op — calling these manually
and promptly, exactly like a normal game, still works fine.

Other lessons from building God Mode's first scenario:
- **`fullVoteRound1`/`fullVoteFinal` need an ALIVE-filtered player list**,
  not the raw, never-shrinking array of every device ever created — passing
  an already-eliminated real player hangs forever waiting for a
  `screen-player-vote` that will never come. Likewise, the God Mode
  `hostSelfName` argument must become `null`/`undefined` once the host's
  own seat has been eliminated, since the host's role (and therefore the
  host's fate) is dealt randomly just like anyone else's — a scenario can't
  assume the host-self seat survives the whole game.
- **کنستانتین becomes eligible the instant ANYONE is dead**, not just from
  whatever night the scenario planned to use their revive — since Day 2's
  vote-out already creates a valid revive candidate, کنستانتین is prompted
  starting Night 2 even if the scenario wants their once-per-game revive
  spent later. A real (logged) skip is the correct way to hold off.
- **اوشن's talk step fires the instant the team (founder + recruits)
  reaches 2+ alive members** — true starting the very night of the FIRST
  recruit, not just on later nights with an already-established team. This
  is the same recurrence noted in scenario 02, just easy to miss on the
  earliest possible night too.
- **حرفه‌ای and کاراگاه have no per-night eligibility limit at all** (their
  `eligible` callback is `null` in `startCivilianPhaseStep`) — unlike
  کنستانتین/تفنگدار/اوشن which cap out, they must be driven on literally
  every night they're alive, all the way to the last one.
- **تفنگدار the ROLE is a different identity from whoever currently holds
  the physical gun.** `findAliveByRoleName(ROLE_NAME_GUNNER)` always finds
  the original تفنگدار, who keeps deciding handoffs (up to
  `GUNNER_MAX_GUNS = 2` total) regardless of who's currently holding the
  gun; the day-time fire/skip decision belongs to that night's RECIPIENT
  instead, and must clear (via a real fire or skip) before the next handoff
  can happen the following night.
- **اوشن's fatal mistake**: recruiting an actual Mafia member into the
  group kills the RECRUITER, not the target (`state.night.extraDeathIds`)
  — every اوشن recruit target in this scenario is deliberately a confirmed
  non-Mafia identity.
- **ماتادور's block only matters against a civilian night ability** — its
  candidate list already excludes Mafia (`role === 'villager'`), and
  blocking a plain villager with no night action of their own is a genuine,
  harmless no-op, not a suppressed real action.
