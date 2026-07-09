const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- WORD BANK ----------
// The word list lives in wordbank.txt (same folder as this file) so it can be
// edited without touching any code. Each line there is:
//   Word | Tag1, Tag2 | Alias1, Alias2
// A word shows up for a round whenever the host's chosen category matches
// any of its tags — e.g. "Turkey | Animals, Food and Drinks" can appear
// under either category. Add a brand-new tag in the file and it
// automatically becomes a selectable category, no code changes needed.
function loadWordBank(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const entries = [];
  raw.split('\n').forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return; // blank line or comment/section header
    const parts = line.split('|').map(p => p.trim());
    const word = parts[0];
    const tagsPart = parts[1];
    if (!word || !tagsPart) {
      console.warn(`wordbank.txt line ${i + 1}: skipping malformed entry "${rawLine}"`);
      return;
    }
    const tags = tagsPart.split(',').map(t => t.trim()).filter(Boolean);
    const entry = { word, tags };
    if (parts[2]) {
      const aliases = parts[2].split(',').map(a => a.trim()).filter(Boolean);
      if (aliases.length) entry.aliases = aliases;
    }
    entries.push(entry);
  });
  return entries;
}
const WORD_BANK = loadWordBank(path.join(__dirname, 'wordbank.txt'));

const CATEGORY_NAMES = Array.from(new Set(WORD_BANK.flatMap(w => w.tags))).sort();

// ---------- IN-MEMORY STATE ----------
// rooms: code -> room object. Non-serializable fields (timer handles) are
// kept directly on the room object but stripped out by sanitize() before
// anything is sent to clients.
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function uniqueCode() {
  let code;
  do { code = genCode(); } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newRoom(code, hostId, hostName, hostToken) {
  return {
    code,
    hostId,
    players: [{ id: hostId, name: hostName, connected: true, token: hostToken }],
    scores: { [hostId]: 0 },
    status: 'lobby', // lobby | briefing | clues | discussion | voting | imposter-guess | reveal
    categories: [], // empty = pull from every category; otherwise a list of chosen tags
    excludedCategories: [], // tags to always filter out, even if a word also matches an included tag
    customWords: [], // host-added words for this room: [{ id, word, tags }]
    imposterCount: 1,
    clueSeconds: 30,   // per-turn clue timer
    guessSeconds: 20,  // separate timer for the caught imposter's final guess
    guessEnabled: true, // host toggle: whether a caught imposter gets a last-chance guess at all
    roundNumber: 0,

    // per-round fields
    secretWord: null,
    imposterHint: null, // the category name shown to the imposter instead of a decoy word
    imposterIds: [],
    turnOrder: [],
    currentTurnIndex: 0,
    clueRound: 1, // 1..3
    clueLog: {},  // playerId -> [text|null, text|null, text|null]
    turnEndsAt: null,

    votes: {},        // voterId -> suspectId
    accusedIds: [],
    caught: null,
    activeGuesserId: null,
    guessResult: null, // true | false | null

    chat: [],

    _timerHandle: null,
    _hostGraceTimer: null // pending host-migration timer while the host is disconnected
  };
}

function sanitize(room) {
  const base = {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, score: room.scores[p.id] || 0 })),
    status: room.status,
    categories: room.categories,
    excludedCategories: room.excludedCategories,
    customWords: room.customWords,
    allCategories: allCategoriesForRoom(room),
    imposterCount: room.imposterCount,
    clueSeconds: room.clueSeconds,
    guessSeconds: room.guessSeconds,
    guessEnabled: room.guessEnabled,
    roundNumber: room.roundNumber,
    turnOrder: room.turnOrder,
    currentTurnIndex: room.currentTurnIndex,
    clueRound: room.clueRound,
    clueLog: room.clueLog,
    turnEndsAt: room.turnEndsAt,
    votedCount: Object.keys(room.votes).length,
    accusedIds: room.accusedIds,
    caught: room.caught,
    activeGuesserId: room.activeGuesserId,
    guessResult: room.guessResult,
    chat: room.chat.slice(-50)
  };
  // Once clue-giving has started, everyone (not just the imposter) gets to
  // see which category the imposter was briefed on — it's public knowledge
  // to talk about at the table from that point through the rest of the round.
  if (['clues', 'discussion', 'voting', 'imposter-guess', 'reveal'].includes(room.status)) {
    base.imposterHint = room.imposterHint;
  }
  if (room.status === 'reveal') {
    base.secretWord = room.secretWord;
    base.secretAliases = room.secretAliases;
    base.imposterIds = room.imposterIds;
  }
  return base;
}

