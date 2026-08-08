// ===== Φ (Phi) 桌宠：四状态状态机 =====
// 待机 idle / 工作 working / 庆祝 celebrate / 报错 error
// 命名规范：CSS 类 .phi-*、data 属性 data-phi-*、API window.PhiPet
(function () {
  "use strict";

  var MODES = ["idle", "working", "celebrate", "error"];

  var MODE_TEXT = {
    idle:      { status: "待机中",   detail: "随机眨眼已开启", toggle: "开始工作" },
    working:   { status: "工作中",   detail: "快速敲代码",     toggle: "完成工作" },
    celebrate: { status: "庆祝中",   detail: "工作成功",       toggle: "报错演示" },
    error:     { status: "报错中",   detail: "故障抖动",       toggle: "返回待机" }
  };

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

  var CONFETTI_COLORS = [
    "#fde047", "#93c5fd", "#c4b5fd", "#86efac", "#fda4af", "#fbbf24", "#67e8f9"
  ];

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

    root.classList.add("is-mode-transitioning");
    root.classList.toggle("is-working", nextMode === "working");
    root.classList.toggle("is-celebrating", nextMode === "celebrate");
    root.classList.toggle("is-erroring", nextMode === "error");
    root.dataset.phiMode = nextMode;
    if (nextMode === "celebrate") randomizeConfetti(root);
    updateModeText(root, nextMode);

    window.setTimeout(function () {
      root.classList.remove("is-mode-transitioning");
    }, 420);
  }

  function initPhiPet(root) {
    if (!root || root.__phiInited) return function () {};
    root.__phiInited = true;

    var eyes = root.querySelector(".phi-eyes");
    if (!eyes) return function () {};

    var toggle = root.closest(".phi-card")?.querySelector("[data-phi-mode-toggle]");
    var blinkTimer = 0;
    var blinkEndTimer = 0;
    var destroyed = false;

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

    return function destroy() {
      destroyed = true;
      window.clearTimeout(blinkTimer);
      window.clearTimeout(blinkEndTimer);
      if (toggle) toggle.removeEventListener("click", handleToggle);
      eyes.classList.remove("is-blinking");
    };
  }

  window.PhiPet = {
    init: initPhiPet,
    setMode: setPhiPetMode
  };

  document.querySelectorAll("[data-phi-pet]").forEach(initPhiPet);
})();
