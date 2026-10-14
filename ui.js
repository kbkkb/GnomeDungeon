/**
 * ui.js —— DOM/HUD/输入/广告模拟 交互层
 *
 * 职责：把引擎事件翻译成玩家能感受到的东西（飘字、音效、日志、弹窗），
 * 并把玩家操作翻译成引擎调用。所有游戏规则都在 engine.js，这里不写规则。
 */
(function (root) {
  'use strict';

  var B = root.Balance;

  var LOG_LIMIT = 7;

  function boot() {
    var canvas = document.getElementById('arena');
    var renderer = root.Renderer.create(canvas);
    var game = root.Engine.createGame({ onEvent: onEvent });

    function $(id) { return document.getElementById(id); }
    var el = {
      power: $('hud-power'), boost: $('hud-boost'),
      floor: $('hud-floor'), remain: $('hud-remain'),
      kills: $('hud-kills'), best: $('hud-best'),
      banner: $('banner'), log: $('log'), propList: $('prop-list'),
      equipIcon: $('equip-icon'), equipName: $('equip-name'), equipBonus: $('equip-bonus'),
      btnSound: $('btn-sound'), btnAuto: $('btn-auto'),
      screenTitle: $('screen-title'), titleBest: $('title-best'), btnStart: $('btn-start'),
      screenDead: $('screen-dead'), deadStats: $('dead-stats'), deadReason: $('dead-reason'),
      btnRevive: $('btn-revive'), btnRestart: $('btn-restart'),
      screenAd: $('screen-ad'), adTitle: $('ad-title'), adClose: $('ad-close'),
      adProgress: $('ad-progress'), adCountText: $('ad-count-text'),
      btnDrawEquip: $('btn-draw-equip'), btnAdAuto: $('btn-ad-auto'),
      screenPay: $('screen-pay'), btnPayConfirm: $('btn-pay-confirm'), btnPayCancel: $('btn-pay-cancel'),
      btnFirstCharge: $('btn-first-charge')
    };

    /* ================= 音效（WebAudio 现场合成，不依赖音频文件） ================= */
    var soundOn = root.localStorage.getItem('dk_sound') !== '0';
    var actx = null;

    function tone(freq, dur, type, vol, delay) {
      if (!soundOn) return;
      try {
        if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume();
        var t0 = actx.currentTime + (delay || 0);
        var osc = actx.createOscillator();
        var gain = actx.createGain();
        osc.type = type || 'square';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(vol || 0.1, t0);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain).connect(actx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      } catch (e) { /* 音频不可用就静默降级 */ }
    }

    var sfx = {
      kill: function () { tone(520, 0.07, 'square', 0.10); tone(760, 0.09, 'square', 0.09, 0.05); },
      boss: function () { tone(300, 0.12, 'sawtooth', 0.12); tone(600, 0.2, 'square', 0.1, 0.1); },
      equip: function () { tone(660, 0.08, 'triangle', 0.13); tone(990, 0.13, 'triangle', 0.11, 0.07); },
      prop: function () { tone(440, 0.1, 'sine', 0.14); },
      trap: function () { tone(170, 0.28, 'sawtooth', 0.14); },
      floor: function () { tone(392, 0.1, 'sine', 0.12); tone(587, 0.17, 'sine', 0.1, 0.11); },
      dead: function () { tone(220, 0.32, 'sawtooth', 0.16); tone(110, 0.5, 'sawtooth', 0.14, 0.18); },
      warn: function () { tone(300, 0.07, 'square', 0.07); },
      ad: function () { tone(880, 0.09, 'sine', 0.12); tone(1170, 0.12, 'sine', 0.1, 0.08); }
    };

    /* ================= 存档 ================= */
    var best = parseInt(root.localStorage.getItem('dk_best') || '1', 10) || 1;

    /* ================= 小工具 ================= */
    var bannerTimer = null;
    function banner(text, kind) {
      el.banner.textContent = text;
      el.banner.className = 'banner' + (kind ? ' ' + kind : '');
      el.banner.hidden = false;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(function () { el.banner.hidden = true; }, 1700);
    }

    function log(text, cls) {
      var li = document.createElement('li');
      if (cls) li.className = cls;
      li.textContent = text;
      el.log.appendChild(li);
      while (el.log.children.length > LOG_LIMIT) el.log.removeChild(el.log.firstChild);
    }

    /* ================= 道具图鉴（从 balance 的 PROPS 生成，不手写两份） ================= */
    B.PROPS.forEach(function (p) {
      var li = document.createElement('li');
      var icon = document.createElement('span');
      icon.className = 'pi';
      icon.textContent = p.icon;
      var name = document.createElement('b');
      name.textContent = p.name;
      var desc = document.createElement('span');
      desc.className = 'pd';
      desc.textContent = p.desc;
      li.appendChild(icon); li.appendChild(name); li.appendChild(desc);
      el.propList.appendChild(li);
    });

    /* ================= 引擎事件 → 表现层 ================= */
    function onEvent(e) {
      switch (e.type) {
        case 'kill':
          renderer.floater(
            e.x, e.y - 26,
            '+' + B.formatPower(e.gain),
            e.kind === 'boss' ? '#ff9d5c' : '#7fe08a',
            e.kind === 'boss' ? 32 : 22
          );
          renderer.burst(e.x, e.y, e.kind === 'boss' ? '#b06ce0' : '#c05a4a',
            e.kind === 'boss' ? 28 : 12, e.kind === 'boss' ? 230 : 140);
          if (e.kind === 'boss') {
            sfx.boss();
            renderer.addShake(0.4);
            banner('BOSS 已吞噬！', 'boss');
            log('击杀 BOSS，吞噬 ' + B.formatPower(e.gain) + ' 战力', 'legend');
          } else {
            sfx.kill();
          }
          break;

        case 'equip':
          renderer.floater(e.x, e.y - 32, '+' + B.formatPower(e.bonus) + ' 战力', e.color || '#ffcf5c', 24);
          renderer.burst(e.x, e.y, e.color || '#ffcf5c', 16, 160);
          el.equipIcon.textContent = '⚔';
          el.equipName.textContent = e.name;
          el.equipName.style.color = e.color || '';
          el.equipBonus.textContent = '战力 +' + B.formatPower(e.bonus);
          sfx.equip();
          log('获得【' + e.name + '】战力 +' + B.formatPower(e.bonus), 'gold');
          break;

        case 'prop':
          renderer.floater(e.x, e.y - 32, e.icon + ' ' + e.name, '#9fe8ff', 22);
          renderer.burst(e.x, e.y, '#9fe8ff', 16, 180);
          sfx.prop();
          if (e.kind === 'bomb' && e.killed) {
            renderer.addShake(0.5);
            log('💥 炸弹消灭 ' + e.killed + ' 只怪', 'epic');
          } else {
            log('拾取道具 ' + e.icon + ' ' + e.name, 'good');
          }
          break;

        case 'trap':
          renderer.floater(e.x, e.y - 20, '-' + Math.round(B.CONFIG.trapPowerLoss * 100) + '%', '#ff6b5e', 26);
          renderer.addShake(0.4);
          sfx.trap();
          log('⚠ 踩到陷坑，战力 -25%（剩 ' + B.formatPower(e.power) + '）', 'bad');
          break;

        case 'floor':
          banner(e.boss ? '第 ' + e.floor + ' 层 · BOSS' : '第 ' + e.floor + ' 层', e.boss ? 'boss' : '');
          log(e.boss ? '进入第 ' + e.floor + ' 层，BOSS 战！' : '进入第 ' + e.floor + ' 层', e.boss ? 'epic' : '');
          sfx.floor();
          break;

        case 'dead':
          showDead(e);
          sfx.dead();
          break;

        case 'revive':
          log('看广告复活：无敌 4 秒 + 战力×2', 'good');
          break;

        case 'firstcharge':
          banner('首充成功！战力 ×3', 'boss');
          log('👑 首充成功：战力 ×3，永久自动战斗', 'legend');
          break;
      }
    }

    /* ================= HUD ================= */
    function refreshHUD() {
      var s = game.state;
      if (!s) return;
      var power = game.heroPower();

      el.power.textContent = B.formatPower(power);
      el.boost.hidden = !(s.time < s.hero.boostUntil);
      el.floor.textContent = '第 ' + s.floor + ' 层';

      var killable = 0;
      for (var i = 0; i < s.monsters.length; i++) if (s.monsters[i].power <= power) killable++;
      el.remain.textContent = s.monsters.length
        ? '剩余 ' + s.monsters.length + ' 只（可杀 ' + killable + '）'
        : '本层已清空';
      el.remain.classList.toggle('danger', s.monsters.length > 0 && killable === 0);

      el.kills.textContent = s.kills;
      el.best.textContent = '最高 ' + best + ' 层';

      var autoOn = game.hasAuto();
      el.btnAuto.textContent = autoOn ? '🤖 自动: 开' : '🤖 自动: 关';
      el.btnAuto.classList.toggle('on', autoOn);
    }

    /* ================= 输入 ================= */
    var keys = { up: false, down: false, left: false, right: false };

    function applyKeys() {
      var dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      var dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
      game.setDirection(dx, dy);
    }

    var KEYMAP = {
      w: 'up', a: 'left', s: 'down', d: 'right',
      arrowup: 'up', arrowleft: 'left', arrowdown: 'down', arrowright: 'right'
    };

    function canPlay() {
      return el.screenTitle.hidden && !paused && game.state && game.state.phase === 'playing';
    }

    canvas.addEventListener('pointerdown', function (ev) {
      if (!canPlay()) return;
      var w = renderer.toWorld(ev.clientX, ev.clientY);
      // 点到的第一件事：如果点在了打不过的怪身上，先给个警告（但仍然允许过去）
      var s = game.state;
      var power = game.heroPower();
      for (var i = 0; i < s.monsters.length; i++) {
        var m = s.monsters[i];
        if (Math.hypot(m.x - w.x, m.y - w.y) <= m.r + 12 && m.power > power) {
          renderer.floater(m.x, m.y - m.r - 30, '打不过！', '#ff6b5e', 22);
          sfx.warn();
          break;
        }
      }
      game.setMoveTarget(w.x, w.y);
    });

    root.addEventListener('keydown', function (ev) {
      var k = ev.key.toLowerCase();
      if (KEYMAP[k]) {
        keys[KEYMAP[k]] = true;
        applyKeys();
        ev.preventDefault();
      }
    });

    root.addEventListener('keyup', function (ev) {
      var k = ev.key.toLowerCase();
      if (KEYMAP[k]) {
        keys[KEYMAP[k]] = false;
        applyKeys();
        ev.preventDefault();
      }
    });

    // 失焦时清空按键，避免"松手后还在一直走"
    root.addEventListener('blur', function () {
      keys.up = keys.down = keys.left = keys.right = false;
      applyKeys();
    });

    /* ================= 假广告模拟 ================= */
    var paused = false;      // 广告播放期间暂停游戏（和真实插屏广告一致）
    var adTimer = null;
    var adLeft = 0;

    function playAd(title, onReward) {
      paused = true;
      var total = B.CONFIG.adSeconds;
      adLeft = total;
      el.screenAd.hidden = false;
      el.adTitle.textContent = title;
      el.adClose.textContent = '✕';
      // 注意：不要用 disabled —— disabled 的按钮连程序化 click 都不触发，
      // "提前关闭就嘲讽一句"的设计需要按钮始终可点，只在 handler 里判断倒计时
      el.adClose.disabled = false;
      el.adClose.classList.add('locked');
      el.adClose.classList.remove('shake');
      el.adProgress.style.width = '100%';
      el.adCountText.innerHTML = '奖励 <b>' + Math.ceil(adLeft) + '</b> 秒后发放';

      clearInterval(adTimer);
      adTimer = setInterval(function () {
        adLeft -= 0.1;
        if (adLeft <= 0.001) {
          clearInterval(adTimer);
          adTimer = null;
          el.adProgress.style.width = '0%';
          el.adCountText.innerHTML = '✅ <b>奖励已发放</b>';
          el.adClose.classList.remove('locked');
          el.adClose.textContent = '✕ 关闭';
          sfx.ad();
          onReward();
          setTimeout(closeAd, 900);
        } else {
          el.adProgress.style.width = (adLeft / total * 100) + '%';
          el.adCountText.innerHTML = '奖励 <b>' + Math.ceil(adLeft) + '</b> 秒后发放';
        }
      }, 100);
    }

    function closeAd() {
      if (adTimer) { clearInterval(adTimer); adTimer = null; }
      el.screenAd.hidden = true;
      paused = false;
    }

    el.adClose.addEventListener('click', function () {
      if (el.adClose.classList.contains('locked')) {
        // 假关闭按钮：广告业最经典的套路，这里用来演示
        el.adClose.classList.remove('shake');
        void el.adClose.offsetWidth;   // 强制重排以重启动画
        el.adClose.classList.add('shake');
        el.adCountText.innerHTML = '😏 还需 <b>' + Math.ceil(adLeft) + '</b> 秒才能关闭';
        sfx.warn();
        return;
      }
      closeAd();
    });

    /* ================= 死亡页 ================= */
    function showDead(e) {
      if (e.floor > best) {
        best = e.floor;
        root.localStorage.setItem('dk_best', String(best));
      }
      el.deadReason.textContent = '击败你的怪物战力 ' + B.formatPower(e.killerPower)
        + '，你当时只有 ' + B.formatPower(e.power) + '。';
      el.deadStats.innerHTML =
        stat('到达层数', '第 ' + e.floor + ' 层') +
        stat('击杀数', String(e.kills)) +
        stat('最终战力', B.formatPower(e.power)) +
        stat('存活时间', e.time + ' 秒');
      el.screenDead.hidden = false;
      refreshHUD();
    }

    function stat(k, v) {
      return '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
    }

    /* ================= 按钮 ================= */
    el.btnStart.addEventListener('click', function () {
      el.screenTitle.hidden = true;
      log('你掉进了地牢第 1 层……', 'gold');
      log('点击地面移动，撞向打得过的怪', '');
    });

    el.btnRestart.addEventListener('click', function () {
      el.screenDead.hidden = true;
      game.restart();
      log('重新开始，回到第 1 层', '');
    });

    el.btnRevive.addEventListener('click', function () {
      el.screenDead.hidden = true;
      playAd('复活奖励', function () {
        game.revive();
      });
    });

    el.btnDrawEquip.addEventListener('click', function () {
      playAd('装备奖励', function () {
        game.drawEquipment();
      });
    });

    el.btnAdAuto.addEventListener('click', function () {
      playAd('自动战斗', function () {
        game.setAuto(60);
        log('🤖 解锁自动战斗 60 秒', 'good');
      });
    });

    el.btnAuto.addEventListener('click', function () {
      if (game.hasAuto()) {
        banner('自动战斗中', '');
        return;
      }
      playAd('自动战斗', function () {
        game.setAuto(60);
        log('🤖 解锁自动战斗 60 秒', 'good');
      });
    });

    el.btnFirstCharge.addEventListener('click', function () {
      paused = true;
      el.screenPay.hidden = false;
    });

    el.btnPayCancel.addEventListener('click', function () {
      el.screenPay.hidden = true;
      paused = false;
    });

    el.btnPayConfirm.addEventListener('click', function () {
      el.screenPay.hidden = true;
      paused = false;
      game.grantFirstCharge();
    });

    el.btnSound.addEventListener('click', function () {
      soundOn = !soundOn;
      root.localStorage.setItem('dk_sound', soundOn ? '1' : '0');
      el.btnSound.textContent = soundOn ? '🔊 音效' : '🔇 静音';
      el.btnSound.classList.toggle('on', soundOn);
      if (soundOn) sfx.prop();
    });

    /* ================= 启动 ================= */
    // 先起一局让地牢画面透出来（第 1 层怪物不会动，标题页期间是安全的）
    game.start();
    // 暴露给控制台/自动化测试调试用（不影响正常玩法）
    root.__game = game;
    el.btnSound.textContent = soundOn ? '🔊 音效' : '🔇 静音';
    el.btnSound.classList.toggle('on', soundOn);
    el.titleBest.textContent = best > 1 ? '历史最高：第 ' + best + ' 层' : '';
    refreshHUD();

    var last = root.performance.now();
    function frame(now) {
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!paused && game.state.phase === 'playing') game.tick(dt);
      renderer.draw(game.state, dt);
      refreshHUD();
      root.requestAnimationFrame(frame);
    }
    root.requestAnimationFrame(frame);
  }

  root.UI = { boot: boot };
})(window);