function broadcastRoom(room) {
  io.to(room.code).emit('room-state', sanitize(room));
}

function clearRoomTimer(room) {
  if (room._timerHandle) {
    clearTimeout(room._timerHandle);
    room._timerHandle = null;
  }
}

function recordClue(room, playerId, text) {
  if (!room.clueLog[playerId]) room.clueLog[playerId] = [null, null, null];
  room.clueLog[playerId][room.clueRound - 1] = text;
}

// ---------- HOST MIGRATION ----------
// If the host disconnects, give them a window to reconnect (e.g. a page
// refresh) before handing host duties to someone else who's still around.
const HOST_GRACE_MS = 15000;

function pushSystemMessage(room, text) {
  room.chat.push({ id: crypto.randomUUID(), playerId: null, name: 'System', text, ts: Date.now(), system: true });
  if (room.chat.length > 200) room.chat = room.chat.slice(-200);
}

function scheduleHostMigration(room, departingHostId) {
  if (room._hostGraceTimer) clearTimeout(room._hostGraceTimer);
  room._hostGraceTimer = setTimeout(() => {
    room._hostGraceTimer = null;
    if (room.hostId !== departingHostId) return; // host already changed some other way
    const stillHost = room.players.find(p => p.id === departingHostId);
    if (stillHost && stillHost.connected) return; // they reconnected in time — stay host
    const newHost = room.players.find(p => p.id !== departingHostId && p.connected);
    if (!newHost) return; // nobody else around to promote; leave as-is
    room.hostId = newHost.id;
    pushSystemMessage(room, `${newHost.name} is now the host (previous host disconnected).`);
    broadcastRoom(room);
  }, HOST_GRACE_MS);
}

// Re-sends a player's private role info after a reconnect, since the
// original 'your-role' broadcast at round-start only reaches the socket
// that was connected at the time. autoReveal skips their tap-to-reveal
// seal since they've already seen this round's word before refreshing.
function sendRoleTo(room, playerId, socket) {
  if (!room.secretWord || room.status === 'lobby') return;
  const isImposter = room.imposterIds.includes(playerId);
  socket.emit('your-role', {
    isImposter,
    word: isImposter ? room.imposterHint : room.secretWord,
    autoReveal: true
  });
}

function scheduleTurnTimer(room) {
  clearRoomTimer(room);
  room.turnEndsAt = Date.now() + room.clueSeconds * 1000;
  room._timerHandle = setTimeout(() => {
    const currentPlayerId = room.turnOrder[room.currentTurnIndex];
    recordClue(room, currentPlayerId, '(no answer)');
    moveToNextTurn(room);
  }, room.clueSeconds * 1000);
}

function moveToNextTurn(room) {
  clearRoomTimer(room);
  room.currentTurnIndex++;
  if (room.currentTurnIndex >= room.turnOrder.length) {
    room.currentTurnIndex = 0;
    room.clueRound++;
    if (room.clueRound > 3) {
      // All clues are logged. Give the table a chance to discuss/justify
      // their answers out loud before the host manually opens voting.
      room.status = 'discussion';
      room.turnEndsAt = null;
      broadcastRoom(room);
      return;
    }
  }
  scheduleTurnTimer(room);
  broadcastRoom(room);
}

function scheduleGuessTimer(room) {
  clearRoomTimer(room);
  room.turnEndsAt = Date.now() + room.guessSeconds * 1000;
  room._timerHandle = setTimeout(() => {
    finalizeRound(room, false);
  }, room.guessSeconds * 1000);
}

