/**
 * render.js —— Canvas 2D 俯视地牢渲染层
 *
 * 只负责"画"：不修改游戏状态。所有飘字/粒子由 UI 层在收到引擎事件时调用
 * floater()/burst() 生成，这里只负责推进和绘制。
 *
 * 视觉要点（这类游戏的爽感全靠数字）：
 *   - 打得过的怪：数字白色/绿色，身体颜色正常
 *   - 打不过的怪：数字红色 + 脉冲红圈 + "!"，一眼看出危险
 *   - 主角数字用金色大字，吞噬时数字"跳"一下
 */
(function (root) {
  'use strict';

  var CELL = 40;

  var COLORS = {
    floor: '#1a1410',
    floorAlt: '#1f1813',
    grid: 'rgba(255,255,255,0.025)',
    wall: '#3d3128',
    wallTop: '#544434',
    wallDark: '#241c16',
    hero: '#8fa7c8',
    heroDark: '#5b6f8c',
    normal: '#c05a4a',
    elite: '#a8457a',
    chaser: '#c8813a',
    boss: '#7b4bb5',
    safe: '#7fe08a',
    danger: '#ff6b5e',
    gold: '#ffcf5c'
  };

  function create(canvas) {
    var ctx = canvas.getContext('2d');
    var arena = { w: 880, h: 620 };
    var view = { scale: 1, ox: 0, oy: 0 };
    var floaters = [];
    var particles = [];
    var shake = 0;
    var noise = null;
    var time = 0;

    /* ---------- 尺寸自适应（含高清屏 DPR） ---------- */
    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      var scale = Math.min(rect.width / arena.w, rect.height / arena.h);
      view.scale = scale * dpr;
      view.ox = (canvas.width - arena.w * view.scale) / 2;
      view.oy = (canvas.height - arena.h * view.scale) / 2;
    }

    /** 屏幕坐标 → 地牢坐标 */
    function toWorld(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var x = (clientX - rect.left) * dpr;
      var y = (clientY - rect.top) * dpr;
      return {
        x: (x - view.ox) / view.scale,
        y: (y - view.oy) / view.scale
      };
    }

    /* ---------- 预渲染噪点纹理，避免每帧算随机数 ---------- */
    function buildNoise() {
      var c = document.createElement('canvas');
      c.width = 88; c.height = 62;
      var g = c.getContext('2d');
      for (var y = 0; y < 62; y++) {
        for (var x = 0; x < 88; x++) {
          var v = Math.random();
          g.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.014)' : 'rgba(0,0,0,0.05)';
          g.fillRect(x, y, 1, 1);
        }
      }
      noise = ctx.createPattern(c, 'repeat');
    }

    /* ---------- 特效 ---------- */
    function floater(x, y, text, color, size) {
      floaters.push({
        x: x, y: y, text: text,
        color: color || '#fff',
        size: size || 20,
        life: 1, vy: -46
      });
      if (floaters.length > 40) floaters.shift();
    }

    function burst(x, y, color, count, speed) {
      for (var i = 0; i < (count || 10); i++) {
        var a = Math.random() * Math.PI * 2;
        var s = (speed || 120) * (0.4 + Math.random());
        particles.push({
          x: x, y: y,
          vx: Math.cos(a) * s, vy: Math.sin(a) * s,
          life: 0.5 + Math.random() * 0.4,
          size: 2 + Math.random() * 3,
          color: color || '#ffcf5c'
        });
      }
      if (particles.length > 300) particles.splice(0, particles.length - 300);
    }

    function addShake(mag) { shake = Math.max(shake, mag); }

    /* ---------- 绘制 ---------- */

    function drawFloor(s) {
      ctx.fillStyle = COLORS.floor;
      ctx.fillRect(0, 0, arena.w, arena.h);
      if (noise) {
        ctx.fillStyle = noise;
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.fillRect(0, 0, arena.w, arena.h);
        ctx.restore();
      }
      // 棋盘格微差，让地面不死板
      for (var y = 0; y < s.grid.length; y++) {
        for (var x = 0; x < s.grid[y].length; x++) {
          if (s.grid[y][x]) continue;
          if ((x + y) % 2 === 0) continue;
          ctx.fillStyle = COLORS.floorAlt;
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
      }
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var gx = 0; gx <= arena.w; gx += CELL) { ctx.moveTo(gx, 0); ctx.lineTo(gx, arena.h); }
      for (var gy = 0; gy <= arena.h; gy += CELL) { ctx.moveTo(0, gy); ctx.lineTo(arena.w, gy); }
      ctx.stroke();
    }

    function drawWalls(s) {
      for (var y = 0; y < s.grid.length; y++) {
        for (var x = 0; x < s.grid[y].length; x++) {
          if (!s.grid[y][x]) continue;
          var px = x * CELL, py = y * CELL;
          ctx.fillStyle = COLORS.wall;
          ctx.fillRect(px, py, CELL, CELL);
          ctx.fillStyle = COLORS.wallTop;
          ctx.fillRect(px, py, CELL, 6);
          ctx.fillStyle = COLORS.wallDark;
          ctx.fillRect(px, py + CELL - 5, CELL, 5);
          // 砖缝
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
        }
      }
    }

    function drawTrap(t, heroDist) {
      if (t.spent) {
        // 已触发：留下显形的陷坑
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.arc(t.x, t.y, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,107,94,0.5)';
        ctx.lineWidth = 2;
        ctx.stroke();
        return;
      }
      var near = t.detected;
      ctx.save();
      if (near) {
        // 显形：红色尖刺 + 警示圈
        ctx.strokeStyle = 'rgba(255,107,94,' + (0.35 + 0.25 * Math.sin(time * 6)) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(t.x, t.y, 20, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#8a3a30';
        for (var i = 0; i < 4; i++) {
          var a = (i / 4) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(t.x + Math.cos(a) * 14, t.y + Math.sin(a) * 14);
          ctx.lineTo(t.x + Math.cos(a) * 4, t.y + Math.sin(a) * 4);
          ctx.lineTo(t.x + Math.cos(a + 0.7) * 9, t.y + Math.sin(a + 0.7) * 9);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        // 未显形：几乎看不见，只有极淡的裂纹（靠近才显形是本机制的关键）
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(t.x - 10, t.y - 4); ctx.lineTo(t.x + 2, t.y + 6); ctx.lineTo(t.x + 12, t.y - 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawItem(it) {
      var bob = Math.sin(time * 3 + it.bob) * 3;
      ctx.save();
      ctx.translate(it.x, it.y + bob);
      // 光晕
      var g = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
      g.addColorStop(0, it.tier.color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      // 图标
      ctx.font = '22px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚔', 0, 1);
      ctx.restore();
    }

    function drawProp(p) {
      var bob = Math.sin(time * 3 + p.bob) * 3;
      ctx.save();
      ctx.translate(p.x, p.y + bob);
      var g = ctx.createRadialGradient(0, 0, 2, 0, 0, 24);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill();
      ctx.font = '20px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.icon, 0, 1);
      ctx.restore();
    }

    function drawMonster(m, heroPower, hero) {
      var canKill = heroPower >= m.power;
      var wob = Math.sin(time * 3 + m.wob) * 0.08;
      var r = m.r * (1 + wob);

      // 阴影
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(m.x, m.y + r * 0.75, r * 0.85, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();

      // 打不过的怪：脉冲危险圈
      if (!canKill) {
        var pulse = 0.5 + 0.5 * Math.sin(time * 5 + m.wob);
        ctx.strokeStyle = 'rgba(255,107,94,' + (0.25 + pulse * 0.45) + ')';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(m.x, m.y, r + 8 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 身体
      var base = m.kind === 'boss' ? COLORS.boss : m.kind === 'elite' ? COLORS.elite
        : m.kind === 'chaser' ? COLORS.chaser : COLORS.normal;
      var grad = ctx.createRadialGradient(m.x - r * 0.3, m.y - r * 0.4, r * 0.2, m.x, m.y, r);
      grad.addColorStop(0, m.hitFlash > 0 ? '#ffffff' : lighten(base, 0.25));
      grad.addColorStop(1, m.hitFlash > 0 ? '#ffd9d0' : base);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
      ctx.fill();

      // 追击怪：小腿（表现"它在动"）
      if (m.kind === 'chaser') {
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 3;
        var legPhase = Math.sin(time * 10 + m.wob) * 5;
        ctx.beginPath();
        ctx.moveTo(m.x - 6, m.y + r - 2); ctx.lineTo(m.x - 6 + legPhase, m.y + r + 8);
        ctx.moveTo(m.x + 6, m.y + r - 2); ctx.lineTo(m.x + 6 - legPhase, m.y + r + 8);
        ctx.stroke();
      }

      // BOSS 皇冠
      if (m.kind === 'boss') {
        ctx.font = '26px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('👑', m.x, m.y - r - 16);
      }

      // 眼睛（盯着主角）
      var look = Math.atan2(hero.y - m.y, hero.x - m.x);
      var ex = Math.cos(look) * r * 0.18, ey = Math.sin(look) * r * 0.18;
      var eyeDx = Math.cos(look + Math.PI / 2) * r * 0.36;
      var eyeDy = Math.sin(look + Math.PI / 2) * r * 0.36;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(m.x - eyeDx + ex, m.y - eyeDy + ey, r * 0.2, 0, Math.PI * 2);
      ctx.arc(m.x + eyeDx + ex, m.y + eyeDy + ey, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1210';
      ctx.beginPath();
      ctx.arc(m.x - eyeDx + ex * 1.6, m.y - eyeDy + ey * 1.6, r * 0.1, 0, Math.PI * 2);
      ctx.arc(m.x + eyeDx + ex * 1.6, m.y + eyeDy + ey * 1.6, r * 0.1, 0, Math.PI * 2);
      ctx.fill();

      // 头顶数字：游戏的核心信息
      var numColor = canKill ? COLORS.safe : COLORS.danger;
      drawNumber(m.x, m.y - r - 14, m.power, numColor, m.kind === 'boss' ? 26 : 20);
      if (!canKill) {
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = COLORS.danger;
        ctx.fillText('!', m.x, m.y - r - (m.kind === 'boss' ? 42 : 32));
      }
    }

    function drawHero(h, s) {
      var shielded = s.time < h.shieldUntil;
      var boosted = s.time < h.boostUntil;
      var invuln = s.time < h.invulnUntil;
      var fast = s.time < h.speedUntil;
      var lucky = s.time < h.luckUntil;

      // 无敌闪烁
      if (invuln && Math.floor(s.time * 12) % 2 === 0) return;

      // 加速拖影
      if (fast && h.moving) {
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#9fe8ff';
        for (var i = 1; i <= 3; i++) {
          ctx.beginPath();
          ctx.arc(h.x - Math.cos(h.facing) * i * 9, h.y - Math.sin(h.facing) * i * 9, h.r * (1 - i * 0.18), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // 护盾
      if (shielded) {
        ctx.strokeStyle = 'rgba(110,220,255,' + (0.5 + 0.3 * Math.sin(time * 8)) + ')';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.r + 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(110,220,255,0.12)';
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.r + 12, 0, Math.PI * 2);
        ctx.fill();
      }

      // 广告加成光环
      if (boosted) {
        var g = ctx.createRadialGradient(h.x, h.y, h.r, h.x, h.y, h.r + 26);
        g.addColorStop(0, 'rgba(255,138,61,0.35)');
        g.addColorStop(1, 'rgba(255,138,61,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r + 26, 0, Math.PI * 2); ctx.fill();
      }
      if (lucky) {
        ctx.strokeStyle = 'rgba(95,208,106,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r + 6, 0, Math.PI * 2); ctx.stroke();
      }

      // 阴影
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.ellipse(h.x, h.y + h.r * 0.8, h.r * 0.8, h.r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();

      // 身体
      var bob = h.moving ? Math.sin(h.bob) * 1.5 : 0;
      var hg = ctx.createRadialGradient(h.x - 5, h.y - 6 + bob, 3, h.x, h.y + bob, h.r);
      hg.addColorStop(0, '#c3d4ea');
      hg.addColorStop(1, COLORS.heroDark);
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.arc(h.x, h.y + bob, h.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 头盔 + 面甲
      ctx.fillStyle = '#d8e2f0';
      ctx.beginPath();
      ctx.arc(h.x, h.y - 3 + bob, h.r * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2a3444';
      ctx.fillRect(h.x - h.r * 0.45, h.y - 6 + bob, h.r * 0.9, h.r * 0.3);

      // 朝向小剑
      ctx.save();
      ctx.translate(h.x, h.y + bob);
      ctx.rotate(h.facing);
      ctx.fillStyle = '#e8eef7';
      ctx.fillRect(h.r - 2, -2, 14, 4);
      ctx.fillStyle = '#ffcf5c';
      ctx.fillRect(h.r - 4, -4, 4, 8);
      ctx.restore();

      // 头顶战力（全场最大的数字）
      drawNumber(h.x, h.y - h.r - 16, h.power, COLORS.gold, 30, true);

      // 状态小图标
      var icons = '';
      if (shielded) icons += '🛡';
      if (lucky) icons += '🍀';
      if (fast) icons += '👟';
      if (boosted) icons += '⚡';
      if (icons) {
        ctx.font = '13px serif';
        ctx.textAlign = 'center';
        ctx.fillText(icons, h.x, h.y - h.r - 34);
      }
    }

    /**
     * 头顶数字。后期战力会溢出到万亿级别，必须走 formatPower 简化成
     * "1.2万/3.4亿/5.6兆"，否则画布上是一排十几位长的数字，什么都看不清。
     * （曾经的 bug：HUD 用了 formatPower，画布却用 String()，两边不一致）
     */
    function drawNumber(x, y, value, color, size, big) {
      var fmt = (root.Balance && root.Balance.formatPower) ? root.Balance.formatPower : function (v) { return String(Math.floor(v)); };
      var text = fmt(value);
      ctx.save();
      ctx.font = 'bold ' + size + 'px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.lineWidth = big ? 5 : 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(text, x, y);
      if (big) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
      }
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    function drawFloaters(dt) {
      for (var i = floaters.length - 1; i >= 0; i--) {
        var f = floaters[i];
        f.life -= dt * 1.35;
        f.y += f.vy * dt;
        f.vy *= 0.94;
        if (f.life <= 0) { floaters.splice(i, 1); continue; }
        ctx.save();
        ctx.globalAlpha = Math.min(1, f.life * 1.6);
        ctx.font = 'bold ' + f.size + 'px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeText(f.text, f.x, f.y);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
        ctx.restore();
      }
    }

    function drawParticles(dt) {
      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i];
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.93; p.vy *= 0.93;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        ctx.restore();
      }
    }

    /** 火光氛围：中间亮、四周暗，让地牢有"探索感" */
    function drawLighting(s) {
      var h = s.hero;
      var g = ctx.createRadialGradient(h.x, h.y, 60, h.x, h.y, 460);
      g.addColorStop(0, 'rgba(255,190,120,0.10)');
      g.addColorStop(0.45, 'rgba(255,170,90,0.04)');
      g.addColorStop(1, 'rgba(0,0,0,0.42)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, arena.w, arena.h);

      var v = ctx.createRadialGradient(arena.w / 2, arena.h / 2, arena.h * 0.35, arena.w / 2, arena.h / 2, arena.h * 0.85);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, arena.w, arena.h);

      // 低血量压迫感：红边脉冲
      var danger = s.monsters.some(function (m) { return m.power > h.power && Math.hypot(m.x - h.x, m.y - h.y) < 130; });
      if (danger) {
        var p = 0.5 + 0.5 * Math.sin(time * 6);
        var d = ctx.createRadialGradient(arena.w / 2, arena.h / 2, arena.h * 0.3, arena.w / 2, arena.h / 2, arena.h * 0.8);
        d.addColorStop(0, 'rgba(255,0,0,0)');
        d.addColorStop(1, 'rgba(255,40,40,' + (0.1 + p * 0.12) + ')');
        ctx.fillStyle = d;
        ctx.fillRect(0, 0, arena.w, arena.h);
      }
    }

    /* ---------- 主绘制 ---------- */
    function draw(state, dt) {
      if (!state) return;
      time += dt;
      var h = state.hero;
      var power = h.power * (state.time < h.boostUntil ? 2 : 1);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#0d0a09';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      var sx = 0, sy = 0;
      if (shake > 0) {
        sx = (Math.random() * 2 - 1) * shake * 14;
        sy = (Math.random() * 2 - 1) * shake * 14;
        shake = Math.max(0, shake - dt * 1.8);
      }

      ctx.setTransform(view.scale, 0, 0, view.scale, view.ox + sx * view.scale, view.oy + sy * view.scale);
      ctx.beginPath();
      ctx.rect(0, 0, arena.w, arena.h);
      ctx.clip();

      drawFloor(state);
      drawWalls(state);

      var i;
      for (i = 0; i < state.traps.length; i++) drawTrap(state.traps[i]);
      for (i = 0; i < state.items.length; i++) drawItem(state.items[i]);
      for (i = 0; i < state.props.length; i++) drawProp(state.props[i]);

      // 怪物按"打不过的"后画，保证危险的红圈不被遮挡
      var safe = [], risky = [];
      for (i = 0; i < state.monsters.length; i++) {
        (power >= state.monsters[i].power ? safe : risky).push(state.monsters[i]);
      }
      for (i = 0; i < safe.length; i++) drawMonster(safe[i], power, h);
      for (i = 0; i < risky.length; i++) drawMonster(risky[i], power, h);

      drawHero(h, state);
      drawParticles(dt);
      drawFloaters(dt);
      drawLighting(state);

      // 点击移动的目标点标记
      if (h.tx != null && state.phase === 'playing') {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,207,92,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(h.tx, h.ty, 9 + Math.sin(time * 8) * 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(h.tx - 5, h.ty); ctx.lineTo(h.tx + 5, h.ty);
        ctx.moveTo(h.tx, h.ty - 5); ctx.lineTo(h.tx, h.ty + 5);
        ctx.stroke();
        ctx.restore();
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    resize();
    buildNoise();
    window.addEventListener('resize', resize);

    return {
      draw: draw,
      toWorld: toWorld,
      floater: floater,
      burst: burst,
      addShake: addShake,
      resize: resize,
      arena: arena
    };
  }

  root.Renderer = { create: create, COLORS: COLORS };
})(typeof self !== 'undefined' ? self : this);

/** 颜色提亮工具 */
function lighten(hex, amt) {
  var n = parseInt(hex.slice(1), 16);
  var r = Math.min(255, ((n >> 16) & 255) + Math.round(255 * amt));
  var g = Math.min(255, ((n >> 8) & 255) + Math.round(255 * amt));
  var b = Math.min(255, (n & 255) + Math.round(255 * amt));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
