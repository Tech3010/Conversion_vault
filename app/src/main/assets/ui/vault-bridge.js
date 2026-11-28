(function () {
  const hasBridge = typeof window.AndroidBridge !== 'undefined';
  function isPresetFlowMode() {
    try { return window.location.search.indexOf('mode=preset') !== -1; } catch (_) { return false; }
  }
  function isWorkflowFlowMode() {
    try { return window.location.search.indexOf('mode=workflow') !== -1; } catch (_) { return false; }
  }
  function getSavedWorkflows() {
    if (window.VaultWorkflows) return window.VaultWorkflows.listActive();
    try {
      const arr = JSON.parse(safeGet('cv_workflows_v1', '[]') || '[]');
      return Array.isArray(arr) ? arr.filter(w => w && !w.deleted) : [];
    } catch (_) { return []; }
  }
  function getPendingWorkflow() {
    if (window.VaultWorkflows) return window.VaultWorkflows.getPendingWorkflow();
    try {
      const raw = safeGet('cv_pending_workflow', '') || '';
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return (obj && obj.id) ? obj : null;
    } catch (_) { return null; }
  }
  function clearPendingWorkflow() {
    if (window.VaultWorkflows) { window.VaultWorkflows.clearPendingWorkflow(); return; }
    safeSet('cv_pending_workflow', '');
  }

  const NAV_ROUTES = {
    home: 'conversion_vault_p1_home.html',
    queue: 'conversion_vault_p5_queue_history.html',
    presets: 'conversion_vault_p7_presets.html',
    workflows: 'conversion_vault_p9_workflows.html',
    settings: 'conversion_vault_p6_settings.html'
  };

  const TOOL_ROUTES = {
    converter: 'conversion_vault_p2_select.html',
    metadata: 'conversion_vault_t1_metadata.html',
    compressor: 'conversion_vault_t2_compressor.html',
    inspector: 'conversion_vault_t4_inspector.html',
    suggestor: 'conversion_vault_t7_suggestor.html',
    integrity: 'conversion_vault_t8_integrity.html',
    playback_tester: 'conversion_vault_p8_playback_tester.html'
  };

  const V_EXT = new Set(['mp4','mkv','webm','mov','avi','ts','flv','ogv','3gp','m4v']);
  const A_EXT = new Set(['mp3','flac','opus','m4a','wav','ogg','ac3','aac','wma']);
  const I_EXT = new Set(['jpg','jpeg','png','webp','gif','bmp','tiff','avif','heic']);

  function parseTrimSec(str) {
    const s = String(str || '').trim();
    if (!s || /^end$/i.test(s)) return null;
    const parts = s.split(':').map(p => Number(p.trim()));
    if (parts.some(n => isNaN(n) || n < 0)) return -1;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return -1;
  }
  window.validateVaultTrimRange = function (startStr, endStr) {
    const st = parseTrimSec(startStr || '00:00:00');
    if (st === -1) return { ok: false, msg: 'Invalid Trim Start (use HH:MM:SS)' };
    const sSec = st == null ? 0 : st;
    const en = parseTrimSec(endStr);
    if (en === null) return { ok: true, startSec: sSec, endSec: null };
    if (en === -1) return { ok: false, msg: 'Invalid Trim End (use HH:MM:SS or End)' };
    if (en <= sSec) return { ok: false, msg: 'Trim End must be strictly after Trim Start' };
    return { ok: true, startSec: sSec, endSec: en };
  };

  function classifyExt(name) {
    const ext = (String(name || '').split('.').pop() || '').toLowerCase();
    if (V_EXT.has(ext)) return 'v';
    if (A_EXT.has(ext)) return 'a';
    if (I_EXT.has(ext)) return 'i';
    return null;
  }

  function currentPage() {
    return (window.location.pathname.split('/').pop() || '').toLowerCase();
  }

  function navigateTo(page) {
    if (!page) return;
    if (hasBridge && typeof window.AndroidBridge.navigate === 'function') {
      window.AndroidBridge.navigate(page);
    } else {
      window.location.href = page;
    }
  }

  function toast(msg) {
    const t = document.getElementById('toast');
    if (t) {
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2000);
    }
  }

  function safeGet(key, fallback) {
    if (hasBridge && typeof window.AndroidBridge.getAppState === 'function') {
      try {
        const v = window.AndroidBridge.getAppState(key);
        if (v !== '' && v !== null && v !== undefined) return v;
      } catch (_) {}
    }
    try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
  }

  function safeSet(key, val) {
    if (hasBridge && typeof window.AndroidBridge.setAppState === 'function') {
      try { window.AndroidBridge.setAppState(key, String(val)); } catch (_) {}
    }
    try { localStorage.setItem(key, String(val)); } catch (_) {}
  }

  function getActiveFiles() {
    try { return JSON.parse(safeGet('cv_active_files', '[]') || '[]'); } catch (_) { return []; }
  }

  function getActiveMode() {
    return safeGet('cv_active_mode', 'single') || 'single';
  }

  function setActiveFiles(mode, files) {
    safeSet('cv_active_mode', mode || 'single');
    safeSet('cv_active_files', JSON.stringify(files || []));
  }

  function clearActiveSelection() {
    safeSet('cv_active_mode', 'single');
    safeSet('cv_active_files', '[]');
    safeSet('cv_last_probe', '{}');
    safeSet('cv_pending_convert_cfg', '{}');
  }

  function copyText(text, label) {
    if (hasBridge && typeof window.AndroidBridge.copyToClipboard === 'function') {
      window.AndroidBridge.copyToClipboard(text);
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    toast(label || 'Copied to clipboard');
  }

  function injectGlobalAnimations() {
    if (document.getElementById('cv-anim-style')) return;
    const style = document.createElement('style');
    style.id = 'cv-anim-style';
    style.textContent = `
      
      
      
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        overflow-x: hidden !important;
        background: var(--bg) !important;
      }
      .app-frame {
        width: 100% !important;
        max-width: 540px !important;
        min-height: 100% !important;
        margin: 0 auto !important;
        box-sizing: border-box !important;
      }
      main.content {
        padding-bottom: 92px !important;
        box-sizing: border-box !important;
      }
      .bottom-nav, .bottom-bar, .bottom-cta-bar {
        width: 100% !important;
        max-width: 540px !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
        bottom: 0 !important;
        box-sizing: border-box !important;
      }

      html[data-theme="dark"] {
        --bg: #070a10;
        --surface: #0d121d;
        --card: #111827;
        --card-elev: #151e30;
        --input: #080c14;
      }
      .cv-dimmed {
        opacity: 0.45 !important;
        transition: opacity 0.2s ease !important;
      }

      html[data-theme="light"] {
        --bg: #ffffff;
        --surface: #f8fafc;
        --card: #f1f5f9;
        --card-elev: #e2e8f0;
        --input: #ffffff;
        --border: #e2e8f0;
        --border-strong: #cbd5e1;
        --text: #0f172a;
        --muted: #64748b;
        --gold-text: #a16207;
      }

      
      .bottom-nav {
        position: fixed !important; bottom: 0 !important; left: 50% !important; transform: translateX(-50%) !important;
        width: 100% !important; max-width: 540px !important; height: 66px !important;
        padding: 6px 4px !important; gap: 4px !important;
        display: grid !important; grid-template-columns: repeat(5, 1fr) !important; z-index: 40 !important;
      }
      .bottom-nav .nav-item {
        background: transparent !important; border: 1px solid transparent !important; border-radius: 11px !important;
        display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important;
        gap: 3px !important; padding: 4px 2px !important; font-size: 9.8px !important; font-weight: 700 !important;
        transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease, transform 0.14s cubic-bezier(0.22,1,0.36,1) !important;
      }
      .bottom-nav .nav-item.active {
        color: var(--crimson) !important;
        background: var(--crimson-soft) !important;
        border: 1px solid rgba(219, 10, 64, 0.50) !important;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 2px 10px rgba(219, 10, 64, 0.18) !important;
      }
      @keyframes cvSwipeFromRight {
        0% { opacity: 0; transform: translate3d(16px, 0, 0); }
        100% { opacity: 1; transform: translate3d(0, 0, 0); }
      }
      @keyframes cvSwipeFromLeft {
        0% { opacity: 0; transform: translate3d(-16px, 0, 0); }
        100% { opacity: 1; transform: translate3d(0, 0, 0); }
      }
      @keyframes cvPageEnter {
        0% { opacity: 0; }
        100% { opacity: 1; }
      }
      @keyframes cvPageExit {
        0% { opacity: 1; }
        100% { opacity: 0; }
      }
      main.content.cv-enter-right { animation: cvSwipeFromRight 0.28s cubic-bezier(0.22, 1, 0.36, 1) both !important; will-change: transform, opacity; }
      main.content.cv-enter-left { animation: cvSwipeFromLeft 0.28s cubic-bezier(0.22, 1, 0.36, 1) both !important; will-change: transform, opacity; }
      main.content.cv-exit-fade { animation: cvPageExit 0.13s ease-out both !important; will-change: opacity; }
      main.content.cv-enter-right > *, main.content.cv-enter-left > * { animation: none !important; }
      .bottom-nav .nav-item svg { width: 18px !important; height: 18px !important; }
      .set-card, .job-card, .wf-card, .tool-card { contain: layout style; }
      .encyc-item { content-visibility: auto; contain-intrinsic-size: auto 62px; }
      @keyframes cvPulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.45); opacity: 0.55; }
      }
      @keyframes cvModalIn {
        from { opacity: 0; transform: translateY(14px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .app-frame {
        transform: none !important;
      }
      main.content {
        animation: cvPageEnter 0.28s cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      .pulse-dot {
        animation: cvPulse 1.8s ease-in-out infinite;
      }
      .modal-card, .modal-sheet, .confirm-card {
        animation: cvModalIn 0.2s cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      button, .tool-card, .select-card, .nav-item {
        transition: transform 0.14s ease, border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
      }
      button:active, .tool-card:active, .select-card:active {
        transform: scale(0.975);
      }
    `;
    document.head.appendChild(style);
      // Global Android WebView tap polish: remove default blue tap highlight box & add curved theme-matched color-invert tap feedback
      if (!document.getElementById('cv-tap-theme-style')) {
        const ts = document.createElement('style');
        ts.id = 'cv-tap-theme-style';
        ts.textContent = `
          *, *::before, *::after { -webkit-tap-highlight-color: transparent !important; }
          button:focus, a:focus, [role="button"]:focus, .tool-card:focus { outline: none !important; }
          button, .tool-card, .btn-sm, .btn-sec, .btn-primary, .btn-use, .btn-save, .btn-test,
          .f-chip, .sf-chip, .s-chip, .cap-btn, .dest-pill, .mode-btn, .nav-item, .back-btn, .theme-opt, .encyc-cat-btn {
            transition: transform 0.11s ease, background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
          }
          .btn-sm:active, .btn-sec:active, .btn-test:active, .btn-sel-mode:active, .back-btn:active,
          .f-chip:active, .sf-chip:active, .s-chip:active, .cap-btn:active, .dest-pill:active,
          .mode-btn:active, .theme-opt:active, .encyc-cat-btn:active {
            background: var(--crimson) !important;
            border-color: var(--crimson) !important;
            color: #ffffff !important;
            transform: scale(0.97) !important;
          }
          .btn-sm:active *, .btn-sec:active *, .mode-btn:active *, .cap-btn:active *, .back-btn:active * {
            color: #ffffff !important;
            stroke: #ffffff !important;
          }
          .btn-primary:active, .btn-use:active, .btn-gen-main:active, .btn-new-preset:active {
            background: var(--gold) !important;
            border-color: var(--gold) !important;
            color: #090d16 !important;
            transform: scale(0.97) !important;
          }
          .btn-primary:active *, .btn-use:active *, .btn-gen-main:active * {
            color: #090d16 !important;
          }
          .tool-card:active {
            background: var(--crimson) !important;
            border-color: var(--crimson) !important;
            color: #ffffff !important;
            transform: scale(0.975) !important;
          }
          .tool-card:active .tool-title, .tool-card:active .tool-desc, .tool-card:active .tool-tag {
            color: #ffffff !important;
          }
          .tool-card.primary-tile:active {
            background: #f8fafc !important;
            border-color: var(--crimson) !important;
            color: #090d16 !important;
          }
          .tool-card.primary-tile:active .tool-title, .tool-card.primary-tile:active .tool-desc {
            color: #090d16 !important;
          }
          .tool-card.gold-tile:active {
            background: var(--gold) !important;
            border-color: var(--gold) !important;
            color: #090d16 !important;
          }
          .tool-card.gold-tile:active .tool-title, .tool-card.gold-tile:active .tool-desc, .tool-card.gold-tile:active .tool-tag {
            color: #090d16 !important;
            border-color: rgba(9,13,22,0.25) !important;
          }
          .nav-item:active {
            background: var(--crimson-soft) !important;
            color: var(--crimson) !important;
            border-radius: 10px !important;
            transform: scale(0.95) !important;
          }

          /* Unified Organic Drop-In Motion & Smooth Range Sliders */
          @keyframes cvLiquidRise {
            0% { opacity: 0; transform: translate3d(0, -10px, 0) scale(0.988); }
            100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
          }
          @keyframes cvOrganicDrop {
            0% { opacity: 0; transform: translate3d(0, -16px, 0) scale(0.982); }
            65% { opacity: 1; transform: translate3d(0, 2px, 0) scale(1.002); }
            100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
          }
          @keyframes cvValueSwap {
            0% { opacity: 0.12; transform: translate3d(0, -9px, 0); }
            100% { opacity: 1; transform: translate3d(0, 0, 0); }
          }
          @keyframes cvToastPop {
            0% { opacity: 0; transform: translate(-50%, 12px) scale(0.94); }
            100% { opacity: 1; transform: translate(-50%, 0) scale(1); }
          }
          .cv-drop-in {
            animation: cvOrganicDrop 0.46s cubic-bezier(0.16, 1, 0.3, 1) both !important;
            will-change: transform, opacity;
          }
          @keyframes cvPtrSpin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          #cv-ptr-bubble {
            position: fixed;
            top: 0;
            left: 50%;
            width: 42px;
            height: 42px;
            border-radius: 50%;
            background: var(--card-elev, #172236);
            border: 1.5px solid rgba(252, 209, 22, 0.55);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(219, 10, 64, 0.25);
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--gold-text, #fcd116);
            z-index: 950;
            pointer-events: none;
            opacity: 0;
            transform: translate3d(-50%, -64px, 0) scale(0.75);
            will-change: transform, opacity;
          }
          #cv-ptr-bubble.is-ready {
            border-color: var(--crimson, #db0a40);
            color: var(--crimson, #db0a40);
            box-shadow: 0 8px 26px rgba(219, 10, 64, 0.42);
          }
          #cv-ptr-bubble.is-spinning svg {
            animation: cvPtrSpin 0.65s linear infinite;
          }
          .cv-swap-in {
            animation: cvValueSwap 0.38s cubic-bezier(0.16, 1, 0.3, 1) both !important;
            will-change: transform, opacity;
          }
          main.content > section, main.content > .card-box, main.content > .set-card, main.content > .sec-card,
          main.content > .bucket, main.content > .status-strip, main.content > .pit-hero, main.content > .overall-hero {
            animation: cvLiquidRise 0.40s cubic-bezier(0.16, 1, 0.3, 1) both;
          }
          main.content > *:nth-child(2) { animation-delay: 0.03s; }
          main.content > *:nth-child(3) { animation-delay: 0.06s; }
          main.content > *:nth-child(4) { animation-delay: 0.09s; }
          main.content > *:nth-child(5) { animation-delay: 0.12s; }
          main.content > *:nth-child(6) { animation-delay: 0.15s; }
          .toast.show { animation: cvToastPop 0.22s cubic-bezier(0.22, 1, 0.36, 1) both; }
          .master-fill, .prog-fill, .bar-fill, .mbar-fill {
            transition: width 0.32s cubic-bezier(0.22, 1, 0.36, 1) !important;
          }
          .file-drawer, .deep-probe-box, .compat-note, .verdict-box {
            animation: cvLiquidRise 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
          }
          /* Liquid, zero-stick touch range sliders */
          input[type="range"] {
            -webkit-appearance: none !important;
            appearance: none !important;
            touch-action: none !important;
            width: 100% !important;
            height: 28px !important;
            background: transparent !important;
            cursor: pointer !important;
            margin: 2px 0 !important;
          }
          input[type="range"]::-webkit-slider-runnable-track {
            height: 6px;
            border-radius: 999px;
            background: linear-gradient(90deg, rgba(219,10,64,0.35), rgba(252,209,22,0.45));
            border: 1px solid var(--border-strong);
          }
          input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 22px;
            height: 22px;
            margin-top: -9px;
            border-radius: 50%;
            background: var(--gold);
            border: 2.5px solid #090d16;
            box-shadow: 0 2px 8px rgba(252, 209, 22, 0.45);
            transition: transform 0.14s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.14s ease, box-shadow 0.14s ease;
          }
          input[type="range"]:active::-webkit-slider-thumb {
            transform: scale(1.22);
            background: var(--crimson);
            box-shadow: 0 0 0 6px rgba(219, 10, 64, 0.24);
          }
        `;
        document.head.appendChild(ts);
      }
      // Global haptic feedback & slider touch-drag protection
      if (!window.__cvHapticsWired) {
        window.__cvHapticsWired = true;
        let lastTickTs = 0;
        const doHaptic = (kind) => {
          try {
            if (hasBridge && typeof window.AndroidBridge.haptic === 'function') {
              window.AndroidBridge.haptic(kind || 'tap');
            }
          } catch (_) {}
        };
        window.cvHaptic = doHaptic;
        document.addEventListener('pointerdown', (e) => {
          const el = e.target && e.target.closest
            ? e.target.closest('button, .tool-card, .select-card, .nav-item, .s-chip, .f-chip, .sf-chip, .t-tab, .seg-tab, .mode-btn, .theme-opt, .pcard, .back-btn')
            : null;
          if (!el || el.disabled) return;
          if (el.classList.contains('btn-danger') || el.id === 'btn-abort') doHaptic('heavy');
          else if (el.classList.contains('btn-primary') || el.classList.contains('btn-use') || el.classList.contains('btn-gen-main') || el.id === 'btn-start') doHaptic('confirm');
          else doHaptic('tap');
        }, { passive: true });
        document.addEventListener('change', (e) => {
          const t = e.target;
          if (t && (t.type === 'checkbox' || t.tagName === 'SELECT')) doHaptic('tick');
        }, { passive: true });
        document.addEventListener('touchstart', (e) => {
          if (e.target && e.target.type === 'range') e.stopPropagation();
        }, { passive: true });
        document.addEventListener('touchmove', (e) => {
          if (e.target && e.target.type === 'range') e.stopPropagation();
        }, { passive: true });
        document.addEventListener('input', (e) => {
          if (e.target && e.target.type === 'range') {
            const now = Date.now();
            if (now - lastTickTs >= 28) {
              lastTickTs = now;
              doHaptic('tick');
            }
          }
        }, { passive: true });
      }

      // Global Organic Drop-In Transition Helper & Meaningful-Change Observer
      if (!window.__cvOrganicMotionWired) {
        window.__cvOrganicMotionWired = true;
        window.cvAnimateUpdate = function(el, mode) {
          if (!el || !el.classList) return;
          const cls = mode === 'swap' ? 'cv-swap-in' : 'cv-drop-in';
          el.classList.remove('cv-drop-in', 'cv-swap-in');
          requestAnimationFrame(() => {
            if (el && el.classList) el.classList.add(cls);
          });
        };

        // Exclude live/high-frequency lists (batch-queue-list, list-video/audio/image, queue-list, history-list)
        // so file picking, probing, sorting, and live batch progress never flicker or stutter!
        const WATCH_LIST_IDS = [
          'batch-failed-list', 'rec-list', 'samples-list',
          'check-list', 'inspect-sections'
        ];
        const WATCH_TEXT_IDS = [
          'now-file-eyebrow', 'now-file-idx', 'overall-eyebrow', 'overall-sub',
          'done-summary', 'verdict-title', 'test-result', 'lbl-bench',
          'lbl-cache', 'main-ps-name', 'engine-sub'
        ];
        const lastListSig = {};
        const lastTextVal = {};

        const attachOrganicObservers = () => {
          WATCH_LIST_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (!el || el.__cvObs) return;
            const getSig = () => {
              const kids = el.children;
              let s = kids.length + ':';
              for (let i = 0; i < Math.min(kids.length, 20); i++) {
                s += (kids[i].textContent || '').replace(/[0-9]+%|Elapsed\s*[0-9:]+|ETA\s*[0-9:]+/g, '').trim().slice(0, 48) + '|';
              }
              return s;
            };
            lastListSig[id] = getSig();
            const obs = new MutationObserver(() => {
              const nextSig = getSig();
              if (nextSig === lastListSig[id]) return;
              lastListSig[id] = nextSig;
              window.cvAnimateUpdate(el, 'drop');
            });
            obs.observe(el, { childList: true });
            el.__cvObs = obs;
          });

          WATCH_TEXT_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (!el || el.__cvObs) return;
            lastTextVal[id] = (el.textContent || '').trim();
            const obs = new MutationObserver(() => {
              const cur = (el.textContent || '').trim();
              if (!cur || cur === lastTextVal[id]) return;
              lastTextVal[id] = cur;
              window.cvAnimateUpdate(el, 'swap');
            });
            obs.observe(el, { childList: true, characterData: true, subtree: true });
            el.__cvObs = obs;
          });

          // Smoothly drop in hidden cards/footers when they become visible
          ['batch-failed-card', 'verdict-box', 'done-summary', 'footer-done', 'footer-failed', 'hw-export-bar', 'pending-preset-banner'].forEach(id => {
            const el = document.getElementById(id);
            if (!el || el.__cvVisObs) return;
            let wasHidden = el.classList.contains('hidden');
            const obs = new MutationObserver(() => {
              const isHidden = el.classList.contains('hidden');
              if (wasHidden && !isHidden) window.cvAnimateUpdate(el, 'drop');
              wasHidden = isHidden;
            });
            obs.observe(el, { attributes: true, attributeFilter: ['class'] });
            el.__cvVisObs = obs;
          });
        };

        setTimeout(attachOrganicObservers, 120);
      }

      // Global Pull-to-Refresh Circle (browser-style top pull indicator)
      if (!window.__cvPtrWired) {
        window.__cvPtrWired = true;
        const curP = currentPage();
        const blockPtr = (curP === 'conversion_vault_p4a_convert_single.html' || curP === 'conversion_vault_p4_convert_batch.html');
        if (!blockPtr && document.body) {
          const ptrEl = document.createElement('div');
          ptrEl.id = 'cv-ptr-bubble';
          ptrEl.setAttribute('aria-hidden', 'true');
          ptrEl.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
          document.body.appendChild(ptrEl);

          let ptrStartY = 0, ptrStartX = 0, ptrPulling = false, ptrReady = false, ptrSpinning = false, ptrRaf = 0, ptrDist = 0;
          const PTR_THRESHOLD = 74;

          const drawPtr = () => {
            ptrRaf = 0;
            if (!ptrPulling || ptrSpinning) return;
            const y = Math.min(92, ptrDist * 0.56);
            const prog = Math.min(1, ptrDist / PTR_THRESHOLD);
            const deg = Math.round(prog * 300);
            ptrEl.style.transition = 'none';
            ptrEl.style.opacity = String(Math.min(1, prog * 1.25));
            ptrEl.style.transform = 'translate3d(-50%, ' + (y - 10).toFixed(1) + 'px, 0) scale(' + (0.78 + prog * 0.24).toFixed(2) + ')';
            const svg = ptrEl.querySelector('svg');
            if (svg) svg.style.transform = 'rotate(' + deg + 'deg)';
          };

          const hidePtr = () => {
            if (ptrRaf) { cancelAnimationFrame(ptrRaf); ptrRaf = 0; }
            ptrEl.classList.remove('is-ready', 'is-spinning');
            ptrEl.style.transition = 'transform 0.24s cubic-bezier(0.22,1,0.36,1), opacity 0.22s ease';
            ptrEl.style.opacity = '0';
            ptrEl.style.transform = 'translate3d(-50%, -64px, 0) scale(0.75)';
            ptrPulling = false;
            ptrReady = false;
            ptrDist = 0;
          };

          document.addEventListener('touchstart', (e) => {
            if (ptrSpinning || !e.touches || e.touches.length !== 1) return;
            const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
            if (scrollTop > 2) return;
            const tgt = e.target;
            if (tgt && tgt.closest && tgt.closest('input, select, textarea, .modal-backdrop, .modal-sheet, .confirm-card')) return;
            ptrStartY = e.touches[0].clientY;
            ptrStartX = e.touches[0].clientX;
            ptrPulling = true;
            ptrReady = false;
            ptrDist = 0;
          }, { passive: true });

          document.addEventListener('touchmove', (e) => {
            if (!ptrPulling || ptrSpinning || !e.touches || e.touches.length !== 1) return;
            const dy = e.touches[0].clientY - ptrStartY;
            const dx = e.touches[0].clientX - ptrStartX;
            if (dy <= 0 || Math.abs(dx) > Math.abs(dy) * 1.15) {
              if (ptrDist > 0) hidePtr();
              else ptrPulling = false;
              return;
            }
            if ((window.scrollY || document.documentElement.scrollTop || 0) > 2) {
              hidePtr();
              return;
            }
            ptrDist = dy;
            const nowReady = dy >= PTR_THRESHOLD;
            if (nowReady !== ptrReady) {
              ptrReady = nowReady;
              ptrEl.classList.toggle('is-ready', ptrReady);
              if (ptrReady && typeof window.cvHaptic === 'function') window.cvHaptic('tick');
            }
            if (!ptrRaf) ptrRaf = requestAnimationFrame(drawPtr);
          }, { passive: true });

          document.addEventListener('touchend', () => {
            if (!ptrPulling || ptrSpinning) return;
            if (ptrReady) {
              ptrPulling = false;
              ptrSpinning = true;
              if (typeof window.cvHaptic === 'function') window.cvHaptic('confirm');
              ptrEl.classList.add('is-spinning');
              ptrEl.style.transition = 'transform 0.2s cubic-bezier(0.22,1,0.36,1)';
              ptrEl.style.transform = 'translate3d(-50%, 62px, 0) scale(1)';
              ptrEl.style.opacity = '1';
              setTimeout(() => {
                try {
                  if (curP === 'conversion_vault_p5_queue_history.html' && typeof window.loadJobsFromNative === 'function') {
                    window.loadJobsFromNative();
                    toast('Queue & History refreshed ✓');
                  } else if (curP === 'conversion_vault_p7_presets.html' && typeof window.syncHubFromVaultPresets === 'function') {
                    window.syncHubFromVaultPresets();
                    toast('Presets refreshed ✓');
                  } else if (curP === 'conversion_vault_p9_workflows.html' && typeof window.renderWorkflowsHub === 'function') {
                    window.renderWorkflowsHub();
                    toast('Workflows refreshed ✓');
                  } else if (curP === 'conversion_vault_p1_home.html') {
                    hydrateHardwareStrip();
                    toast('Dashboard refreshed ✓');
                  } else {
                    window.location.reload();
                    return;
                  }
                } catch (_) {}
                setTimeout(() => {
                  ptrSpinning = false;
                  hidePtr();
                }, 260);
              }, 380);
            } else {
              hidePtr();
            }
          }, { passive: true });

          document.addEventListener('touchcancel', () => {
            if (!ptrSpinning) hidePtr();
          }, { passive: true });
        }
      }
  }

  function applySavedTheme() {
    let theme = safeGet('cv_theme', 'dark') || 'dark';
    if (hasBridge && typeof window.AndroidBridge.getSettings === 'function') {
      try {
        const s = JSON.parse(window.AndroidBridge.getSettings());
        if (s && s.theme) theme = s.theme;
      } catch (_) {}
    }
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('[data-set-theme]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-set-theme') === theme);
    });
  }

  function hydrateHardwareStrip() {
    if (!hasBridge || typeof window.AndroidBridge.getDeviceTelemetry !== 'function') return;
    if (!document.querySelector('.status-strip, .hw-grid, .hw-chip')) return;
    try {
      const t = JSON.parse(window.AndroidBridge.getDeviceTelemetry());
      const hwTag = document.querySelector('.status-strip .hw-tag');
      if (hwTag && t.model) hwTag.textContent = t.model;

      const stats = document.querySelectorAll('.status-metrics .mini-stat');
      if (stats.length >= 4) {
        const vals = [t.cpuSummary, t.ramTotal, t.internalFree, t.externalSdOtg];
        stats.forEach((box, idx) => {
          const vEl = box.querySelector('.mini-v');
          if (vEl && vals[idx]) {
            vEl.textContent = vals[idx];
            if (idx === 3 && vals[idx] !== 'None') vEl.style.color = 'var(--emerald)';
          }
        });
      }

      // Hydrate hardware chips on p2a_single & p3_batch
      document.querySelectorAll('.hw-chip').forEach(el => {
        if (t.model) el.textContent = t.model + ' · ' + (t.totalCores || '') + ' Cores';
      });

      // Hydrate Settings Hardware Profile grid (.hw-grid .hw-cell)
      document.querySelectorAll('.hw-grid .hw-cell').forEach(cell => {
        const k = (cell.querySelector('.hw-k')?.textContent || '').toLowerCase();
        const v = cell.querySelector('.hw-v');
        if (!v) return;
        if (k.includes('device model')) v.textContent = t.model || 'Android Device';
        else if (k.includes('soc')) v.textContent = (t.soc || 'SoC') + ' · ' + (t.totalCores || 8) + ' Cores';
        else if (k.includes('cpu clusters')) v.textContent = t.cpuSummary || (t.totalCores + ' Cores');
        else if (k.includes('ram')) v.textContent = (t.ramTotal || '—') + ' · ' + (t.internalFree || '—');
        else if (k.includes('abi') && t.abi) v.textContent = t.abi + ' · Android ' + (t.androidVersion || '');
        else if (k.includes('hw decode') && t.codecs) {
          const supported = [];
          if (t.codecs.h264HwDecode) supported.push('H.264 8-bit');
          if (t.codecs.hevc10bitHwDecode) supported.push('HEVC 10-bit');
          if (t.codecs.av1HwDecode) supported.push('AV1');
          v.textContent = supported.length ? supported.join(' · ') : 'Software Decode';
        }
      });

      // Hydrate Home green box expandable "Supported Formats on This Device" drawer
      const hfDrawer = document.getElementById('home-formats-drawer');
      if (hfDrawer) {
        let bench = null;
        try {
          if (typeof window.AndroidBridge.getSettings === 'function') {
            const st = JSON.parse(window.AndroidBridge.getSettings() || '{}');
            if (st && st.hwTestJson) bench = JSON.parse(st.hwTestJson);
          }
        } catch (_) {}
        const c = (bench && bench.codecs) || t.codecs || {};
        const enc = (bench && bench.ffmpegEncoders) || null;
        const hasSwAv1 = enc ? Boolean(enc['libsvtav1'] || enc['libaom-av1'] || enc['librav1e']) : false;
        const av1CanEnc = Boolean(c.av1HwEncode) || hasSwAv1;
        const fpsTxt = (bench && bench.ok && bench.fps > 0) ? (' · ~' + Number(bench.fps).toFixed(1) + ' fps') : '';

        const rows = [
          {
            name: 'H.264 8-bit (.mp4)',
            sub: (c.h264HwDecode ? 'HW Decode ✓' : 'SW Decode') + ' · ' + (c.h264HwEncode ? 'HW Encode ✓' : 'CPU x264') + fpsTxt,
            badge: c.h264HwDecode ? 'SUPPORTED ✓' : 'CPU SAFE',
            cls: 'hf-ok'
          },
          {
            name: 'HEVC / H.265 10-bit (.mkv / .mp4)',
            sub: (c.hevc10bitHwDecode ? '10-bit HW Decode ✓' : 'No 10-bit HW Decode') + ' · ' + (c.hevcHwEncode ? 'HW Encode ✓' : 'CPU x265'),
            badge: c.hevc10bitHwDecode ? '10-BIT HW ✓' : 'SW ONLY',
            cls: c.hevc10bitHwDecode ? 'hf-ok' : 'hf-warn'
          },
          {
            name: 'AV1 (.mp4 / .mkv)',
            sub: (c.av1HwDecode ? 'HW Decode ✓' : 'No HW Decode') + ' · ' + (c.av1HwEncode ? 'HW Encode ✓' : (hasSwAv1 ? 'CPU Encode' : 'No Encoder Detected')),
            badge: c.av1HwEncode ? 'FULL HW ✓' : (av1CanEnc ? 'SW ENC' : 'LIMITED'),
            cls: c.av1HwEncode ? 'hf-ok' : (av1CanEnc ? 'hf-warn' : 'hf-no')
          },
          {
            name: 'H.264 10-bit (Hi10P)',
            sub: c.h264_10bitHwDecode ? 'Hardware 10-bit AVC decoder reported' : 'No hardware Hi10P decoder on this SoC',
            badge: c.h264_10bitHwDecode ? 'HW DEC ✓' : 'NOT HW',
            cls: c.h264_10bitHwDecode ? 'hf-ok' : 'hf-warn'
          },
          {
            name: 'Audio & Photos',
            sub: 'Opus · FLAC · AAC · MP3 · WAV · WebP · JPG · PNG' + (av1CanEnc ? ' · AVIF' : ''),
            badge: 'READY ✓',
            cls: 'hf-ok'
          }
        ];

        hfDrawer.innerHTML = rows.map(r =>
          '<div class="hf-row">' +
            '<div class="hf-left">' +
              '<span class="hf-name">' + r.name + '</span>' +
              '<span class="hf-sub">' + r.sub + '</span>' +
            '</div>' +
            '<span class="hf-badge ' + r.cls + '">' + r.badge + '</span>' +
          '</div>'
        ).join('');
      }

      const bHomeFmt = document.getElementById('btn-home-formats');
      if (bHomeFmt && !bHomeFmt.__cvWired) {
        bHomeFmt.__cvWired = true;
        bHomeFmt.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const dr = document.getElementById('home-formats-drawer');
          const lbl = document.getElementById('lbl-home-formats');
          const ico = document.getElementById('ico-home-formats');
          if (!dr) return;
          const willOpen = dr.classList.contains('hidden');
          dr.classList.toggle('hidden', !willOpen);
          bHomeFmt.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
          if (lbl) lbl.textContent = willOpen ? 'Hide Supported Formats' : 'More · Supported Formats on This Device';
          if (ico) ico.textContent = willOpen ? '▴' : '▾';
          if (willOpen && typeof window.cvAnimateUpdate === 'function') window.cvAnimateUpdate(dr, 'drop');
        });
      }
    } catch (_) {}
  }

  function probeAndHydrateSingleFile(fileObj) {
    if (!fileObj || !fileObj.path) return null;
    let info = null;
    if (hasBridge && typeof window.AndroidBridge.probeFile === 'function') {
      try { info = JSON.parse(window.AndroidBridge.probeFile(fileObj.path)); } catch (_) {}
    }
    const name = (info && info.filename) || fileObj.name || 'Selected file';
    const mb = info && info.sizeBytes ? (info.sizeBytes / (1024 * 1024)).toFixed(2) + ' MB'
             : (fileObj.sizeBytes ? (fileObj.sizeBytes / (1024 * 1024)).toFixed(2) + ' MB' : '');
    const dur = info && info.durationSec ? info.durationSec.toFixed(1) + 's' : '';

    const lblFname = document.getElementById('lbl-fname');
    if (lblFname) lblFname.textContent = name;
    document.querySelectorAll('.fb-name, .fp-name').forEach(el => { el.textContent = name; });
    document.querySelectorAll('.modal-sub').forEach(el => { el.textContent = 'Target: ' + name; });
    document.querySelectorAll('.fb-meta, .fmeta').forEach(el => {
      const parts = [mb, dur, info && info.format ? info.format.toUpperCase() : ''].filter(Boolean);
      if (parts.length) el.textContent = parts.join(' · ');
    });

    if (info) {
      safeSet('cv_last_probe', JSON.stringify(info));
      const sizeBytes = info.sizeBytes || fileObj.sizeBytes || 0;
      const sizeMbStr = sizeBytes ? (sizeBytes / (1024 * 1024)).toFixed(2) + ' MB' : '—';
      const durSec = info.durationSec || 0;
      const durStr = durSec > 0 ? durSec.toFixed(2) + 's' : '—';
      const fpsStr = info.fps > 0 ? (Math.round(info.fps * 100) / 100) + ' fps' : '—';
      const resStr = (info.width && info.height) ? (info.width + '×' + info.height) : '—';
      const brStr = info.bitrate > 0 ? (info.bitrate / 1000000).toFixed(2) + ' Mbps' : '—';
      const audBrStr = info.audioBitrate > 0 ? Math.round(info.audioBitrate / 1000) + ' kbps' : '—';

      document.querySelectorAll('.fb-size').forEach(el => { el.textContent = sizeMbStr; });
      if (fileObj.path) {
        const dirPath = fileObj.path.lastIndexOf('/') > 0 ? fileObj.path.substring(0, fileObj.path.lastIndexOf('/')) : fileObj.path;
        document.querySelectorAll('.fb-path').forEach(el => { el.textContent = dirPath; });
      }

      // Dedicated media-type-specific File Information on Single File Workspace (zero dummy data)
      if (currentPage() === 'conversion_vault_p2a_single.html') {
        const mCat = classifyExt(name);
        const gridEl = document.getElementById('single-info-grid');
        const tagEl = document.getElementById('single-probe-tag');
        const deepEl = document.getElementById('single-deep-meta');
        const badgeEl = document.querySelector('.single-badge');
        const esc = (s) => String(s == null ? '—' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const cell = (k, v, cls) => '<div class="info-cell"><span class="info-k">' + esc(k) + '</span><span class="info-v' + (cls ? ' ' + cls : '') + '">' + esc(v) + '</span></div>';

        const renderAllTagsHtml = (tagsObj) => {
          const entries = (tagsObj && typeof tagsObj === 'object') ? Object.entries(tagsObj) : [];
          if (!entries.length) {
            return '<div class="raw-meta-pill" style="margin-top:8px;"><strong>Complete Metadata:</strong><br>No embedded metadata tags found in this file.</div>';
          }
          return '<div class="raw-meta-pill" style="margin-top:8px; max-height:220px; overflow-y:auto;">' +
            '<strong>Complete Metadata (' + entries.length + ' Tags):</strong><br>' +
            entries.map(([k, v]) => '<div style="padding:2px 0; border-bottom:1px dashed rgba(255,255,255,0.06); word-break:break-word;"><span style="color:var(--gold-text); font-weight:700;">' + esc(k) + ':</span> ' + esc(v) + '</div>').join('') +
          '</div>';
        };
        const deepPanel = document.getElementById('deep-probe-panel');
        const moreBtnLbl = document.getElementById('lbl-more-probe');

        if (mCat === 'i') {
          if (badgeEl) badgeEl.textContent = 'PHOTO';
          if (tagEl) tagEl.textContent = 'Native Photo Probe';
          if (moreBtnLbl) moreBtnLbl.textContent = 'More Information (Sensor, EXIF, Lens, GPS & Complete Metadata)';
          const extUp = (name.split('.').pop() || 'IMG').toUpperCase();
          const aspect = (info.width && info.height) ? ((info.width / info.height).toFixed(2) + ':1') : '—';
          const metaLbl = info.hasGps ? ('GPS + ' + (info.tagsCount || 0) + ' EXIF Tags') : (info.tagsCount > 0 ? (info.tagsCount + ' EXIF Tags') : 'Clean');
          if (gridEl) {
            gridEl.innerHTML =
              cell('Dimensions', resStr + (info.megapixels && info.megapixels !== '—' ? (' · ' + info.megapixels) : '')) +
              cell('Image Format', extUp) +
              cell('Color Space', (info.colorSpace && info.colorSpace !== '—') ? info.colorSpace : 'sRGB') +
              cell('File Size', sizeMbStr) +
              cell('Orientation', info.exifOrientation || 'Normal (0°)') +
              cell('Metadata', metaLbl, info.hasGps ? 'c-gold' : '');
          }
          if (deepPanel) {
            deepPanel.innerHTML =
              '<span class="probe-group-lbl">Photo Technical Specs &amp; Camera EXIF</span>' +
              '<div class="info-grid">' +
                cell('Exact Byte Size', sizeBytes ? (sizeBytes.toLocaleString() + ' B') : '—') +
                cell('Aspect Ratio', aspect) +
                cell('Camera', info.cameraModel || '—') +
                cell('Lens', info.lensModel || '—') +
                cell('Aperture &amp; Shutter', (info.aperture || '—') + ' · ' + (info.shutter || '—')) +
                cell('ISO &amp; Focal Length', (info.iso || '—') + ' · ' + (info.focalLength || '—')) +
                cell('Date Taken', info.dateTaken || '—') +
                cell('Software', info.software || '—') +
                cell('GPS Location', info.gpsCoords || 'None', info.hasGps ? 'c-gold' : '') +
                cell('MIME Type', info.mimeType || ('image/' + extUp.toLowerCase())) +
              '</div>' +
              renderAllTagsHtml(info.allTags);
          }
        } else if (mCat === 'a') {
          if (badgeEl) badgeEl.textContent = 'AUDIO';
          if (tagEl) tagEl.textContent = 'FFprobe Audio Stream';
          if (moreBtnLbl) moreBtnLbl.textContent = 'More Information (PCM, Bit Depth, Layout & Complete ID3 Tags)';
          const extUp = (name.split('.').pop() || 'AUDIO').toUpperCase();
          const chLbl = info.channels === 2 ? '2 ch (Stereo)' : (info.channels === 1 ? '1 ch (Mono)' : (info.channels ? info.channels + ' ch' : '—'));
          const srLbl = (info.sampleRate && info.sampleRate !== '—') ? (info.sampleRate + ' Hz') : '—';
          const effBr = audBrStr !== '—' ? audBrStr : (info.bitrate > 0 ? Math.round(info.bitrate / 1000) + ' kbps' : '—');
          if (gridEl) {
            gridEl.innerHTML =
              cell('Audio Codec', (info.audioCodec && info.audioCodec !== 'None') ? info.audioCodec.toUpperCase() : extUp) +
              cell('Bitrate', effBr) +
              cell('Duration', durStr) +
              cell('Sample Rate', srLbl) +
              cell('Channels', chLbl) +
              cell('Metadata', info.tagsCount > 0 ? (info.tagsCount + ' Tags Found') : 'Clean');
          }
          if (deepPanel) {
            deepPanel.innerHTML =
              '<span class="probe-group-lbl">Audio Stream (a:0) · PCM &amp; Container</span>' +
              '<div class="info-grid">' +
                cell('Codec Full Name', info.audioCodecLong || info.audioCodec || extUp) +
                cell('Profile', info.audioProfile || '—') +
                cell('Sample Format', info.audioSampleFmt || '—') +
                cell('Bits / Sample', info.audioBitsPerSample > 0 ? (info.audioBitsPerSample + '-bit') : '—') +
                cell('Channel Layout', info.channelLayout || chLbl) +
                cell('Container', info.formatLongName || info.format || extUp) +
                cell('Exact Byte Size', sizeBytes ? (sizeBytes.toLocaleString() + ' B') : '—') +
                cell('Streams &amp; Start', (info.streamCount || 1) + ' stream(s) · ' + (info.startTime || '0s')) +
              '</div>' +
              renderAllTagsHtml(info.allTags);
          }
        } else {
          if (badgeEl) badgeEl.textContent = 'VIDEO';
          if (tagEl) tagEl.textContent = 'FFprobe Deep Stream';
          if (moreBtnLbl) moreBtnLbl.textContent = 'More Information (Intra/GOP, Chroma, Color, Audio & Complete Metadata)';
          const vCodecLbl = (info.videoCodec && info.videoCodec !== 'None') ? (info.videoCodec.toUpperCase() + (info.pixFmt && info.pixFmt !== '—' ? ' (' + info.pixFmt + ')' : '')) : '—';
          const aStreamLbl = (info.audioCodec && info.audioCodec !== 'None')
            ? (info.audioCodec.toUpperCase() + (audBrStr !== '—' ? ' · ' + audBrStr : '') + (info.sampleRate && info.sampleRate !== '—' ? ' · ' + info.sampleRate + ' Hz' : ''))
            : 'No Audio Track';
          const vBrStr = info.videoBitrate > 0 ? ((info.videoBitrate / 1000000).toFixed(2) + ' Mbps') : brStr;
          if (gridEl) {
            gridEl.innerHTML =
              cell('Resolution &amp; FPS', resStr + (fpsStr !== '—' ? ' · ' + fpsStr : '')) +
              cell('Video Codec', vCodecLbl) +
              cell('Source Bitrate', brStr) +
              cell('Duration', durStr) +
              cell('Audio Stream', aStreamLbl) +
              cell('Metadata', info.hasGps ? ('GPS + ' + (info.tagsCount || 0) + ' Tags') : (info.tagsCount > 0 ? (info.tagsCount + ' Tags Found') : 'Clean'), info.hasGps ? 'c-gold' : '');
          }
          if (deepPanel) {
            deepPanel.innerHTML =
              '<span class="probe-group-lbl">Video Stream (v:0) · Intra/GOP, Chroma &amp; Color</span>' +
              '<div class="info-grid">' +
                cell('Frame Structure', info.frameStructure || '—') +
                cell('B-Frames &amp; Refs', (info.hasBFrames >= 0 ? info.hasBFrames + ' B-fr' : '—') + ' · ' + (info.refs >= 0 ? info.refs + ' ref' : '—')) +
                cell('Chroma &amp; Bit Depth', (info.chromaSubsampling || '—') + ' · ' + (info.bitDepth || '—') + (info.chromaLocation && info.chromaLocation !== '—' ? (' · ' + info.chromaLocation) : '')) +
                cell('Pixel Format', info.pixFmt || '—') +
                cell('Profile &amp; Level', (info.videoProfile || '—') + ' @ ' + (info.videoLevel || '—')) +
                cell('Color Space / Prim.', (info.colorSpace || '—') + ' / ' + (info.colorPrimaries || '—')) +
                cell('Transfer &amp; Range', (info.colorTransfer || '—') + ' · ' + (info.colorRange || '—')) +
                cell('Video Bitrate', vBrStr) +
                cell('Frames &amp; Timebase', (info.nbFrames || '—') + ' fr · tbn ' + (info.timeBase || '—')) +
                cell('SAR / DAR', (info.sar || '—') + ' / ' + (info.dar || '—')) +
                cell('Field Order', info.fieldOrder || 'Progressive', 'c-emerald') +
                cell('Codec Full Name', info.videoCodecLong || info.videoCodec || '—') +
              '</div>' +
              '<span class="probe-group-lbl" style="margin-top:8px;">Audio (a:0), Subtitles &amp; Container</span>' +
              '<div class="info-grid">' +
                cell('Audio Codec &amp; Fmt', (info.audioCodec || 'None').toUpperCase() + (info.audioSampleFmt && info.audioSampleFmt !== '—' ? (' · ' + info.audioSampleFmt) : '')) +
                cell('Audio Channels', (info.channelLayout && info.channelLayout !== '—' ? info.channelLayout : (info.channels ? info.channels + ' ch' : '—')) + (audBrStr !== '—' ? (' · ' + audBrStr) : '')) +
                cell('Container Format', info.formatLongName || info.format || '—') +
                cell('Streams / Subs / Ch.', (info.streamCount || 0) + ' str · ' + (info.subtitleCount || 0) + ' sub · ' + (info.chapterCount || 0) + ' ch') +
              '</div>' +
              renderAllTagsHtml(info.allTags);
          }
        }
      }

      // Hydrate every .info-cell dynamically from real FFprobe data (skip on Stream Inspector which owns full media-aware rendering)
      if (currentPage() !== 'conversion_vault_t4_inspector.html') document.querySelectorAll('.info-cell').forEach(cell => {
        const k = (cell.querySelector('.info-k')?.textContent || '').toLowerCase();
        const v = cell.querySelector('.info-v');
        if (!v || v.id === 'perf-size' || v.id === 'perf-res') return;
        if (k.includes('resolution')) v.textContent = resStr + (fpsStr !== '—' ? ' · ' + fpsStr : '');
        else if (k.includes('video codec') || k.includes('codec & tag')) v.textContent = (info.videoCodec || '—').toUpperCase() + (info.pixFmt && info.pixFmt !== '—' ? ' (' + info.pixFmt + ')' : '');
        else if (k.includes('source bitrate') || k.includes('overall bitrate')) v.textContent = brStr;
        else if (k.includes('duration')) v.textContent = durStr;
        else if (k.includes('audio stream') || k.includes('audio codec')) v.textContent = (info.audioCodec || 'None').toUpperCase() + (audBrStr !== '—' ? ' · ' + audBrStr : '') + (info.sampleRate && info.sampleRate !== '—' ? ' · ' + info.sampleRate + ' Hz' : '');
        else if (k.includes('detected metadata') || k.includes('privacy risk')) v.textContent = info.hasGps ? 'GPS + Container Tags Found' : (info.tagsSummary || 'Clean');
        else if (k.includes('format name')) v.textContent = info.format || '—';
        else if (k.includes('exact byte size')) v.textContent = sizeBytes ? (sizeBytes.toLocaleString() + ' B (' + sizeMbStr + ')') : '—';
        else if (k.includes('profile')) v.textContent = info.videoProfile || '—';
        else if (k.includes('pixel fmt')) v.textContent = info.pixFmt || '—';
        else if (k.includes('color')) v.textContent = info.colorSpace || '—';
        else if (k.includes('fps')) v.textContent = fpsStr;
        else if (k.includes('sample rate')) v.textContent = info.sampleRate ? (info.sampleRate + ' Hz') : '—';
        else if (k.includes('channels')) v.textContent = info.channels ? (info.channels + ' ch') : '—';
        else if (k.includes('audio bitrate')) v.textContent = audBrStr;
        else if (k.includes('subtitle')) v.textContent = (info.subtitleCount || 0) + ' Tracks';
        else if (k.includes('moov') || k.includes('container')) v.textContent = (info.format || '—') + ' · ' + (info.streamCount || 0) + ' Streams';
      });

      const jsonPre = document.getElementById('json-out') || document.querySelector('pre.json-box');
      if (jsonPre && currentPage() === 'conversion_vault_t4_inspector.html') {
        jsonPre.textContent = JSON.stringify(info.raw || info, null, 2);
      }
      if (typeof window.applyMetadataFileFromNative === 'function') {
        window.applyMetadataFileFromNative(fileObj, info);
      }
      if (typeof window.updateSingleFileFromProbe === 'function') {
        window.updateSingleFileFromProbe(fileObj, info);
      }
      if (typeof window.refreshSinglePhotoAudioPerf === 'function') {
        window.refreshSinglePhotoAudioPerf(fileObj, info);
      }
      if (typeof window.syncToolFromNative === 'function') {
        window.syncToolFromNative(fileObj, info);
      }
    }
    return info;
  }

  window.onVaultFilesPicked = function (payload) {
    if (!payload) return;
    const mode = payload.mode || 'single';
    const files = payload.files || [];
    const page = currentPage();

    if (window.__pickingWorkflowDir && mode === 'folder') {
      window.__pickingWorkflowDir = false;
      const wfFolderPath = (payload.folderPath && String(payload.folderPath).trim())
        || ((files[0] && files[0].path && String(files[0].path).includes('/'))
          ? String(files[0].path).substring(0, String(files[0].path).lastIndexOf('/'))
          : ('/storage/emulated/0/' + (payload.folderName || 'ConversionVault')));
      if (typeof window.onVaultWorkflowDirPicked === 'function') {
        window.onVaultWorkflowDirPicked({
          folderPath: wfFolderPath,
          folderName: payload.folderName || wfFolderPath.split('/').filter(Boolean).pop() || 'Folder',
          treeUri: payload.treeUri || ''
        });
      }
      return;
    }

    if (window.__pickingCustomDest && mode === 'folder') {
      window.__pickingCustomDest = false;
      try { window.dispatchEvent(new CustomEvent('cv_custom_folder_picked', { detail: { path: pickedDir } })); } catch (_) {}
      const folderPath = (payload.folderPath && payload.folderPath.trim())
        || ((files[0] && files[0].path) ? files[0].path.substring(0, files[0].path.lastIndexOf('/')) : ('/storage/emulated/0/' + (payload.folderName || 'ConversionVault')));
      if (page === 'conversion_vault_p6_settings.html') {
        const vLbl = document.getElementById('lbl-vault-path') || document.querySelector('.vault-path, .path-val');
        if (vLbl) vLbl.textContent = folderPath.replace(/\/$/, '') + '/';
        if (hasBridge && typeof window.AndroidBridge.saveSettings === 'function') {
          window.AndroidBridge.saveSettings(JSON.stringify({ defaultVaultFolder: folderPath }));
        }
        toast('Default Vault Folder saved: ' + folderPath);
        return;
      }
      if (page === 'conversion_vault_p3b_output.html' || page === 'conversion_vault_p3b_output_single.html') {
        window.__cvCustomOutDir = folderPath;
        const cLbl = document.getElementById('lbl-custom-path');
        if (cLbl) cLbl.textContent = folderPath.replace(/\/$/, '') + '/';
        const customOpt = document.querySelector('[data-mode="custom"], [data-loc="custom"]');
        if (customOpt) customOpt.click();
        toast('Custom folder set: ' + folderPath);
        return;
      }
      window.__customToolDir = folderPath;
      const dLbl = document.getElementById('lbl-dest-path');
      if (dLbl && typeof window.setCustomDestFromNative !== 'function') dLbl.textContent = folderPath + '/';
      if (typeof window.setCustomDestFromNative === 'function') window.setCustomDestFromNative(folderPath);
      return;
    }

    if (page === 'conversion_vault_t9_custom_module.html') {
      if (typeof window.onVaultCustomModuleFilesPicked === 'function') window.onVaultCustomModuleFilesPicked(files);
      return;
    }

    if (page === 'conversion_vault_p2b_multi_collector.html') {
      if (typeof window.setCollectedFromNative === 'function') window.setCollectedFromNative(getActiveFiles());
      const existing = getActiveFiles();
      const merged = existing.concat(files);
      setActiveFiles('multi', merged);
      if (typeof window.setCollectedFromNative === 'function') window.setCollectedFromNative(merged);
      toast('Added ' + files.length + ' files (' + merged.length + ' total)');
      return;
    }

    if (page === 'conversion_vault_p2_select.html') {
      if (!isPresetFlowMode() && window.VaultPresets) window.VaultPresets.clearPendingPreset();
      // Unified Collect & Drop: append Single, Multi, or Folder picks into ONE shared basket (deduped by path)
      const pending = (isPresetFlowMode() && window.VaultPresets) ? window.VaultPresets.getPendingPreset() : null;
      const reqCode = pending && pending.cat ? (pending.cat === 'audio' ? 'a' : (pending.cat === 'image' ? 'i' : 'v')) : null;
      const reqLabel = pending && pending.cat ? (pending.cat === 'audio' ? 'Audio' : (pending.cat === 'image' ? 'Photo' : 'Video')) : '';
      const catPlural = { v: 'Videos', a: 'Audios', i: 'Photos' };

      const existing = getActiveFiles().filter(f => !reqCode || classifyExt(f.name) === reqCode);
      const seenPaths = new Set(existing.map(x => x.path || x.name));
      let added = 0;
      let rejectedCount = 0;
      const rejectedCats = new Set();
      const merged = existing.slice();

      files.forEach(f => {
        const fc = classifyExt(f.name);
        if (!fc) return;
        if (reqCode && fc !== reqCode) {
          rejectedCount++;
          rejectedCats.add(catPlural[fc] || 'Other files');
          return;
        }
        const key = f.path || f.name;
        if (!seenPaths.has(key)) {
          seenPaths.add(key);
          merged.push(f);
          added++;
        }
      });

      setActiveFiles(merged.length > 1 ? 'multi' : 'single', merged);
      if (typeof window.renderUnifiedPickBasket === 'function') {
        window.renderUnifiedPickBasket();
      }

      const warnEl = document.getElementById('pending-preset-warn');
      if (rejectedCount > 0 && reqCode) {
        const rejStr = Array.from(rejectedCats).join(' and ');
        const msg = merged.length === 0
          ? (rejStr + ' are invalid for this ' + reqLabel + ' preset. No ' + reqLabel.toLowerCase() + ' file is selected.')
          : (rejStr + ' are invalid for this ' + reqLabel + ' preset (removed). Kept ' + merged.length + ' ' + reqLabel.toLowerCase() + ' file' + (merged.length === 1 ? '' : 's') + '.');
        if (warnEl) { warnEl.textContent = '⚠ ' + msg; warnEl.classList.remove('hidden'); }
        toast(msg);
      } else {
        if (warnEl) warnEl.classList.add('hidden');
        toast(added > 0 ? ('Added ' + added + (added === 1 ? ' file' : ' files') + ' (' + merged.length + ' total)') : ('Already in list (' + merged.length + ' total)'));
      }
      return;
    }

    setActiveFiles(mode, files);

    if (files.length > 0) {
      probeAndHydrateSingleFile(files[0]);
      syncEmptyFileState(page);
      toast('Loaded: ' + files[0].name);
    }
  };

  window.onVaultEvent = function (ev) {
    if (!ev) return;
    if (currentPage() === 'conversion_vault_p5_queue_history.html') {
      const nowEv = Date.now();
      if (ev.type !== 'job_progress' || !window.__cvLastQhEv || (nowEv - window.__cvLastQhEv) > 480) {
        window.__cvLastQhEv = nowEv;
        renderNativeJobs();
      }
    }
    if (typeof window.onLiveEngineEvent === 'function') {
      window.onLiveEngineEvent(ev);
    }
    if (ev.type === 'job_done') toast('Conversion completed!');
    if (ev.type === 'job_failed') toast('Job failed — check log in Queue');
  };

  function renderNativeJobs() {
    if (typeof window.refreshVaultQueueHistory === 'function') {
      window.refreshVaultQueueHistory();
    }
  }

  function enqueueSimpleToolJob(moduleName, mediaType, ext, commandArgs, baseNameOverride) {
    const files = getActiveFiles();
    if (!files.length) {
      toast('Pick a file first');
      if (hasBridge) window.AndroidBridge.pickFile();
      return;
    }
    if (!hasBridge) {
      toast('Native engine runs inside Android APK');
      return;
    }
    const probe = JSON.parse(safeGet('cv_last_probe', '{}') || '{}');
    const res = JSON.parse(window.AndroidBridge.enqueueJob(JSON.stringify({
      module: moduleName,
      mediaType: mediaType,
      inputPath: files[0].path,
      outputBaseName: baseNameOverride || '',
      outputExt: ext,
      durationMs: Math.round((probe.durationSec || 0) * 1000),
      commandArgs: commandArgs
    })));
    if (res && res.ok) {
      safeSet('cv_batch_job_ids', '[]');
      if (res.jobId) safeSet('cv_active_job_id', res.jobId);
      clearActiveSelection();
      const targetUrl = moduleName === 'Integrity_Repair'
        ? 'conversion_vault_p4a_convert_single.html?mode=recover'
        : 'conversion_vault_p4a_convert_single.html';
      navigateTo(targetUrl);
    } else {
      toast('Engine error: ' + ((res && res.error) || 'Failed to queue'));
    }
  }

  function wireBackButtons(page) {
    const backMap = {
      'conversion_vault_p2_select.html': 'conversion_vault_p1_home.html',
      'conversion_vault_t9_custom_module.html': 'conversion_vault_p1_home.html',
      'conversion_vault_p2a_single.html': 'conversion_vault_p2_select.html',
      'conversion_vault_p2b_multi_collector.html': 'conversion_vault_p2_select.html',
      'conversion_vault_p3_batch.html': 'conversion_vault_p2_select.html',
      'conversion_vault_p3b_output.html': 'conversion_vault_p3_batch.html',
      'conversion_vault_p3b_output_single.html': 'conversion_vault_p2a_single.html',
      'conversion_vault_p4_convert_batch.html': 'conversion_vault_p3b_output.html',
      'conversion_vault_p4a_convert_single.html': 'conversion_vault_p3b_output_single.html',
      'conversion_vault_p8_playback_tester.html': (window.location.search.includes('from=suggestor') ? 'conversion_vault_t7_suggestor.html' : 'conversion_vault_p1_home.html')
    };
    const defaultBack = page.startsWith('conversion_vault_t') ? 'conversion_vault_p1_home.html' : (backMap[page] || 'conversion_vault_p1_home.html');

    ['btn-back-home', 'btn-back', 'btn-top-back', 'btn-foot-back', 'btn-back-files'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          if (defaultBack === 'conversion_vault_p1_home.html') { clearActiveSelection(); if (window.VaultPresets) window.VaultPresets.clearPendingPreset(); }
          navigateTo(defaultBack);
        }, true);
      }
    });
    document.querySelectorAll('.back-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        if (defaultBack === 'conversion_vault_p1_home.html') { clearActiveSelection(); if (window.VaultPresets) window.VaultPresets.clearPendingPreset(); }
        navigateTo(defaultBack);
      }, true);
    });
  }


  function syncEmptyFileState(page) {
    const needsFilePages = [
      'conversion_vault_p2a_single.html',
      'conversion_vault_t1_metadata.html',
      'conversion_vault_t2_compressor.html',
      'conversion_vault_t3_audio.html',
      'conversion_vault_t4_inspector.html',
      'conversion_vault_t5_trim_gif.html',
      'conversion_vault_t6_thumbnail.html',
      'conversion_vault_t8_integrity.html'
    ];
    if (!needsFilePages.includes(page)) return;
    const hasFile = getActiveFiles().length > 0;
    const lbl = document.getElementById('lbl-fname');
    if (!hasFile && lbl) lbl.textContent = 'No file selected';
    const fmeta = document.getElementById('lbl-fmeta');
    if (!hasFile && fmeta) fmeta.textContent = 'Tap Pick File to choose a media file';
    if (!hasFile) {
      document.querySelectorAll('.info-cell .info-v').forEach(v => {
        if (v.id !== 'perf-size' && v.id !== 'perf-res') v.textContent = '—';
      });
    }
    document.querySelectorAll('main .card, main section').forEach((sec, idx) => {
      if (idx === 0 || sec.querySelector('#btn-pick')) return;
      sec.classList.toggle('cv-dimmed', !hasFile);
    });
  }

  function wirePage(page) {
    if (page === 'conversion_vault_p1_home.html') {
      clearActiveSelection();
    }
    wireBackButtons(page);
    syncEmptyFileState(page);

    const activeFiles = getActiveFiles();
    if (activeFiles.length > 0 && page !== 'conversion_vault_p1_home.html' && page !== 'conversion_vault_p2_select.html' && page !== 'conversion_vault_p2a_single.html' && page !== 'conversion_vault_p3_batch.html') {
      probeAndHydrateSingleFile(activeFiles[0]);
    }

    if (page === 'conversion_vault_p2_select.html') {
      let pickSortMode = 'added';
      let pickSearchQuery = '';
      let pickSearchOpen = false;
      const sortPickedFiles = (arr) => {
        const list = (arr || []).slice();
        if (pickSortMode === 'name_asc') list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
        else if (pickSortMode === 'name_desc') list.sort((a, b) => String(b.name || '').localeCompare(String(a.name || ''), undefined, { sensitivity: 'base' }));
        else if (pickSortMode === 'size_desc') list.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
        else if (pickSortMode === 'size_asc') list.sort((a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0));
        return list;
      };

      const renderUnifiedPickBasket = () => {
        const raw = getActiveFiles();
        const sorted = sortPickedFiles(raw);
        const card = document.getElementById('picked-box') || document.getElementById('picked-card');
        const listEl = document.getElementById('picked-files-list');
        const sortRow = document.getElementById('picked-sort-row');
        const btnCont = document.getElementById('btn-continue');
        const ctaStatus = document.getElementById('cta-status');

        if (!sorted.length) {
          if (card) card.classList.add('hidden');
          if (sortRow) sortRow.classList.add('hidden');
          if (listEl) listEl.innerHTML = '';
          if (btnCont) btnCont.disabled = true;
          if (ctaStatus) ctaStatus.textContent = 'No source selected';
          return;
        }

        const counts = { v: 0, a: 0, i: 0 };
        let totalBytes = 0;
        sorted.forEach(f => {
          const c = classifyExt(f.name);
          if (c) counts[c]++;
          totalBytes += (f.sizeBytes || 0);
        });
        const mb = (totalBytes / (1024 * 1024)).toFixed(2);
        if (typeof window.showSelection === 'function') {
          if (sorted.length === 1) {
            const f = sorted[0];
            const ext = (f.name.split('.').pop() || 'FILE').toUpperCase();
            window.showSelection('single', f.name, ext + ' · ' + mb + ' MB · Tap cards above to add more files', counts);
          } else {
            window.showSelection('multi', sorted.length + ' Collected Files Ready', 'Total Size: ' + mb + ' MB · Tap cards above to add more', counts);
          }
        }
        if (sortRow) sortRow.classList.toggle('hidden', sorted.length <= 1);
        if (ctaStatus) ctaStatus.textContent = sorted.length + (sorted.length === 1 ? ' file ready' : ' files ready');
        if (btnCont) btnCont.disabled = false;

        if (listEl) {
          const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          if (!window.__pickCatOpen) window.__pickCatOpen = { v: true, a: true, i: true };
          // Hide any category with 0 files completely (never show 0-count pills or empty toggles)
          [['cnt-v', counts.v], ['cnt-a', counts.a], ['cnt-i', counts.i]].forEach(([id, val]) => {
            const el = document.getElementById(id);
            const pill = el && el.closest('.bpill');
            if (pill) pill.style.display = val > 0 ? '' : 'none';
          });
          const qLow = String(pickSearchQuery || '').trim().toLowerCase();
          const filtered = qLow ? sorted.filter(f => String(f.name || '').toLowerCase().includes(qLow)) : sorted;
          const groups = [
            { key: 'v', label: 'Videos', color: '#38bdf8', items: filtered.filter(f => classifyExt(f.name) === 'v') },
            { key: 'a', label: 'Audios', color: 'var(--emerald)', items: filtered.filter(f => classifyExt(f.name) === 'a') },
            { key: 'i', label: 'Photos', color: 'var(--gold-text)', items: filtered.filter(f => classifyExt(f.name) === 'i') }
          ].filter(g => g.items.length > 0);
          if (qLow && groups.length === 0) {
            listEl.innerHTML = '<div style="padding:12px; text-align:center; font-size:12px; color:var(--muted); border:1px dashed var(--border); border-radius:8px;">No queued files match &ldquo;' + esc(pickSearchQuery.trim()) + '&rdquo;</div>';
            return;
          }
          listEl.innerHTML = groups.map(g => {
            const isOpen = qLow ? true : !!window.__pickCatOpen[g.key];
            const rowsHtml = (isOpen && g.items.length > 0) ? g.items.map(f => {
              const sz = f.sizeBytes ? (f.sizeBytes < 1024 * 1024 ? (f.sizeBytes / 1024).toFixed(0) + ' KB' : (f.sizeBytes / (1024 * 1024)).toFixed(2) + ' MB') : '—';
              const key = esc(f.path || f.name);
              return '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 8px; border-radius:7px; border:1px solid var(--border); background:var(--card);">' +
                '<div style="min-width:0;">' +
                  '<div style="font-size:11.5px; font-weight:700; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(f.name) + '</div>' +
                  '<div style="font-size:10px; font-family:var(--mono); color:var(--muted);">' + sz + '</div>' +
                '</div>' +
                '<button type="button" data-rm-pick="' + key + '" style="border:none; background:transparent; color:var(--crimson); font-size:15px; font-weight:800; padding:2px 6px; cursor:pointer;" aria-label="Remove file">×</button>' +
              '</div>';
            }).join('') : '';
            const emptyHint = (isOpen && g.items.length === 0)
              ? '<div style="font-size:10.5px; color:var(--muted); padding:4px 6px;">No ' + g.label.toLowerCase() + ' added yet</div>'
              : '';
            return '<div style="flex-shrink:0; border:1px solid var(--border); border-radius:8px; background:var(--surface);">' +
              '<button type="button" data-tgl-pick-cat="' + g.key + '" style="width:100%; display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border:none; background:transparent; color:var(--text); font-size:12px; font-weight:800; cursor:pointer;">' +
                '<span style="color:' + g.color + ';">' + g.label + ' (' + g.items.length + ')</span>' +
                '<span style="font-size:11px; color:var(--muted);">' + (isOpen ? '▴' : '▾') + '</span>' +
              '</button>' +
              (isOpen ? ('<div style="display:flex; flex-direction:column; gap:5px; padding:0 8px 8px;">' + rowsHtml + emptyHint + '</div>') : '') +
            '</div>';
          }).join('');
        }
      };
      window.renderUnifiedPickBasket = renderUnifiedPickBasket;

      const bind = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', (e) => {
          if (!hasBridge) return;
          e.preventDefault(); e.stopImmediatePropagation();
          fn();
        }, true);
      };
      bind('card-single', () => window.AndroidBridge.pickFile());
      bind('card-multi', () => window.AndroidBridge.pickMultipleFiles());
      bind('card-folder', () => window.AndroidBridge.pickFolder());

      const selPickSort = document.getElementById('sel-pick-sort');
      if (selPickSort) {
        selPickSort.addEventListener('change', () => {
          pickSortMode = selPickSort.value || 'added';
          const sorted = sortPickedFiles(getActiveFiles());
          setActiveFiles(sorted.length > 1 ? 'multi' : 'single', sorted);
          renderUnifiedPickBasket();
        });
      }

      const btnPickSearchToggle = document.getElementById('btn-pick-search-toggle');
      const pickSearchWrap = document.getElementById('picked-search-wrap');
      const inpPickSearch = document.getElementById('inp-pick-search');
      const btnPickSearchClear = document.getElementById('btn-pick-search-clear');
      if (btnPickSearchToggle && pickSearchWrap && inpPickSearch) {
        btnPickSearchToggle.addEventListener('click', () => {
          pickSearchOpen = !pickSearchOpen;
          pickSearchWrap.classList.toggle('hidden', !pickSearchOpen);
          btnPickSearchToggle.style.borderColor = pickSearchOpen ? 'var(--crimson)' : 'var(--border)';
          btnPickSearchToggle.style.color = pickSearchOpen ? 'var(--crimson)' : 'var(--text)';
          if (pickSearchOpen) {
            inpPickSearch.focus();
          } else if (pickSearchQuery) {
            pickSearchQuery = '';
            inpPickSearch.value = '';
            if (btnPickSearchClear) btnPickSearchClear.classList.add('hidden');
            renderUnifiedPickBasket();
          }
        });
        inpPickSearch.addEventListener('input', () => {
          pickSearchQuery = inpPickSearch.value || '';
          if (btnPickSearchClear) btnPickSearchClear.classList.toggle('hidden', !pickSearchQuery.trim());
          renderUnifiedPickBasket();
        });
        if (btnPickSearchClear) {
          btnPickSearchClear.addEventListener('click', () => {
            pickSearchQuery = '';
            inpPickSearch.value = '';
            btnPickSearchClear.classList.add('hidden');
            renderUnifiedPickBasket();
            inpPickSearch.focus();
          });
        }
      }

      const btnClearPick = document.getElementById('btn-clear-pick');
      if (btnClearPick) {
        btnClearPick.addEventListener('click', () => {
          pickSearchQuery = '';
          pickSearchOpen = false;
          if (inpPickSearch) inpPickSearch.value = '';
          if (pickSearchWrap) pickSearchWrap.classList.add('hidden');
          if (btnPickSearchClear) btnPickSearchClear.classList.add('hidden');
          if (btnPickSearchToggle) { btnPickSearchToggle.style.borderColor = 'var(--border)'; btnPickSearchToggle.style.color = 'var(--text)'; }
          setActiveFiles('single', []);
          renderUnifiedPickBasket();
          toast('Cleared collected files');
        }, true);
      }

      document.addEventListener('click', (e) => {
        const tgl = e.target.closest('[data-tgl-pick-cat]');
        if (tgl) {
          const k = tgl.getAttribute('data-tgl-pick-cat');
          if (!window.__pickCatOpen) window.__pickCatOpen = { v: true, a: true, i: true };
          window.__pickCatOpen[k] = !window.__pickCatOpen[k];
          renderUnifiedPickBasket();
          return;
        }
        const rm = e.target.closest('[data-rm-pick]');
        if (!rm) return;
        const key = rm.getAttribute('data-rm-pick');
        const next = getActiveFiles().filter(f => (f.path || f.name) !== key);
        setActiveFiles(next.length > 1 ? 'multi' : 'single', next);
        renderUnifiedPickBasket();
      });

      const btnCont = document.getElementById('btn-continue');
      if (btnCont) btnCont.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        let sorted = sortPickedFiles(getActiveFiles());
        const pending = (isPresetFlowMode() && window.VaultPresets) ? window.VaultPresets.getPendingPreset() : null;
        if (pending && pending.cat) {
          const reqCode = pending.cat === 'audio' ? 'a' : (pending.cat === 'image' ? 'i' : 'v');
          const reqLabel = pending.cat === 'audio' ? 'Audio' : (pending.cat === 'image' ? 'Photo' : 'Video');
          const validOnly = sorted.filter(f => classifyExt(f.name) === reqCode);
          const warnEl = document.getElementById('pending-preset-warn');
          if (validOnly.length !== sorted.length) {
            sorted = validOnly;
            setActiveFiles(sorted.length > 1 ? 'multi' : 'single', sorted);
            renderUnifiedPickBasket();
          }
          if (!sorted.length) {
            const msg = 'No ' + reqLabel.toLowerCase() + ' file is selected — please select at least one ' + reqLabel.toLowerCase() + ' file for this preset.';
            if (warnEl) { warnEl.textContent = '⚠ ' + msg; warnEl.classList.remove('hidden'); }
            toast(msg);
            return;
          }
          if (warnEl) warnEl.classList.add('hidden');
        }
        if (!sorted.length) { toast('Add at least one file first'); return; }
        setActiveFiles(sorted.length > 1 ? 'multi' : 'single', sorted);
        if (isWorkflowFlowMode() && getPendingWorkflow()) {
          navigateTo('conversion_vault_p3_batch.html?mode=workflow');
          return;
        }
        const qSuffix = (isPresetFlowMode() && pending && pending.cat) ? '?mode=preset' : '';
        if (sorted.length === 1) navigateTo('conversion_vault_p2a_single.html' + qSuffix);
        else navigateTo('conversion_vault_p3_batch.html' + qSuffix);
      }, true);

      // Wire Workflow Launcher Card (normal mode) vs Active Workflow Banner (?mode=workflow)
      const wfModeActive = isWorkflowFlowMode();
      if (!wfModeActive) clearPendingWorkflow();
      const activeWf = wfModeActive ? getPendingWorkflow() : null;
      const wfBanner = document.getElementById('active-workflow-banner');
      const wfLauncherWrap = document.getElementById('workflow-launcher-wrap');
      if (activeWf && wfBanner) {
        if (wfLauncherWrap) wfLauncherWrap.classList.add('hidden');
        wfBanner.classList.remove('hidden');
        const bt = document.getElementById('wf-banner-title');
        const br = document.getElementById('wf-banner-routes');
        if (bt) bt.textContent = 'Workflow: ' + activeWf.name;
        if (br) {
          const vDir = (activeWf.video && activeWf.video.outputDir) || 'Vault_Core/Videos';
          const aDir = (activeWf.audio && activeWf.audio.outputDir) || 'Vault_Core/Audios';
          const iDir = (activeWf.image && activeWf.image.outputDir) || 'Vault_Core/Images';
          br.textContent = 'Video → ' + vDir + ' · Audio → ' + aDir + ' · Image → ' + iDir + ' (Select files below, then press Continue)';
        }
        const exitBtn = document.getElementById('btn-wf-exit');
        if (exitBtn) exitBtn.addEventListener('click', () => {
          clearPendingWorkflow();
          navigateTo('conversion_vault_p2_select.html');
        });
      } else if (wfLauncherWrap) {
        if (isPresetFlowMode()) {
          wfLauncherWrap.classList.add('hidden');
        } else {
          const savedWfs = getSavedWorkflows();
          const selWf = document.getElementById('sel-quick-workflow');
          const btnLaunch = document.getElementById('btn-launch-workflow');
          const btnGoto = document.getElementById('btn-goto-workflows');
          if (savedWfs.length > 0 && selWf && btnLaunch) {
            selWf.innerHTML = '<option value="" selected>— Select a Workflow (None) —</option>' +
              savedWfs.map(w => '<option value="' + w.id.replace(/"/g, '&quot;') + '">' + String(w.name || 'Workflow').replace(/</g, '&lt;') + '</option>').join('');
            selWf.value = '';
            selWf.classList.remove('hidden');
            btnLaunch.classList.remove('hidden');
            btnLaunch.disabled = true;
            if (btnGoto) btnGoto.classList.add('hidden');
            const cardEl = document.getElementById('workflow-launcher-card');
            const badgeEl = document.getElementById('wf-launcher-badge');
            selWf.addEventListener('change', () => {
              const hasPick = !!selWf.value;
              btnLaunch.disabled = !hasPick;
              if (cardEl) cardEl.classList.toggle('is-picked', hasPick);
              if (badgeEl) badgeEl.textContent = hasPick ? 'Workflow Selected · Ready to Launch' : 'Optional · No Workflow Selected';
            });
            btnLaunch.addEventListener('click', () => {
              if (!selWf.value) { toast('Choose a workflow first'); return; }
              const picked = savedWfs.find(w => w.id === selWf.value);
              if (!picked) return;
              safeSet('cv_pending_workflow', JSON.stringify(picked));
              if (window.VaultPresets) window.VaultPresets.clearPendingPreset();
              navigateTo('conversion_vault_p2_select.html?mode=workflow');
            });
          } else if (btnGoto) {
            btnGoto.addEventListener('click', () => navigateTo('conversion_vault_p9_workflows.html'));
          }
        }
      }

      renderUnifiedPickBasket();
    }

    if (page === 'conversion_vault_p2b_multi_collector.html') {
      const bFiles = document.getElementById('btn-add-files');
      const bFolder = document.getElementById('btn-add-folder');
      const bNext = document.getElementById('btn-next-workspace');
      if (bFiles) bFiles.addEventListener('click', (e) => { if (hasBridge) { e.preventDefault(); e.stopImmediatePropagation(); window.AndroidBridge.pickMultipleFiles(); } }, true);
      if (bFolder) bFolder.addEventListener('click', (e) => { if (hasBridge) { e.preventDefault(); e.stopImmediatePropagation(); window.AndroidBridge.pickFolder(); } }, true);
      if (bNext) bNext.addEventListener('click', (e) => { e.preventDefault(); e.stopImmediatePropagation(); navigateTo('conversion_vault_p3_batch.html'); }, true);
    }

    if (page === 'conversion_vault_p2a_single.html') {
      const activeFiles = getActiveFiles();
      const firstFile = activeFiles[0];
      const fileCat = firstFile ? classifyExt(firstFile.name) : 'v';
      let singlePhotoCfg = null;
      let singleAudioCfg = null;
      let photoTouched = false;
      let audioTouched = false;
      window.__cvSingleMediaMode = fileCat;

      const getRoomPresetsForCat = (targetCat) => {
        if (!hasBridge || typeof window.AndroidBridge.getPresets !== 'function') return [];
        try {
          const all = JSON.parse(window.AndroidBridge.getPresets(false) || '[]');
          return all.filter(p => {
            const c = String(p.category || 'Video').toLowerCase();
            if (targetCat === 'image') return c.includes('ima');
            if (targetCat === 'audio') return c.includes('aud');
            return !c.includes('ima') && !c.includes('aud');
          }).map(p => {
            let parsed = {};
            try { parsed = JSON.parse(p.extraFlags || '{}'); } catch (_) {}
            return { raw: p, parsed };
          });
        } catch (_) { return []; }
      };

      const presetBox = document.getElementById('main-preset-box');
      const perfSec = document.getElementById('sec-perf');

      const resetUntouchedMainUI = () => {
        if (perfSec) perfSec.classList.add('is-untouched');
        const stPill = document.getElementById('fmt-status-pill');
        if (stPill) stPill.textContent = 'Not Selected';
        const tEl = document.getElementById('perf-time');
        const fEl = document.getElementById('perf-fps');
        const sEl = document.getElementById('perf-size');
        const rEl = document.getElementById('perf-res');
        if (tEl) tEl.textContent = '—';
        if (fEl) fEl.textContent = 'Select format above';
        if (sEl) sEl.textContent = '—';
        if (rEl) rEl.textContent = '—';
        const footT = document.getElementById('foot-title');
        const footS = document.getElementById('foot-sub');
        if (footT) footT.textContent = 'No format selected';
        if (footS) footS.textContent = 'Choose a format in Section 2 first';
        const mvBtn = document.getElementById('btn-move-convert');
        if (mvBtn) mvBtn.disabled = true;
      };

      if (fileCat === 'i') {
        // PHOTO MODE: start in neutral dark untouched state until user chooses a format or preset
        if (presetBox) presetBox.style.display = 'none';
        if (perfSec) {
          perfSec.classList.add('is-untouched');
          perfSec.querySelectorAll('.field, #core-cmd-pill, #core-warn-note').forEach(el => { el.style.display = 'none'; });
        }
        const badgeEl = document.querySelector('.single-badge');
        if (badgeEl) badgeEl.textContent = 'PHOTO';
        singlePhotoCfg = { format: '', quality: 88, scale: 'original', orient: 'auto', meta: 'wipe', colorSpace: 'srgb_444', crop: 'original', filter: 'none', brightness: 0 };

        if (presetBox && !document.getElementById('native-photo-single-card')) {
          const card = document.createElement('div');
          card.id = 'native-photo-single-card';
          card.style.cssText = 'padding:12px; border-radius:12px; border:1px solid var(--border); background:var(--card-elev); display:flex; flex-direction:column; gap:10px; transition:border-color 0.2s ease, background 0.2s ease;';
          card.innerHTML =
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
              '<span id="sp-card-title" style="font-size:12px; font-weight:800; color:var(--muted);">Native Photo Engine (Skia + Exif + Heif)</span>' +
              '<span id="sp-card-badge" style="font-size:10px; font-family:var(--mono); color:var(--subtle);">NOT SELECTED</span>' +
            '</div>' +
            '<button type="button" id="btn-sp-toggle-presets" style="width:100%; display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--surface); color:var(--muted); font-size:12px; font-weight:700; cursor:pointer;"><span id="lbl-sp-presets-cnt">Presets</span><span id="lbl-sp-presets-arrow">▾</span></button>' +
            '<div id="sp-saved-presets-wrap" style="display:none; flex-wrap:wrap; gap:6px;"></div>' +
            '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Output Format</label>' +
              '<select id="sp-fmt" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                '<option value="" selected>— Select Photo Format —</option>' +
                '<option value="webp">.webp (Modern)</option>' +
                '<option value="jpg">.jpg (Universal)</option>' +
                '<option value="png">.png (Lossless)</option>' +
                '<option value="heic">.heic (HEIF High-Eff)</option>' +
                '<option value="avif">.avif (Ultra Small)</option>' +
              '</select></div>' +
            '<div id="sp-controls-wrap" class="is-untouched" style="display:flex; flex-direction:column; gap:10px;">' +
              '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Max Width Scale</label>' +
                  '<select id="sp-scale" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="original" selected>Keep Original</option>' +
                    '<option value="3840">3840 px (4K)</option>' +
                    '<option value="1920">1920 px</option>' +
                    '<option value="1080">1080 px</option>' +
                    '<option value="720">720 px</option>' +
                  '</select></div>' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Orientation</label>' +
                  '<select id="sp-orient" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="auto" selected>Auto-Orient (EXIF)</option>' +
                    '<option value="keep">Keep Original</option>' +
                    '<option value="90cw">Rotate 90° CW</option>' +
                    '<option value="90ccw">Rotate 90° CCW</option>' +
                    '<option value="180">Rotate 180°</option>' +
                    '<option value="hflip">Flip Horizontal</option>' +
                    '<option value="vflip">Flip Vertical</option>' +
                  '</select></div>' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Aspect Crop</label>' +
                  '<select id="sp-crop" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="original" selected>Original (No Crop)</option>' +
                    '<option value="1:1">1:1 Square</option>' +
                    '<option value="4:5">4:5 Portrait</option>' +
                    '<option value="9:16">9:16 Vertical</option>' +
                    '<option value="16:9">16:9 Widescreen</option>' +
                    '<option value="3:2">3:2 Classic</option>' +
                  '</select></div>' +
                '<div style="grid-column:1/-1;"><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Color Filter</label>' +
                  '<select id="sp-filter" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="none" selected>Original</option>' +
                    '<option value="vivid">Vivid (+25% Sat)</option>' +
                    '<option value="contrast">Auto Contrast</option>' +
                    '<option value="warm">Warm Tone</option>' +
                    '<option value="cool">Cool Tone</option>' +
                    '<option value="grayscale">Grayscale (B&amp;W)</option>' +
                    '<option value="invert">Invert Colors</option>' +
                  '</select></div>' +
                '<div style="grid-column:1/-1;"><div style="display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:4px;"><span>Brightness</span><strong id="sp-bright-lbl" style="color:var(--text);">0</strong></div>' +
                  '<input type="range" id="sp-bright" min="-20" max="20" step="2" value="0" style="width:100%;"></div>' +
              '</div>' +
              '<div><div style="display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:4px;"><span>Image Quality</span><strong id="sp-qual-lbl" style="color:var(--text);">88%</strong></div>' +
                '<input type="range" id="sp-qual" min="15" max="100" value="88" style="width:100%;"></div>' +
              '<div style="padding:10px 11px; border-radius:10px; border:1px dashed rgba(16,185,129,0.55); background:rgba(16,185,129,0.08); display:flex; flex-direction:column; gap:6px;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; font-family:var(--mono); font-size:10px; font-weight:800; color:var(--emerald); text-transform:uppercase; letter-spacing:0.05em;"><span>Metadata Remover &amp; EXIF/GPS Privacy</span><span style="padding:2px 6px; border-radius:4px; background:rgba(16,185,129,0.16); border:1px solid rgba(16,185,129,0.35);">PRIVACY SHIELD</span></div>' +
                '<select id="sp-meta" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                  '<option value="wipe" selected>Wipe All EXIF &amp; GPS</option>' +
                  '<option value="deep">Forensic Scrub</option>' +
                  '<option value="gps">Strip GPS Only</option>' +
                  '<option value="keep">Keep EXIF</option>' +
                '</select>' +
              '</div>' +
              '<div style="display:flex; justify-content:flex-end;">' +
                '<button type="button" id="btn-sp-save-preset" disabled style="padding:6px 12px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); font-size:11.5px; font-weight:700; cursor:pointer;">+ Save Image Preset</button>' +
              '</div>' +
            '</div>';
          presetBox.parentNode.insertBefore(card, presetBox.nextSibling);

          const updatePhotoPerf = () => {
            if (!photoTouched || !singlePhotoCfg.format) {
              resetUntouchedMainUI();
              return;
            }
            if (perfSec) perfSec.classList.remove('is-untouched');
            let pInfo = {};
            try { pInfo = JSON.parse(safeGet('cv_last_probe', '{}') || '{}'); } catch (_) {}
            const bytes = pInfo.sizeBytes || (firstFile && firstFile.sizeBytes) || 0;
            const srcMB = bytes > 0 ? (bytes / (1024 * 1024)) : 0;
            const w = pInfo.width || 0;
            const h = pInfo.height || 0;
            const mp = (w > 0 && h > 0) ? ((w * h) / 1000000) : Math.max(1, srcMB * 3);
            const maxW = parseInt(singlePhotoCfg.scale, 10) || 0;
            const scaleArea = (maxW > 0 && w > maxW) ? Math.pow(maxW / w, 2) : 1.0;
            const outMp = mp * scaleArea;
            const fmt = singlePhotoCfg.format;
            const q = (singlePhotoCfg.quality || 88) / 100;
            const estSec = fmt === 'avif' ? Math.max(0.6, outMp * 0.22) : Math.max(0.12, outMp * 0.035);
            const estMB = fmt === 'png' ? Math.max(0.05, outMp * 0.95)
                        : (fmt === 'avif' ? Math.max(0.02, outMp * 0.09 * q)
                        : (fmt === 'heic' ? Math.max(0.02, outMp * 0.13 * q)
                        : (fmt === 'webp' ? Math.max(0.03, outMp * 0.16 * q)
                                          : Math.max(0.04, outMp * 0.28 * q))));
            const delta = srcMB > 0 ? Math.round(((estMB - srcMB) / srcMB) * 100) : 0;
            const sign = delta <= 0 ? delta + '%' : '+' + delta + '%';
            const ramMB = Math.max(24, Math.round((w > 0 && h > 0 ? (w * h * 4) / (1024 * 1024) : srcMB * 8) * 1.4));
            const tEl = document.getElementById('perf-time');
            const fEl = document.getElementById('perf-fps');
            const sEl = document.getElementById('perf-size');
            const rEl = document.getElementById('perf-res');
            if (tEl) tEl.textContent = estSec < 1 ? '<1s' : ('~' + estSec.toFixed(1) + 's');
            if (fEl) fEl.textContent = fmt === 'avif' ? 'FFmpeg AVIF · Single Pass' : ('Native Skia · ' + (w && h ? (w + '×' + h) : 'Full Res'));
            if (sEl) sEl.textContent = srcMB > 0 ? (srcMB.toFixed(2) + ' → ' + estMB.toFixed(2) + ' MB (' + sign + ')') : 'Probing size...';
            if (rEl) rEl.textContent = '~' + ramMB + ' MB RAM · <0.1% Batt';
          };

          const syncPhotoSummary = (fromUserInteraction) => {
            const fmtEl = document.getElementById('sp-fmt');
            if (fromUserInteraction) {
              if (!fmtEl.value) fmtEl.value = 'webp';
              photoTouched = !!fmtEl.value;
            }
            const ctrlWrap = document.getElementById('sp-controls-wrap');
            const titleEl = document.getElementById('sp-card-title');
            const badgeCard = document.getElementById('sp-card-badge');
            const tglBtn = document.getElementById('btn-sp-toggle-presets');
            const saveBtn = document.getElementById('btn-sp-save-preset');

            if (!photoTouched || !fmtEl.value) {
              card.style.borderColor = 'var(--border)';
              card.style.background = 'var(--card-elev)';
              if (titleEl) titleEl.style.color = 'var(--muted)';
              if (badgeCard) { badgeCard.textContent = 'NOT SELECTED'; badgeCard.style.color = 'var(--subtle)'; }
              if (tglBtn) tglBtn.style.color = 'var(--muted)';
              if (ctrlWrap) ctrlWrap.classList.add('is-untouched');
              if (saveBtn) saveBtn.disabled = true;
              resetUntouchedMainUI();
              return;
            }

            singlePhotoCfg.format = fmtEl.value;
            singlePhotoCfg.scale = document.getElementById('sp-scale').value;
            singlePhotoCfg.orient = document.getElementById('sp-orient').value;
            singlePhotoCfg.meta = document.getElementById('sp-meta').value;
            singlePhotoCfg.crop = document.getElementById('sp-crop').value;
            singlePhotoCfg.filter = document.getElementById('sp-filter').value;
            singlePhotoCfg.brightness = parseInt(document.getElementById('sp-bright').value, 10) || 0;
            singlePhotoCfg.quality = parseInt(document.getElementById('sp-qual').value, 10) || 88;

            card.style.borderColor = 'rgba(16,185,129,0.45)';
            card.style.background = 'rgba(16,185,129,0.06)';
            if (titleEl) titleEl.style.color = 'var(--emerald)';
            if (badgeCard) { badgeCard.textContent = 'PHOTO FORMAT'; badgeCard.style.color = 'var(--muted)'; }
            if (tglBtn) tglBtn.style.color = 'var(--text)';
            if (ctrlWrap) ctrlWrap.classList.remove('is-untouched');
            if (saveBtn) saveBtn.disabled = false;

            const bLbl = document.getElementById('sp-bright-lbl');
            if (bLbl) bLbl.textContent = singlePhotoCfg.brightness > 0 ? ('+' + singlePhotoCfg.brightness) : String(singlePhotoCfg.brightness);
            document.getElementById('sp-qual-lbl').textContent = singlePhotoCfg.format === 'png' ? 'Lossless' : (singlePhotoCfg.quality + '%');
            const stPill = document.getElementById('fmt-status-pill');
            const footT = document.getElementById('foot-title');
            const footS = document.getElementById('foot-sub');
            if (stPill) stPill.textContent = '.' + singlePhotoCfg.format.toUpperCase();
            if (footT) footT.textContent = 'Native Photo Engine Ready';
            if (footS) footS.textContent = '.' + singlePhotoCfg.format.toUpperCase() + (singlePhotoCfg.format === 'png' ? ' · Lossless' : (' · Q' + singlePhotoCfg.quality)) + ' · ' + singlePhotoCfg.meta;
            const mvBtn = document.getElementById('btn-move-convert');
            if (mvBtn) mvBtn.disabled = false;
            updatePhotoPerf();
          };
          window.refreshSinglePhotoAudioPerf = updatePhotoPerf;

          let spPresetsOpen = false;
          const BUILTIN_IMG_PRESETS = [
            { raw: { name: 'WebP Crisp 85%', container: 'webp', crfOrBitrate: '85' }, parsed: { cfg: { fmt: 'webp', qual: 85, scale: 'original', orient: 'auto', meta: 'wipe', crop: 'original', filter: 'none', brightness: 0 } } }
          ];
          const renderSavedImagePresets = () => {
            const wrap = document.getElementById('sp-saved-presets-wrap');
            const cntEl = document.getElementById('lbl-sp-presets-cnt');
            const arrEl = document.getElementById('lbl-sp-presets-arrow');
            if (!wrap) return;
            const merged = (window.VaultPresets && window.VaultPresets.hasBridge())
              ? window.VaultPresets.listActive('image')
              : getRoomPresetsForCat('image');
            if (cntEl) cntEl.textContent = 'Presets (' + merged.length + ')';
            if (arrEl) arrEl.textContent = spPresetsOpen ? '▴' : '▾';
            wrap.style.display = spPresetsOpen ? 'flex' : 'none';
            wrap.innerHTML = merged.map((s, i) =>
              '<button type="button" data-sp-saved="' + i + '" style="padding:6px 11px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); font-size:11.5px; font-weight:700; cursor:pointer;">' + s.raw.name.replace(/</g, '&lt;') + '</button>'
            ).join('');
            wrap.querySelectorAll('[data-sp-saved]').forEach(btn => {
              btn.addEventListener('click', () => {
                const s = merged[parseInt(btn.getAttribute('data-sp-saved'), 10)];
                if (!s) return;
                const c = s.parsed.cfg || {};
                const fmt = (c.fmt || c.format || s.raw.container || 'webp').replace(/^\./, '').toLowerCase();
                if (Array.from(document.getElementById('sp-fmt').options).some(o => o.value === fmt)) document.getElementById('sp-fmt').value = fmt;
                if (c.scale) document.getElementById('sp-scale').value = String(c.scale);
                if (c.orient) document.getElementById('sp-orient').value = String(c.orient);
                if (c.meta) document.getElementById('sp-meta').value = String(c.meta);
                if (c.crop) document.getElementById('sp-crop').value = String(c.crop);
                if (c.filter) document.getElementById('sp-filter').value = String(c.filter);
                if (typeof c.brightness !== 'undefined') document.getElementById('sp-bright').value = String(c.brightness);
                const q = parseInt(c.qual || c.quality || s.raw.crfOrBitrate, 10);
                if (q >= 15 && q <= 100) document.getElementById('sp-qual').value = String(q);
                spPresetsOpen = false;
                renderSavedImagePresets();
                syncPhotoSummary(true);
                toast('Applied preset: ' + s.raw.name);
              });
            });
          };
          const spTgl = document.getElementById('btn-sp-toggle-presets');
          if (spTgl) spTgl.addEventListener('click', () => {
            spPresetsOpen = !spPresetsOpen;
            renderSavedImagePresets();
          });

          document.getElementById('btn-sp-save-preset').addEventListener('click', () => {
            if (!photoTouched || !singlePhotoCfg.format) return;
            if (!hasBridge || typeof window.AndroidBridge.savePreset !== 'function') return;
            const nm = 'Photo ' + singlePhotoCfg.format.toUpperCase() + ' Q' + singlePhotoCfg.quality;
            const specs = '.' + singlePhotoCfg.format + ' · Q' + singlePhotoCfg.quality + ' · ' + singlePhotoCfg.scale + ' · ' + singlePhotoCfg.meta;
            window.AndroidBridge.savePreset(JSON.stringify({
              name: nm,
              category: 'Image',
              codec: singlePhotoCfg.format,
              container: singlePhotoCfg.format,
              crfOrBitrate: String(singlePhotoCfg.quality),
              extraFlags: JSON.stringify({ desc: 'Saved photo preset', specs, cfg: { fmt: singlePhotoCfg.format, qual: singlePhotoCfg.quality, scale: singlePhotoCfg.scale, orient: singlePhotoCfg.orient, meta: singlePhotoCfg.meta, crop: singlePhotoCfg.crop, filter: singlePhotoCfg.filter, brightness: singlePhotoCfg.brightness } })
            }));
            renderSavedImagePresets();
            toast('Saved "' + nm + '" ✓');
          });

          ['sp-fmt', 'sp-scale', 'sp-orient', 'sp-meta', 'sp-crop', 'sp-filter', 'sp-bright', 'sp-qual'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => syncPhotoSummary(true));
            if (el) el.addEventListener('change', () => syncPhotoSummary(true));
          });
          try {
            if (hasBridge && typeof window.AndroidBridge.getSettings === 'function') {
              const ds = JSON.parse(window.AndroidBridge.getSettings() || '{}');
              const pol = ds.defaultMetadataPolicy === 'forensic' ? 'deep' : (ds.defaultMetadataPolicy || 'wipe');
              const sm = document.getElementById('sp-meta');
              if (sm && Array.from(sm.options).some(o => o.value === pol)) sm.value = pol;
            }
          } catch (_) {}
          renderSavedImagePresets();
          let appliedPendingPhoto = false;
          if (window.VaultPresets && isPresetFlowMode()) {
            const p = window.VaultPresets.getPendingPreset();
            if (p && p.cat === 'image') {
              const c = p.cfg || {};
              const fmt = (c.fmt || c.format || p.container || 'webp').replace(/^\./, '').toLowerCase();
              const fmtEl = document.getElementById('sp-fmt');
              if (fmtEl && Array.from(fmtEl.options).some(o => o.value === fmt)) fmtEl.value = fmt;
              if (c.scale && document.getElementById('sp-scale')) document.getElementById('sp-scale').value = String(c.scale);
              if (c.orient && document.getElementById('sp-orient')) document.getElementById('sp-orient').value = String(c.orient);
              if (c.meta && document.getElementById('sp-meta')) document.getElementById('sp-meta').value = String(c.meta);
              if (c.crop && document.getElementById('sp-crop')) document.getElementById('sp-crop').value = String(c.crop);
              if (c.filter && document.getElementById('sp-filter')) document.getElementById('sp-filter').value = String(c.filter);
              if (typeof c.brightness !== 'undefined' && document.getElementById('sp-bright')) document.getElementById('sp-bright').value = String(c.brightness);
              const q = parseInt(c.qual || c.quality || p.crfOrBitrate, 10);
              if (q >= 15 && q <= 100 && document.getElementById('sp-qual')) document.getElementById('sp-qual').value = String(q);
              window.VaultPresets.clearPendingPreset();
              appliedPendingPhoto = true;
              const fmtCard = document.querySelector('section.s-format');
              if (fmtCard) fmtCard.classList.add('hidden');
              const spPresetWrap = document.getElementById('sp-saved-presets');
              if (spPresetWrap && spPresetWrap.parentElement) spPresetWrap.parentElement.style.display = 'none';
              if (perfSec) perfSec.querySelectorAll('.field').forEach(el => { if (el.querySelector('#sp-fmt')) el.style.display = 'none'; });
              const perfTitle = perfSec ? perfSec.querySelector('.sec-title') : null;
              if (perfTitle) perfTitle.textContent = '2. Device Performance · ' + p.name;
              syncPhotoSummary(true);
              toast('✓ Pre-applied preset: ' + p.name);
            }
          }
          if (!appliedPendingPhoto) syncPhotoSummary(false);
        }
      } else if (fileCat === 'a') {
        // AUDIO MODE: start in neutral dark untouched state until user chooses a format or preset
        if (presetBox) presetBox.style.display = 'none';
        if (perfSec) {
          perfSec.classList.add('is-untouched');
          perfSec.querySelectorAll('.field, #core-cmd-pill, #core-warn-note').forEach(el => { el.style.display = 'none'; });
        }
        const badgeEl = document.querySelector('.single-badge');
        if (badgeEl) badgeEl.textContent = 'AUDIO';
        singleAudioCfg = { fmt: '', br: '192k', ar: 'keep', ch: 'keep', filter: 'none', gain: '0dB', speed: '1.0', fade: 'none', trimStart: '00:00:00', trimEnd: 'End', meta: 'wipe' };

        if (presetBox && !document.getElementById('native-audio-single-card')) {
          const card = document.createElement('div');
          card.id = 'native-audio-single-card';
          card.style.cssText = 'padding:12px; border-radius:12px; border:1px solid var(--border); background:var(--card-elev); display:flex; flex-direction:column; gap:10px; transition:border-color 0.2s ease, background 0.2s ease;';
          card.innerHTML =
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
              '<span id="sa-card-title" style="font-size:12px; font-weight:800; color:var(--muted);">Audio Format &amp; Codec Selection</span>' +
              '<span id="sa-card-badge" style="font-size:10px; font-family:var(--mono); color:var(--subtle);">NOT SELECTED</span>' +
            '</div>' +
            '<button type="button" id="btn-sa-toggle-presets" style="width:100%; display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--surface); color:var(--muted); font-size:12px; font-weight:700; cursor:pointer;"><span id="lbl-sa-presets-cnt">Presets</span><span id="lbl-sa-presets-arrow">▾</span></button>' +
            '<div id="sa-saved-presets-wrap" style="display:none; flex-wrap:wrap; gap:6px;"></div>' +
            '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Audio Format</label>' +
              '<select id="sa-fmt" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                '<option value="" selected>— Select Audio Format —</option>' +
                '<option value="m4a">.m4a (AAC Universal)</option>' +
                '<option value="opus">.opus (High Efficiency)</option>' +
                '<option value="mp3">.mp3 (Classic)</option>' +
                '<option value="flac">.flac (Lossless)</option>' +
                '<option value="wav">.wav (Uncompressed)</option>' +
              '</select></div>' +
            '<div id="sa-controls-wrap" class="is-untouched" style="display:flex; flex-direction:column; gap:10px;">' +
              '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Bitrate</label>' +
                  '<select id="sa-br" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="96k">96 kbps (Compact)</option>' +
                    '<option value="128k">128 kbps</option>' +
                    '<option value="192k" selected>192 kbps (High)</option>' +
                    '<option value="256k">256 kbps</option>' +
                    '<option value="320k">320 kbps (Max)</option>' +
                  '</select></div>' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Sample Rate</label>' +
                  '<select id="sa-ar" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="keep" selected>Keep Source</option>' +
                    '<option value="48000">48,000 Hz</option>' +
                    '<option value="44100">44,100 Hz (CD)</option>' +
                  '</select></div>' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Channels</label>' +
                  '<select id="sa-ch" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="keep" selected>Keep Source</option>' +
                    '<option value="2">Stereo (2.0)</option>' +
                    '<option value="1">Mono (1.0)</option>' +
                  '</select></div>' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Audio Filter</label>' +
                  '<select id="sa-filter" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="none" selected>None</option>' +
                    '<option value="loudnorm">Loudnorm (-14 LUFS)</option>' +
                    '<option value="bass">Bass Boost (+5dB)</option>' +
                    '<option value="trim_silence">Trim Silence</option>' +
                  '</select></div>' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Volume Gain</label>' +
                  '<select id="sa-gain" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="-12dB">-12 dB (Quiet)</option>' +
                    '<option value="-6dB">-6 dB</option>' +
                    '<option value="-3dB">-3 dB</option>' +
                    '<option value="0dB" selected>0 dB (Original)</option>' +
                    '<option value="+3dB">+3 dB</option>' +
                    '<option value="+6dB">+6 dB (Louder)</option>' +
                    '<option value="+9dB">+9 dB</option>' +
                    '<option value="+12dB">+12 dB (Max Boost)</option>' +
                  '</select></div>' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Playback Speed</label>' +
                  '<select id="sa-speed" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="0.5">0.5x (Half Speed)</option>' +
                    '<option value="0.75">0.75x</option>' +
                    '<option value="1.0" selected>1.0x (Normal)</option>' +
                    '<option value="1.25">1.25x</option>' +
                    '<option value="1.5">1.5x</option>' +
                    '<option value="2.0">2.0x (Double)</option>' +
                  '</select></div>' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Fade In / Out</label>' +
                  '<select id="sa-fade" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                    '<option value="none" selected>None</option>' +
                    '<option value="in2">Fade In (2s)</option>' +
                    '<option value="out2">Fade Out (2s)</option>' +
                    '<option value="both2">Fade In &amp; Out (2s)</option>' +
                  '</select></div>' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Trim Start (HH:MM:SS)</label>' +
                  '<input type="text" id="sa-trim-start" value="00:00:00" placeholder="00:00:00" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px; font-family:var(--mono);"></div>' +
                '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Trim End (HH:MM:SS / End)</label>' +
                  '<input type="text" id="sa-trim-end" value="End" placeholder="End" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px; font-family:var(--mono);"></div>' +
                '<div id="sa-trim-err" style="grid-column:1/-1; display:none; font-size:11px; font-weight:700; color:var(--crimson);"></div>' +
              '</div>' +
              '<div style="padding:10px 11px; border-radius:10px; border:1px dashed rgba(16,185,129,0.55); background:rgba(16,185,129,0.08); display:flex; flex-direction:column; gap:6px;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; font-family:var(--mono); font-size:10px; font-weight:800; color:var(--emerald); text-transform:uppercase; letter-spacing:0.05em;"><span>Metadata Remover &amp; ID3 Privacy</span><span style="padding:2px 6px; border-radius:4px; background:rgba(16,185,129,0.16); border:1px solid rgba(16,185,129,0.35);">PRIVACY SHIELD</span></div>' +
                '<select id="sa-meta" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                  '<option value="wipe" selected>Wipe All Tags (-map_metadata -1)</option>' +
                  '<option value="deep">Forensic Scrub (+bitexact &amp; Encoder)</option>' +
                  '<option value="keep">Keep All Tags</option>' +
                '</select>' +
              '</div>' +
              '<div style="display:flex; justify-content:flex-end;">' +
                '<button type="button" id="btn-sa-save-preset" disabled style="padding:6px 12px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); font-size:11.5px; font-weight:700; cursor:pointer;">+ Save Audio Preset</button>' +
              '</div>' +
            '</div>';
          presetBox.parentNode.insertBefore(card, presetBox.nextSibling);

          const updateAudioPerf = () => {
            if (!audioTouched || !singleAudioCfg.fmt) {
              resetUntouchedMainUI();
              return;
            }
            if (perfSec) perfSec.classList.remove('is-untouched');
            let pInfo = {};
            try { pInfo = JSON.parse(safeGet('cv_last_probe', '{}') || '{}'); } catch (_) {}
            const bytes = pInfo.sizeBytes || (firstFile && firstFile.sizeBytes) || 0;
            const srcMB = bytes > 0 ? (bytes / (1024 * 1024)) : 0;
            const durSec = pInfo.durationSec || (srcMB > 0 ? (srcMB * 8000) / 192 : 0);
            const fmt = singleAudioCfg.fmt;
            const brKbps = fmt === 'flac' ? 850 : (fmt === 'wav' ? 1411 : (parseInt(singleAudioCfg.br, 10) || 192));
            const estMB = durSec > 0 ? Math.max(0.05, (brKbps * durSec) / 8000) : srcMB;
            const estSec = durSec > 0 ? Math.max(0.25, durSec / 120) : 0.5;
            const delta = srcMB > 0 ? Math.round(((estMB - srcMB) / srcMB) * 100) : 0;
            const sign = delta <= 0 ? delta + '%' : '+' + delta + '%';
            const tEl = document.getElementById('perf-time');
            const fEl = document.getElementById('perf-fps');
            const sEl = document.getElementById('perf-size');
            const rEl = document.getElementById('perf-res');
            if (tEl) tEl.textContent = estSec < 1 ? '<1s' : ('~' + estSec.toFixed(1) + 's');
            if (fEl) fEl.textContent = '~120x RT · ' + (durSec > 0 ? Math.round(durSec) + 's audio' : 'Audio');
            if (sEl) sEl.textContent = srcMB > 0 ? (srcMB.toFixed(2) + ' → ' + estMB.toFixed(2) + ' MB (' + sign + ')') : 'Probing size...';
            if (rEl) rEl.textContent = '~65 MB RAM · <0.1% Batt';
          };

          const syncAudioSummary = (fromUserInteraction) => {
            const fmtEl = document.getElementById('sa-fmt');
            if (fromUserInteraction) {
              if (!fmtEl.value) fmtEl.value = 'm4a';
              audioTouched = !!fmtEl.value;
            }
            const ctrlWrap = document.getElementById('sa-controls-wrap');
            const titleEl = document.getElementById('sa-card-title');
            const badgeCard = document.getElementById('sa-card-badge');
            const tglBtn = document.getElementById('btn-sa-toggle-presets');
            const saveBtn = document.getElementById('btn-sa-save-preset');

            if (!audioTouched || !fmtEl.value) {
              card.style.borderColor = 'var(--border)';
              card.style.background = 'var(--card-elev)';
              if (titleEl) titleEl.style.color = 'var(--muted)';
              if (badgeCard) { badgeCard.textContent = 'NOT SELECTED'; badgeCard.style.color = 'var(--subtle)'; }
              if (tglBtn) tglBtn.style.color = 'var(--muted)';
              if (ctrlWrap) ctrlWrap.classList.add('is-untouched');
              if (saveBtn) saveBtn.disabled = true;
              resetUntouchedMainUI();
              return;
            }

            singleAudioCfg.fmt = fmtEl.value;
            singleAudioCfg.br = document.getElementById('sa-br').value;
            singleAudioCfg.ar = document.getElementById('sa-ar').value;
            singleAudioCfg.ch = document.getElementById('sa-ch').value;
            singleAudioCfg.filter = document.getElementById('sa-filter').value;
            singleAudioCfg.gain = document.getElementById('sa-gain').value;
            singleAudioCfg.speed = document.getElementById('sa-speed').value;
            singleAudioCfg.fade = document.getElementById('sa-fade').value;
            singleAudioCfg.trimStart = (document.getElementById('sa-trim-start').value || '00:00:00').trim();
            singleAudioCfg.trimEnd = (document.getElementById('sa-trim-end').value || 'End').trim();
            singleAudioCfg.meta = document.getElementById('sa-meta').value;

            card.style.borderColor = 'rgba(252,215,0,0.45)';
            card.style.background = 'rgba(252,215,0,0.06)';
            if (titleEl) titleEl.style.color = 'var(--gold-text)';
            if (badgeCard) { badgeCard.textContent = 'AUDIO MODE'; badgeCard.style.color = 'var(--muted)'; }
            if (tglBtn) tglBtn.style.color = 'var(--text)';
            if (ctrlWrap) ctrlWrap.classList.remove('is-untouched');
            if (saveBtn) saveBtn.disabled = false;

            const trimCheck = window.validateVaultTrimRange(singleAudioCfg.trimStart, singleAudioCfg.trimEnd);
            const errEl = document.getElementById('sa-trim-err');
            const endInp = document.getElementById('sa-trim-end');
            if (errEl) {
              errEl.style.display = trimCheck.ok ? 'none' : 'block';
              errEl.textContent = trimCheck.ok ? '' : ('⚠ ' + trimCheck.msg);
            }
            if (endInp) endInp.style.borderColor = trimCheck.ok ? 'var(--border)' : 'var(--crimson)';
            const isLossless = singleAudioCfg.fmt === 'flac' || singleAudioCfg.fmt === 'wav';
            document.getElementById('sa-br').disabled = isLossless;
            const stPill = document.getElementById('fmt-status-pill');
            const footT = document.getElementById('foot-title');
            const footS = document.getElementById('foot-sub');
            if (stPill) stPill.textContent = '.' + singleAudioCfg.fmt.toUpperCase();
            if (footT) footT.textContent = trimCheck.ok ? 'Audio Format Ready' : 'Fix Trim Range';
            if (footS) footS.textContent = '.' + singleAudioCfg.fmt.toUpperCase() + (isLossless ? ' · Lossless' : (' · ' + singleAudioCfg.br)) + (singleAudioCfg.gain !== '0dB' ? (' · ' + singleAudioCfg.gain) : '');
            const mvBtn = document.getElementById('btn-move-convert');
            if (mvBtn) mvBtn.disabled = !trimCheck.ok;
            updateAudioPerf();
          };
          window.refreshSinglePhotoAudioPerf = updateAudioPerf;

          let saPresetsOpen = false;
          const BUILTIN_AUD_PRESETS = [
            { raw: { name: 'Opus 192k Transparent', container: 'opus', crfOrBitrate: '192k' }, parsed: { cfg: { fmt: 'opus', br: '192k', ar: '48000', ch: '2', filter: 'none', gain: '0dB', speed: '1.0', fade: 'none', trimStart: '00:00:00', trimEnd: 'End', meta: 'wipe' } } },
            { raw: { name: 'Loudnorm AAC (-14 LUFS)', container: 'm4a', crfOrBitrate: '192k' }, parsed: { cfg: { fmt: 'm4a', br: '192k', ar: '48000', ch: '2', filter: 'loudnorm', gain: '0dB', speed: '1.0', fade: 'none', trimStart: '00:00:00', trimEnd: 'End', meta: 'wipe' } } }
          ];
          const renderSavedAudioPresets = () => {
            const wrap = document.getElementById('sa-saved-presets-wrap');
            const cntEl = document.getElementById('lbl-sa-presets-cnt');
            const arrEl = document.getElementById('lbl-sa-presets-arrow');
            if (!wrap) return;
            const merged = (window.VaultPresets && window.VaultPresets.hasBridge())
              ? window.VaultPresets.listActive('audio')
              : getRoomPresetsForCat('audio');
            if (cntEl) cntEl.textContent = 'Presets (' + merged.length + ')';
            if (arrEl) arrEl.textContent = saPresetsOpen ? '▴' : '▾';
            wrap.style.display = saPresetsOpen ? 'flex' : 'none';
            wrap.innerHTML = merged.map((s, i) =>
              '<button type="button" data-sa-saved="' + i + '" style="padding:6px 11px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); font-size:11.5px; font-weight:700; cursor:pointer;">' + s.raw.name.replace(/</g, '&lt;') + '</button>'
            ).join('');
            wrap.querySelectorAll('[data-sa-saved]').forEach(btn => {
              btn.addEventListener('click', () => {
                const s = merged[parseInt(btn.getAttribute('data-sa-saved'), 10)];
                if (!s) return;
                const c = s.parsed.cfg || {};
                const fmt = (c.fmt || s.raw.container || 'm4a').replace(/^\./, '').toLowerCase();
                if (Array.from(document.getElementById('sa-fmt').options).some(o => o.value === fmt)) document.getElementById('sa-fmt').value = fmt;
                const br = c.br || s.raw.crfOrBitrate || '192k';
                if (Array.from(document.getElementById('sa-br').options).some(o => o.value === br)) document.getElementById('sa-br').value = br;
                if (c.ar && Array.from(document.getElementById('sa-ar').options).some(o => o.value === String(c.ar))) document.getElementById('sa-ar').value = String(c.ar);
                if (c.ch && Array.from(document.getElementById('sa-ch').options).some(o => o.value === String(c.ch))) document.getElementById('sa-ch').value = String(c.ch);
                if (c.filter && Array.from(document.getElementById('sa-filter').options).some(o => o.value === String(c.filter))) document.getElementById('sa-filter').value = String(c.filter);
                if (c.gain && Array.from(document.getElementById('sa-gain').options).some(o => o.value === String(c.gain))) document.getElementById('sa-gain').value = String(c.gain);
                if (c.speed && Array.from(document.getElementById('sa-speed').options).some(o => o.value === String(c.speed))) document.getElementById('sa-speed').value = String(c.speed);
                if (c.fade && Array.from(document.getElementById('sa-fade').options).some(o => o.value === String(c.fade))) document.getElementById('sa-fade').value = String(c.fade);
                if (c.trimStart) document.getElementById('sa-trim-start').value = String(c.trimStart);
                if (c.trimEnd) document.getElementById('sa-trim-end').value = String(c.trimEnd);
                if (c.meta && Array.from(document.getElementById('sa-meta').options).some(o => o.value === String(c.meta))) document.getElementById('sa-meta').value = String(c.meta);
                saPresetsOpen = false;
                renderSavedAudioPresets();
                syncAudioSummary(true);
                toast('Applied preset: ' + s.raw.name);
              });
            });
          };
          const saTgl = document.getElementById('btn-sa-toggle-presets');
          if (saTgl) saTgl.addEventListener('click', () => {
            saPresetsOpen = !saPresetsOpen;
            renderSavedAudioPresets();
          });

          document.getElementById('btn-sa-save-preset').addEventListener('click', () => {
            if (!audioTouched || !singleAudioCfg.fmt) return;
            if (!hasBridge || typeof window.AndroidBridge.savePreset !== 'function') return;
            const isLossless = singleAudioCfg.fmt === 'flac' || singleAudioCfg.fmt === 'wav';
            const nm = 'Audio ' + singleAudioCfg.fmt.toUpperCase() + (isLossless ? ' Lossless' : (' ' + singleAudioCfg.br));
            const specs = '.' + singleAudioCfg.fmt + ' · ' + (isLossless ? 'Lossless' : singleAudioCfg.br);
            window.AndroidBridge.savePreset(JSON.stringify({
              name: nm,
              category: 'Audio',
              codec: singleAudioCfg.fmt,
              container: singleAudioCfg.fmt,
              crfOrBitrate: isLossless ? 'lossless' : singleAudioCfg.br,
              extraFlags: JSON.stringify({ desc: 'Saved audio preset', specs, cfg: Object.assign({}, singleAudioCfg) })
            }));
            renderSavedAudioPresets();
            toast('Saved "' + nm + '" ✓');
          });

          ['sa-fmt', 'sa-br', 'sa-ar', 'sa-ch', 'sa-filter', 'sa-gain', 'sa-speed', 'sa-fade', 'sa-trim-start', 'sa-trim-end', 'sa-meta'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.addEventListener('change', () => syncAudioSummary(true)); el.addEventListener('input', () => syncAudioSummary(true)); }
          });
          try {
            if (hasBridge && typeof window.AndroidBridge.getSettings === 'function') {
              const ds = JSON.parse(window.AndroidBridge.getSettings() || '{}');
              const pol = ds.defaultMetadataPolicy === 'forensic' ? 'deep' : (ds.defaultMetadataPolicy === 'keep' ? 'keep' : 'wipe');
              const sm = document.getElementById('sa-meta');
              if (sm && Array.from(sm.options).some(o => o.value === pol)) sm.value = pol;
            }
          } catch (_) {}
          renderSavedAudioPresets();
          let appliedPendingAudio = false;
          if (window.VaultPresets && isPresetFlowMode()) {
            const p = window.VaultPresets.getPendingPreset();
            if (p && p.cat === 'audio') {
              const c = p.cfg || {};
              const fmt = (c.fmt || p.container || 'opus').replace(/^\./, '').toLowerCase();
              const fmtEl = document.getElementById('sa-fmt');
              if (fmtEl && Array.from(fmtEl.options).some(o => o.value === fmt)) fmtEl.value = fmt;
              const br = c.br || p.crfOrBitrate || '192k';
              const brEl = document.getElementById('sa-br');
              if (brEl && Array.from(brEl.options).some(o => o.value === br)) brEl.value = br;
              if (c.ar && document.getElementById('sa-ar') && Array.from(document.getElementById('sa-ar').options).some(o => o.value === String(c.ar))) document.getElementById('sa-ar').value = String(c.ar);
              if (c.ch && document.getElementById('sa-ch') && Array.from(document.getElementById('sa-ch').options).some(o => o.value === String(c.ch))) document.getElementById('sa-ch').value = String(c.ch);
              if (c.meta && document.getElementById('sa-meta') && Array.from(document.getElementById('sa-meta').options).some(o => o.value === String(c.meta))) document.getElementById('sa-meta').value = String(c.meta);
              window.VaultPresets.clearPendingPreset();
              appliedPendingAudio = true;
              const fmtCard = document.querySelector('section.s-format');
              if (fmtCard) fmtCard.classList.add('hidden');
              const saPresetWrap = document.getElementById('sa-saved-presets');
              if (saPresetWrap && saPresetWrap.parentElement) saPresetWrap.parentElement.style.display = 'none';
              if (perfSec) perfSec.querySelectorAll('.field').forEach(el => { if (el.querySelector('#sa-fmt')) el.style.display = 'none'; });
              const perfTitle = perfSec ? perfSec.querySelector('.sec-title') : null;
              if (perfTitle) perfTitle.textContent = '2. Device Performance · ' + p.name;
              syncAudioSummary(true);
              toast('✓ Pre-applied preset: ' + p.name);
            }
          }
          if (!appliedPendingAudio) syncAudioSummary(false);
        }
      }

      if (firstFile) {
        if (typeof window.updateSingleFileFromProbe === 'function') {
          window.updateSingleFileFromProbe(firstFile, null);
        }
        setTimeout(() => {
          probeAndHydrateSingleFile(firstFile);
        }, 15);
      }

      const bMove = document.getElementById('btn-move-convert');
      if (bMove) bMove.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        if (singlePhotoCfg) {
          safeSet('cv_pending_convert_cfg', JSON.stringify({ mode: 'single_photo', photo: singlePhotoCfg }));
        } else if (singleAudioCfg) {
          safeSet('cv_pending_convert_cfg', JSON.stringify({ mode: 'single_audio', audio: singleAudioCfg }));
        } else {
          const vCfg = typeof window.getSingleVideoConfig === 'function' ? window.getSingleVideoConfig() : null;
          safeSet('cv_pending_convert_cfg', JSON.stringify({ mode: 'single_video', video: vCfg }));
        }
        navigateTo('conversion_vault_p3b_output_single.html');
      }, true);
    }

    if (page === 'conversion_vault_p3_batch.html') {
      if (typeof window.setBatchFilesFromNative === 'function') window.setBatchFilesFromNative(getActiveFiles());
      const activeWf = isWorkflowFlowMode() ? getPendingWorkflow() : null;
      if (activeWf && typeof window.applyVaultWorkflowMode === 'function') {
        window.applyVaultWorkflowMode(activeWf);
      }
      const bGo = document.getElementById('btn-go-convert');
      if (bGo) bGo.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        if (activeWf) {
          if (!hasBridge) { toast('Native engine runs inside Android APK'); return; }
          const wfFiles = (typeof window.getVaultActiveWorkflowFiles === 'function') ? window.getVaultActiveWorkflowFiles() : [];
          if (!wfFiles.length) { toast('No active files to convert (all skipped)'); return; }
          let savedSettings = {};
          try {
            if (typeof window.AndroidBridge.getSettings === 'function') {
              savedSettings = JSON.parse(window.AndroidBridge.getSettings() || '{}');
            }
          } catch (_) {}
          const rules = activeWf.rules || {};
          const wfMetaPolicy = rules.metaPolicy || 'preset';
          const fnRule = rules.filenameRule || 'keep';
          const customSuf = String(rules.customSuffix || '').trim().replace(/[\\/:*?"<>|]/g, '_');
          const safeWfSlug = String(activeWf.name || 'workflow').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'wf';
          const nowD = new Date();
          const dateTag = String(nowD.getFullYear()) + String(nowD.getMonth() + 1).padStart(2, '0') + String(nowD.getDate()).padStart(2, '0');

          function buildWfBaseName(origName) {
            const dot = String(origName || 'file').lastIndexOf('.');
            const stem = dot > 0 ? origName.substring(0, dot) : String(origName || 'file');
            if (fnRule === 'suffix_converted') return stem + '_converted';
            if (fnRule === 'append_date') return stem + '_' + dateTag;
            if (fnRule === 'prefix_workflow') return safeWfSlug + '_' + stem;
            if (fnRule === 'suffix_custom' && customSuf) return stem + customSuf;
            return stem;
          }

          const jobSpecs = [];
          wfFiles.forEach(f => {
            const c = f.cat === 'audio' ? 'a' : (f.cat === 'image' ? 'i' : 'v');
            const bucket = c === 'a' ? 'Audios' : (c === 'i' ? 'Images' : 'Videos');
            const mType = c === 'a' ? 'Audio' : (c === 'i' ? 'Image' : 'Video');
            let ext = c === 'a' ? 'm4a' : (c === 'i' ? 'webp' : 'mp4');
            let args = '';
            let outDir = '';

            if (c === 'i') {
              const pCfg = f.cfg || {};
              ext = (pCfg.format || pCfg.fmt || 'webp').replace(/^\./, '').toLowerCase();
              const effMeta = wfMetaPolicy !== 'preset' ? wfMetaPolicy : (pCfg.meta || (savedSettings.defaultMetadataPolicy === 'forensic' ? 'deep' : (savedSettings.defaultMetadataPolicy || 'wipe')));
              const photoSpec = {
                format: ext,
                quality: parseInt(pCfg.quality || pCfg.qual || 88, 10) || 88,
                scale: String(pCfg.scale || 'original'),
                orient: String(pCfg.orient || 'auto'),
                meta: String(effMeta),
                colorSpace: String(pCfg.colorSpace || 'srgb_444'),
                crop: String(pCfg.crop || 'original'),
                filter: String(pCfg.filter || 'none'),
                brightness: parseInt(pCfg.brightness || 0, 10) || 0
              };
              args = 'NATIVE_PHOTO:' + JSON.stringify(photoSpec);
              outDir = (activeWf.image && activeWf.image.outputDir) || '';
            } else if (c === 'a') {
              const aCfg = f.cfg || {};
              ext = (aCfg.fmt || 'm4a').replace(/^\./, '').toLowerCase();
              const br = aCfg.br || '192k';
              const arFlag = (aCfg.ar && aCfg.ar !== 'keep') ? (' -ar ' + aCfg.ar) : '';
              const chRaw = aCfg.ch || aCfg.channels || 'keep';
              const chFlag = chRaw === '1' || chRaw === 'mono' ? ' -ac 1' : (chRaw === '2' || chRaw === 'stereo' ? ' -ac 2' : '');
              const afList = [];
              const filt = aCfg.filter || aCfg.af || 'none';
              if (filt === 'loudnorm') afList.push('loudnorm=I=-14:TP=-1.5:LRA=11');
              else if (filt === 'bass') afList.push('bass=g=5');
              else if (filt === 'trim_silence' || filt === 'silence') afList.push('silenceremove=start_periods=1:start_threshold=-50dB');
              if (aCfg.gain && aCfg.gain !== '0dB') afList.push('volume=' + aCfg.gain);
              if (aCfg.speed && aCfg.speed !== '1.0') afList.push('atempo=' + aCfg.speed);
              if (aCfg.fade === 'in2' || aCfg.fade === 'both2') afList.push('afade=t=in:d=2');
              const afFlag = afList.length ? (' -af "' + afList.join(',') + '"') : '';
              const effAudMeta = wfMetaPolicy !== 'preset' ? wfMetaPolicy : (aCfg.meta || (savedSettings.defaultMetadataPolicy === 'forensic' ? 'deep' : (savedSettings.defaultMetadataPolicy === 'keep' ? 'keep' : 'wipe')));
              const metaFlag = effAudMeta === 'deep' ? ' -map_metadata -1 -map_chapters -1 -fflags +bitexact' : (effAudMeta === 'wipe' ? ' -map_metadata -1' : '');
              const codecPart = ext === 'flac' ? '-c:a flac'
                : (ext === 'wav' ? '-c:a pcm_s16le'
                : (ext === 'mp3' ? '-c:a libmp3lame -b:a ' + br
                : (ext === 'opus' ? '-c:a libopus -b:a ' + br
                : '-c:a aac -b:a ' + br)));
              args = '-y -i {INPUT} -vn ' + codecPart + arFlag + chFlag + afFlag + metaFlag + ' {OUTPUT}';
              outDir = (activeWf.audio && activeWf.audio.outputDir) || '';
            } else {
              const vCfg = f.cfg || {};
              ext = (vCfg.container || 'mp4').replace(/^\./, '').toLowerCase();
              const vCodec = vCfg.codec || 'libx264';
              const crf = vCfg.crf != null ? vCfg.crf : 20;
              const preset = vCfg.preset || 'fast';
              const aCodec = vCfg.audioCodec || 'aac';
              const aBr = vCfg.audioBr || '192k';
              const vfList = [];
              if (vCfg.scale === '720') vfList.push('scale=-2:720');
              else if (vCfg.scale === '480') vfList.push('scale=-2:480');
              else if (vCfg.scale === '1080_v') vfList.push('scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2');
              if (vCfg.orient === '90cw') vfList.push('transpose=1');
              else if (vCfg.orient === '90ccw') vfList.push('transpose=2');
              else if (vCfg.orient === '180') vfList.push('transpose=1,transpose=1');
              else if (vCfg.orient === 'hflip') vfList.push('hflip');
              const vfFlag = vfList.length ? (' -vf "' + vfList.join(',') + '"') : '';
              const fpsFlag = (vCfg.fps && vCfg.fps !== 'original') ? (' -r ' + vCfg.fps) : '';
              const aPart = aCodec === 'none' ? '-an' : (aCodec === 'copy' ? '-c:a copy' : (aCodec === 'flac' ? '-c:a flac' : ('-c:a ' + aCodec + ' -b:a ' + aBr)));
              const subFlag = vCfg.subMode === 'strip' ? ' -sn' : (vCfg.subMode === 'copy' ? ' -c:s copy' : '');
              const effVidMeta = wfMetaPolicy !== 'preset' ? wfMetaPolicy : (vCfg.meta || (savedSettings.defaultMetadataPolicy === 'forensic' ? 'deep' : (savedSettings.defaultMetadataPolicy || 'wipe')));
              const metaFlag = effVidMeta === 'deep' ? ' -map_metadata -1 -map_chapters -1 -fflags +bitexact'
                : (effVidMeta === 'wipe' ? ' -map_metadata -1'
                : (effVidMeta === 'gps' ? ' -metadata location= -metadata location-eng= -metadata com.apple.quicktime.location.ISO6709=' : ''));
              const fastPart = (ext === 'mp4' && vCfg.faststart !== 'standard') ? ' -movflags +faststart' : '';
              args = vCodec === 'copy'
                ? ('-y -i {INPUT} -c copy' + subFlag + metaFlag + fastPart + ' {OUTPUT}')
                : ('-y -i {INPUT} -c:v ' + vCodec + ' -pix_fmt ' + (vCfg.pixfmt || 'yuv420p') + ' -crf ' + crf + ' -preset ' + preset + vfFlag + fpsFlag + ' ' + aPart + subFlag + metaFlag + fastPart + ' {OUTPUT}');
              outDir = (activeWf.video && activeWf.video.outputDir) || '';
            }

            jobSpecs.push({
              module: 'Vault_Core',
              outputDir: outDir,
              subBucket: outDir ? '' : bucket,
              mediaType: mType,
              inputPath: f.path,
              outputBaseName: buildWfBaseName(f.name),
              outputExt: ext,
              durationMs: Math.round((f.durationSec || 0) * 1000),
              originalPolicy: (rules.sourceAction === 'delete_after_verify') ? 'delete' : 'keep',
              commandArgs: args
            });
          });

          let queuedCount = 0;
          let lastErr = '';
          if (typeof window.AndroidBridge.enqueueBatchJobs === 'function') {
            const res = JSON.parse(window.AndroidBridge.enqueueBatchJobs(JSON.stringify(jobSpecs)) || '{}');
            if (res && res.ok) {
              queuedCount = res.count || jobSpecs.length;
              if (res.firstJobId) safeSet('cv_active_job_id', res.firstJobId);
              const jIds = res.jobIds || [];
              safeSet('cv_batch_job_ids', JSON.stringify(jIds));
              if (jIds.length > 1) {
                try {
                  const reg = JSON.parse(safeGet('cv_batches_meta', '[]') || '[]');
                  reg.unshift({ batchId: 'wf_' + Date.now(), createdAt: Date.now(), total: jIds.length, jobIds: jIds });
                  safeSet('cv_batches_meta', JSON.stringify(reg.slice(0, 30)));
                } catch (_) {}
              }
            } else {
              lastErr = (res && res.error) || 'Failed to queue workflow';
            }
          } else {
            const fallbackIds = [];
            jobSpecs.forEach((spec, idx) => {
              const res = JSON.parse(window.AndroidBridge.enqueueJob(JSON.stringify(spec)) || '{}');
              if (res && res.ok) {
                queuedCount++;
                if (idx === 0) safeSet('cv_active_job_id', res.jobId);
                if (res.jobId) fallbackIds.push(res.jobId);
              } else {
                lastErr = (res && res.error) || 'Failed to queue job';
              }
            });
            safeSet('cv_batch_job_ids', JSON.stringify(fallbackIds));
          }
          if (queuedCount === 0) {
            toast('Workflow failed: ' + (lastErr || 'No valid input files'));
            return;
          }
          clearPendingWorkflow();
          if (queuedCount === 1) navigateTo('conversion_vault_p4a_convert_single.html');
          else navigateTo('conversion_vault_p4_convert_batch.html');
          return;
        }
        if (typeof window.getVaultBatchConfigs === 'function') {
          try {
            safeSet('cv_pending_convert_cfg', JSON.stringify({ mode: 'batch', batch: window.getVaultBatchConfigs() }));
          } catch (_) {}
        }
        navigateTo('conversion_vault_p3b_output.html');
      }, true);
    }

    if (page === 'conversion_vault_p3b_output.html' || page === 'conversion_vault_p3b_output_single.html') {
      // Hide non-present media type names in Separate-by-Media-Type subtitle
      const outFiles = getActiveFiles();
      const presentDirs = [];
      if (outFiles.some(f => classifyExt(f.name) === 'v')) presentDirs.push('Videos/');
      if (outFiles.some(f => classifyExt(f.name) === 'a')) presentDirs.push('Audios/');
      if (outFiles.some(f => classifyExt(f.name) === 'i')) presentDirs.push('Images/');
      if (presentDirs.length > 0) {
        document.querySelectorAll('.toggle-sub').forEach(el => {
          if ((el.textContent || '').includes('Videos/') && (el.textContent || '').includes('Audios/')) {
            el.textContent = 'Creates/reuses ' + presentDirs.join(' · ');
          }
        });
      }
      // Hydrate Output Destination defaults from Settings
      let savedSettings = {};
      if (hasBridge && typeof window.AndroidBridge.getSettings === 'function') {
        try { savedSettings = JSON.parse(window.AndroidBridge.getSettings() || '{}'); } catch (_) {}
      }
      if (savedSettings.defaultVaultFolder) {
        const cleanRoot = savedSettings.defaultVaultFolder.replace(/\/$/, '');
        window.__cvVaultRoot = cleanRoot;
        document.querySelectorAll('[data-mode="vault"] .loc-path, [data-loc="vault"] .loc-path').forEach(el => {
          el.textContent = cleanRoot + '/Vault_Core/';
        });
      }
      // Update Date pill label to today's actual date
      const datePillSpan = document.querySelector('#sub-mode-pills [data-submode="date"] span');
      if (datePillSpan) {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const nowD = new Date();
        datePillSpan.textContent = months[nowD.getMonth()] + '_' + String(nowD.getDate()).padStart(2, '0');
      }
      const chkSepInit = document.getElementById('chk-separate');
      if (chkSepInit && typeof savedSettings.separateByType === 'boolean') {
        chkSepInit.checked = savedSettings.separateByType;
        chkSepInit.dispatchEvent(new Event('change'));
      }
      if (savedSettings.defaultSubfolderStyle) {
        const subPill = document.querySelector('#sub-mode-pills [data-submode="' + savedSettings.defaultSubfolderStyle + '"], #sub-mode-pills [data-sub="' + savedSettings.defaultSubfolderStyle + '"]');
        if (subPill) subPill.click();
      }
      // Show active filename suffix hint on Single Output screen
      const singleFnameEl = document.getElementById('inp-fname');
      if (singleFnameEl && savedSettings.defaultSuffixRule && (savedSettings.defaultSuffixRule === '_vault' || savedSettings.defaultSuffixRule === '_converted')) {
        singleFnameEl.placeholder = 'Leave blank for original name + ' + savedSettings.defaultSuffixRule;
      }

      const bBrowse = document.getElementById('btn-browse');
      if (bBrowse) bBrowse.addEventListener('click', (e) => { if (hasBridge) { e.preventDefault(); e.stopImmediatePropagation(); window.__pickingCustomDest = true; window.AndroidBridge.pickFolder(); } }, true);

      const bStart = document.getElementById('btn-start-convert');
      if (bStart) bStart.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        const files = getActiveFiles();
        if (!files.length) { toast('Pick file(s) first'); return; }
        if (!hasBridge) { toast('Native engine runs inside Android APK'); return; }
        const outNameEl = document.getElementById('inp-fname');
        const probe = JSON.parse(safeGet('cv_last_probe', '{}') || '{}');
        let pendingCfg = {};
        try { pendingCfg = JSON.parse(safeGet('cv_pending_convert_cfg', '{}') || '{}'); } catch (_) {}
        const jobSpecs = [];
        files.forEach((f, idx) => {
          const c = classifyExt(f.name);
          const bucket = c === 'a' ? 'Audios' : (c === 'i' ? 'Images' : 'Videos');
          const mType = c === 'a' ? 'Audio' : (c === 'i' ? 'Image' : 'Video');
          let ext = c === 'a' ? 'm4a' : (c === 'i' ? 'webp' : 'mp4');
          let args = '';

          if (c === 'i') {
            const batchItemCfg = pendingCfg.batch && pendingCfg.batch.byName && pendingCfg.batch.byName[f.name];
            const batchImgCfg = pendingCfg.batch && pendingCfg.batch.byCat && pendingCfg.batch.byCat.image;
            const pCfg = (pendingCfg.mode === 'single_photo' && pendingCfg.photo) || batchItemCfg || batchImgCfg || {};
            ext = (pCfg.format || pCfg.fmt || 'webp').replace(/^\./, '').toLowerCase();
            const photoSpec = {
              format: ext,
              quality: parseInt(pCfg.quality || pCfg.qual || 88, 10) || 88,
              scale: String(pCfg.scale || 'original'),
              orient: String(pCfg.orient || 'auto'),
              meta: String(pCfg.meta || (savedSettings.defaultMetadataPolicy === 'forensic' ? 'deep' : (savedSettings.defaultMetadataPolicy || 'wipe'))),
              colorSpace: String(pCfg.colorSpace || 'srgb_444'),
              crop: String(pCfg.crop || 'original'),
              filter: String(pCfg.filter || 'none'),
              brightness: parseInt(pCfg.brightness || 0, 10) || 0
            };
            args = 'NATIVE_PHOTO:' + JSON.stringify(photoSpec);
          } else if (c === 'a') {
            const aCfg = (pendingCfg.mode === 'single_audio' && pendingCfg.audio) || (pendingCfg.batch && pendingCfg.batch.byName && pendingCfg.batch.byName[f.name]) || (pendingCfg.batch && pendingCfg.batch.byCat && pendingCfg.batch.byCat.audio) || {};
            ext = (aCfg.fmt || 'm4a').replace(/^\./, '').toLowerCase();
            const br = aCfg.br || '192k';
            const arFlag = (aCfg.ar && aCfg.ar !== 'keep') ? (' -ar ' + aCfg.ar) : '';
            const chRaw = aCfg.ch || aCfg.channels || 'keep';
            const chFlag = chRaw === '1' || chRaw === 'mono' ? ' -ac 1' : (chRaw === '2' || chRaw === 'stereo' ? ' -ac 2' : '');
            const afList = [];
            const filt = aCfg.filter || aCfg.af || 'none';
            if (filt === 'loudnorm') afList.push('loudnorm=I=-14:TP=-1.5:LRA=11');
            else if (filt === 'bass') afList.push('bass=g=5');
            else if (filt === 'trim_silence' || filt === 'silence') afList.push('silenceremove=start_periods=1:start_threshold=-50dB');
            if (aCfg.gain && aCfg.gain !== '0dB') afList.push('volume=' + aCfg.gain);
            if (aCfg.speed && aCfg.speed !== '1.0') afList.push('atempo=' + aCfg.speed);
            if (aCfg.fade === 'in2' || aCfg.fade === 'both2') afList.push('afade=t=in:d=2');
            const afFlag = afList.length ? (' -af "' + afList.join(',') + '"') : '';
            const tr = window.validateVaultTrimRange(aCfg.trimStart, aCfg.trimEnd);
            const ssFlag = (tr.ok && tr.startSec > 0) ? (' -ss ' + aCfg.trimStart) : '';
            const toFlag = (tr.ok && tr.endSec != null) ? (' -to ' + aCfg.trimEnd) : '';
            const effAudMeta = aCfg.meta || (savedSettings.defaultMetadataPolicy === 'forensic' ? 'deep' : (savedSettings.defaultMetadataPolicy === 'keep' ? 'keep' : 'wipe'));
            const metaFlag = effAudMeta === 'deep' ? ' -map_metadata -1 -map_chapters -1 -fflags +bitexact' : (effAudMeta === 'wipe' ? ' -map_metadata -1' : '');
            const codecPart = ext === 'flac' ? '-c:a flac'
                 : (ext === 'wav' ? '-c:a pcm_s16le'
                 : (ext === 'mp3' ? '-c:a libmp3lame -b:a ' + br
                 : (ext === 'opus' ? '-c:a libopus -b:a ' + br
                                   : '-c:a aac -b:a ' + br)));
            args = '-y' + ssFlag + toFlag + ' -i {INPUT} -vn ' + codecPart + arFlag + chFlag + afFlag + metaFlag + ' {OUTPUT}';
          } else {
            const vCfg = (pendingCfg.mode === 'single_video' && pendingCfg.video) || (pendingCfg.batch && pendingCfg.batch.byName && pendingCfg.batch.byName[f.name]) || (pendingCfg.batch && pendingCfg.batch.byCat && pendingCfg.batch.byCat.video) || {};
            ext = (vCfg.container || 'mp4').replace(/^\./, '').toLowerCase();
            const vCodec = vCfg.codec || 'libx264';
            const crf = vCfg.crf != null ? vCfg.crf : 20;
            const preset = vCfg.preset || 'fast';
            const aCodec = vCfg.audioCodec || 'aac';
            const aBr = vCfg.audioBr || '192k';
            const tr = window.validateVaultTrimRange(vCfg.trimStart, vCfg.trimEnd);
            const ssFlag = (tr.ok && tr.startSec > 0) ? (' -ss ' + vCfg.trimStart) : '';
            const toFlag = (tr.ok && tr.endSec != null) ? (' -to ' + vCfg.trimEnd) : '';
            const vfList = [];
            if (vCfg.scale === '720') vfList.push('scale=-2:720');
            else if (vCfg.scale === '480') vfList.push('scale=-2:480');
            else if (vCfg.scale === '1080_v') vfList.push('scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2');
            if (vCfg.orient === '90cw') vfList.push('transpose=1');
            else if (vCfg.orient === '90ccw') vfList.push('transpose=2');
            else if (vCfg.orient === '180') vfList.push('transpose=1,transpose=1');
            else if (vCfg.orient === 'hflip') vfList.push('hflip');
            if (vCfg.speed && vCfg.speed !== '1.0') {
              const sp = parseFloat(vCfg.speed) || 1.0;
              vfList.push('setpts=' + (1 / sp).toFixed(3) + '*PTS');
            }
            const vfFlag = vfList.length ? (' -vf "' + vfList.join(',') + '"') : '';
            const fpsFlag = (vCfg.fps && vCfg.fps !== 'original') ? (' -r ' + vCfg.fps) : '';
            const afList = [];
            if (vCfg.audioNorm === 'loudnorm') afList.push('loudnorm=I=-14:TP=-1.5:LRA=11');
            if (vCfg.audioGain && vCfg.audioGain !== '0dB') afList.push('volume=' + vCfg.audioGain);
            if (vCfg.speed && vCfg.speed !== '1.0') afList.push('atempo=' + vCfg.speed);
            const afFlag = (aCodec !== 'none' && aCodec !== 'copy' && afList.length) ? (' -af "' + afList.join(',') + '"') : '';
            const aPart = aCodec === 'none' ? '-an' : (aCodec === 'copy' ? '-c:a copy' : (aCodec === 'flac' ? '-c:a flac' : ('-c:a ' + aCodec + ' -b:a ' + aBr)));
            const subFlag = vCfg.subMode === 'strip' ? ' -sn' : (vCfg.subMode === 'copy' ? ' -c:s copy' : '');
            const effVidMeta = vCfg.meta || (savedSettings.defaultMetadataPolicy === 'forensic' ? 'deep' : (savedSettings.defaultMetadataPolicy || 'wipe'));
            const metaFlag = effVidMeta === 'deep' ? ' -map_metadata -1 -map_chapters -1 -fflags +bitexact'
              : (effVidMeta === 'wipe' ? ' -map_metadata -1'
              : (effVidMeta === 'gps' ? ' -metadata location= -metadata location-eng= -metadata com.apple.quicktime.location.ISO6709=' : ''));
            const fastPart = (ext === 'mp4' && vCfg.faststart !== 'standard') ? ' -movflags +faststart' : '';
            const thNum = parseInt(vCfg.threads || (pendingCfg.batch && pendingCfg.batch.threads) || '', 10);
            const thFlag = (thNum >= 1 && thNum <= 16) ? (' -threads ' + thNum) : '';
            args = vCodec === 'copy'
              ? ('-y' + thFlag + ssFlag + toFlag + ' -i {INPUT} -c copy' + subFlag + metaFlag + fastPart + ' {OUTPUT}')
              : ('-y' + thFlag + ssFlag + toFlag + ' -i {INPUT} -c:v ' + vCodec + ' -pix_fmt ' + (vCfg.pixfmt || 'yuv420p') + ' -crf ' + crf + ' -preset ' + preset + vfFlag + fpsFlag + ' ' + aPart + afFlag + subFlag + metaFlag + fastPart + ' {OUTPUT}');
          }

          // Compute effective outputDir & subBucket from Output Destination UI + saved Settings
          const activeLocEl = document.querySelector('#loc-stack .loc-card.active, #loc-stack [data-mode].active, #loc-stack [data-loc].active');
          const locMode = activeLocEl ? (activeLocEl.getAttribute('data-mode') || activeLocEl.getAttribute('data-loc') || 'vault') : 'vault';
          const activeSubEl = document.querySelector('#sub-mode-pills .sub-pill.active, #sub-mode-pills [data-submode].active, #sub-mode-pills [data-sub].active');
          const subMode = activeSubEl ? (activeSubEl.getAttribute('data-submode') || activeSubEl.getAttribute('data-sub') || 'none') : (savedSettings.defaultSubfolderStyle || 'none');
          const sepChkEl = document.getElementById('chk-separate');
          const separateOn = sepChkEl ? !!sepChkEl.checked : (savedSettings.separateByType !== false);

          let runFolder = '';
          if (subMode === 'numbered') {
            runFolder = '__AUTO_NUMBERED__';
          } else if (subMode === 'date') {
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const nowD = new Date();
            runFolder = months[nowD.getMonth()] + '_' + String(nowD.getDate()).padStart(2, '0');
          } else if (subMode === 'custom') {
            const cInp = document.getElementById('inp-run-name') || document.getElementById('inp-sub-name');
            runFolder = ((cInp && cInp.value) ? cInp.value : 'Converted').trim().replace(/[\\/:*?"<>|]/g, '_');
          }

          const relParts = [];
          if (runFolder) relParts.push(runFolder);
          if (separateOn) relParts.push(bucket);
          const finalSubBucket = relParts.join('/');

          let customOutDir = '';
          if (locMode === 'source' && f.path && f.path.includes('/')) {
            const srcParent = f.path.substring(0, f.path.lastIndexOf('/'));
            customOutDir = finalSubBucket ? (srcParent + '/' + finalSubBucket) : srcParent;
          } else if (locMode === 'custom') {
            const cBase = (window.__cvCustomOutDir || (document.getElementById('lbl-custom-path') && document.getElementById('lbl-custom-path').textContent) || '').trim().replace(/\/$/, '');
            if (cBase) customOutDir = finalSubBucket ? (cBase + '/' + finalSubBucket) : cBase;
          }

          jobSpecs.push({
            module: 'Vault_Core',
            outputDir: customOutDir,
            subBucket: customOutDir ? '' : finalSubBucket,
            mediaType: mType,
            inputPath: f.path,
            outputBaseName: (files.length === 1 && outNameEl) ? outNameEl.value : '',
            outputExt: ext,
            durationMs: (files.length === 1) ? Math.round((probe.durationSec || 0) * 1000) : 0,
            commandArgs: args
          });
        });

        let queuedCount = 0;
        let lastErr = '';
        if (typeof window.AndroidBridge.enqueueBatchJobs === 'function') {
          const res = JSON.parse(window.AndroidBridge.enqueueBatchJobs(JSON.stringify(jobSpecs)) || '{}');
          if (res && res.ok) {
            queuedCount = res.count || jobSpecs.length;
            if (res.firstJobId) safeSet('cv_active_job_id', res.firstJobId);
            const jIds = res.jobIds || [];
            safeSet('cv_batch_job_ids', JSON.stringify(jIds));
            if (jIds.length > 1) {
              try {
                const reg = JSON.parse(safeGet('cv_batches_meta', '[]') || '[]');
                reg.unshift({
                  batchId: 'batch_' + Date.now(),
                  createdAt: Date.now(),
                  total: jIds.length,
                  jobIds: jIds
                });
                safeSet('cv_batches_meta', JSON.stringify(reg.slice(0, 30)));
              } catch (_) {}
            }
          } else {
            lastErr = (res && res.error) || 'Failed to queue batch';
          }
        } else {
          const fallbackIds = [];
          jobSpecs.forEach((spec, idx) => {
            const res = JSON.parse(window.AndroidBridge.enqueueJob(JSON.stringify(spec)) || '{}');
            if (res && res.ok) {
              queuedCount++;
              if (res.jobId) fallbackIds.push(res.jobId);
              if (idx === 0 && res.jobId) safeSet('cv_active_job_id', res.jobId);
            } else {
              lastErr = (res && res.error) || 'Failed to queue job';
            }
          });
          safeSet('cv_batch_job_ids', JSON.stringify(fallbackIds));
        }
        if (queuedCount > 0) {
          clearActiveSelection();
          toast('Starting Conversion Engine...');
          if (queuedCount === 1) {
            safeSet('cv_batch_job_ids', '[]');
            navigateTo('conversion_vault_p4a_convert_single.html');
          } else {
            navigateTo('conversion_vault_p4_convert_batch.html');
          }
        } else {
          toast('Engine error: ' + lastErr);
        }
      }, true);
    }

    if (page === 'conversion_vault_p5_queue_history.html') {
      // p5_queue_history.html already hydrates itself via loadJobsFromNative() — skip duplicate DB query
    }

    if (page === 'conversion_vault_p6_settings.html') {
      const bTester = document.getElementById('btn-open-tester');
      const bPresets = document.getElementById('btn-manage-presets');
      const bBench = document.getElementById('btn-rebench');
      const bPickVault = document.getElementById('btn-pick-vault');
      const bOpenFm = document.getElementById('btn-open-vault-fm');
      const bExportPresets = document.getElementById('btn-export-presets');

      if (bTester) bTester.addEventListener('click', (e) => { e.preventDefault(); e.stopImmediatePropagation(); navigateTo('conversion_vault_p8_playback_tester.html'); }, true);
      if (bPresets) bPresets.addEventListener('click', (e) => { e.preventDefault(); e.stopImmediatePropagation(); navigateTo('conversion_vault_p7_presets.html'); }, true);
      if (bPickVault) bPickVault.addEventListener('click', (e) => { if (hasBridge) { e.preventDefault(); e.stopImmediatePropagation(); window.__pickingCustomDest = true; window.AndroidBridge.pickFolder(); } }, true);

      function renderTestedDeviceFormats(testData) {
        const capWrap = document.getElementById('device-cap-list');
        if (!capWrap || !testData || !testData.ok) return;
        const c = testData.codecs || {};
        const fps = Number(testData.fps || 0).toFixed(1);
        const rows = [
          {
            name: 'MP4 · H.264 (yuv420p 8-bit)',
            sub: (c.h264HwDecode ? 'HW Decode ✓' : 'SW Decode') + ' · ' + (c.h264HwEncode ? 'HW Encode ✓' : 'CPU x264') + ' · Measured ~' + fps + ' fps',
            badge: c.h264HwDecode ? 'BEST OVERALL' : 'CPU SAFE',
            cls: 'cb-ok'
          },
          {
            name: 'MKV · HEVC 10-bit (yuv420p10le)',
            sub: (c.hevc10bitHwDecode ? '10-bit HW Decode ✓' : 'Software 10-bit Decode') + (c.hevcHwEncode ? ' · HEVC HW Encode ✓' : ' · CPU x265'),
            badge: c.hevc10bitHwDecode ? '10-BIT HW ✓' : 'SW ONLY',
            cls: c.hevc10bitHwDecode ? 'cb-ok' : 'cb-warn'
          },
          {
            name: 'MP4 / MKV · AV1 (libsvtav1)',
            sub: (c.av1HwDecode ? 'AV1 HW Decode ✓' : 'No AV1 HW Decode') + ' · ' + (c.av1HwEncode ? 'AV1 HW Encode ✓' : 'CPU Encode'),
            badge: c.av1HwDecode ? (c.av1HwEncode ? 'FULL HW ✓' : 'HW DEC · CPU ENC') : 'SW ONLY',
            cls: c.av1HwEncode ? 'cb-ok' : 'cb-warn'
          },
          {
            name: 'H.264 10-bit (Hi10P)',
            sub: c.h264_10bitHwDecode ? 'Hardware 10-bit AVC decoder detected' : 'No Hardware Hi10P decoder on this SoC',
            badge: c.h264_10bitHwDecode ? 'SUPPORTED' : 'AVOID',
            cls: c.h264_10bitHwDecode ? 'cb-ok' : 'cb-no'
          },
          {
            name: 'WebP / HEIC Photos · Opus / FLAC Audio',
            sub: 'Native Skia + HeifWriter Photo Engine · FFmpeg Audio',
            badge: 'VERIFIED ✓',
            cls: 'cb-ok'
          }
        ];
        capWrap.innerHTML =
          '<span class="hw-k" style="margin-bottom:1px;">Best Supported Formats (Verified on This Device)</span>' +
          rows.map(r =>
            '<div class="cap-row"><div class="cap-l"><span class="cap-name">' + r.name + '</span><span class="cap-sub">' + r.sub + '</span></div><span class="cap-badge ' + r.cls + '">' + r.badge + '</span></div>'
          ).join('');
      }

      const runDeviceHwTest = (e) => {
        if (!hasBridge || typeof window.AndroidBridge.runBenchmark !== 'function') return;
        if (e) { e.preventDefault(); e.stopImmediatePropagation(); }
        const bLbl = document.getElementById('lbl-bench');
        if (bLbl) bLbl.textContent = 'Testing hardware codecs & 1080p60 x264 speed...';
        if (bBench) bBench.disabled = true;
        const bQuick = document.getElementById('btn-run-hw-test');
        if (bQuick) bQuick.disabled = true;
        setTimeout(() => {
          try {
            const res = JSON.parse(window.AndroidBridge.runBenchmark() || '{}');
            if (res && res.ok && res.fps > 0) {
              if (bLbl) bLbl.textContent = 'Verified: ~' + res.fps + ' fps (1080p60 x264 · ' + (res.threads || 8) + 'T)';
              renderTestedDeviceFormats(res);
              toast('Device test complete: ' + res.fps + ' fps ✓');
            } else {
              if (bLbl) bLbl.textContent = 'Test failed — try again';
              toast('Device test failed');
            }
          } catch (_) {
            if (bLbl) bLbl.textContent = 'Test error';
          }
          if (bBench) bBench.disabled = false;
          if (bQuick) bQuick.disabled = false;
        }, 30);
      };
      if (bBench) bBench.addEventListener('click', runDeviceHwTest, true);
      document.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('#btn-run-hw-test')) {
          runDeviceHwTest(e);
        }
      });

      // Export Device, Hardware, Verified Formats & Engine Threads Report (auto-benchmarks first if not yet tested)
      let lastHwExportPath = '';
      const bExpHw = document.getElementById('btn-export-hw-report');
      const selHwFmt = document.getElementById('sel-hw-report-fmt');
      const hwExpBar = document.getElementById('hw-export-bar');
      if (hwExpBar) hwExpBar.classList.add('hidden');

      window.onVaultBenchmarkUpdated = () => {
        try {
          if (!hasBridge || typeof window.AndroidBridge.getSettings !== 'function') return;
          const stNow = JSON.parse(window.AndroidBridge.getSettings() || '{}');
          if (stNow && stNow.hwTestJson) {
            const parsed = JSON.parse(stNow.hwTestJson);
            if (parsed && parsed.ok && parsed.fps > 0) {
              if (bLbl) bLbl.textContent = 'Verified: ~' + parsed.fps + ' fps (1080p60 x264 · ' + (parsed.threads || 8) + 'T)';
              renderTestedDeviceFormats(parsed);
            }
          }
        } catch (_) {}
      };
      const hwExpLbl = document.getElementById('hw-export-lbl');

      function buildDeviceReportData(benchObj) {
        let tel = {};
        let st = {};
        try { if (hasBridge && window.AndroidBridge.getDeviceTelemetry) tel = JSON.parse(window.AndroidBridge.getDeviceTelemetry() || '{}'); } catch (_) {}
        try { if (hasBridge && window.AndroidBridge.getSettings) st = JSON.parse(window.AndroidBridge.getSettings() || '{}'); } catch (_) {}
        const c = (benchObj && benchObj.codecs) || tel.codecs || {};
        const fps = Number((benchObj && benchObj.fps) || st.benchFps || 0).toFixed(1);
        const clusters = Array.isArray(tel.clusters) && tel.clusters.length
          ? tel.clusters.map(cl => `${cl.count}× ${cl.maxGhz || cl.maxMhz || ''} (${cl.label || cl.tier || 'core'})`).join(' + ')
          : (tel.cpuSummary || ((tel.totalCores || 8) + ' Cores'));

        const sections = [
          {
            title: 'Device & Hardware Profile',
            rows: [
              ['Device Model', tel.model || 'Unknown Android Device'],
              ['SoC / Chipset', tel.soc || 'Unknown'],
              ['CPU Clusters', clusters],
              ['Total CPU Cores', String(tel.totalCores || '—')],
              ['ABI Architecture', tel.abi || 'arm64-v8a'],
              ['Android OS', tel.androidVersion || 'Android'],
              ['RAM', tel.ramSummary || (tel.ramTotalGB ? (tel.ramTotalGB + ' GB') : '—')],
              ['Internal Storage', tel.internalSummary || '—'],
              ['SD / OTG Storage', tel.externalSummary || 'None']
            ]
          },
          {
            title: 'Benchmark & Best Supported Formats (Verified)',
            rows: [
              ['1080p60 x264 Benchmark', fps + ' fps (' + ((benchObj && benchObj.threads) || st.defaultThreads || '8') + ' threads)'],
              ['MP4 · H.264 (yuv420p 8-bit)', (c.h264HwDecode ? 'HW Decode ✓' : 'SW Decode') + ' · ' + (c.h264HwEncode ? 'HW Encode ✓' : 'CPU x264')],
              ['MKV · HEVC 10-bit (yuv420p10le)', (c.hevc10bitHwDecode ? '10-bit HW Decode ✓' : 'Software 10-bit Decode') + ' · ' + (c.hevcHwEncode ? 'HEVC HW Encode ✓' : 'CPU x265')],
              ['MP4 / MKV · AV1 (libsvtav1 / libaom)', (c.av1HwDecode ? 'AV1 HW Decode ✓' : 'No AV1 HW Decode') + ' · ' + (c.av1HwEncode ? 'AV1 HW Encode ✓' : 'CPU Encode')],
              ['H.264 10-bit (Hi10P)', c.h264_10bitHwDecode ? 'Hardware 10-bit AVC Decode ✓' : 'Avoid (No Hi10P HW Decoder)'],
              ['Photos & Audio Engine', 'Native Skia + HeifWriter Photo Engine · FFmpeg Audio (Opus / FLAC / AAC / MP3)']
            ]
          },
          {
            title: 'Active Engine & Thread Settings',
            rows: [
              ['Default CPU Threads (-threads)', String(st.defaultThreads || '8') + ' Threads'],
              ['Encoder Engine Preference', st.hwPreference === 'hw_fast' ? 'Hardware MediaCodec Fast (Auto SW Fallback)' : 'Software Quality First (x264 / x265)'],
              ['Thermal Guard', st.thermalGuard !== false ? 'Enabled (45°C → 4T, 48°C → 2T)' : 'Disabled'],
              ['Keep Screen Awake', st.keepScreenAwake ? 'Enabled during active runs' : 'Disabled'],
              ['FFmpeg Log Level', String(st.logLevel || 'info')],
              ['Default Vault Folder', st.defaultVaultFolder || '/storage/emulated/0/ConversionVault']
            ]
          }
        ];
        return { model: tel.model || 'device', generatedAt: new Date().toISOString(), telemetry: tel, benchmark: benchObj || {}, settings: st, sections };
      }

      function formatDeviceReport(data, fmt) {
        if (fmt === 'json') return JSON.stringify(data, null, 2);
        const escH = (s) => String(s || '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (fmt === 'txt') {
          const lines = [
            '============================================================',
            'CONVERSION VAULT — DEVICE & ENGINE HARDWARE REPORT',
            '============================================================',
            'Device    : ' + data.model,
            'Generated : ' + data.generatedAt,
            ''
          ];
          data.sections.forEach(sec => {
            lines.push('--- ' + sec.title.toUpperCase() + ' ---');
            sec.rows.forEach(([k, v]) => lines.push(String(k).padEnd(32, ' ') + ': ' + String(v)));
            lines.push('');
          });
          return lines.join('\n');
        }
        if (fmt === 'md') {
          const lines = ['# Conversion Vault — Device & Engine Report', '', '- **Device:** ' + data.model, '- **Generated:** ' + data.generatedAt, ''];
          data.sections.forEach(sec => {
            lines.push('## ' + sec.title, '| Parameter | Value |', '| --- | --- |');
            sec.rows.forEach(([k, v]) => lines.push('| ' + String(k).replace(/\|/g, '\\|') + ' | ' + String(v).replace(/\|/g, '\\|') + ' |'));
            lines.push('');
          });
          return lines.join('\n');
        }
        if (fmt === 'csv') {
          const ce = (v) => '"' + String(v || '').replace(/"/g, '""') + '"';
          const out = ['Section,Parameter,Value'];
          data.sections.forEach(sec => sec.rows.forEach(([k, v]) => out.push([ce(sec.title), ce(k), ce(v)].join(','))));
          return out.join('\n');
        }
        // Standalone styled HTML report
        const bodyHtml = data.sections.map(sec =>
          '<h2>' + escH(sec.title) + '</h2><table><tbody>' +
          sec.rows.map(([k, v]) => '<tr><th>' + escH(k) + '</th><td>' + escH(v) + '</td></tr>').join('') +
          '</tbody></table>'
        ).join('');
        return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>Device Report — ' + escH(data.model) + '</title>' +
          '<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#090d16;color:#f8fafc;padding:20px;max-width:780px;margin:0 auto;line-height:1.45;}' +
          'h1{font-size:18px;margin-bottom:4px;color:#fcd116;} .meta{font-family:monospace;font-size:12px;color:#94a3b8;margin-bottom:18px;}' +
          'h2{font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#fcd116;margin:18px 0 8px;border-bottom:1px solid #1e293b;padding-bottom:4px;}' +
          'table{width:100%;border-collapse:collapse;background:#0f1624;border:1px solid #1e293b;border-radius:8px;overflow:hidden;}' +
          'th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #1e293b;font-family:monospace;font-size:12px;word-break:break-word;}' +
          'th{color:#94a3b8;width:40%;background:#131c2e;} td{color:#f8fafc;}</style></head><body>' +
          '<h1>Conversion Vault — Device &amp; Engine Report</h1>' +
          '<div class="meta">Device: ' + escH(data.model) + ' · Generated: ' + escH(data.generatedAt) + '</div>' +
          bodyHtml + '</body></html>';
      }

      if (bExpHw) {
        bExpHw.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          if (!hasBridge) { toast('Device report export runs inside Android APK'); return; }
          const fmt = (selHwFmt && selHwFmt.value) || 'txt';
          let existingBench = null;
          try {
            const stNow = JSON.parse(window.AndroidBridge.getSettings() || '{}');
            if (stNow.hwTestJson) existingBench = JSON.parse(stNow.hwTestJson);
          } catch (_) {}

          const finalizeExport = (benchObj) => {
            const data = buildDeviceReportData(benchObj);
            const content = formatDeviceReport(data, fmt);
            const safeModel = String(data.model || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'device';
            try {
              const res = JSON.parse(window.AndroidBridge.exportInspectorReport('device_report_' + safeModel, fmt, content) || '{}');
              if (res && res.ok) {
                lastHwExportPath = res.path || '';
                if (hwExpLbl) hwExpLbl.textContent = '✓ Saved ' + (res.name || ('device_report.' + fmt)) + ' → Reports/';
                if (hwExpBar) hwExpBar.classList.remove('hidden');
                toast('Exported ' + (res.name || ('.' + fmt)) + ' ✓');
              } else {
                toast('Export failed: ' + ((res && res.error) || 'Error'));
              }
            } catch (err) {
              toast('Export error: ' + err.message);
            }
          };

          if (existingBench && existingBench.ok && existingBench.fps > 0) {
            finalizeExport(existingBench);
          } else if (typeof window.AndroidBridge.runBenchmark === 'function') {
            bExpHw.disabled = true;
            bExpHw.textContent = '⏳ Benchmarking & Exporting...';
            toast('Running device benchmark & format check first...');
            setTimeout(() => {
              try {
                const bRes = JSON.parse(window.AndroidBridge.runBenchmark() || '{}');
                if (bRes && bRes.ok && bRes.fps > 0) {
                  const bLbl = document.getElementById('lbl-bench');
                  if (bLbl) bLbl.textContent = 'Verified: ~' + bRes.fps + ' fps (1080p60 x264 · ' + (bRes.threads || 8) + 'T)';
                  renderTestedDeviceFormats(bRes);
                }
                finalizeExport(bRes);
              } catch (_) {
                finalizeExport(null);
              }
              bExpHw.disabled = false;
              bExpHw.textContent = 'Export Report ↗';
            }, 40);
          } else {
            finalizeExport(null);
          }
        }, true);
      }

      const bHwOpenFile = document.getElementById('btn-hw-open-file');
      if (bHwOpenFile) bHwOpenFile.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        if (lastHwExportPath && hasBridge && window.AndroidBridge.openFile) window.AndroidBridge.openFile(lastHwExportPath);
      }, true);
      const bHwOpenFm = document.getElementById('btn-hw-open-fm');
      if (bHwOpenFm) bHwOpenFm.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        const dir = lastHwExportPath && lastHwExportPath.includes('/') ? lastHwExportPath.slice(0, lastHwExportPath.lastIndexOf('/')) : '';
        if (hasBridge && window.AndroidBridge.openFolder) window.AndroidBridge.openFolder(dir);
      }, true);

      function fmtCacheBytes(b) {
        const n = Math.max(0, Number(b) || 0);
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(2) + ' MB';
      }

      const bClearCache = document.getElementById('btn-clear-cache');
      if (bClearCache) bClearCache.addEventListener('click', (e) => {
        if (!hasBridge || typeof window.AndroidBridge.clearCache !== 'function') return;
        e.preventDefault(); e.stopImmediatePropagation();
        const r = JSON.parse(window.AndroidBridge.clearCache() || '{}');
        const freedStr = fmtCacheBytes(r.bytesFreed || 0);
        const remStr = fmtCacheBytes(r.remainingBytes || 0);
        const cLbl = document.getElementById('lbl-cache');
        if (cLbl) cLbl.textContent = (r.remainingBytes > 0) ? (remStr + ' cached temp files') : '0 B cached (Clean)';
        toast((r.bytesFreed > 0) ? ('Cleared ' + freedStr + ' of cache ✓') : 'Cache is already clean ✓');
      }, true);

      // Hydrate all saved Settings dropdowns & Vault Folder path from SharedPreferences
      if (hasBridge && typeof window.AndroidBridge.getSettings === 'function') {
        try {
          const s = JSON.parse(window.AndroidBridge.getSettings());
          const vLbl = document.getElementById('lbl-vault-path') || document.querySelector('.vault-path, .path-val');
          if (vLbl && s.defaultVaultFolder) vLbl.textContent = s.defaultVaultFolder.replace(/\/$/, '') + '/';

          const map = [
            ['sel-def-sub', 'defaultSubfolderStyle'],
            ['sel-def-suffix', 'defaultSuffixRule'],
            ['sel-src-policy', 'originalSourcePolicy'],
            ['sel-def-threads', 'defaultThreads'],
            ['sel-hw-pref', 'hwPreference'],
            ['sel-loglevel', 'logLevel'],
            ['sel-def-meta', 'defaultMetadataPolicy'],
            ['sel-sample-ttl', 'sampleRetentionDays'],
            ['sel-preset-ttl', 'presetRetentionDays'],
            ['sel-history-ttl', 'historyRetentionDays']
          ];
          map.forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (s[key] !== undefined && s[key] !== null) {
              let targetVal = String(s[key]);
              if (key === 'originalSourcePolicy' && targetVal.toUpperCase() === 'KEEP') targetVal = 'keep';
              if (key === 'defaultSuffixRule' && targetVal === 'orig') targetVal = 'none';
              if (key === 'hwPreference' && targetVal === 'sw_quality') targetVal = 'sw_hq';
              if (key === 'defaultThreads' && targetVal === 'auto') targetVal = '8';
              if ((key === 'sampleRetentionDays' || key === 'presetRetentionDays' || key === 'historyRetentionDays') && (targetVal === '0' || targetVal === '-1')) targetVal = 'never';
              if (Array.from(el.options).some(o => o.value === targetVal)) {
                el.value = targetVal;
              }
            }
            el.addEventListener('change', () => {
              const payload = {};
              payload[key] = (key === 'sampleRetentionDays' || key === 'presetRetentionDays' || key === 'historyRetentionDays') ? (el.value === 'never' ? 0 : (parseInt(el.value, 10) || (key === 'sampleRetentionDays' ? 15 : 30))) : el.value;
              window.AndroidBridge.saveSettings(JSON.stringify(payload));
              toast('Setting saved ✓');
            });
          });
          const chkSepDef = document.getElementById('chk-def-separate');
          if (chkSepDef) {
            if (typeof s.separateByType === 'boolean') chkSepDef.checked = s.separateByType;
            chkSepDef.addEventListener('change', () => {
              window.AndroidBridge.saveSettings(JSON.stringify({ separateByType: !!chkSepDef.checked }));
              toast('Setting saved ✓');
            });
          }
          const bLblInit = document.getElementById('lbl-bench');
          if (bLblInit && s.benchFps > 0) {
            bLblInit.textContent = 'Verified: ~' + Number(s.benchFps).toFixed(1) + ' fps (1080p60 x264)';
          }
          if (s.hwTestJson) {
            try { renderTestedDeviceFormats(JSON.parse(s.hwTestJson)); } catch (_) {}
          }
          const cLblInit = document.getElementById('lbl-cache');
          if (cLblInit && typeof s.cacheSizeBytes === 'number') {
            cLblInit.textContent = (s.cacheSizeBytes > 0) ? (fmtCacheBytes(s.cacheSizeBytes) + ' cached temp files') : '0 B cached (Clean)';
          }
          const refreshBatteryOptUi = () => {
            const lbl = document.getElementById('lbl-battery-opt');
            const btn = document.getElementById('btn-battery-opt');
            if (!lbl || !btn || !hasBridge || typeof window.AndroidBridge.getBatteryOptimizationStatus !== 'function') return;
            try {
              const b = JSON.parse(window.AndroidBridge.getBatteryOptimizationStatus() || '{}');
              if (b && b.unrestricted) {
                lbl.textContent = 'No Restrictions ✓ — conversions keep running when you leave the app';
                lbl.style.color = 'var(--emerald)';
                btn.textContent = 'Settings ↗';
                btn.style.borderColor = 'var(--emerald)';
                btn.style.color = 'var(--emerald)';
              } else {
                lbl.textContent = 'Battery Saver active — tap Allow so conversions do not pause in background';
                lbl.style.color = 'var(--gold-text)';
                btn.textContent = 'Allow ↗';
                btn.style.borderColor = 'var(--gold)';
                btn.style.color = 'var(--gold-text)';
              }
            } catch (_) {}
          };
          refreshBatteryOptUi();
          window.onVaultAppResumed = refreshBatteryOptUi;
          const bBattOpt = document.getElementById('btn-battery-opt');
          if (bBattOpt && !bBattOpt.__cvWired) {
            bBattOpt.__cvWired = true;
            bBattOpt.addEventListener('click', (e) => {
              e.preventDefault(); e.stopImmediatePropagation();
              if (hasBridge && typeof window.AndroidBridge.requestBatteryUnrestricted === 'function') {
                window.AndroidBridge.requestBatteryUnrestricted();
              } else {
                toast('Open App Info → Battery → No restrictions');
              }
            }, true);
          }

          const chkTherm = document.getElementById('chk-thermal-guard');
          if (chkTherm) {
            if (typeof s.thermalGuard === 'boolean') chkTherm.checked = s.thermalGuard;
            chkTherm.addEventListener('change', () => {
              window.AndroidBridge.saveSettings(JSON.stringify({ thermalGuard: !!chkTherm.checked }));
              toast('Thermal Guard ' + (chkTherm.checked ? 'enabled' : 'disabled'));
            });
          }
          const chkAwake = document.getElementById('chk-keep-awake');
          if (chkAwake) {
            if (typeof s.keepScreenAwake === 'boolean') chkAwake.checked = s.keepScreenAwake;
            chkAwake.addEventListener('change', () => {
              window.AndroidBridge.saveSettings(JSON.stringify({ keepScreenAwake: !!chkAwake.checked }));
              toast('Keep Screen Awake ' + (chkAwake.checked ? 'ON' : 'OFF'));
            });
          }
        } catch (_) {}
      }
      if (bOpenFm) bOpenFm.addEventListener('click', (e) => { if (hasBridge) { e.preventDefault(); e.stopImmediatePropagation(); window.AndroidBridge.openFolder(''); } }, true);
      if (bExportPresets) bExportPresets.addEventListener('click', (e) => {
        if (hasBridge) {
          e.preventDefault(); e.stopImmediatePropagation();
          const res = JSON.parse(window.AndroidBridge.exportPresetsJson());
          toast('Exported: ' + (res.path || 'Presets'));
        }
      }, true);

      // Live-sync Settings Presets 100% from Room SQLite (checkbox selection, Delete Duplicates, Export Selected)
      const selectedPresetIds = new Set();
      let cachedSettingsPresets = [];

      function updatePresetSelectionUI() {
        const selCount = selectedPresetIds.size;
        const total = cachedSettingsPresets.length;
        const lbl = document.getElementById('lbl-preset-sel-count');
        const btnAll = document.getElementById('btn-preset-sel-all');
        const btnExpSel = document.getElementById('btn-export-selected-presets');
        if (lbl) lbl.textContent = selCount + ' selected';
        if (btnAll) btnAll.textContent = (total > 0 && selCount === total) ? 'Clear All' : 'Select All';
        if (btnExpSel) btnExpSel.textContent = 'Export Selected (' + selCount + ')';
      }

      function renderSettingsSavedPresets() {
        const listEl = document.getElementById('settings-saved-presets-list');
        const subEl = document.getElementById('lbl-saved-presets-sub');
        const badgeEl = document.getElementById('badge-saved-presets');
        if (!listEl) return;

        const items = [];
        let customCount = 0;
        let builtinCount = 0;
        const activeIds = new Set();
        if (hasBridge && typeof window.AndroidBridge.getPresets === 'function') {
          try {
            const roomList = JSON.parse(window.AndroidBridge.getPresets(false) || '[]');
            roomList.forEach(p => {
              let parsed = {};
              try { parsed = JSON.parse(p.extraFlags || '{}'); } catch (_) {}
              const cat = p.category || 'Video';
              const nm = p.name || 'Preset';
              const isB = !!p.isBuiltIn;
              if (isB) builtinCount++; else customCount++;
              const summary = parsed.specs || (cat.toUpperCase() + ' · .' + (p.container || 'mp4') + ' · ' + (p.codec || 'libx264') + (p.crfOrBitrate ? ' · ' + p.crfOrBitrate : ''));
              const pid = String(p.id || '');
              activeIds.add(pid);
              items.push({ id: pid, name: nm, category: cat, container: p.container || 'mp4', codec: p.codec || 'libx264', crfOrBitrate: p.crfOrBitrate || '', isBuiltIn: isB, sub: summary, origin: isB ? 'BUILT-IN' : 'CUSTOM' });
            });
          } catch (_) {}
        }

        cachedSettingsPresets = items;
        Array.from(selectedPresetIds).forEach(id => { if (!activeIds.has(id)) selectedPresetIds.delete(id); });

        const count = items.length;
        if (subEl) subEl.textContent = count === 0
          ? 'No active presets · Open Presets tab to create or restore'
          : (count + ' preset' + (count === 1 ? '' : 's') + ' (' + builtinCount + ' built-in · ' + customCount + ' custom) · Select to export');
        if (badgeEl) badgeEl.textContent = count + ' PRESETS';

        const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        listEl.innerHTML = count === 0
          ? '<div class="cap-row"><div class="cap-l"><span class="cap-name">No active presets</span><span class="cap-sub">Open the Presets tab to create or restore presets.</span></div></div>'
          : items.map(it => {
              const checked = selectedPresetIds.has(it.id);
              return '<label class="cap-row" style="cursor:pointer; align-items:flex-start; gap:10px;' + (checked ? ' border-color:var(--gold); background:rgba(252,209,22,0.06);' : '') + '">' +
                '<input type="checkbox" class="preset-sel-chk" data-preset-id="' + esc(it.id) + '" ' + (checked ? 'checked' : '') + ' style="margin-top:3px; accent-color:var(--gold); width:16px; height:16px; flex-shrink:0;">' +
                '<div class="cap-l" style="flex:1; min-width:0;">' +
                  '<span class="cap-name">' + esc(it.name) + ' <span style="font-size:9.5px; font-family:var(--mono); padding:1px 5px; border-radius:4px; margin-left:4px; background:' + (it.origin === 'CUSTOM' ? 'var(--gold-soft)' : 'var(--card-elev)') + '; color:' + (it.origin === 'CUSTOM' ? 'var(--gold-text)' : 'var(--muted)') + ';">' + it.origin + '</span></span>' +
                  '<span class="cap-sub">' + esc(it.sub) + '</span>' +
                '</div>' +
              '</label>';
            }).join('');

        updatePresetSelectionUI();
      }

      const presetsListWrap = document.getElementById('settings-saved-presets-list');
      if (presetsListWrap) {
        presetsListWrap.addEventListener('change', (e) => {
          const chk = e.target.closest('.preset-sel-chk');
          if (!chk) return;
          const pid = chk.getAttribute('data-preset-id') || '';
          if (!pid) return;
          if (chk.checked) selectedPresetIds.add(pid);
          else selectedPresetIds.delete(pid);
          const row = chk.closest('.cap-row');
          if (row) {
            row.style.borderColor = chk.checked ? 'var(--gold)' : '';
            row.style.background = chk.checked ? 'rgba(252,209,22,0.06)' : '';
          }
          updatePresetSelectionUI();
        });
      }

      const bSelAllPresets = document.getElementById('btn-preset-sel-all');
      if (bSelAllPresets) {
        bSelAllPresets.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          if (cachedSettingsPresets.length === 0) return;
          if (selectedPresetIds.size === cachedSettingsPresets.length) {
            selectedPresetIds.clear();
          } else {
            cachedSettingsPresets.forEach(p => { if (p.id) selectedPresetIds.add(p.id); });
          }
          requestAnimationFrame(() => setTimeout(() => { try { renderSettingsSavedPresets(); } catch (_) {} }, 35));

      // 6. Workflows Settings Library (mirrors Presets Settings Library exactly)
      const selWfTtl = document.getElementById('sel-workflow-ttl');
      if (selWfTtl) {
        const savedWfTtl = safeGet('cv_workflow_trash_ttl', '30') || '30';
        if (Array.from(selWfTtl.options).some(o => o.value === savedWfTtl)) selWfTtl.value = savedWfTtl;
        selWfTtl.addEventListener('change', () => {
          safeSet('cv_workflow_trash_ttl', selWfTtl.value || '30');
          toast('Saved workflow trash retention');
        });
      }

      const selectedWorkflowIds = new Set();
      let cachedSettingsWorkflows = [];

      function readAllWorkflowsRaw() {
        try {
          const arr = JSON.parse(safeGet('cv_workflows_v1', '[]') || '[]');
          return Array.isArray(arr) ? arr : [];
        } catch (_) { return []; }
      }
      function writeAllWorkflowsRaw(list) {
        safeSet('cv_workflows_v1', JSON.stringify(list || []));
      }

      function updateWorkflowSelectionUI() {
        const cntEl = document.getElementById('lbl-wf-settings-sel-count');
        const btnAll = document.getElementById('btn-wf-settings-sel-all');
        const btnExpSel = document.getElementById('btn-export-selected-workflows');
        const total = cachedSettingsWorkflows.length;
        const selCount = selectedWorkflowIds.size;
        if (cntEl) cntEl.textContent = selCount + ' selected';
        if (btnAll) btnAll.textContent = (total > 0 && selCount === total) ? 'Clear All' : 'Select All';
        if (btnExpSel) btnExpSel.textContent = 'Export Selected (' + selCount + ')';
      }

      function renderSettingsSavedWorkflows() {
        const listEl = document.getElementById('settings-saved-workflows-list');
        const subEl = document.getElementById('lbl-saved-workflows-sub');
        const badgeEl = document.getElementById('badge-saved-workflows');
        if (!listEl) return;

        const all = readAllWorkflowsRaw();
        const active = all.filter(w => w && !w.deleted);
        const activeIds = new Set(active.map(w => String(w.id || '')));
        cachedSettingsWorkflows = active;
        Array.from(selectedWorkflowIds).forEach(id => { if (!activeIds.has(id)) selectedWorkflowIds.delete(id); });

        const count = active.length;
        if (subEl) subEl.textContent = count === 0
          ? 'No active workflows · Open Workflows tab to create or import'
          : (count + ' saved workflow' + (count === 1 ? '' : 's') + ' · Select to export');
        if (badgeEl) badgeEl.textContent = count + ' WORKFLOWS';

        const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        function wfSubSummary(w) {
          const v = (w.video && w.video.presetId && w.video.presetId !== '__skip__') ? 'Video' : null;
          const a = (w.audio && w.audio.presetId && w.audio.presetId !== '__skip__') ? 'Audio' : null;
          const i = (w.image && w.image.presetId && w.image.presetId !== '__skip__') ? 'Image' : null;
          const routes = [v, a, i].filter(Boolean).join(' · ') || 'No active routes';
          return routes + (w.desc ? (' · ' + w.desc) : '');
        }

        listEl.innerHTML = count === 0
          ? '<div class="cap-row"><div class="cap-l"><span class="cap-name">No saved workflows</span><span class="cap-sub">Open the Workflows tab to create or import workflows.</span></div></div>'
          : active.map(w => {
              const wid = String(w.id || '');
              const checked = selectedWorkflowIds.has(wid);
              return '<label class="cap-row" style="cursor:pointer; align-items:flex-start; gap:10px;' + (checked ? ' border-color:var(--gold); background:rgba(252,209,22,0.06);' : '') + '">' +
                '<input type="checkbox" class="wf-settings-sel-chk" data-wf-id="' + esc(wid) + '" ' + (checked ? 'checked' : '') + ' style="margin-top:3px; accent-color:var(--gold); width:16px; height:16px; flex-shrink:0;">' +
                '<div class="cap-l" style="flex:1; min-width:0;">' +
                  '<span class="cap-name">' + esc(w.name || 'Workflow') + ' <span style="font-size:9.5px; font-family:var(--mono); padding:1px 5px; border-radius:4px; margin-left:4px; background:var(--gold-soft); color:var(--gold-text);">WORKFLOW</span></span>' +
                  '<span class="cap-sub">' + esc(wfSubSummary(w)) + '</span>' +
                '</div>' +
              '</label>';
            }).join('');

        updateWorkflowSelectionUI();
      }

      const wfListWrap = document.getElementById('settings-saved-workflows-list');
      if (wfListWrap) {
        wfListWrap.addEventListener('change', (e) => {
          const chk = e.target.closest('.wf-settings-sel-chk');
          if (!chk) return;
          const wid = chk.getAttribute('data-wf-id') || '';
          if (!wid) return;
          if (chk.checked) selectedWorkflowIds.add(wid); else selectedWorkflowIds.delete(wid);
          const row = chk.closest('.cap-row');
          if (row) {
            row.style.borderColor = chk.checked ? 'var(--gold)' : '';
            row.style.background = chk.checked ? 'rgba(252,209,22,0.06)' : '';
          }
          updateWorkflowSelectionUI();
        });
      }

      const bSelAllWfs = document.getElementById('btn-wf-settings-sel-all');
      if (bSelAllWfs) {
        bSelAllWfs.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          if (cachedSettingsWorkflows.length === 0) return;
          if (selectedWorkflowIds.size === cachedSettingsWorkflows.length) selectedWorkflowIds.clear();
          else cachedSettingsWorkflows.forEach(w => { if (w.id) selectedWorkflowIds.add(String(w.id)); });
          requestAnimationFrame(() => setTimeout(() => { try { renderSettingsSavedWorkflows(); } catch (_) {} }, 55));

      // 8. Selective Full Vault Backup & Restore (Settings + Presets + Workflows)
      const bVaultExp = document.getElementById('btn-vault-export-bundle');
      const bVaultImp = document.getElementById('btn-vault-import-bundle');
      const inpVaultImp = document.getElementById('inp-vault-import-bundle');

      if (bVaultExp) {
        bVaultExp.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          const incSettings = !!(document.getElementById('chk-bak-settings') && document.getElementById('chk-bak-settings').checked);
          const incPresets = !!(document.getElementById('chk-bak-presets') && document.getElementById('chk-bak-presets').checked);
          const incWorkflows = !!(document.getElementById('chk-bak-workflows') && document.getElementById('chk-bak-workflows').checked);
          if (!incSettings && !incPresets && !incWorkflows) {
            toast('Select at least one category to export');
            return;
          }
          const bundle = {
            format: 'conversion_vault_backup_v1',
            exportedAt: new Date().toISOString(),
            included: { settings: incSettings, presets: incPresets, workflows: incWorkflows }
          };
          if (incSettings) {
            let stObj = {};
            try {
              if (hasBridge && typeof window.AndroidBridge.getSettings === 'function') {
                stObj = JSON.parse(window.AndroidBridge.getSettings() || '{}');
              }
            } catch (_) {}
            delete stObj.cacheSizeBytes;
            delete stObj.hwTestJson;
            delete stObj.benchFps;
            stObj.workflowTrashTtl = safeGet('cv_workflow_trash_ttl', '30') || '30';
            bundle.settings = stObj;
          }
          if (incPresets) {
            let prArr = [];
            try {
              if (hasBridge && typeof window.AndroidBridge.getPresets === 'function') {
                prArr = JSON.parse(window.AndroidBridge.getPresets(false) || '[]');
              }
            } catch (_) {}
            bundle.presets = Array.isArray(prArr) ? prArr : [];
          }
          if (incWorkflows) {
            bundle.workflows = window.VaultWorkflows ? window.VaultWorkflows.listActive() : getSavedWorkflows();
          }
          const nowD = new Date();
          const dTag = String(nowD.getFullYear()) + String(nowD.getMonth() + 1).padStart(2, '0') + String(nowD.getDate()).padStart(2, '0');
          const baseName = 'conversion_vault_backup_' + dTag;
          const jsonStr = JSON.stringify(bundle, null, 2);
          if (hasBridge && typeof window.AndroidBridge.exportVaultBackupJson === 'function') {
            try {
              const res = JSON.parse(window.AndroidBridge.exportVaultBackupJson(baseName, jsonStr) || '{}');
              if (res && res.ok) {
                toast('Backup saved → Backups/' + (res.name || (baseName + '.json')));
                return;
              }
              toast('Backup failed: ' + ((res && res.error) || 'Unknown error'));
              return;
            } catch (_) {}
          }
          try {
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = baseName + '.json';
            a.click();
            toast('Exported ' + baseName + '.json');
          } catch (_) { toast('Backup export failed'); }
        }, true);
      }

      if (bVaultImp && inpVaultImp) {
        bVaultImp.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          const incSettings = !!(document.getElementById('chk-bak-settings') && document.getElementById('chk-bak-settings').checked);
          const incPresets = !!(document.getElementById('chk-bak-presets') && document.getElementById('chk-bak-presets').checked);
          const incWorkflows = !!(document.getElementById('chk-bak-workflows') && document.getElementById('chk-bak-workflows').checked);
          if (!incSettings && !incPresets && !incWorkflows) {
            toast('Select at least one category to import');
            return;
          }
          inpVaultImp.value = '';
          inpVaultImp.click();
        }, true);

        inpVaultImp.addEventListener('change', () => {
          const file = inpVaultImp.files && inpVaultImp.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const rawText = String(reader.result || '');
              if (window.VaultJsonGuard) {
                const baseChk = window.VaultJsonGuard.validateJson(rawText, 'generic');
                if (!baseChk.ok) { toast('🛡️ Blocked unsafe backup JSON: ' + baseChk.reason); return; }
              }
              const parsed = JSON.parse(rawText);
              if (!parsed || typeof parsed !== 'object' || parsed.format !== 'conversion_vault_backup_v1') {
                toast('Invalid Conversion Vault backup file');
                return;
              }
              const incSettings = !!(document.getElementById('chk-bak-settings') && document.getElementById('chk-bak-settings').checked);
              const incPresets = !!(document.getElementById('chk-bak-presets') && document.getElementById('chk-bak-presets').checked);
              const incWorkflows = !!(document.getElementById('chk-bak-workflows') && document.getElementById('chk-bak-workflows').checked);
              const restoredParts = [];

              if (incSettings && parsed.settings && typeof parsed.settings === 'object') {
                const st = parsed.settings;
                if (st.workflowTrashTtl) safeSet('cv_workflow_trash_ttl', String(st.workflowTrashTtl));
                if (st.theme) {
                  document.documentElement.setAttribute('data-theme', st.theme);
                  safeSet('cv_theme', st.theme);
                }
                if (hasBridge && typeof window.AndroidBridge.saveSettings === 'function') {
                  window.AndroidBridge.saveSettings(JSON.stringify(st));
                }
                restoredParts.push('Settings');
              }

              if (incPresets && Array.isArray(parsed.presets) && parsed.presets.length > 0) {
                if (window.VaultJsonGuard) {
                  const pChk = window.VaultJsonGuard.validateJson(JSON.stringify(parsed.presets), 'preset');
                  if (!pChk.ok) { toast('🛡️ Blocked unsafe presets in backup: ' + pChk.reason); return; }
                }
                let pCount = 0;
                parsed.presets.forEach(p => {
                  if (p && p.name && hasBridge && typeof window.AndroidBridge.savePreset === 'function') {
                    try {
                      const r = JSON.parse(window.AndroidBridge.savePreset(JSON.stringify(p)) || '{}');
                      if (r && r.ok) pCount++;
                    } catch (_) {}
                  }
                });
                if (pCount > 0) restoredParts.push(pCount + ' Presets');
                if (typeof renderSettingsSavedPresets === 'function') renderSettingsSavedPresets();
              }

              if (incWorkflows && Array.isArray(parsed.workflows) && parsed.workflows.length > 0) {
                if (window.VaultJsonGuard) {
                  const wChk = window.VaultJsonGuard.validateJson(JSON.stringify(parsed.workflows), 'workflow');
                  if (!wChk.ok) { toast('🛡️ Blocked unsafe workflows in backup: ' + wChk.reason); return; }
                }
                if (window.VaultWorkflows && typeof window.VaultWorkflows.importJson === 'function') {
                  const wr = window.VaultWorkflows.importJson(JSON.stringify(parsed.workflows));
                  if (wr && wr.ok && wr.added > 0) restoredParts.push(wr.added + ' Workflows');
                }
                if (typeof renderSettingsSavedWorkflows === 'function') renderSettingsSavedWorkflows();
              }

              if (restoredParts.length === 0) {
                toast('Selected sections were not found in this backup file');
              } else {
                toast('✓ Restored: ' + restoredParts.join(', '));
                if (incSettings && parsed.settings) {
                  setTimeout(() => window.location.reload(), 650);
                }
              }
            } catch (_) {
              toast('Could not parse backup JSON');
            }
          };
          reader.readAsText(file);
        });
      }

        }, true);
      }

      const bDedupeWfs = document.getElementById('btn-dedupe-workflows');
      if (bDedupeWfs) {
        bDedupeWfs.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          if (window.VaultWorkflows) {
            const r = window.VaultWorkflows.dedupe();
            (r.removedIds || []).forEach(id => selectedWorkflowIds.delete(id));
            renderSettingsSavedWorkflows();
            toast(r.removed > 0 ? ('Removed ' + r.removed + ' duplicate workflow' + (r.removed === 1 ? '' : 's') + ' ✓') : 'No duplicate workflows found');
            return;
          }
          const all = readAllWorkflowsRaw();
          const seen = new Set();
          let removed = 0;
          const kept = [];
          all.forEach(w => {
            if (!w || w.deleted) { kept.push(w); return; }
            const sig = [
              String(w.name || '').trim().toLowerCase(),
              w.video && w.video.presetId, w.video && w.video.outputDir,
              w.audio && w.audio.presetId, w.audio && w.audio.outputDir,
              w.image && w.image.presetId, w.image && w.image.outputDir
            ].join('|');
            if (seen.has(sig)) {
              removed++;
              selectedWorkflowIds.delete(String(w.id || ''));
            } else {
              seen.add(sig);
              kept.push(w);
            }
          });
          if (removed > 0) writeAllWorkflowsRaw(kept);
          renderSettingsSavedWorkflows();
          toast(removed > 0 ? ('Removed ' + removed + ' duplicate workflow' + (removed === 1 ? '' : 's') + ' ✓') : 'No duplicate workflows found');
        }, true);
      }

      function exportWfJsonFromSettings(items, baseName) {
        const str = JSON.stringify(items.length === 1 ? items[0] : items, null, 2);
        if (hasBridge && typeof window.AndroidBridge.exportWorkflowJson === 'function') {
          try {
            const res = JSON.parse(window.AndroidBridge.exportWorkflowJson(baseName, str) || '{}');
            if (res && res.ok) {
              toast('Exported ' + items.length + ' workflow' + (items.length === 1 ? '' : 's') + ' → ' + (res.path || 'Workflows'));
              return;
            }
            toast('Export failed: ' + ((res && res.error) || 'Unknown error'));
            return;
          } catch (_) {}
        }
        try {
          const blob = new Blob([str], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = baseName + '.json';
          a.click();
          toast('Exported ' + items.length + ' workflow' + (items.length === 1 ? '' : 's'));
        } catch (_) { toast('Export failed'); }
      }

      const bExportAllWfs = document.getElementById('btn-export-workflows');
      if (bExportAllWfs) {
        bExportAllWfs.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          if (!cachedSettingsWorkflows.length) { toast('No workflows to export'); return; }
          exportWfJsonFromSettings(cachedSettingsWorkflows, 'conversion_vault_workflows');
        }, true);
      }

      const bExportSelWfs = document.getElementById('btn-export-selected-workflows');
      if (bExportSelWfs) {
        bExportSelWfs.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          const picked = cachedSettingsWorkflows.filter(w => selectedWorkflowIds.has(String(w.id || '')));
          if (!picked.length) { toast('Select at least 1 workflow to export'); return; }
          exportWfJsonFromSettings(picked, picked.length === 1 ? String(picked[0].name || 'workflow').replace(/[^a-zA-Z0-9_-]/g, '_') : 'conversion_vault_selected_workflows');
        }, true);
      }

      const bImpWfs = document.getElementById('btn-import-workflows');
      const inpImpWfs = document.getElementById('inp-import-workflows-file');
      if (bImpWfs && inpImpWfs) {
        bImpWfs.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          inpImpWfs.value = '';
          inpImpWfs.click();
        }, true);
        inpImpWfs.addEventListener('change', () => {
          const file = inpImpWfs.files && inpImpWfs.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              if (window.VaultJsonGuard) { const chk = window.VaultJsonGuard.validateJson(String(reader.result || ''), 'workflow'); if (!chk.ok) { toast('🛡️ Blocked unsafe JSON: ' + chk.reason); return; } }
              const parsed = JSON.parse(String(reader.result || ''));
              const items = Array.isArray(parsed) ? parsed : [parsed];
              const valid = items.filter(x => x && typeof x === 'object' && x.name && (x.video || x.audio || x.image));
              if (!valid.length) { toast('Invalid workflow JSON file'); return; }
              const all = readAllWorkflowsRaw();
              const existingIds = new Set(all.map(x => x.id));
              let added = 0;
              valid.forEach(v => {
                const id = (v.id && !existingIds.has(v.id)) ? v.id : ('wf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
                existingIds.add(id);
                all.unshift({
                  id: id,
                  name: String(v.name).trim(),
                  desc: String(v.desc || '').trim(),
                  video: { presetId: (v.video && v.video.presetId) || '__skip__', outputDir: (v.video && v.video.outputDir) || '' },
                  audio: { presetId: (v.audio && v.audio.presetId) || '__skip__', outputDir: (v.audio && v.audio.outputDir) || '' },
                  image: { presetId: (v.image && v.image.presetId) || '__skip__', outputDir: (v.image && v.image.outputDir) || '' },
                  rules: Object.assign({ filenameRule: 'keep', customSuffix: '', metaPolicy: 'preset', skipRule: 'none', skipSmallerMB: 5, sourceAction: 'keep' }, v.rules || {}),
                  deleted: false,
                  createdAt: v.createdAt || Date.now(),
                  updatedAt: Date.now()
                });
                added++;
              });
              writeAllWorkflowsRaw(all);
              renderSettingsSavedWorkflows();
              toast('Imported ' + added + ' workflow' + (added === 1 ? '' : 's') + ' ✓');
            } catch (_) {
              toast('Could not parse workflow JSON');
            }
          };
          reader.readAsText(file);
        });
      }

      renderSettingsSavedWorkflows();

        }, true);
      }

      const bDedupePresets = document.getElementById('btn-dedupe-presets');
      if (bDedupePresets) {
        bDedupePresets.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          if (!window.VaultPresets || !window.VaultPresets.hasBridge()) return;
          const r = window.VaultPresets.dedupe();
          (r.removedIds || []).forEach(id => selectedPresetIds.delete(id));
          renderSettingsSavedPresets();
          toast(r.removed > 0 ? ('Removed ' + r.removed + ' duplicate preset' + (r.removed === 1 ? '' : 's') + ' ✓') : 'No duplicate presets found');
        }, true);
      }

      const bExportSelPresets = document.getElementById('btn-export-selected-presets');
      if (bExportSelPresets) {
        bExportSelPresets.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          const ids = Array.from(selectedPresetIds);
          if (ids.length === 0) {
            toast('Select at least 1 preset to export');
            return;
          }
          if (hasBridge && typeof window.AndroidBridge.exportSelectedPresetsJson === 'function') {
            try {
              const res = JSON.parse(window.AndroidBridge.exportSelectedPresetsJson(JSON.stringify(ids)) || '{}');
              if (res && res.ok) {
                toast('Exported ' + (res.count || ids.length) + ' selected preset' + (ids.length === 1 ? '' : 's') + ' → ' + (res.path || 'Presets'));
              } else {
                toast('Export failed: ' + (res.error || 'Unknown error'));
              }
            } catch (_) {
              toast('Export selected failed');
            }
          }
        }, true);
      }

      renderSettingsSavedPresets();
      window.addEventListener('pageshow', renderSettingsSavedPresets);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) renderSettingsSavedPresets();
      });

      // Wire Import JSON button to import exported preset JSON directly into Room
      const bImportPresets = document.getElementById('btn-import-presets');
      const inpImportFile = document.getElementById('inp-import-presets-file');
      if (bImportPresets && inpImportFile) {
        bImportPresets.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          inpImportFile.value = '';
          inpImportFile.click();
        }, true);
        inpImportFile.addEventListener('change', () => {
          const file = inpImportFile.files && inpImportFile.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              if (window.VaultJsonGuard) { const chk = window.VaultJsonGuard.validateJson(String(reader.result || ''), 'preset'); if (!chk.ok) { toast('🛡️ Blocked unsafe JSON: ' + chk.reason); return; } }
                const raw = JSON.parse(String(reader.result || '[]'));
              const arr = Array.isArray(raw) ? raw : [raw];
              let imported = 0;
              arr.forEach(p => {
                if (!p || !p.name) return;
                if (hasBridge && typeof window.AndroidBridge.savePreset === 'function') {
                  window.AndroidBridge.savePreset(JSON.stringify({
                    name: String(p.name),
                    category: String(p.category || 'Video'),
                    container: String(p.container || 'mp4'),
                    codec: String(p.codec || 'libx264'),
                    crfOrBitrate: String(p.crfOrBitrate || '18'),
                    audioCodec: String(p.audioCodec || 'aac'),
                    extraFlags: typeof p.extraFlags === 'string' ? p.extraFlags : JSON.stringify(p.extraFlags || {})
                  }));
                  imported++;
                }
              });
              renderSettingsSavedPresets();
              toast(imported > 0 ? ('Imported ' + imported + ' preset' + (imported === 1 ? '' : 's') + ' ✓') : 'No valid presets found in JSON');
            } catch (_) {
              toast('Invalid preset JSON file');
            }
          };
          reader.readAsText(file);
        });
      }
      if (bBench) bBench.addEventListener('click', (e) => {
        if (hasBridge) {
          e.preventDefault(); e.stopImmediatePropagation();
          const r = JSON.parse(window.AndroidBridge.runQuickBenchmark());
          toast(r.ok ? 'Benchmark: ' + Math.round(r.approxFps) + ' fps' : 'Benchmark failed');
        }
      }, true);

      // Persist Red Bull Dark/Light theme clicks across all 21 pages
      const tGrid = document.getElementById('theme-grid');
      if (tGrid) {
        tGrid.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-set-theme]');
          if (!btn) return;
          const theme = btn.getAttribute('data-set-theme') || 'dark';
          document.documentElement.setAttribute('data-theme', theme);
          safeSet('cv_theme', theme);
          if (hasBridge && typeof window.AndroidBridge.saveSettings === 'function') {
            window.AndroidBridge.saveSettings(JSON.stringify({ theme }));
          }
        });
      }
    }

    if (page === 'conversion_vault_p8_playback_tester.html') {
      const bFm = document.getElementById('btn-gen-fm');
      const bOpenFm = document.getElementById('btn-open-fm');
      const openSamplesDir = () => {
        let baseRoot = '/storage/emulated/0/ConversionVault';
        try {
          const st = JSON.parse(window.AndroidBridge.getSettings() || '{}');
          if (st.defaultVaultFolder) baseRoot = st.defaultVaultFolder.replace(/\/$/, '');
        } catch (_) {}
        window.AndroidBridge.openFolder(baseRoot + '/Samples');
      };
      if (bFm) bFm.addEventListener('click', (e) => { if (hasBridge) { e.preventDefault(); e.stopImmediatePropagation(); openSamplesDir(); } }, true);
      if (bOpenFm) bOpenFm.addEventListener('click', (e) => { if (hasBridge) { e.preventDefault(); e.stopImmediatePropagation(); openSamplesDir(); } }, true);
    }

    // Wire all 8 Quick Tools
    if (page.startsWith('conversion_vault_t')) {
      const bPick = document.getElementById('btn-pick');
      if (bPick) bPick.addEventListener('click', (e) => {
        if (!hasBridge) return;
        e.preventDefault(); e.stopImmediatePropagation();
        window.AndroidBridge.pickFile();
      }, true);

      const TOOL_MOD_DIRS = {
        'conversion_vault_t1_metadata.html': 'Metadata_Modifier',
        'conversion_vault_t2_compressor.html': 'Target_Compressor',
        'conversion_vault_t3_audio.html': 'Audio_Extract_Mute',
        'conversion_vault_t4_inspector.html': 'Reports',
        'conversion_vault_t5_trim_gif.html': 'Trim_GIF',
        'conversion_vault_t6_thumbnail.html': 'Thumbnail_Capturer',
        'conversion_vault_t7_suggestor.html': 'Vault_Core',
        'conversion_vault_t8_integrity.html': 'Vault_Core'
      };
      const bFm = document.getElementById('btn-fm');
      if (bFm) bFm.addEventListener('click', (e) => {
        if (!hasBridge) return;
        e.preventDefault(); e.stopImmediatePropagation();
        let targetDir = '';
        if (typeof window.getOutputDir === 'function') {
          try { targetDir = window.getOutputDir() || ''; } catch (_) {}
        }
        if (!targetDir) {
          let baseRoot = '/storage/emulated/0/ConversionVault';
          try {
            const st = JSON.parse(window.AndroidBridge.getSettings() || '{}');
            if (st.defaultVaultFolder) baseRoot = st.defaultVaultFolder.replace(/\/$/, '');
          } catch (_) {}
          const sub = TOOL_MOD_DIRS[page] || '';
          targetDir = sub ? (baseRoot + '/' + sub) : baseRoot;
        }
        window.AndroidBridge.openFolder(targetDir);
      }, true);

      const bSh = document.getElementById('btn-sh');
      if (bSh) bSh.addEventListener('click', (e) => {
        if (!hasBridge) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const cmdEl = document.querySelector('.cmd-box, pre, code');
        const res = JSON.parse(window.AndroidBridge.exportShellScript('vault_tool.sh', '#!/data/data/com.termux/files/usr/bin/bash\n' + (cmdEl ? cmdEl.textContent : 'ffmpeg -version') + '\n'));
        toast('Saved: ' + (res.path || 'SH_Scripts'));
      }, true);

      const bRun = document.getElementById('btn-run');
      if (bRun && page === 'conversion_vault_t1_metadata.html') bRun.addEventListener('click', (e) => {
        if (!hasBridge) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (page === 'conversion_vault_t1_metadata.html') {
          const spec = typeof window.getMetadataJobSpec === 'function' ? window.getMetadataJobSpec() : null;
          if (!spec) { toast('Pick a file and choose a wipe or edit action'); return; }
          if (typeof window.autoBackupMetadataBeforeWipe === 'function') window.autoBackupMetadataBeforeWipe();
          const res = JSON.parse(window.AndroidBridge.enqueueJob(JSON.stringify(spec)));
          if (res && res.ok) {
            if (res.jobId) safeSet('cv_active_job_id', res.jobId);
            clearActiveSelection();
            navigateTo('conversion_vault_p4a_convert_single.html');
          } else {
            toast('Engine error: ' + ((res && res.error) || 'Failed to queue'));
          }
        } else if (['conversion_vault_t3_audio.html','conversion_vault_t5_trim_gif.html','conversion_vault_t6_thumbnail.html'].includes(page)) {
          const files = getActiveFiles();
          if (!files.length) { toast('Pick a file first'); window.AndroidBridge.pickFile(); return; }
          const modMap = {
            'conversion_vault_t2_compressor.html': ['Target_Compressor', 'Video', 'mp4'],
            'conversion_vault_t3_audio.html': ['Audio_Extract_Mute', 'Audio', 'opus'],
            'conversion_vault_t5_trim_gif.html': ['Trim_GIF', 'Video', 'mp4'],
            'conversion_vault_t6_thumbnail.html': ['Thumbnail_Capturer', 'Image', 'png']
          };
          const [modName, defMedia, defExt] = modMap[page];
          const rawCmd = (document.getElementById('cmd-box')?.textContent || '').replace(/^\$\s*/, '').replace(/^ffmpeg\s+/, '').trim();
          // Extract output extension from last quoted or unquoted token
          const outMatch = rawCmd.match(/\.([a-zA-Z0-9]{2,5})["']?\s*$/);
          const ext = outMatch ? outMatch[1].toLowerCase() : defExt;
          const mediaType = ['opus','flac','mp3','m4a','wav','ac3','ogg'].includes(ext) ? 'Audio' : (['png','jpg','jpeg','webp','avif','gif'].includes(ext) ? 'Image' : defMedia);
          // Replace -i "..." with -i {INPUT} and trailing output token with {OUTPUT}
          let args = rawCmd
            .replace(/-i\s+"[^"]+"/, '-i {INPUT}')
            .replace(/-i\s+\S+/, '-i {INPUT}')
            .replace(/"[^"]+"\s*$/, '{OUTPUT}');
          if (!args.includes('{OUTPUT}')) args = args.replace(/\S+\s*$/, '{OUTPUT}');
          if (!args.includes('{INPUT}')) args = '-y -i {INPUT} -c copy {OUTPUT}';

          const activeDest = document.querySelector('#dest-pills .dest-pill.active')?.getAttribute('data-dest') || 'vault';
          const srcPath = files[0].path || '';
          const srcDir = srcPath.lastIndexOf('/') > 0 ? srcPath.substring(0, srcPath.lastIndexOf('/')) : '';
          const outDir = activeDest === 'source' ? srcDir : (activeDest === 'custom' ? (window.__customToolDir || '') : '');
          const inName = files[0].name || 'output';
          const baseName = inName.lastIndexOf('.') > 0 ? inName.substring(0, inName.lastIndexOf('.')) : inName;
          const probe = JSON.parse(safeGet('cv_last_probe', '{}') || '{}');

          const res = JSON.parse(window.AndroidBridge.enqueueJob(JSON.stringify({
            module: modName,
            mediaType: mediaType,
            inputPath: srcPath,
            outputDir: outDir,
            outputBaseName: baseName,
            outputExt: ext,
            durationMs: Math.round((probe.durationSec || 0) * 1000),
            commandArgs: args
          })));
          if (res && res.ok) {
            safeSet('cv_batch_job_ids', '[]');
            if (res.jobId) safeSet('cv_active_job_id', res.jobId);
            navigateTo('conversion_vault_p4a_convert_single.html');
          } else {
            toast('Engine error: ' + ((res && res.error) || 'Failed to queue'));
          }
        }
      }, true);

      // Stream Inspector (t4_inspector.html) handles its own deepInspectFile & exportReportJson

      if (page === 'conversion_vault_t8_integrity.html') {
        const bRepair = document.getElementById('btn-repair');
        if (bRepair) bRepair.addEventListener('click', (e) => {
          if (!hasBridge) return;
          e.preventDefault(); e.stopImmediatePropagation();
          const files = getActiveFiles();
          const f0 = files[0] || {};
          const rawExt = String(f0.name || f0.path || '').split('.').pop().toLowerCase();
          const isAud = A_EXT.has(rawExt);
          const outExt = isAud ? (['mp3','flac','opus','m4a','wav','ogg'].includes(rawExt) ? rawExt : 'm4a') : (['mkv','mov','webm','mp4'].includes(rawExt) ? rawExt : 'mp4');
          const faststart = (outExt === 'mp4' || outExt === 'mov' || outExt === 'm4a') ? ' -movflags +faststart' : '';
          enqueueSimpleToolJob('Integrity_Repair', isAud ? 'Audio' : 'Video', outExt, '-y -err_detect ignore_err -i {INPUT} -c copy' + faststart + ' {OUTPUT}', 'repaired_output');
        }, true);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const page = currentPage();
    injectGlobalAnimations();
    applySavedTheme();
    window.onVaultHardwareUpdated = hydrateHardwareStrip;
    hydrateHardwareStrip();
    if (page === 'conversion_vault_p1_home.html' && hasBridge && typeof window.AndroidBridge.checkEngineHealth === 'function') {
      setTimeout(() => {
        try {
          const h = JSON.parse(window.AndroidBridge.checkEngineHealth());
          const pill = document.querySelector('.engine-pill');
          if (pill) {
            if (h.ok) {
              pill.innerHTML = '<span class="pulse-dot"></span> FFmpeg · FFprobe · Photo Engine Ready';
            } else {
              pill.style.color = 'var(--crimson)';
              pill.style.background = 'rgba(219,10,64,0.15)';
              pill.style.whiteSpace = 'normal'; pill.style.borderRadius = '8px'; pill.textContent = 'Engine Error: ' + (h.error || 'FFmpeg init failed').slice(0, 260);
            }
          }
        } catch (_) {}
      }, 150);
    }

    const TAB_ORDER = [
      'conversion_vault_p1_home.html',
      'conversion_vault_p5_queue_history.html',
      'conversion_vault_p7_presets.html',
      'conversion_vault_p9_workflows.html',
      'conversion_vault_p6_settings.html'
    ];
    const curTabIdx = TAB_ORDER.indexOf(page);

    // Apply directional entrance animation when arriving via swipe or tab switch
    try {
      const slideDir = sessionStorage.getItem('cv_tab_slide_dir');
      if (slideDir && curTabIdx !== -1) {
        sessionStorage.removeItem('cv_tab_slide_dir');
        const mainEl = document.querySelector('main.content');
        if (mainEl) mainEl.classList.add(slideDir === 'right' ? 'cv-enter-right' : 'cv-enter-left');
      }
    } catch (_) {}

    document.querySelectorAll('.bottom-nav .nav-item[data-nav]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = btn.getAttribute('data-nav');
        if (NAV_ROUTES[key]) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const targetPage = NAV_ROUTES[key];
          const targetIdx = TAB_ORDER.indexOf(targetPage);
          if (targetPage === page) return;
          if (curTabIdx !== -1 && targetIdx !== -1 && targetIdx !== curTabIdx) {
            try { sessionStorage.setItem('cv_tab_slide_dir', targetIdx > curTabIdx ? 'right' : 'left'); } catch (_) {}
          }
          navigateTo(targetPage);
        }
      }, true);
    });

    // GPU-composited silky left/right swipe between the 4 main tabs (Home <-> Queue <-> Presets <-> Settings)
    if (curTabIdx !== -1) {
      let swStartX = 0, swStartY = 0, swActive = false, swLocked = false, swRaf = 0, swPendingShift = 0, swNavigating = false;
      const mainEl = document.querySelector('main.content');
      const applyShift = () => {
        swRaf = 0;
        if (!mainEl || !swLocked) return;
        mainEl.style.transform = 'translate3d(' + swPendingShift.toFixed(1) + 'px, 0, 0)';
      };

      document.addEventListener('touchstart', (e) => {
        if (swNavigating || !e.touches || e.touches.length !== 1) return;
        const tgt = e.target;
        if (tgt && tgt.closest && tgt.closest('input, select, textarea, .modal-backdrop, .modal-sheet, .confirm-card, .chip-row, .filter-row, .subfilter-row, .chip-wrap, .encyc-cats, .seg-tabs, .type-tabs, .f-chip, .sf-chip')) {
          swActive = false;
          return;
        }
        let curNode = tgt && tgt.nodeType === 1 ? tgt : (tgt ? tgt.parentElement : null);
        while (curNode && curNode !== document.body) {
          if (curNode.scrollWidth > curNode.clientWidth + 4) {
            const ox = window.getComputedStyle(curNode).overflowX;
            if (ox === 'auto' || ox === 'scroll') {
              swActive = false;
              return;
            }
          }
          curNode = curNode.parentElement;
        }
        swStartX = e.touches[0].clientX;
        swStartY = e.touches[0].clientY;
        swActive = true;
        swLocked = false;
      }, { passive: true });

      document.addEventListener('touchmove', (e) => {
        if (!swActive || swNavigating || !e.touches || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - swStartX;
        const dy = e.touches[0].clientY - swStartY;
        if (!swLocked) {
          if (Math.abs(dy) > 18 && Math.abs(dy) > Math.abs(dx)) {
            swActive = false;
            return;
          }
          if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.4) {
            swLocked = true;
            if (mainEl) {
              mainEl.style.willChange = 'transform, opacity';
              mainEl.style.transition = 'none';
            }
          }
        }
        if (swLocked && mainEl) {
          const canGoNext = dx < 0 && curTabIdx < TAB_ORDER.length - 1;
          const canGoPrev = dx > 0 && curTabIdx > 0;
          const damp = (canGoNext || canGoPrev) ? 0.34 : 0.09;
          swPendingShift = Math.max(-72, Math.min(72, dx * damp));
          if (!swRaf) swRaf = requestAnimationFrame(applyShift);
        }
      }, { passive: true });

      const resetSwipePos = () => {
        if (swRaf) { cancelAnimationFrame(swRaf); swRaf = 0; }
        if (mainEl) {
          mainEl.style.transition = 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)';
          mainEl.style.transform = 'translate3d(0, 0, 0)';
          setTimeout(() => {
            if (mainEl && !swNavigating) {
              mainEl.style.willChange = '';
              mainEl.style.transform = '';
              mainEl.style.transition = '';
            }
          }, 230);
        }
      };

      const finishSwipe = (endX, endY) => {
        if (!swActive || swNavigating) return;
        swActive = false;
        const dx = endX - swStartX;
        const dy = endY - swStartY;
        const triggered = swLocked && Math.abs(dx) >= 56 && Math.abs(dx) > Math.abs(dy) * 1.35;
        if (triggered && dx < 0 && curTabIdx < TAB_ORDER.length - 1) {
          swNavigating = true;
          if (typeof window.cvHaptic === 'function') window.cvHaptic('tap');
          try { sessionStorage.setItem('cv_tab_slide_dir', 'right'); } catch (_) {}
          navigateTo(TAB_ORDER[curTabIdx + 1]);
          return;
        }
        if (triggered && dx > 0 && curTabIdx > 0) {
          swNavigating = true;
          if (typeof window.cvHaptic === 'function') window.cvHaptic('tap');
          try { sessionStorage.setItem('cv_tab_slide_dir', 'left'); } catch (_) {}
          navigateTo(TAB_ORDER[curTabIdx - 1]);
          return;
        }
        if (swLocked) resetSwipePos();
        swLocked = false;
      };

      document.addEventListener('touchend', (e) => {
        if (!e.changedTouches || !e.changedTouches.length) return;
        finishSwipe(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }, { passive: true });
      document.addEventListener('touchcancel', () => {
        swActive = false;
        if (swLocked) resetSwipePos();
        swLocked = false;
      }, { passive: true });
    }

    document.querySelectorAll('.tool-card[data-tool]').forEach(card => {
      card.addEventListener('click', (e) => {
        const key = card.getAttribute('data-tool');
        if (TOOL_ROUTES[key]) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (key === 'converter' && window.VaultPresets) window.VaultPresets.clearPendingPreset();
          navigateTo(TOOL_ROUTES[key]);
        }
      }, true);
    });

    wirePage(page);
  });

  window.VaultBridge = {
    isNative: hasBridge,
    navigateTo,
    copyText,
    raw: hasBridge ? window.AndroidBridge : null
  };
})();