function computeVoteResult(room) {
  const tally = {};
  Object.values(room.votes).forEach(id => { tally[id] = (tally[id] || 0) + 1; });
  let max = 0;
  Object.values(tally).forEach(v => { if (v > max) max = v; });
  const accused = max > 0 ? Object.keys(tally).filter(id => tally[id] === max) : [];
  room.tally = tally;
  room.accusedIds = accused;
  room.turnEndsAt = null;

  if (accused.length === 1 && room.imposterIds.includes(accused[0])) {
    room.caught = true;
    if (room.guessEnabled) {
      room.activeGuesserId = accused[0];
      room.status = 'imposter-guess';
      scheduleGuessTimer(room);
      broadcastRoom(room);
    } else {
      // Host has disabled the last-chance guess — being caught ends the
      // round immediately, same scoring as a caught-and-guessed-wrong outcome.
      finalizeRound(room, false);
    }
  } else {
    room.caught = false;
    finalizeRound(room, null);
  }
}

function finalizeRound(room, guessedCorrectly) {
  clearRoomTimer(room);
  room.guessResult = guessedCorrectly;
  room.turnEndsAt = null;
  room.players.forEach(p => {
    const isImposter = room.imposterIds.includes(p.id);
    if (room.caught && guessedCorrectly === true && isImposter) {
      room.scores[p.id] = (room.scores[p.id] || 0) + 2;
    } else if (room.caught && guessedCorrectly === false && !isImposter) {
      room.scores[p.id] = (room.scores[p.id] || 0) + 1;
    } else if (!room.caught && isImposter) {
      room.scores[p.id] = (room.scores[p.id] || 0) + 2;
    }
  });
  room.status = 'reveal';
  broadcastRoom(room);
}

// Strips a departing player out of whatever round-in-progress bookkeeping
// might reference them (turn order, clue log, votes, imposter list) so the
// round can carry on sanely after a mid-game kick instead of crashing or
// getting stuck waiting on someone who is gone.
function purgePlayerFromRound(room, playerId) {
  const turnIdx = room.turnOrder.indexOf(playerId);
  if (turnIdx !== -1) {
    room.turnOrder.splice(turnIdx, 1);
    if (turnIdx < room.currentTurnIndex) room.currentTurnIndex--;
    if (room.turnOrder.length === 0) room.currentTurnIndex = 0;
    else if (room.currentTurnIndex >= room.turnOrder.length) room.currentTurnIndex = 0;
  }
  delete room.clueLog[playerId];
  delete room.votes[playerId];
  Object.keys(room.votes).forEach(voterId => {
    if (room.votes[voterId] === playerId) delete room.votes[voterId];
  });
  room.imposterIds = room.imposterIds.filter(id => id !== playerId);
  room.accusedIds = (room.accusedIds || []).filter(id => id !== playerId);
}

function allCategoriesForRoom(room) {
  return Array.from(new Set([...CATEGORY_NAMES, ...room.customWords.flatMap(w => w.tags)])).sort();
}

// Resets all per-round fields and sends the room back to the lobby /
// category-select screen. Shared by the normal "start next round" flow
// (from reveal) and the host's "end case early" abort (from any phase).
function resetToLobby(room) {
  clearRoomTimer(room);
  room.status = 'lobby';
  room.secretWord = null;
  room.secretAliases = [];
  room.imposterHint = null;
  room.imposterIds = [];
  room.turnOrder = [];
  room.currentTurnIndex = 0;
  room.clueRound = 1;
  room.clueLog = {};
  room.turnEndsAt = null;
  room.votes = {};
  room.accusedIds = [];
  room.caught = null;
  room.activeGuesserId = null;
  room.guessResult = null;
}


function addOneCustomWord(room, word, tag) {
  const cleanWord = (word || '').trim().slice(0, 40);
  if (!cleanWord) return false;
  if (room.customWords.length >= 50) return false;
  const cleanTag = (tag || '').trim().slice(0, 24) || 'Custom';
  room.customWords.push({ id: crypto.randomUUID(), word: cleanWord, tags: [cleanTag] });
  return true;
}

