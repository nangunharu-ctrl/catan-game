'use strict';
/**
 * カタン ゲームエンジン（3〜8人）
 *  - 3〜4人 : 標準ルール（19タイル）
 *  - 5〜6人 : 公式拡張準拠（30タイル・特別建設フェーズ）
 *  - 7〜8人 : 拡張スケール版（37タイル・特別建設フェーズ・カード増量）
 * ルール判定は全てここ（サーバー側）で行う。
 */

const SQRT3 = Math.sqrt(3);
const SIZE = 40;
const RES = ['wood', 'brick', 'wheat', 'wool', 'ore'];
const RES_JA = { wood: '木材', brick: 'レンガ', wheat: '小麦', wool: '羊毛', ore: '鉱石' };
const TERRAIN_RES = { forest: 'wood', hill: 'brick', field: 'wheat', pasture: 'wool', mountain: 'ore' };
const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, wheat: 1, wool: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { wheat: 1, wool: 1, ore: 1 },
};
const MAX_PLAYERS = 8;
const MIN_PLAYERS = parseInt(process.env.CATAN_MIN_PLAYERS || '3', 10);

const expand = (o) => Object.entries(o).flatMap(([n, c]) => Array(c).fill(Number(n)));

const CONFIGS = {
  standard: {
    tier: 'standard',
    label: '標準ルール（19タイル）',
    rows: [3, 4, 5, 4, 3],
    tiles: { forest: 4, pasture: 4, field: 4, hill: 3, mountain: 3, desert: 1 },
    numbers: expand({ 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 }),
    ports: { generic: 4, specificEach: 1 },
    bank: 19,
    dev: { knight: 14, vp: 5, roadbuilding: 2, yearofplenty: 2, monopoly: 2 },
    sbp: false,
    defaultTarget: 10,
  },
  ext56: {
    tier: 'ext56',
    label: '5-6人拡張（30タイル・特別建設フェーズ）',
    rows: [3, 4, 5, 6, 5, 4, 3],
    tiles: { forest: 6, pasture: 6, field: 6, hill: 5, mountain: 5, desert: 2 },
    numbers: expand({ 2: 2, 3: 3, 4: 3, 5: 3, 6: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 2 }),
    ports: { generic: 6, specificEach: 1 },
    bank: 24,
    dev: { knight: 20, vp: 5, roadbuilding: 3, yearofplenty: 3, monopoly: 3 },
    sbp: true,
    defaultTarget: 10,
  },
  ext78: {
    tier: 'ext78',
    label: '7-8人拡張（37タイル・特別建設フェーズ）',
    rows: [4, 5, 6, 7, 6, 5, 4],
    tiles: { forest: 7, pasture: 7, field: 7, hill: 7, mountain: 6, desert: 3 },
    numbers: expand({ 2: 2, 3: 3, 4: 4, 5: 4, 6: 4, 8: 4, 9: 4, 10: 4, 11: 3, 12: 2 }),
    ports: { generic: 4, specificEach: 2 },
    bank: 30,
    dev: { knight: 26, vp: 7, roadbuilding: 4, yearofplenty: 4, monopoly: 4 },
    sbp: true,
    defaultTarget: 12,
  },
};
function getConfig(n) {
  return n <= 4 ? CONFIGS.standard : n <= 6 ? CONFIGS.ext56 : CONFIGS.ext78;
}
function describeTier(n) {
  const c = getConfig(n);
  return {
    tier: c.tier, label: c.label, hexes: c.rows.reduce((a, b) => a + b, 0),
    sbp: c.sbp, bank: c.bank, defaultTarget: c.defaultTarget,
    devCards: Object.values(c.dev).reduce((a, b) => a + b, 0),
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const d6 = () => 1 + Math.floor(Math.random() * 6);
const emptyRes = () => ({ wood: 0, brick: 0, wheat: 0, wool: 0, ore: 0 });
const err = (m) => ({ error: m });
const OK = { ok: true };

/* ------------------------------------------------------------------ */
/* 盤面生成                                                             */
/* ------------------------------------------------------------------ */
function buildBoard(cfg) {
  const rows = cfg.rows;
  const hexes = [];
  let id = 0;
  rows.forEach((n, ri) => {
    for (let i = 0; i < n; i++) {
      hexes.push({
        id: id++, cx: (i - (n - 1) / 2) * SQRT3 * SIZE, cy: (ri - (rows.length - 1) / 2) * 1.5 * SIZE,
        type: null, number: null, nodeIds: [], adjHex: [],
      });
    }
  });
  const D = SQRT3 * SIZE;
  hexes.forEach((a) => hexes.forEach((b) => {
    if (a.id < b.id && Math.hypot(a.cx - b.cx, a.cy - b.cy) < D + 1) { a.adjHex.push(b.id); b.adjHex.push(a.id); }
  }));

  // 地形と数値トークン（赤い数字 6/8 が隣り合わないように配置）
  const types = [];
  Object.entries(cfg.tiles).forEach(([t, c]) => { for (let i = 0; i < c; i++) types.push(t); });
  if (types.length !== hexes.length) throw new Error('tile count mismatch');
  const landCount = types.filter((t) => t !== 'desert').length;
  if (cfg.numbers.length !== landCount) throw new Error('number token count mismatch');
  for (let attempt = 0; attempt < 3000; attempt++) {
    shuffle(types);
    const nums = shuffle(cfg.numbers.slice());
    let k = 0;
    hexes.forEach((h, i) => { h.type = types[i]; h.number = h.type === 'desert' ? null : nums[k++]; });
    const red = (h) => h.number === 6 || h.number === 8;
    const bad = hexes.some((h) => red(h) && h.adjHex.some((j) => red(hexes[j])));
    if (!bad) break;
  }

  // 交差点と辺
  const nodes = [], nodeMap = new Map(), edges = [], edgeMap = new Map();
  hexes.forEach((h) => {
    const ids = [];
    for (let k = 0; k < 6; k++) {
      const ang = (Math.PI / 180) * (60 * k - 30);
      const x = h.cx + SIZE * Math.cos(ang), y = h.cy + SIZE * Math.sin(ang);
      const key = Math.round(x * 10) + ',' + Math.round(y * 10);
      let n = nodeMap.get(key);
      if (!n) {
        n = { id: nodes.length, x, y, hexIds: [], adj: [], edgeIds: [], port: null, owner: null, type: null };
        nodes.push(n); nodeMap.set(key, n);
      }
      if (!n.hexIds.includes(h.id)) n.hexIds.push(h.id);
      ids.push(n.id);
    }
    h.nodeIds = ids;
    for (let k = 0; k < 6; k++) {
      const a = ids[k], b = ids[(k + 1) % 6];
      const ek = a < b ? a + '-' + b : b + '-' + a;
      let e = edgeMap.get(ek);
      if (!e) {
        e = { id: edges.length, a: Math.min(a, b), b: Math.max(a, b), hexIds: [], owner: null };
        edges.push(e); edgeMap.set(ek, e);
        nodes[a].adj.push(b); nodes[b].adj.push(a);
        nodes[a].edgeIds.push(e.id); nodes[b].edgeIds.push(e.id);
      }
      e.hexIds.push(h.id);
    }
  });

  // 港（海岸の辺に等間隔で配置）
  const coast = edges.filter((e) => e.hexIds.length === 1);
  coast.forEach((e) => {
    const A = nodes[e.a], B = nodes[e.b];
    e.mx = (A.x + B.x) / 2; e.my = (A.y + B.y) / 2; e.ang = Math.atan2(e.my, e.mx);
  });
  coast.sort((p, q) => p.ang - q.ang);
  const portTypes = [];
  for (let i = 0; i < cfg.ports.generic; i++) portTypes.push('any');
  RES.forEach((r) => { for (let i = 0; i < cfg.ports.specificEach; i++) portTypes.push(r); });
  shuffle(portTypes);
  const step = coast.length / portTypes.length;
  let picks = null;
  for (let off = 0; off < coast.length && !picks; off++) {
    const idxs = portTypes.map((_, i) => (Math.floor(off + i * step)) % coast.length);
    const used = new Set(); let ok = true;
    for (const ix of idxs) {
      const e = coast[ix];
      if (used.has(e.a) || used.has(e.b)) { ok = false; break; }
      used.add(e.a); used.add(e.b);
    }
    if (ok) picks = idxs;
  }
  if (!picks) picks = portTypes.map((_, i) => Math.floor(i * step));
  const ports = picks.map((ix, i) => {
    const e = coast[ix], type = portTypes[i], ratio = type === 'any' ? 3 : 2;
    nodes[e.a].port = { type, ratio }; nodes[e.b].port = { type, ratio };
    const h = hexes[e.hexIds[0]];
    const ox = e.mx - h.cx, oy = e.my - h.cy, len = Math.hypot(ox, oy) || 1;
    return { a: e.a, b: e.b, type, ratio, mx: e.mx, my: e.my, ox: ox / len, oy: oy / len };
  });
  return { hexes, nodes, edges, ports };
}

/* ------------------------------------------------------------------ */
/* ゲーム本体                                                           */
/* ------------------------------------------------------------------ */
class Game {
  constructor(plist, opts = {}) {
    const n = plist.length;
    this.cfg = getConfig(n);
    this.board = buildBoard(this.cfg);
    this.targetScore = Math.max(10, Math.min(14, parseInt(opts.targetScore, 10) || this.cfg.defaultTarget));

    // 先攻決め：全員がダイスを振り、最大の目が先攻（同点はランダム）
    const rolls = plist.map(() => d6() + d6());
    const first = rolls.indexOf(Math.max(...rolls));
    this.firstRolls = plist.map((p, i) => ({ name: p.name, roll: rolls[i] }));
    this.players = plist.slice(first).concat(plist.slice(0, first)).map((p) => ({
      id: p.id, name: p.name, color: p.color, connected: true,
      res: emptyRes(), dev: [], knights: 0, longest: 0,
      pieces: { road: 15, settlement: 5, city: 4 },
    }));

    this.bank = {}; RES.forEach((r) => { this.bank[r] = this.cfg.bank; });
    this.deck = [];
    Object.entries(this.cfg.dev).forEach(([t, c]) => { for (let i = 0; i < c; i++) this.deck.push(t); });
    shuffle(this.deck);

    const deserts = this.board.hexes.filter((h) => h.type === 'desert');
    this.robber = deserts[Math.floor(Math.random() * deserts.length)].id;

    this.phase = 'SETUP';
    this.activeIdx = 0;
    this.turnNo = 0;
    this.turnRolled = false;
    this.devPlayed = false;
    this.freeRoads = 0;
    this.robberPending = null;
    this.discardPending = {};
    this.trade = null;
    this.tradeSeq = 0;
    this.lastRoll = null;
    this.rollSeq = 0;
    this.longestOwner = null;
    this.armyOwner = null;
    this.special = null;
    this.winner = null;
    this.msgs = [];

    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    for (let i = n - 1; i >= 0; i--) order.push(i);
    this.setup = { order, pos: 0, step: 'settlement', lastNode: null };
    this.msg(`先攻決め: ${this.firstRolls.map((r) => `${r.name}=${r.roll}`).join(' / ')}`);
    this.msg(`${this.players[0].name} から初期配置を開始します`);
  }

  /* ---------- 小物 ---------- */
  msg(t) { this.msgs.push(t); }
  drain() { const m = this.msgs; this.msgs = []; return m; }
  p(pid) { return this.players.find((x) => x.id === pid); }
  idx(pid) { return this.players.findIndex((x) => x.id === pid); }
  total(p) { return RES.reduce((s, r) => s + p.res[r], 0); }
  canPay(p, cost) { return Object.entries(cost).every(([r, n]) => p.res[r] >= n); }
  pay(p, cost) { Object.entries(cost).forEach(([r, n]) => { p.res[r] -= n; this.bank[r] += n; }); }
  gain(p, r, n) { p.res[r] += n; this.bank[r] -= n; }
  get nodes() { return this.board.nodes; }
  get edges() { return this.board.edges; }
  get hexes() { return this.board.hexes; }
  setupPlayer() { return this.phase === 'SETUP' ? this.players[this.setup.order[this.setup.pos]] : null; }
  isActive(pid) { return this.players[this.activeIdx].id === pid; }
  blocked() { return Object.keys(this.discardPending).length > 0 || !!this.robberPending; }
  specialBuilder() { return this.phase === 'SPECIAL' ? this.players[this.special.queue[this.special.pos]] : null; }

  /** 建設・購入・交易が今できる文脈 ('turn' | 'special' | null) */
  ctx(pid) {
    if (this.phase === 'MAIN' && this.isActive(pid) && this.turnRolled && !this.blocked()) return 'turn';
    if (this.phase === 'SPECIAL' && this.specialBuilder().id === pid) return 'special';
    return null;
  }

  publicScore(p) {
    return (5 - p.pieces.settlement) + 2 * (4 - p.pieces.city)
      + (this.longestOwner === p.id ? 2 : 0) + (this.armyOwner === p.id ? 2 : 0);
  }
  vpCards(p) { return p.dev.filter((c) => c.type === 'vp').length; }
  totalScore(p) { return this.publicScore(p) + this.vpCards(p); }

  checkWin() {
    if (this.phase !== 'MAIN') return;
    const p = this.players[this.activeIdx];
    if (this.totalScore(p) >= this.targetScore) {
      this.phase = 'GAME_OVER';
      this.winner = { id: p.id, name: p.name, score: this.totalScore(p) };
      this.msg(`🎉 ${p.name} が ${this.winner.score} 点で勝利！`);
    }
  }

  /* ---------- 盤面ロジック ---------- */
  legalSettlementNodes(pid, needRoad) {
    const nodes = this.nodes, edges = this.edges;
    return nodes.filter((n) => !n.owner && n.adj.every((a) => !nodes[a].owner)
      && (!needRoad || n.edgeIds.some((eid) => edges[eid].owner === pid))).map((n) => n.id);
  }
  legalRoadEdges(pid) {
    const nodes = this.nodes, edges = this.edges;
    const connected = (nid) => {
      const n = nodes[nid];
      if (n.owner === pid) return true;
      if (n.owner) return false; // 他人の開拓地・都市は通過できない
      return n.edgeIds.some((id) => edges[id].owner === pid);
    };
    return edges.filter((e) => !e.owner && (connected(e.a) || connected(e.b))).map((e) => e.id);
  }
  legalCityNodes(pid) {
    return this.nodes.filter((n) => n.owner === pid && n.type === 'settlement').map((n) => n.id);
  }
  legalFor(pid) {
    const L = { settlement: [], city: [], road: [], robberHexes: [] };
    const me = this.p(pid);
    if (!me) return L;
    if (this.phase === 'SETUP') {
      const cur = this.setupPlayer();
      if (!cur || cur.id !== pid) return L;
      if (this.setup.step === 'settlement') L.settlement = this.legalSettlementNodes(pid, false);
      else L.road = this.nodes[this.setup.lastNode].edgeIds.filter((id) => !this.edges[id].owner);
      return L;
    }
    if (this.robberPending && this.robberPending.by === pid) {
      L.robberHexes = this.hexes.filter((h) => h.id !== this.robber).map((h) => h.id);
      return L;
    }
    if (this.phase === 'MAIN' && this.isActive(pid) && this.freeRoads > 0 && !this.blocked()) {
      L.road = this.legalRoadEdges(pid);
      return L;
    }
    if (this.ctx(pid)) {
      if (me.pieces.settlement > 0) L.settlement = this.legalSettlementNodes(pid, true);
      if (me.pieces.city > 0) L.city = this.legalCityNodes(pid);
      if (me.pieces.road > 0) L.road = this.legalRoadEdges(pid);
    }
    return L;
  }

  roadLength(pid) {
    const own = this.edges.filter((e) => e.owner === pid);
    if (!own.length) return 0;
    const byNode = new Map();
    own.forEach((e) => [e.a, e.b].forEach((n) => { if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(e); }));
    let best = 0;
    const used = new Set();
    const nodes = this.nodes;
    const dfs = (node, len) => {
      if (len > best) best = len;
      for (const e of byNode.get(node) || []) {
        if (used.has(e.id)) continue;
        used.add(e.id);
        const other = e.a === node ? e.b : e.a;
        const blocked = nodes[other].owner && nodes[other].owner !== pid;
        if (blocked) { if (len + 1 > best) best = len + 1; } else dfs(other, len + 1);
        used.delete(e.id);
      }
    };
    for (const n of byNode.keys()) dfs(n, 0);
    return best;
  }
  updateLongestRoad() {
    this.players.forEach((p) => { p.longest = this.roadLength(p.id); });
    const max = Math.max(...this.players.map((p) => p.longest));
    const prev = this.longestOwner;
    if (max < 5) this.longestOwner = null;
    else {
      const holder = prev ? this.p(prev) : null;
      if (holder && holder.longest === max) { /* 同数なら現保持者が維持 */ }
      else {
        const top = this.players.filter((p) => p.longest === max);
        this.longestOwner = top.length === 1 ? top[0].id : null;
      }
    }
    if (prev !== this.longestOwner) {
      this.msg(this.longestOwner ? `🛣️ ${this.p(this.longestOwner).name} が最長交易路を獲得（${max}本）` : '🛣️ 最長交易路は誰のものでもなくなりました');
    }
  }
  updateLargestArmy(p) {
    if (p.knights < 3) return;
    const holder = this.armyOwner ? this.p(this.armyOwner) : null;
    if (!holder || p.knights > holder.knights) {
      if (this.armyOwner !== p.id) this.msg(`⚔️ ${p.name} が最大騎士力を獲得（騎士${p.knights}枚）`);
      this.armyOwner = p.id;
    }
  }
  ratioFor(p, give) {
    let best = 4;
    this.nodes.forEach((n) => {
      if (n.owner !== p.id || !n.port) return;
      if (n.port.type === 'any') best = Math.min(best, 3);
      else if (n.port.type === give) best = Math.min(best, 2);
    });
    return best;
  }

  /* ---------- 初期配置 ---------- */
  setupSettlement(pid, nodeId) {
    const cur = this.setupPlayer();
    if (!cur || cur.id !== pid) return err('あなたの初期配置の番ではありません');
    if (this.setup.step !== 'settlement') return err('先に街道を置いてください');
    if (!this.legalSettlementNodes(pid, false).includes(nodeId)) return err('そこには置けません（間隔ルール：隣接する交差点が空いている必要があります）');
    const node = this.nodes[nodeId];
    node.owner = pid; node.type = 'settlement'; cur.pieces.settlement--;
    if (this.setup.pos >= this.players.length) { // 2つ目の開拓地：接する地形から1枚ずつ
      const got = [];
      node.hexIds.forEach((hid) => {
        const h = this.hexes[hid], r = TERRAIN_RES[h.type];
        if (r && this.bank[r] > 0) { this.gain(cur, r, 1); got.push(RES_JA[r]); }
      });
      if (got.length) this.msg(`${cur.name} の初期資源: ${got.join('・')}`);
    }
    this.setup.step = 'road'; this.setup.lastNode = nodeId;
    return OK;
  }
  setupRoad(pid, edgeId) {
    const cur = this.setupPlayer();
    if (!cur || cur.id !== pid) return err('あなたの初期配置の番ではありません');
    if (this.setup.step !== 'road') return err('先に開拓地を置いてください');
    const e = this.edges[edgeId];
    if (!e || e.owner) return err('そこには置けません');
    if (e.a !== this.setup.lastNode && e.b !== this.setup.lastNode) return err('今置いた開拓地に接する街道を置いてください');
    e.owner = pid; cur.pieces.road--;
    this.setup.pos++; this.setup.step = 'settlement'; this.setup.lastNode = null;
    if (this.setup.pos >= this.setup.order.length) {
      this.phase = 'MAIN'; this.activeIdx = 0; this.turnNo = 1; this.turnRolled = false; this.devPlayed = false;
      this.msg(`ゲーム開始！ ${this.players[0].name} のターン`);
    }
    return OK;
  }

  /* ---------- ダイス・産出・盗賊 ---------- */
  rollDice(pid) {
    if (this.phase !== 'MAIN' || !this.isActive(pid)) return err('あなたのターンではありません');
    if (this.turnRolled) return err('既にダイスを振りました');
    if (this.blocked()) return err('先に盗賊の処理を終えてください');
    const dice = [d6(), d6()], total = dice[0] + dice[1];
    this.lastRoll = { dice, total, by: pid, seq: ++this.rollSeq };
    this.turnRolled = true;
    if (total === 7) this.handleSeven(pid);
    else this.produce(total);
    return OK;
  }
  produce(total) {
    const demand = {}; // res -> pid -> n
    this.hexes.forEach((h) => {
      if (h.number !== total || h.id === this.robber) return;
      const r = TERRAIN_RES[h.type];
      h.nodeIds.forEach((nid) => {
        const n = this.nodes[nid];
        if (!n.owner) return;
        demand[r] = demand[r] || {};
        demand[r][n.owner] = (demand[r][n.owner] || 0) + (n.type === 'city' ? 2 : 1);
      });
    });
    const gains = {};
    Object.entries(demand).forEach(([r, per]) => {
      const sum = Object.values(per).reduce((a, b) => a + b, 0);
      const pids = Object.keys(per);
      if (this.bank[r] >= sum) {
        pids.forEach((pid) => { this.gain(this.p(pid), r, per[pid]); (gains[pid] = gains[pid] || []).push(`${RES_JA[r]}+${per[pid]}`); });
      } else if (pids.length === 1) { // 受け取るのが1人だけなら山札の残りを全部渡す
        const pid = pids[0], n = this.bank[r];
        if (n > 0) { this.gain(this.p(pid), r, n); (gains[pid] = gains[pid] || []).push(`${RES_JA[r]}+${n}`); }
      } else {
        this.msg(`${RES_JA[r]} は山札が足りず、誰も受け取れません`);
      }
    });
    const lines = Object.entries(gains).map(([pid, g]) => `${this.p(pid).name}: ${g.join(' ')}`);
    this.msg(lines.length ? `産出 → ${lines.join(' / ')}` : '誰も資源を得られませんでした');
  }
  handleSeven(pid) {
    this.discardPending = {};
    this.players.forEach((p) => {
      const t = this.total(p);
      if (t > 7) this.discardPending[p.id] = Math.floor(t / 2);
    });
    const names = Object.keys(this.discardPending).map((id) => this.p(id).name);
    this.msg(names.length ? `7が出ました！ ${names.join('・')} は半分を廃棄します` : '7が出ました！ 盗賊を移動します');
    if (!names.length) this.robberPending = { by: pid, reason: 'seven' };
  }
  discard(pid, res) {
    const need = this.discardPending[pid];
    if (!need) return err('廃棄の必要はありません');
    const p = this.p(pid);
    let sum = 0;
    for (const r of RES) {
      const n = Math.floor(Number(res && res[r]) || 0);
      if (n < 0 || n > p.res[r]) return err('持っていない資源は廃棄できません');
      sum += n;
    }
    if (sum !== need) return err(`ちょうど ${need} 枚を選んでください`);
    RES.forEach((r) => { const n = Math.floor(Number(res[r]) || 0); p.res[r] -= n; this.bank[r] += n; });
    delete this.discardPending[pid];
    this.msg(`${p.name} が ${need} 枚を廃棄しました`);
    if (!Object.keys(this.discardPending).length) {
      this.robberPending = { by: this.players[this.activeIdx].id, reason: 'seven' };
    }
    return OK;
  }
  moveRobber(pid, hexId, targetId) {
    if (!this.robberPending || this.robberPending.by !== pid) return err('盗賊を動かせません');
    const hex = this.hexes[hexId];
    if (!hex) return err('その地形は存在しません');
    if (hexId === this.robber) return err('盗賊は必ず別の地形に動かしてください');
    const victims = [...new Set(hex.nodeIds.map((id) => this.nodes[id].owner).filter((o) => o && o !== pid))];
    if (victims.length && !victims.includes(targetId)) {
      if (victims.length === 1 && !targetId) targetId = victims[0];
      else return err('資源を奪う相手を選んでください');
    }
    if (!victims.length) targetId = null;
    this.robber = hexId;
    const me = this.p(pid);
    let text = `${me.name} が盗賊を移動`;
    if (targetId) {
      const v = this.p(targetId);
      const pool = [];
      RES.forEach((r) => { for (let i = 0; i < v.res[r]; i++) pool.push(r); });
      if (pool.length) {
        const r = pool[Math.floor(Math.random() * pool.length)];
        v.res[r]--; me.res[r]++;
        text += `、${v.name} から1枚奪いました`;
      } else text += `（${v.name} は手札なし）`;
    }
    this.msg(text);
    this.robberPending = null;
    return OK;
  }

  /* ---------- 建設・発展カード ---------- */
  buildStructure(pid, type, id) {
    const p = this.p(pid);
    if (!p) return err('不明なプレイヤー');
    const free = type === 'road' && this.phase === 'MAIN' && this.isActive(pid) && this.freeRoads > 0 && !this.blocked();
    if (!free && !this.ctx(pid)) return err('今は建設できません（ダイスを振った後の自分のターン／特別建設中のみ）');
    if (type === 'road') {
      if (p.pieces.road <= 0) return err('街道の駒がありません');
      if (!this.legalRoadEdges(pid).includes(id)) return err('そこには街道を敷設できません');
      if (!free) { if (!this.canPay(p, COSTS.road)) return err('資源が足りません'); this.pay(p, COSTS.road); }
      this.edges[id].owner = pid; p.pieces.road--;
      if (free) {
        this.freeRoads--;
        if (this.freeRoads > 0 && (p.pieces.road <= 0 || !this.legalRoadEdges(pid).length)) this.freeRoads = 0;
      }
      this.updateLongestRoad();
    } else if (type === 'settlement') {
      if (p.pieces.settlement <= 0) return err('開拓地の駒がありません（都市にアップグレードすると戻ります）');
      if (!this.legalSettlementNodes(pid, true).includes(id)) return err('そこには開拓地を建設できません（自分の街道に接し、隣の交差点が空いている必要があります）');
      if (!this.canPay(p, COSTS.settlement)) return err('資源が足りません');
      this.pay(p, COSTS.settlement);
      this.nodes[id].owner = pid; this.nodes[id].type = 'settlement'; p.pieces.settlement--;
      this.updateLongestRoad();
    } else if (type === 'city') {
      if (p.pieces.city <= 0) return err('都市の駒がありません');
      if (!this.legalCityNodes(pid).includes(id)) return err('自分の開拓地にだけ都市を建設できます');
      if (!this.canPay(p, COSTS.city)) return err('資源が足りません');
      this.pay(p, COSTS.city);
      this.nodes[id].type = 'city'; p.pieces.city--; p.pieces.settlement++;
    } else return err('不明な建設タイプ');
    this.msg(`${p.name} が${{ road: '街道', settlement: '開拓地', city: '都市' }[type]}を建設${free ? '（無料）' : ''}`);
    this.checkWin();
    return OK;
  }
  buyDevelopment(pid) {
    const p = this.p(pid);
    if (!this.ctx(pid)) return err('今は購入できません');
    if (!this.deck.length) return err('発展カードの山札がありません');
    if (!this.canPay(p, COSTS.dev)) return err('資源が足りません（羊1・麦1・鉄1）');
    this.pay(p, COSTS.dev);
    const type = this.deck.pop();
    p.dev.push({ type, turn: this.turnNo });
    this.msg(`${p.name} が発展カードを購入（残り${this.deck.length}枚）`);
    this.checkWin();
    return OK;
  }
  playDev(pid, card, params = {}) {
    const p = this.p(pid);
    if (this.phase !== 'MAIN' || !this.isActive(pid)) return err('自分のターンにのみ使えます');
    if (this.blocked() || this.freeRoads > 0) return err('今は使えません');
    if (this.devPlayed) return err('発展カードは1ターンに1枚までです');
    if (!['knight', 'roadbuilding', 'yearofplenty', 'monopoly'].includes(card)) return err('そのカードは使えません');
    const ci = p.dev.findIndex((c) => c.type === card && c.turn < this.turnNo);
    if (ci < 0) return err('使えるカードがありません（購入したターンには使えません）');
    if (card === 'roadbuilding') {
      if (p.pieces.road <= 0 || !this.legalRoadEdges(pid).length) return err('街道を置ける場所がありません');
    }
    if (card === 'yearofplenty') {
      const rs = params.res;
      if (!Array.isArray(rs) || rs.length !== 2 || !rs.every((r) => RES.includes(r))) return err('資源を2つ選んでください');
      const need = emptyRes(); rs.forEach((r) => need[r]++);
      if (RES.some((r) => this.bank[r] < need[r])) return err('山札に資源が足りません');
    }
    if (card === 'monopoly' && !RES.includes(params.res)) return err('資源を1つ選んでください');

    p.dev.splice(ci, 1);
    this.devPlayed = true;
    if (card === 'knight') {
      p.knights++; this.updateLargestArmy(p);
      this.robberPending = { by: pid, reason: 'knight' };
      this.msg(`${p.name} が騎士カードを使用`);
    } else if (card === 'roadbuilding') {
      this.freeRoads = Math.min(2, p.pieces.road);
      this.msg(`${p.name} が街道建設カードを使用`);
    } else if (card === 'yearofplenty') {
      params.res.forEach((r) => this.gain(p, r, 1));
      this.msg(`${p.name} が収穫カードで ${params.res.map((r) => RES_JA[r]).join('・')} を獲得`);
    } else if (card === 'monopoly') {
      const r = params.res; let sum = 0;
      this.players.forEach((o) => { if (o.id !== pid) { sum += o.res[r]; p.res[r] += o.res[r]; o.res[r] = 0; } });
      this.msg(`${p.name} が独占カードで ${RES_JA[r]} を ${sum} 枚獲得`);
    }
    this.checkWin();
    return OK;
  }

  /* ---------- 交易 ---------- */
  bankTrade(pid, give, get) {
    if (this.ctx(pid) !== 'turn') return err('今は交易できません');
    if (!RES.includes(give) || !RES.includes(get) || give === get) return err('資源の指定が正しくありません');
    const p = this.p(pid), ratio = this.ratioFor(p, give);
    if (p.res[give] < ratio) return err(`${RES_JA[give]}が${ratio}枚必要です（${ratio}:1）`);
    if (this.bank[get] < 1) return err('山札にその資源がありません');
    p.res[give] -= ratio; this.bank[give] += ratio;
    this.gain(p, get, 1);
    this.msg(`${p.name} が銀行交易 ${RES_JA[give]}×${ratio} → ${RES_JA[get]}×1`);
    return OK;
  }
  normRes(o) {
    const r = emptyRes(); let sum = 0;
    RES.forEach((k) => { const n = Math.max(0, Math.floor(Number(o && o[k]) || 0)); r[k] = n; sum += n; });
    return { r, sum };
  }
  proposeTrade(pid, give, want) {
    if (this.ctx(pid) !== 'turn') return err('今は交易を提案できません');
    const g = this.normRes(give), w = this.normRes(want);
    if (!g.sum || !w.sum) return err('渡す資源と受け取る資源の両方を指定してください');
    if (RES.some((r) => g.r[r] > 0 && w.r[r] > 0)) return err('同じ種類の資源を含む交換はできません');
    const p = this.p(pid);
    if (RES.some((r) => p.res[r] < g.r[r])) return err('渡す資源が足りません');
    this.trade = { id: ++this.tradeSeq, from: pid, give: g.r, want: w.r, accepted: [], declined: [] };
    this.msg(`${p.name} が交易を提案しました`);
    return OK;
  }
  respondTrade(pid, accept) {
    const t = this.trade;
    if (!t || t.from === pid) return err('応答できる交易がありません');
    if (this.phase !== 'MAIN') return err('今は応答できません');
    if (t.accepted.includes(pid) || t.declined.includes(pid)) return err('既に応答済みです');
    const p = this.p(pid);
    if (accept) {
      if (RES.some((r) => p.res[r] < t.want[r])) return err('資源が足りません');
      t.accepted.push(pid);
    } else t.declined.push(pid);
    return OK;
  }
  confirmTrade(pid, withId) {
    const t = this.trade;
    if (!t || t.from !== pid) return err('成立させる交易がありません');
    if (!t.accepted.includes(withId)) return err('その相手は承諾していません');
    const a = this.p(pid), b = this.p(withId);
    if (RES.some((r) => a.res[r] < t.give[r] || b.res[r] < t.want[r])) { this.trade = null; return err('資源が足りなくなったため交易は無効になりました'); }
    RES.forEach((r) => { a.res[r] += t.want[r] - t.give[r]; b.res[r] += t.give[r] - t.want[r]; });
    this.msg(`🤝 ${a.name} と ${b.name} の交易が成立`);
    this.trade = null;
    return OK;
  }
  cancelTrade(pid) {
    if (!this.trade || this.trade.from !== pid) return err('取り消せる交易がありません');
    this.trade = null;
    return OK;
  }

  /* ---------- ターン進行 ---------- */
  endTurn(pid) {
    if (this.phase !== 'MAIN' || !this.isActive(pid)) return err('あなたのターンではありません');
    if (!this.turnRolled) return err('先にダイスを振ってください');
    if (this.blocked()) return err('先に盗賊の処理を終えてください');
    if (this.freeRoads > 0) return err('街道建設カードの街道を置いてください');
    this.trade = null;
    this.checkWin();
    if (this.phase === 'GAME_OVER') return OK;
    if (this.cfg.sbp) {
      const n = this.players.length, queue = [];
      for (let i = 1; i < n; i++) queue.push((this.activeIdx + i) % n);
      this.phase = 'SPECIAL'; this.special = { queue, pos: 0 };
      this.msg('特別建設フェーズ：他のプレイヤーが順番に建設できます');
    } else this.nextTurn();
    return OK;
  }
  endSpecial(pid) {
    if (this.phase !== 'SPECIAL' || this.specialBuilder().id !== pid) return err('あなたの特別建設ではありません');
    this.special.pos++;
    if (this.special.pos >= this.special.queue.length) this.nextTurn();
    return OK;
  }
  nextTurn() {
    this.activeIdx = (this.activeIdx + 1) % this.players.length;
    this.turnNo++; this.turnRolled = false; this.devPlayed = false;
    this.phase = 'MAIN'; this.special = null; this.freeRoads = 0; this.trade = null;
    this.msg(`${this.players[this.activeIdx].name} のターン`);
    this.checkWin();
  }

  /** 切断・放置プレイヤーの自動進行 */
  autoAct(pid) {
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    if (this.phase === 'GAME_OVER') return false;
    if (this.phase === 'SETUP') {
      const cur = this.setupPlayer();
      if (cur.id !== pid) return false;
      if (this.setup.step === 'settlement') return !this.setupSettlement(pid, pick(this.legalSettlementNodes(pid, false))).error;
      return !this.setupRoad(pid, pick(this.legalFor(pid).road)).error;
    }
    if (this.discardPending[pid]) {
      const p = this.p(pid), res = emptyRes();
      const pool = []; RES.forEach((r) => { for (let i = 0; i < p.res[r]; i++) pool.push(r); });
      shuffle(pool).slice(0, this.discardPending[pid]).forEach((r) => res[r]++);
      return !this.discard(pid, res).error;
    }
    if (this.robberPending && this.robberPending.by === pid) {
      const hexes = this.legalFor(pid).robberHexes;
      for (const hid of shuffle(hexes.slice())) {
        const vs = [...new Set(this.hexes[hid].nodeIds.map((i) => this.nodes[i].owner).filter((o) => o && o !== pid))];
        if (!this.moveRobber(pid, hid, vs[0] || null).error) return true;
      }
      return false;
    }
    if (this.phase === 'MAIN' && this.isActive(pid)) {
      this.freeRoads = 0; this.trade = null;
      if (!this.turnRolled) return !this.rollDice(pid).error;
      return !this.endTurn(pid).error;
    }
    if (this.phase === 'SPECIAL' && this.specialBuilder().id === pid) return !this.endSpecial(pid).error;
    return false;
  }

  /* ---------- クライアント向けデータ ---------- */
  configInfo() {
    return { ...describeTier(this.players.length), targetScore: this.targetScore, players: this.players.length };
  }
  staticBoard() {
    const b = this.board;
    return {
      hexes: b.hexes.map((h) => ({ id: h.id, cx: h.cx, cy: h.cy, type: h.type, number: h.number, nodeIds: h.nodeIds })),
      nodes: b.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, port: n.port })),
      edges: b.edges.map((e) => ({ id: e.id, a: e.a, b: e.b })),
      ports: b.ports,
    };
  }
  view(pid) {
    const me = this.p(pid);
    const over = this.phase === 'GAME_OVER';
    return {
      phase: this.phase,
      activeIdx: this.activeIdx,
      turnRolled: this.turnRolled,
      turnNo: this.turnNo,
      devPlayed: this.devPlayed,
      targetScore: this.targetScore,
      tier: this.cfg.tier,
      bank: this.bank,
      deckCount: this.deck.length,
      robber: this.robber,
      robberPending: this.robberPending,
      discardPending: this.discardPending,
      freeRoads: this.freeRoads,
      trade: this.trade,
      lastRoll: this.lastRoll,
      setup: this.phase === 'SETUP'
        ? { current: this.setup.order[this.setup.pos], step: this.setup.step, round: this.setup.pos >= this.players.length ? 2 : 1 } : null,
      special: this.phase === 'SPECIAL' ? { current: this.special.queue[this.special.pos], left: this.special.queue.length - this.special.pos } : null,
      longestOwner: this.longestOwner,
      armyOwner: this.armyOwner,
      winner: this.winner,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, connected: p.connected,
        score: over ? this.totalScore(p) : this.publicScore(p),
        cards: this.total(p), dev: p.dev.length, knights: p.knights, longest: p.longest, pieces: p.pieces,
      })),
      buildings: this.nodes.filter((n) => n.owner).map((n) => ({ node: n.id, owner: n.owner, type: n.type })),
      roads: this.edges.filter((e) => e.owner).map((e) => ({ edge: e.id, owner: e.owner })),
      myResources: me ? me.res : emptyRes(),
      myDev: me ? me.dev.map((c) => ({ type: c.type, fresh: c.turn >= this.turnNo })) : [],
      myRatios: me ? Object.fromEntries(RES.map((r) => [r, this.ratioFor(me, r)])) : {},
      legal: this.legalFor(pid),
    };
  }
}

module.exports = { Game, COSTS, RES, RES_JA, MAX_PLAYERS, MIN_PLAYERS, describeTier, getConfig, buildBoard, CONFIGS };
