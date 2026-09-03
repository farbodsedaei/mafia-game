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

4. `04-revote-after-reconnect` — regression test for a reported bug: "if
   someone casts their vote and then disconnects or refreshes their
   browser, they're asked to vote again — and their new vote applies on
   top of the previous one." `handlePlayerVote` was already safe at the
   data layer (`state.votesRound1/2` is a Map keyed by voterId, so a
   genuine re-submission from the same identity always just overwrites) —
   confirmed here by driving an automatic same-token reconnect (a dropped
   connection, browser data intact). What genuinely WAS broken: the resync
   always replayed a totally blank vote screen with no sign an earlier
   vote was on record — confusing on its own, and risky in this
   multi-select (accuse-several-people) UI specifically, since checking
   one more box on top of an unnoticed stale selection would have
   genuinely, correctly counted both. Fixed with a
   `'vote-already-submitted'` follow-up message (`resyncPlayer`) that
   tells the reconnecting client what's already on record, surfaced as a
   plain-text notice (`#vote-already-voted-hint`) naming their prior
   pick(s) — deliberately WITHOUT pre-checking any boxes, so resubmitting
   stays a clean replacement rather than an accidental stack. Asserts the
   notice's exact wording, that nothing is pre-checked on reconnect, and
   that the final tally only ever reflects the latest vote.

5. `05-no-seat-reclaim-plus-test-mode` — regression test for a reported
   security issue: a disconnected player's seat used to be reclaimable by
   ANY new connection just by picking their name off a list
   (`handleClaimSeat`), with zero verification — letting anyone quietly
   peek at someone else's role and disconnect again. That whole mechanism
   (the `'reclaimable-seats'`/`'claim-seat'`/`'claim-accepted'`/
   `'claim-failed'` messages, `screen-player-reclaim-seat`,
   `entry.overCapacityTemp`'s over-capacity admission) has been removed
   entirely — a device can now ONLY ever rejoin as whichever identity its
   own persisted session (`savePlayerSession`) proves it is; a fresh
   connection with no matching session is always a genuinely new, separate
   player, even if it types someone else's exact display name. **Part 1**
   confirms this directly: a fresh device sees only the plain name-entry
   screen (no seat picker exists in the DOM at all), typing an existing
   player's name gets a freshly-dealt role and a genuinely separate
   dossier entry, and the real player's own role is untouched throughout.
   The removal has a real side effect worth covering too: self-serve
   reclaim used to be how the same machine's browser could plausibly run
   multiple simulated players; without it, testing needs a real mechanism
   for that, so the setup screen gained a **Test Mode** checkbox
   (`App.setTestMode`/`state.testMode`, plumbed through `server.js`'s
   room object and the `'joined'` reply) that persists a session in
   per-tab `sessionStorage` instead of the normally-shared `localStorage`,
   with the choice baked into the stored payload itself so it survives a
   refresh without needing a fresh round trip to re-learn it. **Part 2**
   verifies the mechanism directly against each device's own storage
   (sessionStorage holds it, localStorage is pruned, a real reconnect
   still works fine within that one tab) rather than attempting to fake
   real cross-tab storage sharing, which — unlike an actual browser —
   jsdom never does between independently-created windows in the first
   place. A **control** case confirms a normal (non-Test-Mode) game is
   completely unchanged, still using localStorage as before.

6. `06-no-god-mode-full-game-log` — feature test for a reported request:
   "in No God Mode where the app drives the game with no host or god, at
   the end of the game the app should produce a full log — actions and
   votes — clarifying how the game was done." A No God Mode game genuinely
   has nobody watching the host device as it plays out, so nothing about
   HOW it actually unfolded (who blocked whom, what a detective's
   investigation actually found, who Mafia actually shot) was ever visible
   anywhere once the moment passed — only the bare public outcome. Added
   `state.gameLog` (`index.html`): every public day/night/inquiry/day-gun
   outcome gets one line the moment it's announced (`logGameEvent`), and —
   safe only once the game has fully ended — each night's individual,
   previously-PRIVATE decisions (already comprehensively tracked per
   night-acting role via the existing `recordNightDecision`/
   `state.night.decisionsLog`) get folded in too, right when that night
   resolves. Bundled into the existing `'game-over'` message (a new `log`
   field) and rendered — merged chronologically with the already-separate,
   continuously-updated `state.voteHistory` feed — behind a new "View Full
   Game Log" link on every game-over screen (host's own, and every real
   player's, via the shared `App.viewGameLog()`/`renderGameLogInto` — same
   precedent as My Role/My Activity/Vote History already being screens the
   host also visits, see `showScreen`'s own comment on that pattern). This
   scenario runs a real 5-player No God Mode game entirely hands-off (zero
   manual role-assign/begin/vote-open calls — only the 3 genuinely
   auto-triggered moments are waited on, never driven) through two day-vote
   eliminations and one real night (a Mafia kill + a detective
   investigation) to a Mafia win, then checks the FINAL rendered log — on
   the host's own screen AND independently on an eliminated player's
   device (proving the `'game-over'` message's own log data, not just the
   host's local copy) — actually contains all of it: both eliminations,
   the night kill, the detective's investigation target, and the final
   winner line.

7. `07-vote-history-always-visible` — regression test for a reported bug:
   "the vote history should be visible by all players in all scenarios and
   all games at all times — i see in god mode players don't see that when
   voting prompt is active." The `.vote-history-link` button
   (`App.viewVoteHistory`) was only ever present on 4 of a real player's
   ~16 in-game screens — notably absent from `screen-player-vote` itself
   (the exact screen the report called out), `screen-player-night-action`,
   and every inquiry/waiting/result/eliminated/game-over screen. Not
   God-Mode-specific — every real player in every mode was missing it on
   those screens, the user just happened to notice it while testing God
   Mode. Fixed by adding it to all 15 remaining in-game player screens
   (`index.html`) — the same universal-access treatment `.activity-link`
   ("My Activity") already got in an earlier pass; the existing
   `updateVoteHistoryLinkVisibility()` needed no changes at all, since its
   `querySelectorAll('.vote-history-link')` already picks up every newly-
   added button automatically. **Part A** (a normal game) confirms the link
   is correctly HIDDEN on Day 1 (no vote has happened yet), then visible on
   the Day-2 result screen, an ACTIVE Night-2 night-action prompt, and —
   the exact reported case — an ACTIVE Day-3 voting prompt. **Part B**
   confirms the same for a real player inside an actual **God Mode** game,
   plus that God Mode's own separate, pre-existing host-self vote-history
   button (`host-self-vote-history-btn`) still works too, untouched by this
   change. Both parts deliberately pin `numPlayers`/`numMafia` down (rather
   than relying on the default 6p/2m split) and pick the Day-2 elimination
   target by checking who ISN'T Mafia (`mafiaNames`, not a hardcoded seat)
   — an earlier draft of this scenario picked a fixed player name and hit
   real, reproducible flakiness: whenever the random role shuffle happened
   to deal Mafia to that exact name, eliminating them ended the game
   immediately (0 or equal Mafia left) before the scenario ever reached the
   night/Day-3 checks it needed.

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
