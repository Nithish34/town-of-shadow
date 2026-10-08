# Mafia: Real-Time Multiplayer Social Deduction Game

A server-authoritative real-time web implementation of the classic social deduction game **Mafia**, built with Node.js, Express, Socket.io, and a responsive vanilla HTML5/CSS3/JavaScript SPA frontend.

---

## Game-State Transition Diagram

The actual game flow follows this state machine loop:

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

## Core Game Rules & Mechanics

### 1. Win Conditions
- **Town/Civilians Win**: Town wins when **all Mafia players are eliminated** (`livingMafia === 0`).
- **Mafia Win**: Mafia win when the number of **living Mafia players becomes greater than the number of living Town players** (`livingMafia > livingTown`).
- **Town Composition**: Doctor, Detective, Vanilla Villagers, and Shadow-who-chose-Town all count as Town for this calculation.
- Evaluated strictly using the server's win-checking system.

### 2. Mafia Coordination
- **Identity Awareness**: Every Mafia player knows who the other Mafia players are.
- **Night Discussion**: Living Mafia players can communicate with each other in real-time during the Night phase via private channel (`MAFIA`).
- **Collective Kill Selection**: Mafia members collectively decide who to assassinate each night.
- **Dynamic Re-targeting**: Mafia players can change their selected target dynamically at any time before the night phase concludes.
- **Target Preview**: Live target selections are broadcast exclusively to living Mafia players.
- **Consensus & Deadlocks**: Unanimous consensus allows early night resolution; deadlocked ties cause assassinations to fail.

---

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Open your browser and navigate to `http://localhost:3000`.

---

## Deployment (Render)

### Option 1: Render Blueprint (Recommended)
This repository includes a `render.yaml` specification for one-click deployment to Render's Free Web Service tier:
1. Push your repository to GitHub or GitLab.
2. Log in to [Render Dashboard](https://dashboard.render.com).
3. Click **New +** > **Blueprint**.
4. Connect your repository. Render will automatically detect `render.yaml` and configure:
   - **Service Name**: `mafia-game`
   - **Environment**: Node.js (`node:20+`)
   - **Plan**: Free
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check**: `/healthz` (enables zero-downtime deployment health validation)
   - **WebSockets**: Persistent Socket.io connections supported out-of-the-box

### Option 2: Docker Container Runtime
If you prefer running via Docker container:
- A production multi-stage `Dockerfile` (based on `node:20-alpine`) and `.dockerignore` are included.
- On Render, select **New +** > **Web Service** > choose **Docker** runtime.
- Render will build the container using `npm ci --only=production` and expose the application.

