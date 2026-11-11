'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Game, MAX_PLAYERS, MIN_PLAYERS, describeTier } = require('./game');

const PORT = process.env.PORT || 3000;
const COLORS = ['#e74c3c', '#3498db', '#ffffff', '#e67e22', '#9b59b6', '#fd79a8', '#00cec9', '#2d3436'];
const AFK_MS = 45 * 1000;      // 切断してからこの時間が過ぎたら自動進行
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (e, buf) => {
      if (e) { res.writeHead(500); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } else { res.writeHead(404); res.end('Not found'); }
});
const io = new Server(server);

const rooms = new Map();
const rid = (n = 8) => crypto.randomBytes(n).toString('hex').slice(0, n);

function newRoomCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(code));
  return code;
}
function cleanName(s) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10); }
function freeColor(room) {
  const used = new Set(room.players.map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[0];
}
function roomState(room) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    started: !!room.game,
    targetScore: room.targetScore,
    tierInfo: describeTier(Math.max(room.players.length, 3)),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, connected: p.connected })),
  };
}
function emitStartPayload(room, player) {
  const g = room.game;
  io.to(player.socketId).emit('gameStarted', {
    roomCode: room.code, myId: player.id, config: g.configInfo(), board: g.staticBoard(),
  });
  io.to(player.socketId).emit('gameStateSync', g.view(player.id));
}
function broadcast(room) {
  const g = room.game;
  if (!g) return;
  g.drain().forEach((m) => io.to(room.code).emit('toast', m));
  room.players.forEach((p) => {
    if (p.socketId && p.connected) io.to(p.socketId).emit('gameStateSync', g.view(p.id));
  });
}

