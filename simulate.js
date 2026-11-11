'use strict';
// 3〜8人のボット対戦でエンジンを検証する: node simulate.js
const { Game, COSTS, RES, describeTier } = require('./game');

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const COLORS = ['#e74c3c', '#3498db', '#ffffff', '#e67e22', '#9b59b6', '#fd79a8', '#00cec9', '#2d3436'];

function checkInvariants(g, expectBank) {
  RES.forEach((r) => {
    const sum = g.bank[r] + g.players.reduce((s, p) => s + p.res[r], 0);
    if (sum !== expectBank) throw new Error(`資源保存則違反 ${r}: ${sum} != ${expectBank}`);
    if (g.bank[r] < 0 || g.players.some((p) => p.res[r] < 0)) throw new Error('負の資源');
  });
  g.players.forEach((p) => {
    const roads = g.edges.filter((e) => e.owner === p.id).length;
    const st = g.nodes.filter((n) => n.owner === p.id && n.type === 'settlement').length;
    const ci = g.nodes.filter((n) => n.owner === p.id && n.type === 'city').length;
    if (roads + p.pieces.road !== 15 || st + p.pieces.settlement !== 5 || ci + p.pieces.city !== 4) throw new Error('駒数の不整合');
  });
  // 間隔ルール
  g.nodes.forEach((n) => { if (n.owner && n.adj.some((a) => g.nodes[a].owner)) throw new Error('間隔ルール違反'); });
}

function botMain(g, pid) {
  const p = g.p(pid);
  const must = (r) => { if (r.error) throw new Error('bot error: ' + r.error); };
  for (let i = 0; i < 12; i++) {
    const L = g.legalFor(pid);
    if (g.canPay(p, COSTS.city) && L.city.length) { must(g.buildStructure(pid, 'city', pick(L.city))); continue; }
    if (g.canPay(p, COSTS.settlement) && L.settlement.length) { must(g.buildStructure(pid, 'settlement', pick(L.settlement))); continue; }
    if (g.canPay(p, COSTS.road) && L.road.length && Math.random() < 0.8) { must(g.buildStructure(pid, 'road', pick(L.road))); continue; }
    if (g.canPay(p, COSTS.dev) && g.deck.length) { must(g.buyDevelopment(pid)); continue; }
    // 銀行交易（特別建設フェーズでは不可）
    const have = g.phase === 'MAIN' ? RES.filter((r) => p.res[r] >= g.ratioFor(p, r)) : [];
    if (have.length) {
      const give = pick(have), get = pick(RES.filter((r) => r !== give));
      if (g.bank[get] > 0) { must(g.bankTrade(pid, give, get)); continue; }
    }
    break;
  }
  // プレイヤー間交易（提案→承諾→成立）
  if (g.phase === 'MAIN' && Math.random() < 0.3) {
    const give = pick(RES), want = pick(RES.filter((r) => r !== give));
    if (p.res[give] > 0) {
      const gv = {}, wt = {}; gv[give] = 1; wt[want] = 1;
      if (!g.proposeTrade(pid, gv, wt).error) {
        g.players.forEach((o) => { if (o.id !== pid) g.respondTrade(o.id, Math.random() < 0.5); });
        if (g.trade.accepted.length) must(g.confirmTrade(pid, g.trade.accepted[0])); else g.cancelTrade(pid);
      }
    }
  }
}

function playDevCards(g, pid) {
  const p = g.p(pid);
  if (g.devPlayed || Math.random() < 0.3) return;
  const playable = p.dev.filter((c) => c.turn < g.turnNo && c.type !== 'vp').map((c) => c.type);
  if (!playable.length) return;
  const card = pick(playable);
  if (card === 'yearofplenty') g.playDev(pid, card, { res: [pick(RES), pick(RES)] });
  else if (card === 'monopoly') g.playDev(pid, card, { res: pick(RES) });
  else g.playDev(pid, card);
  // 街道建設
  while (g.freeRoads > 0) {
    const L = g.legalFor(pid);
    if (g.buildStructure(pid, 'road', pick(L.road)).error) { g.freeRoads = 0; break; }
  }
}

function playGame(n, maxSteps = 60000) {
  const plist = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + (i + 1), color: COLORS[i] }));
  const g = new Game(plist, {});
  const bankInit = g.cfg.bank;
  let steps = 0;
  while (g.phase !== 'GAME_OVER' && steps++ < maxSteps) {
    g.drain();
    if (g.phase === 'SETUP') { g.autoAct(g.setupPlayer().id); continue; }
    const pendingIds = Object.keys(g.discardPending);
    if (pendingIds.length) { if (!g.autoAct(pendingIds[0])) throw new Error('discard stuck'); checkInvariants(g, bankInit); continue; }
    if (g.robberPending) { if (!g.autoAct(g.robberPending.by)) throw new Error('robber stuck'); continue; }
    if (g.phase === 'MAIN') {
      const pid = g.players[g.activeIdx].id;
      if (!g.turnRolled) {
        if (Math.random() < 0.4) playDevCards(g, pid);
        if (g.robberPending) continue;
        const r = g.rollDice(pid); if (r.error) throw new Error(r.error);
        checkInvariants(g, bankInit);
        continue;
      }
      botMain(g, pid);
      playDevCards(g, pid);
      if (g.robberPending) continue;
      if (g.phase === 'GAME_OVER') break;
      const e = g.endTurn(pid); if (e.error) throw new Error(e.error);
      checkInvariants(g, bankInit);
      continue;
    }
    if (g.phase === 'SPECIAL') {
      const pid = g.specialBuilder().id;
      botMain(g, pid);
      const e = g.endSpecial(pid); if (e.error) throw new Error(e.error);
      checkInvariants(g, bankInit);
      continue;
    }
  }
  checkInvariants(g, bankInit);
  return { g, steps, finished: g.phase === 'GAME_OVER' };
}

let failed = false;
for (let n = 3; n <= 8; n++) {
  const d = describeTier(n);
  let finished = 0, turns = 0, maxRoad = 0;
  const RUNS = 8;
  for (let i = 0; i < RUNS; i++) {
    try {
      const r = playGame(n);
      if (r.finished) { finished++; turns += r.g.turnNo; }
      maxRoad = Math.max(maxRoad, ...r.g.players.map((p) => p.longest));
      if (i === 0) {
        const g = r.g;
        if (n === 3 || n === 5 || n === 7) {
          console.log(`  [${n}人] hex=${g.hexes.length} nodes=${g.nodes.length} edges=${g.edges.length} ports=${g.board.ports.length}`);
          g.nodes.forEach((nd) => { if (nd.hexIds.length < 1 || nd.hexIds.length > 3) throw new Error('node hex count'); });
        }
      }
    } catch (e) {
      failed = true;
      console.log(`❌ ${n}人: ${e.stack}`);
      break;
    }
  }
  console.log(`${n}人 (${d.label}): ${finished}/${RUNS} 試合が決着, 平均ターン数=${finished ? Math.round(turns / finished) : '-'}, 最長街道最大=${maxRoad}`);
}
if (failed) { console.log('テスト失敗'); process.exit(1); }
console.log('すべてのテスト合格');
