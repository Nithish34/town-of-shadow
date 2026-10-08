const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3000;

// Health check endpoint for Render zero-downtime deployment probes
app.get('/healthz', (req, res) => res.status(200).send('OK'));

app.use(express.static(path.join(__dirname, 'public')));

process.on('uncaughtException', (err) => {
  console.error('SERVER UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('SERVER UNHANDLED REJECTION:', reason);
});

// Simple HTML escaping helper for XSS prevention
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .slice(0, 100);
}

// In-Memory Game Store
const rooms = new Map(); // roomId -> Room

function generateRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

// ==========================================================
// FEATURE 1: LAST WORDS — Predefined statements list
// ==========================================================
const LAST_WORDS_STATEMENTS = [
  "I trusted you all... that was my mistake.",
  "The truth will come out eventually.",
  "Avenge me, dear town.",
  "I go peacefully. I was innocent.",
  "Mark my words — the real killer is among you still.",
  "I had my suspicions... I should have spoken sooner.",
  "Don't let them win. Stay vigilant.",
  "Farewell. May justice find its way.",
  "I die knowing the truth. Do you?",
  "The shadows grow longer... be careful who you trust.",
  "This isn't over. The game continues without me.",
  "Some of you know what really happened. Shame on you.",
  "I forgive you... even if you don't deserve it.",
  "Watch your backs. The wolf is still hungry.",
  "My silence is broken only by my last breath."
];

// ==========================================================
// FEATURE 2: RANDOM EVENTS — Event pool
// BLACKOUT: Detective cannot investigate that Night.
// PANIC: Voting phase eliminates TWO players.
// SAFE_NIGHT: Mafia cannot kill that Night.
// null (x3): No event (~50% chance of no event).
// ==========================================================
const RANDOM_EVENT_POOL = ['BLACKOUT', 'PANIC', 'SAFE_NIGHT', null, null, null];

function rollRandomEvent() {
  return RANDOM_EVENT_POOL[Math.floor(Math.random() * RANDOM_EVENT_POOL.length)];
}

function createRoom(roomId, hostPlayerId) {
  const room = {
    id: roomId,
    hostPlayerId,
    phase: 'LOBBY', // 'LOBBY' | 'NIGHT' | 'DAY_DISCUSSION' | 'TRIAL_VOTING' | 'GAME_OVER'
    round: 1,
    phaseEndsAt: null,
    timerTimeout: null,
    settings: {
      pace: 'NORMAL', // 'BLITZ' | 'NORMAL' | 'CASUAL'
      nightSec: 30,
      discussionSec: 45,
      votingSec: 30,
    },
    players: new Map(), // playerId -> Player
    nightActions: {
      mafiaTargets: {}, // mafiaPlayerId -> targetPlayerId
      doctorTarget: null,
      detectiveTarget: null,
    },
    doctorLastProtected: null,
    votes: {}, // playerId -> targetPlayerId | 'SKIP' | [v1, v2] (Panic)
    logs: [],
    winner: null, // 'TOWN' | 'MAFIA' | null
    chatMessages: [], // { id, senderName, senderId, text, channel, timestamp }

    // FEATURE 2: Active random event for this night/day cycle
    currentRandomEvent: null, // null | 'BLACKOUT' | 'PANIC' | 'SAFE_NIGHT'

    // FEATURE 1: Last Words queue
    pendingLastWords: [], // [ { playerId, playerName } ]
    lastWordsCallback: null,

    // FEATURE 3: Shoo — set of silenced player IDs
    shooedPlayerIds: new Set(),
    shooUsed: false, // can only be used once per game

    // FEATURE 4: Shadow — team choice
    shadowChoice: null, // null | { playerId, chosenTeam: 'MAFIA' | 'TOWN' }
    shadowChoiceDeadlineRound: null,
  };
  rooms.set(roomId, room);
  return room;
}

function addLog(room, text, type = 'info') {
  const logEntry = {
    id: crypto.randomUUID(),
    text,
    type, // 'info' | 'phase' | 'kill' | 'save' | 'vote' | 'system' | 'last_words' | 'event' | 'shoo'
    timestamp: Date.now()
  };
  room.logs.push(logEntry);
  if (room.logs.length > 100) room.logs.shift();
  io.to(room.id).emit('game_log', logEntry);
}

function getLivingPlayers(room) {
  return Array.from(room.players.values()).filter(p => p.alive);
}

// FEATURE 4: Shadow who chose MAFIA counts as Mafia for win condition
function getLivingMafia(room) {
  return Array.from(room.players.values()).filter(p => {
    if (!p.alive) return false;
    if (p.role === 'MAFIA') return true;
    if (p.role === 'SHADOW' && room.shadowChoice &&
        room.shadowChoice.playerId === p.id &&
        room.shadowChoice.chosenTeam === 'MAFIA') return true;
    return false;
  });
}

// FEATURE 4: Shadow who chose TOWN (or hasn't chosen) counts as Town
function getLivingTown(room) {
  return Array.from(room.players.values()).filter(p => {
    if (!p.alive) return false;
    if (p.role === 'MAFIA') return false;
    if (p.role === 'SHADOW' && room.shadowChoice &&
        room.shadowChoice.playerId === p.id &&
        room.shadowChoice.chosenTeam === 'MAFIA') return false;
    return true;
  });
}
const getLivingInnocents = getLivingTown;

function getVotingThreshold(livingCount) {
  return Math.floor(livingCount / 2) + 1;
}

