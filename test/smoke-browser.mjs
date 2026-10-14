/**
 * smoke-browser.mjs —— 真实浏览器端到端验证（驱动系统 Chrome）
 *
 * 单测只能验证引擎逻辑；这个脚本验证"页面真的能跑起来"：
 *   加载无 JS 报错 → 标题页 → 开始游戏 → canvas 真的画出东西 →
 *   移动 → 吞噬增长 → HUD 同步 → 广告倒计时/嘲讽/奖励 → 死亡 → 复活 → 首充
 *
 * 运行： node test/smoke-browser.mjs
 * 依赖：playwright-core（任意目录 npm i playwright-core，设 PW_CORE_PATH 指向其 node_modules）
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT = join(HERE, 'screenshot.png');

/**
 * ESM 的 import 不认 NODE_PATH，所以用 createRequire 按目录解析。
 * 按顺序探测：环境变量 → 临时安装目录 → 项目本地 node_modules。
 * 找不到就跳过（退出码 0），不让可选的浏览器测试挡住整套验证。
 */
function loadPlaywright() {
  const candidates = [
    process.env.PW_CORE_PATH,
    'C:/Users/eskyfun/AppData/Local/Temp/pwsmoke/node_modules',
    join(HERE, '..', 'node_modules')
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'playwright-core'))) {
      const req = createRequire(join(dir, 'playwright-core', 'package.json'));
      return req('playwright-core');
    }
  }
  return null;
}

