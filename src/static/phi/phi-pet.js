// ===== Φ (Phi) 桌宠：四状态状态机 + 待机微行为 + 视线跟随 =====
// 待机 idle / 工作 working / 庆祝 celebrate / 报错 error
// 命名规范：CSS 类 .phi-*、data 属性 data-phi-*、API window.PhiPet
(function () {
  "use strict";

  var MODES = ["idle", "working", "celebrate", "error"];

  var MODE_TEXT = {
    idle:      { status: "待机中",   detail: "会眨眼，也会看你", toggle: "开始工作" },
    working:   { status: "工作中",   detail: "快速敲代码",       toggle: "完成工作" },
    celebrate: { status: "庆祝中",   detail: "工作成功",         toggle: "报错演示" },
    error:     { status: "报错中",   detail: "故障抖动",         toggle: "返回待机" }
  };

  var REDUCED_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // 视线位移上限（em，随桌宠字号缩放：100px 字号 ≈ 2.6px 横 / 1.8px 纵）
  var GAZE_X = 0.026;
  var GAZE_Y = 0.018;

  // 待机微行为：cls 挂在 .phi-pet 上，ms 与 CSS 动画时长对齐（略长，含收势）
  var BEHAVIORS = [
    { cls: "is-tilting", ms: 1060, weight: 3 },
    { cls: "is-hopping", ms: 760, weight: 3 },
    { cls: "is-waving", ms: 1140, weight: 2 },
    { cls: "is-double-blink", ms: 420, weight: 3 }
  ];

  var CONFETTI_COLORS = [
    "#fde047", "#93c5fd", "#c4b5fd", "#86efac", "#fda4af", "#fbbf24", "#67e8f9"
  ];

  function getMode(root) {
    return root.dataset.phiMode === "working" ? "working"
         : root.dataset.phiMode === "celebrate" ? "celebrate"
         : root.dataset.phiMode === "error" ? "error"
         : "idle";
  }

  function updateModeText(root, mode) {
    var card = root.closest(".phi-card");
    if (!card) return;

    var info = MODE_TEXT[mode] || MODE_TEXT.idle;
    var status = card.querySelector("[data-phi-status]");
    var detail = card.querySelector("[data-phi-detail]");
    var toggle = card.querySelector("[data-phi-mode-toggle]");

    if (status) status.textContent = info.status;
    if (detail) detail.textContent = info.detail;
    if (toggle) toggle.textContent = info.toggle;
  }

  function randomizeConfetti(root) {
    var items = root.querySelectorAll(".phi-confetti");
    var bucket = 88 / items.length;
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var style = el.style;
      style.setProperty("--phi-confetti-x", (4 + bucket * i + Math.random() * bucket * 0.8).toFixed(1) + "%");
      style.setProperty("--phi-confetti-y", (8 + Math.random() * 48).toFixed(1) + "%");
      style.setProperty("--phi-confetti-delay", (-Math.random() * 1.5).toFixed(2) + "s");
      style.setProperty("--phi-confetti-size", (0.10 + Math.random() * 0.12).toFixed(2) + "em");
      style.setProperty("--phi-confetti-spin", (Math.random() < 0.5 ? -1 : 1) * (20 + Math.random() * 40).toFixed(0) + "deg");
      style.setProperty("--phi-confetti-scale", (1 + Math.random() * 0.5).toFixed(2));
      style.setProperty("--phi-confetti-color", CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]);
    }
  }

  function setPhiPetMode(root, mode) {
    var nextMode = MODES.indexOf(mode) !== -1 ? mode : "idle";
    var prevMode = getMode(root);
    var changed = prevMode !== nextMode;

    // 过渡脉冲必须挂在 .phi-pet 本体上：CSS 选择器是 .phi-pet.is-phi-mode-transitioning
    // （挂在 .phi-pet-root 上永远匹配不到，这段动画此前是死的）。
    // 只在模式真的变化时播放：harness 每个 running 状态事件都会调一次 working，
    // 无条件重放会把 420ms 脉冲叠成持续抽搐。连切两次则先摘类再强制回流重放，
    // 并清掉上一个收尾定时器，否则旧定时器会提前掐掉新脉冲。
    if (changed && root.classList.contains("phi-pet")) {
      root.classList.remove("is-phi-mode-transitioning");
      void root.offsetWidth;
      root.classList.add("is-phi-mode-transitioning");
      window.clearTimeout(root.__phiTransitionTimer);
      root.__phiTransitionTimer = window.setTimeout(function () {
        root.classList.remove("is-phi-mode-transitioning");
        root.__phiTransitionTimer = 0;
      }, 460);
    }
    root.classList.toggle("is-working", nextMode === "working");
    root.classList.toggle("is-celebrating", nextMode === "celebrate");
    root.classList.toggle("is-erroring", nextMode === "error");
    root.dataset.phiMode = nextMode;
    if (nextMode === "celebrate") randomizeConfetti(root);
    updateModeText(root, nextMode);
    if (changed && typeof root.__phiModeChanged === "function") root.__phiModeChanged(nextMode);
  }

  function initPhiPet(root) {
    if (!root || root.__phiInited) return function () {};
    root.__phiInited = true;

    var eyes = root.querySelector(".phi-eyes");
    if (!eyes) return function () {};

    var destroyed = false;
    var toggle = root.closest(".phi-card")?.querySelector("[data-phi-mode-toggle]");
    var blinkTimer = 0, blinkEndTimer = 0;
    var saccadeTimer = 0, behaviorTimer = 0, behaviorEndTimer = 0;
    var perkTimer = 0, pokeTimer = 0, landingTimer = 0;

    // ---------- 结构补丁：眼睛外层（只负责视线位移）＋落地投影 ----------
    // 在 JS 里补，而不是改 harness.js 的内联 SVG 模板：模板里那串像素路径太长，
    // 且 preview 页共用同一份 phi-pet.js，补丁自动对两边生效。
    var eyesWrap = root.querySelector(".phi-eyes-wrap");
    if (!eyesWrap && eyes.parentNode) {
      eyesWrap = document.createElement("div");
      eyesWrap.className = "phi-eyes-wrap";
      eyesWrap.setAttribute("aria-hidden", "true");
      eyes.parentNode.insertBefore(eyesWrap, eyes);
      eyesWrap.appendChild(eyes);
    }

    if (root.parentNode && !root.parentNode.querySelector(".phi-shadow")) {
      var shadowEl = document.createElement("div");
      shadowEl.className = "phi-shadow";
      shadowEl.setAttribute("aria-hidden", "true");
      root.parentNode.insertBefore(shadowEl, root);
    }

    // ---------- 视线：落在椭圆上，逐帧阻尼跟随 ----------
    // 坐标写在 --phi-gaze-x/y（em），由 .phi-eyes-wrap 的 transform 消费；
    // 眨眼/工作眯眼仍走 .phi-eyes 自己的 scaleY，两层互不打架。
    var gaze = { x: 0, y: 0, tx: 0, ty: 0, raf: 0, rect: null, rectAt: 0, hovering: false };

    function eyesCenter() {
      var now = Date.now();
      if (!gaze.rect || now - gaze.rectAt > 240) {
        var target = eyesWrap || eyes;
        var rect = target.getBoundingClientRect();
        gaze.rect = { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
        gaze.rectAt = now;
      }
      return gaze.rect;
    }

    function applyGaze() {
      root.style.setProperty("--phi-gaze-x", gaze.x.toFixed(4) + "em");
      root.style.setProperty("--phi-gaze-y", gaze.y.toFixed(4) + "em");
    }

    function stepGaze() {
      gaze.raf = 0;
      if (destroyed) return;
      var ease = 0.2;
      gaze.x += (gaze.tx - gaze.x) * ease;
      gaze.y += (gaze.ty - gaze.y) * ease;
      var settled = Math.abs(gaze.tx - gaze.x) < 0.0004 && Math.abs(gaze.ty - gaze.y) < 0.0004;
      if (settled) {
        gaze.x = gaze.tx;
        gaze.y = gaze.ty;
      }
      applyGaze();
      if (!settled) kickGaze();
    }

    function kickGaze() {
      if (destroyed || gaze.raf) return;
      gaze.raf = window.requestAnimationFrame ? window.requestAnimationFrame(stepGaze) : window.setTimeout(stepGaze, 16);
    }

    function aimAt(clientX, clientY) {
      var c = eyesCenter();
      var dx = clientX - c.cx;
      var dy = clientY - c.cy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 6) {
        gaze.tx = 0;
        gaze.ty = 0;
        kickGaze();
        return;
      }
      // 近了看满、远了收一点：仍是那个方向，但不会“死死盯着”
      var strength = 0.4 + 0.6 * Math.max(0, 1 - dist / 560);
      gaze.tx = (dx / dist) * GAZE_X * strength;
      gaze.ty = (dy / dist) * GAZE_Y * strength;
      kickGaze();
    }

    function scheduleSaccade() {
      if (destroyed) return;
      saccadeTimer = window.setTimeout(function () {
        if (!document.hidden && getMode(root) === "idle" && !gaze.hovering) {
          var angle = Math.random() * Math.PI * 2;
          var radius = 0.3 + Math.random() * 0.7;
          gaze.tx = Math.cos(angle) * GAZE_X * radius;
          gaze.ty = Math.sin(angle) * GAZE_Y * radius;
          kickGaze();
        }
        scheduleSaccade();
      }, 1500 + Math.random() * 3400);
    }

    // ---------- 待机微行为：歪头 / 蹦一下 / 招手 / 连眨两下 ----------
    function pickBehavior() {
      var total = 0, i;
      for (i = 0; i < BEHAVIORS.length; i++) total += BEHAVIORS[i].weight;
      var roll = Math.random() * total;
      for (i = 0; i < BEHAVIORS.length; i++) {
        roll -= BEHAVIORS[i].weight;
        if (roll <= 0) return BEHAVIORS[i];
      }
      return BEHAVIORS[0];
    }

    function clearBehavior() {
      for (var i = 0; i < BEHAVIORS.length; i++) root.classList.remove(BEHAVIORS[i].cls);
    }

    function scheduleBehavior(delay) {
      if (destroyed || REDUCED_MOTION) return;
      behaviorTimer = window.setTimeout(function () {
        if (document.hidden || getMode(root) !== "idle" || root.classList.contains("is-dragging")) {
          scheduleBehavior(2200);
          return;
        }
        clearBehavior();
        var behavior = pickBehavior();
        root.classList.add(behavior.cls);
        behaviorEndTimer = window.setTimeout(function () {
          root.classList.remove(behavior.cls);
          // 间隔本身也随机：同一套动作不会踩出可预期的节拍
          scheduleBehavior(4200 + Math.random() * 7600);
        }, behavior.ms);
      }, typeof delay === "number" ? delay : 5200 + Math.random() * 7000);
    }

    // ---------- 交互反应 ----------
    var suppressPoke = false;

    function pulse(cls) {
      root.classList.remove(cls);
      void root.offsetWidth; // 同一类连续触发时也能重放动画
      root.classList.add(cls);
    }

    function onPointerMove(event) {
      if (event.pointerType === "touch") return;
      if (getMode(root) !== "idle") return;
      aimAt(event.clientX, event.clientY);
    }

    function onPointerEnter(event) {
      gaze.hovering = true;
      if (typeof event.clientX === "number") aimAt(event.clientX, event.clientY);
      if (getMode(root) === "idle" && !REDUCED_MOTION) {
        window.clearTimeout(perkTimer);
        pulse("is-perking");
        perkTimer = window.setTimeout(function () { root.classList.remove("is-perking"); }, 520);
      }
    }

    function onPointerLeave() {
      gaze.hovering = false;
    }

    function onClick() {
      if (suppressPoke) return;
      if (getMode(root) !== "idle" || REDUCED_MOTION) return;
      window.clearTimeout(pokeTimer);
      pulse("is-poked");
      pokeTimer = window.setTimeout(function () { root.classList.remove("is-poked"); }, 620);
    }

    // 拖拽由 harness.js 负责位移（内联 left/top），这里只观察手势做姿态反应
    var dragActive = false, dragMoved = false, dragStartX = 0, dragStartY = 0;

    function onPointerDown(event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      dragActive = true;
      dragMoved = false;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
    }

    function onDragMove(event) {
      if (!dragActive) return;
      var dx = event.clientX - dragStartX;
      var dy = event.clientY - dragStartY;
      if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 5) {
        dragMoved = true;
        root.classList.add("is-dragging");
      }
      if (!dragMoved) return;
      var tilt = Math.max(-8, Math.min(8, dx * 0.45));
      root.style.setProperty("--phi-drag-tilt", tilt.toFixed(2) + "deg");
    }

    function onPointerUp() {
      if (!dragActive) return;
      dragActive = false;
      if (!dragMoved) return;
      suppressPoke = true;
      window.setTimeout(function () { suppressPoke = false; }, 0);
      root.classList.remove("is-dragging");
      root.style.removeProperty("--phi-drag-tilt");
      if (!REDUCED_MOTION) {
        window.clearTimeout(landingTimer);
        pulse("is-landing");
        landingTimer = window.setTimeout(function () { root.classList.remove("is-landing"); }, 520);
      }
    }

    function onWindowBlur() {
      gaze.tx = 0;
      gaze.ty = 0;
      kickGaze();
    }

    // 模式切换时清掉待机类，避免「工作时还在招手」
    root.__phiModeChanged = function (mode) {
      clearBehavior();
      window.clearTimeout(perkTimer);
      window.clearTimeout(pokeTimer);
      window.clearTimeout(landingTimer);
      root.classList.remove("is-perking", "is-poked", "is-landing", "is-dragging");
      if (mode !== "idle") {
        gaze.tx = 0;
        gaze.ty = 0;
        kickGaze();
      }
    };

    // ---------- 眨眼（原有逻辑，保留节奏） ----------
    function scheduleBlink() {
      if (destroyed) return;
      var mode = getMode(root);
      var delay;
      if (mode === "working") {
        delay = 3800 + Math.random() * 3000;
      } else if (mode === "celebrate" || mode === "error") {
        delay = 5000 + Math.random() * 3000;
      } else {
        delay = 2600 + Math.random() * 4300;
      }

      blinkTimer = window.setTimeout(function () {
        if (document.visibilityState !== "hidden" && getMode(root) !== "celebrate" && getMode(root) !== "error") {
          eyes.classList.remove("is-blinking");
          void eyes.offsetWidth;
          eyes.classList.add("is-blinking");
          blinkEndTimer = window.setTimeout(function () {
            eyes.classList.remove("is-blinking");
          }, 190);
        }
        scheduleBlink();
      }, delay);
    }

    function handleToggle() {
      var order = { idle: "working", working: "celebrate", celebrate: "error", error: "idle" };
      setPhiPetMode(root, order[getMode(root)]);
    }

    if (toggle) toggle.addEventListener("click", handleToggle);
    updateModeText(root, getMode(root));
    if (getMode(root) === "working") root.classList.add("is-working");
    if (getMode(root) === "celebrate") root.classList.add("is-celebrating");
    if (getMode(root) === "error") root.classList.add("is-erroring");
    randomizeConfetti(root);
    scheduleBlink();

    if (!REDUCED_MOTION) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointermove", onDragMove, { passive: true });
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      window.addEventListener("blur", onWindowBlur);
      root.addEventListener("pointerenter", onPointerEnter);
      root.addEventListener("pointerleave", onPointerLeave);
      root.addEventListener("pointerdown", onPointerDown);
      root.addEventListener("click", onClick);
      scheduleSaccade();
      scheduleBehavior(2600 + Math.random() * 4200);
      applyGaze();
    }

    return function destroy() {
      destroyed = true;
      var timers = [blinkTimer, blinkEndTimer, saccadeTimer, behaviorTimer, behaviorEndTimer, perkTimer, pokeTimer, landingTimer, root.__phiTransitionTimer];
      for (var i = 0; i < timers.length; i++) window.clearTimeout(timers[i]);
      root.__phiTransitionTimer = 0;
      if (gaze.raf && window.cancelAnimationFrame) window.cancelAnimationFrame(gaze.raf);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onWindowBlur);
      root.removeEventListener("pointerenter", onPointerEnter);
      root.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("click", onClick);
      clearBehavior();
      root.classList.remove("is-poked", "is-perking", "is-landing", "is-dragging", "is-blinking");
      root.style.removeProperty("--phi-gaze-x");
      root.style.removeProperty("--phi-gaze-y");
      root.style.removeProperty("--phi-drag-tilt");
      root.__phiModeChanged = null;
      if (toggle) toggle.removeEventListener("click", handleToggle);
    };
  }

  window.PhiPet = {
    init: initPhiPet,
    setMode: setPhiPetMode
  };

  document.querySelectorAll("[data-phi-pet]").forEach(initPhiPet);
})();
