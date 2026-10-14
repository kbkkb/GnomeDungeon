/**
 * balance.test.mjs —— 数值模块单测（战力吞噬制）
 * 运行： node --test test/balance.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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

test('数字格式化：万 / 亿 / 兆 进位', () => {
  assert.equal(B.formatPower(1), '1');
  assert.equal(B.formatPower(999), '999');
  assert.equal(B.formatPower(9999), '9999');
  assert.equal(B.formatPower(10000), '1万');
  assert.equal(B.formatPower(12345), '1.2万');
  assert.equal(B.formatPower(999999), '100万');
  assert.equal(B.formatPower(123456789), '1.2亿');
  assert.equal(B.formatPower(1e12), '1兆');
  assert.equal(B.formatPower(1e16), '1京');
  assert.equal(B.formatPower(Infinity), '∞');
});

test('每 5 层是 BOSS 层，且 BOSS 倍数随层数上涨', () => {
  assert.ok(B.isBossFloor(5));
  assert.ok(B.isBossFloor(10));
  assert.ok(!B.isBossFloor(4));

  const rand = mulberry32(1);
  const boss5 = B.floorSpec(5, rand).filter(s => s.kind === 'boss');
  const boss20 = B.floorSpec(20, rand).filter(s => s.kind === 'boss');
  assert.equal(boss5.length, 1);
  assert.equal(boss20.length, 1);
  assert.ok(boss20[0].mult > boss5[0].mult, '高层 BOSS 应该更硬');
  assert.ok(boss20[0].mult <= B.CONFIG.bossMulMax, 'BOSS 倍数应有上限');
});

test('普通层没有 BOSS', () => {
  const rand = mulberry32(2);
  for (const f of [1, 2, 3, 4, 6, 7, 8, 9]) {
    const specs = B.floorSpec(f, rand);
    assert.equal(specs.filter(s => s.kind === 'boss').length, 0, `第 ${f} 层不该有 BOSS`);
  }
});

test('每层都有大量能刷的小怪，且保底有开局就打得过的', () => {
  const rand = mulberry32(3);
  for (const f of [1, 5, 10, 20, 40]) {
    const specs = B.floorSpec(f, rand);
    const normal = specs.filter(s => s.kind === 'normal');
    assert.ok(normal.length >= 5, `第 ${f} 层小怪太少：${normal.length}`);
    // 保底约束：至少 monsterMinBeat 只怪开局就打得过。
    // 没有这条，深层层一进门全是打不过的，玩家直接卡死
    const beatable = specs.filter(s => s.mult <= 1);
    assert.ok(beatable.length >= B.CONFIG.monsterMinBeat,
      `第 ${f} 层开局可打的怪只有 ${beatable.length} 只（保底 ${B.CONFIG.monsterMinBeat}）`);
  }
});

test('普通怪倍数随层数上移：敌人在相对强度上跟上玩家', () => {
  // 这是"敌人跟不上"的修复验证：只让精英/BOSS 变强是不够的，
  // 深层层连普通怪也得追上玩家的相对强度，否则玩家一路秒过去毫无压力
  const avgNormalMult = (f) => {
    const specs = B.floorSpec(f, mulberry32(f * 7 + 1)).filter(s => s.kind === 'normal');
    return specs.reduce((a, s) => a + s.mult, 0) / specs.length;
  };
  const a1 = avgNormalMult(1), a10 = avgNormalMult(10), a25 = avgNormalMult(25);
  assert.ok(a1 < 1, `第 1 层普通怪应普遍打得过，平均倍数 ${a1.toFixed(2)}`);
  assert.ok(a10 > a1, `第 10 层应更难：${a1.toFixed(2)} → ${a10.toFixed(2)}`);
  assert.ok(a25 > a10, `第 25 层应更难：${a10.toFixed(2)} → ${a25.toFixed(2)}`);

  // 封顶：区间参数不能无限上移（lo 不封顶就会导致深层层没有能刷的怪）
  const loDeep = B.CONFIG.normalMulLoBase + 59 * B.CONFIG.normalMulLoPerFloor;
  const hiDeep = B.CONFIG.normalMulHiBase + 59 * B.CONFIG.normalMulHiPerFloor;
  assert.ok(loDeep > B.CONFIG.normalMulLoMax, '深层层 lo 必须被封顶，否则没有能刷的怪');
  assert.ok(hiDeep > B.CONFIG.normalMulHiMax, '深层层 hi 必须被封顶');
  // 实际生成的普通怪不应突破 hi 封顶（链式收敛只会往下压，不会往上抬）
  for (const seed of [1, 2, 3]) {
    for (const s of B.floorSpec(60, mulberry32(seed)).filter(x => x.kind === 'normal')) {
      assert.ok(s.mult <= B.CONFIG.normalMulHiMax + 1e-9,
        `第 60 层普通怪倍数 ${s.mult.toFixed(2)} 超出封顶 ${B.CONFIG.normalMulHiMax}`);
    }
  }
});

test('首层数值有差异（不会再出现一屋子全是 1）', () => {
  // 旧版 startPower=1，怪物 = 1×[0.25,0.95] 全部 round 成 1，第一个房间就是一排"1"
  for (const seed of [5, 6, 7, 8]) {
    const specs = B.floorSpec(1, mulberry32(seed));
    const powers = specs.map(s => B.monsterPower(s.mult, B.CONFIG.startPower));
    const uniq = new Set(powers);
    assert.ok(uniq.size >= 3, `首层怪物战力应有差异，实际只有 ${[...uniq].join(',')}`);
    assert.ok(Math.max(...powers) >= 3, `首层该有像样的数字，最大只有 ${Math.max(...powers)}`);
    const beatable = powers.filter(p => p <= B.CONFIG.startPower).length;
    assert.ok(beatable >= B.CONFIG.monsterMinBeat, `首层可打的怪太少：${beatable}`);
  }
});

test('精英与追击怪的倍数区间随层数上移（越往后越危险）', () => {
  const rand = mulberry32(4);
  const eliteLo = (f) => B.CONFIG.eliteMulLoBase + f * B.CONFIG.eliteMulLoPerFloor;
  const eliteHi = (f) => Math.min(B.CONFIG.eliteMulHiMax, B.CONFIG.eliteMulHiBase + f * B.CONFIG.eliteMulHiPerFloor);
  assert.ok(eliteHi(20) > eliteHi(5), '精英上限应随层数提升');
  assert.ok(eliteLo(20) > eliteLo(5), '精英下限应随层数提升');

  // 第 3 层起出现追击怪
  const f2 = B.floorSpec(2, rand);
  assert.equal(f2.filter(s => s.kind === 'chaser').length, 0, '第 2 层不该有追击怪');
  const f5 = B.floorSpec(5, rand);
  assert.ok(f5.filter(s => s.kind === 'chaser').length >= 1, '第 5 层应有追击怪');
});

test('怪物数量随层数增加但有上限', () => {
  const rand = mulberry32(5);
  const c1 = B.floorSpec(1, rand).length;
  const c10 = B.floorSpec(10, rand).length;
  const c60 = B.floorSpec(60, rand).length;
  assert.ok(c10 > c1, '中期怪应更多');
  assert.ok(c60 <= B.CONFIG.monsterCountMax + 4, `怪数应有上限，实际 ${c60}`);
});

test('怪物战力 = 本层初始战力 × 倍数，且至少为 1', () => {
  assert.equal(B.monsterPower(0.5, 100), 50);
  assert.equal(B.monsterPower(0.01, 1), 1, '再小也不能低于 1');
  assert.equal(B.monsterPower(2.5, 1000), 2500);
});

test('装备加成随本层初始战力提升，且至少为 1', () => {
  const rand = mulberry32(6);
  const small = B.equipmentBonus(1, rand);
  const big = B.equipmentBonus(1e6, rand);
  assert.ok(small >= 1);
  assert.ok(big > small * 1000, '高战力层的装备应显著更强');
});

test('陷阱从第 2 层开始出现，数量有上限', () => {
  assert.equal(B.trapCount(1), 0, '第 1 层不该有陷阱');
  assert.ok(B.trapCount(2) > 0);
  assert.ok(B.trapCount(3) > B.trapCount(2), '陷阱应随层数变多');
  assert.ok(B.trapCount(99) <= B.CONFIG.trapCountMax, '陷阱数量应有上限');
});

test('道具池覆盖 5 种效果，权重合计有效', () => {
  assert.equal(B.PROPS.length, 5);
  const kinds = B.PROPS.map(p => p.kind);
  assert.deepEqual(kinds.sort(), ['bomb', 'luck', 'magnet', 'shield', 'speed']);
  const total = B.PROPS.reduce((s, p) => s + p.weight, 0);
  assert.ok(total > 0);

  const rand = mulberry32(7);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(B.rollProp(rand).kind);
  assert.ok(seen.size >= 4, '500 次抽样应覆盖大部分道具');
});

test('道具每层至少 1 件', () => {
  const rand = mulberry32(8);
  for (let i = 0; i < 50; i++) {
    assert.ok(B.propCount(5, rand) >= 1);
  }
});

test('可清空性不变量（链式）：按倍数从低到高打，每一步都够得着', () => {
  // 这是最关键的设计约束。把每层怪物按倍数升序排列，
  // 第 i 只怪的倍数必须 ≤ 1 + 吞噬比例 × 前面所有怪倍数之和，
  // 也就是"刷完前面这些之后能达到的战力"。
  // 不满足就会出现"小的刷完、大的永远打不过"的死局，玩家只能弃游。
  // （早期版本按"Σ小怪倍数"算上限，倍数上移后那条假设已不成立）
  for (const floor of [1, 2, 3, 5, 8, 10, 15, 20, 30, 50]) {
    for (const seed of [1, 2, 3, 7, 11, 23, 99]) {
      const rand = mulberry32(seed * 1000 + floor);
      const specs = B.floorSpec(floor, rand).slice().sort((a, b) => a.mult - b.mult);
      let reach = 1;
      for (const s of specs) {
        assert.ok(s.mult <= reach + 1e-9,
          `第 ${floor} 层种子 ${seed}：${s.kind} 倍数 ${s.mult.toFixed(2)} 超出可达上限 ${reach.toFixed(2)}`);
        reach += s.mult * B.CONFIG.absorbRatio;
      }
    }
  }
});

test('关键规则：打得过才秒杀，打不过即死', () => {
  // 第 1 层就要有"打不过"的怪，否则开局一路秒，玩家学不会看数字、
  // 也体会不到"红色数字别碰"这个核心机制（早期版本首层全是 1 或全都打得过，
  // 都被反馈过"没有挑战/没有成长感"）。
  // 但同时必须有保底能打的怪，否则开局直接卡死。
  assert.ok(B.CONFIG.normalMulHiBase > 1,
    `第 1 层必须存在打不过的怪，实际 hi=${B.CONFIG.normalMulHiBase}`);
  assert.ok(B.CONFIG.normalMulSafeHi < 1, '保底口粮必须打得过，否则没法开局');
  assert.ok(B.CONFIG.normalMulLoBase < B.CONFIG.normalMulSafeHi, '口粮区间应有效');
  // 精英/BOSS 起步就比主角强，保证存在致命威胁
  assert.ok(B.CONFIG.eliteMulLoBase > 1, '精英必须打不过，否则没有危险');
  assert.ok(B.CONFIG.bossMulBase > 1, 'BOSS 必须打不过，否则没有挑战');
  // 追击怪速度慢于主角：危险但跑得掉
  assert.ok(B.CONFIG.chaserSpeed < B.CONFIG.heroSpeed, '追击怪必须比主角慢');
  // 吞噬比例必须 < 1，否则每层成长 = 1+Σ倍数，战力指数爆炸
  assert.ok(B.CONFIG.absorbRatio > 0 && B.CONFIG.absorbRatio < 1,
    `吞噬比例应在 0~1 之间，实际 ${B.CONFIG.absorbRatio}`);
});

test('首层必须同时存在"打得过"和"打不过"的怪（教学关）', () => {
  // 这是对"开局全都打得过 / 一屋子全是 1"两次反馈的固化：
  // 首层既要有成长空间，也要有必须躲开的威胁，玩家才能学会核心机制
  let sawBoth = 0, sawOnlySafe = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const specs = B.floorSpec(1, mulberry32(seed));
    const powers = specs.map(s => B.monsterPower(s.mult, B.CONFIG.startPower));
    const safe = powers.filter(p => p <= B.CONFIG.startPower).length;
    const risky = powers.filter(p => p > B.CONFIG.startPower).length;
    assert.ok(safe >= B.CONFIG.monsterMinBeat,
      `首层种子 ${seed} 可打的怪太少：${safe}（保底 ${B.CONFIG.monsterMinBeat}）`);
    if (risky > 0) sawBoth++; else sawOnlySafe++;
  }
  // 10 个种子里至少 6 个出现威胁：保证教学意义，又允许偶尔一帆风顺
  assert.ok(sawBoth >= 6, `首层太容易了，10 个种子里只有 ${sawBoth} 个出现打不过的怪`);
});
