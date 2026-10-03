const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const DEFAULT_ROUND_DURATION_MS = 3 * 60 * 1000;
const DEFAULT_PROMPTS_PER_ROUND = 10;
const MAX_PLAYERS = 6;
const MIN_PLAYER_LIMIT = 2;
const DEFAULT_PLAYER_LIMIT = 2;
const DESCRIBER_RECONNECT_GRACE_MS = 30 * 1000;
const CHAT_HISTORY_LIMIT = 100;
const RECONNECT_TOKEN_BYTES = 24;
const OFFENSIVE_WORDS = new Set([
  'ass', 'asshole', 'bastard', 'bitch', 'bullshit', 'crap', 'damn', 'dick',
  'fag', 'faggot', 'fuck', 'fucked', 'fucker', 'fucking', 'goddamn', 'hell',
  'jerk', 'motherfucker', 'piss', 'prick', 'shit', 'slut', 'whore'
]);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const PROMPTS = [
  'coffee machine', 'team meeting', 'calendar invite', 'email inbox', 'video call',
  'office chair', 'laptop charger', 'to-do list', 'deadline', 'presentation',
  'password reset', 'printer', 'spreadsheet', 'project manager', 'group chat',
  'morning commute', 'traffic jam', 'grocery shopping', 'laundry', 'alarm clock',
  'weekend plans', 'birthday party', 'rainy day', 'takeout delivery', 'reusable water bottle',
  'headphones', 'shopping cart', 'parking spot', 'weather forecast', 'package delivery',
  'calendar reminder', 'coffee break', 'desk drawer', 'sticky note', 'phone charger',
  'customer support', 'brainstorming', 'work from home', 'office kitchen', 'lunch break',
  'team chat', 'budget spreadsheet', 'job interview', 'vacation request', 'payday',
  'online shopping', 'house keys', 'car keys', 'remote control', 'toothbrush',
  'bedtime', 'doctor appointment', 'dinner plans', 'house cleaning', 'grocery list',
  'delivery driver', 'meeting agenda', 'shared document', 'calendar conflict', 'coffee order',
  'browser tab', 'search engine', 'phone notification', 'text message', 'voice memo',
  'workout', 'dog walk', 'school pickup', 'commute train', 'parking meter',
  'office elevator', 'water cooler', 'conference room', 'whiteboard', 'name badge',
  'expense report', 'invoice', 'receipt', 'shipping label', 'customer feedback',
  'video meeting', 'office supplies', 'team deadline', 'work calendar', 'lunch order',
  'customer email', 'project plan', 'coffee shop', 'home office', 'file attachment',
  'calendar reminder', 'morning routine', 'shopping list', 'phone call', 'work presentation'
];
const EXTRA_PROMPTS = {
  everyday: ['toothbrush', 'bedtime', 'dinner plans', 'house cleaning', 'grocery list', 'delivery driver', 'house keys', 'car keys', 'remote control', 'phone call'],
  work: ['coffee machine', 'team meeting', 'calendar invite', 'email inbox', 'video call', 'office chair', 'laptop charger', 'to-do list', 'deadline', 'presentation', 'printer', 'spreadsheet', 'project manager', 'group chat', 'conference room', 'whiteboard'],
  party: ['birthday cake', 'dance floor', 'party hat', 'karaoke night', 'balloon animal', 'board game', 'costume party', 'magic trick', 'popcorn', 'fireworks'],
  animals: ['golden retriever', 'penguin', 'butterfly', 'elephant', 'kangaroo', 'octopus', 'hummingbird', 'sea turtle', 'flamingo', 'hedgehog']
};

function roomCode() {
  let code;
  do code = crypto.randomBytes(3).toString('hex').toUpperCase();
  while (rooms.has(code));
  return code;
}

function playerId() {
  return crypto.randomBytes(8).toString('hex');
}

function normalizeAnswer(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s-]+/g, '');
}

function normalizedLetterLength(value) {
  return normalizeAnswer(value).length;
}

function isAllowedGuessText(value) {
  return /^[A-Za-z\s-]+$/.test(String(value || ''));
}

function isOffensiveGuess(value) {
  const normalized = normalizeAnswer(value);
  if (!normalized) return false;
  if (OFFENSIVE_WORDS.has(normalized)) return true;
  const tokens = String(value || '').toLowerCase().split(/[\s-]+/).filter(Boolean);
  return tokens.some((token) => OFFENSIVE_WORDS.has(token));
}