// State Projection - Masks private information per client
function serializeStateForPlayer(room, playerId) {
  const me = room.players.get(playerId);
  const livingCount = getLivingPlayers(room).length;
  const threshold = getVotingThreshold(livingCount);

  // FEATURE 4: Shadow knows ALL roles
  const isShadow = me && me.role === 'SHADOW';

  const playerList = Array.from(room.players.values()).map(p => {
    let revealedRole = null;
    let isAlly = false;
    // FEATURE 3: isShooed is public info (the fact of silence, not the reason)
    const isShooed = room.shooedPlayerIds.has(p.id);

    if (room.phase === 'GAME_OVER') {
      revealedRole = p.role;
    } else if (p.id === playerId) {
      revealedRole = p.role;
    } else if (me && me.role === 'MAFIA' && p.role === 'MAFIA') {
      revealedRole = 'MAFIA';
      isAlly = true;
    } else if (isShadow) {
      // FEATURE 4: Shadow sees every player's true role
      revealedRole = p.role;
    }
    // Everyone else: revealedRole stays null

    return {
      id: p.id,
      name: p.name,
      alive: p.alive,
      connected: p.connected,
      isHost: p.id === room.hostPlayerId,
      isBot: p.isBot,
      role: revealedRole,
      isAlly,
      isShooed // FEATURE 3: visible to everyone
    };
  });

  // Calculate live vote tallies for Trial phase
  const voteTallies = {};
  if (room.phase === 'TRIAL_VOTING') {
    for (const voteVal of Object.values(room.votes)) {
      if (Array.isArray(voteVal)) {
        // Panic: each player has an array of 2 votes
        for (const v of voteVal) {
          if (v && v !== 'SKIP') voteTallies[v] = (voteTallies[v] || 0) + 1;
        }
      } else {
        if (voteVal && voteVal !== 'SKIP') voteTallies[voteVal] = (voteTallies[voteVal] || 0) + 1;
      }
    }
  }

  // Night metadata specific to my role
  let myNightContext = null;
  if (me && me.alive && room.phase === 'NIGHT') {
    if (me.role === 'MAFIA') {
      myNightContext = {
        role: 'MAFIA',
        myCurrentTarget: room.nightActions.mafiaTargets[me.id] || null,
        fellowTargets: room.nightActions.mafiaTargets,
        shooAvailable: !room.shooUsed // FEATURE 3
      };
    } else if (me.role === 'DOCTOR') {
      myNightContext = {
        role: 'DOCTOR',
        lastProtected: room.doctorLastProtected,
        myCurrentTarget: room.nightActions.doctorTarget
      };
    } else if (me.role === 'DETECTIVE') {
      myNightContext = {
        role: 'DETECTIVE',
        myCurrentTarget: room.nightActions.detectiveTarget,
        blackout: room.currentRandomEvent === 'BLACKOUT' // FEATURE 2
      };
    } else if (me.role === 'SHADOW') {
      // FEATURE 4: Shadow receives all roles
      const allRoles = {};
      for (const p of room.players.values()) {
        allRoles[p.id] = p.role;
      }
      myNightContext = {
        role: 'SHADOW',
        allRoles,
        hasChosen: !!(room.shadowChoice && room.shadowChoice.playerId === me.id),
        chosenTeam: (room.shadowChoice && room.shadowChoice.playerId === me.id)
          ? room.shadowChoice.chosenTeam : null,
        shadowChoiceDeadlineRound: room.shadowChoiceDeadlineRound || null,
        canChooseNow: room.round >= (room.shadowChoiceDeadlineRound || 1)
      };
    } else {
      myNightContext = { role: 'VILLAGER' };
    }
  }

  // FEATURE 1: Last Words prompt — only for the queued player
  let lastWordsPrompt = null;
  if (room.pendingLastWords.length > 0 && room.pendingLastWords[0].playerId === playerId) {
    lastWordsPrompt = {
      statements: LAST_WORDS_STATEMENTS,
      playerName: room.pendingLastWords[0].playerName
    };
  }

  const amIShooed = room.shooedPlayerIds.has(playerId);

  return {
    roomId: room.id,
    phase: room.phase,
    round: room.round,
    phaseEndsAt: room.phaseEndsAt,
    settings: room.settings,
    isHost: me ? me.id === room.hostPlayerId : false,
    me: me ? {
      id: me.id,
      name: me.name,
      alive: me.alive,
      role: me.role,
      isShooed: amIShooed // FEATURE 3
    } : null,
    players: playerList,
    livingCount,
    votingThreshold: threshold,
    votes: room.phase === 'TRIAL_VOTING' ? room.votes : {},
    voteTallies,
    myNightContext,
    winner: room.winner,
    logs: room.logs.slice(-30),
    // Feature-specific fields
    lastWordsPrompt,           // FEATURE 1
    activeRandomEvent: room.currentRandomEvent, // FEATURE 2
    panicVoteCount: room.currentRandomEvent === 'PANIC' ? 2 : 1, // FEATURE 2
    shadowChoiceDeadlineRound: room.shadowChoiceDeadlineRound // FEATURE 4
  };
}

function broadcastRoomState(room) {
  for (const player of room.players.values()) {
    if (player.socketId) {
      const state = serializeStateForPlayer(room, player.id);
      io.to(player.socketId).emit('room_state', state);
    }
  }
}

function clearRoomTimer(room) {
  if (room.timerTimeout) {
    clearTimeout(room.timerTimeout);
    room.timerTimeout = null;
  }
}

// Role Balancing Algorithm
function assignRoles(room) {
  const playerList = Array.from(room.players.values());
  const count = playerList.length;

  let mafiaCount = 1;
  let hasDoctor = true;
  let hasDetective = true;

  if (count >= 4 && count <= 6) {
    mafiaCount = 1;
  } else if (count >= 7 && count <= 11) {
    mafiaCount = 2;
  } else if (count >= 12) {
    mafiaCount = 3;
  }

  const roleDeck = [];
  for (let i = 0; i < mafiaCount; i++) roleDeck.push('MAFIA');
  if (hasDoctor) roleDeck.push('DOCTOR');
  if (hasDetective) roleDeck.push('DETECTIVE');

  // FEATURE 4: Shadow — assigned if 5+ players
  if (count >= 5) {
    roleDeck.push('SHADOW');
  }

  while (roleDeck.length < count) {
    roleDeck.push('VILLAGER');
  }

  // Fisher-Yates Shuffle
  for (let i = roleDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roleDeck[i], roleDeck[j]] = [roleDeck[j], roleDeck[i]];
  }

  playerList.forEach((p, idx) => {
    p.role = roleDeck[idx];
    p.alive = true;
  });

  room.round = 1;
  room.doctorLastProtected = null;
  room.winner = null;
  room.currentRandomEvent = null;
  room.pendingLastWords = [];
  room.lastWordsCallback = null;
  room.shooedPlayerIds = new Set();
  room.shooUsed = false;
  room.shadowChoice = null;

  // FEATURE 4: Shadow deadline = roughly "middle" of expected game
  // Estimated rounds ≈ half the players. Deadline = midpoint of that.
  const estimatedTotalRounds = Math.max(3, Math.ceil(count / 2));
  room.shadowChoiceDeadlineRound = Math.ceil(estimatedTotalRounds / 2);
}

