/**
 * engine.test.mjs —— 引擎模拟测试（战力吞噬制）
 *
 * 验证：
 *   1. 核心规则：战力 >= 怪 → 秒杀并吞噬；战力 < 怪 → 触碰即死
 *   2. 走位：点击移动、键盘移动、墙体碰撞
 *   3. 机制：陷阱削战力、装备加战力、道具效果、过层、复活、首充
 *   4. 地图生成：怪物不卡墙里、全部可达
 *   5. 机器人长时间模拟：能稳定推进、不出现 NaN、不会卡死
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Engine = require('../engine.js');
const B = require('../balance.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DT = 1 / 60;
const CELL = B.CONFIG.cell;

/**
 * 单测隔离：清掉场上无关的装备/道具/陷阱。
 * keep 不传 = 清掉所有怪物；传数组 = 只保留指定怪物。
 * 避免随机生成的实体干扰断言（比如脚边刚好有个陷阱）
 */
function isolate(game, keep) {
  const s = game.state;
  s.items = [];
  s.props = [];
  s.traps = [];
  s.monsters = keep ? s.monsters.filter(m => keep.includes(m)) : [];
  return s;
}

/** 把主角放到某个怪物身上，触发接触判定 */
function touch(game, m) {
  const h = game.state.hero;
  h.x = m.x; h.y = m.y;
}

test('核心规则：战力 >= 怪 → 一击秒杀并吞噬其数值', () => {
  const game = Engine.createGame({ rand: mulberry32(1) });
  game.start();
  const s = game.state;
  const m = s.monsters[0];
  m.power = 5;                       // 固定一个打得过的数值
  s.hero.power = 5;
  isolate(game, [m]);

  touch(game, m);
  game.tick(DT);

  // 只吞一部分（absorbRatio），不是全量吞噬
  const expectGain = Math.max(1, Math.round(5 * B.CONFIG.absorbRatio));
  assert.equal(s.hero.power, 5 + expectGain,
    `秒杀后应吞噬 ${expectGain} 点战力，实际 ${s.hero.power}`);
  assert.equal(s.kills, 1);
  assert.equal(s.monsters.length, 0, '怪物应被移除');
});

test('核心规则：战力 < 怪 → 触碰即死', () => {
  const game = Engine.createGame({ rand: mulberry32(2) });
  game.start();
  const s = game.state;
  const m = s.monsters[0];
  m.power = 100;
  s.hero.power = 1;
  isolate(game, [m]);

  touch(game, m);
  game.tick(DT);

  assert.equal(s.phase, 'dead', '打不过还往上撞必须死');
  assert.equal(s.deadStats.killerPower, 100);
});

test('核心规则：恰好相等也能秒杀', () => {
  const game = Engine.createGame({ rand: mulberry32(3) });
  game.start();
  const s = game.state;
  const m = s.monsters[0];
  m.power = 7;
  s.hero.power = 7;
  isolate(game, [m]);
  touch(game, m);
  game.tick(DT);
  const expectGain = Math.max(1, Math.round(7 * B.CONFIG.absorbRatio));
  assert.equal(s.hero.power, 7 + expectGain);
  assert.equal(s.phase, 'playing');
});

test('护盾期间可以穿过打不过的怪而不死', () => {
  const game = Engine.createGame({ rand: mulberry32(4) });
  game.start();
  const s = game.state;
  const m = s.monsters[0];
  m.power = 999;
  s.hero.power = 1;
  s.hero.shieldUntil = s.time + 5;
  isolate(game, [m]);
  touch(game, m);
  game.tick(DT);
  assert.equal(s.phase, 'playing', '护盾期不该死');
  assert.equal(s.monsters.length, 1, '护盾不该杀死怪物');
});

test('走位：点击移动会让主角走向目标点', () => {
  const game = Engine.createGame({ rand: mulberry32(5) });
  game.start();
  const s = game.state;
  const startX = s.hero.x;
  game.setMoveTarget(s.hero.x + 200, s.hero.y);
  for (let i = 0; i < 120; i++) game.tick(DT);
  assert.ok(s.hero.x > startX + 50, `主角应向右移动，实际 x=${s.hero.x}`);
});

