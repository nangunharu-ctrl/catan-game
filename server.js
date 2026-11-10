const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// 静的ファイルの提供 (HTML/CSS/JS)
app.use(express.static('public'));

// ルームのゲーム状態保持用メモリDB
const rooms = {};

// プレイヤーカラーの定義 (8色)
const PLAYER_COLORS = [
    '#e74c3c', '#3498db', '#2ecc71', '#f1c40f',
    '#9b59b6', '#e67e22', '#1abc9c', '#e84393'
];

io.on('connection', (socket) => {
    console.log(`[Connect] Socket ID: ${socket.id}`);

    // --- 1. ルーム作成 ---
    socket.on('createRoom', ({ name, targetScore }) => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        rooms[roomCode] = {
            roomCode: roomCode,
            hostId: socket.id,
            targetScore: targetScore || 12,
            phase: 'LOBBY', // LOBBY, setup, MAIN, SPECIAL_BUILD
            activePlayerIdx: 0,
            players: [],
            board: null // ゲーム開始時に生成
        };

        const player = {
            id: socket.id,
            name: name,
            color: PLAYER_COLORS[0],
            score: 0,
            resources: { wood: 0, brick: 0, wheat: 0, wool: 0, ore: 0 }
        };

        rooms[roomCode].players.push(player);
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, player, roomState: rooms[roomCode] });
    });

    // --- 2. ルーム参加 ---
    socket.on('joinRoom', ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) {
            return socket.emit('errorMsg', '該当するルームが見つかりません。');
        }
        if (room.players.length >= 8) {
            return socket.emit('errorMsg', 'ルームが満員です（最大8名）。');
        }
        if (room.phase !== 'LOBBY') {
            return socket.emit('errorMsg', 'すでにゲームが進行中です。');
        }

        const playerColor = PLAYER_COLORS[room.players.length];
        const player = {
            id: socket.id,
            name: name,
            color: playerColor,
            score: 0,
            resources: { wood: 2, brick: 2, wheat: 2, wool: 2, ore: 2 } // 初期テスト資源
        };

        room.players.push(player);
        socket.join(roomCode);

        // 全員へ更新されたルーム状態を配信
        io.to(roomCode).emit('roomUpdated', room);
        socket.emit('joinedSuccess', { player, roomState: room });
    });

    // --- 3. ゲーム開始 (ホストのみ) ---
    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;

        room.phase = 'MAIN';
        // 42タイルの動的マップ初期化
        room.board = generateDynamicMap(room.players.length);

        io.to(roomCode).emit('gameStarted', room);
    });

    // --- 4. ダイスロール同期 & 資源配布/バースト判定 ---
    socket.on('rollDice', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const d1 = Math.floor(Math.random() * 6) + 1;
        const d2 = Math.floor(Math.random() * 6) + 1;
        const total = d1 + d2;

        if (total === 7) {
            // 7が出た場合：手札8枚以上のプレイヤー全員にバーストイベント発火
            const burstPlayers = room.players
                .filter(p => Object.values(p.resources).reduce((a, b) => a + b, 0) >= 8)
                .map(p => p.id);

            io.to(roomCode).emit('diceRolled', { dice: [d1, d2], total, isSeven: true, burstPlayers });
        } else {
            // 資源自動分配処理
            distributeResourcesServer(room, total);
            io.to(roomCode).emit('diceRolled', { dice: [d1, d2], total, isSeven: false });
            io.to(roomCode).emit('gameStateSync', room);
        }
    });

    // --- 5. 資源廃棄（バースト時） ---
    socket.on('discardResources', ({ roomCode, discardedRes }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            Object.keys(discardedRes).forEach(r => {
                player.resources[r] = Math.max(0, (player.resources[r] || 0) - discardedRes[r]);
            });
            io.to(roomCode).emit('gameStateSync', room);
        }
    });

    // --- 6. 建設同期（開拓地 / 都市 / 街道） ---
    socket.on('buildStructure', ({ roomCode, type, nodeId }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        const node = room.board.nodes.find(n => n.id === nodeId);

        if (!player || !node) return;

        if (type === 'settlement' && node.owner === null) {
            node.owner = player.id;
            node.type = 'settlement';
            player.score += 1;
            // 資源消費
            player.resources.wood -= 1; player.resources.brick -= 1;
            player.resources.wheat -= 1; player.resources.wool -= 1;
        } else if (type === 'city' && node.owner === player.id) {
            node.type = 'city';
            player.score += 1; // 開拓地1点→都市2点への増分+1
            player.resources.wheat -= 2; player.resources.ore -= 3;
        }

        // 勝利判定
        let winner = null;
        if (player.score >= room.targetScore) {
            winner = player;
        }

        io.to(roomCode).emit('gameStateSync', room);
        if (winner) {
            io.to(roomCode).emit('gameOver', { winner });
        }
    });

    // --- 7. ターン終了 / 特別建設フェーズ切り替え ---
    socket.on('endTurn', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;

        // 8人ルール用：特別建設フェーズへ一時移行
        room.phase = 'SPECIAL_BUILD';
        io.to(roomCode).emit('gameStateSync', room);

        // 3秒後に次のプレイヤーへターン移譲
        setTimeout(() => {
            room.activePlayerIdx = (room.activePlayerIdx + 1) % room.players.length;
            room.phase = 'MAIN';
            io.to(roomCode).emit('gameStateSync', room);
        }, 3000);
    });

    // 切断処理
    socket.on('disconnect', () => {
        console.log(`[Disconnect] Socket ID: ${socket.id}`);
        // 必要に応じて部屋からの離脱処理
    });
});