function getRoom(code) {
  return rooms.get((code || '').toUpperCase());
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.playerId = null;

  socket.on('create-room', ({ name }) => {
    const cleanName = (name || '').trim().slice(0, 18);
    if (!cleanName) return socket.emit('join-error', { message: 'Enter your name first.' });
    const code = uniqueCode();
    const playerId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const room = newRoom(code, playerId, cleanName, token);
    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    socket.emit('created', { code, playerId, token });
    broadcastRoom(room);
  });

  socket.on('join-room', ({ code, name }) => {
    const cleanName = (name || '').trim().slice(0, 18);
    const room = getRoom(code);
    if (!cleanName) return socket.emit('join-error', { message: 'Enter your name first.' });
    if (!room) return socket.emit('join-error', { message: 'No case found with that code.' });
    if (room.status !== 'lobby') return socket.emit('join-error', { message: 'That case is already in progress. Ask the host to wait for the next round.' });

    const playerId = crypto.randomUUID();
    const token = crypto.randomUUID();
    room.players.push({ id: playerId, name: cleanName, connected: true, token });
    room.scores[playerId] = 0;

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;

    socket.emit('joined', { code: room.code, playerId, token });
    broadcastRoom(room);
  });

  socket.on('reconnect-room', ({ code, playerId, token }) => {
    const room = getRoom(code);
    if (!room) return socket.emit('reconnect-error', { message: 'That case no longer exists.' });
    const player = room.players.find(p => p.id === playerId);
    if (!player || !token || player.token !== token) {
      return socket.emit('reconnect-error', { message: 'Could not reconnect you to that case.' });
    }

    // If a stale connection under this playerId is still lingering (e.g. an
    // old tab), boot it out of the room so it can't act as this player anymore.
    const staleSocketId = findSocketId(playerId);
    if (staleSocketId && staleSocketId !== socket.id) {
      const staleSocket = io.sockets.sockets.get(staleSocketId);
      if (staleSocket) {
        staleSocket.leave(room.code);
        staleSocket.data.roomCode = null;
        staleSocket.data.playerId = null;
      }
    }

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    player.connected = true;

    // They made it back — cancel any pending handover of host duties.
    if (room.hostId === playerId && room._hostGraceTimer) {
      clearTimeout(room._hostGraceTimer);
      room._hostGraceTimer = null;
    }

    socket.emit('reconnected', { code: room.code, playerId, token });
    sendRoleTo(room, playerId, socket);
    broadcastRoom(room);
  });

  socket.on('add-custom-word', ({ word, tag }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.status !== 'lobby') return;
    if (addOneCustomWord(room, word, tag)) broadcastRoom(room);
  });

  socket.on('add-custom-words-bulk', ({ entries }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.status !== 'lobby') return;
    if (!Array.isArray(entries)) return;
    let addedAny = false;
    entries.slice(0, 50).forEach(entry => {
      if (addOneCustomWord(room, entry && entry.word, entry && entry.tag)) addedAny = true;
    });
    if (addedAny) broadcastRoom(room);
  });

  socket.on('remove-custom-word', ({ id }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.status !== 'lobby') return;
    room.customWords = room.customWords.filter(w => w.id !== id);
    // Drop any now-unused custom tags from the host's active category selection.
    const valid = allCategoriesForRoom(room);
    room.categories = room.categories.filter(c => valid.includes(c));
    room.excludedCategories = room.excludedCategories.filter(c => valid.includes(c));
    broadcastRoom(room);
  });

  socket.on('kick-player', ({ playerId }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    if (!playerId || playerId === room.hostId) return; // host can't kick themselves
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    // Boot their live connection (if any) out of the room and let them know.
    const kickedSocketId = findSocketId(playerId);
    if (kickedSocketId) {
      const kickedSocket = io.sockets.sockets.get(kickedSocketId);
      if (kickedSocket) {
        kickedSocket.emit('kicked');
        kickedSocket.leave(room.code);
        kickedSocket.data.roomCode = null;
        kickedSocket.data.playerId = null;
      }
    }

    room.players = room.players.filter(p => p.id !== playerId);
    delete room.scores[playerId];
    purgePlayerFromRound(room, playerId);

    if (room.status === 'clues') {
      if (room.turnOrder.length === 0) {
        room.status = 'discussion';
        clearRoomTimer(room);
        room.turnEndsAt = null;
      } else {
        scheduleTurnTimer(room); // reschedule for whoever the turn now lands on
      }
    } else if (room.status === 'voting') {
      const connectedCount = room.players.filter(p => p.connected).length;
      if (connectedCount > 0 && Object.keys(room.votes).length >= connectedCount) {
        computeVoteResult(room);
        return; // computeVoteResult already broadcasts
      }
    } else if (room.status === 'imposter-guess' && room.activeGuesserId === playerId) {
      finalizeRound(room, false); // the accused imposter is gone — treat as a wrong guess
      return; // finalizeRound already broadcasts
    }

    broadcastRoom(room);
  });

  socket.on('update-settings', ({ categories, excludedCategories, imposterCount, clueSeconds, guessSeconds, guessEnabled }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.status !== 'lobby') return;
    if (Array.isArray(categories)) {
      const valid = allCategoriesForRoom(room);
      room.categories = Array.from(new Set(categories.filter(c => valid.includes(c))));
    }
    if (Array.isArray(excludedCategories)) {
      const valid = allCategoriesForRoom(room);
      room.excludedCategories = Array.from(new Set(excludedCategories.filter(c => valid.includes(c))));
    }
    if (imposterCount) room.imposterCount = Math.max(1, Math.min(2, parseInt(imposterCount, 10) || 1));
    if (clueSeconds) room.clueSeconds = Math.max(5, Math.min(180, parseInt(clueSeconds, 10) || 30));
    if (guessSeconds) room.guessSeconds = Math.max(5, Math.min(180, parseInt(guessSeconds, 10) || 20));
    if (typeof guessEnabled === 'boolean') room.guessEnabled = guessEnabled;
    broadcastRoom(room);
  });

  socket.on('start-round', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.status !== 'lobby') return;
    if (room.players.length < 3) return;

    const fullBank = WORD_BANK.concat(room.customWords);
    const eligible = fullBank.filter(w => {
      const included = room.categories.length === 0 || w.tags.some(t => room.categories.includes(t));
      const excluded = room.excludedCategories.length > 0 && w.tags.some(t => room.excludedCategories.includes(t));
      return included && !excluded;
    });
    if (eligible.length === 0) return; // nothing matches the chosen categories — host needs to adjust selection

    // Bucket eligible words by category so every category has an equal
    // chance of being picked for the round, regardless of how many words it
    // contains — otherwise a category with 50 words would come up far more
    // often than one with 5. A word with multiple matching tags can land in
    // more than one bucket, which is fine: it's still only counted once per
    // category it's picked under.
    const buckets = {};
    eligible.forEach(w => {
      w.tags.forEach(tag => {
        if (room.categories.length > 0 && !room.categories.includes(tag)) return;
        if (room.excludedCategories.includes(tag)) return;
        (buckets[tag] || (buckets[tag] = [])).push(w);
      });
    });
    const bucketCats = Object.keys(buckets);
    const chosenCategory = bucketCats.length
      ? bucketCats[Math.floor(Math.random() * bucketCats.length)]
      : null;
    const pool = chosenCategory ? buckets[chosenCategory] : eligible;
    const secretEntry = pool[Math.floor(Math.random() * pool.length)];
    const secret = secretEntry.word;
    // The imposter no longer gets a decoy word — they see the category itself:
    // the same category the word was just picked under, so it's guaranteed to
    // be a tag that matched the host's selection.
    const matchingTags = chosenCategory
      ? [chosenCategory]
      : (room.categories.length === 0
          ? secretEntry.tags
          : secretEntry.tags.filter(t => room.categories.includes(t))
        ).filter(t => !room.excludedCategories.includes(t));
    const hintPool = matchingTags.length > 0 ? matchingTags : secretEntry.tags;
    const imposterHint = hintPool[Math.floor(Math.random() * hintPool.length)];
    const ids = room.players.map(p => p.id);
    const impCount = Math.min(room.imposterCount, Math.max(1, ids.length - 1));
    const shuffled = shuffle(ids);


    room.secretWord = secret;
    room.secretAliases = secretEntry.aliases || [];
    room.imposterHint = imposterHint;
    room.imposterIds = shuffled.slice(0, impCount);
    room.turnOrder = shuffle(ids);
    room.currentTurnIndex = 0;
    room.clueRound = 1;
    room.clueLog = {};
    ids.forEach(id => { room.clueLog[id] = [null, null, null]; });
    room.votes = {};
    room.accusedIds = [];
    room.caught = null;
    room.activeGuesserId = null;
    room.guessResult = null;
    room.roundNumber++;
    room.status = 'briefing';

    broadcastRoom(room);

    room.players.forEach(p => {
      const isImposter = room.imposterIds.includes(p.id);
      io.to(findSocketId(p.id)).emit('your-role', {
        isImposter,
        word: isImposter ? imposterHint : secret
      });
    });
  });

  socket.on('start-clues', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.status !== 'briefing') return;
    room.status = 'clues';
    scheduleTurnTimer(room);
    broadcastRoom(room);
  });

  socket.on('open-voting', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.status !== 'discussion') return;
    room.status = 'voting';
    room.votes = {};
    broadcastRoom(room);
  });

  socket.on('submit-clue', ({ text }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'clues') return;
    const currentPlayerId = room.turnOrder[room.currentTurnIndex];
    if (socket.data.playerId !== currentPlayerId) return;
    const clean = (text || '').trim().slice(0, 60);
    if (!clean) return;
    recordClue(room, currentPlayerId, clean);
    moveToNextTurn(room);
  });

  socket.on('cast-vote', ({ suspectId }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'voting') return;
    if (!room.players.find(p => p.id === suspectId)) return;
    if (suspectId === socket.data.playerId) return;
    room.votes[socket.data.playerId] = suspectId;
    const connectedCount = room.players.filter(p => p.connected).length;
    if (Object.keys(room.votes).length >= connectedCount) {
      computeVoteResult(room);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on('force-reveal-vote', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.status !== 'voting') return;
    computeVoteResult(room);
  });

  socket.on('submit-imposter-guess', ({ guess }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.status !== 'imposter-guess') return;
    if (socket.data.playerId !== room.activeGuesserId) return;
    // Punctuation is irrelevant when checking the imposter's guess — strip
    // anything that isn't a letter/number/space so "Jack the Ripper" matches
    // "Jack, the Ripper!" or "St. Patrick's Day" matches "St Patricks Day".
    const normalize = (s) => (s || '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    const acceptable = [room.secretWord, ...(room.secretAliases || [])].map(normalize);
    const correct = acceptable.includes(normalize(guess));
    finalizeRound(room, correct);
  });

  socket.on('next-round', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    resetToLobby(room);
    broadcastRoom(room);
  });

  // Lets the host bail out of an in-progress case at any point (briefing,
  // clues, discussion, voting, or the imposter's last-chance guess) and send
  // everyone straight back to the lobby / category-select screen, instead of
  // having to play the round out to completion.
  socket.on('end-round', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId || room.status === 'lobby') return;
    resetToLobby(room);
    broadcastRoom(room);
  });

  socket.on('send-chat', ({ text }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player) return;
    const clean = (text || '').trim().slice(0, 300);
    if (!clean) return;
    room.chat.push({ id: crypto.randomUUID(), playerId: player.id, name: player.name, text: clean, ts: Date.now() });
    if (room.chat.length > 200) room.chat = room.chat.slice(-200);
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (player) player.connected = false;
    broadcastRoom(room);
    if (player && room.hostId === player.id) {
      scheduleHostMigration(room, player.id);
    }
  });
});

// Helper: find the currently-connected socket id for a given playerId.
// (Needed because Socket.IO doesn't index sockets by our own player ids.)
function findSocketId(playerId) {
  for (const [id, s] of io.of('/').sockets) {
    if (s.data.playerId === playerId) return id;
  }
  return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Imposter server running at http://localhost:${PORT}`);
});