test('走位：键盘方向可以移动', () => {
  const game = Engine.createGame({ rand: mulberry32(6) });
  game.start();
  const s = game.state;
  const y0 = s.hero.y;
  game.setDirection(0, 1);
  for (let i = 0; i < 60; i++) game.tick(DT);
  assert.ok(s.hero.y > y0 + 20, '按下方向键应向下移动');
  game.setDirection(0, 0);
});

test('墙体碰撞：主角穿不过外墙', () => {
  const game = Engine.createGame({ rand: mulberry32(7) });
  game.start();
  const s = game.state;
  game.setDirection(-1, 0);   // 一路向左顶 5 秒
  for (let i = 0; i < 300; i++) game.tick(DT);
  game.setDirection(0, 0);
  assert.ok(s.hero.x >= CELL, `不应穿出左墙，实际 x=${s.hero.x}`);
  assert.ok(s.hero.x <= B.CONFIG.arenaW - CELL, '也不应穿出右墙');
});

test('寻路：点击墙后面的目标点也能绕过去', () => {
  const game = Engine.createGame({ rand: mulberry32(27) });
  game.start();
  const s = game.state;
  isolate(game);                       // 清掉怪物/装备/陷阱，只测寻路

  // 手工铺一张确定性的地图（随机地图可能把目标点堵死，测不出寻路本身）
  const cols = Engine.COLS, rows = Engine.ROWS;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      s.grid[y][x] = (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) ? 1 : 0;
    }
  }
  const wallX = Math.floor(cols / 2);
  for (let y = 1; y < rows - 1; y++) {
    if (y !== 2) s.grid[y][wallX] = 1;    // 整列墙，只在第 2 行留一个缺口
  }

  // 主角放到墙左侧，目标点放到墙右侧，必须绕到上面那个缺口
  s.hero.x = 5 * CELL; s.hero.y = 7 * CELL;
  const goalX = (wallX + 4) * CELL, goalY = s.hero.y;
  game.setMoveTarget(goalX, goalY);

  for (let i = 0; i < 60 * 20; i++) {
    game.tick(DT);
    if (Math.hypot(s.hero.x - goalX, s.hero.y - goalY) < 12) break;
  }
  assert.ok(
    Math.hypot(s.hero.x - goalX, s.hero.y - goalY) < 20,
    `应能绕到墙后面的目标点，实际距离 ${Math.hypot(s.hero.x - goalX, s.hero.y - goalY).toFixed(1)}`
  );
});

test('地图生成：怪物/装备/道具都不卡在墙里，且全部可达', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const game = Engine.createGame({ rand: mulberry32(seed) });
    game.start();
    const s = game.state;

    // 可达性：从主角所在格洪水填充
    const cols = Engine.COLS, rows = Engine.ROWS;
    const seen = new Set();
    const sx = Math.floor(s.hero.x / CELL), sy = Math.floor(s.hero.y / CELL);
    const stack = [[sx, sy]];
    seen.add(sx + ',' + sy);
    while (stack.length) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        const key = nx + ',' + ny;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if (s.grid[ny][nx] || seen.has(key)) continue;
        seen.add(key);
        stack.push([nx, ny]);
      }
    }

    const entities = [...s.monsters, ...s.items, ...s.props, ...s.traps];
    assert.ok(entities.length > 0, '本层应有实体');
    for (const e of entities) {
      const gx = Math.floor(e.x / CELL), gy = Math.floor(e.y / CELL);
      assert.equal(s.grid[gy][gx], 0, `实体卡在墙里: (${gx},${gy})`);
      assert.ok(seen.has(gx + ',' + gy), `实体不可达: (${gx},${gy})`);
    }
  }
});

test('陷阱：踩到损失 25% 战力并显形', () => {
  const game = Engine.createGame({ rand: mulberry32(8) });
  game.start();
  const s = game.state;
  // 手动在主角脚下放一个陷阱
  const t = { id: 999, x: s.hero.x, y: s.hero.y, r: 14, spent: false, detected: false };
  s.traps = [t];
  s.hero.power = 100;
  game.tick(DT);
  assert.equal(t.spent, true, '陷阱应被触发');
  assert.equal(s.hero.power, 75, '应损失 25% 战力');
  assert.equal(t.detected, true);
});

