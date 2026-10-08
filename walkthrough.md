# Real-Time Multiplayer Mafia: Walkthrough & Verification

A complete, real-time multiplayer implementation of the social deduction game **Mafia** built from scratch using Node.js, Express, Socket.io, and a responsive vanilla HTML5/CSS3/JavaScript SPA frontend.

---

## 1. Architecture & Feature Highlights

### Strict Server-Authoritative State Machine
- **Network Role Masking**: Client sockets never receive raw room objects or other players' roles during active play. Roles remain hidden until either the post-game reveal or between fellow Mafia members at night.
- **Atomic Night Resolution**:
  1. Doctor's protection is registered (with a strict rule disallowing protecting the same target two consecutive nights).
  2. Mafia kill attempt is calculated against the protected target.
  3. The Detective query is resolved: if the Detective died that same night, their report is suppressed (`KILLED_BEFORE_REPORT`) to eliminate post-mortem information leaks.
  4. Dawn broadcast announces all morning casualties simultaneously.
- **Absolute Living Majority Voting**:
  $$\text{Threshold} = \left\lfloor \frac{N_{\text{living}}}{2} \right\rfloor + 1$$
  Eliminations occur if and only if a candidate reaches or exceeds this absolute majority threshold. If the timer expires without a candidate reaching threshold, or if "Skip" prevails, no one is eliminated.
- **Revocable Mafia Night Coordination**:
  - Mafia members can switch targets dynamically.
  - Live preview (`mafia_target_preview`) is broadcast strictly to living Mafia sockets.
  - Unanimous consensus allows early night resolution; deadlocked ties cause assassinations to fail.
- **Epoch-Based Stateless Timers**:
  - The server transmits `phaseEndsAt: Date.now() + durationMs`.
  - Clients compute display timers using `requestAnimationFrame` visual interpolation, completely immune to mobile background tab throttling.
- **Lazy Web Audio API Engine**:
  - Procedural sound synthesis (night toll, morning chime, gavel click, gunshot, victory fanfare).
  - AudioContext is created/resumed strictly upon user click interactions, fully complying with modern browser autoplay policies.

---

## 2. Game-State Transition Flow

The server-authoritative state engine implements the following exact game-state loop:

```
LOBBY
  ↓
ROLE ASSIGNMENT
  ↓
NIGHT
  ↓
NIGHT RESOLUTION
  ↓
DAWN
  ↓
DISCUSSION
  ↓
VOTING
  ↓
VOTE RESOLUTION
  ↓
WIN CHECK
  ↓
 ┌───────────────────────┐
 │                       │
Nobody wins          Someone wins
 │                       │
 ↓                       ↓
NIGHT                 GAME OVER
```

---

## 3. Core Game Mechanics

### 1. Exact Win Conditions
- **Town/Civilians Win**: Town wins when **all Mafia players are eliminated** (`livingMafia === 0`).
- **Mafia Win**: Mafia win when the number of **living Mafia players becomes strictly greater than the number of living Town players** (`livingMafia > livingTown`).
- **Town Composition**: Doctor, Detective, Vanilla Villagers, and Shadow-who-chose-Town all count as Town for this calculation.
- Evaluated on the existing game architecture and win-checking system without extraneous win conditions.

### 2. Mafia Coordination System
- **Identity Awareness**: Every Mafia player knows who the other Mafia players are.
- **Night Discussion**: Living Mafia players can communicate privately during the Night phase (`msg.channel = 'MAFIA'`).
- **Collective Kill Selection**: Mafia members collectively decide who to assassinate.
- **Dynamic Re-targeting**: Mafia players can change their target dynamically at any point prior to night resolution.
- **Living Mafia Target Preview**: Real-time target previews (`mafia_target_preview`) are streamed strictly to sockets of living Mafia members.
- **Consensus & Deadlock Rules**: Unanimous consensus among living Mafia allows early night resolution; tie votes / deadlock between Mafia result in assassination failure.

---

## 4. Dynamic Role Balancing Matrix
The server dynamically scales role distribution based on player count upon game start:

| Player Count | Mafia Count | Power Roles (Town) | Vanilla Villagers |
| :--- | :--- | :--- | :--- |
| **4–6** | 1 | 1 Doctor, 1 Detective | Remainder |
| **7–11** | 2 | 1 Doctor, 1 Detective | Remainder |
| **12+** | 3 | 1 Doctor, 1 Detective | Remainder |

---

## 5. Files Created

- [package.json](file:///c:/Users/nithi/OneDrive/Desktop/mafia/package.json): Configured with `express` and `socket.io`.
- [server.js](file:///c:/Users/nithi/OneDrive/Desktop/mafia/server.js): Complete in-memory state engine, room session manager, XSS sanitization, 15s disconnect grace handler, atomic night resolver, and test bot simulator.
- [public/index.html](file:///c:/Users/nithi/OneDrive/Desktop/mafia/public/index.html): Dark slate theme, HUD with live role badge, animated countdown progress bar, player grid with vote tallies, contextual action drawer, split event ticker & chat, and Web Audio SFX.

---

## 6. Verification & Browser Demonstration

Interactive end-to-end testing was conducted using the browser subagent at `http://localhost:3000`:
1. **Lobby Creation**: Host entered room as `"Godfather"` and received room code `QSNC`.
2. **Bot Spawning & Minimum Validation**: Added 3 test bots (`Agent 1`, `Agent 2`, `Agent 3`). The Start Game button dynamically enabled once the 4-player threshold was satisfied.
3. **Role Assignment**: Server assigned roles according to the 4-player scaling formula (Mafia, Doctor, Detective, Villager).
4. **Night Phase & Ability Target Selection**: Host (assigned Doctor) was presented with the Doctor Sanctuary action drawer and successfully selected a protection target.
5. **Dawn Resolution**: Dawn announcements broadcast morning casualties atomically in the Game Ticker.
6. **Chat & Trial Voting**: Discussion chat messages and live vote tallies resolved with the absolute majority threshold.
7. **Game Over & Role Reveal**: Concluded with full role reveals and a functional "Return to Lobby" action for subsequent rounds.

### Demonstration Recording
![Browser Session Video](C:/Users/nithi/.gemini/antigravity-ide/brain/5c6ebf18-c504-4a4a-bace-75c2136a2cc8/mafia_full_game_test_1791444304347.webp)

---

## 7. Running the Application Locally

To start the server manually at any time:
```bash
cd c:/Users/nithi/OneDrive/Desktop/mafia
npm start
```
Then visit `http://localhost:3000` in any web browser.