// Check Win Conditions
// Town/Civilians win when all Mafia players are eliminated.
// Mafia win when the number of living Mafia players becomes greater than the number of living Town players.
// Doctor, Detective, Vanilla Villagers, and Shadow-who-chose-Town all count as Town.
function checkWinCondition(room) {
  const livingMafia = getLivingMafia(room).length;
  const livingTown = getLivingTown(room).length;

  if (livingMafia === 0) {
    room.winner = 'TOWN';
    endGame(room, 'All Mafia players have been eliminated! Town wins!');
    return true;
  }

  if (livingMafia > livingTown) {
    room.winner = 'MAFIA';
    endGame(room, 'The number of living Mafia players is greater than living Town players! Mafia wins!');
    return true;
  }

  return false;
}

function endGame(room, message) {
  clearRoomTimer(room);
  room.phase = 'GAME_OVER';
  room.phaseEndsAt = null;
  addLog(room, `ðŸ† GAME OVER: ${message}`, 'kill');
  broadcastRoomState(room);
}

/*
==================================================
GAME-STATE TRANSITION DIAGRAM

LOBBY
  ↓
ROLE ASSIGNMENT
  ↓
NIGHT  [FEATURE 2: roll random event]
  ↓
NIGHT RESOLUTION
  ↓
[FEATURE 1: LAST WORDS for night victims]
  ↓
DAY_DISCUSSION
  ↓
TRIAL_VOTING  [FEATURE 2: PANIC = 2 eliminations]
  ↓
VOTE RESOLUTION
  ↓
[FEATURE 1: LAST WORDS for vote victims]
  ↓
WIN CHECK
  ↓
 â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
 │                       │
Nobody wins          Someone wins
 │                       │
 ↓                       ↓
NIGHT                 GAME OVER
==================================================
*/

// FSM Transitions
function startNight(room) {
  clearRoomTimer(room);
  room.phase = 'NIGHT';
  const duration = (room.settings?.nightSec || 30) * 1000;
  room.phaseEndsAt = Date.now() + duration;

  room.nightActions = {
    mafiaTargets: {},
    doctorTarget: null,
    detectiveTarget: null
  };
  room.votes = {};

  // FEATURE 2: Roll a random event for this night/day cycle
  const event = rollRandomEvent();
  room.currentRandomEvent = event;

  let nightLogMsg = `🌙 Night ${room.round} has fallen. The town sleeps...`;
  if (event === 'BLACKOUT') {
    addLog(room, nightLogMsg, 'phase');
    addLog(room, `⚡ [RANDOM EVENT] BLACKOUT — A power surge blocks the Detective's investigation tonight!`, 'event');
  } else if (event === 'SAFE_NIGHT') {
    addLog(room, nightLogMsg, 'phase');
    addLog(room, `🛡️ï¸ [RANDOM EVENT] SAFE NIGHT — A protective shroud prevents any Mafia kill tonight!`, 'event');
  } else if (event === 'PANIC') {
    addLog(room, nightLogMsg, 'phase');
    addLog(room, `😱 [RANDOM EVENT] PANIC — Fear grips the town! Tomorrow's trial will eliminate TWO players!`, 'event');
  } else {
    addLog(room, nightLogMsg, 'phase');
  }

  broadcastRoomState(room);

  // Trigger bots for night phase
  simulateBotNightActions(room);

  room.timerTimeout = setTimeout(() => {
    resolveNight(room);
  }, duration);
}

function checkEarlyNightResolution(room) {
  if (room.phase !== 'NIGHT') return;

  const livingMafia = getLivingMafia(room);
  const livingDoctor = Array.from(room.players.values()).find(p => p.alive && p.role === 'DOCTOR');
  const livingDetective = Array.from(room.players.values()).find(p => p.alive && p.role === 'DETECTIVE');

  // FEATURE 2: BLACKOUT — don't wait for Detective
  const detectiveBlocked = room.currentRandomEvent === 'BLACKOUT';

  // 1. Check Mafia unanimity
  if (livingMafia.length > 0) {
    const mafiaTargets = livingMafia.map(m => room.nightActions.mafiaTargets[m.id]);
    const allPicked = mafiaTargets.every(t => t !== undefined && t !== null);
    if (!allPicked) return;
    const firstTarget = mafiaTargets[0];
    const unanimous = mafiaTargets.every(t => t === firstTarget);
    if (!unanimous) return;
  }

  // 2. Check Doctor
  if (livingDoctor && !room.nightActions.doctorTarget) return;

  // 3. Check Detective (skip if blackout)
  if (livingDetective && !room.nightActions.detectiveTarget && !detectiveBlocked) return;

  resolveNight(room);
}