test('陷阱：靠近会显形（给玩家反应机会）', () => {
  const game = Engine.createGame({ rand: mulberry32(9) });
  game.start();
  const s = game.state;
  const t = { id: 998, x: s.hero.x + 70, y: s.hero.y, r: 14, spent: false, detected: false };
  s.traps = [t];
  game.tick(DT);
  assert.equal(t.detected, true, '靠近应显形');
  assert.equal(t.spent, false, '还没踩到不该触发');
});

test('装备：碰到即加战力', () => {
  const game = Engine.createGame({ rand: mulberry32(10) });
  game.start();
  const s = game.state;
  const it = { id: 997, x: s.hero.x, y: s.hero.y, r: 15, bonus: 500, name: '测试剑', tier: { name: '史诗', color: '#fff' }, bob: 0 };
  s.items = [it];
  s.hero.power = 10;
  game.tick(DT);
  assert.equal(s.hero.power, 510);
  assert.equal(s.items.length, 0);
});

test('道具：炸弹消灭周围所有打得过的怪', () => {
  const game = Engine.createGame({ rand: mulberry32(11) });
  game.start();
  const s = game.state;
  s.hero.power = 100;
  s.monsters = [
    { id: 1, kind: 'normal', x: s.hero.x + 50, y: s.hero.y, power: 10, r: 21, pad: 60, wob: 0, hitFlash: 0 },
    { id: 2, kind: 'normal', x: s.hero.x - 50, y: s.hero.y, power: 20, r: 21, pad: 60, wob: 0, hitFlash: 0 },
    { id: 3, kind: 'elite', x: s.hero.x + 100, y: s.hero.y, power: 9999, r: 27, pad: 60, wob: 0, hitFlash: 0 }
  ];
  const before = s.hero.power;
  const pr = { id: 996, x: s.hero.x, y: s.hero.y, r: 16, kind: 'bomb', name: '炸弹', icon: '💥', desc: '', bob: 0 };
  s.props = [pr];
  game.tick(DT);
  assert.equal(s.monsters.length, 1, '只该炸掉打得过的');
  assert.equal(s.monsters[0].id, 3, '打不过的应该留下');
  const expectGain = Math.max(1, Math.round(10 * B.CONFIG.absorbRatio))
    + Math.max(1, Math.round(20 * B.CONFIG.absorbRatio));
  assert.equal(s.hero.power, before + expectGain, '炸掉的怪战力也应被吞噬');
});

test('道具：磁铁把附近装备吸到身上', () => {
  const game = Engine.createGame({ rand: mulberry32(12) });
  game.start();
  const s = game.state;
  s.hero.power = 50;
  s.items = [{ id: 995, x: s.hero.x + 200, y: s.hero.y, r: 15, bonus: 100, name: '远剑', tier: { name: '普通', color: '#fff' }, bob: 0, pad: 50 }];
  s.monsters = [];
  s.traps = [];
  const pr = { id: 994, x: s.hero.x, y: s.hero.y, r: 16, kind: 'magnet', name: '磁铁', icon: '🧲', desc: '', bob: 0 };
  s.props = [pr];
  game.tick(DT);
  assert.equal(s.items.length, 0, '装备应被吸过来并拾取');
  assert.equal(s.hero.power, 150);
});

test('道具：护盾/加速/幸运有时效', () => {
  const game = Engine.createGame({ rand: mulberry32(13) });
  game.start();
  const s = game.state;
  const apply = (kind) => {
    s.props = [{ id: 900 + Math.random(), x: s.hero.x, y: s.hero.y, r: 16, kind, name: kind, icon: 'x', desc: '', bob: 0 }];
    game.tick(DT);
  };
  s.monsters = [];
  apply('shield'); assert.ok(s.hero.shieldUntil > s.time);
  apply('speed'); assert.ok(s.hero.speedUntil > s.time);
  apply('luck'); assert.ok(s.hero.luckUntil > s.time);
});

