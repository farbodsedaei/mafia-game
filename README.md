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

## How it works

- Host opens the URL, sets player/Mafia counts, and gets a room code + link.
- Each player opens the link (or types the code) — their phone connects
  directly to the host's phone/browser over WebRTC.
- Once connected, players submit their name to the host.
- Host taps "Assign Roles" — roles are shuffled and sent privately to each
  player's own device.