// Atomic Night Resolution
function resolveNight(room) {
  if (room.phase !== 'NIGHT') return;
  clearRoomTimer(room);

  const killedPlayerIds = new Set();
  const protectedTargetId = room.nightActions.doctorTarget;
  room.doctorLastProtected = protectedTargetId;

  // 1. Evaluate Mafia Attack
  // FEATURE 2: SAFE_NIGHT suppresses Mafia kill
  const livingMafia = getLivingMafia(room);
  let mafiaVictimId = null;

  if (room.currentRandomEvent !== 'SAFE_NIGHT' && livingMafia.length > 0) {
    const votes = {};
    for (const m of livingMafia) {
      const target = room.nightActions.mafiaTargets[m.id];
      if (target) votes[target] = (votes[target] || 0) + 1;
    }

    let topTarget = null;
    let topCount = 0;
    let isTie = false;

    for (const [targetId, count] of Object.entries(votes)) {
      if (count > topCount) {
        topTarget = targetId;
        topCount = count;
        isTie = false;
      } else if (count === topCount) {
        isTie = true;
      }
    }

    if (!isTie && topTarget) {
      mafiaVictimId = topTarget;
    } else if (isTie) {
      addLog(room, '⚠️ï¸ Mafia was split and failed to execute an assassination due to lack of coordination.', 'info');
    }
  }

  if (mafiaVictimId) {
    if (mafiaVictimId === protectedTargetId) {
      addLog(room, '🛡️ï¸ The Doctor successfully protected someone from assassination tonight!', 'save');
    } else {
      killedPlayerIds.add(mafiaVictimId);
    }
  }

  // Apply deaths atomically before detective evaluation
  const victims = [];
  for (const victimId of killedPlayerIds) {
    const victim = room.players.get(victimId);
    if (victim && victim.alive) {
      victim.alive = false;
      victims.push(victim);
    }
  }

  // 2. Evaluate Detective Query
  // FEATURE 2: BLACKOUT suppresses detective result
  const detective = Array.from(room.players.values()).find(p => p.role === 'DETECTIVE');
  const detectiveTargetId = room.nightActions.detectiveTarget;

  if (detective && detective.socketId) {
    if (room.currentRandomEvent === 'BLACKOUT') {
      if (detective.alive) {
        io.to(detective.socketId).emit('detective_result', {
          status: 'BLACKOUT',
          message: 'BLACKOUT! Your investigation was suppressed tonight. Try again next night.'
        });
      }
    } else if (detectiveTargetId) {
      const targetPlayer = room.players.get(detectiveTargetId);
      if (detective.alive) {
        const alignment = (targetPlayer && targetPlayer.role === 'MAFIA') ? 'Guilty (Mafia)' : 'Innocent (Town)';
        io.to(detective.socketId).emit('detective_result', {
          status: 'SUCCESS',
          targetName: targetPlayer ? targetPlayer.name : 'Unknown',
          alignment
        });
      } else {
        io.to(detective.socketId).emit('detective_result', {
          status: 'KILLED_BEFORE_REPORT',
          message: 'You were assassinated before you could complete your investigation.'
        });
      }
    }
  }

  // 3. Dawn Broadcast
  if (victims.length > 0) {
    const names = victims.map(v => v.name).join(', ');
    addLog(room, `💀 Dawn breaks... ${names} ${victims.length > 1 ? 'were' : 'was'} found dead!`, 'kill');
  } else {
    addLog(room, '☀️ï¸ Dawn breaks... Miraculously, everyone survived the night!', 'save');
  }

  // 4. Win condition check
  if (checkWinCondition(room)) {
    return;
  }

  // FEATURE 1: Trigger Last Words for night victims
  if (victims.length > 0) {
    triggerLastWords(room, victims, () => startDayDiscussion(room));
  } else {
    startDayDiscussion(room);
  }
}

// ==========================================================
// FEATURE 1: LAST WORDS SYSTEM
// ==========================================================
function triggerLastWords(room, victims, onComplete) {
  // Only human (non-bot) victims get Last Words
  const humanVictims = victims.filter(v => !v.isBot);

  if (humanVictims.length === 0) {
    onComplete();
    return;
  }

  room.pendingLastWords = humanVictims.map(v => ({
    playerId: v.id,
    playerName: v.name
  }));
  room.lastWordsCallback = onComplete;

  addLog(room, `🕯️ï¸ The fallen are given a moment to speak their Last Words...`, 'info');
  broadcastRoomState(room);

  // 15-second timeout per player; auto-skip if no response
  scheduleNextLastWordsTimeout(room);
}

function scheduleNextLastWordsTimeout(room) {
  clearRoomTimer(room);
  if (room.pendingLastWords.length === 0) {
    const cb = room.lastWordsCallback;
    room.lastWordsCallback = null;
    if (cb) cb();
    return;
  }

  room.timerTimeout = setTimeout(() => {
    if (room.pendingLastWords.length > 0) {
      const skipped = room.pendingLastWords.shift();
      addLog(room, `🕯️ï¸ ${skipped.playerName} chose silence as their last words.`, 'info');
    }
    if (room.pendingLastWords.length > 0) {
      broadcastRoomState(room);
      scheduleNextLastWordsTimeout(room);
    } else {
      broadcastRoomState(room);
      const cb = room.lastWordsCallback;
      room.lastWordsCallback = null;
      if (cb) cb();
    }
  }, 15000);
}

function startDayDiscussion(room) {
  clearRoomTimer(room);
  room.phase = 'DAY_DISCUSSION';
  const duration = (room.settings?.discussionSec || 45) * 1000;
  room.phaseEndsAt = Date.now() + duration;

  const discussionSec = room.settings?.discussionSec || 45;
  addLog(room, `🗣️ï¸ Day ${room.round} Discussion begins. You have ${discussionSec} seconds to debate.`, 'phase');
  broadcastRoomState(room);

  simulateBotChat(room);

  room.timerTimeout = setTimeout(() => {
    startTrialVoting(room);
  }, duration);
}

function startTrialVoting(room) {
  clearRoomTimer(room);
  room.phase = 'TRIAL_VOTING';
  const duration = (room.settings?.votingSec || 30) * 1000;
  room.phaseEndsAt = Date.now() + duration;
  room.votes = {};

  const livingCount = getLivingPlayers(room).length;
  const threshold = getVotingThreshold(livingCount);

  // FEATURE 2: PANIC event
  if (room.currentRandomEvent === 'PANIC') {
    addLog(room, `😱 [PANIC] Trial & Voting — each player casts TWO votes. Top 2 most-voted players are eliminated!`, 'event');
  } else {
    addLog(room, `⚖️ï¸ Trial & Voting begins! Threshold for elimination is ${threshold} votes.`, 'phase');
  }

  broadcastRoomState(room);
  simulateBotVotes(room);

  room.timerTimeout = setTimeout(() => {
    resolveTrialVoting(room);
  }, duration);
}

function checkEarlyTrialResolution(room) {
  if (room.phase !== 'TRIAL_VOTING') return;

  const livingPlayers = getLivingPlayers(room);
  const threshold = getVotingThreshold(livingPlayers.length);
  const isPanic = room.currentRandomEvent === 'PANIC';

  if (isPanic) {
    // Each player submits an array of 2 votes; early resolve when all have voted
    const votedCount = Object.keys(room.votes).length;
    if (votedCount >= livingPlayers.length) {
      resolveTrialVoting(room);
    }
    return;
  }

  const tallies = {};
  for (const targetId of Object.values(room.votes)) {
    if (typeof targetId === 'string') {
      tallies[targetId] = (tallies[targetId] || 0) + 1;
    }
  }

  for (const [targetId, count] of Object.entries(tallies)) {
    if (targetId !== 'SKIP' && count >= threshold) {
      resolveTrialVoting(room, targetId);
      return;
    }
  }

  const votedCount = Object.keys(room.votes).length;
  if (votedCount >= livingPlayers.length) {
    resolveTrialVoting(room);
  }
}

