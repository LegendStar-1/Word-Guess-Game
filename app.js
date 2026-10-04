const app = document.getElementById('app');
const scoreListEl = document.getElementById('scoreList'); const meetingDockEl = document.getElementById('meetingDock');
const shareEl = document.getElementById('share'); const shareUrlEl = document.getElementById('shareUrl'); const noticeEl = document.getElementById('notice');
const meetingEl = document.getElementById('meeting'); const videoGridEl = document.getElementById('videoGrid'); const meetingStatusEl = document.getElementById('meetingStatus'); const meetingNoteEl = document.getElementById('meetingNote');
const chatEl = document.getElementById('chat'); const chatLogEl = document.getElementById('chatLog'); const chatInput = document.getElementById('chatInput'); const chatBtn = document.getElementById('chatBtn');
let ws = null, me = null, currentState = null, roomCode = new URLSearchParams(location.search).get('room')?.toUpperCase() || null;
let playerToken = roomCode ? localStorage.getItem(`wordGuessPlayerToken:${roomCode}`) || '' : '';
let savedPlayerName = roomCode ? localStorage.getItem(`wordGuessPlayerName:${roomCode}`) || '' : '';
let guesses = [], countdownTimer = null, roundFinished = false, lastNotice = '';
let localStream = null, mediaStarted = false, muted = false, cameraOff = false;
const peers = new Map(); const remoteStreams = new Map(); const remoteNames = new Map();
let fireworksFrame = null;
const preferenceKey = 'wordGuessPreferences';
let preferences = { sound: true, fireworks: true, ...JSON.parse(localStorage.getItem(preferenceKey) || '{}') };
let clueTimer = null;
let speechRecognition = null, speechGuardEnabled = false, speechRestartTimer = null, guessRecognition = null;
let answerGuardWarning = '', guardedPrompt = '';

function esc(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function roleLabel(role) { return role === 'describer' ? 'Describer' : 'Guesser'; }
function setNotice(msg) { lastNotice = msg || ''; noticeEl.textContent = lastNotice; const b = document.getElementById('noticeBanner'); if (b) b.textContent = lastNotice; }
function setGuessWarning(msg) { const el = document.getElementById('guessWarning'); if (el) { el.textContent = msg || ''; el.classList.toggle('hidden', !msg); } }
function formatTime(ms) { const total = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; }
function wsSend(data) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(data)); }

