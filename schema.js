// schema.js — Colyseus synced state.
//
// Only fields registered below with type(...) are sent to clients. Every
// other property set on these instances (velocity, AI state, cooldowns...)
// stays server-side and is never synced — that's intentional, it's the
// server's private working memory, not something a client needs to see.
//
// NOTE: this file uses the "manual type definition" style (no decorators),
// which avoids needing TypeScript or a babel decorator plugin. If your
// installed @colyseus/schema version only documents the @type() decorator
// syntax, swap these type(...)(...) calls for decorators per their docs —
// the field list and logic stay identical either way.

const { Schema, type, MapSchema } = require('@colyseus/schema');

class TankSchema extends Schema {
  constructor() {
    super();
    // --- synced fields ---
    this.name = 'Bot';
    this.team = 0;
    this.isBot = true;
    this.x = 0;
    this.y = 0;
    this.angle = 0;
    this.hp = 100;
    this.maxHp = 100;
    this.level = 1;
    this.tier = 0;
    this.score = 0;
    this.kills = 0;
    this.alive = true;
    this.invuln = 0;
    this.flash = 0; // >0 briefly after taking a hit, for client hit-flash

    // --- server-only working state (not synced) ---
    this.vx = 0; this.vy = 0;
    this.cd = 0; this.altIdx = 0;
    this.lastHit = -99; this.respawnT = 0;
    this.r = 20; this.speed = 220;
    this.bDmg = 10; this.bSpeed = 560; this.bR = 6; this.reload = .5; this.bodyDmg = 25;
    this.input = { mx: 0, my: 0, angle: 0, fire: false };
    this.ai = { t: 0, target: null, kind: 'wander', wp: null, strafe: 1, err: 0, threat: null, threatD: Infinity };
  }
}
type('string')(TankSchema.prototype, 'name');
type('uint8')(TankSchema.prototype, 'team');
type('boolean')(TankSchema.prototype, 'isBot');
type('number')(TankSchema.prototype, 'x');
type('number')(TankSchema.prototype, 'y');
type('number')(TankSchema.prototype, 'angle');
type('number')(TankSchema.prototype, 'hp');
type('number')(TankSchema.prototype, 'maxHp');
type('uint8')(TankSchema.prototype, 'level');
type('uint8')(TankSchema.prototype, 'tier');
type('uint32')(TankSchema.prototype, 'score');
type('uint16')(TankSchema.prototype, 'kills');
type('boolean')(TankSchema.prototype, 'alive');
type('number')(TankSchema.prototype, 'invuln');
type('number')(TankSchema.prototype, 'flash');

class BulletSchema extends Schema {
  constructor() {
    super();
    this.x = 0; this.y = 0; this.team = 0; this.r = 6;
    // server-only:
    this.vx = 0; this.vy = 0; this.dmg = 8; this.hp = 8; this.life = 1.15; this.ownerId = '';
  }
}
type('number')(BulletSchema.prototype, 'x');
type('number')(BulletSchema.prototype, 'y');
type('uint8')(BulletSchema.prototype, 'team');
type('number')(BulletSchema.prototype, 'r');

class BlockSchema extends Schema {
  constructor() {
    super();
    this.x = 0; this.y = 0; this.type = 'sq'; this.rot = 0;
    this.hp = 30; this.maxHp = 30;
    // server-only:
    this.cr = 19; this.vr = 0; this.dmg = 8; this.pts = 10;
  }
}
type('number')(BlockSchema.prototype, 'x');
type('number')(BlockSchema.prototype, 'y');
type('string')(BlockSchema.prototype, 'type');
type('number')(BlockSchema.prototype, 'rot');
type('number')(BlockSchema.prototype, 'hp');
type('number')(BlockSchema.prototype, 'maxHp');

class GameState extends Schema {
  constructor() {
    super();
    this.tanks = new MapSchema();
    this.bullets = new MapSchema();
    this.blocks = new MapSchema();
    this.teamPts0 = 0; this.teamPts1 = 0; this.teamPts2 = 0; this.teamPts3 = 0;
  }
}
type({ map: TankSchema })(GameState.prototype, 'tanks');
type({ map: BulletSchema })(GameState.prototype, 'bullets');
type({ map: BlockSchema })(GameState.prototype, 'blocks');
type('uint32')(GameState.prototype, 'teamPts0');
type('uint32')(GameState.prototype, 'teamPts1');
type('uint32')(GameState.prototype, 'teamPts2');
type('uint32')(GameState.prototype, 'teamPts3');

module.exports = { TankSchema, BulletSchema, BlockSchema, GameState };