io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    if (!room) return {};
    const player = room.players.find((p) => p.id === socket.data.pid);
    return { room, player };
  };
  const attach = (room, player) => {
    player.socketId = socket.id; player.connected = true; player.lastSeen = Date.now();
    socket.data = { code: room.code, pid: player.id };
    socket.join(room.code);
    if (room.game) { const gp = room.game.p(player.id); if (gp) gp.connected = true; }
  };

  socket.on('createRoom', ({ name, targetScore } = {}) => {
    name = cleanName(name);
    if (!name) return socket.emit('errorMsg', '名前を入力してください');
    const code = newRoomCode();
    const ts = parseInt(targetScore, 10);
    const room = { code, hostId: null, players: [], game: null, targetScore: ts >= 10 && ts <= 14 ? ts : null, created: Date.now() };
    const player = { id: rid(), token: rid(24), name, color: freeColor(room), socketId: null, connected: true };
    room.players.push(player); room.hostId = player.id;
    rooms.set(code, room);
    attach(room, player);
    socket.emit('roomCreated', { roomCode: code, player: { id: player.id, token: player.token, name, color: player.color }, roomState: roomState(room) });
  });

  socket.on('joinRoom', ({ roomCode, name } = {}) => {
    name = cleanName(name);
    const room = rooms.get(String(roomCode || '').trim());
    if (!name) return socket.emit('errorMsg', '名前を入力してください');
    if (!room) return socket.emit('errorMsg', 'ルームが見つかりません');
    if (room.game) return socket.emit('errorMsg', 'このルームは既にゲーム中です');
    if (room.players.length >= MAX_PLAYERS) return socket.emit('errorMsg', `満員です（最大${MAX_PLAYERS}人）`);
    if (room.players.some((p) => p.name === name)) return socket.emit('errorMsg', '同じ名前のプレイヤーがいます');
    const player = { id: rid(), token: rid(24), name, color: freeColor(room), socketId: null, connected: true };
    room.players.push(player);
    attach(room, player);
    socket.emit('joinedSuccess', { player: { id: player.id, token: player.token, name, color: player.color }, roomState: roomState(room) });
    io.to(room.code).emit('roomUpdated', roomState(room));
  });

  socket.on('rejoin', ({ roomCode, token } = {}) => {
    const room = rooms.get(String(roomCode || ''));
    const player = room && room.players.find((p) => p.token === token);
    if (!player) return socket.emit('rejoinFailed');
    attach(room, player);
    socket.emit('rejoined', { roomCode: room.code, player: { id: player.id, name: player.name, color: player.color }, roomState: roomState(room) });
    if (room.game) { emitStartPayload(room, player); broadcast(room); }
    else io.to(room.code).emit('roomUpdated', roomState(room));
  });

  socket.on('startGame', () => {
    const { room, player } = ctx();
    if (!room || room.game) return;
    if (player.id !== room.hostId) return socket.emit('errorMsg', 'ホストのみ開始できます');
    if (room.players.length < MIN_PLAYERS) return socket.emit('errorMsg', `${MIN_PLAYERS}人以上で開始できます`);
    room.game = new Game(room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })), { targetScore: room.targetScore });
    room.players.forEach((p) => { if (p.connected) emitStartPayload(room, p); });
    broadcast(room);
  });

  // ---- ゲーム内アクション（ルーム・プレイヤーは接続情報から特定。クライアントの申告は信用しない）----
  const act = (fn) => {
    const { room, player } = ctx();
    if (!room || !room.game || !player) return;
    let r;
    try { r = fn(room.game, player.id); } catch (e) { console.error(e); r = { error: 'サーバーエラーが発生しました' }; }
    if (r && r.error) socket.emit('errorMsg', r.error);
    broadcast(room);
  };
  socket.on('setupPlaceSettlement', (d = {}) => act((g, id) => g.setupSettlement(id, d.nodeId)));
  socket.on('setupPlaceRoad', (d = {}) => act((g, id) => g.setupRoad(id, d.edgeId)));
  socket.on('rollDice', () => act((g, id) => g.rollDice(id)));
  socket.on('discardResources', (d = {}) => act((g, id) => g.discard(id, d.discardedRes)));
  socket.on('moveRobber', (d = {}) => act((g, id) => g.moveRobber(id, d.hexId, d.targetPlayerId)));
  socket.on('buildStructure', (d = {}) => act((g, id) => g.buildStructure(id, d.type, d.type === 'road' ? d.edgeId : d.nodeId)));
  socket.on('buyDevelopment', () => act((g, id) => g.buyDevelopment(id)));
  socket.on('playDev', (d = {}) => act((g, id) => g.playDev(id, d.card, d.params || {})));
  socket.on('bankTrade', (d = {}) => act((g, id) => g.bankTrade(id, d.give, d.get)));
  socket.on('proposeTrade', (d = {}) => act((g, id) => g.proposeTrade(id, d.give, d.want)));
  socket.on('respondTrade', (d = {}) => act((g, id) => g.respondTrade(id, !!d.accept)));
  socket.on('confirmTrade', (d = {}) => act((g, id) => g.confirmTrade(id, d.withId)));
  socket.on('cancelTrade', () => act((g, id) => g.cancelTrade(id)));
  socket.on('endTurn', () => act((g, id) => (g.phase === 'SPECIAL' ? g.endSpecial(id) : g.endTurn(id))));

  socket.on('disconnect', () => {
    const { room, player } = ctx();
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false; player.socketId = null; player.lastSeen = Date.now();
    if (!room.game) {
      room.players = room.players.filter((p) => p.id !== player.id);
      if (!room.players.length) { rooms.delete(room.code); return; }
      if (room.hostId === player.id) room.hostId = room.players[0].id;
      io.to(room.code).emit('roomUpdated', roomState(room));
    } else {
      const gp = room.game.p(player.id); if (gp) gp.connected = false;
      broadcast(room);
    }
  });
});

// 切断したまま放置されたプレイヤーの手番を自動進行／古い部屋の掃除
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    const anyone = room.players.some((p) => p.connected);
    if (!anyone && now - Math.max(room.created, ...room.players.map((p) => p.lastSeen || 0)) > ROOM_TTL_MS) { rooms.delete(code); return; }
    const g = room.game;
    if (!g || g.phase === 'GAME_OVER') return;
    let changed = false;
    for (let guard = 0; guard < 60; guard++) {
      let acted = false;
      for (const p of room.players) {
        if (p.connected || now - (p.lastSeen || 0) < AFK_MS) continue;
        if (g.autoAct(p.id)) { acted = true; changed = true; }
      }
      if (!acted) break;
    }
    if (changed) broadcast(room);
  });
}, 5000);

server.listen(PORT, () => console.log(`Catan server running on http://localhost:${PORT}`));
