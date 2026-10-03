# Word Guess Game

A multiplayer browser game with one describer, multiple guessers, configurable rounds, scoring, pass/pause controls, room chat, and optional WebRTC meeting.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` on the host computer. The server also prints a LAN URL such as `http://192.168.x.x:3000` for devices on the same Wi-Fi.

## Current game rules

- One player is the describer; everyone else is a guesser.
- The describer can set the room's total player target before starting.
- A room can start as soon as at least 2 players are present.
- The describer can choose a 1, 2, 3, or 5 minute round; 5, 10, or 15 prompts; a Classic, Everyday, Work, Party, or Animals pack; and Easy, Medium, or Hard difficulty.
- Correct guesses earn 1 point.
- The describer can PASS a prompt; skipped prompts return later if time remains.
- The describer can Pause/Resume the round.
- If the describer disconnects, the room waits 30 seconds for them to reconnect before promoting an online guesser.
- Invalid guesses are rejected privately and do not appear in the shared guess log.
- Invalid input includes numbers, punctuation, emojis, or guesses whose normalized letter length is shorter/longer than the answer.
- Letters separated by extra spaces or hyphens are normalized before comparison, so spacing/hyphen variations do not prevent a match.
- Offensive guesses are rejected privately.
- After a guesser has made two incorrect guesses for the current prompt, the second and later incorrect guesses trigger a private warning and do not change score or game progress.
- Once the final prompt is correctly guessed and the round ends, later submissions are rejected by the server.
- A 30-second clue cadence timer helps the describer keep clues moving.
- Round-end screens announce the top scorer (or a tie), show both round scores and cumulative standings, and celebrate winners with fireworks. Fireworks and point sounds have local controls.
- The room keeps recent round results and cumulative scores in memory for the duration of the server process.

## Reconnect / preserved points

Each browser stores a private reconnect token for the room in `localStorage`. Players can also copy their private recovery code from the room panel and enter it when joining from another browser or device. The server restores the same player identity and score instead of creating a new player. Keep the recovery code private; anyone with it can take over that player identity.

The reconnect identity is not placed in the room URL. Scores and round history are held in server memory, so restarting the Node.js server clears the active rooms and scores.

## Meeting and chat

Room chat works over the WebSocket connection. Video/audio use browser WebRTC. Camera and microphone access generally require HTTPS (or localhost), so phone camera/mic access may be blocked on a plain `http://192.168.x.x` LAN address.


## Latest updates

- Room creation now asks for a target of 2–6 players (default selection: 2).
- The describer can change the target between 2 and 6 before the round starts.
- The duplicate waiting message under the room header was removed; the waiting status remains in the main game area.
- Phone camera/microphone use requires a secure HTTPS origin in most mobile browsers.

## Make the meeting work on phones with HTTPS

A local address such as `http://192.168.x.x:3000` is not a secure origin, so mobile browsers may block camera/microphone access. The quickest way to test is a Cloudflare Quick Tunnel, which gives your local HTTP server a temporary HTTPS `trycloudflare.com` URL.

1. Start the game in one PowerShell window:

```powershell
npm.cmd start
```

2. Install `cloudflared` for Windows from Cloudflare's official installation/download instructions.

3. Open a second PowerShell window and run:

```powershell
cloudflared tunnel --url http://localhost:3000
```

4. Copy the `https://...trycloudflare.com` URL printed by `cloudflared` and open it on the phone. The room URL will then be HTTPS and the browser can request camera/microphone permission.

Quick Tunnels are temporary for testing; the hostname changes when the process is restarted. For a permanent HTTPS address, use a named Cloudflare Tunnel with a domain.

Official documentation:
- https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- https://developers.cloudflare.com/tunnel/get-started/