function resolveTrialVoting(room, immediateTargetId = null) {
  if (room.phase !== 'TRIAL_VOTING') return;
  clearRoomTimer(room);

  const livingPlayers = getLivingPlayers(room);
  const threshold = getVotingThreshold(livingPlayers.length);
  const isPanic = room.currentRandomEvent === 'PANIC';

  const eliminatedPlayers = [];

  if (isPanic) {
    // FEATURE 2: PANIC — tally all votes (each player contributed 2), eliminate top 2
    const tallies = {};
    for (const voteVal of Object.values(room.votes)) {
      const arr = Array.isArray(voteVal) ? voteVal : [voteVal];
      for (const v of arr) {
        if (v && v !== 'SKIP') tallies[v] = (tallies[v] || 0) + 1;
      }
    }

    const sorted = Object.entries(tallies)
      .filter(([id]) => id !== 'SKIP')
      .sort((a, b) => b[1] - a[1]);

    for (let i = 0; i < 2 && i < sorted.length; i++) {
      const [targetId, count] = sorted[i];
      const p = room.players.get(targetId);
      if (p && p.alive && count > 0) {
        p.alive = false;
        eliminatedPlayers.push(p);
        addLog(room, `😱 [PANIC] By panic-vote (${count} votes), ${p.name} was executed!`, 'kill');
      }
    }

    if (eliminatedPlayers.length === 0) {
      addLog(room, `🕊️ï¸ [PANIC] Despite the chaos, no one had enough votes to be eliminated.`, 'info');
    }
  } else {
    // Normal voting
    const tallies = {};
    for (const targetId of Object.values(room.votes)) {
      if (typeof targetId === 'string') tallies[targetId] = (tallies[targetId] || 0) + 1;
    }

    let eliminatedPlayer = null;

    if (immediateTargetId) {
      eliminatedPlayer = room.players.get(immediateTargetId);
    } else {
      for (const [targetId, count] of Object.entries(tallies)) {
        if (targetId !== 'SKIP' && count >= threshold) {
          eliminatedPlayer = room.players.get(targetId);
          break;
        }
      }
    }

    if (eliminatedPlayer && eliminatedPlayer.alive) {
      eliminatedPlayer.alive = false;
      eliminatedPlayers.push(eliminatedPlayer);
      addLog(room, `⚖️ï¸ By majority vote (${tallies[eliminatedPlayer.id]} votes), ${eliminatedPlayer.name} was executed!`, 'kill');
    } else {
      const skipCount = tallies['SKIP'] || 0;
      if (skipCount > 0) {
        addLog(room, `🕊️ï¸ No one was eliminated! The town chose to skip or failed to reach ${threshold} votes.`, 'info');
      } else {
        addLog(room, `🕊️ï¸ Voting ended without reaching the required threshold of ${threshold} votes. No elimination!`, 'info');
      }
    }
  }

  if (checkWinCondition(room)) {
    return;
  }

  room.round++;

  // FEATURE 1: Last Words for vote-eliminated players before next night
  if (eliminatedPlayers.length > 0) {
    triggerLastWords(room, eliminatedPlayers, () => startNight(room));
  } else {
    startNight(room);
  }
}

// ==========================================================
// FEATURE 3: SHOO — Mafia power, used once per game during Night
// ==========================================================
function executeShoo(room) {
  const candidates = getLivingPlayers(room).filter(p =>
    p.role !== 'MAFIA' && !room.shooedPlayerIds.has(p.id)
  );

  if (candidates.length === 0) {
    addLog(room, `🤫 [SHOO] No eligible targets for the Shoo ability.`, 'info');
    return null;
  }

  const target = candidates[Math.floor(Math.random() * candidates.length)];
  room.shooedPlayerIds.add(target.id);

  addLog(room, `🤫 [SHOO] A mysterious force has silenced someone in town. ${target.name} can no longer speak — only vote.`, 'shoo');
  broadcastRoomState(room);
  return target;
}

// Bot Simulation Helpers for instant 1-host testing
function simulateBotNightActions(room) {
  const livingBots = getLivingPlayers(room).filter(p => p.isBot);
  const livingTargets = getLivingPlayers(room);

  livingBots.forEach(bot => {
    const delay = Math.floor(Math.random() * 4000) + 1500;
    setTimeout(() => {
      if (room.phase !== 'NIGHT' || !bot.alive) return;

      if (bot.role === 'MAFIA') {
        const innocentTargets = livingTargets.filter(t => t.role !== 'MAFIA');
        const target = innocentTargets[Math.floor(Math.random() * innocentTargets.length)];
        if (target) {
          room.nightActions.mafiaTargets[bot.id] = target.id;
          notifyMafiaPreview(room);
          checkEarlyNightResolution(room);
        }
      } else if (bot.role === 'DOCTOR') {
        const valid = livingTargets.filter(t => t.id !== room.doctorLastProtected);
        const target = valid[Math.floor(Math.random() * valid.length)];
        if (target) {
          room.nightActions.doctorTarget = target.id;
          checkEarlyNightResolution(room);
        }
      } else if (bot.role === 'DETECTIVE') {
        // FEATURE 2: Bot detective skips during BLACKOUT
        if (room.currentRandomEvent === 'BLACKOUT') return;
        const otherTargets = livingTargets.filter(t => t.id !== bot.id);
        const target = otherTargets[Math.floor(Math.random() * otherTargets.length)];
        if (target) {
          room.nightActions.detectiveTarget = target.id;
          checkEarlyNightResolution(room);
        }
      } else if (bot.role === 'SHADOW') {
        // FEATURE 4: Bot Shadow picks a team if past deadline
        if (!room.shadowChoice && room.round >= (room.shadowChoiceDeadlineRound || 3)) {
          const teams = ['MAFIA', 'TOWN'];
          const chosenTeam = teams[Math.floor(Math.random() * teams.length)];
          room.shadowChoice = { playerId: bot.id, chosenTeam };
          addLog(room, `🌑 [SHADOW] A hidden figure has aligned themselves with the ${chosenTeam}...`, 'info');
          broadcastRoomState(room);
        }
      }
    }, delay);
  });
}

