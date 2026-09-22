// TDMRoom.js — the authoritative 4-team TDM room.
//
// This is your original single-file game's update()/botAI() logic, ported
// to run server-side against Colyseus MapSchema collections instead of
// plain arrays. The simulation rules (collisions, damage, base shields,
// bot decision-making) are unchanged from the client prototype.
//
// Known simplifications vs. the client, left as follow-up work:
//  - No spatial grid broad-phase: collisions are checked with plain nested
//    loops. Fine at this scale (~100 tanks, a few hundred blocks/bullets),
//    but worth optimizing before pushing tick rate or player counts much higher.
//  - Every bullet is synced every tick, which is bandwidth-heavy at scale.
//    A future pass could send bullets as fire-and-forget events instead of
//    persistent synced entities.
//  - Death auto-respawns everyone (bots and players) after a short timer,
//    and score persists across deaths (only the 25%-to-killer is lost) —
//    this is a deliberate change from the single-player prototype, where
//    dying reset your whole run. That felt right for one arcade life;
//    it would be brutal in a real ongoing match.

const { Room } = require('colyseus');
const { GameState, TankSchema, BulletSchema, BlockSchema } = require('./schema');
const C = require('./constants');

let uid = 1;
const nextId = () => String(uid++);

const NAMES = ['Bolt', 'Nova', 'Tanker', 'Zed', 'Pixel', 'Rocket', 'Blaze', 'Comet', 'Ninja', 'Viper', 'Turbo', 'Echo', 'Shadow', 'Ace', 'Titan', 'Rusty'];

// Exported so index.js can serve /status without reaching into Colyseus internals.
const stats = { players: 0, capacity: 100 };

class TDMRoom extends Room {
  onCreate() {
    this.maxClients = 100;
    this.patchRate = 1000 / 20; // send state diffs to clients 20x/sec
    this.setState(new GameState());

    this.time = 0;
    this.blockUid = 1;
    this.inputBudget = new Map(); // sessionId -> {tokens, last} — simple token-bucket rate limit
    this.spawnInitialBlocks();
    this.rebalanceBots();

    this.onMessage('input', (client, msg) => {
      const t = this.state.tanks.get(client.sessionId);
      if (!t || t.isBot || !msg) return;
      if (!this.allowInput(client.sessionId)) return; // client sending faster than allowed — drop it
      t.input.mx = C.clamp(Number(msg.mx) || 0, -1, 1);
      t.input.my = C.clamp(Number(msg.my) || 0, -1, 1);
      t.input.angle = Number(msg.angle) || 0;
      t.input.fire = !!msg.fire;
    });

    this.setSimulationInterval((dt) => this.tick(dt / 1000), 1000 / 30); // 30Hz authoritative sim
  }