function createReconnectToken() {
  return crypto.randomBytes(RECONNECT_TOKEN_BYTES).toString('hex');
}

function isOnline(player) {
  return Boolean(player?.ws && player.ws.readyState === 1);
}

function currentPromptKey(room) {
  return room.currentPrompt || '';
}

function getGuessAttempt(room, player) {
  const key = currentPromptKey(room);
  const existing = room.guessAttempts.get(player.id);
  if (!existing || existing.promptKey !== key) {
    const fresh = { promptKey: key, wrongCount: 0 };
    room.guessAttempts.set(player.id, fresh);
    return fresh;
  }
  return existing;
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickRoundPrompts(room) {
  const themed = EXTRA_PROMPTS[room.promptPack] || [];
  const matchesDifficulty = (prompt) => {
    const length = prompt.replace(/[\s-]/g, '').length;
    if (room.difficulty === 'easy') return length <= 10;
    if (room.difficulty === 'hard') return length >= 9;
    return length >= 5 && length <= 14;
  };
  const classic = shuffle([...new Set(PROMPTS)]).filter(matchesDifficulty);
  const themedMatches = shuffle([...new Set(themed)]).filter(matchesDifficulty);
  const prompts = room.promptPack === 'classic' ? classic : [...themedMatches, ...classic.filter(p => !themedMatches.includes(p))];
  return prompts.slice(0, room.promptsPerRound);
}

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...payload }));
}

function broadcast(room, type, payload = {}) {
  for (const p of room.players.values()) send(p.ws, type, payload);
}

function publicScores(room) {
  return [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, role: p.role, score: p.score, online: isOnline(p) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function publicState(room) {
  return {
    room: room.code,
    started: room.started,
    paused: room.paused,
    pauseRemainingMs: room.paused ? room.pauseRemainingMs : null,
    describerGraceEndsAt: room.describerGraceEndsAt,
    roundNumber: room.roundNumber,
    activePlayerIds: [...room.activePlayerIds],
    roundDurationMs: room.roundDurationMs,
    promptPack: room.promptPack,
    difficulty: room.difficulty,
    playerLimit: room.playerLimit,
    canStart: room.players.size >= 2 && !room.started,
    waitingForMorePlayers: room.players.size < room.playerLimit,
    roundEndsAt: room.roundEndsAt,
    promptStartedAt: room.promptStartedAt,
    totalWords: room.promptsPerRound,
    history: room.history.slice(-20),
    overallScores: publicOverallScores(room),
    wordsSolved: room.wordsSolved,
    currentNumber: room.currentIndex + 1,
    remainingWords: Math.max(0, room.queue.length - room.currentIndex),
    currentPrompt: room.currentPrompt,
    skippedCount: room.skipped.length,
    scores: publicScores(room),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      score: p.score,
      totalScore: p.totalScore,
      online: isOnline(p)
    }))
  };
}

function publicOverallScores(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, score: p.totalScore }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function broadcastState(room) {
  for (const p of room.players.values()) {
    const state = publicState(room);
    if (p.role !== 'describer' || !room.started) state.currentPrompt = null;
    send(p.ws, 'state', state);
  }
}

function sendChatHistory(room, ws) {
  send(ws, 'chatHistory', { messages: room.chat.slice(-CHAT_HISTORY_LIMIT) });
}

function clampPlayerLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PLAYER_LIMIT;
  return Math.min(MAX_PLAYERS, Math.max(MIN_PLAYER_LIMIT, Math.round(n)));
}