function simulateBotChat(room) {
  const livingBots = getLivingPlayers(room).filter(p => p.isBot);
  if (livingBots.length === 0) return;

  const botPhrases = [
    "I had a feeling something strange happened last night...",
    "Who seems suspicious to you guys?",
    "Let's look at who was quiet yesterday.",
    "I believe we need to be very careful with our votes today.",
    "Don't rush to vote without hearing everyone out!"
  ];

  // FEATURE 3: Shooed bots cannot chat
  const chattableBots = livingBots.filter(b => !room.shooedPlayerIds.has(b.id));
  if (chattableBots.length === 0) return;

  const bot = chattableBots[Math.floor(Math.random() * chattableBots.length)];
  const phrase = botPhrases[Math.floor(Math.random() * botPhrases.length)];

  setTimeout(() => {
    if (room.phase === 'DAY_DISCUSSION' && bot.alive) {
      const msg = {
        id: crypto.randomUUID(),
        senderName: bot.name,
        senderId: bot.id,
        text: phrase,
        channel: 'PUBLIC',
        timestamp: Date.now()
      };
      room.chatMessages.push(msg);
      io.to(room.id).emit('chat_message', msg);
    }
  }, 4000);
}

function simulateBotVotes(room) {
  const livingBots = getLivingPlayers(room).filter(p => p.isBot);
  const livingTargets = getLivingPlayers(room);
  const isPanic = room.currentRandomEvent === 'PANIC';

  livingBots.forEach(bot => {
    const delay = Math.floor(Math.random() * 6000) + 2000;
    setTimeout(() => {
      if (room.phase !== 'TRIAL_VOTING' || !bot.alive) return;

      if (isPanic) {
        // FEATURE 2: PANIC bots cast 2 votes
        const others = livingTargets.filter(t => t.id !== bot.id);
        const votes = [];
        for (let i = 0; i < 2; i++) {
          if (Math.random() < 0.7 && others.length > 0) {
            votes.push(others[Math.floor(Math.random() * others.length)].id);
          } else {
            votes.push('SKIP');
          }
        }
        room.votes[bot.id] = votes;
      } else {
        if (Math.random() < 0.7) {
          const others = livingTargets.filter(t => t.id !== bot.id);
          const target = others[Math.floor(Math.random() * others.length)];
          if (target) room.votes[bot.id] = target.id;
        } else {
          room.votes[bot.id] = 'SKIP';
        }
      }

      broadcastRoomState(room);
      checkEarlyTrialResolution(room);
    }, delay);
  });
}

function notifyMafiaPreview(room) {
  const livingMafia = getLivingMafia(room);
  const previewData = {};

  for (const m of livingMafia) {
    const targetId = room.nightActions.mafiaTargets[m.id];
    const target = targetId ? room.players.get(targetId) : null;
    previewData[m.id] = {
      targetId: targetId || null,
      targetName: target ? target.name : null
    };
  }

  for (const m of livingMafia) {
    if (m.socketId) {
      io.to(m.socketId).emit('mafia_target_preview', previewData);
    }
  }
}

