(function () {
  const hasBridge = typeof window.AndroidBridge !== 'undefined';

  // Route map for Home cards & 4-tab bottom navigation
  const NAV_ROUTES = {
    home: 'conversion_vault_p1_home.html',
    queue: 'conversion_vault_p5_queue_history.html',
    presets: 'conversion_vault_p7_presets.html',
    settings: 'conversion_vault_p6_settings.html'
  };

  const TOOL_ROUTES = {
    converter: 'conversion_vault_p2_select.html',
    metadata: 'conversion_vault_t1_metadata.html',
    compressor: 'conversion_vault_t2_compressor.html',
    audio_tools: 'conversion_vault_t3_audio.html',
    inspector: 'conversion_vault_t4_inspector.html',
    trim_gif: 'conversion_vault_t5_trim_gif.html',
    thumbnail: 'conversion_vault_t6_thumbnail.html',
    suggestor: 'conversion_vault_t7_suggestor.html',
    integrity: 'conversion_vault_t8_integrity.html'
  };

  function navigateTo(page) {
    if (!page) return;
    if (hasBridge && typeof window.AndroidBridge.navigate === 'function') {
      window.AndroidBridge.navigate(page);
    } else {
      window.location.href = page;
    }
  }

  // Sync persisted theme across all 21 pages
  function applySavedTheme() {
    let theme = localStorage.getItem('cv_theme') || 'dark';
    if (hasBridge && typeof window.AndroidBridge.getSettings === 'function') {
      try {
        const s = JSON.parse(window.AndroidBridge.getSettings());
        if (s && s.theme) theme = s.theme;
      } catch (_) {}
    }
    document.documentElement.setAttribute('data-theme', theme);
  }

  // Hydrate Home hardware strip dynamically from Android HardwareProfiler
  function hydrateHardwareStrip() {
    if (!hasBridge || typeof window.AndroidBridge.getDeviceTelemetry !== 'function') return;
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
            if (idx === 3 && vals[idx] !== 'None') {
              vEl.style.color = 'var(--emerald)';
            }
          }
        });
      }
    } catch (_) {}
  }

  document.addEventListener('DOMContentLoaded', () => {
    applySavedTheme();
    hydrateHardwareStrip();

    // Wire 4-tab bottom nav across all pages
    document.querySelectorAll('.bottom-nav .nav-item[data-nav]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = btn.getAttribute('data-nav');
        if (NAV_ROUTES[key]) {
          e.preventDefault();
          e.stopImmediatePropagation();
          navigateTo(NAV_ROUTES[key]);
        }
      }, true);
    });

    // Wire Home tool cards
    document.querySelectorAll('.tool-card[data-tool]').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.getAttribute('data-tool');
        if (TOOL_ROUTES[key]) {
          navigateTo(TOOL_ROUTES[key]);
        }
      });
    });

    // Wire Back buttons to return cleanly in WebView
    document.querySelectorAll('.back-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (window.history.length > 1) {
          window.history.back();
        } else {
          navigateTo(NAV_ROUTES.home);
        }
      });
    });
  });

  window.VaultBridge = {
    isNative: hasBridge,
    navigateTo,
    raw: hasBridge ? window.AndroidBridge : null
  };
})();