const pw = loadPlaywright();
if (!pw) {
  console.log('⚠ 未找到 playwright-core，跳过浏览器冒烟测试');
  console.log('  安装：任意目录 npm i playwright-core，设 PW_CORE_PATH=<该目录>/node_modules');
  process.exit(0);
}
const { chromium } = pw;

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 从脚本位置推导项目根目录，别硬编码绝对路径（否则一搬地方就指向错误的文件）
const PROJECT = join(HERE, '..');
const URL = 'file:///' + PROJECT.replace(/\\/g, '/').replace(/^\//, '') + '/index.html';
if (!existsSync(CHROME)) {
  console.log('⚠ 未找到系统 Chrome，跳过浏览器冒烟测试');
  process.exit(0);
}

const errors = [];
let passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { console.log(`  ✖ ${name}${extra ? ' → ' + extra : ''}`); process.exitCode = 1; }
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,860']
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  /* ---------- [1] 加载 ---------- */
  console.log('\n[1] 页面加载');
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state, null, { timeout: 10000 });

  const globals = await page.evaluate(() => ({
    Balance: typeof window.Balance,
    Engine: typeof window.Engine,
    Renderer: typeof window.Renderer,
    UI: typeof window.UI,
    game: typeof window.__game,
    props: window.Balance ? window.Balance.PROPS.length : 0
  }));
  ok('五个模块全部加载', globals.Balance === 'object' && globals.Engine === 'object'
    && globals.Renderer === 'object' && globals.UI === 'object');
  ok('游戏实例已创建', globals.game === 'object');
  ok('道具图鉴数据就绪', globals.props === 5, `PROPS=${globals.props}`);
  ok('标题页显示中', await page.isVisible('#screen-title'));

  /* ---------- [2] Canvas 真的画出了东西 ---------- */
  console.log('\n[2] Canvas 渲染');
  const canvas = await page.evaluate(() => {
    const c = document.getElementById('arena');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0, total = 0;
    for (let i = 0; i < d.length; i += 4 * 53) {
      total++;
      if (d[i] + d[i + 1] + d[i + 2] > 40) lit++;
    }
    return { w: c.width, h: c.height, litRatio: lit / total };
  });
  ok('canvas 有实际尺寸', canvas.w > 100 && canvas.h > 100, `${canvas.w}x${canvas.h}`);
  ok('canvas 真的画出了地牢（非纯黑）', canvas.litRatio > 0.15, `亮点占比 ${(canvas.litRatio * 100).toFixed(1)}%`);

  /* ---------- [3] 开始游戏 + 移动 ---------- */
  console.log('\n[3] 开始游戏 & 移动');
  await page.click('#btn-start');
  await page.waitForTimeout(300);
  ok('标题页已隐藏', !(await page.isVisible('#screen-title')));
  ok('游戏进入 playing', await page.evaluate(() => window.__game.state.phase === 'playing'));

  const clickRes = await page.evaluate(() => {
    const g = window.__game, s = g.state, m = s.monsters[0];
    g.setMoveTarget(m.x, m.y);
    return { heroX: s.hero.x, heroY: s.hero.y, targetX: m.x, targetY: m.y };
  });
  await page.waitForTimeout(2500);
  const moved = await page.evaluate(() => {
    const s = window.__game.state;
    return { x: s.hero.x, y: s.hero.y, kills: s.kills, power: s.hero.power };
  });
  const dB = Math.hypot(clickRes.heroX - clickRes.targetX, clickRes.heroY - clickRes.targetY);
  const dA = Math.hypot(moved.x - clickRes.targetX, moved.y - clickRes.targetY);
  ok('主角朝目标移动了', dA < dB, `距离 ${dB.toFixed(0)} → ${dA.toFixed(0)}`);

  /* ---------- [4] 吞噬机制 ---------- */
  // 移动已经在上面验证过；这里直接把主角放到怪物身边，专注验证"秒杀并吞噬"
  console.log('\n[4] 吞噬机制');
  const grow = await page.evaluate(() => {
    const g = window.__game, s = g.state;
    g.grantPower(5000);
    const before = s.hero.power;
    const m = s.monsters[0];
    s.hero.x = m.x + 34; s.hero.y = m.y;      // 放到接触距离内
    s.hero.tx = null; s.hero.ty = null;
    return { before, monsterPower: m.power };
  });
  await page.waitForFunction(
    (k0) => window.__game.state.kills > k0,
    moved.kills,
    { timeout: 5000 }
  ).catch(() => {});
  const ate = await page.evaluate(() => ({
    power: window.__game.state.hero.power,
    kills: window.__game.state.kills
  }));
  ok('击杀数增加', ate.kills > moved.kills, `${moved.kills} → ${ate.kills}`);
  ok('战力通过吞噬增长', ate.power >= grow.before + grow.monsterPower,
    `${grow.before} → ${ate.power}（吞了 ${grow.monsterPower}）`);

  /* ---------- [5] HUD 同步 ---------- */
  console.log('\n[5] HUD 同步');
  const hudPower = await page.textContent('#hud-power');
  const hudKills = await page.textContent('#hud-kills');
  ok('战力 HUD 已更新', hudPower !== '1' && hudPower.length > 0, `显示 ${hudPower}`);
  ok('击杀 HUD 与引擎一致', Number(hudKills) === ate.kills, `显示 ${hudKills}`);

  /* ---------- [6] 假广告 ---------- */
  console.log('\n[6] 假广告流程');
  const beforeAd = await page.evaluate(() => window.__game.state.hero.power);
  await page.click('#btn-draw-equip');
  await page.waitForSelector('#screen-ad:not([hidden])', { timeout: 5000 });
  ok('广告弹窗出现', true);

  // 倒计时中点关闭 → 应该被拦住并嘲讽（按钮不能用 disabled，否则点不动）
  const blocked = await page.evaluate(() => {
    const btn = document.getElementById('ad-close');
    const txt = document.getElementById('ad-count-text');
    const before = txt.textContent;
    btn.click();
    return {
      locked: btn.classList.contains('locked'),
      before,
      after: txt.textContent
    };
  });
  ok('倒计时内关闭被拦截', blocked.locked === true);
  ok('提前关闭会被嘲讽一句', blocked.after !== blocked.before, blocked.after);

  // 等倒计时自然结束
  await page.waitForFunction(
    () => !document.getElementById('ad-close').classList.contains('locked'),
    null, { timeout: 15000 }
  );
  const afterAd = await page.evaluate(() => ({
    power: window.__game.state.hero.power,
    text: document.getElementById('ad-count-text').textContent
  }));
  ok('广告放完发放了奖励（战力提升）', afterAd.power > beforeAd, `${beforeAd} → ${afterAd.power}`);
  ok('奖励提示已出现', afterAd.text.includes('奖励已发放'), afterAd.text);

  // 奖励发放后会自动关闭，等它自己消失
  await page.waitForSelector('#screen-ad', { state: 'hidden', timeout: 5000 });
  ok('广告倒计时结束自动关闭', true);

  /* ---------- [7] 死亡与复活 ---------- */
  console.log('\n[7] 死亡与复活');
  await page.evaluate(() => {
    const g = window.__game, s = g.state;
    s.hero.power = 1;
    const m = s.monsters.find((x) => x.power > 1) || s.monsters[0];
    if (m) { m.power = 999999; s.hero.x = m.x; s.hero.y = m.y; s.hero.tx = null; s.hero.ty = null; }
  });
  await page.waitForSelector('#screen-dead:not([hidden])', { timeout: 5000 });
  ok('撞上打不过的怪会死', true);
  ok('死亡统计有内容', (await page.textContent('#dead-stats')).includes('到达层数'));

  const powerBeforeRevive = await page.evaluate(() => window.__game.state.hero.power);
  await page.click('#btn-revive');
  await page.waitForSelector('#screen-ad:not([hidden])', { timeout: 5000 });
  await page.waitForFunction(
    () => !document.getElementById('ad-close').classList.contains('locked'),
    null, { timeout: 15000 }
  );
  await page.waitForSelector('#screen-ad', { state: 'hidden', timeout: 5000 });
  const revived = await page.evaluate(() => ({
    phase: window.__game.state.phase,
    power: window.__game.state.hero.power,
    boost: window.__game.heroPower() > window.__game.state.hero.power
  }));
  ok('复活后回到游戏', revived.phase === 'playing');
  ok('复活保留原战力', revived.power === powerBeforeRevive, `战力 ${revived.power}`);
  ok('复活带战力×2 加成', revived.boost === true);

  /* ---------- [8] 首充演示 ---------- */
  console.log('\n[8] 首充演示');
  await page.click('#btn-first-charge');
  await page.waitForSelector('#screen-pay:not([hidden])', { timeout: 5000 });
  ok('首充弹窗出现', true);

  // 注意：复活奖励带来的自动战斗此时仍在跑，会持续吞噬怪物改变战力。
  // 所以必须在同一帧内读取 before/after，中间不能留时间窗。
  const charge = await page.evaluate(() => {
    const g = window.__game;
    const before = g.state.hero.power;
    g.grantFirstCharge();                 // 同步调用，杜绝时间窗
    return { before, after: g.state.hero.power };
  });
  await page.waitForTimeout(300);
  const charged = await page.evaluate(() => ({
    first: window.__game.state.hero.firstCharge,
    auto: window.__game.hasAuto(),
    power: window.__game.state.hero.power
  }));
  ok('首充生效（战力×3）', charge.after === charge.before * 3,
    `${charge.before} → ${charge.after}`);
  ok('首充状态已记录', charged.first === true);
  ok('首充解锁永久自动战斗', charged.auto === true);
  ok('自动战斗 HUD 显示开启', (await page.textContent('#btn-auto')).includes('开'));

  /* ---------- [9] 控制台洁净度 ---------- */
  console.log('\n[9] 控制台洁净度');
  ok('全程无 JS 报错', errors.length === 0, errors.slice(0, 5).join(' | '));

  await page.screenshot({ path: SHOT });
  console.log('\n  📸 截图已保存: ' + SHOT);
} finally {
  await browser.close();
}

console.log(`\n========== 浏览器冒烟测试：${passed} 项通过 ==========`);
if (process.exitCode) console.log('存在失败项，请检查上方 ✖');
