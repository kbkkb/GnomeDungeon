/**
 * main.js —— 入口
 * 页面加载完成后启动 UI 层。
 */
(function () {
  'use strict';
  function start() {
    if (window.UI && typeof window.UI.boot === 'function') window.UI.boot();
    else console.error('[main] UI 模块未加载，请检查 script 标签顺序');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
