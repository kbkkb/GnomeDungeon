/**
 * verify-remote.mjs —— 验证 GitHub Pages 远程地址真的能玩
 *
 * 只验证"启用成功"是不够的：必须实际打开远程 URL，确认
 *   HTML/CSS/JS 全部加载、无 JS 报错、游戏能跑起来、能交互。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));

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
if (!pw) { console.log('⚠ 无 playwright-core，跳过远程验证'); process.exit(0); }
const { chromium } = pw;

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) { console.log('⚠ 无 Chrome，跳过远程验证'); process.exit(0); }

const URL = 'https://kbkkb.github.io/GnomeDungeon/';

const errors = [];
const failed = [];
let passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { console.log(`  ✖ ${name}${extra ? ' → ' + extra : ''}`); failed.push(name); }
}

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-gpu']
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', (r) => {
    // 忽略 favicon 之类的无关失败
    if (!/favicon/i.test(r.url())) errors.push('请求失败: ' + r.url() + ' - ' + (r.failure() || {}).errorText);
  });

  console.log(`\n目标地址: ${URL}\n`);

  /* ---------- 1. 资源全部加载 ---------- */
  console.log('[1] 资源加载');
  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  ok('页面返回 200', resp && resp.status() === 200, `HTTP ${resp ? resp.status() : '无响应'}`);
  ok('标题正确', (await page.title()).includes('诺姆地牢'), await page.title());

  // 逐个确认关键资源真的加载成功（而不是 404）
  const assets = await page.evaluate(() =>
    performance.getEntriesByType('resource')
      .filter(r => /\.(js|css)$/.test(r.name))
      .map(r => ({ name: r.name.split('/').pop(), size: r.transferSize || r.encodedBodySize }))
  );
  console.log('    加载的资源:', assets.map(a => `${a.name}(${a.size}B)`).join(' '));
  const need = ['index.html', 'style.css', 'balance.js', 'engine.js', 'render.js', 'ui.js', 'main.js'];
  const loaded = assets.map(a => a.name);
  for (const f of need) {
    if (f === 'index.html') continue;   // html 不是 resource 条目
    ok(`${f} 已加载`, loaded.includes(f));
  }
  const zeroSize = assets.filter(a => a.size === 0).map(a => a.name);
  ok('没有空文件（0 字节）', zeroSize.length === 0, zeroSize.join(','));

  /* ---------- 2. 游戏跑得起来 ---------- */
  console.log('\n[2] 游戏运行');
  await page.waitForFunction(() => window.__game && window.__game.state, null, { timeout: 15000 });
  ok('游戏实例已创建', true);

  await page.click('#btn-start');
  await page.waitForTimeout(900);
  const state = await page.evaluate(() => {
    const s = window.__game.state;
    return {
      phase: s.phase, floor: s.floor, heroPower: s.hero.power,
      monsters: s.monsters.length, distinct: new Set(s.monsters.map(m => m.power)).size
    };
  });
  ok('进入 playing', state.phase === 'playing');
  ok('已生成怪物', state.monsters > 0, `${state.monsters} 只`);
  ok('首层数值有差异', state.distinct >= 3, `${state.distinct} 种`);

  // canvas 真的画出了东西
  const lit = await page.evaluate(() => {
    const c = document.getElementById('arena');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, t = 0;
    for (let i = 0; i < d.length; i += 4 * 53) { t++; if (d[i] + d[i + 1] + d[i + 2] > 40) n++; }
    return n / t;
  });
  ok('canvas 已渲染', lit > 0.15, `亮点占比 ${(lit * 100).toFixed(1)}%`);

  /* ---------- 3. 交互可用 ---------- */
  console.log('\n[3] 交互');
  const before = await page.evaluate(() => {
    const s = window.__game.state;
    const m = s.monsters[0];
    window.__game.setMoveTarget(m.x, m.y);
    return { x: s.hero.x, y: s.hero.y, tx: m.x, ty: m.y };
  });
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() => ({ x: window.__game.state.hero.x, y: window.__game.state.hero.y }));
  const dB = Math.hypot(before.x - before.tx, before.y - before.ty);
  const dA = Math.hypot(after.x - before.tx, after.y - before.ty);
  ok('点击移动有效', dA < dB, `距离 ${dB.toFixed(0)} → ${dA.toFixed(0)}`);

  /* ---------- 4. 控制台洁净 ---------- */
  console.log('\n[4] 控制台');
  ok('全程无 JS 报错', errors.length === 0, errors.slice(0, 4).join(' | '));

  await page.screenshot({ path: join(HERE, 'remote.png'), fullPage: false });
  console.log('\n  📸 远程截图: ' + join(HERE, 'remote.png'));
} finally {
  await browser.close();
}

console.log(`\n========== 远程验证：${passed} 项通过 ==========`);
if (failed.length) { console.log('失败项: ' + failed.join(', ')); process.exitCode = 1; }
