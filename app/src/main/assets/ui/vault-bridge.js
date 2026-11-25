(function () {
  const hasBridge = typeof window.AndroidBridge !== 'undefined';

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
    integrity: 'conversion_vault_t8_integrity.html',
    playback_tester: 'conversion_vault_p8_playback_tester.html'
  };

  const V_EXT = new Set(['mp4','mkv','webm','mov','avi','ts','flv','ogv','3gp','m4v']);
  const A_EXT = new Set(['mp3','flac','opus','m4a','wav','ogg','ac3','aac','wma']);
  const I_EXT = new Set(['jpg','jpeg','png','webp','gif','bmp','tiff','avif','heic']);

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
        width: 100% !important; max-width: 540px !important; height: 64px !important;
        padding: 0 !important; gap: 0 !important;
        display: grid !important; grid-template-columns: repeat(4, 1fr) !important; z-index: 40 !important;
      }
      .bottom-nav .nav-item {
        background: transparent !important; border: none !important;
        display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important;
        gap: 3px !important; padding: 0 !important; font-size: 10.5px !important; font-weight: 700 !important;
      }
      .bottom-nav .nav-item.active { color: var(--crimson) !important; background: transparent !important; }
      .bottom-nav .nav-item svg { width: 18px !important; height: 18px !important; }

      @keyframes cvPageEnter {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: none; }
      }
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
        animation: cvPageEnter 0.22s cubic-bezier(0.22, 1, 0.36, 1);
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
        else if (k.includes('hw decode') && t.codecs) {
          const supported = [];
          if (t.codecs.h264HwDecode) supported.push('H.264 8-bit');
          if (t.codecs.hevc10bitHwDecode) supported.push('HEVC 10-bit');
          if (t.codecs.av1HwDecode) supported.push('AV1');
          v.textContent = supported.length ? supported.join(' · ') : 'Software Decode';
        }
      });
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

      // Hydrate every .info-cell dynamically from real FFprobe data
      document.querySelectorAll('.info-cell').forEach(cell => {
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

    if (window.__pickingCustomDest && mode === 'folder') {
      window.__pickingCustomDest = false;
      const folderPath = (files[0] && files[0].path) ? files[0].path.substring(0, files[0].path.lastIndexOf('/')) : ('/storage/emulated/0/' + (payload.folderName || 'ConversionVault'));
      if (page === 'conversion_vault_p6_settings.html') {
        const vLbl = document.getElementById('lbl-vault-path') || document.querySelector('.vault-path, .path-val');
        if (vLbl) vLbl.textContent = folderPath + '/';
        if (hasBridge && typeof window.AndroidBridge.saveSettings === 'function') {
          window.AndroidBridge.saveSettings(JSON.stringify({ defaultVaultFolder: folderPath }));
        }
        toast('Default Vault Folder saved: ' + folderPath);
        return;
      }
      window.__customToolDir = folderPath;
      const dLbl = document.getElementById('lbl-dest-path');
      if (dLbl && typeof window.setCustomDestFromNative !== 'function') dLbl.textContent = folderPath + '/';
      if (typeof window.setCustomDestFromNative === 'function') window.setCustomDestFromNative(folderPath);
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

    setActiveFiles(mode, files);

    if (page === 'conversion_vault_p2_select.html') {
      if (mode === 'single' && files.length >= 1) {
        const f = files[0];
        const mb = f.sizeBytes ? (f.sizeBytes / (1024 * 1024)).toFixed(2) + ' MB' : 'Ready';
        const ext = (f.name.split('.').pop() || 'FILE').toUpperCase();
        if (typeof window.showSelection === 'function') {
          window.showSelection('single', f.name, ext + ' · ' + mb, null);
        }
      } else {
        const counts = { v: 0, a: 0, i: 0 };
        let totalBytes = 0;
        files.forEach(f => {
          const c = classifyExt(f.name);
          if (c) { counts[c]++; totalBytes += (f.sizeBytes || 0); }
        });
        const total = counts.v + counts.a + counts.i;
        const mb = (totalBytes / (1024 * 1024)).toFixed(1);
        if (typeof window.showSelection === 'function') {
          window.showSelection(mode, total + ' Media Files Detected', 'Total Size: ' + mb + ' MB · Auto-split into 3 buckets', counts);
        }
      }
      toast('Selected ' + files.length + (files.length === 1 ? ' file' : ' files'));
      return;
    }

    if (files.length > 0) {
      probeAndHydrateSingleFile(files[0]);
      syncEmptyFileState(page);
      toast('Loaded: ' + files[0].name);
    }
  };

  window.onVaultEvent = function (ev) {
    if (!ev) return;
    if (currentPage() === 'conversion_vault_p5_queue_history.html') {
      renderNativeJobs();
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
      if (res.jobId) safeSet('cv_active_job_id', res.jobId);
      navigateTo('conversion_vault_p4a_convert_single.html');
    } else {
      toast('Engine error: ' + ((res && res.error) || 'Failed to queue'));
    }
  }

  function wireBackButtons(page) {
    const backMap = {
      'conversion_vault_p2_select.html': 'conversion_vault_p1_home.html',
      'conversion_vault_p2a_single.html': 'conversion_vault_p2_select.html',
      'conversion_vault_p2b_multi_collector.html': 'conversion_vault_p2_select.html',
      'conversion_vault_p3_batch.html': 'conversion_vault_p2_select.html',
      'conversion_vault_p3b_output.html': 'conversion_vault_p3_batch.html',
      'conversion_vault_p3b_output_single.html': 'conversion_vault_p2a_single.html',
      'conversion_vault_p4_convert_batch.html': 'conversion_vault_p3b_output.html',
      'conversion_vault_p4a_convert_single.html': 'conversion_vault_p3b_output_single.html',
      'conversion_vault_p8_playback_tester.html': 'conversion_vault_p1_home.html'
    };
    const defaultBack = page.startsWith('conversion_vault_t') ? 'conversion_vault_p1_home.html' : (backMap[page] || 'conversion_vault_p1_home.html');

    ['btn-back-home', 'btn-back', 'btn-top-back', 'btn-foot-back', 'btn-back-files'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          navigateTo(defaultBack);
        }, true);
      }
    });
    document.querySelectorAll('.back-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
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
    wireBackButtons(page);
    syncEmptyFileState(page);

    const activeFiles = getActiveFiles();
    if (activeFiles.length > 0 && page !== 'conversion_vault_p1_home.html' && page !== 'conversion_vault_p2_select.html') {
      probeAndHydrateSingleFile(activeFiles[0]);
    }

    if (page === 'conversion_vault_p2_select.html') {
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

      const btnCont = document.getElementById('btn-continue');
      if (btnCont) btnCont.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        const m = getActiveMode();
        if (m === 'folder') navigateTo('conversion_vault_p3_batch.html');
        else if (m === 'multi') navigateTo('conversion_vault_p2b_multi_collector.html');
        else navigateTo('conversion_vault_p2a_single.html');
      }, true);
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
      const bMove = document.getElementById('btn-move-convert');
      if (bMove) bMove.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        navigateTo('conversion_vault_p3b_output_single.html');
      }, true);
    }

    if (page === 'conversion_vault_p3_batch.html') {
      if (typeof window.setBatchFilesFromNative === 'function') window.setBatchFilesFromNative(getActiveFiles());
      const bGo = document.getElementById('btn-go-convert');
      if (bGo) bGo.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        navigateTo('conversion_vault_p3b_output.html');
      }, true);
    }

    if (page === 'conversion_vault_p3b_output.html' || page === 'conversion_vault_p3b_output_single.html') {
      const bBrowse = document.getElementById('btn-browse');
      if (bBrowse) bBrowse.addEventListener('click', (e) => { if (hasBridge) { e.preventDefault(); e.stopImmediatePropagation(); window.AndroidBridge.pickFolder(); } }, true);

      const bStart = document.getElementById('btn-start-convert');
      if (bStart) bStart.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        const files = getActiveFiles();
        if (!files.length) { toast('Pick file(s) first'); return; }
        if (!hasBridge) { toast('Native engine runs inside Android APK'); return; }
        const outNameEl = document.getElementById('inp-fname');
        const probe = JSON.parse(safeGet('cv_last_probe', '{}') || '{}');
        let queuedCount = 0;
        let lastErr = '';
        files.forEach((f, idx) => {
          const c = classifyExt(f.name);
          const bucket = c === 'a' ? 'Audios' : (c === 'i' ? 'Images' : 'Videos');
          const mType = c === 'a' ? 'Audio' : (c === 'i' ? 'Image' : 'Video');
          const ext = c === 'a' ? 'm4a' : (c === 'i' ? 'webp' : 'mp4');
          const args = c === 'a' ? '-y -i {INPUT} -c:a aac -b:a 192k {OUTPUT}'
                     : (c === 'i' ? '-y -i {INPUT} -c:v libwebp -quality 85 {OUTPUT}'
                                  : '-y -i {INPUT} -c:v libx264 -pix_fmt yuv420p -crf 20 -preset fast -c:a aac -b:a 192k -movflags +faststart {OUTPUT}');
          const res = JSON.parse(window.AndroidBridge.enqueueJob(JSON.stringify({
            module: 'Vault_Core',
            subBucket: bucket,
            mediaType: mType,
            inputPath: f.path,
            outputBaseName: (idx === 0 && outNameEl) ? outNameEl.value : '',
            outputExt: ext,
            durationMs: idx === 0 ? Math.round((probe.durationSec || 0) * 1000) : 0,
            commandArgs: args
          })));
          if (res && res.ok) { queuedCount++; if (idx === 0 && res.jobId) safeSet('cv_active_job_id', res.jobId); }
          else lastErr = (res && res.error) || 'Failed to queue job';
        });
        if (queuedCount > 0) {
          toast('Starting Engine...');
          navigateTo('conversion_vault_p4a_convert_single.html');
        } else {
          toast('Engine error: ' + lastErr);
        }
      }, true);
    }

    if (page === 'conversion_vault_p5_queue_history.html') {
      renderNativeJobs();
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

      const bClearCache = document.getElementById('btn-clear-cache');
      if (bClearCache) bClearCache.addEventListener('click', (e) => {
        if (!hasBridge || typeof window.AndroidBridge.clearCache !== 'function') return;
        e.preventDefault(); e.stopImmediatePropagation();
        const r = JSON.parse(window.AndroidBridge.clearCache());
        const mb = ((r.bytesFreed || 0) / (1024 * 1024)).toFixed(2);
        toast('Cleared ' + mb + ' MB of temporary cache ✓');
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
            ['sel-sample-ttl', 'sampleRetentionDays']
          ];
          map.forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (s[key] !== undefined && s[key] !== null) {
              const targetVal = String(s[key]);
              if (Array.from(el.options).some(o => o.value === targetVal)) {
                el.value = targetVal;
              }
            }
            el.addEventListener('change', () => {
              const payload = {};
              payload[key] = (key === 'sampleRetentionDays') ? (parseInt(el.value, 10) || 15) : el.value;
              window.AndroidBridge.saveSettings(JSON.stringify(payload));
              toast('Setting saved ✓');
            });
          });
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

      // Live-sync Settings Saved Presets Manager from Room SQLite
      function renderSettingsSavedPresets() {
        const listEl = document.getElementById('settings-saved-presets-list');
        const subEl = document.getElementById('lbl-saved-presets-sub');
        const badgeEl = document.getElementById('badge-saved-presets');
        if (!listEl) return;

        const items = [];
        if (hasBridge && typeof window.AndroidBridge.getPresets === 'function') {
          try {
            const roomList = JSON.parse(window.AndroidBridge.getPresets(false) || '[]');
            roomList.forEach(p => {
              let parsed = {};
              try { parsed = JSON.parse(p.extraFlags || '{}'); } catch (_) {}
              const cat = p.category || 'Video';
              const summary = parsed.specs || (cat.toUpperCase() + ' · .' + (p.container || 'mp4') + ' · ' + (p.codec || 'libx264') + (p.crfOrBitrate ? ' · ' + p.crfOrBitrate : ''));
              items.push({ name: p.name || 'Saved Preset', sub: summary });
            });
          } catch (_) {}
        }
        // Keep starter preset visible alongside Room presets without duplicates (matching Presets Hub, Single & Batch)
        if (!items.some(x => x.name === 'My Daily Car Edit')) {
          items.push({
            name: 'My Daily Car Edit',
            sub: 'MP4 · 1080×1920 60fps · CRF 17 · AAC 256k · Forensic'
          });
        }

        const count = items.length;
        if (subEl) subEl.textContent = count + ' saved preset' + (count === 1 ? '' : 's') + ' · Synced across Single & Batch';
        if (badgeEl) badgeEl.textContent = count + ' SAVED';

        const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        listEl.innerHTML = items.map(it =>
          '<div class="cap-row">' +
            '<div class="cap-l">' +
              '<span class="cap-name">' + esc(it.name) + '</span>' +
              '<span class="cap-sub">' + esc(it.sub) + '</span>' +
            '</div>' +
            '<button type="button" class="btn-sm" data-open-presets="1">Edit</button>' +
          '</div>'
        ).join('');
      }

      const presetsListWrap = document.getElementById('settings-saved-presets-list');
      if (presetsListWrap) {
        presetsListWrap.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-open-presets]');
          if (!btn) return;
          e.preventDefault(); e.stopImmediatePropagation();
          navigateTo('conversion_vault_p7_presets.html');
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
      if (bFm) bFm.addEventListener('click', (e) => { if (hasBridge) { e.preventDefault(); e.stopImmediatePropagation(); window.AndroidBridge.openFolder('/storage/emulated/0/ConversionVault/Samples'); } }, true);
      if (bOpenFm) bOpenFm.addEventListener('click', (e) => { if (hasBridge) { e.preventDefault(); e.stopImmediatePropagation(); window.AndroidBridge.openFolder('/storage/emulated/0/ConversionVault/Samples'); } }, true);
    }

    // Wire all 8 Quick Tools
    if (page.startsWith('conversion_vault_t')) {
      const bPick = document.getElementById('btn-pick');
      if (bPick) bPick.addEventListener('click', (e) => {
        if (!hasBridge) return;
        e.preventDefault(); e.stopImmediatePropagation();
        window.AndroidBridge.pickFile();
      }, true);

      const bFm = document.getElementById('btn-fm');
      if (bFm) bFm.addEventListener('click', (e) => {
        if (!hasBridge) return;
        e.preventDefault(); e.stopImmediatePropagation();
        window.AndroidBridge.openFolder('');
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
      if (bRun) bRun.addEventListener('click', (e) => {
        if (!hasBridge) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (page === 'conversion_vault_t1_metadata.html') {
          const spec = typeof window.getMetadataJobSpec === 'function' ? window.getMetadataJobSpec() : null;
          if (!spec) { toast('Pick a file and choose a wipe or edit action'); return; }
          const res = JSON.parse(window.AndroidBridge.enqueueJob(JSON.stringify(spec)));
          if (res && res.ok) {
            if (res.jobId) safeSet('cv_active_job_id', res.jobId);
            navigateTo('conversion_vault_p4a_convert_single.html');
          } else {
            toast('Engine error: ' + ((res && res.error) || 'Failed to queue'));
          }
        } else if (['conversion_vault_t2_compressor.html','conversion_vault_t3_audio.html','conversion_vault_t5_trim_gif.html','conversion_vault_t6_thumbnail.html'].includes(page)) {
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
            if (res.jobId) safeSet('cv_active_job_id', res.jobId);
            navigateTo('conversion_vault_p4a_convert_single.html');
          } else {
            toast('Engine error: ' + ((res && res.error) || 'Failed to queue'));
          }
        } else if (page === 'conversion_vault_t8_integrity.html') {
          const files = getActiveFiles();
          if (!files.length) { toast('Pick a file first'); window.AndroidBridge.pickFile(); return; }
          const deep = (document.querySelector('[data-scan].active')?.getAttribute('data-scan') || 'deep') === 'deep';
          toast('Scanning file...');
          const res = JSON.parse(window.AndroidBridge.runIntegrityCheck(files[0].path, deep));
          toast(res.ok ? 'File healthy: 0 decode errors ✓' : 'Corrupt/Incomplete: ' + res.decodeErrorCount + ' errors');
          if (typeof window.showResult === 'function') window.showResult(!res.ok);
        }
      }, true);

      if (page === 'conversion_vault_t4_inspector.html') {
        const bExp = document.getElementById('btn-export-json');
        if (bExp) bExp.addEventListener('click', (e) => {
          if (!hasBridge) return;
          e.preventDefault(); e.stopImmediatePropagation();
          const probe = safeGet('cv_last_probe', '{}') || '{}';
          const res = JSON.parse(window.AndroidBridge.exportReportJson('probe_report', probe));
          toast('Saved: ' + (res.path || 'Reports'));
        }, true);
      }

      if (page === 'conversion_vault_t8_integrity.html') {
        const bRepair = document.getElementById('btn-repair');
        if (bRepair) bRepair.addEventListener('click', (e) => {
          if (!hasBridge) return;
          e.preventDefault(); e.stopImmediatePropagation();
          enqueueSimpleToolJob('Vault_Core', 'Video', 'mp4', '-y -err_detect ignore_err -i {INPUT} -c copy {OUTPUT}', 'repaired_output');
        }, true);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const page = currentPage();
    injectGlobalAnimations();
    applySavedTheme();
    hydrateHardwareStrip();
    if (page === 'conversion_vault_p1_home.html' && hasBridge && typeof window.AndroidBridge.checkEngineHealth === 'function') {
      setTimeout(() => {
        try {
          const h = JSON.parse(window.AndroidBridge.checkEngineHealth());
          const pill = document.querySelector('.engine-pill');
          if (pill) {
            if (h.ok) {
              pill.innerHTML = '<span class="pulse-dot"></span> FFmpeg &amp; FFprobe Ready';
            } else {
              pill.style.color = 'var(--crimson)';
              pill.style.background = 'rgba(219,10,64,0.15)';
              pill.style.whiteSpace = 'normal'; pill.style.borderRadius = '8px'; pill.textContent = 'Engine Error: ' + (h.error || 'FFmpeg init failed').slice(0, 260);
            }
          }
        } catch (_) {}
      }, 150);
    }

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

    document.querySelectorAll('.tool-card[data-tool]').forEach(card => {
      card.addEventListener('click', (e) => {
        const key = card.getAttribute('data-tool');
        if (TOOL_ROUTES[key]) {
          e.preventDefault();
          e.stopImmediatePropagation();
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
