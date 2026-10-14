/**
 * engine.js —— 纯逻辑游戏引擎（战力吞噬制，无 DOM 依赖）
 *
 * 规则：
 *   主角靠移动去"选"目标。碰到战力 <= 自己的怪 → 一击秒杀并吞噬其战力；
 *   碰到战力 > 自己的怪 → 直接死亡。陷阱会按百分比削战力。
 *   清空本层所有怪物即通关，进入下一层。
 *
 * 因为不碰 DOM，可以在 Node 里注入随机数直接跑模拟测试。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var B = (typeof module === 'object' && module.exports)
    ? require('./balance.js')
    : root.Balance;

  var C = B.CONFIG;
  var CELL = C.cell;
  var COLS = Math.floor(C.arenaW / CELL);
  var ROWS = Math.floor(C.arenaH / CELL);
  var ARENA = { w: C.arenaW, h: C.arenaH };
  var HERO_HOME = { x: C.arenaW / 2, y: C.arenaH / 2 };
  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function dist(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  var EQUIP_NAMES = [
    ['生锈的', '短剑'], ['锋利的', '匕首'], ['精铁的', '长剑'], ['秘银的', '战斧'],
    ['龙纹', '巨刃'], ['深渊', '镰刀'], ['弑神的', '法杖']
  ];
  var TIER_BY_MULT = [
    { max: 0.18, name: '普通', color: '#c9c2b6' },
    { max: 0.26, name: '优秀', color: '#5fd06a' },
    { max: 0.33, name: '精良', color: '#5aa7e8' },
    { max: 1e9, name: '史诗', color: '#b06ce0' }
  ];

  function createGame(options) {
    options = options || {};
    var rand = options.rand || Math.random;
    var emit = options.onEvent || function () {};

    var state = null;

    function newState() {
      return {
        phase: 'title',        // title | playing | dead
        time: 0,
        floor: 1,
        floorStartPower: C.startPower,
        kills: 0,
        absorbed: 0,
        nextId: 1,
        grid: [],
        hero: {
          x: HERO_HOME.x, y: HERO_HOME.y,
          power: C.startPower,
          r: C.heroRadius,
          speed: C.heroSpeed,
          tx: null, ty: null,          // 点击移动的目标点
          kx: 0, ky: 0,                // 键盘方向
          facing: -Math.PI / 2,
          moving: false,
          bob: 0,
          invulnUntil: 0,
          shieldUntil: 0,
          speedUntil: 0,
          luckUntil: 0,
          boostUntil: 0,               // 广告复活带来的战力翻倍
          autoUntil: -1,               // 自动战斗结束时间，Infinity = 永久
          autoCd: 0,
          autoWanderX: null, autoWanderY: null,
          path: null, pathIdx: 0,        // 点击移动的寻路结果
          repathCd: 0, pathFails: 0,
          stuckX: 0, stuckY: 0, stuckTimer: 0,
          firstCharge: false
        },
        monsters: [],
        items: [],
        props: [],
        traps: [],
        clearAt: -1,
        banner: null,
        deadStats: null,
        shake: 0
      };
    }

    /* ---------------- 派生数值 ---------------- */

    function heroPower() {
      var h = state.hero;
      return h.power * (state.time < h.boostUntil ? C.reviveBoost : 1);
    }

    /** 这一下能不能打得过这个怪 */
    function canBeat(m) { return heroPower() >= m.power; }

    function fire(type, data) {
      data = data || {};
      data.type = type;
      emit(data);
    }

    function setBanner(text, kind, seconds) {
      state.banner = { text: text, kind: kind || '', until: state.time + (seconds || 1.8) };
    }

    /* ---------------- 地图生成 ---------------- */

    function blankGrid() {
      var g = [];
      for (var y = 0; y < ROWS; y++) {
        var row = [];
        for (var x = 0; x < COLS; x++) {
          row.push((x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1) ? 1 : 0);
        }
        g.push(row);
      }
      return g;
    }

    function fillRect(g, gx, gy, w, h) {
      for (var y = gy; y < gy + h; y++) for (var x = gx; x < gx + w; x++) g[y][x] = 1;
    }

    function nearCenter(gx, gy, w, h, padCells) {
      var cx = Math.floor(COLS / 2), cy = Math.floor(ROWS / 2);
      return !(gx + w < cx - padCells || gx > cx + padCells || gy + h < cy - padCells || gy > cy + padCells);
    }

    function reachableCount(g, sx, sy) {
      var seen = {};
      var stack = [[sx, sy]];
      var count = 0;
      seen[sx + ',' + sy] = 1;
      while (stack.length) {
        var p = stack.pop();
        count++;
        var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (var i = 0; i < 4; i++) {
          var nx = p[0] + dirs[i][0], ny = p[1] + dirs[i][1];
          var key = nx + ',' + ny;
          if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
          if (g[ny][nx] || seen[key]) continue;
          seen[key] = 1;
          stack.push([nx, ny]);
        }
      }
      return count;
    }

    function freeCells(g) {
      var n = 0;
      for (var y = 0; y < ROWS; y++) for (var x = 0; x < COLS; x++) if (!g[y][x]) n++;
      return n;
    }

    /** 生成地图：外墙 + 随机石柱，并保证中心可达大部分区域 */
    function buildGrid(floor) {
      var g = blankGrid();
      var cx = Math.floor(COLS / 2), cy = Math.floor(ROWS / 2);

      // 先清出中心 3×3 作为出生区（防御性：绝不把主角刷在墙里）
      for (var by = cy - 1; by <= cy + 1; by++) {
        for (var bx = cx - 1; bx <= cx + 1; bx++) {
          if (bx > 0 && by > 0 && bx < COLS - 1 && by < ROWS - 1) g[by][bx] = 0;
        }
      }

      var pillarCount = Math.min(14, 5 + Math.floor(floor * 1.2));
      for (var i = 0; i < pillarCount; i++) {
        var w = rand() < 0.35 ? 2 : 1;
        var h = rand() < 0.35 ? 2 : 1;
        var gx = 1 + Math.floor(rand() * (COLS - 2 - w));
        var gy = 1 + Math.floor(rand() * (ROWS - 2 - h));
        if (nearCenter(gx, gy, w, h, 2)) continue;   // 别把主角出生点围死
        fillRect(g, gx, gy, w, h);
      }
      var free = freeCells(g);
      var reach = reachableCount(g, cx, cy);
      if (reach < free * 0.55) return buildGrid(floor);   // 连通性不够就重来
      return g;
    }

    function blockedAt(x, y, r) {
      var gx0 = Math.floor((x - r) / CELL), gx1 = Math.floor((x + r) / CELL);
      var gy0 = Math.floor((y - r) / CELL), gy1 = Math.floor((y + r) / CELL);
      for (var gy = gy0; gy <= gy1; gy++) {
        for (var gx = gx0; gx <= gx1; gx++) {
          if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return true;
          if (state.grid[gy][gx]) return true;
        }
      }
      return false;
    }

    function moveEntity(e, dx, dy) {
      if (!blockedAt(e.x + dx, e.y, e.r)) e.x += dx;
      if (!blockedAt(e.x, e.y + dy, e.r)) e.y += dy;
    }

    /** 找离 (gx,gy) 最近的空格（目标点落在墙里时用） */
    function nearestFreeCell(gx, gy) {
      for (var r = 1; r <= 4; r++) {
        for (var dy = -r; dy <= r; dy++) {
          for (var dx = -r; dx <= r; dx++) {
            var x = gx + dx, y = gy + dy;
            if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
            if (!state.grid[y][x]) return { x: x, y: y };
          }
        }
      }
      return null;
    }

    /**
     * BFS 网格寻路：返回世界坐标途经点数组（不含起点）。
     * 找不到路返回 null。网格只有 22×15，成本可以忽略。
     */
    function findPath(startX, startY, goalX, goalY) {
      var sx = clamp(Math.floor(startX / CELL), 0, COLS - 1);
      var sy = clamp(Math.floor(startY / CELL), 0, ROWS - 1);
      var gx = clamp(Math.floor(goalX / CELL), 0, COLS - 1);
      var gy = clamp(Math.floor(goalY / CELL), 0, ROWS - 1);

      if (state.grid[sy][sx]) {
        var alt = nearestFreeCell(sx, sy);
        if (!alt) return null;
        sx = alt.x; sy = alt.y;
      }
      if (state.grid[gy][gx]) {
        var alt2 = nearestFreeCell(gx, gy);
        if (!alt2) return null;
        gx = alt2.x; gy = alt2.y;
      }

      var startKey = sx + ',' + sy;
      var goalKey = gx + ',' + gy;
      if (startKey === goalKey) return [];

      var came = {};
      came[startKey] = null;
      var queue = [[sx, sy]];
      var head = 0;
      var found = false;

      while (head < queue.length) {
        var cur = queue[head++];
        var ck = cur[0] + ',' + cur[1];
        if (ck === goalKey) { found = true; break; }
        for (var i = 0; i < 4; i++) {
          var nx = cur[0] + DIRS[i][0], ny = cur[1] + DIRS[i][1];
          if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
          var nk = nx + ',' + ny;
          if (state.grid[ny][nx] || came.hasOwnProperty(nk)) continue;
          came[nk] = ck;
          queue.push([nx, ny]);
        }
      }
      if (!found) return null;

      var cells = [];
      var k = goalKey;
      while (k && k !== startKey) {
        var parts = k.split(',');
        cells.push({ x: (+parts[0]) * CELL + CELL / 2, y: (+parts[1]) * CELL + CELL / 2 });
        k = came[k];
      }
      cells.reverse();
      return cells;
    }

    /** 找一个不与墙、出生点、已有实体重叠的空位 */
    function findSpot(minFromCenter, occupied, pad) {
      for (var t = 0; t < 80; t++) {
        var x = CELL + rand() * (C.arenaW - CELL * 2);
        var y = CELL + rand() * (C.arenaH - CELL * 2);
        if (blockedAt(x, y, 20)) continue;
        if (dist(x, y, HERO_HOME.x, HERO_HOME.y) < minFromCenter) continue;
        var ok = true;
        for (var i = 0; i < occupied.length; i++) {
          var o = occupied[i];
          if (dist(x, y, o.x, o.y) < (o.pad || 54)) { ok = false; break; }
        }
        if (ok) return { x: x, y: y };
      }
      // 宽松重试：只避开墙和出生点
      for (var t2 = 0; t2 < 40; t2++) {
        var x2 = CELL + rand() * (C.arenaW - CELL * 2);
        var y2 = CELL + rand() * (C.arenaH - CELL * 2);
        if (!blockedAt(x2, y2, 20) && dist(x2, y2, HERO_HOME.x, HERO_HOME.y) > 90) return { x: x2, y: y2 };
      }
      return null;
    }

    var MONSTER_RADIUS = { normal: 21, elite: 27, chaser: 23, boss: 46 };

    function spawnMonster(spec, basePower, occupied) {
      var spot = findSpot(150, occupied, spec.kind === 'boss' ? 130 : 60);
      if (!spot) return null;
      var m = {
        id: state.nextId++,
        kind: spec.kind,
        mult: spec.mult,
        power: B.monsterPower(spec.mult, basePower),
        x: spot.x, y: spot.y,
        r: MONSTER_RADIUS[spec.kind] || 21,
        hitFlash: 0,
        wob: rand() * Math.PI * 2,
        pad: spec.kind === 'boss' ? 130 : 60,
        dead: false
      };
      occupied.push({ x: m.x, y: m.y, pad: m.pad });
      return m;
    }

    function spawnItem(basePower, occupied) {
      var spot = findSpot(80, occupied, 50);
      if (!spot) return null;
      var mult = C.equipMulLo + rand() * (C.equipMulHi - C.equipMulLo);
      var bonus = B.equipmentBonus(basePower, rand);
      var tier = null;
      for (var i = 0; i < TIER_BY_MULT.length; i++) {
        if (mult <= TIER_BY_MULT[i].max) { tier = TIER_BY_MULT[i]; break; }
      }
      var namePair = EQUIP_NAMES[Math.floor(rand() * EQUIP_NAMES.length)];
      var it = {
        id: state.nextId++,
        x: spot.x, y: spot.y, r: 15,
        bonus: bonus, mult: mult,
        name: namePair[0] + namePair[1],
        tier: tier || TIER_BY_MULT[0],
        bob: rand() * Math.PI * 2,
        pad: 50
      };
      occupied.push({ x: it.x, y: it.y, pad: 50 });
      return it;
    }

    function spawnProp(occupied) {
      var spot = findSpot(70, occupied, 46);
      if (!spot) return null;
      var p = B.rollProp(rand);
      var pr = {
        id: state.nextId++,
        x: spot.x, y: spot.y, r: 16,
        kind: p.kind, name: p.name, icon: p.icon, desc: p.desc,
        bob: rand() * Math.PI * 2,
        pad: 46
      };
      occupied.push({ x: pr.x, y: pr.y, pad: 46 });
      return pr;
    }

    function spawnTrap(occupied) {
      var spot = findSpot(60, occupied, 44);
      if (!spot) return null;
      var t = {
        id: state.nextId++,
        x: spot.x, y: spot.y, r: 14,
        spent: false, detected: false,
        pad: 44
      };
      occupied.push({ x: t.x, y: t.y, pad: 44 });
      return t;
    }

    function buildFloor() {
      var s = state;
      s.grid = buildGrid(s.floor);
      var basePower = s.hero.power;
      s.floorStartPower = basePower;
      s.monsters = [];
      s.items = [];
      s.props = [];
      s.traps = [];
      s.clearAt = -1;

      var occupied = [{ x: HERO_HOME.x, y: HERO_HOME.y, pad: 150 }];
      var specs = B.floorSpec(s.floor, rand);

      // BOSS 放在最远的空位，保证不会一出生就贴脸
      var bossSpec = null;
      for (var i = specs.length - 1; i >= 0; i--) {
        if (specs[i].kind === 'boss') { bossSpec = specs.splice(i, 1)[0]; break; }
      }

      for (var j = 0; j < specs.length; j++) {
        var m = spawnMonster(specs[j], basePower, occupied);
        if (m) s.monsters.push(m);
      }
      if (bossSpec) {
        var boss = spawnMonster(bossSpec, basePower, occupied);
        if (boss) s.monsters.push(boss);
      }

      var itemCount = rand() < C.equipChance ? C.equipCount : C.equipCount - 1;
      for (var k = 0; k < itemCount; k++) {
        var it = spawnItem(basePower, occupied);
        if (it) s.items.push(it);
      }

      var pCount = B.propCount(s.floor, rand);
      for (var p = 0; p < pCount; p++) {
        var pr = spawnProp(occupied);
        if (pr) s.props.push(pr);
      }

      var tCount = B.trapCount(s.floor);
      for (var q = 0; q < tCount; q++) {
        var tr = spawnTrap(occupied);
        if (tr) s.traps.push(tr);
      }

      fire('floor', {
        floor: s.floor,
        monsters: s.monsters.length,
        boss: B.isBossFloor(s.floor)
      });
    }

    /* ---------------- 战斗 ---------------- */

    function absorbMonster(m) {
      var h = state.hero;
      var mul = state.time < h.luckUntil ? C.luckMul : 1;
      // 只吞一部分：全吞会让每层成长 = 1+Σ倍数，层数一多就指数爆炸
      var gain = Math.max(1, Math.round(m.power * C.absorbRatio * mul));
      h.power += gain;
      state.kills += 1;
      state.absorbed += m.power;
      fire('kill', {
        x: m.x, y: m.y, power: m.power, gain: gain,
        kind: m.kind, luck: mul > 1, remaining: state.monsters.length - 1
      });
      var idx = state.monsters.indexOf(m);
      if (idx >= 0) state.monsters.splice(idx, 1);
      if (state.monsters.length === 0 && state.clearAt < 0) {
        state.clearAt = state.time + 0.8;
      }
      return gain;
    }

    function die(killer) {
      state.phase = 'dead';
      state.deadStats = {
        floor: state.floor,
        kills: state.kills,
        power: state.hero.power,
        killerPower: killer ? killer.power : 0,
        time: Math.round(state.time)
      };
      fire('dead', state.deadStats);
    }

    function resolveContacts() {
      var h = state.hero;
      var power = heroPower();
      for (var i = state.monsters.length - 1; i >= 0; i--) {
        var m = state.monsters[i];
        if (dist(m.x, m.y, h.x, h.y) > h.r + m.r) continue;
        if (power >= m.power) {
          absorbMonster(m);
          continue;
        }
        if (state.time < h.invulnUntil || state.time < h.shieldUntil) continue;   // 护盾期穿过去
        die(m);
        return;
      }
    }

    /* ---------------- 道具效果 ---------------- */

    function useProp(pr) {
      var h = state.hero;
      var power = heroPower();
      var killed = 0;

      if (pr.kind === 'shield') {
        h.shieldUntil = state.time + C.shieldSeconds;
      } else if (pr.kind === 'speed') {
        h.speedUntil = state.time + C.speedSeconds;
      } else if (pr.kind === 'luck') {
        h.luckUntil = state.time + C.luckSeconds;
      } else if (pr.kind === 'bomb') {
        var victims = state.monsters.filter(function (m) {
          return m.power <= power && dist(m.x, m.y, h.x, h.y) <= C.bombRange;
        });
        for (var i = 0; i < victims.length; i++) {
          absorbMonster(victims[i]);
          killed++;
        }
      } else if (pr.kind === 'magnet') {
        var pull = state.items.concat(state.props);
        for (var j = 0; j < pull.length; j++) {
          var o = pull[j];
          if (dist(o.x, o.y, h.x, h.y) <= C.magnetRange) {
            o.x = h.x + (rand() * 40 - 20);
            o.y = h.y + (rand() * 40 - 20);
          }
        }
      }

      var idx = state.props.indexOf(pr);
      if (idx >= 0) state.props.splice(idx, 1);
      fire('prop', { kind: pr.kind, name: pr.name, icon: pr.icon, killed: killed });
      return { kind: pr.kind, killed: killed };
    }

    function pickItem(it) {
      var h = state.hero;
      h.power += it.bonus;
      var idx = state.items.indexOf(it);
      if (idx >= 0) state.items.splice(idx, 1);
      fire('equip', { x: it.x, y: it.y, name: it.name, bonus: it.bonus, tier: it.tier.name, color: it.tier.color });
      return it.bonus;
    }

    /* ---------------- 陷阱 ---------------- */

    function updateTraps() {
      var h = state.hero;
      for (var i = 0; i < state.traps.length; i++) {
        var t = state.traps[i];
        if (t.spent) continue;
        var d = dist(t.x, t.y, h.x, h.y);
        if (d < C.trapTriggerRange) {
          t.spent = true;
          t.detected = true;
          var loss = Math.max(1, Math.floor(h.power * C.trapPowerLoss));
          h.power = Math.max(1, h.power - loss);
          state.shake = Math.max(state.shake, 0.35);
          fire('trap', { x: t.x, y: t.y, loss: loss, power: h.power });
        } else if (d < C.trapDetectRange) {
          t.detected = true;
        }
      }
    }

    /* ---------------- 怪物 AI ---------------- */

    function updateMonsters(dt) {
      var h = state.hero;
      var power = heroPower();
      for (var i = 0; i < state.monsters.length; i++) {
        var m = state.monsters[i];
        if (m.hitFlash > 0) m.hitFlash -= dt;
        m.wob += dt * 2;

        // 会追人的怪：朝主角跑；打不过的追不上也咬不到（跑得比主角慢）
        if (m.kind === 'chaser' && power < m.power) {
          var dx = h.x - m.x, dy = h.y - m.y;
          var d = Math.sqrt(dx * dx + dy * dy) || 1;
          moveEntity(m, (dx / d) * C.chaserSpeed * dt, (dy / d) * C.chaserSpeed * dt);
        }
      }
    }

    /* ---------------- 自动战斗 ---------------- */

    function updateAuto(dt) {
      var h = state.hero;
      if (state.time >= h.autoUntil) return;
      h.autoCd -= dt;
      if (h.autoCd > 0) return;
      h.autoCd = C.autoInterval;

      var power = heroPower();
      var target = null, best = Infinity;
      for (var i = 0; i < state.monsters.length; i++) {
        var m = state.monsters[i];
        if (m.power > power) continue;
        var d = dist(m.x, m.y, h.x, h.y);
        if (d < best) { best = d; target = m; }
      }
      if (target) { h.tx = target.x; h.ty = target.y; return; }

      // 没有能打的怪就去捡装备/道具
      var pick = null, bestP = Infinity;
      var all = state.items.concat(state.props);
      for (var j = 0; j < all.length; j++) {
        var d2 = dist(all[j].x, all[j].y, h.x, h.y);
        if (d2 < bestP) { bestP = d2; pick = all[j]; }
      }
      if (pick) { h.tx = pick.x; h.ty = pick.y; return; }

      // 闲逛：找个随机点
      if (h.autoWanderX == null || dist(h.x, h.y, h.autoWanderX, h.autoWanderY) < 30) {
        h.autoWanderX = CELL * 2 + rand() * (C.arenaW - CELL * 4);
        h.autoWanderY = CELL * 2 + rand() * (C.arenaH - CELL * 4);
      }
      h.tx = h.autoWanderX;
      h.ty = h.autoWanderY;
    }

    /* ---------------- 主循环 ---------------- */

    function updateHero(dt) {
      var h = state.hero;
      var sp = h.speed * (state.time < h.speedUntil ? C.speedMul : 1);
      var dx = 0, dy = 0;

      if (h.kx || h.ky) {
        dx = h.kx; dy = h.ky;
        h.tx = null; h.ty = null; h.path = null;
      } else if (h.tx != null) {
        // 沿寻路途经点走。路径只在缺失时才重算——
        // 注意：不能每次计时器到点就重置 pathIdx，否则主角会被反复拽回第一个
        // 途经点，永远到不了远处的目标（机器人测试测不到，因为它每 0.15s 就重新寻路）
        h.repathCd -= dt;
        if (h.repathCd <= 0) {
          h.repathCd = 0.4;
          if (!h.path) {
            h.path = findPath(h.x, h.y, h.tx, h.ty);
            h.pathIdx = 0;
          }
        }

        var advanced = false;
        while (h.path && h.pathIdx < h.path.length) {
          var wp = h.path[h.pathIdx];
          if (Math.hypot(wp.x - h.x, wp.y - h.y) < 9) { h.pathIdx++; continue; }
          dx = wp.x - h.x; dy = wp.y - h.y;
          advanced = true;
          break;
        }
        if (!advanced) {
          // 路径走完了，直接扑向最终目标
          var fdx = h.tx - h.x, fdy = h.ty - h.y;
          if (Math.hypot(fdx, fdy) < 5) { h.tx = null; h.ty = null; h.path = null; }
          else { dx = fdx; dy = fdy; }
        }
      }

      if (dx || dy) {
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len > 1) { dx /= len; dy /= len; }
        moveEntity(h, dx * sp * dt, dy * sp * dt);
        h.facing = Math.atan2(dy, dx);
        h.moving = true;
        h.bob += dt * 12;

        // 卡住检测：一直想动却挪不动 → 重算路径；反复失败就放弃这个目标
        h.stuckTimer += dt;
        if (h.stuckTimer > 0.4) {
          var moved = Math.hypot(h.x - h.stuckX, h.y - h.stuckY);
          if (moved < 6) {
            h.path = findPath(h.x, h.y, h.tx, h.ty);
            h.pathIdx = 0;
            h.pathFails++;
            if (h.pathFails > 3) { h.tx = null; h.ty = null; h.path = null; h.pathFails = 0; }
          } else {
            h.pathFails = 0;
          }
          h.stuckX = h.x; h.stuckY = h.y; h.stuckTimer = 0;
        }
      } else {
        h.moving = false;
        h.stuckX = h.x; h.stuckY = h.y; h.stuckTimer = 0;
      }
    }

    function tick(dt) {
      if (state.phase !== 'playing') return;
      dt = clamp(dt, 0, 0.05);
      state.time += dt;
      if (state.shake > 0) state.shake -= dt;

      updateAuto(dt);
      updateHero(dt);
      updateMonsters(dt);
      updateTraps();
      resolveContacts();

      if (state.phase !== 'playing') return;   // 本帧已死亡

      // 拾取：先道具后装备。
      // 顺序很重要——磁铁会把装备吸到身上，必须同一帧就生效，否则要等下一帧
      var h = state.hero;
      for (var j = state.props.length - 1; j >= 0; j--) {
        if (dist(state.props[j].x, state.props[j].y, h.x, h.y) <= h.r + state.props[j].r + 4) useProp(state.props[j]);
      }
      for (var i = state.items.length - 1; i >= 0; i--) {
        if (dist(state.items[i].x, state.items[i].y, h.x, h.y) <= h.r + state.items[i].r + 4) pickItem(state.items[i]);
      }

      if (state.clearAt >= 0 && state.time >= state.clearAt) {
        state.clearAt = -1;
        advanceFloor();
      }

      if (state.banner && state.time >= state.banner.until) state.banner = null;
    }

    function advanceFloor() {
      state.floor += 1;
      var h = state.hero;
      h.invulnUntil = state.time + 1.2;
      // 新的一层是新的房间：主角回到入口（中心）。
      // 必须重置位置——否则新刷的石柱可能正好盖在主角脚下，把人卡在墙里永远动不了
      h.x = HERO_HOME.x;
      h.y = HERO_HOME.y;
      h.tx = null; h.ty = null; h.path = null;
      h.pathFails = 0;
      h.stuckX = h.x; h.stuckY = h.y; h.stuckTimer = 0;
      h.autoWanderX = null; h.autoWanderY = null;
      var boss = B.isBossFloor(state.floor);
      setBanner(boss ? `第 ${state.floor} 层 · BOSS` : `第 ${state.floor} 层`, boss ? 'boss' : '', boss ? 2.4 : 1.6);
      buildFloor();
    }

    /* ---------------- 对外接口 ---------------- */

    var game = {
      ARENA: ARENA,
      HERO_HOME: HERO_HOME,
      state: null,

      start: function () {
        state = newState();
        state.phase = 'playing';
        setBanner('第 1 层', '', 1.6);
        buildFloor();
        fire('start', {});
        return state;
      },

      restart: function () { return this.start(); },

      tick: tick,
      heroPower: heroPower,
      canBeat: canBeat,

      /** 点击/触摸移动：让主角走到这个点（自动绕开墙） */
      setMoveTarget: function (x, y) {
        var h = state.hero;
        h.tx = clamp(x, CELL, C.arenaW - CELL);
        h.ty = clamp(y, CELL, C.arenaH - CELL);
        h.path = findPath(h.x, h.y, h.tx, h.ty);
        h.pathIdx = 0;
        h.pathFails = h.path ? 0 : h.pathFails + 1;
        h.repathCd = 0.4;
        h.stuckX = h.x; h.stuckY = h.y; h.stuckTimer = 0;
        h.autoWanderX = null;
      },

      /** 键盘方向，dx/dy 为 -1/0/1 */
      setDirection: function (dx, dy) {
        var h = state.hero;
        h.kx = clamp(dx, -1, 1);
        h.ky = clamp(dy, -1, 1);
        if (h.kx || h.ky) { h.tx = null; h.ty = null; }
      },

      setAuto: function (seconds) {
        state.hero.autoUntil = state.time + seconds;
        state.hero.autoWanderX = null;
        fire('auto', { on: this.hasAuto() });
      },

      hasAuto: function () { return state.time < state.hero.autoUntil; },

      /** 看广告复活：保留战力 + 短暂无敌 + 战力翻倍一会儿 */
      revive: function () {
        if (state.phase !== 'dead') return false;
        var h = state.hero;
        state.phase = 'playing';
        h.invulnUntil = state.time + C.reviveInvuln;
        h.boostUntil = state.time + C.reviveBoostSeconds;
        state.deadStats = null;
        fire('revive', { boost: C.reviveBoostSeconds });
        return true;
      },

      /** 看广告抽装备：按「当前战力」折算，卡关时也拿得出手 */
      drawEquipment: function () {
        var h = state.hero;
        var bonus = Math.max(1, Math.round(heroPower() * (0.5 + rand() * 0.5)));
        var namePair = EQUIP_NAMES[EQUIP_NAMES.length - 1];
        h.power += bonus;
        fire('equip', {
          x: h.x, y: h.y, name: namePair[0] + namePair[1],
          bonus: bonus, tier: '史诗', color: '#b06ce0'
        });
        return bonus;
      },

      /** 首充（演示）：战力 ×3 + 永久自动战斗 */
      grantFirstCharge: function () {
        var h = state.hero;
        if (h.firstCharge) return false;
        h.power = Math.max(1, Math.round(h.power * 3));
        h.firstCharge = true;
        h.autoUntil = Infinity;
        fire('firstcharge', { power: h.power });
        return true;
      },

      /** 供测试/调试：直接给主角加战力 */
      grantPower: function (n) { state.hero.power += n; }
    };

    Object.defineProperty(game, 'state', { get: function () { return state; } });
    return game;
  }

  return { createGame: createGame, ARENA: ARENA, COLS: COLS, ROWS: ROWS };
});
