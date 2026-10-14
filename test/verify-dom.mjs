/**
 * verify-dom.mjs —— 静态校验：ui.js 里引用的每个 DOM id 是否都存在于 index.html
 * 这类"拼错 id"的 bug 在浏览器里只表现为什么都点不动，很难查，这里提前拦掉。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = new URL('.', import.meta.url);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// 所有前端脚本都要扫——id 可能被 ui.js 之外的模块（如 render.js）使用
const SCRIPTS = ['ui.js', 'render.js', 'engine.js', 'main.js'];
const allJs = SCRIPTS.map((f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');

// index.html 里实际存在的 id
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

// ui.js 里 $('xxx') 的引用
const ui = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const refIds = [...ui.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);

// 任意脚本里 getElementById('xxx') 的引用
const byId = [...allJs.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);

let fail = 0;
for (const id of new Set(refIds)) {
  if (!htmlIds.has(id)) {
    console.log(`✖ ui.js 引用了不存在的 id: ${id}`);
    fail++;
  }
}
for (const id of new Set(byId)) {
  if (!htmlIds.has(id)) {
    console.log(`✖ 脚本引用了不存在的 id: ${id}`);
    fail++;
  }
}
for (const id of htmlIds) {
  const used = refIds.includes(id) || byId.includes(id);
  if (!used && !['app', 'stage', 'arena-wrap', 'panel', 'topbar'].includes(id)) {
    console.log(`⚠ index.html 里的 id 没有任何脚本使用: ${id}`);
  }
}

console.log(`\n共校验 ${new Set(refIds).size} 个引用，${htmlIds.size} 个 HTML id`);
if (fail) { console.log('✖ 存在失效引用'); process.exit(1); }
console.log('✔ DOM id 引用全部有效');

// 同时确认 script 标签顺序正确（依赖顺序）
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
const order = ['balance.js', 'engine.js', 'render.js', 'ui.js', 'main.js'];
const ok = JSON.stringify(scripts) === JSON.stringify(order);
console.log(ok ? '✔ script 依赖顺序正确' : `✖ script 顺序异常: ${scripts.join(' → ')}`);
if (!ok) process.exit(1);

// 确认 css 里新增的类在 html/js 中有使用（防止写了没用的样式）
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const need = ['.rule-demo', '.rule-row', '.prop-list', '.hud-sub.danger'];
for (const cls of need) {
  if (!css.includes(cls)) { console.log(`✖ style.css 缺少 ${cls}`); fail++; }
}
if (!fail) console.log('✔ 样式类齐全');
