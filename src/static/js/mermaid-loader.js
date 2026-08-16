// ====== Mermaid 懒加载器 ======
// 首屏不再加载 3MB+ 的 mermaid.min.js；只有页面里第一次出现知识图谱时才动态加载。
(function () {
  "use strict";

  const MERMAID_SRC = '/vendor/mermaid/mermaid.min.js';
  let loadPromise = null;
  let pendingConfig = null;

  function applyConfig(mermaidInstance, config) {
    if (!mermaidInstance || !config) return;
    try {
      mermaidInstance.initialize(config);
    } catch (err) {
      console.warn('[Mermaid] initialize failed:', err);
    }
  }

  function configureMermaid(config) {
    pendingConfig = config || null;
    if (window.mermaid) applyConfig(window.mermaid, pendingConfig);
    return window.mermaid || null;
  }

  function ensureMermaid(config) {
    if (config) pendingConfig = config;
    if (window.mermaid) {
      if (pendingConfig) applyConfig(window.mermaid, pendingConfig);
      return Promise.resolve(window.mermaid);
    }
    if (!loadPromise) {
      loadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = MERMAID_SRC;
        script.async = true;
        script.onload = () => {
          try {
            if (pendingConfig) applyConfig(window.mermaid, pendingConfig);
            resolve(window.mermaid);
          } catch (err) {
            loadPromise = null;
            reject(err);
          }
        };
        script.onerror = () => {
          loadPromise = null;
          reject(new Error('Mermaid 脚本加载失败: ' + MERMAID_SRC));
        };
        document.head.appendChild(script);
      });
    }
    return loadPromise;
  }

  window.ensureMermaid = ensureMermaid;
  window.configureMermaid = configureMermaid;
})();