// Socket Connection Handler
io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentSessionId = null;

  // 1. Join / Create Room with Session Recovery
  socket.on('join_game', ({ roomId, playerName, sessionToken }) => {
    const cleanName = sanitize(playerName) || 'Player';
    const targetRoomId = (roomId ? sanitize(roomId).toUpperCase() : generateRoomCode());

    let room = rooms.get(targetRoomId);
    let playerId = sessionToken || crypto.randomUUID();

    if (!room) {
      room = createRoom(targetRoomId, playerId);
    }

    let player = room.players.get(playerId);

    if (player) {
      if (player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
      }
      player.socketId = socket.id;
      player.connected = true;
      addLog(room, `🔌 ${player.name} reconnected.`, 'system');
    } else {
      if (room.phase !== 'LOBBY') {
        socket.emit('error_message', 'Game is already in progress in this room.');
        return;
      }

      player = {
        id: playerId,
        socketId: socket.id,
        name: cleanName,
        role: null,
        alive: true,
        connected: true,
        disconnectTimer: null,
        isBot: false
      };
      room.players.set(playerId, player);
      addLog(room, `👋 ${player.name} joined the room.`, 'system');
    }

    currentRoomId = targetRoomId;
    currentSessionId = playerId;
    socket.join(targetRoomId);

    socket.emit('session_established', {
      roomId: targetRoomId,
      sessionToken: playerId,
      isHost: playerId === room.hostPlayerId
    });

    broadcastRoomState(room);
  });

  // 2. Host Adds / Removes Bots (for testing)
  socket.on('add_bot', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'LOBBY' || currentSessionId !== room.hostPlayerId) return;

    const botNumber = Array.from(room.players.values()).filter(p => p.isBot).length + 1;
    const botId = `bot_${crypto.randomUUID().slice(0, 6)}`;
    const bot = {
      id: botId,
      socketId: null,
      name: `Agent ${botNumber}`,
      role: null,
      alive: true,
      connected: true,
      disconnectTimer: null,
      isBot: true
    };
    room.players.set(botId, bot);
    addLog(room, `🤖 Host added test bot: ${bot.name}`, 'system');
    broadcastRoomState(room);
  });

  socket.on('remove_bot', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'LOBBY' || currentSessionId !== room.hostPlayerId) return;

    const botList = Array.from(room.players.values()).filter(p => p.isBot);
    if (botList.length > 0) {
      const lastBot = botList[botList.length - 1];
      room.players.delete(lastBot.id);
      addLog(room, `🤖 Host removed test bot: ${lastBot.name}`, 'system');
      broadcastRoomState(room);
    }
  });

  // 2b. Update Room Settings (Host Only, Lobby Only)
  socket.on('update_settings', ({ pace }) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'LOBBY') return;

    if (currentSessionId !== room.hostPlayerId) {
      socket.emit('error_message', 'Only the host can modify room settings.');
      return;
    }

    if (pace) {
      const paceMap = {
        'BLITZ': { nightSec: 15, discussionSec: 25, votingSec: 20 },
        'NORMAL': { nightSec: 30, discussionSec: 45, votingSec: 30 },
        'CASUAL': { nightSec: 45, discussionSec: 75, votingSec: 45 }
      };
      if (paceMap[pace]) {
        room.settings.pace = pace;
        room.settings.nightSec = paceMap[pace].nightSec;
        room.settings.discussionSec = paceMap[pace].discussionSec;
        room.settings.votingSec = paceMap[pace].votingSec;
      }
    }

    addLog(room, `⚙️ Host updated match pace: ${room.settings.pace}`, 'system');
    broadcastRoomState(room);
  });

  // 3. Start Game
  socket.on('start_game', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'LOBBY') return;

    if (currentSessionId !== room.hostPlayerId) {
      socket.emit('error_message', 'Only the host can start the game.');
      return;
    }

    if (room.players.size < 4) {
      socket.emit('error_message', `Need at least 4 players to start! Currently: ${room.players.size}`);
      return;
    }

    assignRoles(room);
    addLog(room, `🎮 Game started with ${room.players.size} players! Roles assigned.`, 'phase');
    startNight(room);
  });

  // 4. Return to Lobby
  socket.on('return_to_lobby', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'GAME_OVER') return;

    if (currentSessionId !== room.hostPlayerId) {
      socket.emit('error_message', 'Only the host can return to lobby.');
      return;
    }

    clearRoomTimer(room);
    room.phase = 'LOBBY';
    room.round = 1;
    room.winner = null;
    room.votes = {};
    room.nightActions = { mafiaTargets: {}, doctorTarget: null, detectiveTarget: null };
    room.currentRandomEvent = null;
    room.pendingLastWords = [];
    room.lastWordsCallback = null;
    room.shooedPlayerIds = new Set();
    room.shooUsed = false;
    room.shadowChoice = null;
    room.shadowChoiceDeadlineRound = null;

    for (const player of room.players.values()) {
      player.alive = true;
      player.role = null;
    }

    addLog(room, '🔄 Host returned room to Lobby.', 'system');
    broadcastRoomState(room);
  });

  // 5. Mafia Night Target Selection (Revocable)
  socket.on('mafia_target', ({ targetId }) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'NIGHT') return;

    const player = room.players.get(currentSessionId);
    if (!player || !player.alive || player.role !== 'MAFIA') return;

    const target = room.players.get(targetId);
    if (target && target.alive) {
      room.nightActions.mafiaTargets[player.id] = target.id;
      notifyMafiaPreview(room);
      checkEarlyNightResolution(room);
      broadcastRoomState(room);
    }
  });

  // 6. Doctor Protect Selection
  socket.on('doctor_protect', ({ targetId }) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'NIGHT') return;

    const player = room.players.get(currentSessionId);
    if (!player || !player.alive || player.role !== 'DOCTOR') return;

    if (targetId === room.doctorLastProtected) {
      socket.emit('error_message', 'You cannot protect the same player two nights in a row!');
      return;
    }

    const target = room.players.get(targetId);
    if (target && target.alive) {
      room.nightActions.doctorTarget = target.id;
      socket.emit('action_confirmed', { type: 'DOCTOR', targetName: target.name });
      checkEarlyNightResolution(room);
      broadcastRoomState(room);
    }
  });

  // 7. Detective Investigate Selection
  // FEATURE 2: Server blocks investigation during BLACKOUT
  socket.on('detective_investigate', ({ targetId }) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'NIGHT') return;

    const player = room.players.get(currentSessionId);
    if (!player || !player.alive || player.role !== 'DETECTIVE') return;

    if (room.currentRandomEvent === 'BLACKOUT') {
      socket.emit('error_message', '⚡ BLACKOUT! Your investigation ability is suppressed tonight.');
      return;
    }

    const target = room.players.get(targetId);
    if (target && target.alive) {
      room.nightActions.detectiveTarget = target.id;
      socket.emit('action_confirmed', { type: 'DETECTIVE', targetName: target.name });
      checkEarlyNightResolution(room);
      broadcastRoomState(room);
    }
  });

  // 8. Day Trial Vote (Revocable)
  // FEATURE 2: PANIC mode uses secondVoteTargetId for 2nd vote
  socket.on('cast_vote', ({ targetId, secondVoteTargetId }) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'TRIAL_VOTING') return;

    const player = room.players.get(currentSessionId);
    if (!player || !player.alive) return;

    const isPanic = room.currentRandomEvent === 'PANIC';

    if (isPanic) {
      const validateVote = (vid) => {
        if (!vid || vid === 'SKIP') return 'SKIP';
        const t = room.players.get(vid);
        return (t && t.alive) ? t.id : null;
      };

      const v1 = validateVote(targetId);
      const v2 = validateVote(secondVoteTargetId);

      if (!v1) {
        socket.emit('error_message', 'Invalid first vote target.');
        return;
      }

      room.votes[player.id] = [v1, v2 || 'SKIP'];

      const t1Name = v1 === 'SKIP' ? 'Skip' : (room.players.get(v1)?.name || '?');
      const t2Name = (!v2 || v2 === 'SKIP') ? 'Skip' : (room.players.get(v2)?.name || '?');
      addLog(room, `😱 [PANIC] ${player.name} cast votes: [${t1Name}] and [${t2Name}].`, 'vote');
    } else {
      if (targetId === 'SKIP') {
        room.votes[player.id] = 'SKIP';
        addLog(room, `🗳️ï¸ ${player.name} voted to Skip.`, 'vote');
      } else {
        const target = room.players.get(targetId);
        if (target && target.alive) {
          room.votes[player.id] = target.id;
          addLog(room, `🗳️ï¸ ${player.name} voted for ${target.name}.`, 'vote');
        }
      }
    }

    broadcastRoomState(room);
    checkEarlyTrialResolution(room);
  });

  // ==========================================================
  // FEATURE 1: Last Words — player selects a predefined statement
  // ==========================================================
  socket.on('select_last_words', ({ statementIndex }) => {
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.pendingLastWords.length === 0) return;

    const pending = room.pendingLastWords[0];
    if (pending.playerId !== currentSessionId) return; // Only the queued player

    const idx = parseInt(statementIndex, 10);
    if (isNaN(idx) || idx < 0 || idx >= LAST_WORDS_STATEMENTS.length) return;

    const statement = LAST_WORDS_STATEMENTS[idx];
    room.pendingLastWords.shift();
    clearRoomTimer(room);

    addLog(room, `🕯️ï¸ ${pending.playerName}'s Last Words: "${statement}"`, 'last_words');

    if (room.pendingLastWords.length > 0) {
      broadcastRoomState(room);
      scheduleNextLastWordsTimeout(room);
    } else {
      broadcastRoomState(room);
      const cb = room.lastWordsCallback;
      room.lastWordsCallback = null;
      if (cb) setTimeout(cb, 1500);
    }
  });

  // ==========================================================
  // FEATURE 3: SHOO — Mafia uses it once per game during Night
  // ==========================================================
  socket.on('mafia_shoo', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.phase !== 'NIGHT') return;

    const player = room.players.get(currentSessionId);
    if (!player || !player.alive || player.role !== 'MAFIA') return;

    if (room.shooUsed) {
      socket.emit('error_message', 'The Shoo ability has already been used this game.');
      return;
    }

    room.shooUsed = true;
    const target = executeShoo(room);
    if (target) {
      socket.emit('action_confirmed', { type: 'SHOO', targetName: '(random target)' });
    }
  });

  // ==========================================================
  // FEATURE 4: SHADOW — Choose allegiance (MAFIA or TOWN)
  // ==========================================================
  socket.on('shadow_choose_team', ({ team }) => {
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.players.get(currentSessionId);
    if (!player || !player.alive || player.role !== 'SHADOW') return;

    if (team !== 'MAFIA' && team !== 'TOWN') {
      socket.emit('error_message', 'Invalid team choice. Must be MAFIA or TOWN.');
      return;
    }

    if (room.shadowChoice && room.shadowChoice.playerId === player.id) {
      socket.emit('error_message', 'You have already chosen your allegiance.');
      return;
    }

    if (room.round < (room.shadowChoiceDeadlineRound || 1)) {
      socket.emit('error_message', `You must wait until Round ${room.shadowChoiceDeadlineRound} to choose your allegiance.`);
      return;
    }

    room.shadowChoice = { playerId: player.id, chosenTeam: team };
    addLog(room, `🌑 [SHADOW] A hidden figure has chosen their allegiance — the balance of power may have shifted...`, 'info');
    socket.emit('action_confirmed', { type: 'SHADOW_CHOICE', targetName: team });

    broadcastRoomState(room);
  });

  // 10. Chat System (Sanitized, Day Public / Night Mafia / Spectator Graveyard)
  socket.on('send_chat', ({ text, channel }) => {
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const cleanText = sanitize(text);
    if (!cleanText) return;

    const player = room.players.get(currentSessionId);
    if (!player) return;

    // FEATURE 3: Server-enforced chat block for Shooed players
    if (room.shooedPlayerIds.has(player.id) && player.alive) {
      socket.emit('error_message', '🤫 You have been SILENCED. You can only vote, not speak.');
      return;
    }

    const msg = {
      id: crypto.randomUUID(),
      senderName: player.name,
      senderId: player.id,
      text: cleanText,
      timestamp: Date.now()
    };

    if (!player.alive) {
      // Dead Players: GRAVEYARD channel, only to dead sockets
      msg.channel = 'GRAVEYARD';
      room.chatMessages.push(msg);
      if (room.chatMessages.length > 100) room.chatMessages.shift();

      Array.from(room.players.values()).filter(p => !p.alive).forEach(d => {
        if (d.socketId) io.to(d.socketId).emit('chat_message', msg);
      });
      return;
    }

    // Living Players:
    if (room.phase === 'NIGHT') {
      // Only living Mafia can speak at night
      if (player.role === 'MAFIA') {
        msg.channel = 'MAFIA';
        room.chatMessages.push(msg);
        if (room.chatMessages.length > 100) room.chatMessages.shift();

        const livingMafia = getLivingMafia(room);
        livingMafia.forEach(m => {
          if (m.socketId) io.to(m.socketId).emit('chat_message', msg);
        });
      }
      return;
    } else {
      // Day phases: PUBLIC to all
      msg.channel = 'PUBLIC';
      room.chatMessages.push(msg);
      if (room.chatMessages.length > 100) room.chatMessages.shift();

      io.to(room.id).emit('chat_message', msg);
    }
  });

  // 11. Disconnection & Grace Period
  socket.on('disconnect', () => {
    if (!currentRoomId || !currentSessionId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.players.get(currentSessionId);
    if (!player) return;

    player.connected = false;
    broadcastRoomState(room);

    player.disconnectTimer = setTimeout(() => {
      if (!player.connected) {
        if (room.phase === 'LOBBY') {
          room.players.delete(player.id);
          if (room.hostPlayerId === player.id) {
            const nextPlayer = Array.from(room.players.values())[0];
            room.hostPlayerId = nextPlayer ? nextPlayer.id : null;
          }
          addLog(room, `🔌 ${player.name} left the lobby.`, 'system');
        } else {
          if (player.alive) {
            player.alive = false;
            addLog(room, `💀 ${player.name} lost connection and was claimed by the shadows.`, 'kill');
            checkWinCondition(room);
            if (room.phase === 'NIGHT') checkEarlyNightResolution(room);
            if (room.phase === 'TRIAL_VOTING') checkEarlyTrialResolution(room);
          }
          // Clean up Last Words queue if this player was pending
          if (room.pendingLastWords.length > 0 && room.pendingLastWords[0].playerId === player.id) {
            room.pendingLastWords.shift();
            clearRoomTimer(room);
            if (room.pendingLastWords.length > 0) {
              broadcastRoomState(room);
              scheduleNextLastWordsTimeout(room);
            } else {
              const cb = room.lastWordsCallback;
              room.lastWordsCallback = null;
              if (cb) cb();
            }
          }
        }
        broadcastRoomState(room);

        if (room.players.size === 0) {
          clearRoomTimer(room);
          rooms.delete(room.id);
        }
      }
    }, 15000);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mafia server running on http://0.0.0.0:${PORT}`);
});