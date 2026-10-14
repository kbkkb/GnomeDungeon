/** 诊断脚本：跑一个种子，打印每秒的状态，看机器人卡在哪 */
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

const seed = Number(process.argv[2] || 34);
const DT = 1 / 60;
const rand = mulberry32(seed);
const game = Engine.createGame({ rand });
game.start();

let deaths = 0, repathCd = 0, stuckFloor = 1, stuckTime = 0, ads = 0;
const log = [];

for (let t = 0; t < 8 * 60; t += DT) {
  const s = game.state;
  if (s.phase === 'dead') {
    deaths++;
    if (deaths > 3) break;
    game.revive();
    continue;
  }
  if (s.floor === stuckFloor) stuckTime += DT; else { stuckFloor = s.floor; stuckTime = 0; }
  if (stuckTime > 25) { stuckTime = 0; ads++; game.drawEquipment(); }

  repathCd -= DT;
  if (repathCd <= 0) {
    repathCd = 0.15;
    const power = game.heroPower();
    let target = null, best = Infinity;
    for (const m of s.monsters) {
      if (m.power > power) continue;
      const d = Math.hypot(m.x - s.hero.x, m.y - s.hero.y);
      if (d < best) { best = d; target = m; }
    }
    if (target) game.setMoveTarget(target.x, target.y);
    else {
      let pick = null, bp = Infinity;
      for (const o of [...s.items, ...s.props]) {
        const d = Math.hypot(o.x - s.hero.x, o.y - s.hero.y);
        if (d < bp) { bp = d; pick = o; }
      }
      if (pick) game.setMoveTarget(pick.x, pick.y);
      else {
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

  if (Math.abs(t % 10) < DT) {
    const s2 = game.state;
    const killable = s2.monsters.filter(m => m.power <= game.heroPower()).length;
    log.push(`t=${t.toFixed(0).padStart(3)}s 层=${s2.floor} 战力=${B.formatPower(s2.hero.power).padStart(6)} ` +
      `击杀=${String(s2.kills).padStart(3)} 剩余怪=${String(s2.monsters.length).padStart(2)} ` +
      `可杀=${String(killable).padStart(2)} 目标=${s2.hero.tx != null ? '有' : '无'} ` +
      `位置=(${s2.hero.x.toFixed(0)},${s2.hero.y.toFixed(0)}) 广告=${ads} 死亡=${deaths}`);
  }
}

console.log(log.join('\n'));
console.log('\n=== 汇总 ===');
console.log(`种子 ${seed}: 最高层 ${game.state.floor}, 击杀 ${game.state.kills}, 死亡 ${deaths}, 广告 ${ads}, 战力 ${B.formatPower(game.state.hero.power)}`);
const s = game.state;
console.log(`结束时: 剩余怪 ${s.monsters.length} 只`, s.monsters.map(m => `${m.kind}:${m.power}`).join(' '));
console.log(`主角战力 ${s.hero.power}, 能否打其中任何一只: ${s.monsters.some(m => m.power <= s.hero.power)}`);
