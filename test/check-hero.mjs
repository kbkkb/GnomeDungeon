/**
 * check-hero.mjs —— 专门验证"主角真的被画出来了"
 * 冒烟测试通过只能证明 canvas 非空；主角如果因为无敌闪烁/层级关系被画没了我得知道。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT = join(HERE, 'hero-check.png');
const PROJECT = join(HERE, '..');
const URL = 'file:///' + PROJECT.replace(/\\/g, '/').replace(/^\//, '') + '/index.html';

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
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state, null, { timeout: 10000 });
  await page.click('#btn-start');
  await page.waitForTimeout(1200);   // 第 1 层无脑等待，不做任何操作，确保不在无敌闪烁期

  const probe = await page.evaluate(() => {
    const g = window.__game, s = g.state;
    const c = document.getElementById('arena');
    const ctx = c.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 复现 renderer 的坐标变换，把地牢坐标换成 canvas 像素坐标
    const rect = c.getBoundingClientRect();
    const scale = Math.min(rect.width / 880, rect.height / 620) * dpr;
    const ox = (c.width - 880 * scale) / 2;
    const oy = (c.height - 620 * scale) / 2;
    const hx = Math.round(ox + s.hero.x * scale);
    const hy = Math.round(oy + s.hero.y * scale);

    // 在主角所在位置取一小块像素，统计颜色
    const size = Math.max(4, Math.round(10 * scale));
    const x0 = Math.max(0, hx - size), y0 = Math.max(0, hy - size);
    const d = ctx.getImageData(x0, y0, size * 2, size * 2).data;
    let blueish = 0, total = 0;
    for (let i = 0; i < d.length; i += 4) {
      total++;
      // 主角盔甲是蓝灰色 #8fa7c8 ~ #5b6f8c：B 明显大于 R
      if (d[i + 2] > d[i] + 18 && d[i + 2] > 70) blueish++;
    }
    return {
      heroX: Math.round(s.hero.x), heroY: Math.round(s.hero.y),
      canvasPx: [hx, hy],
      blueRatio: blueish / total,
      invuln: s.time < s.hero.invulnUntil,
      phase: s.phase
    };
  });

  console.log('主角地牢坐标:', probe.heroX, probe.heroY);
  console.log('无敌闪烁中:', probe.invuln, '| 相位:', probe.phase);
  console.log('主角位置蓝灰色像素占比:', (probe.blueRatio * 100).toFixed(1) + '%');
  console.log(probe.blueRatio > 0.08
    ? '✔ 主角被正常绘制（盔甲颜色可在其位置采样到）'
    : '✖ 主角位置采样不到盔甲颜色，可能没画出来');

  await page.screenshot({ path: SHOT });
  console.log('📸 截图: ' + SHOT);
} finally {
  await browser.close();
}