function createRoom(playerLimit = DEFAULT_PLAYER_LIMIT) {
  const code = roomCode();
  const room = {
    code,
    players: new Map(),
    started: false,
    paused: false,
    pauseRemainingMs: null,
    roundNumber: 0,
    activePlayerIds: new Set(),
    roundEndsAt: null,
    promptStartedAt: null,
    timer: null,
    describerGraceTimer: null,
    describerGraceEndsAt: null,
    disconnectedDescriberId: null,
    playerLimit: clampPlayerLimit(playerLimit),
    roundDurationMs: DEFAULT_ROUND_DURATION_MS,
    promptsPerRound: DEFAULT_PROMPTS_PER_ROUND,
    promptPack: 'classic',
    difficulty: 'medium',
    history: [],
    queue: [],
    currentIndex: 0,
    currentPrompt: null,
    skipped: [],
    wordsSolved: 0,
    chat: [],
    guessAttempts: new Map()
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}

function addPlayer(room, name, ws, reconnectToken = null) {
  const token = String(reconnectToken || '');
  if (token) {
    for (const existing of room.players.values()) {
      if (existing.reconnectToken === token) {
        if (isOnline(existing) && existing.ws !== ws) return { error: 'That player is already connected.' };
        existing.ws = ws;
        existing.lastSeenAt = Date.now();
        return { player: existing, reconnected: true };
      }
    }
  }

  const p = {
    id: playerId(),
    reconnectToken: createReconnectToken(),
    name: String(name || '').trim().slice(0, 24) || 'Player',
    role: room.players.size === 0 ? 'describer' : 'guesser',
    score: 0,
    totalScore: 0,
    ws,
    lastSeenAt: Date.now()
  };
  room.players.set(p.id, p);
  return { player: p, reconnected: false };
}

function findOnlineDescriber(room) {
  for (const p of room.players.values()) {
    if (p.role === 'describer' && isOnline(p)) return p;
  }
  return null;
}

function resetScores(room) {
  for (const p of room.players.values()) p.score = 0;
}

function nextPrompt(room) {
  if (!room.started) return false;

  if (room.currentIndex < room.queue.length) {
    room.currentPrompt = room.queue[room.currentIndex];
    room.promptStartedAt = Date.now();
    return true;
  }

  if (room.skipped.length) {
    room.queue = room.skipped.splice(0);
    room.currentIndex = 0;
    room.currentPrompt = room.queue[0] || null;
    room.promptStartedAt = Date.now();
    return Boolean(room.currentPrompt);
  }

  room.currentPrompt = null;
  return false;
}

function startRound(room) {
  if (room.timer) clearTimeout(room.timer);
  resetScores(room);
  room.started = true;
  room.paused = false;
  room.pauseRemainingMs = null;
  room.roundNumber += 1;
  room.activePlayerIds = new Set([...room.players.values()].filter(isOnline).map(p => p.id));
  room.roundEndsAt = Date.now() + room.roundDurationMs;
  room.queue = pickRoundPrompts(room);
  room.currentIndex = 0;
  room.currentPrompt = room.queue[0];
  room.promptStartedAt = Date.now();
  room.skipped = [];
  room.wordsSolved = 0;
  room.guessAttempts.clear();
  room.timer = setTimeout(() => endRound(room, 'Time is up!'), room.roundDurationMs + 50);
  broadcast(room, 'roundStarted', { durationMs: room.roundDurationMs, totalWords: room.promptsPerRound });
  broadcastState(room);
}

function endRound(room, message = 'Round ended.') {
  if (!room.started && !room.roundEndsAt && !room.paused) return;
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.started = false;
  room.paused = false;
  room.pauseRemainingMs = null;
  room.roundEndsAt = null;
  room.currentPrompt = null;
  room.promptStartedAt = null;
  const scores = publicScores(room);
  const highest = scores.length ? scores[0].score : 0;
  const winners = highest > 0 ? scores.filter(p => p.score === highest).map(p => ({ id: p.id, name: p.name, score: p.score })) : [];
  const historyEntry = { roundNumber: room.roundNumber, at: Date.now(), scores: scores.map(({ id, name, score }) => ({ id, name, score })), winners };
  room.history.push(historyEntry);
  if (room.history.length > 50) room.history.shift();
  for (const p of room.players.values()) p.totalScore += p.score;
  broadcast(room, 'roundEnded', { message, scores, winners, overallScores: publicOverallScores(room), history: room.history.slice(-20), wordsSolved: room.wordsSolved, totalWords: room.promptsPerRound });
  broadcastState(room);
}

function advanceAfterSolve(room, solvedByPlayerId) {
  if (solvedByPlayerId) room.guessAttempts.delete(solvedByPlayerId);
  room.wordsSolved += 1;
  room.currentIndex += 1;
  if (!nextPrompt(room)) {
    endRound(room, `All ${room.promptsPerRound} words were completed!`);
    return;
  }
  broadcastState(room);
}


function pauseRound(room) {
  if (!room.started || room.paused || !room.roundEndsAt) return false;
  room.pauseRemainingMs = Math.max(0, room.roundEndsAt - Date.now());
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.roundEndsAt = null;
  room.paused = true;
  broadcast(room, 'notice', { message: 'Game paused by the describer.' });
  broadcastState(room);
  return true;
}

function resumeRound(room) {
  if (!room.started || !room.paused) return false;
  const remaining = Math.max(0, room.pauseRemainingMs || 0);
  if (remaining <= 0) { endRound(room, 'Time is up!'); return false; }
  room.paused = false;
  room.pauseRemainingMs = null;
  room.roundEndsAt = Date.now() + remaining;
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room, 'Time is up!'), remaining + 50);
  broadcast(room, 'notice', { message: 'Game resumed.' });
  broadcastState(room);
  return true;
}