test('幸运道具让吞噬翻倍', () => {
  const game = Engine.createGame({ rand: mulberry32(14) });
  game.start();
  const s = game.state;
  s.monsters = [{ id: 1, kind: 'normal', x: s.hero.x, y: s.hero.y, power: 50, r: 21, pad: 60, wob: 0, hitFlash: 0 }];
  s.hero.power = 100;
  s.hero.luckUntil = s.time + 5;
  game.tick(DT);
  const expectGain = Math.max(1, Math.round(50 * B.CONFIG.absorbRatio * B.CONFIG.luckMul));
  assert.equal(s.hero.power, 100 + expectGain, `幸运期间应吞噬双倍，实际 +${expectGain}`);
});

test('追击怪会主动靠近主角', () => {
  const game = Engine.createGame({ rand: mulberry32(15) });
  game.start();
  const s = game.state;
  s.monsters = [{ id: 1, kind: 'chaser', x: s.hero.x + 300, y: s.hero.y, power: 99999, r: 23, pad: 60, wob: 0, hitFlash: 0 }];
  s.items = []; s.props = []; s.traps = [];
  const x0 = s.monsters[0].x;
  for (let i = 0; i < 30; i++) game.tick(DT);
  assert.ok(s.monsters[0].x < x0, '追击怪应向主角移动');
});

test('追击怪打不过时：主角跑得掉（速度更快）', () => {
  const game = Engine.createGame({ rand: mulberry32(16) });
  game.start();
  const s = game.state;
  s.monsters = [{ id: 1, kind: 'chaser', x: s.hero.x + 200, y: s.hero.y, power: 99999, r: 23, pad: 60, wob: 0, hitFlash: 0 }];
  s.items = []; s.props = []; s.traps = [];
  game.setDirection(-1, 0);   // 主角往左跑
  for (let i = 0; i < 120; i++) {
    game.tick(DT);
    if (s.phase === 'dead') break;
  }
  assert.equal(s.phase, 'playing', '跑得掉就不该死');
});

test('过层：清空本层怪物后进入下一层并重新刷怪', () => {
  const game = Engine.createGame({ rand: mulberry32(17) });
  game.start();
  const s = game.state;
  s.monsters = [];
  s.clearAt = s.time + 0.1;
  for (let i = 0; i < 30 && s.floor === 1; i++) game.tick(DT);
  assert.equal(s.floor, 2, '应进入第 2 层');
  assert.ok(s.monsters.length > 0, '新一层应重新刷怪');
});

test('过层后新怪物按新战力折算（保持紧张区间）', () => {
  const game = Engine.createGame({ rand: mulberry32(18) });
  game.start();
  const s = game.state;
  s.hero.power = 1e6;      // 已经很强
  s.monsters = [];
  s.clearAt = s.time + 0.1;
  for (let i = 0; i < 30 && s.floor === 1; i++) game.tick(DT);
  const maxPower = Math.max(...s.monsters.map(m => m.power));
  assert.ok(maxPower > 1e5, `新怪物应按新战力折算，实际最大 ${maxPower}`);
});

test('复活：保留战力 + 无敌 + 短期翻倍', () => {
  const game = Engine.createGame({ rand: mulberry32(19) });
  game.start();
  const s = game.state;
  s.hero.power = 42;
  s.monsters = [{ id: 1, kind: 'elite', x: s.hero.x, y: s.hero.y, power: 9999, r: 27, pad: 60, wob: 0, hitFlash: 0 }];
  game.tick(DT);
  assert.equal(s.phase, 'dead');

  game.revive();
  assert.equal(s.phase, 'playing');
  assert.equal(s.hero.power, 42, '复活应保留战力');
  assert.equal(game.heroPower(), 84, '复活后短期翻倍');
  assert.ok(s.hero.invulnUntil > s.time, '复活应有无敌时间');
});

test('首充：战力 ×3 并永久自动战斗', () => {
  const game = Engine.createGame({ rand: mulberry32(20) });
  game.start();
  const s = game.state;
  s.hero.power = 100;
  assert.equal(game.hasAuto(), false);
  assert.ok(game.grantFirstCharge());
  assert.equal(s.hero.power, 300);
  assert.equal(game.hasAuto(), true, '首充后应永久自动战斗');
  assert.equal(game.grantFirstCharge(), false, '不能重复首充');
});

