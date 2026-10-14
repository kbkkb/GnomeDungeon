/**
 * balance.js —— 纯数值模块（战力吞噬制）
 *
 * 核心规则：
 *   战力 >= 怪物战力 → 一击秒杀，并把怪物的战力吞进来（数字膨胀）
 *   战力 <  怪物战力 → 碰到即死
 * 所以"战力"同时就是血量，走位选择打谁就是全部策略。
 *
 * 怪物数值不按绝对值成长，而是按「主角进入本层时的战力」取倍数生成，
 * 这样每一层都自动处于"大部分能打、少数打不过"的紧张区间，
 * 层数只决定危险的尖峰有多高（精英/BOSS 倍数随层数上涨）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Balance = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONFIG = {
    /* ---- 场地 ---- */
    cell: 40,
    arenaW: 880,
    arenaH: 620,

    /* ---- 主角 ---- */
    // 起始战力不能是 1：怪物战力 = 起始战力 × 倍数，倍率下限只有 0.25，
    // 全都会 round 到 1，第一个房间就是一排"1"，完全没有成长感。
    startPower: 10,
    heroRadius: 16,
    heroSpeed: 210,          // px/s

    /* ---- 吞噬 ---- */
    // 只吞对方一部分战力。全吞时每层成长 = 1 + Σ倍数，层数一多就指数爆炸，
    // 敌人的相对强度永远追不上玩家 —— 这就是"战力膨胀太快"的根源。
    absorbRatio: 0.5,

    /* ---- 每层刷怪 ---- */
    monsterCountBase: 5,
    monsterCountPerFloor: 0.5,   // 每层多半只，深层层数增长更平缓
    monsterCountMax: 11,
    monsterMinBeat: 2,           // 每层至少这么多"开局就打得过"的怪，保证有东西可刷
    eliteChanceBase: 0.10,
    eliteChancePerFloor: 0.012,
    eliteChanceMax: 0.28,
    eliteMulLoBase: 1.15,    // 精英战力倍数下限（随层数上移）
    eliteMulLoPerFloor: 0.05,
    eliteMulHiBase: 2.2,
    eliteMulHiPerFloor: 0.12,
    eliteMulHiMax: 6,

    // 普通怪倍数区间整体随层数上移 —— 这是"敌人跟得上玩家"的关键：
    // 只让精英/BOSS 变强是不够的，深层层连普通怪也得追上玩家的相对强度，
    // 否则玩家一路秒过去，毫无压力。
    normalMulLoBase: 0.25,
    normalMulLoPerFloor: 0.04,
    normalMulLoMax: 0.80,    // 下限也要封顶，否则深层层没有能刷的怪了
    normalMulHiBase: 1.8,
    normalMulHiPerFloor: 0.08,
    normalMulHiMax: 3.0,
    normalMulSafeHi: 0.95,    // "开局就打得过"的口粮上限（保底怪用这个区间）

    chaserFromFloor: 3,      // 从第几层开始出现会追人的怪
    chaserCountBase: 1,
    chaserCountEvery: 4,     // 每多 4 层多一只
    chaserCountMax: 3,
    chaserMulLo: 0.7,
    chaserMulHi: 1.3,
    chaserSpeed: 118,        // 比主角慢，跑得过

    bossEvery: 5,
    bossMulBase: 3.2,
    bossMulPerFloor: 0.22,
    bossMulMax: 14,

    /* ---- 装备与道具 ---- */
    equipChance: 0.75,       // 每层至少掉一件的概率
    equipCount: 2,
    equipMulLo: 0.12,        // 装备加成 = 本层初始战力 × 倍数
    equipMulHi: 0.40,

    propChance: 0.85,
    propCount: 2,

    /* ---- 陷阱 ---- */
    trapFromFloor: 2,
    trapCountBase: 2,
    trapCountPerFloor: 1,
    trapCountMax: 8,
    trapPowerLoss: 0.25,     // 踩到损失 25% 战力
    trapDetectRange: 95,     // 靠近后显形
    trapTriggerRange: 30,

    /* ---- 广告 / 首充（演示）---- */
    reviveInvuln: 4,
    reviveBoost: 2,
    reviveBoostSeconds: 20,
    adSeconds: 5,
    shieldSeconds: 5,
    speedMul: 1.7,
    speedSeconds: 6,
    luckSeconds: 10,
    luckMul: 2,
    magnetRange: 320,
    bombRange: 250,
    autoInterval: 0.12
  };

  /* ---- 道具 ---- */
  var PROPS = [
    { kind: 'shield', name: '无敌护盾', icon: '🛡', desc: '5 秒内刀枪不入，可以穿过任何怪物', weight: 24 },
    { kind: 'bomb',   name: '炸弹',     icon: '💥', desc: '消灭周围所有打得过的怪物',         weight: 24 },
    { kind: 'magnet', name: '磁铁',     icon: '🧲', desc: '把附近的装备和道具吸过来',         weight: 18 },
    { kind: 'speed',  name: '疾风之靴', icon: '👟', desc: '6 秒内移动速度大幅提升',           weight: 18 },
    { kind: 'luck',   name: '幸运四叶', icon: '🍀', desc: '10 秒内吞噬获得的战力翻倍',       weight: 16 }
  ];
  var PROP_TOTAL = PROPS.reduce(function (s, p) { return s + p.weight; }, 0);

  function pickWeighted(list, total, rand) {
    var r = rand() * total;
    for (var i = 0; i < list.length; i++) {
      r -= list[i].weight;
      if (r <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  /* ---------------- 数字格式化（万 / 亿 / 兆） ---------------- */
  var UNITS = [[1e16, '京'], [1e12, '兆'], [1e8, '亿'], [1e4, '万']];

  function formatPower(n) {
    if (!isFinite(n)) return '∞';
    n = Math.floor(n);
    if (n < 1e4) return String(n);
    for (var i = 0; i < UNITS.length; i++) {
      if (n >= UNITS[i][0]) {
        var v = n / UNITS[i][0];
        var s = v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
        return s + UNITS[i][1];
      }
    }
    return String(n);
  }

  /* ---------------- 每层怪物配置 ---------------- */

  function isBossFloor(floor) { return floor % CONFIG.bossEvery === 0; }

  /**
   * 生成本层的怪物清单（倍数是相对于「进入本层时的战力」）
   * 返回 [{ kind, mult }]
   *
   * 两条硬约束：
   *
   * 1) 可清空性（链式）：把倍数升序排列，第 i 只怪的倍数不允许超过
   *    「刷完前面那些怪之后能达到的战力倍数」= 1 + absorbRatio × Σ(前面怪的倍数)。
   *    这保证无论数值多夸张，玩家永远能一层层滚上去，不会出现
   *    「小的刷完了、大的永远打不过」的死局。
   *    （早期版本只按"开局打得过的怪"算上限，倍数上移后那条假设不成立了。）
   *
   * 2) 永远有怪可刷：每层至少 monsterMinBeat 只怪落在低倍率区间，
   *    否则深层层一进门全是打不过的，直接卡死。
   *
   * 危险感来自"深层层大部分怪都比你强、你得边躲边刷"，而不是"永远过不去"。
   */
  function floorSpec(floor, rand) {
    var specs = [];
    var f = floor - 1;
    var count = Math.min(CONFIG.monsterCountMax,
      CONFIG.monsterCountBase + Math.floor(floor * CONFIG.monsterCountPerFloor));

    var lo = Math.min(CONFIG.normalMulLoMax,
      CONFIG.normalMulLoBase + f * CONFIG.normalMulLoPerFloor);
    var hi = Math.min(CONFIG.normalMulHiMax, CONFIG.normalMulHiBase + f * CONFIG.normalMulHiPerFloor);
    var safeHi = Math.min(hi, CONFIG.normalMulSafeHi);   // "开局就打得过"的上限
    var minBeat = Math.min(count, CONFIG.monsterMinBeat);

    var eliteChance = Math.min(CONFIG.eliteChanceMax,
      CONFIG.eliteChanceBase + floor * CONFIG.eliteChancePerFloor);
    var eliteLo = CONFIG.eliteMulLoBase + f * CONFIG.eliteMulLoPerFloor;
    var eliteHi = Math.min(CONFIG.eliteMulHiMax, CONFIG.eliteMulHiBase + f * CONFIG.eliteMulHiPerFloor);

    for (var i = 0; i < count; i++) {
      if (i < minBeat) {
        // 保底：低倍率区间的"口粮"
        specs.push({ kind: 'normal', mult: lo + rand() * Math.max(0.01, safeHi - lo) });
      } else if (rand() < eliteChance) {
        specs.push({ kind: 'elite', mult: eliteLo + rand() * (eliteHi - eliteLo) });
      } else {
        specs.push({ kind: 'normal', mult: lo + rand() * (hi - lo) });
      }
    }

    // 会追人的怪：从第 3 层开始，数量随层数增加
    if (floor >= CONFIG.chaserFromFloor) {
      var chasers = Math.min(
        CONFIG.chaserCountMax,
        CONFIG.chaserCountBase + Math.floor((floor - CONFIG.chaserFromFloor) / CONFIG.chaserCountEvery)
      );
      for (var c = 0; c < chasers; c++) {
        specs.push({ kind: 'chaser', mult: CONFIG.chaserMulLo + rand() * (CONFIG.chaserMulHi - CONFIG.chaserMulLo) });
      }
    }

    // BOSS 层
    if (isBossFloor(floor)) {
      specs.push({ kind: 'boss', mult: Math.min(CONFIG.bossMulMax, CONFIG.bossMulBase + floor * CONFIG.bossMulPerFloor) });
    }

    // ---- 可清空性收敛（链式）----
    // slice() 是浅拷贝，数组里装的是同一批对象引用，改 mult 即改到 specs 上
    var sorted = specs.slice().sort(function (a, b) { return a.mult - b.mult; });
    var reach = 1;                       // 当前战力 = 进入本层时的 1 倍
    for (var k = 0; k < sorted.length; k++) {
      if (sorted[k].mult > reach) sorted[k].mult = reach;   // 够不到就压到够得到
      reach += sorted[k].mult * CONFIG.absorbRatio;         // 吞掉它之后的战力倍数
    }
    return specs;
  }

  /** 由倍数算出绝对战力（至少 1） */
  function monsterPower(mult, basePower) {
    return Math.max(1, Math.round(basePower * mult));
  }

  /** 装备加成 */
  function equipmentBonus(basePower, rand) {
    return Math.max(1, Math.round(basePower * (CONFIG.equipMulLo + rand() * (CONFIG.equipMulHi - CONFIG.equipMulLo))));
  }

  function trapCount(floor) {
    if (floor < CONFIG.trapFromFloor) return 0;
    return Math.min(CONFIG.trapCountMax, CONFIG.trapCountBase + (floor - CONFIG.trapFromFloor + 1) * CONFIG.trapCountPerFloor);
  }

  function propCount(floor, rand) {
    return rand() < CONFIG.propChance ? CONFIG.propCount : CONFIG.propCount - 1;
  }

  function rollProp(rand) {
    return pickWeighted(PROPS, PROP_TOTAL, rand);
  }

  return {
    CONFIG: CONFIG,
    PROPS: PROPS,
    isBossFloor: isBossFloor,
    floorSpec: floorSpec,
    monsterPower: monsterPower,
    equipmentBonus: equipmentBonus,
    trapCount: trapCount,
    propCount: propCount,
    rollProp: rollProp,
    formatPower: formatPower
  };
});
