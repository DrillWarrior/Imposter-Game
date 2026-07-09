(function () {
  const socket = io();

  // Categories tied to a specific fandom/franchise get grouped under
  // "Fandom / Niche" in the picker; everything else falls under "General".
  // New tags added to the word bank default to General unless listed here.
  const NICHE_CATEGORIES = new Set([
    'League of Legends', 'One Piece', 'Demon Slayer', 'Anime',
    'Jujutsu Kaisen', 'Attack on Titan', 'Harry Potter', 'Valorant',
    'Marvel & DC'
  ]);

  // ---------- SESSION PERSISTENCE (for reconnecting after a reload/drop) ----------
  const SESSION_KEY = 'imposter_session';
  function saveSession(session) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* storage unavailable — reconnect just won't persist */ }
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  let state = {
    screen: 'landing',   // landing | joinForm | room | reconnecting
    name: '',
    codeInput: '',
    myId: '',
    code: '',
    room: null,          // latest sanitized room-state from server
    myRole: null,        // {isImposter, word, category} — private, current round only
    error: '',
    busy: false,
    chatOpen: false,
    local: {
      revealed: false,
      typedWord: '',
      clueDraft: '',
      voted: false,
      voteSelection: null,
      guessDraft: '',
      chatDraft: '',
      customWordDraft: '',
      customTagDraft: '',
      bulkOpen: false,
      bulkDraft: '',
      catPanelOpen: false,
      catFilter: '',
      rosterOpen: false
    },
    focusedField: null
  };

  // If we have a saved session from before a reload/disconnect, show a
  // "reconnecting" screen immediately instead of flashing the landing page.
  const savedSession = loadSession();
  if (savedSession && savedSession.code && savedSession.playerId && savedSession.token) {
    state.screen = 'reconnecting';
    state.name = savedSession.name || '';
  }

  let typeTimer = null;

  function esc(s) {
    const d = document.createElement('div');
    d.innerText = s == null ? '' : s;
    return d.innerHTML;
  }
  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function getPlayerName(id) {
    const p = (state.room && state.room.players || []).find(p => p.id === id);
    return p ? p.name : 'Unknown';
  }
  // The specific category the imposter was briefed on this round (as opposed
  // to categoryLabel(), which shows the host's overall category *settings*).
  // Server only sends this once clue-giving has started, so it doubles as
  // "is it time to show this yet" — everyone sees it from then on.
  function renderCategoryHint(room) {
    if (!room.imposterHint) return '';
    return `<div class="muted center" style="margin-bottom:8px;">This round's category: <strong>${esc(room.imposterHint)}</strong></div>`;
  }
  function categoryLabel(room) {
    const base = (!room.categories || room.categories.length === 0) ? 'All Categories' : room.categories.join(', ');
    const excluded = room.excludedCategories || [];
    if (excluded.length === 0) return base;
    return `${base} (excluding ${excluded.join(', ')})`;
  }
  // Single searchable/collapsible tri-state picker covering both include and
  // exclude in one control. Each category row cycles default -> include
  // (green check) -> exclude (red x) -> default on click/tap.
  function catState(cat, included, excluded) {
    if (included.includes(cat)) return 'include';
    if (excluded.includes(cat)) return 'exclude';
    return 'default';
  }
  function renderCatRow(idPrefix, c, included, excluded) {
    const st = catState(c, included, excluded);
    const icon = st === 'include' ? '&check;' : st === 'exclude' ? '&times;' : '';
    return `
      <div class="cat-check tri-row tri-${idPrefix}" data-cat="${esc(c)}">
        <span class="tri-box tri-${st}">${icon}</span>
        <span>${esc(c)}</span>
      </div>`;
  }
  function renderCatPicker(idPrefix, allCats, included, excluded, filterVal, panelOpen) {
    const filterText = (filterVal || '').trim().toLowerCase();
    const filteredCats = filterText ? allCats.filter(c => c.toLowerCase().includes(filterText)) : allCats;
    const generalCats = filteredCats.filter(c => !NICHE_CATEGORIES.has(c));
    const nicheCats = filteredCats.filter(c => NICHE_CATEGORIES.has(c));
    const rows = filteredCats.length
      ? `
        ${generalCats.length ? `
          <div class="cat-group-header">General</div>
          ${generalCats.map(c => renderCatRow(idPrefix, c, included, excluded)).join('')}
        ` : ''}
        ${nicheCats.length ? `
          <div class="cat-group-header">Fandom / Niche</div>
          ${nicheCats.map(c => renderCatRow(idPrefix, c, included, excluded)).join('')}
        ` : ''}`
      : `<div class="muted center" style="padding:10px 0;">No categories match "${esc(filterVal)}"</div>`;

    let summary;
    if (included.length === 0 && excluded.length === 0) {
      summary = 'All Categories';
    } else {
      const parts = [];
      if (included.length) parts.push(`${included.length} included`);
      if (excluded.length) parts.push(`${excluded.length} excluded`);
      summary = parts.join(' &middot; ');
    }

    if (panelOpen) {
      return `
        <div class="cat-panel">
          <input type="text" id="${idPrefix}FilterInput" placeholder="Search categories&hellip;" value="${esc(filterVal)}"/>
          <div class="tri-legend">
            <span><span class="tri-box tri-include">&check;</span>include</span>
            <span><span class="tri-box tri-exclude">&times;</span>exclude</span>
            <span><span class="tri-box tri-default"></span>default</span>
          </div>
          <div class="cat-panel-actions">
            <button type="button" class="link-btn" id="${idPrefix}ResetBtn">Reset All</button>
            <button type="button" class="link-btn" id="${idPrefix}DoneBtn" style="margin-left:auto;">Done &check;</button>
          </div>
          <div class="cat-check-grid cat-check-scroll" id="${idPrefix}ScrollBox">${rows}</div>
        </div>`;
    }
    return `
      <button type="button" class="cat-summary-btn" id="${idPrefix}OpenBtn">
        <span class="cat-summary-text">${esc(summary)}</span>
        <span class="cat-summary-edit">Edit &rsaquo;</span>
      </button>`;
  }
  function renderMyWordCard() {
    if (!state.myRole) return '';
    if (!state.local.revealed) {
      return `<div class="mini-word-card neutral" id="miniSeal">
        <span class="mini-stamp" style="background:var(--gold);color:var(--text-dark);">Hidden</span>
        <span class="mini-word" style="font-family:var(--font-mono);font-size:12px;letter-spacing:1px;">Tap to reveal your word</span>
      </div>`;
    }
    const isImposter = state.myRole.isImposter;
    return `<div class="mini-word-card ${isImposter ? 'compromised' : 'cleared'}">
      <span class="mini-stamp">${isImposter ? 'Compromised' : 'Cleared'}</span>
      <span class="mini-word">${esc(state.myRole.word)}</span>
    </div>`;
  }
  // Compact player roster shown during active phases (post-lobby). Lets the
  // host kick someone mid-game, same as the lobby's player list, without
  // taking up as much space — collapsed by default, toggled open on tap.
  function renderRoster(room, isHost) {
    const rows = room.players.map(p => `
      <div class="player-row">
        <span class="player-dot ${p.connected ? '' : 'offline'}"></span>${esc(p.name)}
        ${p.id === room.hostId
          ? '<span class="player-host-tag">Host</span>'
          : (isHost ? `<button class="kick-btn" data-kick="${p.id}" data-kick-name="${esc(p.name)}" title="Remove ${esc(p.name)}">&times;</button>` : '')}
      </div>`).join('');

    return `
      <div class="card roster-card">
        <button class="roster-toggle" id="rosterToggleBtn">
          Agents (${room.players.length}) ${state.local.rosterOpen ? '&#9650;' : '&#9660;'}
        </button>
        ${state.local.rosterOpen ? rows : ''}
      </div>`;
  }

  // Host-only escape hatch: abort the in-progress case at any point and
  // send everyone back to the lobby / category-select screen.
  function renderEndCaseBtn(isHost) {
    if (!isHost) return '';
    return `<button class="link-btn link-btn-danger" id="endRoundBtn">End case &amp; return to lobby</button>`;
  }

  // Status blurb for anyone watching a round they're not part of (a
  // spectator who joined mid-case). Nothing to report before votes are in;
  // once they are, say whether the imposter got caught, and once the round
  // is fully resolved, give the full verdict same as the reveal screen.
  function renderSpectatorStatus(room) {
    if (room.status === 'imposter-guess') {
      return `<div class="muted center">Imposter caught! ${esc(getPlayerName(room.activeGuesserId))} is guessing the real word…</div>`;
    }
    if (room.status === 'reveal') {
      let verdictText;
      if (room.caught && room.guessResult === true) verdictText = 'Imposter was caught — but guessed the word and steals the round!';
      else if (room.caught && !room.guessEnabled) verdictText = 'Imposter was caught red-handed. Crew wins the round.';
      else if (room.caught && room.guessResult === false) verdictText = 'Imposter was caught, and guessed wrong. Crew wins the round.';
      else if (!room.caught) verdictText = 'The imposter blended in and escaped with the round.';
      else verdictText = '';
      return `<div class="muted center">${esc(verdictText)}</div>`;
    }
    return '';
  }

  // Picks a font size for a clue so it fits inside the fixed-size cell box
  // instead of the cell growing to fit the text — longer clues shrink down
  // through these tiers rather than expanding the table layout. With the
  // round columns now fixed at 3 regardless of player count, this only
  // needs to react to the clue's own length, not the player count.
  function clueFontSize(text) {
    const len = (text || '').length;
    if (len <= 10) return 12;
    if (len <= 18) return 11;
    if (len <= 28) return 10;
    if (len <= 40) return 9;
    if (len <= 55) return 8.5;
    return 8;
  }
  // One row per player, one column per round. Rounds are always capped at
  // 3, so column width (and therefore clue text size) stays constant no
  // matter how many players are in the game — only the table grows
  // taller, which is cheap, instead of columns getting squeezed and text
  // shrinking further with every player added.
  function renderClueTable(room) {
    const currentId = room.turnOrder[room.currentTurnIndex];
    const players = room.turnOrder;
    const colGroup = `<colgroup><col style="width:30%;"/><col style="width:23.33%;"/><col style="width:23.33%;"/><col style="width:23.34%;"/></colgroup>`;
    const headerCells = `<th></th><th class="clue-round-head">R1</th><th class="clue-round-head">R2</th><th class="clue-round-head">R3</th>`;
    const bodyRows = players.map(id => {
      const isCurrentPlayer = room.status === 'clues' && id === currentId;
      const nameCell = `<td class="clue-player-cell ${isCurrentPlayer ? 'active-col' : ''}"><div class="clue-cell-box clue-header-box"><span class="clue-cell-text">${esc(getPlayerName(id))}</span></div></td>`;
      const roundCells = [0, 1, 2].map(r => {
        const val = (room.clueLog[id] || [])[r];
        const isActiveCell = isCurrentPlayer && r === room.clueRound - 1;
        if (val === null || val === undefined) {
          return `<td class="${isActiveCell ? 'active-cell' : 'empty'}"><div class="clue-cell-box"><span class="clue-cell-text">${isActiveCell ? '…' : '—'}</span></div></td>`;
        }
        return `<td><div class="clue-cell-box"><span class="clue-cell-text" style="font-size:${clueFontSize(val)}px;">${esc(val)}</span></div></td>`;
      }).join('');
      return `<tr>${nameCell}${roundCells}</tr>`;
    }).join('');
    return `
      <table class="clue-table">
        ${colGroup}
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    `;
  }

  // ---------- SOCKET EVENTS ----------
  socket.on('connect', () => {
    // Fires on the very first connect AND on any automatic reconnect after a
    // network drop — in both cases, if we have a saved session, try to
    // resume it as the same player rather than showing a fresh landing page.
    const saved = loadSession();
    if (saved && saved.code && saved.playerId && saved.token) {
      socket.emit('reconnect-room', saved);
    }
  });
  socket.on('created', ({ code, playerId, token }) => {
    state.myId = playerId; state.code = code; state.screen = 'room';
    state.error = ''; state.busy = false;
    saveSession({ code, playerId, token, name: state.name });
    render(); renderChat();
  });
  socket.on('joined', ({ code, playerId, token }) => {
    state.myId = playerId; state.code = code; state.screen = 'room';
    state.error = ''; state.busy = false;
    saveSession({ code, playerId, token, name: state.name });
    render(); renderChat();
  });
  socket.on('reconnected', ({ code, playerId, token }) => {
    state.myId = playerId; state.code = code; state.screen = 'room';
    state.error = ''; state.busy = false;
    saveSession({ code, playerId, token, name: state.name });
    render(); renderChat();
  });
  socket.on('reconnect-error', ({ message }) => {
    clearSession();
    state.screen = 'landing'; state.error = message; state.busy = false;
    render(); renderChat();
  });
  socket.on('join-error', ({ message }) => {
    state.busy = false; state.error = message; render();
  });
  socket.on('kicked', () => {
    clearSession();
    state = {
      screen: 'landing', name: state.name, codeInput: '', myId: '', code: '',
      room: null, myRole: null, error: 'The host removed you from the case.',
      busy: false, chatOpen: false,
      local: {
        revealed: false, typedWord: '', clueDraft: '', voted: false, voteSelection: null,
        guessDraft: '', chatDraft: '', customWordDraft: '', customTagDraft: '',
        bulkOpen: false, bulkDraft: '', catPanelOpen: false, catFilter: '', rosterOpen: false
      },
      focusedField: null
    };
    render(); renderChat();
  });
  socket.on('your-role', (role) => {
    state.myRole = role;
    state.local.revealed = !!role.autoReveal;
    state.local.typedWord = role.autoReveal ? role.word : '';
    render();
  });
  socket.on('room-state', (room) => {
    const prevStatus = state.room ? state.room.status : null;
    state.room = room;
    if (room.status !== prevStatus) {
      if (room.status === 'clues') state.local.clueDraft = '';
      if (room.status === 'voting') { state.local.voted = false; state.local.voteSelection = null; }
      if (room.status === 'imposter-guess') state.local.guessDraft = '';
      if (room.status === 'lobby') { state.myRole = null; }
    }
    render(); renderChat();
  });

  // ---------- ACTIONS ----------
  window.__imp_createRoom = function () {
    if (!state.name.trim()) { state.error = 'Enter your name first.'; render(); return; }
    state.busy = true; state.error = ''; render();
    socket.emit('create-room', { name: state.name.trim() });
  };
  window.__imp_joinRoom = function () {
    if (!state.name.trim()) { state.error = 'Enter your name first.'; render(); return; }
    if (state.codeInput.trim().length !== 4) { state.error = 'Enter the 4-character case code.'; render(); return; }
    state.busy = true; state.error = ''; render();
    socket.emit('join-room', { code: state.codeInput.trim().toUpperCase(), name: state.name.trim() });
  };
  window.__imp_goJoinForm = function () { state.error = ''; state.screen = 'joinForm'; render(); };
  window.__imp_backLanding = function () { state.error = ''; state.screen = 'landing'; render(); };
  window.__imp_updateSettings = function (patch) { socket.emit('update-settings', patch); };
  window.__imp_addCustomWord = function () {
    const word = state.local.customWordDraft.trim();
    if (!word) return;
    socket.emit('add-custom-word', { word, tag: state.local.customTagDraft.trim() });
    state.local.customWordDraft = '';
    state.local.customTagDraft = '';
  };
  window.__imp_removeCustomWord = function (id) { socket.emit('remove-custom-word', { id }); };
  window.__imp_kickPlayer = function (playerId, name) {
    if (!confirm(`Remove ${name} from the case?`)) return;
    socket.emit('kick-player', { playerId });
  };
  window.__imp_toggleBulk = function () { state.local.bulkOpen = !state.local.bulkOpen; render(); };
  window.__imp_toggleRoster = function () { state.local.rosterOpen = !state.local.rosterOpen; render(); };
  window.__imp_addBulkWords = function () {
    const lines = state.local.bulkDraft.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const entries = lines.map(line => {
      const idx = line.indexOf(':');
      if (idx === -1) return { word: line, tag: '' };
      return { word: line.slice(0, idx).trim(), tag: line.slice(idx + 1).trim() };
    }).filter(e => e.word);
    if (!entries.length) return;
    socket.emit('add-custom-words-bulk', { entries });
    state.local.bulkDraft = '';
    render();
  };
  window.__imp_startRound = function () { socket.emit('start-round'); };
  window.__imp_startClues = function () { socket.emit('start-clues'); };
  window.__imp_openVoting = function () { socket.emit('open-voting'); };
  window.__imp_revealCard = function () {
    state.local.revealed = true;
    render();
    if (!state.myRole) return;
    const word = state.myRole.word;
    let i = 0;
    if (typeTimer) clearInterval(typeTimer);
    typeTimer = setInterval(() => {
      i++;
      state.local.typedWord = word.slice(0, i);
      updateTypedWordDisplay();
      if (i >= word.length) clearInterval(typeTimer);
    }, 65);
  };
  window.__imp_submitClue = function () {
    const text = state.local.clueDraft.trim();
    if (!text) return;
    socket.emit('submit-clue', { text });
    state.local.clueDraft = '';
  };
  window.__imp_castVote = function (suspectId) {
    state.local.voted = true;
    state.local.voteSelection = suspectId;
    render();
    socket.emit('cast-vote', { suspectId });
  };
  window.__imp_forceReveal = function () { socket.emit('force-reveal-vote'); };
  window.__imp_submitGuess = function () {
    const guess = state.local.guessDraft.trim();
    if (!guess) return;
    socket.emit('submit-imposter-guess', { guess });
    state.local.guessDraft = '';
  };
  window.__imp_nextRound = function () { socket.emit('next-round'); };
  window.__imp_endRound = function () {
    if (!confirm('End this case and send everyone back to the lobby?')) return;
    socket.emit('end-round');
  };
  window.__imp_leaveCase = function () { clearSession(); location.reload(); };
  window.__imp_sendChat = function () {
    const text = state.local.chatDraft.trim();
    if (!text) return;
    socket.emit('send-chat', { text });
    state.local.chatDraft = '';
    const input = document.getElementById('chatInput');
    if (input) input.value = '';
  };
  window.__imp_toggleChat = function () {
    state.chatOpen = !state.chatOpen;
    document.getElementById('chat-col').classList.toggle('open', state.chatOpen);
  };

  // ---------- TIMER TICK (partial DOM update, no full re-render) ----------
  function tickTimer() {
    const room = state.room;
    const el = document.getElementById('timerDisplay');
    if (!el || !room || !room.turnEndsAt) return;
    const remain = Math.max(0, Math.ceil((room.turnEndsAt - Date.now()) / 1000));
    el.textContent = formatTime(remain);
    el.classList.toggle('low', remain <= 5);
  }
  setInterval(tickTimer, 300);

  function updateTypedWordDisplay() {
    const el = document.getElementById('typedWordDisplay');
    if (el) el.innerHTML = esc(state.local.typedWord) + '<span class="cursor">_</span>';
  }

  // ---------- FOCUS PRESERVATION ----------
  function restoreFocus() {
    if (!state.focusedField) return;
    const el = document.getElementById(state.focusedField);
    if (el) {
      el.focus();
      const v = el.value || '';
      if (el.setSelectionRange) el.setSelectionRange(v.length, v.length);
    }
  }
  function trackFocus(el) {
    if (!el) return;
    el.onfocus = () => { state.focusedField = el.id; };
    el.onblur = () => { if (state.focusedField === el.id) state.focusedField = null; };
  }
  // Wires up the single tri-state category picker's rows/search/open/done/
  // reset controls. idPrefix matches the prefix used in renderCatPicker.
  // Each row click cycles that one category: default -> include -> exclude
  // -> default, writing both "categories" and "excludedCategories" via
  // update-settings so the two stay mutually exclusive.
  function bindCatPicker(byId, idPrefix, filterKey, panelKey) {
    document.querySelectorAll('.tri-' + idPrefix).forEach(row => {
      row.onclick = () => {
        const cat = row.getAttribute('data-cat');
        const included = (state.room && state.room.categories) || [];
        const excluded = (state.room && state.room.excludedCategories) || [];
        const st = catState(cat, included, excluded);
        let newIncluded = included.slice();
        let newExcluded = excluded.slice();
        if (st === 'default') {
          newIncluded.push(cat);
        } else if (st === 'include') {
          newIncluded = newIncluded.filter(c => c !== cat);
          newExcluded.push(cat);
        } else {
          newExcluded = newExcluded.filter(c => c !== cat);
        }
        window.__imp_updateSettings({ categories: newIncluded, excludedCategories: newExcluded });
      };
    });
    if (byId(idPrefix + 'FilterInput')) {
      trackFocus(byId(idPrefix + 'FilterInput'));
      byId(idPrefix + 'FilterInput').oninput = (e) => { state.local[filterKey] = e.target.value; render(); };
    }
    if (byId(idPrefix + 'OpenBtn')) byId(idPrefix + 'OpenBtn').onclick = () => { state.local[panelKey] = true; render(); };
    if (byId(idPrefix + 'DoneBtn')) byId(idPrefix + 'DoneBtn').onclick = () => { state.local[panelKey] = false; state.local[filterKey] = ''; render(); };
    if (byId(idPrefix + 'ResetBtn')) byId(idPrefix + 'ResetBtn').onclick = () => {
      window.__imp_updateSettings({ categories: [], excludedCategories: [] });
    };
  }

  // ---------- SCROLL PRESERVATION ----------
  // A full re-render (render()) replaces game-col's innerHTML wholesale,
  // which would otherwise reset the category picker's internal scroll back
  // to the top and can shift the page scroll too. We snapshot both right
  // before the DOM is rebuilt and restore them right after.
  function captureScroll() {
    const catBox = document.getElementById('catScrollBox');
    return {
      winY: window.scrollY,
      catScrollTop: catBox ? catBox.scrollTop : null,
    };
  }
  function restoreScroll(snapshot) {
    if (snapshot.catScrollTop !== null) {
      const catBox = document.getElementById('catScrollBox');
      if (catBox) catBox.scrollTop = snapshot.catScrollTop;
    }
    window.scrollTo(0, snapshot.winY);
  }

  // ---------- RENDER: MAIN GAME COLUMN ----------
  function render() {
    const root = document.getElementById('game-col');
    const scrollSnapshot = captureScroll();
    root.innerHTML = renderScreen();
    bindEvents();
    restoreFocus();
    restoreScroll(scrollSnapshot);
    tickTimer();
  }

  function renderScreen() {
    const header = `
      <div class="eyebrow">Classified &middot; Party Deduction</div>
      <div class="masthead">IMPOST<span>ER</span></div>
      <div class="subhead">Case File Edition</div>
    `;

    if (state.screen === 'reconnecting') {
      return `<div>${header}
        <div class="card center">
          <div class="muted center">Reconnecting you to your case…</div>
        </div>
      </div>`;
    }

    if (state.screen === 'landing') {
      return `<div>${header}
        <div class="card">
          <div class="card-title">Open a Case</div>
          <label class="field-label">Your Name</label>
          <input type="text" id="nameInput" placeholder="Agent name" value="${esc(state.name)}" maxlength="18"/>
          ${state.error ? `<div class="error-box">${esc(state.error)}</div>` : ''}
          <button class="btn btn-red" id="goCreate" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Opening…' : 'Create Case'}</button>
          <button class="btn btn-outline" id="goJoin">Join Case</button>
        </div>
        <div class="footer-note">3&ndash;10 agents &middot; hidden word game &middot; decoy variant</div>
      </div>`;
    }

    if (state.screen === 'joinForm') {
      return `<div>${header}
        <div class="card">
          <div class="card-title">Join Case</div>
          <label class="field-label">Your Name</label>
          <input type="text" id="nameInput" placeholder="Agent name" value="${esc(state.name)}" maxlength="18"/>
          <label class="field-label">Case Code</label>
          <input type="text" id="codeInput" placeholder="e.g. K7QX" value="${esc(state.codeInput)}" maxlength="4" style="text-transform:uppercase;letter-spacing:4px;"/>
          ${state.error ? `<div class="error-box">${esc(state.error)}</div>` : ''}
          <button class="btn btn-teal" id="doJoin" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Joining…' : 'Join'}</button>
          <button class="link-btn" id="backLanding">&larr; Back</button>
        </div>
      </div>`;
    }

    if (state.screen === 'room' && state.room) {
      return `<div>${header}${renderRoom()}</div>`;
    }

    return `<div>${header}<div class="card center">Loading…</div></div>`;
  }

  function renderRoom() {
    const room = state.room;
    const isHost = state.myId === room.hostId;
    const codeBlock = `<div class="code-badge">${esc(room.code)}</div>`;

    // Joined while a case was already underway: this round's turnOrder was
    // locked in before they arrived, so they wait here (visible in the
    // roster, able to chat) rather than seeing briefing/clue/vote screens
    // built around a role they were never assigned.
    const amWaitingForNextRound = room.status !== 'lobby' && !room.turnOrder.includes(state.myId);
    if (amWaitingForNextRound) {
      const spectatorStatus = renderSpectatorStatus(room);
      const revealExtras = room.status === 'reveal' ? `
          <div class="reveal-word-row" style="margin-top:10px;">
            <div class="reveal-word-box"><div class="lbl">Real Word</div><div class="val">${esc(room.secretWord)}</div></div>
            <div class="reveal-word-box"><div class="lbl">Imposter Saw (Category)</div><div class="val">${esc(room.imposterHint)}</div></div>
          </div>
          ${room.caught && room.guessEnabled !== false ? `
            <div class="reveal-word-row">
              <div class="reveal-word-box"><div class="lbl">What The Imposter Guessed</div><div class="val">${room.imposterGuessText ? esc(room.imposterGuessText) : '(no guess submitted)'}</div></div>
            </div>
          ` : ''}
        ` : '';
      return `
        <div class="card">
          <div class="card-title">Case File ${room.roundNumber > 0 ? '&middot; Round ' + room.roundNumber : ''}</div>
          ${codeBlock}
          <div class="muted center">A case is already underway. You're spectating and will join in when the next one starts.</div>
          ${spectatorStatus}
          ${revealExtras}
        </div>
        ${room.turnOrder.length ? `<div class="card"><div class="card-title">Case Log</div>${renderClueTable(room)}</div>` : ''}
        ${renderRoster(room, isHost)}
        ${renderEndCaseBtn(isHost)}
        <button class="link-btn" id="leaveBtn">Leave case</button>
      `;
    }

    if (room.status === 'lobby') {
      const playerRows = room.players.map(p => `
        <div class="player-row">
          <span class="player-dot ${p.connected ? '' : 'offline'}"></span>${esc(p.name)}
          ${p.id === room.hostId
            ? '<span class="player-host-tag">Host</span>'
            : (isHost ? `<button class="kick-btn" data-kick="${p.id}" data-kick-name="${esc(p.name)}" title="Remove ${esc(p.name)}">&times;</button>` : '')}
        </div>`).join('');

      let controls;
      if (isHost) {
        const allCats = room.allCategories || [];
        const included = room.categories || [];
        const excluded = room.excludedCategories || [];
        const catPanel = renderCatPicker('cat', allCats, included, excluded, state.local.catFilter, state.local.catPanelOpen);

        const impMax = Math.max(1, Math.min(2, room.players.length - 1));
        const impOptions = Array.from({ length: impMax }, (_, i) => i + 1)
          .map(n => `<option value="${n}" ${room.imposterCount === n ? 'selected' : ''}>${n}</option>`).join('');
        const secOptions = [15, 30, 45, 60, 90].map(s => `<option value="${s}" ${room.clueSeconds === s ? 'selected' : ''}>${s}s</option>`).join('');
        const guessSecOptions = [10, 15, 20, 30, 45].map(s => `<option value="${s}" ${room.guessSeconds === s ? 'selected' : ''}>${s}s</option>`).join('');
        const guessEnabled = room.guessEnabled !== false;
        controls = `
          <label class="field-label">Categories (tap once to include, tap again to exclude, tap again to reset)</label>
          ${catPanel}
          <label class="field-label" style="margin-top:12px;">Imposters</label>
          <select id="impSelect">${impOptions}</select>
          <label class="field-label">Seconds per turn (clue rounds)</label>
          <select id="secSelect">${secOptions}</select>
          <label class="checkbox-row">
            <input type="checkbox" id="guessEnabledCheck" ${guessEnabled ? 'checked' : ''}/>
            Let a caught imposter make a last-chance guess at the real word
          </label>
          ${guessEnabled ? `
            <label class="field-label">Seconds for imposter's guess (if caught)</label>
            <select id="guessSecSelect">${guessSecOptions}</select>
          ` : ''}
          <button class="btn btn-red" id="beginBtn" ${room.players.length < 3 ? 'disabled' : ''}>Begin Interrogation</button>
          ${room.players.length < 3 ? '<div class="muted center">Need at least 3 agents to begin.</div>' : ''}
        `;
      } else {
        const guessNote = room.guessEnabled !== false ? `${room.guessSeconds}s to guess if caught` : 'no last-chance guess if caught';
        controls = `<div class="muted center">Categories: <strong>${esc(categoryLabel(room))}</strong> &middot; Imposters: <strong>${room.imposterCount}</strong> &middot; ${room.clueSeconds}s per turn &middot; ${guessNote}<br/><br/>Waiting for the host to begin the case…</div>`;
      }

      const customWords = room.customWords || [];
      const customWordRows = customWords.length
        ? customWords.map(w => `
            <div class="custom-word-row">
              <span>${esc(w.word)}</span>
              <span class="custom-word-tag">${esc(w.tags[0])}</span>
              ${isHost ? `<button class="remove-custom-btn" data-remove="${w.id}">&times;</button>` : ''}
            </div>`).join('')
        : `<div class="muted center">No custom words added yet.</div>`;

      const customWordCard = `
        <div class="card">
          <div class="card-title">Custom Words</div>
          ${isHost ? `
            <label class="field-label">Word or Phrase</label>
            <input type="text" id="customWordInput" placeholder="e.g. Roller Coaster" value="${esc(state.local.customWordDraft)}" maxlength="40"/>
            <label class="field-label">Category (optional — defaults to "Custom")</label>
            <input type="text" id="customTagInput" placeholder="Custom" value="${esc(state.local.customTagDraft)}" maxlength="24"/>
            <button class="btn btn-teal" id="addCustomWordBtn">Add Word</button>
            <button class="link-btn" id="toggleBulkBtn" style="margin-top:2px;">${state.local.bulkOpen ? 'Hide bulk add' : 'Bulk add multiple words'}</button>
            ${state.local.bulkOpen ? `
              <label class="field-label" style="margin-top:8px;">One per line — "Word" or "Word: Category"</label>
              <textarea id="bulkInput" placeholder="Roller Coaster: Amusement Park&#10;Ferris Wheel: Amusement Park&#10;Cotton Candy" maxlength="4000">${esc(state.local.bulkDraft)}</textarea>
              <button class="btn btn-gold" id="addBulkBtn">Add All Lines</button>
            ` : ''}
          ` : ''}
          ${customWordRows}
        </div>
      `;

      return `
        <div class="card">
          <div class="card-title">Case File ${room.roundNumber > 0 ? '&middot; Round ' + room.roundNumber : ''}</div>
          ${codeBlock}
          <div class="muted center" style="margin-bottom:10px;">Share this code with your friends</div>
          ${playerRows}
        </div>
        <div class="card"><div class="card-title">Briefing Setup</div>${controls}</div>
        ${customWordCard}
        <button class="link-btn" id="leaveBtn">Leave case</button>
      `;
    }

    if (room.status === 'briefing') {
      const isImposter = state.myRole ? state.myRole.isImposter : false;
      let inner;
      if (!state.local.revealed) {
        inner = `
          <div class="seal-wrap" id="sealCard">
            <div class="muted" style="font-family:var(--font-mono);font-size:11px;letter-spacing:2px;">TOP SECRET</div>
            <div class="redacted-bar"></div>
            <div class="redacted-bar" style="width:55%;"></div>
            <div class="seal-hint">Tap to break the seal</div>
          </div>`;
      } else {
        inner = `
          <div class="stamp-block">
            <div class="stamp-text ${isImposter ? 'stamp-compromised' : 'stamp-cleared'}">${isImposter ? 'COMPROMISED' : 'CLEARED'}</div>
            <div class="word-type" id="typedWordDisplay">${esc(state.local.typedWord)}<span class="cursor">_</span></div>
            <div class="role-note">${isImposter
              ? 'You did not receive the real word — only its category. Use that to bluff your way through without getting caught.'
              : 'This is the real word. You will each log a word or phrase clue for it, one at a time, over 3 rounds.'}</div>
          </div>`;
      }
      const orderChips = room.turnOrder.map(id => `<span class="order-chip">${esc(getPlayerName(id))}</span>`).join('');
      const hostControls = isHost
        ? `<button class="btn btn-teal" id="toCluesBtn">Start Clue Rounds</button>`
        : `<div class="muted center">Discuss nothing yet — wait for the host to start clue rounds.</div>`;

      return `
        <div class="card"><div class="card-title">Your Briefing &middot; ${esc(categoryLabel(room))}</div>${inner}</div>
        <div class="card"><div class="card-title">Turn Order</div><div class="order-list">${orderChips}</div></div>
        <div class="card">${hostControls}</div>
        ${renderRoster(room, isHost)}
        ${renderEndCaseBtn(isHost)}
        <button class="link-btn" id="leaveBtn">Leave case</button>
      `;
    }

    if (room.status === 'clues') {
      const currentId = room.turnOrder[room.currentTurnIndex];
      const isMyTurn = currentId === state.myId;
      const turnBanner = `<div class="turn-banner">Round ${room.clueRound} of 3 &middot; <span class="who">${esc(getPlayerName(currentId))}</span>'s turn</div>`;
      const timerBlock = `<div class="timer-display" id="timerDisplay">--:--</div>`;

      let actionBlock;
      if (isMyTurn) {
        actionBlock = `
          <input type="text" id="clueInput" placeholder="Your word or phrase clue…" value="${esc(state.local.clueDraft)}" maxlength="60"/>
          <button class="btn btn-red" id="submitClueBtn">Log Clue</button>
        `;
      } else {
        actionBlock = `<div class="muted center">Waiting for ${esc(getPlayerName(currentId))} to answer…</div>`;
      }

      return `
        ${renderMyWordCard()}
        <div class="card">
          <div class="card-title">Interrogation &middot; ${esc(categoryLabel(room))}</div>
          ${renderCategoryHint(room)}
          ${turnBanner}
          ${timerBlock}
          ${actionBlock}
        </div>
        <div class="card"><div class="card-title">Case Log</div>${renderClueTable(room)}</div>
        ${renderRoster(room, isHost)}
        ${renderEndCaseBtn(isHost)}
        <button class="link-btn" id="leaveBtn">Leave case</button>
      `;
    }

    if (room.status === 'discussion') {
      const hostControls = isHost
        ? `<button class="btn btn-red" id="openVotingBtn">Open Voting</button>`
        : `<div class="muted center">Discuss and justify your answers out loud or in chat. Waiting for the host to open voting…</div>`;

      return `
        ${renderMyWordCard()}
        <div class="card">
          <div class="card-title">Open Discussion</div>
          ${renderCategoryHint(room)}
          <div class="muted center">All clues are in. Talk it through, then ${isHost ? 'open voting when ready.' : 'wait for the host.'}</div>
        </div>
        <div class="card"><div class="card-title">Case Log</div>${renderClueTable(room)}</div>
        <div class="card">${hostControls}</div>
        ${renderRoster(room, isHost)}
        ${renderEndCaseBtn(isHost)}
        <button class="link-btn" id="leaveBtn">Leave case</button>
      `;
    }

    if (room.status === 'voting') {
      const votedCount = room.votedCount || 0;
      const options = room.turnOrder.filter(id => id !== state.myId).map(id => {
        const selected = state.local.voteSelection === id;
        return `<div class="vote-option ${selected ? 'selected' : ''}" data-vote="${id}">${esc(getPlayerName(id))} ${selected ? '&#10003;' : ''}</div>`;
      }).join('');

      const hostControls = isHost ? `<button class="btn btn-red" id="forceRevealBtn">Force Reveal Vote</button>` : '';

      return `
        ${renderMyWordCard()}
        <div class="card">
          <div class="card-title">Cast Your Suspicion</div>
          ${renderCategoryHint(room)}
          <div class="vote-grid">${options}</div>
          <div class="vote-count">${votedCount} / ${room.turnOrder.length} agents have voted</div>
          ${state.local.voted ? '<div class="muted center">Tap another agent to change your vote.</div>' : ''}
        </div>
        <div class="card">${hostControls || '<div class="muted center">Waiting for the reveal.</div>'}</div>
        ${renderRoster(room, isHost)}
        ${renderEndCaseBtn(isHost)}
        <button class="link-btn" id="leaveBtn">Leave case</button>
      `;
    }

    if (room.status === 'imposter-guess') {
      const accusedName = getPlayerName(room.activeGuesserId);
      const isGuesser = state.myId === room.activeGuesserId;
      const timerBlock = `<div class="timer-display" id="timerDisplay">--:--</div>`;
      let inner;
      if (isGuesser) {
        inner = `
          <div class="muted center" style="margin-bottom:10px;">You were caught. Guess the real word to steal the win.</div>
          <input type="text" id="guessInput" placeholder="Guess the real word…" value="${esc(state.local.guessDraft)}" maxlength="60"/>
          <button class="btn btn-red" id="submitGuessBtn">Submit Guess</button>
        `;
      } else {
        inner = `<div class="muted center">${esc(accusedName)} was caught and gets one shot at guessing the real word…</div>`;
      }
      return `
        ${renderMyWordCard()}
        <div class="card">
          <div class="card-title">Last Chance</div>
          ${renderCategoryHint(room)}
          <div class="stamp-block"><div class="stamp-text stamp-compromised">CAUGHT</div></div>
          ${timerBlock}
          ${inner}
        </div>
        <div class="card"><div class="card-title">Case Log</div>${renderClueTable(room)}</div>
        ${renderRoster(room, isHost)}
        ${renderEndCaseBtn(isHost)}
        <button class="link-btn" id="leaveBtn">Leave case</button>
      `;
    }

    if (room.status === 'reveal') {
      const accusedNames = (room.accusedIds || []).map(getPlayerName).join(', ') || 'No majority';
      const imposterNames = (room.imposterIds || []).map(getPlayerName).join(', ');
      let verdictText;
      if (room.caught && room.guessResult === true) verdictText = 'Caught — but guessed the word and steals the round!';
      else if (room.caught && !room.guessEnabled) verdictText = 'Caught red-handed. Crew wins the round.';
      else if (room.caught && room.guessResult === false) verdictText = 'Caught, and guessed wrong. Crew wins the round.';
      else if (!room.caught) verdictText = 'The imposter blended in and escapes with the round.';
      else verdictText = '';

      const scoreRows = room.players.slice()
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .map(p => `<div class="score-row"><span>${esc(p.name)}</span><span class="score-val">${p.score || 0}</span></div>`).join('');

      const hostControls = isHost
        ? `<button class="btn btn-gold" id="nextRoundBtn">Next Case</button>`
        : `<div class="muted center">Waiting for the host to start the next round.</div>`;

      return `
        <div class="card">
          <div class="card-title">Verdict</div>
          <div class="stamp-block">
            <div class="stamp-text ${room.caught && room.guessResult !== true ? 'stamp-cleared' : 'stamp-compromised'}">${room.caught ? (room.guessResult === true ? 'IMPOSTER WINS' : 'IMPOSTER CAUGHT') : 'IMPOSTER ESCAPED'}</div>
          </div>
          <div class="muted center" style="margin-bottom:6px;">${esc(verdictText)}</div>
          <div class="muted center" style="margin-bottom:10px;">Accused: <strong>${esc(accusedNames)}</strong> &middot; Imposter${(room.imposterIds || []).length > 1 ? 's' : ''}: <strong>${esc(imposterNames)}</strong></div>
          <div class="reveal-word-row">
            <div class="reveal-word-box"><div class="lbl">Real Word</div><div class="val">${esc(room.secretWord)}</div></div>
            <div class="reveal-word-box"><div class="lbl">Imposter Saw (Category)</div><div class="val">${esc(room.imposterHint)}</div></div>
          </div>
          ${room.caught && room.guessEnabled !== false ? `
            <div class="reveal-word-row">
              <div class="reveal-word-box"><div class="lbl">What The Imposter Guessed</div><div class="val">${room.imposterGuessText ? esc(room.imposterGuessText) : '(no guess submitted)'}</div></div>
            </div>
          ` : ''}
          ${(room.secretAliases && room.secretAliases.length) ? `<div class="muted center" style="margin-top:8px;">Also accepted as a correct guess: <strong>${esc(room.secretAliases.join(', '))}</strong></div>` : ''}
        </div>
        <div class="card"><div class="card-title">Scoreboard</div>${scoreRows}</div>
        <div class="card">${hostControls}</div>
        ${renderRoster(room, isHost)}
        <button class="link-btn" id="leaveBtn">Leave case</button>
      `;
    }

    return '';
  }

  function bindEvents() {
    const byId = (id) => document.getElementById(id);

    if (byId('nameInput')) {
      trackFocus(byId('nameInput'));
      byId('nameInput').oninput = (e) => { state.name = e.target.value; };
    }
    if (byId('codeInput')) {
      trackFocus(byId('codeInput'));
      byId('codeInput').oninput = (e) => { state.codeInput = e.target.value.toUpperCase(); };
    }
    if (byId('goCreate')) byId('goCreate').onclick = window.__imp_createRoom;
    if (byId('goJoin')) byId('goJoin').onclick = window.__imp_goJoinForm;
    if (byId('doJoin')) byId('doJoin').onclick = window.__imp_joinRoom;
    if (byId('backLanding')) byId('backLanding').onclick = window.__imp_backLanding;

    bindCatPicker(byId, 'cat', 'catFilter', 'catPanelOpen');
    if (byId('impSelect')) byId('impSelect').onchange = (e) => window.__imp_updateSettings({ imposterCount: parseInt(e.target.value, 10) });
    if (byId('secSelect')) byId('secSelect').onchange = (e) => window.__imp_updateSettings({ clueSeconds: parseInt(e.target.value, 10) });
    if (byId('guessSecSelect')) byId('guessSecSelect').onchange = (e) => window.__imp_updateSettings({ guessSeconds: parseInt(e.target.value, 10) });
    if (byId('guessEnabledCheck')) byId('guessEnabledCheck').onchange = (e) => window.__imp_updateSettings({ guessEnabled: e.target.checked });
    if (byId('beginBtn')) byId('beginBtn').onclick = window.__imp_startRound;

    if (byId('customWordInput')) {
      trackFocus(byId('customWordInput'));
      byId('customWordInput').oninput = (e) => { state.local.customWordDraft = e.target.value; };
      byId('customWordInput').onkeydown = (e) => { if (e.key === 'Enter') window.__imp_addCustomWord(); };
    }
    if (byId('customTagInput')) {
      trackFocus(byId('customTagInput'));
      byId('customTagInput').oninput = (e) => { state.local.customTagDraft = e.target.value; };
      byId('customTagInput').onkeydown = (e) => { if (e.key === 'Enter') window.__imp_addCustomWord(); };
    }
    if (byId('addCustomWordBtn')) byId('addCustomWordBtn').onclick = window.__imp_addCustomWord;
    if (byId('toggleBulkBtn')) byId('toggleBulkBtn').onclick = window.__imp_toggleBulk;
    if (byId('bulkInput')) {
      trackFocus(byId('bulkInput'));
      byId('bulkInput').oninput = (e) => { state.local.bulkDraft = e.target.value; };
    }
    if (byId('addBulkBtn')) byId('addBulkBtn').onclick = window.__imp_addBulkWords;
    document.querySelectorAll('.remove-custom-btn').forEach(btn => {
      btn.onclick = () => window.__imp_removeCustomWord(btn.getAttribute('data-remove'));
    });
    document.querySelectorAll('.kick-btn').forEach(btn => {
      btn.onclick = () => window.__imp_kickPlayer(btn.getAttribute('data-kick'), btn.getAttribute('data-kick-name'));
    });
    if (byId('rosterToggleBtn')) byId('rosterToggleBtn').onclick = window.__imp_toggleRoster;

    if (byId('sealCard')) byId('sealCard').onclick = window.__imp_revealCard;
    if (byId('miniSeal')) byId('miniSeal').onclick = window.__imp_revealCard;
    if (byId('toCluesBtn')) byId('toCluesBtn').onclick = window.__imp_startClues;
    if (byId('openVotingBtn')) byId('openVotingBtn').onclick = window.__imp_openVoting;

    if (byId('clueInput')) {
      trackFocus(byId('clueInput'));
      byId('clueInput').oninput = (e) => { state.local.clueDraft = e.target.value; };
      byId('clueInput').onkeydown = (e) => { if (e.key === 'Enter') window.__imp_submitClue(); };
    }
    if (byId('submitClueBtn')) byId('submitClueBtn').onclick = window.__imp_submitClue;

    document.querySelectorAll('.vote-option').forEach(el => {
      el.onclick = () => window.__imp_castVote(el.getAttribute('data-vote'));
    });
    if (byId('forceRevealBtn')) byId('forceRevealBtn').onclick = window.__imp_forceReveal;

    if (byId('guessInput')) {
      trackFocus(byId('guessInput'));
      byId('guessInput').oninput = (e) => { state.local.guessDraft = e.target.value; };
      byId('guessInput').onkeydown = (e) => { if (e.key === 'Enter') window.__imp_submitGuess(); };
    }
    if (byId('submitGuessBtn')) byId('submitGuessBtn').onclick = window.__imp_submitGuess;

    if (byId('nextRoundBtn')) byId('nextRoundBtn').onclick = window.__imp_nextRound;
    if (byId('endRoundBtn')) byId('endRoundBtn').onclick = window.__imp_endRound;
    if (byId('leaveBtn')) byId('leaveBtn').onclick = window.__imp_leaveCase;
  }

  // ---------- RENDER: CHAT COLUMN ----------
  function renderChat() {
    const root = document.getElementById('chat-col');
    if (state.screen !== 'room') { root.innerHTML = ''; return; }
    const room = state.room;
    const messages = (room && room.chat || []).map(m => {
      const t = new Date(m.ts);
      const hh = t.getHours().toString().padStart(2, '0');
      const mm = t.getMinutes().toString().padStart(2, '0');
      if (m.system) {
        return `<div class="chat-msg system">${esc(m.text)}<span class="time">${hh}:${mm}</span></div>`;
      }
      return `<div class="chat-msg"><span class="name">${esc(m.name)}</span>${esc(m.text)}<span class="time">${hh}:${mm}</span></div>`;
    }).join('');

    root.innerHTML = `
      <div class="chat-card">
        <div class="chat-header">Comms Channel</div>
        <div class="chat-messages" id="chatMessages">${messages || '<div class="chat-empty">No messages yet. Say hi.</div>'}</div>
        <div class="chat-input-row">
          <input type="text" id="chatInput" placeholder="Message the room…" value="${esc(state.local.chatDraft)}" maxlength="300"/>
          <button class="chat-send-btn" id="chatSendBtn">Send</button>
        </div>
        <button class="chat-close-btn" id="chatCloseBtn">Close</button>
      </div>
    `;

    const input = document.getElementById('chatInput');
    trackFocus(input);
    input.oninput = (e) => { state.local.chatDraft = e.target.value; };
    input.onkeydown = (e) => { if (e.key === 'Enter') window.__imp_sendChat(); };
    document.getElementById('chatSendBtn').onclick = window.__imp_sendChat;
    const closeBtn = document.getElementById('chatCloseBtn');
    if (closeBtn) closeBtn.onclick = window.__imp_toggleChat;

    restoreFocus();
    const msgBox = document.getElementById('chatMessages');
    if (msgBox) msgBox.scrollTop = msgBox.scrollHeight;
  }

  document.getElementById('chatToggleBtn').onclick = window.__imp_toggleChat;

  render();
  renderChat();
})();