// マップ自動生成ロジック
function generateDynamicMap(playerCount) {
    const tileTypes = [
        ...Array(8).fill('FOREST'), ...Array(8).fill('HILL'),
        ...Array(8).fill('FIELD'),  ...Array(8).fill('PASTURE'),
        ...Array(8).fill('MOUNTAIN'), ...Array(2).fill('DESERT')
    ].sort(() => Math.random() - 0.5);

    const tokens = [2,2,3,3,3,4,4,4,4,5,5,5,5,6,6,6,8,8,8,9,9,9,9,10,10,10,10,11,11,11,12,12]
        .sort(() => Math.random() - 0.5);

    let hexes = [], nodes = [], id = 0, tokenIdx = 0;
    const rings = 3;

    for (let q = -rings; q <= rings; q++) {
        let r1 = Math.max(-rings, -q - rings);
        let r2 = Math.min(rings, -q + rings);
        for (let r = r1; r <= r2; r++) {
            const type = tileTypes[id % tileTypes.length];
            const num = type === 'DESERT' ? null : (tokens[tokenIdx++] || 7);
            const x = 40 * (Math.sqrt(3) * q + Math.sqrt(3)/2 * r);
            const y = 40 * (3/2 * r);

            hexes.push({ id, q, r, type, number: num, cx: x, cy: y });

            // ノード（交差点）の生成
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 3) * i - (Math.PI / 6);
                const nx = Math.round(x + 40 * Math.cos(angle));
                const ny = Math.round(y + 40 * Math.sin(angle));
                if (!nodes.some(n => Math.hypot(n.x - nx, n.y - ny) < 5)) {
                    nodes.push({ id: nodes.length, x: nx, y: ny, owner: null, type: null });
                }
            }
            id++;
        }
    }

    const deserts = hexes.filter(h => h.type === 'DESERT').map(h => h.id);
    return { hexes, nodes, robbers: deserts.length >= 2 ? [deserts[0], deserts[1]] : [0, 1] };
}

// サーバー側での資源自動分配計算
function distributeResourcesServer(room, rolledNum) {
    const resMap = { FOREST: 'wood', HILL: 'brick', FIELD: 'wheat', PASTURE: 'wool', MOUNTAIN: 'ore' };
    const matchingHexes = room.board.hexes.filter(h => h.number === rolledNum);

    matchingHexes.forEach(hex => {
        if (room.board.robbers.includes(hex.id)) return; // 盗賊がいるマスはスキップ
        const resType = resMap[hex.type];
        if (!resType) return;

        room.board.nodes.forEach(node => {
            if (node.owner !== null && Math.hypot(node.x - hex.cx, node.y - hex.cy) < 50) {
                const amount = node.type === 'city' ? 2 : 1;
                const player = room.players.find(p => p.id === node.owner);
                if (player) {
                    player.resources[resType] = (player.resources[resType] || 0) + amount;
                }
            }
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Catan Server running on port ${PORT}`));