function passPrompt(room) {
  if (!room.started || !room.currentPrompt) return;
  room.guessAttempts.clear();
  room.skipped.push(room.currentPrompt);
  room.currentIndex += 1;

  if (!nextPrompt(room)) {
    endRound(room, 'No more words are available.');
    return;
  }

  broadcast(room, 'notice', { message: 'Passed. That word will come back after the remaining new words.' });
  broadcastState(room);
}

function chooseNextDescriber(room) {
  for (const p of room.players.values()) {
    if (p.role === 'guesser' && isOnline(p)) return p;
  }
  return null;
}

function promoteFallbackDescriber(room) {
  if (findOnlineDescriber(room)) return null;
  const next = chooseNextDescriber(room);
  if (!next) return null;
  next.role = 'describer';
  return next;
}

function clearDescriberGrace(room) {
  if (room.describerGraceTimer) clearTimeout(room.describerGraceTimer);
  room.describerGraceTimer = null;
  room.describerGraceEndsAt = null;
  room.disconnectedDescriberId = null;
}

function waitForDescriberReconnect(room, player) {
  clearDescriberGrace(room);
  room.disconnectedDescriberId = player.id;
  room.describerGraceEndsAt = Date.now() + DESCRIBER_RECONNECT_GRACE_MS;
  room.describerGraceTimer = setTimeout(() => {
    room.describerGraceTimer = null;
    room.describerGraceEndsAt = null;
    const disconnected = room.players.get(room.disconnectedDescriberId);
    room.disconnectedDescriberId = null;
    if (findOnlineDescriber(room)) { broadcastState(room); return; }
    if (disconnected?.role === 'describer' && !isOnline(disconnected)) disconnected.role = 'guesser';
    const next = promoteFallbackDescriber(room);
    broadcast(room, 'notice', { message: next ? `${next.name} is now the describer.` : 'No describer is online. The first player to rejoin will become describer.' });
    if (next) broadcast(room, 'describerChanged', { playerId: next.id, playerName: next.name, previousName: disconnected?.name || player.name });
    broadcastState(room);
  }, DESCRIBER_RECONNECT_GRACE_MS);
}

function removePlayer(room, id, socket) {
  const p = room.players.get(id);
  if (!p || (socket && p.ws !== socket)) return;
  const wasDescriber = p.role === 'describer';
  const leftName = p.name;
  p.ws = null;
  p.lastSeenAt = Date.now();

  if (wasDescriber) {
    waitForDescriberReconnect(room, p);
    broadcast(room, 'notice', { message: `${leftName} disconnected. Waiting 30 seconds for them to return before handing over the describer role.` });
    broadcastState(room);
  } else if (room.players.size) {
    broadcast(room, 'notice', { message: `${leftName} left the game. Their points are preserved if they return.` });
    broadcastState(room);
  }
}

function routeSignal(room, fromPlayerId, targetPlayerId, signal) {
  const target = room.players.get(targetPlayerId);
  if (!target) return;
  send(target.ws, 'signal', { from: fromPlayerId, signal });
}