async function startLocalMedia() {
  if (mediaStarted || !navigator.mediaDevices?.getUserMedia) return;
  if (!window.isSecureContext) { meetingStatusEl.textContent = 'Chat ready'; meetingNoteEl.textContent = 'Camera/microphone are blocked by most browsers on http://192.168.x.x. Use HTTPS or localhost for the meeting. Room chat still works.'; return; }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    mediaStarted = true; muted = false; cameraOff = false; renderLocalVideo(); meetingStatusEl.textContent = 'Meeting ready';
    for (const [peerId, pc] of peers) {
      localStream.getTracks().forEach(track => { if (!pc.getSenders().some(s => s.track === track)) pc.addTrack(track, localStream); });
      if (me?.id && peerId > me.id) {
        try { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); wsSend({ type: 'signal', targetId: peerId, signal: { type: 'offer', sdp: pc.localDescription.sdp } }); } catch (_) { }
      }
    }
    for (const id of (currentState?.players || []).map(p => p.id)) { if (id !== me?.id) ensurePeer(id); }
  } catch (err) {
    meetingStatusEl.textContent = 'Chat ready';
    meetingNoteEl.textContent = `Camera/microphone permission was not granted (${err.name || 'permission error'}). You can still use room chat.`;
  }
}
function renderLocalVideo() {
  if (!mediaStarted || !localStream) return;
  let tile = document.getElementById('tile-local');
  if (!tile) { tile = document.createElement('div'); tile.className = 'video-tile'; tile.id = 'tile-local'; videoGridEl.prepend(tile); }
  tile.innerHTML = `<video id="localVideo" autoplay playsinline muted></video><div class="tile-label">${esc(me?.name || 'You')} (you)</div>`;
  const v = tile.querySelector('video'); v.srcObject = localStream; v.muted = true;
}
function renderRemoteVideo(id) {
  let tile = document.getElementById('tile-' + id); const stream = remoteStreams.get(id); if (!stream) return;
  if (!tile) { tile = document.createElement('div'); tile.className = 'video-tile'; tile.id = 'tile-' + id; videoGridEl.appendChild(tile); }
  tile.innerHTML = `<video autoplay playsinline></video><div class="tile-label">${esc(remoteNames.get(id) || 'Player')}</div>`;
  tile.querySelector('video').srcObject = stream;
}
function removePeer(id) {
  const pc = peers.get(id); if (pc) pc.close(); peers.delete(id); remoteStreams.delete(id); remoteNames.delete(id); const tile = document.getElementById('tile-' + id); if (tile) tile.remove();
}
function syncPeers(players) {
  const activeIds = new Set(players.filter(p => p.online && p.id !== me?.id).map(p => p.id));
  for (const id of [...peers.keys()]) if (!activeIds.has(id)) removePeer(id);
  for (const p of players) { if (p.id !== me?.id && p.online) { remoteNames.set(p.id, p.name); if (me?.id && p.id > me.id) ensurePeer(p.id, true); } }
}
function ensurePeer(peerId, createOffer = false) {
  if (!me || peerId === me.id || peers.has(peerId)) return peers.get(peerId);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  peers.set(peerId, pc);
  if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.onicecandidate = e => { if (e.candidate) wsSend({ type: 'signal', targetId: peerId, signal: { type: 'ice', candidate: e.candidate } }); };
  pc.ontrack = e => { remoteStreams.set(peerId, e.streams[0]); renderRemoteVideo(peerId); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) { if (pc.connectionState === 'failed') { removePeer(peerId); } } };
  if (createOffer) pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => wsSend({ type: 'signal', targetId: peerId, signal: { type: 'offer', sdp: pc.localDescription.sdp } })).catch(() => { });
  return pc;
}
async function handleSignal(from, signal) {
  if (!me) return;
  const pc = ensurePeer(from, false);
  if (!pc) return;
  try {
    if (signal.type === 'offer') {
      if (localStream) localStream.getTracks().forEach(track => { if (!pc.getSenders().some(s => s.track === track)) pc.addTrack(track, localStream); });
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); wsSend({ type: 'signal', targetId: from, signal: { type: 'answer', sdp: pc.localDescription.sdp } });
    } else if (signal.type === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    } else if (signal.type === 'ice' && signal.candidate) {
      try { await pc.addIceCandidate(signal.candidate); } catch (_) { }
    }
  } catch (_) { }
}
function appendChat(entry) {
  const row = document.createElement('div'); row.className = 'chat-msg'; const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); row.innerHTML = `<b>${esc(entry.player)}</b>${esc(entry.message)} <span class="chat-time">${time}</span>`; chatLogEl.appendChild(row); chatLogEl.scrollTop = chatLogEl.scrollHeight;
}
function sendChat() { const message = chatInput.value.trim(); if (!message) return; wsSend({ type: 'chat', message }); chatInput.value = ''; chatInput.focus(); }
function setMeetingVisible(show) { meetingEl.classList.toggle('hidden', !show); chatEl.classList.toggle('hidden', !show); }
function placeMeeting(target) { if (!target) return; target.appendChild(meetingEl); }
function renderJoin() {
  placeMeeting(meetingDockEl);
  setMeetingVisible(false);
  document.body.classList.toggle('home-only', !roomCode);

  if (roomCode) {
    app.innerHTML = `<div class="home-page"><h1>Word Guess</h1><div class="home-panel"><div class="home-block"><div class="home-block-title">Join room ${esc(roomCode)}</div><div class="home-field"><input id="name" maxlength="24" placeholder="Enter your username" value="${esc(savedPlayerName)}" autofocus /><button class="primary" id="joinBtn">Join room</button></div></div><div class="home-rules"><h3>Game rules</h3><ul><li>One describer gives clues while guessers submit answers.</li><li>Each round lasts 3 minutes and contains up to 10 words or phrases.</li><li>Each correct guess earns 1 point. PASS words can return while time remains.</li><li>The describer can pause the round, and the next guesser takes over if the describer leaves.</li></ul></div></div></div>`;
    app.querySelector('.home-rules li:nth-child(4)').textContent = 'If the describer disconnects, the room waits 30 seconds before promoting another player.';
    document.querySelector('.home-block .home-field').insertAdjacentHTML('afterend', '<label class="recovery-entry">Returning from another browser? Paste your private recovery code<input id="recoveryCodeInput" autocomplete="off" placeholder="Recovery code (optional)"></label>');
    const go = () => { const name = document.getElementById('name').value.trim() || 'Player'; const recoveryCode = document.getElementById('recoveryCodeInput')?.value.trim(); localStorage.setItem(`wordGuessPlayerName:${roomCode}`, name); wsSend({ type: 'join', room: roomCode, name, playerToken: recoveryCode || playerToken }); };
    document.getElementById('joinBtn').onclick = go;
    document.getElementById('name').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    return;
  }

  app.innerHTML = `<div class="home-page"><h1>Word Guess</h1><div class="home-panel"><div class="home-block"><div class="home-block-title">Create a new room</div><div class="home-field"><input id="name" maxlength="24" placeholder="Enter your username" value="${esc(savedPlayerName)}" autofocus /><select id="createPlayerLimit" aria-label="Target players">${[2, 3, 4, 5, 6].map(n => `<option value="${n}">${n} players</option>`).join('')}</select><button class="primary" id="createBtn">Create room</button></div></div><div class="home-or">or</div><div class="home-block"><div class="home-block-title">Join an existing room</div><div class="home-field"><input id="joinRoomCode" maxlength="12" placeholder="Enter room code" autocomplete="off" /><button class="secondary" id="joinExistingBtn">Join room</button></div></div></div><div class="home-rules"><h3>Game rules</h3><ul><li>One player describes the secret word or phrase. Everyone else guesses.</li><li>Each round lasts 3 minutes and contains up to 10 words or phrases.</li><li>Each correct guess earns 1 point. PASS words can return while time remains.</li><li>The describer can pause the round, and the next guesser takes over if the describer leaves.</li><li>Invalid, offensive, or incorrectly sized guesses are rejected privately and do not affect the round.</li></ul></div></div>`;

  app.querySelector('.home-rules li:nth-child(4)').textContent = 'If the describer disconnects, the room waits 30 seconds before promoting another player.';
  const create = () => { const name = document.getElementById('name').value.trim() || 'Player'; const playerLimit = Number(document.getElementById('createPlayerLimit').value); wsSend({ type: 'create', name, playerLimit }); };
  const joinExisting = () => {
    const name = document.getElementById('name').value.trim() || 'Player';
    const code = document.getElementById('joinRoomCode').value.trim().toUpperCase();
    if (!code) return;
    savedPlayerName = name;
    localStorage.setItem(`wordGuessPlayerName:${code}`, name);
    wsSend({ type: 'join', room: code, name, playerToken: localStorage.getItem(`wordGuessPlayerToken:${code}`) || '' });
  };
  document.getElementById('createBtn').onclick = create;
  document.getElementById('joinExistingBtn').onclick = joinExisting;
  document.getElementById('name').addEventListener('keydown', e => { if (e.key === 'Enter') create(); });
  document.getElementById('joinRoomCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinExisting(); });
}
function renderState(s) {
  document.body.classList.remove('home-only');
  currentState = s; me = me || {};
  const self = s.players.find(p => p.id === me.id);
  if (self) { me.role = self.role; me.name = self.name; }
  if (roundFinished && !s.started && window.lastRoundResult) {
    renderRoundEnd(window.lastRoundResult); renderPlayers(s.players); renderScores(s.scores || []); renderHistory(s.history || []); syncPeers(s.players); return;
  }

  const iAmDescriber = me.role === 'describer';
  const canStart = s.players.length >= 2 && !s.started;
  const targetReached = s.players.length >= s.playerLimit;
  const statusBadge = targetReached
    ? '<span class="ready-badge">Ready to play</span>'
    : '<span class="waiting-badge">Waiting for more players</span>';
  const headerTitle = iAmDescriber && s.started && s.currentPrompt ? `Your secret word: <span class="secret-word-inline">${esc(s.currentPrompt)}</span>` : (s.started ? 'Guess the word!' : '');
  const subText = s.started
    ? `Word ${Math.min(s.currentNumber, s.totalWords)} of ${s.totalWords}. Type your answer as soon as you are ready.`
    : '';

  setMeetingVisible(true); chatEl.classList.remove('hidden'); syncPeers(s.players);
  if (guardedPrompt !== (s.currentPrompt || '')) { guardedPrompt = s.currentPrompt || ''; answerGuardWarning = ''; }
  app.innerHTML = `<div class="game-top"><div><div class="room-line"><div class="eyebrow">Room ${esc(s.room)}</div>${statusBadge}${s.paused ? '<span class="paused-badge">Paused</span>' : ''}</div>${headerTitle ? `<h2>${headerTitle}</h2>` : ''}${subText ? `<p class="sub">${subText}</p>` : ''}</div><span class="role">${roleLabel(me.role)}</span></div>
${lastNotice ? `<div class="notice-banner" id="noticeBanner">${esc(lastNotice)}</div>` : ''}
<div class="stats"><div class="stat timer"><div class="label">Time left</div><div class="value" id="timerValue">${s.started ? (s.paused ? formatTime(s.pauseRemainingMs) : formatTime(s.roundEndsAt - Date.now())) : formatTime(s.roundDurationMs)}</div></div><div class="stat"><div class="label">Solved</div><div class="value">${s.wordsSolved}/${s.totalWords}</div></div><div class="stat"><div class="label">Skipped</div><div class="value">${s.skippedCount}</div></div><div class="stat"><div class="label">Players</div><div class="value">${s.players.length}/${s.playerLimit}</div></div></div>
<div class="prompt">${iAmDescriber && s.started && s.currentPrompt ? `<div class="meeting-slot" id="meetingSlot"><div class="meeting-main-note">Describe the word above without saying it directly.</div></div>` : `<div class="meeting-slot" id="meetingSlot">${s.started ? '<div class="hidden-prompt">The secret word is hidden from guessers.<br><br>Watch and listen to the meeting, then type your answer below.</div>' : (targetReached ? '<div class="hidden-prompt">The room is ready.<br>The describer can start the 3-minute round.</div>' : '<div class="hidden-prompt">Waiting for more players to reach the room target.<br><br>The describer can still start once at least 2 players are here.</div>')}</div>`}</div>
<div class="actions">${iAmDescriber && !s.started ? `<label class="room-setting">Players to join <select id="playerLimit">${[2, 3, 4, 5, 6].map(n => `<option value="${n}" ${n === s.playerLimit ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label class="room-setting">Round length <select id="durationOption">${[1, 2, 3, 5].map(n => `<option value="${n}" ${n * 60000 === s.roundDurationMs ? 'selected' : ''}>${n} min</option>`).join('')}</select></label><label class="room-setting">Prompts <select id="promptCountOption">${[5, 10, 15].map(n => `<option value="${n}" ${n === s.totalWords ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label class="room-setting">Pack <select id="promptPackOption">${[['classic','Classic'],['everyday','Everyday'],['work','Work'],['party','Party'],['animals','Animals']].map(([v,l]) => `<option value="${v}" ${v === s.promptPack ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="room-setting">Difficulty <select id="difficultyOption">${['easy','medium','hard'].map(v => `<option value="${v}" ${v === s.difficulty ? 'selected' : ''}>${v[0].toUpperCase()+v.slice(1)}</option>`).join('')}</select></label>` : ''}${iAmDescriber ? `<button class="primary" id="startRound" ${!canStart ? 'disabled' : ''}>Start ${s.roundDurationMs / 60000}-minute round</button><button class="secondary" id="pauseBtn" ${s.started ? '' : 'disabled'}>${s.paused ? 'Resume' : 'Pause'}</button><button class="danger" id="passBtn" ${s.started && !s.paused ? '' : 'disabled'}>PASS</button><button class="secondary" id="endRound" ${s.started ? '' : 'disabled'}>End round</button>` : ''}</div>
${!iAmDescriber ? `<div class="guess-row"><input id="guess" maxlength="120" autocomplete="off" placeholder="Type or speak your answer…" ${s.started && !s.paused ? '' : 'disabled'} /><button class="secondary" id="speakGuessBtn" ${s.started && !s.paused ? '' : 'disabled'}>Speak answer</button><button class="primary" id="guessBtn" ${s.started && !s.paused ? '' : 'disabled'}>Guess</button></div><div class="speech-guess-notice">Optional speech input: click Speak answer to request microphone access and transcribe one answer into the box. Review it, then click Guess. Depending on your browser, audio may be processed by its speech-recognition service; the game does not send it to its server.</div><div id="speechGuessStatus" class="speech-guard-status" role="status"></div><div id="guessWarning" class="guess-warning hidden"></div>` : ''}
<div class="clue-clock ${iAmDescriber && s.started ? '' : 'hidden'}" id="clueClock">Next clue reminder in <strong id="clueSeconds">30</strong>s</div><div class="guess-log" id="guessLog"></div><section class="game-history"><h3>Overall standings</h3>${(s.overallScores || []).map((p,i) => `<div class="score-row"><span>${i+1}. ${esc(p.name)}</span><span class="pts">${p.score}</span></div>`).join('') || '<p class="small">Play a round to start the standings.</p>'}<details><summary>Round history (${(s.history || []).length})</summary>${(s.history || []).slice().reverse().map(h => `<div class="history-round"><b>Round ${h.roundNumber}</b><span>${esc((h.winners || []).map(w => w.name).join(' & ') || 'No winner')} · ${h.scores.map(p => `${esc(p.name)} ${p.score}`).join(', ')}</span></div>`).join('')}</details></section>`;

  if (iAmDescriber && s.started) {
    app.insertAdjacentHTML('afterbegin', `<section class="speech-guard"><strong>Spoken-answer check</strong><p>Optional: if enabled, speech recognition continuously listens to your microphone during this round and warns you if it hears the answer. The game checks the transcript on this device and does not send it to the game server. Depending on your browser, audio may be processed by its speech-recognition service. You can turn this off at any time.</p><button class="secondary" id="speechGuardToggle">${speechGuardEnabled ? 'Turn off spoken-answer check' : 'Allow spoken-answer check'}</button><span class="speech-guard-status">${esc(answerGuardWarning || (speechGuardEnabled ? 'Listening for the answer…' : 'Off'))}</span>${answerGuardWarning && answerGuardWarning.includes('may have said') ? '<div id="answerGuardWarning" class="answer-guard-warning" role="status">Possible answer detected. Rephrase that clue.</div>' : ''}</section>`);
    document.getElementById('speechGuardToggle').onclick = () => speechGuardEnabled ? stopSpeechGuard() : startSpeechGuard();
  }
  if (!s.started && speechGuardEnabled) stopSpeechGuard();

  const slot = document.getElementById('meetingSlot');
  if (slot && s.players.length >= 2) placeMeeting(slot);
  if (iAmDescriber) {
    const startBtn = document.getElementById('startRound');
    const pauseBtn = document.getElementById('pauseBtn');
    const passBtn = document.getElementById('passBtn');
    const endBtn = document.getElementById('endRound');
    const limitEl = document.getElementById('playerLimit');
    const updateOptions = () => wsSend({ type: 'setRoundOptions', durationMinutes: Number(document.getElementById('durationOption').value), promptsPerRound: Number(document.getElementById('promptCountOption').value), promptPack: document.getElementById('promptPackOption').value, difficulty: document.getElementById('difficultyOption').value });
    if (startBtn) startBtn.onclick = () => wsSend({ type: 'startRound' });
    if (pauseBtn) pauseBtn.onclick = () => wsSend({ type: 'pause' });
    if (passBtn) passBtn.onclick = () => wsSend({ type: 'pass' });
    if (endBtn) endBtn.onclick = () => wsSend({ type: 'endRound' });
    if (limitEl) limitEl.onchange = () => wsSend({ type: 'setPlayerLimit', limit: Number(limitEl.value) });
    ['durationOption','promptCountOption','promptPackOption','difficultyOption'].forEach(id => document.getElementById(id)?.addEventListener('change', updateOptions));
  } else {
    const input = document.getElementById('guess'), button = document.getElementById('guessBtn'), speakButton = document.getElementById('speakGuessBtn');
    const submit = () => { if (!input.disabled && input.value.trim()) { wsSend({ type: 'guess', guess: input.value }); input.value = ''; input.focus(); } };
    button.onclick = submit;
    speakButton.onclick = () => startSpokenGuess(speakButton);
    input.addEventListener('input', () => setGuessWarning(''));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    if (s.started && !s.paused) setTimeout(() => input.focus(), 0);
  }
  setGuessWarning('');
  renderPlayers(s.players); renderScores(s.scores || []); renderHistory(s.history || []); renderGuesses(); startCountdown(s); startClueTimer(s);
  if (!mediaStarted && window.isSecureContext && s.players.length >= 2) startLocalMedia();
}
function stopFireworks() {
  if (fireworksFrame) cancelAnimationFrame(fireworksFrame);
  fireworksFrame = null;
  document.getElementById('fireworks')?.remove();
}
function startFireworks() {
  stopFireworks();
  if (!preferences.fireworks || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'fireworks'; canvas.className = 'fireworks'; canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const resize = () => { canvas.width = window.innerWidth * devicePixelRatio; canvas.height = window.innerHeight * devicePixelRatio; ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); };
  resize();
  const colors = ['#ff5c8a', '#ffd166', '#6ee7b7', '#60a5fa', '#c084fc', '#fff'];
  const particles = [];
  let lastBurst = 0;
  const started = performance.now();
  const draw = now => {
    const w = window.innerWidth, h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    if (now - lastBurst > 420 && now - started < 4200) {
      lastBurst = now;
      const x = w * (.15 + Math.random() * .7), y = h * (.12 + Math.random() * .42);
      const color = colors[Math.floor(Math.random() * colors.length)];
      for (let i = 0; i < 48; i++) { const angle = Math.random() * Math.PI * 2, speed = 1.2 + Math.random() * 3.2; particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, color, size: 1.5 + Math.random() * 2 }); }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]; p.x += p.vx; p.y += p.vy; p.vy += .035; p.vx *= .99; p.life -= .012;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = p.life; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (now - started < 6500) fireworksFrame = requestAnimationFrame(draw);
    else stopFireworks();
  };
  window.addEventListener('resize', resize, { once: true });
  fireworksFrame = requestAnimationFrame(draw);
}
function renderRoundEnd(msg) {
  document.body.classList.remove('home-only');
  const scores = msg.scores || [];
  const mine = scores.find(p => p.id === me?.id);
  const winners = msg.winners || [];
  const winnerText = winners.length === 1 ? `${winners[0].name} wins!` : winners.length > 1 ? `It's a tie: ${winners.map(p => p.name).join(' & ')}!` : 'No winner this round';
  app.innerHTML = `<div class="round-end"><div class="eyebrow">Round complete</div><h2>${esc(msg.message || 'Time!')}</h2><div class="winner-banner">🏆 ${esc(winnerText)}</div><div class="big-score">${mine ? mine.score : 0}</div><div class="small">Your points</div><p class="sub" style="margin-top:18px">${msg.wordsSolved || 0} of ${msg.totalWords || 10} words solved.</p><div class="actions" style="justify-content:center"><button class="primary" id="restartRound">${me?.role === 'describer' ? 'Start another round' : 'Waiting for describer'}</button></div></div>`;
  placeMeeting(meetingDockEl); setMeetingVisible(true);
  const btn = document.getElementById('restartRound');
  if (me?.role === 'describer') btn.onclick = () => wsSend({ type: 'startRound' }); else btn.disabled = true;
  app.insertAdjacentHTML('beforeend', '<section class="final-board"><h3>Round scores</h3>' + scores.map((p,i) => `<div class="score-row"><span>${i+1}. ${esc(p.name)}</span><span class="pts">${p.score} pts</span></div>`).join('') + '<h3>Overall standings</h3>' + (msg.overallScores || []).map((p,i) => `<div class="score-row"><span>${i+1}. ${esc(p.name)}</span><span class="pts">${p.score} pts</span></div>`).join('') + '<details><summary>Round history</summary>' + (msg.history || []).slice().reverse().map(h => `<div>Round ${h.roundNumber}: ${esc((h.winners || []).map(w => w.name).join(' & '))}</div>`).join('') + '</details><div class="actions"><button class="secondary" id="soundToggle">Sound: ' + (preferences.sound ? 'on' : 'off') + '</button><button class="secondary" id="fireworksToggle">Fireworks: ' + (preferences.fireworks ? 'on' : 'off') + '</button></div></section>');
  document.getElementById('soundToggle').onclick = () => { preferences.sound = !preferences.sound; savePreferences(); renderRoundEnd(msg); };
  document.getElementById('fireworksToggle').onclick = () => { preferences.fireworks = !preferences.fireworks; savePreferences(); if (preferences.fireworks) startFireworks(); else stopFireworks(); renderRoundEnd(msg); };
}
function renderPlayers() { shareEl.hidden = !roomCode; if (roomCode) shareUrlEl.value = location.href; const recovery = document.getElementById('recovery'); if (recovery) { recovery.hidden = !roomCode || !playerToken; if (!recovery.hidden) document.getElementById('recoveryCode').value = playerToken; } }
function renderScores(scores) { if (!scoreListEl) return; const activeIds = currentState?.roundNumber ? new Set(currentState.activePlayerIds || []) : null; const visible = activeIds ? scores.filter(p => activeIds.has(p.id)) : scores; scoreListEl.innerHTML = `<h3>Scoreboard</h3>${visible.length ? visible.map(p => `<div class="score-row"><span class="score-player"><strong>${esc(p.name)}</strong><span class="role-label">${roleLabel(p.role)}</span>${p.online ? '' : '<span class="offline-label">Disconnected</span>'}</span><span class="pts">${p.score} ${p.score === 1 ? 'pt' : 'pts'}</span></div>`).join('') : '<div class="small">No active players yet.</div>'}`; }
function renderHistory(history) { const el = document.getElementById('roundHistory'); if (!el) return; el.innerHTML = `<details><summary>Round History (${history.length})</summary>${history.slice().reverse().map(h => `<div class="history-round"><b>Round ${h.roundNumber}</b><span>${esc((h.winners || []).map(w => w.name).join(' & ') || 'No winner')} · ${(h.scores || []).map(p => `${esc(p.name)} ${p.score}`).join(', ')}</span></div>`).join('')}</details>`; }
function renderGuesses() { const el = document.getElementById('guessLog'); if (!el) return; el.innerHTML = guesses.length ? guesses.map(g => `<div class="guess-item"><span><b>${esc(g.player)}</b>: ${esc(g.guess)}</span><span class="${g.correct ? 'guess-correct' : ''}">${g.correct ? '+1 ✓' : ''}</span></div>`).join('') : '<div class="small" style="padding:10px 0">Guesses will appear here.</div>'; }
function startCountdown(s) { clearInterval(countdownTimer); const timerEl = document.getElementById('timerValue'); if (!timerEl || !s.started) return; if (s.paused) { timerEl.textContent = formatTime(s.pauseRemainingMs); return; } if (!s.roundEndsAt) return; countdownTimer = setInterval(() => { const left = s.roundEndsAt - Date.now(); timerEl.textContent = formatTime(left); if (left <= 0) clearInterval(countdownTimer); }, 250); }
function startClueTimer(s) { clearInterval(clueTimer); const value = document.getElementById('clueSeconds'); if (!value || !s.promptStartedAt || s.paused) return; const update = () => { const elapsed = Math.floor((Date.now() - s.promptStartedAt) / 1000); value.textContent = String(Math.max(0, 30 - (elapsed % 30))); }; update(); clueTimer = setInterval(update, 1000); }
function savePreferences() { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); }
function playPointSound() { if (!preferences.sound) return; try { const audio = new AudioContext(); const oscillator = audio.createOscillator(); const gain = audio.createGain(); gain.gain.value = .07; oscillator.frequency.value = 740; oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + .12); oscillator.onended = () => audio.close(); } catch (_) { } }
function updateSpeechGuardUi() {
  const button = document.getElementById('speechGuardToggle');
  const status = document.querySelector('.speech-guard-status');
  if (button) button.textContent = speechGuardEnabled ? 'Turn off spoken-answer check' : 'Allow spoken-answer check';
  if (status) status.textContent = answerGuardWarning || (speechGuardEnabled ? 'Listening for the answer…' : 'Off');
}
function phraseWasSpoken(transcript, answer) {
  const spoken = String(transcript).toLocaleLowerCase().match(/[a-z0-9]+/g) || [];
  const target = String(answer).toLocaleLowerCase().match(/[a-z0-9]+/g) || [];
  if (!target.length || target.length > spoken.length) return false;
  return spoken.some((_, i) => target.every((word, j) => spoken[i + j] === word));
}
function startSpokenGuess(button) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = document.getElementById('speechGuessStatus');
  if (!Recognition) { if (status) status.textContent = 'Speech recognition is not available in this browser.'; return; }
  if (guessRecognition) { try { guessRecognition.abort(); } catch (_) { } }
  const recognition = new Recognition();
  guessRecognition = recognition;
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = navigator.language || 'en-US';
  if (status) status.textContent = 'Listening for one answer…';
  button.disabled = true;
  recognition.onresult = event => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    const input = document.getElementById('guess');
    if (transcript && input) { input.value = transcript; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); if (status) status.textContent = 'Answer transcribed. Review it, then click Guess.'; }
    else if (status) status.textContent = 'No speech was recognized. Try again or type your answer.';
  };
  recognition.onerror = event => {
    if (status) status.textContent = event.error === 'not-allowed' || event.error === 'service-not-allowed'
      ? 'Microphone or speech-recognition permission was denied. You can still type your answer.'
      : 'Speech recognition stopped. You can try again or type your answer.';
  };
  recognition.onend = () => { if (guessRecognition === recognition) guessRecognition = null; if (button.isConnected) button.disabled = false; };
  try { recognition.start(); }
  catch (_) { guessRecognition = null; button.disabled = false; if (status) status.textContent = 'Could not start speech recognition. Check browser microphone permission.'; }
}
function startSpeechGuard() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    answerGuardWarning = 'Speech recognition is not available in this browser.';
    updateSpeechGuardUi();
    return;
  }
  answerGuardWarning = '';
  speechGuardEnabled = true;
  const recognition = new Recognition();
  speechRecognition = recognition;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';
  recognition.onresult = event => {
    if (!speechGuardEnabled || answerGuardWarning || !currentState?.currentPrompt) return;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (phraseWasSpoken(event.results[i][0].transcript, currentState.currentPrompt)) {
        answerGuardWarning = 'Recognition thinks you may have said the answer.';
        updateSpeechGuardUi();
        const warning = document.getElementById('answerGuardWarning');
        if (warning) warning.textContent = 'Possible answer detected. Rephrase that clue.';
        return;
      }
    }
  };
  recognition.onerror = event => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      speechGuardEnabled = false;
      answerGuardWarning = 'Microphone or speech recognition permission was denied.';
      updateSpeechGuardUi();
    }
  };
  recognition.onend = () => {
    if (!speechGuardEnabled || !currentState?.started || speechRecognition !== recognition) return;
    clearTimeout(speechRestartTimer);
    speechRestartTimer = setTimeout(() => { try { recognition.start(); } catch (_) { } }, 350);
  };
  try { recognition.start(); updateSpeechGuardUi(); }
  catch (_) { speechGuardEnabled = false; answerGuardWarning = 'Could not start speech recognition. Check browser microphone permission.'; updateSpeechGuardUi(); }
}
function stopSpeechGuard() {
  speechGuardEnabled = false;
  clearTimeout(speechRestartTimer);
  speechRestartTimer = null;
  if (speechRecognition) { speechRecognition.onend = null; try { speechRecognition.abort(); } catch (_) { } }
  speechRecognition = null;
  answerGuardWarning = '';
  updateSpeechGuardUi();
}
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'; ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { if (me) { /* browser reconnect path */ } renderJoin(); };
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'welcome') { stopFireworks(); const joinedName = document.getElementById('name')?.value?.trim() || savedPlayerName || 'Player'; me = { id: msg.playerId, role: msg.role, name: joinedName }; roomCode = msg.room; playerToken = msg.playerToken || playerToken; savedPlayerName = joinedName; localStorage.setItem(`wordGuessPlayerToken:${roomCode}`, playerToken); localStorage.setItem(`wordGuessPlayerName:${roomCode}`, savedPlayerName); history.replaceState({}, '', `?room=${encodeURIComponent(roomCode)}`); roundFinished = false; window.lastRoundResult = null; setMeetingVisible(true); setNotice(msg.reconnected ? 'Welcome back — your points are preserved.' : ''); chatLogEl.innerHTML = ''; }
    if (msg.type === 'state') { const oldRole = me?.role; const self = msg.players.find(p => p.id === me?.id); if (self) { me.role = self.role; me.name = self.name; } currentState = msg; if (oldRole && oldRole !== me.role) { setNotice(me.role === 'describer' ? 'You are now the describer. The current word is still in play.' : `You are now a ${roleLabel(me.role)}.`); } renderState(msg); }
    if (msg.type === 'roundStarted') { stopFireworks(); guesses = []; roundFinished = false; window.lastRoundResult = null; setNotice('Round started! The describer gets the secret word.'); setGuessWarning(''); }
    if (msg.type === 'guess') { guesses.unshift(msg); guesses = guesses.slice(0, 30); renderGuesses(); if (msg.playerId === me?.id) { setGuessWarning(''); if (msg.correct) playPointSound(); } }
    if (msg.type === 'roundEnded') { stopSpeechGuard(); roundFinished = true; clearInterval(countdownTimer); window.lastRoundResult = msg; setNotice(msg.message || 'Round finished.'); renderRoundEnd(msg); renderHistory(msg.history || []); if (msg.winners?.length) startFireworks(); }
    if (msg.type === 'notice') { setNotice(msg.message); const b = document.getElementById('noticeBanner'); if (b) b.textContent = lastNotice; }
    if (msg.type === 'describerChanged') { setNotice(`${msg.previousName} left. ${msg.playerName} is now the describer.`); }
    if (msg.type === 'signal') handleSignal(msg.from, msg.signal);
    if (msg.type === 'chatHistory') { chatLogEl.innerHTML = ''; (msg.messages || []).forEach(appendChat); }
    if (msg.type === 'chat') appendChat(msg);
    if (msg.type === 'meetingParticipant') { const p = (currentState?.players || []).find(x => x.id === msg.playerId); if (p) remoteNames.set(msg.playerId, p.name); }
    if (msg.type === 'guessWarning') { setGuessWarning(msg.message); }
    if (msg.type === 'error') { setNotice(msg.message); }
  };
  ws.onclose = () => { clearInterval(countdownTimer); setNotice('Disconnected. Refresh the page to reconnect.'); };
}

document.getElementById('copyBtn').onclick = async () => { try { await navigator.clipboard.writeText(location.href); setNotice('Invite URL copied.'); } catch { setNotice('Copy failed — select the URL and copy it manually.'); } };
document.getElementById('copyRecoveryBtn').onclick = async () => { try { await navigator.clipboard.writeText(playerToken); setNotice('Recovery code copied. Keep it private.'); } catch { setNotice('Copy failed — select the recovery code and copy it manually.'); } };
document.getElementById('muteBtn').onclick = () => { if (!localStream) return; muted = !muted; localStream.getAudioTracks().forEach(t => t.enabled = !muted); document.getElementById('muteBtn').textContent = muted ? 'Unmute mic' : 'Mute mic'; };
document.getElementById('cameraBtn').onclick = () => { if (!localStream) return; cameraOff = !cameraOff; localStream.getVideoTracks().forEach(t => t.enabled = !cameraOff); document.getElementById('cameraBtn').textContent = cameraOff ? 'Turn camera on' : 'Turn camera off'; };
document.getElementById('meetingRestartBtn').onclick = () => startLocalMedia();
chatBtn.onclick = sendChat; chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
connect(); if (!roomCode) renderJoin();