test('广告抽装备直接加战力', () => {
  const game = Engine.createGame({ rand: mulberry32(21) });
  game.start();
  const s = game.state;
  s.hero.power = 1000;
  const gain = game.drawEquipment();
  assert.ok(gain > 0);
  assert.equal(s.hero.power, 1000 + gain);
});

/* ---------------- 机器人模拟 ---------------- */

/**
 * 机器人玩家策略：
 *  - 'careful'（默认）：只打最近的、打得过的怪，顺路捡装备；
 *    没有能打的就逃向远离危险怪的方向。卡关了会看广告抽装备（模拟真人）。
 *  - 'reckless'：无脑冲向最近的怪，完全不看数值、不躲。
 *    用来验证"危险是真实的"——不懂躲就该死。
 */
function simulate(seed, options = {}) {
  const rand = mulberry32(seed);
  const game = Engine.createGame({ rand });
  game.start();

  const duration = options.duration || 10 * 60;
  const maxDeaths = options.maxDeaths === undefined ? 3 : options.maxDeaths;
  const useAds = options.useAds !== false;
  const reckless = options.policy === 'reckless';
  let deaths = 0, maxFloor = 1, nanSeen = false, ticks = 0, adsUsed = 0;
  let repathCd = 0;
  let stuckFloor = 1, stuckTime = 0;

  for (let t = 0; t < duration; t += DT) {
    const s = game.state;
    if (s.phase === 'dead') {
      deaths++;
      if (deaths > maxDeaths) break;
      game.revive();
      continue;
    }
    ticks++;

    // 卡关检测：同一层待太久 → 看广告抽装备（这就是这类游戏的变现点）
    if (s.floor === stuckFloor) stuckTime += DT; else { stuckFloor = s.floor; stuckTime = 0; }
    if (useAds && stuckTime > 25) {
      stuckTime = 0;
      adsUsed++;
      game.drawEquipment();
    }

    // 寻路：每 0.15 秒重新决策一次
    repathCd -= DT;
    if (repathCd <= 0) {
      repathCd = 0.15;
      const power = game.heroPower();
      let target = null, best = Infinity;
      for (const m of s.monsters) {
        // 莽夫策略不看数值，见到最近的怪就往上撞
        if (!reckless && m.power > power) continue;
        const d = Math.hypot(m.x - s.hero.x, m.y - s.hero.y);
        if (d < best) { best = d; target = m; }
      }
      if (target) {
        game.setMoveTarget(target.x, target.y);
      } else if (!reckless) {
        // 没有能打的：捡装备，或者远离最强的怪
        let pick = null, bp = Infinity;
        for (const o of [...s.items, ...s.props]) {
          const d = Math.hypot(o.x - s.hero.x, o.y - s.hero.y);
          if (d < bp) { bp = d; pick = o; }
        }
        if (pick) {
          game.setMoveTarget(pick.x, pick.y);
        } else {
          let threat = null, bt = Infinity;
          for (const m of s.monsters) {
            const d = Math.hypot(m.x - s.hero.x, m.y - s.hero.y);
            if (d < bt) { bt = d; threat = m; }
          }
          if (threat) {
            const dx = s.hero.x - threat.x, dy = s.hero.y - threat.y;
            const len = Math.hypot(dx, dy) || 1;
            game.setMoveTarget(s.hero.x + (dx / len) * 300, s.hero.y + (dy / len) * 300);
          }
        }
      }
    }

    game.tick(DT);
    maxFloor = Math.max(maxFloor, s.floor);

    for (const k of ['power']) if (!Number.isFinite(s.hero[k])) nanSeen = true;
    for (const m of s.monsters) {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !Number.isFinite(m.power)) nanSeen = true;
    }
  }

  const s = game.state;
  return {
    floor: s.floor, maxFloor, kills: s.kills, deaths, adsUsed,
    power: s.hero.power, monstersLeft: s.monsters.length,
    time: Math.round(s.time), ticks, nanSeen, phase: s.phase
  };
}

