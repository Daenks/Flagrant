// Entry point: state, message routing, screen switching.
import { $, el, toast, sfx, local, session, idEq, isMuted, setMuted, TERRAIN } from './util.js';
import { Net } from './net.js';
import { Log, bindChatForm } from './log.js';
import { LobbyUI } from './lobby.js';
import { GameUI } from './game.js';
import { drawSwatch } from './renderer.js';

const state = {
  me: null,          // {id, name}
  token: session.get('flagrant.token'),
  room: null,
  game: null,
  lobbies: [],
};

const log = new Log();
const net = new Net(onMessage, onStatus, onOpen);
const lobbyUI = new LobbyUI({ state, net, onEnsureName: ensureName });
const gameUI = new GameUI({ state, net, log, onLeave: leave });
let screen = null;
let hashTried = false;

// ---------------------------------------------------------------- name / hello
function currentName() {
  let n = lobbyUI.getName();
  if (!n) {
    n = local.get('flagrant.defaultName');
    if (!n) { n = 'Player' + (100 + Math.floor(Math.random() * 900)); local.set('flagrant.defaultName', n); }
  }
  return n;
}

function onOpen() {
  const hello = { t: 'hello', name: currentName() };
  if (state.token) hello.token = state.token;
  net.send(hello);
}

/**
 * The protocol has no rename message and the server ignores a second hello on the same socket,
 * so if the name was edited after welcome (and we're not in a room) we reconnect: the new
 * hello carries our token (session resume) plus the new name.
 */
function ensureName() {
  const n = currentName();
  if (state.me && n !== state.me.name && !state.room) {
    state.me.name = n;
    restarting = true;
    net.restart();
  }
}
let restarting = false;

function onStatus(s) {
  const box = $('#connStatus');
  if (s === 'online') { box.hidden = true; restarting = false; return; }
  if (restarting) return;
  box.hidden = false;
  box.textContent = state.me ? 'Connection lost - reconnecting...' : 'Connecting to server...';
}

function leave() {
  net.send({ t: 'leave' });
  sfx('click');
}

// ---------------------------------------------------------------- hash handling
function hashCode() {
  const h = decodeURIComponent(location.hash.replace(/^#/, '')).trim().toUpperCase();
  return /^[A-Z0-9]{3,8}$/.test(h) ? h : null;
}
function setHash(code) {
  if (!code) return;
  if (location.hash !== '#' + code) history.replaceState(null, '', '#' + code);
}
function clearHash() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
function tryHashJoin() {
  if (hashTried) return;
  const code = hashCode();
  if (!code) return;
  hashTried = true;
  // give the server a moment to re-send our room if this is a session resume
  setTimeout(() => {
    if (!state.room && net.open) lobbyUI.join(code);
  }, 450);
}
window.addEventListener('hashchange', () => {
  const code = hashCode();
  if (code && !state.room && state.me) lobbyUI.join(code);
});

// ---------------------------------------------------------------- messages
function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      state.me = { id: m.id, name: m.name };
      if (m.token) { state.token = m.token; session.set('flagrant.token', m.token); }
      if (!$('#nameInput').value && m.name) $('#nameInput').value = m.name;
      onStatus('online');
      tryHashJoin();
      if (!state.room) net.send({ t: 'list' });
      break;
    case 'lobbies':
      state.lobbies = Array.isArray(m.lobbies) ? m.lobbies : [];
      lobbyUI.renderLobbies();
      break;
    case 'error':
      toast(m.msg || 'Something went wrong');
      break;
    case 'left':
      state.room = null;
      state.game = null;
      gameUI.reset();
      clearHash();
      if (m.reason) toast(m.reason, 'info');
      net.send({ t: 'list' });
      break;
    case 'room': {
      const prev = state.room;
      state.room = m;
      if (m.state === 'lobby' && state.game) { state.game = null; gameUI.reset(); }
      setHash(m.code);
      if (!prev || prev.code !== m.code) log.system(`Joined lobby ${m.name || m.code}`);
      break;
    }
    case 'chat': {
      const players = state.game?.players || state.room?.players || [];
      log.chat(m, players);
      if (!m.system && !idEq(m.from, state.me?.id) && m.from !== state.me?.name) sfx('chat');
      break;
    }
    case 'ping':
      gameUI.onPing(m);
      break;
    case 'game':
      state.game = m;
      gameUI.onSnapshot(m);
      break;
    default:
      return; // unknown message: ignore
  }
  update();
}

// ---------------------------------------------------------------- screens
function update() {
  const room = state.room;
  const next = state.game && (!room || room.state !== 'lobby') ? 'game' : room ? 'lobby' : 'home';
  if (next !== screen) {
    screen = next;
    for (const id of ['home', 'lobby', 'game']) $('#' + id).hidden = id !== next;
    gameUI.setActive(next === 'game');
    if (next === 'home') lobbyUI.renderLobbies();
  }
  if (next === 'lobby') lobbyUI.renderLobby();
  else if (next === 'game') gameUI.renderHud();
}

// ---------------------------------------------------------------- chat forms
const sendChat = (text, scope) => net.send({ t: 'chat', text, scope });
bindChatForm($('#lobbyChatForm'), sendChat);
bindChatForm($('#gameChatForm'), (text, scope) => { sendChat(text, scope); $('#gameChatForm input').blur(); });

// ---------------------------------------------------------------- help
function buildLegend() {
  const box = $('#terrainLegend');
  for (const ch of ['.', 'f', 'h', 'w', 'd', 'm', 't', 'p', 'j']) {
    const T = TERRAIN[ch];
    const cv = el('canvas');
    try { drawSwatch(cv, ch); } catch (e) { console.error(e); }
    box.append(el('div', { class: 'lg' }, cv, el('div', null, el('b', { text: T.name }), ` (${T.cost === 'impassable' ? 'impassable' : 'cost ' + T.cost})`, T.note ? el('div', { class: 'muted', text: T.note }) : null)));
  }
}
function toggleHelp(show) {
  const pop = $('#helpPop');
  pop.hidden = show === undefined ? !pop.hidden : !show;
}
$('#helpBtn').addEventListener('click', () => toggleHelp());
for (const b of document.querySelectorAll('.help-open')) b.addEventListener('click', () => toggleHelp(true));
$('#helpClose').addEventListener('click', () => toggleHelp(false));
$('#helpPop').addEventListener('click', (e) => { if (e.target.id === 'helpPop') toggleHelp(false); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#helpPop').hidden) { toggleHelp(false); e.preventDefault(); }
  else if (e.key === '?' && screen === 'game' && !(e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))) toggleHelp();
});

// ---------------------------------------------------------------- boot
setMuted(isMuted());
buildLegend();
update();
lobbyUI.renderLobbies();
net.start();

// handy for debugging from the console
window.flagrant = { state, net, gameUI };
