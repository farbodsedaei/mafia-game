# Mafia — Night Session

A mobile-friendly, browser-based Mafia party game. Player devices connect
**directly to each other** over WebRTC once the handshake completes — this
server only serves the app and relays the short connection handshake
(offer/answer/ICE candidates). No game data (names, roles, votes) is ever
stored or logged here.

## Run locally

    npm install
    npm start

Then open http://localhost:8787

## Deploy to Render (free)

1. Push this folder to a new GitHub repository.
2. On Render.com: **New +** → **Web Service** → connect the repo.
3. Settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
4. Deploy. Render gives you a public URL like `https://your-app.onrender.com`.

Note: on the free tier the service sleeps after 15 minutes idle, and the
next visit takes 30-60 seconds to wake it up. Open the link yourself a
minute before your game starts to warm it up for everyone else.

## TURN server (optional, but strongly recommended for groups of 10+)

Without a TURN server, player devices can only connect to the host directly
(peer-to-peer) — which fails outright for anyone on cellular data, a
corporate/hotel/guest WiFi, or similar restrictive networks, no matter how
many times they retry. The more players you have, the higher the odds that
at least one of them hits this. A TURN server relays the connection for
exactly those cases. If it's not configured, the host's own setup screen
shows a warning saying so.

Set ONE of these two (Cloudflare takes priority if both happen to be set):

**Option A — Cloudflare Realtime TURN** (recommended: generous free tier —
1,000 GB/month shared across Cloudflare's whole Realtime product, far more
than this app's text-only game data will ever use):
1. Sign in (or sign up — free) at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Find **Realtime** in the dashboard sidebar → **TURN** → **Create TURN key**.
3. Copy the **TURN Key ID** and the **TURN Key API Token** it gives you (the
   token is a secret — treat it like a password).
4. On Render: your service → **Environment** → add two variables:
   - `CF_TURN_KEY_ID` = the Key ID
   - `CF_TURN_KEY_API_TOKEN` = the API Token
5. Render redeploys automatically. `server.js` calls Cloudflare's API on
   your behalf to mint short-lived credentials — nothing else to configure.

**Option B — any static-credential TURN provider** (Metered.ca's Open
Relay, Xirsys, a self-hosted coturn, etc.) — set these three instead:
- `TURN_URL` — one URL, or several comma-separated
- `TURN_USERNAME` / `TURN_CREDENTIAL` — from your provider

## How it works

- Host opens the URL, sets player/Mafia counts, and gets a room code + link.
- Each player opens the link (or types the code) — their phone connects
  directly to the host's phone/browser over WebRTC.
- Once connected, players submit their name to the host.
- Host taps "Assign Roles" — roles are shuffled and sent privately to each
  player's own device.
