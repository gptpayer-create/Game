// constants.js — shared game constants & pure helper functions, ported
// directly from the original client's logic so the server matches it exactly.

const W = 4000, H = 4000, BASE = 700;
const BOTS_PER_TEAM = 20;      // bots fill empty slots on a team up to this many
const MAX_PER_TEAM = 25;       // soft target: 100 players / 4 teams
const BLOCK_TARGET = 320;
const SHIELD_DPS = 55;         // damage/sec for standing inside an enemy base

const TEAMS = [
  { name: 'Blue',   cx: 400,     cy: 400 },
  { name: 'Red',    cx: W - 400, cy: 400 },
  { name: 'Green',  cx: 400,     cy: H - 400 },
  { name: 'Purple', cx: W - 400, cy: H - 400 },
];

const BASE_RECTS = TEAMS.map(T => ({
  x0: T.cx < W / 2 ? 0 : W - BASE, y0: T.cy < H / 2 ? 0 : H - BASE,
  x1: (T.cx < W / 2 ? 0 : W - BASE) + BASE, y1: (T.cy < H / 2 ? 0 : H - BASE) + BASE,
}));

const TIERS = [
  { name: 'Basic',  lvl: 1,  dmg: 1,    reload: 1,    alt: false, barrels: [{ a: 0, off: 0 }] },
  { name: 'Twin',   lvl: 6,  dmg: .85,  reload: .6,   alt: true,  barrels: [{ a: 0, off: -.45 }, { a: 0, off: .45 }] },
  { name: 'Triple', lvl: 12, dmg: .8,   reload: 1.05, alt: false, barrels: [{ a: -.45, off: 0 }, { a: .45, off: 0 }, { a: 0, off: 0 }] },
  { name: 'Quad',   lvl: 20, dmg: .75,  reload: 1.15, alt: false, barrels: [0, 1, 2, 3].map(k => ({ a: k * Math.PI / 2, off: 0 })) },
];

const BT = {
  sq:   { sides: 4, r: 19, hp: 30,  pts: 10,  dmg: 8 },
  tri:  { sides: 3, r: 22, hp: 60,  pts: 25,  dmg: 12 },
  pent: { sides: 5, r: 34, hp: 220, pts: 130, dmg: 20 },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);

function angDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Closest point on rect r to (x,y): returns offset from that point + squared distance.
// d2 === 0 means (x,y) is inside (or on) the rectangle.
function rectClosest(r, x, y) {
  const qx = clamp(x, r.x0, r.x1), qy = clamp(y, r.y0, r.y1);
  const dx = x - qx, dy = y - qy;
  return { dx, dy, d2: dx * dx + dy * dy };
}

function levelFor(score) {
  return Math.min(40, 1 + Math.floor(Math.sqrt(score / 12)));
}

module.exports = {
  W, H, BASE, BOTS_PER_TEAM, MAX_PER_TEAM, BLOCK_TARGET, SHIELD_DPS,
  TEAMS, BASE_RECTS, TIERS, BT,
  clamp, rand, angDiff, rectClosest, levelFor,
};