  // Token bucket per client: refills at INPUT_RATE tokens/sec, capped at
  // INPUT_BURST so a client can never sustain faster than that rate even
  // if it bursts messages. Cheap and stateless enough to check every message.
  allowInput(sessionId) {
    const INPUT_RATE = 40, INPUT_BURST = 10;
    const now = Date.now();
    let b = this.inputBudget.get(sessionId);
    if (!b) { b = { tokens: INPUT_BURST, last: now }; this.inputBudget.set(sessionId, b); }
    const elapsed = (now - b.last) / 1000;
    b.last = now;
    b.tokens = Math.min(INPUT_BURST, b.tokens + elapsed * INPUT_RATE);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // Strips anything that isn't a letter/number/space/dash/underscore, so a
  // name can't carry HTML, control characters, or other junk downstream.
  sanitizeName(raw) {
    const cleaned = String(raw || '')
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .trim()
      .slice(0, 14);
    return cleaned || 'Player';
  }

  onJoin(client, options) {
    const team = this.leastPopulatedTeam();
    const name = this.sanitizeName(options && options.name);
    this.state.tanks.set(client.sessionId, this.makeTank(team, name, false));
    this.rebalanceBots();
    stats.players = this.clients.length;
  }

  async onLeave(client, consented) {
    // A clean leave (consented, e.g. tab closed on purpose) removes the tank
    // right away. A dropped connection (wifi blip, phone lock) gets a grace
    // window to reconnect before we give up the slot — Colyseus keeps the
    // tank in state during that window, so the player just resumes in place.
    if (consented) {
      this.removeTank(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, 20); // 20s grace period
      // client reconnected in time — tank stays exactly as it was.
    } catch (e) {
      this.removeTank(client.sessionId);
    }
  }

  removeTank(sessionId) {
    this.state.tanks.delete(sessionId);
    this.inputBudget.delete(sessionId);
    this.rebalanceBots();
    stats.players = this.clients.length;
  }

  // ---------- setup helpers ----------

  leastPopulatedTeam() {
    // Balance by human count only — bots backfill separately, so a
    // bot-heavy team shouldn't look "full" to a joining player.
    const counts = [0, 0, 0, 0];
    this.state.tanks.forEach(t => { if (!t.isBot) counts[t.team]++; });
    let best = 0;
    for (let i = 1; i < 4; i++) if (counts[i] < counts[best]) best = i;
    return best;
  }

  rebalanceBots() {
    const humanCount = [0, 0, 0, 0];
    const botIds = [[], [], [], []];
    this.state.tanks.forEach((t, id) => {
      if (t.isBot) botIds[t.team].push(id); else humanCount[t.team]++;
    });
    for (let team = 0; team < 4; team++) {
      const wantBots = C.clamp(C.BOTS_PER_TEAM - humanCount[team], 0, C.MAX_PER_TEAM);
      while (botIds[team].length < wantBots) {
        const id = 'bot_' + nextId();
        const name = NAMES[(Math.random() * NAMES.length) | 0] + ((Math.random() * 90) | 0);
        this.state.tanks.set(id, this.makeTank(team, name, true));
        botIds[team].push(id);
      }
      while (botIds[team].length > wantBots) {
        this.state.tanks.delete(botIds[team].pop());
      }
    }
  }

  spawnInitialBlocks() {
    while (this.state.blocks.size < C.BLOCK_TARGET) this.spawnBlock();
  }

  spawnBlock() {
    const r = Math.random();
    const type = r < .68 ? 'sq' : r < .93 ? 'tri' : 'pent';
    for (let tries = 0; tries < 30; tries++) {
      const x = C.rand(80, C.W - 80), y = C.rand(80, C.H - 80);
      if (this.inBase(x, y, 80)) continue;
      if (type === 'pent' && Math.hypot(x - C.W / 2, y - C.H / 2) > 1300) continue;
      let ok = true;
      for (const k of this.state.blocks.values()) {
        if (Math.abs(k.x - x) < 55 && Math.abs(k.y - y) < 55) { ok = false; break; }
      }
      if (!ok) continue;
      const B = C.BT[type];
      const k = new BlockSchema();
      k.x = x; k.y = y; k.type = type; k.rot = C.rand(0, Math.PI * 2); k.vr = C.rand(-.4, .4);
      k.cr = B.r * .92; k.hp = B.hp; k.maxHp = B.hp; k.pts = B.pts; k.dmg = B.dmg;
      this.state.blocks.set('blk_' + this.blockUid++, k);
      return;
    }
  }

  inBase(x, y, pad) {
    return (x < C.BASE + pad || x > C.W - C.BASE - pad) && (y < C.BASE + pad || y > C.H - C.BASE - pad);
  }

  inOwnBase(t) {
    const r = C.BASE_RECTS[t.team];
    return t.x > r.x0 && t.x < r.x1 && t.y > r.y0 && t.y < r.y1;
  }

  makeTank(team, name, isBot) {
    const t = new TankSchema();
    t.name = name; t.team = team; t.isBot = isBot;
    t.score = 0; t.level = 1; t.kills = 0;
    this.applyStats(t, false);
    this.placeAtBase(t);
    t.hp = t.maxHp; t.alive = true; t.invuln = isBot ? 1.5 : 3;
    return t;
  }

  placeAtBase(t) {
    const T = C.TEAMS[t.team];
    t.x = T.cx + C.rand(-260, 260); t.y = T.cy + C.rand(-260, 260);
    t.vx = 0; t.vy = 0;
  }

  applyStats(t, keepRatio) {
    const L = t.level;
    let tier = 0;
    for (let i = 0; i < C.TIERS.length; i++) if (L >= C.TIERS[i].lvl) tier = i;
    t.tier = tier;
    t.r = 17 + Math.min(L, 30) * .55;
    const old = t.maxHp;
    t.maxHp = 90 + L * 14;
    if (keepRatio) t.hp += t.maxHp - old;
    t.speed = Math.max(165, 255 - L * 2.2);
    t.bDmg = (7 + L * .95) * C.TIERS[tier].dmg;
    t.bSpeed = 560;
    t.bR = 5.5 + t.r * .2;
    t.reload = Math.max(.22, .52 - L * .006) * C.TIERS[tier].reload;
    t.bodyDmg = 22 + L * 1.5;
  }

  respawn(t) {
    this.placeAtBase(t);
    this.applyStats(t, false); // level/score untouched — only position + hp reset
    t.hp = t.maxHp; t.alive = true; t.invuln = t.isBot ? 1.5 : 3;
  }

  // ---------- main tick ----------

  tick(dt) {
    this.time += dt;

    // 1) decide movement/aim/fire intent
    this.state.tanks.forEach((t, id) => {
      if (!t.alive) return;
      if (t.isBot) this.botAI(t, dt, id);
      else this.humanControl(t, dt, id);
    });

    // 2) integrate position, regen, respawns, level-ups
    this.state.tanks.forEach((t) => {
      if (!t.alive) {
        t.respawnT -= dt;
        if (t.respawnT <= 0) this.respawn(t);
        return;
      }
      t.cd -= dt;
      if (t.invuln > 0) t.invuln -= dt;
      if (t.flash > 0) t.flash -= dt;
      t.x += t.vx * dt; t.y += t.vy * dt;

      const safe = this.inOwnBase(t);
      const delay = safe ? 1.2 : 4, rate = safe ? .3 : .1; // faster regen in your own base
      if (this.time - t.lastHit > delay && t.hp < t.maxHp) t.hp = Math.min(t.maxHp, t.hp + t.maxHp * rate * dt);

      const nl = C.levelFor(t.score);
      if (nl !== t.level) { t.level = nl; this.applyStats(t, true); }
    });

    // 3) bullets: move, then bullet-vs-bullet (opposing teams knock each other down)
    const bullets = [...this.state.bullets.entries()];
    for (const [, b] of bullets) { b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt; }
    for (let i = 0; i < bullets.length; i++) {
      const [, a] = bullets[i]; if (a.hp <= 0) continue;
      for (let j = i + 1; j < bullets.length; j++) {
        const [, b] = bullets[j];
        if (b.hp <= 0 || b.team === a.team) continue;
        const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r;
        if (dx * dx + dy * dy < rr * rr) { a.hp -= b.dmg; b.hp -= a.dmg; }
      }
    }

    // 4) bullets vs enemy base shields / blocks / tanks
    for (const [bid, b] of bullets) {
      let dead = b.hp <= 0 || b.life <= 0 || b.x < 0 || b.y < 0 || b.x > C.W || b.y > C.H;
      if (!dead) {
        for (let bi = 0; bi < 4; bi++) {
          if (bi === b.team) continue;
          if (C.rectClosest(C.BASE_RECTS[bi], b.x, b.y).d2 < b.r * b.r) { dead = true; break; }
        }
      }
      if (!dead) {
        this.state.blocks.forEach((k, key) => {
          if (dead) return;
          const dx = k.x - b.x, dy = k.y - b.y, rr = k.cr + b.r;
          if (dx * dx + dy * dy < rr * rr) { this.hitBlock(key, k, b.dmg, b.ownerId); dead = true; }
        });
      }
      if (!dead) {
        this.state.tanks.forEach((t, tid) => {
          if (dead || !t.alive || t.team === b.team || t.invuln > 0) return;
          const dx = t.x - b.x, dy = t.y - b.y, rr = t.r + b.r;
          if (dx * dx + dy * dy < rr * rr) { this.damageTank(t, b.dmg, b.ownerId, tid); dead = true; }
        });
      }
      if (dead) this.state.bullets.delete(bid);
    }

    // 5) tank vs tank (push apart + body damage between enemies)
    const tanks = [...this.state.tanks.entries()].filter(([, t]) => t.alive);
    for (let i = 0; i < tanks.length; i++) {
      const [aid, a] = tanks[i];
      for (let j = i + 1; j < tanks.length; j++) {
        const [bid, b] = tanks[j];
        const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r, d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || .01, ov = rr - d, nx = dx / d, ny = dy / d;
        const same = a.team === b.team, push = ov * (same ? .25 : .5);
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        if (!same && a.invuln <= 0 && b.invuln <= 0) {
          this.damageTank(a, b.bodyDmg * dt, bid, aid);
          this.damageTank(b, a.bodyDmg * dt, aid, bid);
        }
      }
    }

    // 6) tank vs blocks, enemy base shields (solid wall + damage), and world bounds
    this.state.tanks.forEach((t, id) => {
      if (!t.alive) return;

      this.state.blocks.forEach((k, key) => {
        const dx = t.x - k.x, dy = t.y - k.y, rr = t.r + k.cr;
        if (dx * dx + dy * dy >= rr * rr) return;
        const d = Math.sqrt(dx * dx + dy * dy) || .01, ov = rr - d;
        t.x += dx / d * ov; t.y += dy / d * ov;
        k.hp -= t.bodyDmg * dt;
        if (t.invuln <= 0) this.damageTank(t, k.dmg * dt, null, id);
        if (k.hp <= 0) this.destroyBlock(key, k, id);
      });

      for (let bi = 0; bi < 4; bi++) {
        if (bi === t.team) continue;
        const rect = C.BASE_RECTS[bi];
        const c = C.rectClosest(rect, t.x, t.y);
        if (c.d2 === 0) {
          const distL = t.x - rect.x0, distR = rect.x1 - t.x, distT = t.y - rect.y0, distB = rect.y1 - t.y;
          const m = Math.min(distL, distR, distT, distB);
          if (m === distL) t.x = rect.x0 - t.r;
          else if (m === distR) t.x = rect.x1 + t.r;
          else if (m === distT) t.y = rect.y0 - t.r;
          else t.y = rect.y1 + t.r;
          if (t.invuln <= 0) this.damageTank(t, C.SHIELD_DPS * dt, null, id);
        } else if (c.d2 < t.r * t.r) {
          const d = Math.sqrt(c.d2), push = t.r - d;
          t.x += (c.dx / d) * push; t.y += (c.dy / d) * push;
          if (t.invuln <= 0) this.damageTank(t, C.SHIELD_DPS * dt, null, id);
        }
      }

      t.x = C.clamp(t.x, t.r, C.W - t.r); t.y = C.clamp(t.y, t.r, C.H - t.r);
    });

    // 7) spin blocks (purely cosmetic, but was dropped in the original port —
    // the client's local sim used to do this every frame, so k.rot was
    // static forever here even though it's a synced field)
    this.state.blocks.forEach(k => { k.rot += k.vr * dt; });

    // 8) keep the block field topped up
    if (this.state.blocks.size < C.BLOCK_TARGET && Math.random() < dt * 12) this.spawnBlock();
  }

  // ---------- combat ----------

  hitBlock(key, k, dmg, ownerId) {
    k.hp -= dmg;
    if (k.hp <= 0) this.destroyBlock(key, k, ownerId);
  }

  destroyBlock(key, k, ownerId) {
    this.state.blocks.delete(key);
    const owner = ownerId && this.state.tanks.get(ownerId);
    if (owner && owner.alive) this.addScore(owner, k.pts);
  }

  addScore(t, pts) {
    t.score += pts;
    const key = 'teamPts' + t.team;
    this.state[key] += pts;
  }

  damageTank(t, dmg, srcId, victimId) {
    if (!t.alive || t.invuln > 0) return;
    t.hp -= dmg; t.lastHit = this.time; t.flash = .12;
    if (t.hp <= 0) this.killTank(t, srcId, victimId);
  }

  killTank(t, srcId, victimId) {
    if (!t.alive) return;
    t.alive = false;
    const src = srcId && this.state.tanks.get(srcId);
    let gain = 0;
    if (src && src.alive && src !== t && src.team !== t.team) {
      gain = Math.round(t.score * .25);
      if (gain > 0) this.addScore(src, gain);
      src.kills++;
    }
    this.broadcast('kill', {
      killer: src ? src.name : null,
      killerTeam: src ? src.team : null,
      killerId: src ? srcId : null,
      victim: t.name,
      victimTeam: t.team,
      victimId: victimId || null,
      gain,
    });
    t.respawnT = 2.5 + Math.random() * 2.5;
  }

  // ---------- human input ----------

  humanControl(t, dt, id) {
    const inp = t.input;
    const k = Math.min(1, 7 * dt);
    t.vx += (inp.mx * t.speed - t.vx) * k;
    t.vy += (inp.my * t.speed - t.vy) * k;
    t.angle = inp.angle;
    if (inp.fire) this.tryFire(t, id);
  }

  tryFire(t, id) {
    if (t.cd > 0) return;
    const T = C.TIERS[t.tier];
    if (T.alt) this.shoot(t, T.barrels[t.altIdx++ % T.barrels.length], id);
    else for (const bdef of T.barrels) this.shoot(t, bdef, id);
    t.cd = t.reload;
    t.vx -= Math.cos(t.angle) * 18; t.vy -= Math.sin(t.angle) * 18;
  }

  shoot(t, bdef, ownerId) {
    const ang = t.angle + bdef.a + (Math.random() - .5) * (t.isBot ? .1 : .06);
    const b = new BulletSchema();
    b.x = t.x; b.y = t.y; b.team = t.team;
    b.vx = Math.cos(ang) * t.bSpeed + t.vx * .3;
    b.vy = Math.sin(ang) * t.bSpeed + t.vy * .3;
    b.dmg = t.bDmg; b.hp = t.bDmg; b.r = t.bR; b.life = 1.15; b.ownerId = ownerId;
    this.state.bullets.set('b_' + nextId(), b);
  }

  // ---------- bot AI (identical decision logic to the client, driving t.input-like output) ----------

  leadAim(b, tg, d) {
    let px = tg.x, py = tg.y, tt = d / b.bSpeed;
    for (let i = 0; i < 2; i++) {
      px = tg.x + tg.vx * tt; py = tg.y + tg.vy * tt;
      tt = Math.hypot(px - b.x, py - b.y) / b.bSpeed;
    }
    return Math.atan2(py - b.y, px - b.x);
  }

  botAI(b, dt, id) {
    const a = b.ai;
    a.t -= dt;
    const hpFrac = b.hp / b.maxHp;

    if (a.t <= 0) {
      a.t = .22 + Math.random() * .3;
      let nearest = null, nearestD = Infinity, threatsClose = 0, bestTarget = null, bestScore = -Infinity;
      this.state.tanks.forEach(o => {
        if (!o.alive || o.team === b.team || o.invuln > 0) return;
        const d = Math.hypot(o.x - b.x, o.y - b.y);
        if (d < nearestD) { nearestD = d; nearest = o; }
        if (d < 480) threatsClose++;
        if (d > 780) return;
        const levelGap = o.level - b.level;
        const score = (1 - o.hp / o.maxHp) * 300 - d * .35 - (levelGap > 5 ? levelGap * 16 : 0);
        if (score > bestScore) { bestScore = score; bestTarget = o; }
      });
      a.threat = nearest; a.threatD = nearestD;

      const outgunned = nearest && nearestD < 480 && nearest.level - b.level > 6;
      const wantsRetreat = hpFrac < .36 || (outgunned && hpFrac < .7) || threatsClose >= 3;

      if (wantsRetreat && !this.inOwnBase(b)) {
        a.kind = 'retreat'; a.target = null;
      } else if (bestTarget) {
        a.kind = 'tank'; a.target = bestTarget;
      } else {
        let bb = null, bv = -1, bbKey = null;
        this.state.blocks.forEach((k, key) => {
          const d = Math.hypot(k.x - b.x, k.y - b.y);
          if (d > 900) return;
          const v = k.pts / (d + 150);
          if (v > bv) { bv = v; bb = k; bbKey = key; }
        });
        if (bb) { a.target = bbKey; a.kind = 'block'; }
        else {
          a.target = null; a.kind = 'wander';
          if (!a.wp || Math.hypot(a.wp.x - b.x, a.wp.y - b.y) < 140)
            a.wp = { x: C.clamp(C.W / 2 + C.rand(-1600, 1600), 100, C.W - 100), y: C.clamp(C.H / 2 + C.rand(-1600, 1600), 100, C.H - 100) };
        }
      }
      a.strafe = Math.random() < .5 ? -1 : 1;
      a.err = (Math.random() - .5) * .12;
    }

    let dx = 0, dy = 0, fire = false, aim = b.angle;
    const tg = a.kind === 'block' ? this.state.blocks.get(a.target) : a.target;

    if (a.kind === 'retreat') {
      const T = C.TEAMS[b.team];
      const tx = T.cx - b.x, ty = T.cy - b.y, d = Math.hypot(tx, ty) || 1;
      dx = tx / d; dy = ty / d;
      if (a.threat && a.threat.alive && a.threatD < 560) {
        aim = this.leadAim(b, a.threat, a.threatD) + a.err;
        fire = a.threatD < 500;
      } else aim = Math.atan2(ty, tx);
      if (this.inOwnBase(b)) a.t = 0;
    } else if (a.kind === 'tank' && tg && tg.alive) {
      const txr = tg.x - b.x, tyr = tg.y - b.y, d = Math.hypot(txr, tyr) || 1, ux = txr / d, uy = tyr / d;
      const want = 280, kk = d > want + 40 ? 1 : d < want - 60 ? -1 : 0;
      dx = ux * kk - uy * a.strafe * .65; dy = uy * kk + ux * a.strafe * .65;
      aim = this.leadAim(b, tg, d) + a.err; fire = d < 560;
    } else if (a.kind === 'block' && tg) {
      const tx = tg.x - b.x, ty = tg.y - b.y, d = Math.hypot(tx, ty) || 1, ux = tx / d, uy = ty / d;
      const want = 130, kk = d > want + 40 ? 1 : d < want - 60 ? -1 : 0;
      dx = ux * kk - uy * a.strafe * .65; dy = uy * kk + ux * a.strafe * .65;
      aim = Math.atan2(ty, tx) + a.err; fire = d < 330;
    } else if (a.kind === 'wander' && a.wp) {
      const tx = a.wp.x - b.x, ty = a.wp.y - b.y, d = Math.hypot(tx, ty) || 1;
      dx = tx / d; dy = ty / d; aim = Math.atan2(ty, tx);
    } else { a.t = 0; }

    const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    const sp = b.speed * .9, k2 = Math.min(1, 6 * dt);
    b.vx += (dx * sp - b.vx) * k2; b.vy += (dy * sp - b.vy) * k2;
    const diff = C.angDiff(b.angle, aim);
    b.angle += C.clamp(diff, -9 * dt, 9 * dt);
    if (fire && Math.abs(diff) < .25) this.tryFire(b, id);
  }
}

module.exports = { TDMRoom, stats };
