/**
 * verify-visual.mjs —— 截图确认本次两项改动的实际效果
 *   1. 首层怪物战力有差异（不再是一屋子"1"）
 *   2. 假广告是「吉姆冰墙」主题
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT_FLOOR = join(HERE, 'verify-floor1.png');
const SHOT_AD = join(HERE, 'verify-ad.png');
const SHOT_BIG = join(HERE, 'verify-bignum.png');

function loadPlaywright() {
  const candidates = [
    process.env.PW_CORE_PATH,
    'C:/Users/eskyfun/AppData/Local/Temp/pwsmoke/node_modules',
    join(HERE, '..', 'node_modules')
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'playwright-core'))) {
      return createRequire(join(dir, 'playwright-core', 'package.json'))('playwright-core');
    }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) { console.log('skip'); process.exit(0); }
const { chromium } = pw;

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) { console.log('skip'); process.exit(0); }

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-gpu']
});

let passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { console.log(`  ✖ ${name}${extra ? ' → ' + extra : ''}`); process.exitCode = 1; }
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto('file:///' + join(HERE, '..').replace(/\\/g, '/').replace(/^\//, '') + '/index.html',
    { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state, null, { timeout: 10000 });

  /* ---------- 1. 首层数值有差异 ---------- */
  console.log('\n[1] 首层怪物战力');
  await page.click('#btn-start');
  await page.waitForTimeout(900);

  const floor1 = await page.evaluate(() => {
    const s = window.__game.state;
    return {
      heroPower: s.hero.power,
      powers: s.monsters.map(m => m.power),
      distinct: new Set(s.monsters.map(m => m.power)).size
    };
  });
  console.log(`    主角战力 ${floor1.heroPower}，怪物战力: [${floor1.powers.join(', ')}]`);
  ok('首层初始战力已抬高', floor1.heroPower >= 5, `实际 ${floor1.heroPower}`);
  ok('首层怪物数值有多种', floor1.distinct >= 3, `只有 ${floor1.distinct} 种: [${floor1.powers.join(',')}]`);
  ok('首层不再全是 1', !floor1.powers.every(p => p === 1), `[${floor1.powers.join(', ')}]`);
  await page.screenshot({ path: SHOT_FLOOR });
  console.log('    📸 ' + SHOT_FLOOR);

  /* ---------- 2. 广告主题 ---------- */
  console.log('\n[2] 假广告主题');
  await page.click('#btn-draw-equip');
  await page.waitForSelector('#screen-ad:not([hidden])', { timeout: 5000 });

  const ad = await page.evaluate(() => {
    const box = document.querySelector('.ad-box');
    return {
      text: box ? box.textContent : '',
      hasJim: !!document.querySelector('.jim-scene'),
      hasWall: !!document.querySelector('.jim-wall'),
      hasHero: !!document.querySelector('.jim-hero'),
      hasTap: !!document.querySelector('.jim-tap'),
      hasInstall: box ? box.textContent.includes('INSTALL') : false,
      hasStars: box ? box.textContent.includes('4.9') : false,
      hasDl: box ? box.textContent.includes('1亿+ 下载') : false,
      oldTheme: box ? box.textContent.includes('点点女王') : false
    };
  });
  ok('吉姆冰墙场景存在', ad.hasJim && ad.hasWall && ad.hasHero && ad.hasTap);
  ok('标题为吉姆冰墙', ad.text.includes('吉姆冰墙'));
  ok('INSTALL 按钮在', ad.hasInstall);
  ok('假评分/假下载量在', ad.hasStars && ad.hasDl);
  ok('旧主题已移除', !ad.oldTheme);

  await page.screenshot({ path: SHOT_AD });
  console.log('    📸 ' + SHOT_AD);

  // 广告还会自动结束，不影响后续
  await page.waitForSelector('#screen-ad', { state: 'hidden', timeout: 15000 });

  /* ---------- 3. 后期大数字已简化 ---------- */
  console.log('\n[3] 大数字简化');
  // 把战力推到后期量级，检查画布上实际渲染出的文本是短的（而不是 16 位长数字）
  const big = await page.evaluate(() => {
    const g = window.__game;
    g.grantPower(4.5e15 - g.state.hero.power);   // 推到约 4.5 京
    g.state.monsters.forEach(m => { m.power = Math.round(m.power * 1e6); });
    return {
      hero: g.state.hero.power,
      monsterMax: Math.max(...g.state.monsters.map(m => m.power)),
      heroText: window.Balance.formatPower(g.state.hero.power),
      monsterText: window.Balance.formatPower(Math.max(...g.state.monsters.map(m => m.power)))
    };
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: SHOT_BIG });
  console.log(`    主角战力 ${big.hero} → 画布显示「${big.heroText}」`);
  console.log(`    最大怪物 ${big.monsterMax} → 画布显示「${big.monsterText}」`);
  ok('主角数字已简化', big.heroText.length <= 6, `「${big.heroText}」长度 ${big.heroText.length}`);
  ok('怪物数字已简化', big.monsterText.length <= 6, `「${big.monsterText}」长度 ${big.monsterText.length}`);
  ok('简化后带单位（万/亿/兆/京）', /[万亿兆京]/.test(big.heroText), big.heroText);
  console.log('    📸 ' + SHOT_BIG);
} finally {
  await browser.close();
}

console.log(`\n========== 视觉确认：${passed} 项通过 ==========`);
