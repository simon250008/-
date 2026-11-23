/* ==========================================================================
   《熄灯了，蚊子出没》游戏逻辑
   原生 ES5/ES6 语法，无框架、无依赖、无外部资源。
   ========================================================================== */
(() => {
  'use strict';

  // ---------- 可调参数 ----------
  const GAME_DURATION = 30;          // 一局时长（秒）
  const MISS_LIMIT = 3;              // 连续拍空几次扣 1 分
  const AFFINITY_MAX = 100;          // 室友好感度上限
  const FACE_HIT_PENALTY = 34;       // 拍到室友脸扣多少好感度（3 次归零）
  const HIT_BASE_SCORE = 10;         // 拍中基础分
  const BEST_KEY = 'dorm-mosquito-best';

  // ---------- DOM 缓存 ----------
  const dom = {
    app: document.getElementById('app'),
    screens: {
      start: document.getElementById('start-screen'),
      game: document.getElementById('game-screen'),
      result: document.getElementById('result-screen')
    },
    startBest: document.getElementById('start-best'),
    startBtn: document.getElementById('start-btn'),
    score: document.getElementById('score-value'),
    time: document.getElementById('time-value'),
    timerFill: document.getElementById('timer-fill'),
    combo: document.getElementById('combo-value'),
    multiplier: document.getElementById('combo-mult'),
    affinityPanel: document.getElementById('affinity-panel'),
    affinityLabel: document.getElementById('affinity-label'),
    affinityFill: document.getElementById('affinity-fill'),
    playfield: document.getElementById('playfield'),
    roommate: document.getElementById('roommate'),
    face: document.querySelector('#roommate .face'),
    mosquito: document.getElementById('mosquito'),
    effects: document.getElementById('effects-layer'),
    comboBanner: document.getElementById('combo-banner'),
    edgeFlash: document.getElementById('edge-flash'),
    resultTitle: document.getElementById('result-title'),
    failReason: document.getElementById('fail-reason'),
    finalScore: document.getElementById('final-score'),
    finalCombo: document.getElementById('final-combo'),
    finalBest: document.getElementById('final-best'),
    newBest: document.getElementById('new-best'),
    verdict: document.getElementById('verdict'),
    restartBtn: document.getElementById('restart-btn'),
    backBtn: document.getElementById('back-btn')
  };

  // ---------- 游戏状态 ----------
  const state = {
    phase: 'start',        // start | playing | result
    score: 0,
    combo: 0,
    maxCombo: 0,
    multiplier: 1,
    misses: 0,
    affinity: AFFINITY_MAX,
    timeLeft: GAME_DURATION,
    elapsed: 0,
    best: loadBest(),
    paused: false,
    lastFrame: 0,
    rafId: 0,
    fieldRect: null,
    mos: {
      x: 0, y: 0,          // 逻辑坐标（相对场地，单位 px）
      renderX: 0, renderY: 0,
      tx: 0, ty: 0,        // 当前飞行目标
      mode: 'flying',      // flying | landing | landed | swatted
      modeTime: 0,
      landingDuration: 0,
      landedDuration: 0,
      landingCooldown: 4,
      landingStart: null,
      landingTarget: null,
      wobbleSeed: Math.random() * Math.PI * 2
    }
  };

  let audioCtx = null;
  let comboTimer = 0;
  let shakeTimer = 0;

  init();

  // ========================================================================
  // 初始化与界面切换
  // ========================================================================
  function init() {
    dom.startBest.textContent = state.best;
    bindEvents();
    measureField();
    showScreen('start');
  }

  function bindEvents() {
    dom.startBtn.addEventListener('click', () => {
      initAudio();
      startGame();
    });

    dom.restartBtn.addEventListener('click', () => {
      initAudio();
      startGame();
    });

    dom.backBtn.addEventListener('click', () => {
      updateStartBest();
      showScreen('start');
    });

    // 鼠标与触屏统一处理；pointer-events 在 CSS 中已确保特效不拦截点击
    dom.playfield.addEventListener('pointerdown', onPlayfieldPointer, { passive: true });

    window.addEventListener('resize', measureField);
    window.addEventListener('orientationchange', () => setTimeout(measureField, 120));

    // 现代浏览器用 ResizeObserver 捕捉场地尺寸变化（如横竖屏切换）
    if ('ResizeObserver' in window) {
      new ResizeObserver(measureField).observe(dom.playfield);
    }

    // 切到后台时暂停计时，回来后重置时间基准，避免一回来就秒结束
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.phase === 'playing') {
        state.paused = true;
      } else if (!document.hidden) {
        state.paused = false;
        state.lastFrame = 0;
      }
    });
  }

  function showScreen(name) {
    Object.keys(dom.screens).forEach((key) => {
      const el = dom.screens[key];
      const active = key === name;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
  }

  function startGame() {
    cancelAnimationFrame(state.rafId);
    clearTimeout(comboTimer);
    clearTimeout(shakeTimer);
    initAudio();

    // 重置本局状态
    state.phase = 'playing';
    state.score = 0;
    state.combo = 0;
    state.maxCombo = 0;
    state.multiplier = 1;
    state.misses = 0;
    state.affinity = AFFINITY_MAX;
    state.timeLeft = GAME_DURATION;
    state.elapsed = 0;
    state.paused = false;
    state.lastFrame = 0;

    // 先切屏再测量，确保拿到游戏界面真实尺寸
    showScreen('game');
    measureField();
    clearEffects();

    dom.mosquito.classList.remove('is-splat', 'is-landed');
    dom.roommate.classList.remove('is-targeted', 'is-angry');
    dom.comboBanner.classList.remove('show');
    dom.edgeFlash.classList.remove('show');
    dom.app.classList.remove('is-shaking');

    resetMosquito();
    updateHud();

    state.rafId = requestAnimationFrame(gameLoop);
  }

  function endGame(reason) {
    if (state.phase !== 'playing') return;

    state.phase = 'result';
    cancelAnimationFrame(state.rafId);

    dom.mosquito.classList.remove('is-landed');
    dom.roommate.classList.remove('is-targeted');
    dom.comboBanner.classList.remove('show');
    dom.edgeFlash.classList.remove('show');
    playEnd();

    const isNewBest = state.score > state.best;
    if (isNewBest) {
      state.best = state.score;
      saveBest(state.best);
    }

    dom.resultTitle.textContent = reason === 'affinity' ? '室友已被你拍醒' : '战斗结束';
    dom.failReason.hidden = reason !== 'affinity';
    if (reason === 'affinity') {
      dom.failReason.textContent = '好感度归零：他抱着枕头去走廊睡了，并给你起了个外号。';
    }

    dom.finalScore.textContent = state.score;
    dom.finalCombo.textContent = state.maxCombo;
    dom.finalBest.textContent = state.best;
    dom.newBest.hidden = !isNewBest;
    dom.verdict.textContent = getVerdict(state.score, reason);

    updateStartBest();
    showScreen('result');
  }

  // ========================================================================
  // 主循环与蚊子行为
  // ========================================================================
  function gameLoop(now) {
    if (state.phase !== 'playing') return;

    if (!state.lastFrame) state.lastFrame = now;
    // 限制单帧步长，避免切后台回来后蚊子瞬移
    const dt = Math.min((now - state.lastFrame) / 1000, 0.05);
    state.lastFrame = now;

    if (!state.paused) {
      state.elapsed += dt;
      state.timeLeft = Math.max(0, GAME_DURATION - state.elapsed);

      updateMosquito(dt);
      updateHud();

      if (state.timeLeft <= 0) {
        endGame('time');
        return;
      }
    }

    renderMosquito();
    state.rafId = requestAnimationFrame(gameLoop);
  }

  function updateMosquito(dt) {
    const m = state.mos;
    m.modeTime += dt;

    switch (m.mode) {
      case 'flying':
        updateFlying(dt);
        break;
      case 'landing':
        updateLanding();
        break;
      case 'landed':
        updateLanded();
        break;
      case 'swatted':
        m.renderX = m.x;
        m.renderY = m.y;
        if (m.modeTime > 0.28) respawnMosquito();
        break;
      default:
        break;
    }
  }

  function updateFlying(dt) {
    const m = state.mos;
    const rect = state.fieldRect;

    // 冷却结束后随机落到室友脸上
    m.landingCooldown -= dt;
    if (m.landingCooldown <= 0) {
      startLanding();
      return;
    }

    const dx = m.tx - m.x;
    const dy = m.ty - m.y;
    const dist = Math.hypot(dx, dy) || 1;
    const step = Math.min(dist, getSpeed() * dt);

    m.x += (dx / dist) * step;
    m.y += (dy / dist) * step;

    if (dist < 14 || m.modeTime > 2.4) pickTarget();

    // 垂直于飞行方向的轻微摆动，让轨迹更像蚊子
    const wobble = Math.sin(state.elapsed * 11 + m.wobbleSeed) * 5;
    m.renderX = clamp(m.x + (-dy / dist) * wobble, 14, rect.width - 14);
    m.renderY = clamp(m.y + (dx / dist) * wobble, 14, rect.height - 14);
  }

  function updateLanding() {
    const m = state.mos;
    const t = clamp(m.modeTime / m.landingDuration, 0, 1);
    const ease = t * t * (3 - 2 * t); // smoothstep

    m.x = lerp(m.landingStart.x, m.landingTarget.x, ease);
    m.y = lerp(m.landingStart.y, m.landingTarget.y, ease) - Math.sin(t * Math.PI) * 28;
    m.renderX = m.x;
    m.renderY = m.y;

    if (t >= 1) {
      m.mode = 'landed';
      m.modeTime = 0;
      m.landedDuration = 1.6 + Math.random() * 1.1;
      dom.roommate.classList.remove('is-targeted');
      dom.mosquito.classList.add('is-landed');
    }
  }

  function updateLanded() {
    const m = state.mos;
    const target = m.landingTarget;

    m.x = target.x + Math.sin(state.elapsed * 8) * 1.5;
    m.y = target.y + Math.cos(state.elapsed * 6) * 1.2;
    m.renderX = m.x;
    m.renderY = m.y;

    if (m.modeTime > m.landedDuration) {
      m.mode = 'flying';
      dom.mosquito.classList.remove('is-landed');
      m.landingCooldown = 5 + Math.random() * 5;
      pickTarget();
    }
  }

  function resetMosquito() {
    const m = state.mos;
    m.x = state.fieldRect.width * 0.5;
    m.y = state.fieldRect.height * 0.45;
    m.mode = 'flying';
    m.modeTime = 0;
    m.landingCooldown = 4 + Math.random() * 3;
    m.wobbleSeed = Math.random() * Math.PI * 2;
    m.landingStart = null;
    m.landingTarget = null;
    pickTarget();
    m.renderX = m.x;
    m.renderY = m.y;
    renderMosquito();
  }

  function respawnMosquito() {
    const m = state.mos;
    const rect = state.fieldRect;

    m.x = rand(rect.width * 0.16, rect.width * 0.84);
    m.y = rand(rect.height * 0.16, rect.height * 0.7);
    m.mode = 'flying';
    m.modeTime = 0;
    m.landingCooldown = 3.5 + Math.random() * 4;
    m.wobbleSeed = Math.random() * Math.PI * 2;
    pickTarget();
    m.renderX = m.x;
    m.renderY = m.y;

    dom.mosquito.classList.remove('is-splat');
    renderMosquito();
  }

  function startLanding() {
    const m = state.mos;
    const target = getFaceCenter();
    m.mode = 'landing';
    m.modeTime = 0;
    m.landingDuration = 0.75 + Math.random() * 0.35;
    m.landingStart = { x: m.x, y: m.y };
    m.landingTarget = target;
    dom.roommate.classList.add('is-targeted');
  }

  function pickTarget() {
    const m = state.mos;
    const rect = state.fieldRect;
    const padX = Math.min(56, rect.width * 0.13);
    const padTop = Math.min(64, rect.height * 0.13);
    const padBottom = Math.min(88, rect.height * 0.22);
    let x = m.x;
    let y = m.y;
    let tries = 0;

    do {
      x = rand(padX, Math.max(padX + 1, rect.width - padX));
      y = rand(padTop, Math.max(padTop + 1, rect.height - padBottom));
      tries += 1;
    } while (
      Math.hypot(x - m.x, y - m.y) < Math.min(90, rect.width * 0.24) &&
      tries < 8
    );

    m.tx = x;
    m.ty = y;
    m.modeTime = 0;
  }

  function renderMosquito() {
    const m = state.mos;
    // 越到后面越小：1.18 → 0.74
    const scale = 1.18 - 0.44 * clamp(state.elapsed / GAME_DURATION, 0, 1);
    dom.mosquito.style.transform =
      `translate3d(${m.renderX.toFixed(1)}px, ${m.renderY.toFixed(1)}px, 0) ` +
      `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
  }

  function getSpeed() {
    const width = state.fieldRect.width || 360;
    const progress = clamp(state.elapsed / GAME_DURATION, 0, 1);
    // 越到后面越快，手机和电脑都限制在舒适区间
    return clamp(width * (0.17 + 0.25 * progress), 78, 340);
  }

  function getMosquitoScale() {
    return 1.18 - 0.44 * clamp(state.elapsed / GAME_DURATION, 0, 1);
  }

  function measureField() {
    const rect = dom.playfield.getBoundingClientRect();
    state.fieldRect = {
      left: rect.left,
      top: rect.top,
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight
    };

    const m = state.mos;
    m.x = clamp(m.x, 14, Math.max(14, state.fieldRect.width - 14));
    m.y = clamp(m.y, 14, Math.max(14, state.fieldRect.height - 14));
    m.renderX = clamp(m.renderX, 14, Math.max(14, state.fieldRect.width - 14));
    m.renderY = clamp(m.renderY, 14, Math.max(14, state.fieldRect.height - 14));

    // 正在落脸 / 停在脸上时重新计算目标，避免横竖屏切换后错位
    if (m.mode === 'landing' || m.mode === 'landed') {
      m.landingTarget = getFaceCenter();
      if (m.mode === 'landing') m.landingStart = { x: m.x, y: m.y };
    }
  }

  function getFaceCenter() {
    const fieldRect = state.fieldRect || { left: 0, top: 0 };
    const faceRect = dom.face.getBoundingClientRect();
    return {
      x: faceRect.left + faceRect.width / 2 - fieldRect.left,
      y: faceRect.top + faceRect.height / 2 - fieldRect.top
    };
  }

  // ========================================================================
  // 输入判定与计分规则
  // ========================================================================
  function onPlayfieldPointer(event) {
    if (state.phase !== 'playing' || state.paused) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // 拍扁动画期间忽略点击，避免“尸体”被重复计分
    if (state.mos.mode === 'swatted') return;

    const x = event.clientX - state.fieldRect.left;
    const y = event.clientY - state.fieldRect.top;
    const hitRadius = Math.max(26, 30 * getMosquitoScale()) *
      (state.mos.mode === 'landed' ? 1.15 : 1);

    if (Math.hypot(x - state.mos.renderX, y - state.mos.renderY) <= hitRadius) {
      hitMosquito(x, y);
    } else {
      missSwing(x, y);
    }
  }

  function hitMosquito(x, y) {
    const faceHit = state.mos.mode === 'landed';

    state.combo += 1;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
    // 每连续命中 3 次提升一档倍率，最高 x5
    state.multiplier = Math.min(5, 1 + Math.floor(state.combo / 3));

    const points = HIT_BASE_SCORE * state.multiplier * (faceHit ? 2 : 1);
    state.score += points;
    state.misses = 0;

    state.mos.mode = 'swatted';
    state.mos.modeTime = 0;
    dom.mosquito.classList.add('is-splat');
    dom.mosquito.classList.remove('is-landed');
    dom.roommate.classList.remove('is-targeted');

    createSwatter(x, y);
    createSplatRing(x, y);
    shakeScreen();
    playHit(faceHit, state.multiplier);

    if (faceHit) {
      state.affinity = Math.max(0, state.affinity - FACE_HIT_PENALTY);
      dom.roommate.classList.add('is-angry');
      setTimeout(() => dom.roommate.classList.remove('is-angry'), 520);
      createFloatingText(`+${points} 室友：-${FACE_HIT_PENALTY}`, x, y - 26, 'face');
    } else {
      createFloatingText(`+${points}`, x, y - 20, state.multiplier >= 2 ? 'face' : '');
    }

    if (state.multiplier >= 2) showCombo(state.multiplier);
    updateHud();

    // 好感度扣光，立刻结束（荒谬但合规）
    if (state.affinity <= 0) endGame('affinity');
  }

  function missSwing(x, y) {
    state.misses += 1;
    state.combo = 0;
    state.multiplier = 1;

    createMissHand(x, y);
    playMiss();

    if (state.misses >= MISS_LIMIT) {
      state.misses = 0;
      if (state.score > 0) {
        state.score -= 1;
        createFloatingText('-1', x + 22, y - 18, 'penalty');
        playPenalty();
      } else {
        createFloatingText('扑空', x + 22, y - 18, 'penalty');
      }
    }

    updateHud();
  }

  function updateHud() {
    dom.score.textContent = state.score;
    dom.time.textContent = Math.ceil(state.timeLeft);
    dom.timerFill.style.width = `${(state.timeLeft / GAME_DURATION) * 100}%`;
    dom.timerFill.classList.toggle('is-urgent', state.timeLeft <= 8);

    dom.combo.textContent = state.combo;
    dom.multiplier.textContent = `倍率 x${state.multiplier}`;

    dom.affinityFill.style.width = `${state.affinity}%`;
    dom.affinityPanel.classList.toggle('is-low', state.affinity <= FACE_HIT_PENALTY);
    dom.affinityLabel.textContent = getAffinityText(state.affinity);
  }

  function getAffinityText(value) {
    if (value > 66) return '他还在装睡';
    if (value > 33) return '床开始晃了';
    if (value > 0) return '他睁眼了！';
    return '室友已离家出走';
  }

  // ========================================================================
  // 视觉反馈
  // ========================================================================
  function addEffect(el, lifetime) {
    if (dom.effects.children.length > 28) {
      dom.effects.removeChild(dom.effects.firstChild);
    }
    dom.effects.appendChild(el);
    setTimeout(() => el.remove(), lifetime);
  }

  function createSwatter(x, y) {
    const el = document.createElement('div');
    el.className = 'swatter-hit';
    el.innerHTML =
      '<span class="swatter-head"></span>' +
      '<span class="swatter-handle"></span>' +
      '<span class="swatter-word">啪!</span>';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    addEffect(el, 320);
  }

  function createSplatRing(x, y) {
    const el = document.createElement('div');
    el.className = 'splat-ring';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    addEffect(el, 480);
  }

  function createFloatingText(text, x, y, type) {
    const el = document.createElement('div');
    el.className = `float-text${type ? ` is-${type}` : ''}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    addEffect(el, 900);
  }

  function createMissHand(x, y) {
    const el = document.createElement('div');
    el.className = 'miss-hand';
    el.textContent = '🖐';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    addEffect(el, 640);
  }

  function showCombo(multiplier) {
    dom.comboBanner.textContent = `连击 x${multiplier}`;
    dom.comboBanner.classList.remove('show');
    dom.edgeFlash.classList.remove('show');
    // 强制重排以重启动画
    void dom.comboBanner.offsetWidth;
    dom.comboBanner.classList.add('show');
    dom.edgeFlash.classList.add('show');

    clearTimeout(comboTimer);
    comboTimer = setTimeout(() => {
      dom.comboBanner.classList.remove('show');
      dom.edgeFlash.classList.remove('show');
    }, 950);
  }

  function shakeScreen() {
    dom.app.classList.remove('is-shaking');
    void dom.app.offsetWidth;
    dom.app.classList.add('is-shaking');
    clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => dom.app.classList.remove('is-shaking'), 200);
  }

  function clearEffects() {
    dom.effects.innerHTML = '';
  }

  // ========================================================================
  // Web Audio 合成音效（不加载任何音频文件）
  // ========================================================================
  function initAudio() {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      if (!audioCtx) audioCtx = new Ctor();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (error) {
      audioCtx = null;
    }
  }

  function tone(freq, duration, type, volume, sweepTo, delay) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const start = audioCtx.currentTime + (delay || 0);
    const osc = audioCtx.createOscillator();
    const amp = audioCtx.createGain();

    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(Math.max(20, freq), start);
    if (sweepTo) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), start + duration);
    }

    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(amp);
    amp.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function noise(duration, volume) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const length = Math.floor(audioCtx.sampleRate * duration);
    const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }

    const source = audioCtx.createBufferSource();
    const filter = audioCtx.createBiquadFilter();
    const amp = audioCtx.createGain();

    source.buffer = buffer;
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value = 0.8;
    amp.gain.setValueAtTime(volume, audioCtx.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);

    source.connect(filter);
    filter.connect(amp);
    amp.connect(audioCtx.destination);
    source.start();
  }

  function playHit(faceHit, multiplier) {
    noise(0.055, faceHit ? 0.18 : 0.13);
    tone(520 + (multiplier - 1) * 90, 0.09, 'square', 0.055, 900);
    if (faceHit) {
      // 拍到室友脸：加一段滑稽的下滑音
      tone(340, 0.26, 'triangle', 0.075, 90, 0.04);
    }
  }

  function playMiss() {
    tone(240, 0.12, 'sine', 0.045, 100);
  }

  function playPenalty() {
    tone(180, 0.12, 'sawtooth', 0.05, 120);
    tone(140, 0.14, 'sawtooth', 0.04, 90, 0.1);
  }

  function playEnd() {
    tone(440, 0.16, 'triangle', 0.06, 420);
    tone(330, 0.16, 'triangle', 0.06, 300, 0.1);
    tone(220, 0.28, 'triangle', 0.07, 160, 0.2);
  }

  // ========================================================================
  // 结算、评语与本地最高分
  // ========================================================================
  function getVerdict(score, reason) {
    if (reason === 'affinity') {
      return '蚊子没死，你的室友先没了。这波属于宿舍外交事故。';
    }
    if (score <= 0) return '蚊子赢了，它今晚睡得很香';
    if (score < 60) return '这个分数，蚊子建议给你报销医药费。';
    if (score < 120) return '还行，至少室友没认出你是凶手。';
    if (score < 200) return '手速可以，建议加入宿舍灭蚊协会。';
    return '离谱！蚊子已连夜买票搬出宿舍。';
  }

  function loadBest() {
    try {
      const value = Number(localStorage.getItem(BEST_KEY));
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch (error) {
      return 0;
    }
  }

  function saveBest(value) {
    try {
      localStorage.setItem(BEST_KEY, String(value));
    } catch (error) {
      // 隐私模式或禁用存储时静默失败，不影响游玩
    }
  }

  function updateStartBest() {
    dom.startBest.textContent = state.best;
  }

  // ---------- 小工具 ----------
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(from, to, t) {
    return from + (to - from) * t;
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }
})();