test('机器人模拟：10 分钟能稳定推进多层，不卡死不出 NaN', () => {
  const r = simulate(20240501);
  console.log('    → 模拟结果:', JSON.stringify({
    层数: r.maxFloor, 击杀: r.kills, 战力: B.formatPower(r.power),
    死亡: r.deaths, 看广告: r.adsUsed, 用时: r.time + 's'
  }));
  assert.ok(r.maxFloor >= 5, `至少应到第 5 层，实际 ${r.maxFloor}`);
  assert.ok(r.maxFloor <= 60, `10 分钟不该超过 60 层，实际 ${r.maxFloor}`);
  assert.ok(r.kills > 30, '击杀数应显著大于 0');
  assert.ok(!r.nanSeen, '不应出现 NaN');
});

test('机器人模拟：会死（危险是真实的），复活能继续', () => {
  // 用"无脑冲向最近的怪"的莽夫策略：不懂躲就该死，这样才证明威胁是真的。
  // （谨慎机器人会躲，新曲线下它能苟活但会卡关，0 死亡是正常的，测不出威胁）
  const r = simulate(777, { useAds: false, policy: 'reckless' });
  console.log('    → 莽夫策略:', JSON.stringify({ 死亡: r.deaths, 层数: r.maxFloor }));
  assert.ok(r.deaths > 0, '不懂躲怪的玩家应该会死');
  assert.ok(r.phase === 'playing' || r.phase === 'dead');
});

test('机器人模拟：8 个种子结果都在合理区间', () => {
  const floors = [];
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
    const r = simulate(seed, { duration: 8 * 60 });
    floors.push(r.maxFloor);
    assert.ok(!r.nanSeen, `种子 ${seed} 出现 NaN`);
  }
  console.log('    → 8 个种子最高层数:', floors.join(', '));
  assert.ok(Math.min(...floors) >= 4, `最差种子也应到第 4 层，实际 ${Math.min(...floors)}`);
  assert.ok(Math.max(...floors) <= 70, `最好种子也不该超过 70 层，实际 ${Math.max(...floors)}`);
});

test('回归：过层后主角不会被新刷的石柱卡在墙里（曾经踩过的坑）', () => {
  // 这个 bug 的真实形态：buildFloor 重新生成随机石柱，但主角位置没重置，
  // 石柱盖在主角脚下 → blockedAt 永远为真 → 一步都动不了，整局废掉。
  const spots = [[120, 120], [760, 500], [240, 420], [640, 180], [400, 300]];
  for (const [px, py] of spots) {
    const game = Engine.createGame({ rand: mulberry32(31 + px) });
    game.start();
    const s = game.state;
    // 把主角挪到任意位置，然后强制过层（触发地图重生成）
    s.hero.x = px; s.hero.y = py;
    s.monsters = [];
    s.clearAt = s.time + 0.01;
    for (let i = 0; i < 30 && s.floor === 1; i++) game.tick(DT);
    assert.equal(s.floor, 2, '应已过层');

    const x0 = s.hero.x;
    game.setDirection(1, 0);
    for (let i = 0; i < 60; i++) game.tick(DT);
    game.setDirection(0, 0);
    assert.ok(s.hero.x > x0 + 5, `从 (${px},${py}) 过层后主角应仍能移动，实际 x=${s.hero.x}`);
  }
});

test('挂机玩家：第 1 层怪物不会动，所以不会死（符合设计）', () => {
  const game = Engine.createGame({ rand: mulberry32(22) });
  game.start();
  for (let i = 0; i < 60 * 30; i++) game.tick(DT);
  assert.equal(game.state.phase, 'playing', '第 1 层没有追击怪，挂机不会死');
  assert.equal(game.state.floor, 1, '不操作也过不了层');
});

test('长时间空跑不会泄漏实体（数组不会无限增长）', () => {
  const game = Engine.createGame({ rand: mulberry32(23) });
  game.start();
  for (let i = 0; i < 60 * 60; i++) {
    game.tick(DT);
    if (i % 600 === 0) {
      const s = game.state;
      assert.ok(s.monsters.length <= B.CONFIG.monsterCountMax + 5, `怪物数异常: ${s.monsters.length}`);
      assert.ok(s.items.length <= 5, `装备数异常: ${s.items.length}`);
      assert.ok(s.traps.length <= B.CONFIG.trapCountMax, `陷阱数异常: ${s.traps.length}`);
    }
  }
});