wss.on('connection', (ws) => {
  let room = null;
  let player = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, 'error', { message: 'Invalid message.' }); }

    if (msg.type === 'join') {
      const code = String(msg.room || '').trim().toUpperCase();
      room = getRoom(code);
      if (!room) return send(ws, 'error', { message: 'Room not found. Create a new room first.' });
      const reconnectToken = String(msg.playerToken || '').trim();
      const existing = reconnectToken ? [...room.players.values()].find((p) => p.reconnectToken === reconnectToken) : null;
      if (!existing && room.players.size >= room.playerLimit) {
        return send(ws, 'error', { message: `This room is full. The describer set the room for ${room.playerLimit} players.` });
      }
      const result = addPlayer(room, msg.name, ws, reconnectToken);
      if (result.error) return send(ws, 'error', { message: result.error });
      player = result.player;
      if (room.started) room.activePlayerIds.add(player.id);
      if (room.disconnectedDescriberId === player.id && player.role === 'describer') {
        clearDescriberGrace(room);
        broadcast(room, 'notice', { message: `${player.name} returned within the grace period and remains the describer.` });
      }
      send(ws, 'welcome', { playerId: player.id, playerToken: player.reconnectToken, role: player.role, room: room.code, reconnected: result.reconnected });
      sendChatHistory(room, ws);
      broadcast(room, 'notice', { message: result.reconnected ? `${player.name} rejoined the room. Their points were preserved.` : `${player.name} joined the room.` });
      broadcast(room, 'meetingParticipant', { playerId: player.id, name: player.name });
      if (!findOnlineDescriber(room) && !room.describerGraceTimer) {
        const next = promoteFallbackDescriber(room);
        if (next) broadcast(room, 'notice', { message: `${next.name} is now the describer.` });
      }
      broadcastState(room);
      return;
    }

    if (msg.type === 'create') {
      room = createRoom(msg.playerLimit);
      const result = addPlayer(room, msg.name, ws);
      if (result.error) return send(ws, 'error', { message: result.error });
      player = result.player;
      send(ws, 'welcome', { playerId: player.id, playerToken: player.reconnectToken, role: player.role, room: room.code, created: true });
      sendChatHistory(room, ws);
      broadcastState(room);
      return;
    }

    if (!room || !player) return send(ws, 'error', { message: 'Join a room first.' });

    if (msg.type === 'signal') {
      const targetId = String(msg.targetId || '');
      if (!targetId || !msg.signal) return;
      routeSignal(room, player.id, targetId, msg.signal);
      return;
    }

    if (msg.type === 'chat') {
      const message = String(msg.message || '').trim().slice(0, 500);
      if (!message) return;
      const entry = { id: crypto.randomBytes(6).toString('hex'), playerId: player.id, player: player.name, message, at: Date.now() };
      room.chat.push(entry);
      if (room.chat.length > CHAT_HISTORY_LIMIT) room.chat.splice(0, room.chat.length - CHAT_HISTORY_LIMIT);
      broadcast(room, 'chat', entry);
      return;
    }

    if (msg.type === 'setPlayerLimit') {
      if (player.role !== 'describer') return send(ws, 'error', { message: 'Only the describer can change the player target.' });
      if (room.started) return send(ws, 'error', { message: 'The player target can only be changed before the round starts.' });
      room.playerLimit = clampPlayerLimit(msg.limit);
      broadcast(room, 'notice', { message: `Room target set to ${room.playerLimit} players.` });
      broadcastState(room);
      return;
    }

    if (msg.type === 'setRoundOptions') {
      if (player.role !== 'describer') return send(ws, 'error', { message: 'Only the describer can change round options.' });
      if (room.started) return send(ws, 'error', { message: 'Round options can only be changed before the round starts.' });
      const duration = Number(msg.durationMinutes);
      const promptCount = Number(msg.promptsPerRound);
      const packs = ['classic', ...Object.keys(EXTRA_PROMPTS)];
      const difficulties = ['easy', 'medium', 'hard'];
      if ([1, 2, 3, 5].includes(duration)) room.roundDurationMs = duration * 60 * 1000;
      if ([5, 10, 15].includes(promptCount)) room.promptsPerRound = promptCount;
      if (packs.includes(msg.promptPack)) room.promptPack = msg.promptPack;
      if (difficulties.includes(msg.difficulty)) room.difficulty = msg.difficulty;
      broadcast(room, 'notice', { message: 'Round options updated.' });
      broadcastState(room);
      return;
    }

    if (msg.type === 'startRound') {
      if (player.role !== 'describer') return send(ws, 'error', { message: 'Only the describer can start a round.' });
      if (room.players.size < 2) return send(ws, 'error', { message: 'At least 2 players are required to start.' });
      if (room.started) return send(ws, 'error', { message: 'A round is already in progress.' });
      startRound(room);
      return;
    }

    if (msg.type === 'pause') {
      if (player.role !== 'describer') return send(ws, 'error', { message: 'Only the describer can pause the game.' });
      if (!room.started) return send(ws, 'error', { message: 'There is no active round.' });
      if (room.paused) resumeRound(room); else pauseRound(room);
      return;
    }

    if (msg.type === 'pass') {
      if (player.role !== 'describer') return send(ws, 'error', { message: 'Only the describer can pass.' });
      if (!room.started) return send(ws, 'error', { message: 'There is no active round.' });
      if (room.paused) return send(ws, 'error', { message: 'Resume the game before passing.' });
      passPrompt(room);
      return;
    }

    if (msg.type === 'guess') {
      const guess = String(msg.guess || '').trim().slice(0, 120);
      if (!guess) return send(ws, 'guessWarning', { message: 'Please enter a guess.' });
      if (!room.started || !room.currentPrompt) return send(ws, 'guessWarning', { message: 'The round is already over. No more guesses are accepted.' });
      if (room.paused) return send(ws, 'guessWarning', { message: 'The game is paused. Your guess was not submitted.' });
      if (player.role === 'describer') return send(ws, 'guessWarning', { message: 'The describer cannot submit guesses.' });
      if (Date.now() >= room.roundEndsAt) {
        endRound(room, 'Time is up!');
        return send(ws, 'guessWarning', { message: 'Time is up. Your guess was not submitted.' });
      }

      if (!isAllowedGuessText(guess)) {
        return send(ws, 'guessWarning', { message: 'Invalid guess. Use letters, spaces, or hyphens only—no numbers, punctuation, or emojis.' });
      }
      if (isOffensiveGuess(guess)) {
        return send(ws, 'guessWarning', { message: 'Please keep guesses respectful. That guess was not submitted.' });
      }

      const normalizedGuess = normalizeAnswer(guess);
      const normalizedAnswer = normalizeAnswer(room.currentPrompt);
      const guessLetterLength = normalizedLetterLength(guess);
      const answerLetterLength = normalizedLetterLength(room.currentPrompt);
      if (!normalizedGuess) return send(ws, 'guessWarning', { message: 'Please enter letters to make a guess.' });

      // Length-invalid guesses are rejected privately before they can be
      // counted as attempts or broadcast to the room. Spaces and hyphens
      // do not count toward the letter length.
      if (guessLetterLength < answerLetterLength) {
        return send(ws, 'guessWarning', { message: `Your guess is too short (${guessLetterLength} letters; answer has ${answerLetterLength}). Try again.` });
      }
      if (guessLetterLength > answerLetterLength) {
        return send(ws, 'guessWarning', { message: `Your guess is too long (${guessLetterLength} letters; answer has ${answerLetterLength}). Try again.` });
      }

      const correct = normalizedGuess === normalizedAnswer;
      const attempt = getGuessAttempt(room, player);

      if (correct) {
        player.score += 1;
        const answer = room.currentPrompt;
        broadcast(room, 'guess', { player: player.name, playerId: player.id, guess, correct: true, at: Date.now() });
        broadcast(room, 'notice', { message: `${player.name} got it! The answer was “${answer}”. +1 point.` });
        advanceAfterSolve(room, player.id);
        return;
      }

      attempt.wrongCount += 1;
      if (attempt.wrongCount >= 2) {
        return send(ws, 'guessWarning', { message: 'That was your second incorrect guess for this word. No points or turn were lost—try another answer.' });
      }

      broadcast(room, 'guess', { player: player.name, playerId: player.id, guess, correct: false, at: Date.now() });
      return;
    }

    if (msg.type === 'endRound') {
      if (player.role !== 'describer') return send(ws, 'error', { message: 'Only the describer can end the round.' });
      endRound(room, 'Round ended by the describer.');
      return;
    }
  });

  ws.on('close', () => {
    if (room && player) removePlayer(room, player.id, ws);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  console.log(`Word Guess Game running at http://localhost:${PORT}`);
  for (const address of addresses) console.log(`LAN access: http://${address}:${PORT}`);
  console.log(`Default round rules: ${DEFAULT_PROMPTS_PER_ROUND} words, ${Math.round(DEFAULT_ROUND_DURATION_MS / 60000)} minutes, 1 point per correct guess.`);
  console.log('Meeting: video/audio use browser WebRTC; camera/microphone require HTTPS or localhost in most browsers.');
});
