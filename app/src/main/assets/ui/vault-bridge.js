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

        if (mCat === 'i') {
          if (badgeEl) badgeEl.textContent = 'PHOTO';
          if (tagEl) tagEl.textContent = 'Native Photo Probe';
          const extUp = (name.split('.').pop() || 'IMG').toUpperCase();
          const aspect = (info.width && info.height) ? ((info.width / info.height).toFixed(2) + ':1') : '—';
          const metaLbl = info.hasGps ? 'GPS + EXIF Present' : (info.cameraModel ? info.cameraModel : (info.tagsSummary || 'Clean'));
          if (gridEl) {
            gridEl.innerHTML =
              cell('Dimensions', resStr) +
              cell('Image Format', extUp + (info.videoCodec && info.videoCodec !== 'None' ? ' (' + info.videoCodec.toUpperCase() + ')' : '')) +
              cell('Pixel / Color', (info.pixFmt && info.pixFmt !== '—') ? info.pixFmt : 'sRGB') +
              cell('File Size', sizeMbStr) +
              cell('Orientation', info.exifOrientation || 'Normal (0°)') +
              cell('EXIF / Camera', metaLbl, info.hasGps ? 'c-gold' : '');
          }
          if (deepEl) {
            deepEl.innerHTML =
              '<strong>Extracted Photo Details:</strong><br>' +
              'File: ' + esc(name) + ' · Exact Size: ' + (sizeBytes ? sizeBytes.toLocaleString() + ' B' : '—') + '<br>' +
              'Dimensions: ' + esc(resStr) + ' (Aspect ' + esc(aspect) + ') · Orientation: ' + esc(info.exifOrientation || 'Normal') + '<br>' +
              'Tags: ' + esc(info.tagsSummary || 'No metadata tags detected');
          }
        } else if (mCat === 'a') {
          if (badgeEl) badgeEl.textContent = 'AUDIO';
          if (tagEl) tagEl.textContent = 'FFprobe Audio Stream';
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
              cell('Container', (info.format && info.format !== 'unknown') ? info.format.toUpperCase() : extUp);
          }
          if (deepEl) {
            deepEl.innerHTML =
              '<strong>Extracted Audio Stream Details:</strong><br>' +
              'File: ' + esc(name) + ' · Exact Size: ' + (sizeBytes ? sizeBytes.toLocaleString() + ' B' : '—') + '<br>' +
              'Streams: ' + (info.streamCount || 1) + ' · Container: ' + esc(info.format || extUp) + '<br>' +
              'Tags: ' + esc(info.tagsSummary || 'No metadata tags detected');
          }
        } else {
          if (badgeEl) badgeEl.textContent = 'VIDEO';
          if (tagEl) tagEl.textContent = 'FFprobe Deep Stream';
          const vCodecLbl = (info.videoCodec && info.videoCodec !== 'None') ? (info.videoCodec.toUpperCase() + (info.pixFmt && info.pixFmt !== '—' ? ' (' + info.pixFmt + ')' : '')) : '—';
          const aStreamLbl = (info.audioCodec && info.audioCodec !== 'None')
            ? (info.audioCodec.toUpperCase() + (audBrStr !== '—' ? ' · ' + audBrStr : '') + (info.sampleRate && info.sampleRate !== '—' ? ' · ' + info.sampleRate + ' Hz' : ''))
            : 'No Audio Track';
          if (gridEl) {
            gridEl.innerHTML =
              cell('Resolution & FPS', resStr + (fpsStr !== '—' ? ' · ' + fpsStr : '')) +
              cell('Video Codec', vCodecLbl) +
              cell('Source Bitrate', brStr) +
              cell('Duration', durStr) +
              cell('Audio Stream', aStreamLbl) +
              cell('Detected Metadata', info.hasGps ? 'GPS + Container Tags' : (info.tagsSummary || 'Clean'), info.hasGps ? 'c-gold' : '');
          }
          if (deepEl) {
            deepEl.innerHTML =
              '<strong>Extracted Video Stream Details:</strong><br>' +
              'Profile: ' + esc(info.videoProfile || '—') + ' · Pixel Fmt: ' + esc(info.pixFmt || '—') + ' · Color: ' + esc(info.colorSpace || '—') + '<br>' +
              'Container: ' + esc(info.format || '—') + ' · Streams: ' + (info.streamCount || 0) + ' · Subtitles: ' + (info.subtitleCount || 0) + '<br>' +
              'Tags: ' + esc(info.tagsSummary || 'No metadata tags detected');
          }
        }
      }

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

    if (page === 'conversion_vault_p2_select.html') {
      // Unified Collect & Drop: append Single, Multi, or Folder picks into ONE shared basket (deduped by path)
      const existing = getActiveFiles();
      const seenPaths = new Set(existing.map(x => x.path || x.name));
      let added = 0;
      const merged = existing.slice();
      files.forEach(f => {
        if (!classifyExt(f.name)) return;
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
      toast(added > 0 ? ('Added ' + added + (added === 1 ? ' file' : ' files') + ' (' + merged.length + ' total)') : ('Already in list (' + merged.length + ' total)'));
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
    if (activeFiles.length > 0 && page !== 'conversion_vault_p1_home.html' && page !== 'conversion_vault_p2_select.html' && page !== 'conversion_vault_p2a_single.html' && page !== 'conversion_vault_p3_batch.html') {
      probeAndHydrateSingleFile(activeFiles[0]);
    }

    if (page === 'conversion_vault_p2_select.html') {
      let pickSortMode = 'added';
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
        const card = document.getElementById('picked-card');
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
          listEl.innerHTML = sorted.map((f) => {
            const c = classifyExt(f.name);
            const tag = c === 'a' ? 'AUDIO' : (c === 'i' ? 'PHOTO' : 'VIDEO');
            const sz = f.sizeBytes ? (f.sizeBytes < 1024 * 1024 ? (f.sizeBytes / 1024).toFixed(0) + ' KB' : (f.sizeBytes / (1024 * 1024)).toFixed(2) + ' MB') : '—';
            const key = esc(f.path || f.name);
            return '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 8px; border-radius:7px; border:1px solid var(--border); background:var(--surface);">' +
              '<div style="min-width:0;">' +
                '<div style="font-size:11.5px; font-weight:700; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(f.name) + '</div>' +
                '<div style="font-size:10px; font-family:var(--mono); color:var(--muted);">' + tag + ' · ' + sz + '</div>' +
              '</div>' +
              '<button type="button" data-rm-pick="' + key + '" style="border:none; background:transparent; color:var(--crimson); font-size:15px; font-weight:800; padding:2px 6px; cursor:pointer;" aria-label="Remove file">×</button>' +
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

      const btnClearPick = document.getElementById('btn-clear-pick');
      if (btnClearPick) {
        btnClearPick.addEventListener('click', () => {
          setActiveFiles('single', []);
          renderUnifiedPickBasket();
          toast('Cleared collected files');
        }, true);
      }

      document.addEventListener('click', (e) => {
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
        const sorted = sortPickedFiles(getActiveFiles());
        if (!sorted.length) { toast('Add at least one file first'); return; }
        setActiveFiles(sorted.length > 1 ? 'multi' : 'single', sorted);
        if (sorted.length === 1) navigateTo('conversion_vault_p2a_single.html');
        else navigateTo('conversion_vault_p3_batch.html');
      }, true);

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

      if (fileCat === 'i') {
        // PHOTO MODE: hide video format selector completely & show dedicated Photo Format + real Photo Performance Estimation
        if (presetBox) presetBox.style.display = 'none';
        if (perfSec) {
          perfSec.classList.remove('is-untouched');
          perfSec.querySelectorAll('.field, #core-cmd-pill, #core-warn-note').forEach(el => { el.style.display = 'none'; });
        }
        const badgeEl = document.querySelector('.single-badge');
        if (badgeEl) badgeEl.textContent = 'PHOTO';
        singlePhotoCfg = { format: 'webp', quality: 88, scale: 'original', orient: 'auto', meta: 'wipe', colorSpace: 'srgb_444' };

        if (presetBox && !document.getElementById('native-photo-single-card')) {
          const card = document.createElement('div');
          card.id = 'native-photo-single-card';
          card.style.cssText = 'padding:12px; border-radius:12px; border:1px solid rgba(16,185,129,0.4); background:rgba(16,185,129,0.06); display:flex; flex-direction:column; gap:10px;';
          card.innerHTML =
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
              '<span style="font-size:12px; font-weight:800; color:var(--emerald);">Native Photo Engine (Skia + Exif + Heif)</span>' +
              '<span style="font-size:10px; font-family:var(--mono); color:var(--muted);">PHOTO FORMAT</span>' +
            '</div>' +
            '<button type="button" id="btn-sp-toggle-presets" style="width:100%; display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--surface); color:var(--text); font-size:12px; font-weight:700; cursor:pointer;"><span id="lbl-sp-presets-cnt">Presets</span><span id="lbl-sp-presets-arrow">▾</span></button>' +
            '<div id="sp-saved-presets-wrap" style="display:none; flex-wrap:wrap; gap:6px;"></div>' +
            '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">' +
              '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Output Format</label>' +
                '<select id="sp-fmt" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                  '<option value="webp" selected>.webp (Modern)</option>' +
                  '<option value="jpg">.jpg (Universal)</option>' +
                  '<option value="png">.png (Lossless)</option>' +
                  '<option value="heic">.heic (HEIF High-Eff)</option>' +
                  '<option value="avif">.avif (Ultra Small)</option>' +
                '</select></div>' +
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
                '</select></div>' +
              '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">EXIF Privacy</label>' +
                '<select id="sp-meta" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                  '<option value="wipe" selected>Wipe All EXIF &amp; GPS</option>' +
                  '<option value="deep">Forensic Scrub</option>' +
                  '<option value="gps">Strip GPS Only</option>' +
                  '<option value="keep">Keep EXIF</option>' +
                '</select></div>' +
            '</div>' +
            '<div><div style="display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:4px;"><span>Image Quality</span><strong id="sp-qual-lbl" style="color:var(--text);">88%</strong></div>' +
              '<input type="range" id="sp-qual" min="15" max="100" value="88" style="width:100%;"></div>' +
            '<div style="display:flex; justify-content:flex-end;">' +
              '<button type="button" id="btn-sp-save-preset" style="padding:6px 12px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); font-size:11.5px; font-weight:700; cursor:pointer;">+ Save Image Preset</button>' +
            '</div>';
          presetBox.parentNode.insertBefore(card, presetBox.nextSibling);

          const syncPhotoSummary = () => {
            singlePhotoCfg.format = document.getElementById('sp-fmt').value;
            singlePhotoCfg.scale = document.getElementById('sp-scale').value;
            singlePhotoCfg.orient = document.getElementById('sp-orient').value;
            singlePhotoCfg.meta = document.getElementById('sp-meta').value;
            singlePhotoCfg.quality = parseInt(document.getElementById('sp-qual').value, 10) || 88;
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
          const updatePhotoPerf = () => {
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
          window.refreshSinglePhotoAudioPerf = updatePhotoPerf;

          let spPresetsOpen = false;
          const BUILTIN_IMG_PRESETS = [
            { raw: { name: 'WebP Crisp 85%', container: 'webp', crfOrBitrate: '85' }, parsed: { cfg: { fmt: 'webp', qual: 85, scale: 'original', orient: 'auto', meta: 'wipe' } } }
          ];
          const renderSavedImagePresets = () => {
            const wrap = document.getElementById('sp-saved-presets-wrap');
            const cntEl = document.getElementById('lbl-sp-presets-cnt');
            const arrEl = document.getElementById('lbl-sp-presets-arrow');
            if (!wrap) return;
            const roomList = getRoomPresetsForCat('image');
            const merged = [];
            const seen = new Set();
            roomList.forEach(s => { if (!seen.has(s.raw.name)) { seen.add(s.raw.name); merged.push(s); } });
            const hiddenB = new Set([].concat(JSON.parse(safeGet('cv_deleted_builtins', '[]') || '[]'), JSON.parse(safeGet('cv_perm_deleted_builtins', '[]') || '[]')));
            BUILTIN_IMG_PRESETS.forEach(s => { if (!hiddenB.has(s.raw.name) && !seen.has(s.raw.name)) { seen.add(s.raw.name); merged.push(s); } });
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
                const q = parseInt(c.qual || c.quality || s.raw.crfOrBitrate, 10);
                if (q >= 15 && q <= 100) document.getElementById('sp-qual').value = String(q);
                spPresetsOpen = false;
                renderSavedImagePresets();
                syncPhotoSummary();
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
            if (!hasBridge || typeof window.AndroidBridge.savePreset !== 'function') return;
            const nm = 'Photo ' + singlePhotoCfg.format.toUpperCase() + ' Q' + singlePhotoCfg.quality;
            const specs = '.' + singlePhotoCfg.format + ' · Q' + singlePhotoCfg.quality + ' · ' + singlePhotoCfg.scale + ' · ' + singlePhotoCfg.meta;
            window.AndroidBridge.savePreset(JSON.stringify({
              name: nm,
              category: 'Image',
              codec: singlePhotoCfg.format,
              container: singlePhotoCfg.format,
              crfOrBitrate: String(singlePhotoCfg.quality),
              extraFlags: JSON.stringify({ desc: 'Saved photo preset', specs, cfg: { fmt: singlePhotoCfg.format, qual: singlePhotoCfg.quality, scale: singlePhotoCfg.scale, orient: singlePhotoCfg.orient, meta: singlePhotoCfg.meta } })
            }));
            renderSavedImagePresets();
            toast('Saved "' + nm + '" ✓');
          });

          ['sp-fmt', 'sp-scale', 'sp-orient', 'sp-meta', 'sp-qual'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', syncPhotoSummary);
            if (el) el.addEventListener('change', syncPhotoSummary);
          });
          renderSavedImagePresets();
          syncPhotoSummary();
        }
      } else if (fileCat === 'a') {
        // AUDIO MODE: hide video format selector completely & show dedicated Audio Format + real Audio Performance Estimation
        if (presetBox) presetBox.style.display = 'none';
        if (perfSec) {
          perfSec.classList.remove('is-untouched');
          perfSec.querySelectorAll('.field, #core-cmd-pill, #core-warn-note').forEach(el => { el.style.display = 'none'; });
        }
        const badgeEl = document.querySelector('.single-badge');
        if (badgeEl) badgeEl.textContent = 'AUDIO';
        singleAudioCfg = { fmt: 'm4a', br: '192k', ar: 'keep', ch: 'keep', filter: 'none', meta: 'wipe' };

        if (presetBox && !document.getElementById('native-audio-single-card')) {
          const card = document.createElement('div');
          card.id = 'native-audio-single-card';
          card.style.cssText = 'padding:12px; border-radius:12px; border:1px solid rgba(252,215,0,0.4); background:rgba(252,215,0,0.06); display:flex; flex-direction:column; gap:10px;';
          card.innerHTML =
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
              '<span style="font-size:12px; font-weight:800; color:var(--gold-text);">Audio Format &amp; Codec Selection</span>' +
              '<span style="font-size:10px; font-family:var(--mono); color:var(--muted);">AUDIO MODE</span>' +
            '</div>' +
            '<button type="button" id="btn-sa-toggle-presets" style="width:100%; display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--surface); color:var(--text); font-size:12px; font-weight:700; cursor:pointer;"><span id="lbl-sa-presets-cnt">Presets</span><span id="lbl-sa-presets-arrow">▾</span></button>' +
            '<div id="sa-saved-presets-wrap" style="display:none; flex-wrap:wrap; gap:6px;"></div>' +
            '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">' +
              '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Audio Format</label>' +
                '<select id="sa-fmt" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                  '<option value="m4a" selected>.m4a (AAC Universal)</option>' +
                  '<option value="opus">.opus (High Efficiency)</option>' +
                  '<option value="mp3">.mp3 (Classic)</option>' +
                  '<option value="flac">.flac (Lossless)</option>' +
                  '<option value="wav">.wav (Uncompressed)</option>' +
                '</select></div>' +
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
                  '<option value="trim_silence">Trim Silence</option>' +
                '</select></div>' +
              '<div><label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">ID3 Privacy</label>' +
                '<select id="sa-meta" style="width:100%; padding:8px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--border); font-size:12px;">' +
                  '<option value="wipe" selected>Wipe All Tags</option>' +
                  '<option value="keep">Keep All Tags</option>' +
                '</select></div>' +
            '</div>' +
            '<div style="display:flex; justify-content:flex-end;">' +
              '<button type="button" id="btn-sa-save-preset" style="padding:6px 12px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); font-size:11.5px; font-weight:700; cursor:pointer;">+ Save Audio Preset</button>' +
            '</div>';
          presetBox.parentNode.insertBefore(card, presetBox.nextSibling);

          const syncAudioSummary = () => {
            singleAudioCfg.fmt = document.getElementById('sa-fmt').value;
            singleAudioCfg.br = document.getElementById('sa-br').value;
            singleAudioCfg.ar = document.getElementById('sa-ar').value;
            singleAudioCfg.ch = document.getElementById('sa-ch').value;
            singleAudioCfg.filter = document.getElementById('sa-filter').value;
            singleAudioCfg.meta = document.getElementById('sa-meta').value;
            const isLossless = singleAudioCfg.fmt === 'flac' || singleAudioCfg.fmt === 'wav';
            document.getElementById('sa-br').disabled = isLossless;
            const stPill = document.getElementById('fmt-status-pill');
            const footT = document.getElementById('foot-title');
            const footS = document.getElementById('foot-sub');
            if (stPill) stPill.textContent = '.' + singleAudioCfg.fmt.toUpperCase();
            if (footT) footT.textContent = 'Audio Format Ready';
            if (footS) footS.textContent = '.' + singleAudioCfg.fmt.toUpperCase() + (isLossless ? ' · Lossless' : (' · ' + singleAudioCfg.br));
            const mvBtn = document.getElementById('btn-move-convert');
            if (mvBtn) mvBtn.disabled = false;
            updateAudioPerf();
          };
          const updateAudioPerf = () => {
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
          window.refreshSinglePhotoAudioPerf = updateAudioPerf;

          let saPresetsOpen = false;
          const BUILTIN_AUD_PRESETS = [
            { raw: { name: 'Opus 192k Transparent', container: 'opus', crfOrBitrate: '192k' }, parsed: { cfg: { fmt: 'opus', br: '192k', ar: '48000', ch: '2', filter: 'none', meta: 'wipe' } } },
            { raw: { name: 'Loudnorm AAC (-14 LUFS)', container: 'm4a', crfOrBitrate: '192k' }, parsed: { cfg: { fmt: 'm4a', br: '192k', ar: '48000', ch: '2', filter: 'loudnorm', meta: 'wipe' } } }
          ];
          const renderSavedAudioPresets = () => {
            const wrap = document.getElementById('sa-saved-presets-wrap');
            const cntEl = document.getElementById('lbl-sa-presets-cnt');
            const arrEl = document.getElementById('lbl-sa-presets-arrow');
            if (!wrap) return;
            const roomList = getRoomPresetsForCat('audio');
            const merged = [];
            const seen = new Set();
            roomList.forEach(s => { if (!seen.has(s.raw.name)) { seen.add(s.raw.name); merged.push(s); } });
            const hiddenB = new Set([].concat(JSON.parse(safeGet('cv_deleted_builtins', '[]') || '[]'), JSON.parse(safeGet('cv_perm_deleted_builtins', '[]') || '[]')));
            BUILTIN_AUD_PRESETS.forEach(s => { if (!hiddenB.has(s.raw.name) && !seen.has(s.raw.name)) { seen.add(s.raw.name); merged.push(s); } });
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
                if (c.filter && Array.from(document.getElementById('sa-filter').options).some(o => o.value === String(c.filter))) document.getElementById('sa-filter').value = String(c.filter);
                if (c.meta && Array.from(document.getElementById('sa-meta').options).some(o => o.value === String(c.meta))) document.getElementById('sa-meta').value = String(c.meta);
                saPresetsOpen = false;
                renderSavedAudioPresets();
                syncAudioSummary();
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

          ['sa-fmt', 'sa-br', 'sa-ar', 'sa-ch', 'sa-filter', 'sa-meta'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', syncAudioSummary);
          });
          renderSavedAudioPresets();
          syncAudioSummary();
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
      const bGo = document.getElementById('btn-go-convert');
      if (bGo) bGo.addEventListener('click', (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        if (typeof window.getVaultBatchConfigs === 'function') {
          try {
            safeSet('cv_pending_convert_cfg', JSON.stringify({ mode: 'batch', batch: window.getVaultBatchConfigs() }));
          } catch (_) {}
        }
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
              meta: String(pCfg.meta || 'wipe'),
              colorSpace: String(pCfg.colorSpace || 'srgb_444')
            };
            args = 'NATIVE_PHOTO:' + JSON.stringify(photoSpec);
          } else if (c === 'a') {
            const aCfg = (pendingCfg.mode === 'single_audio' && pendingCfg.audio) || (pendingCfg.batch && pendingCfg.batch.byName && pendingCfg.batch.byName[f.name]) || (pendingCfg.batch && pendingCfg.batch.byCat && pendingCfg.batch.byCat.audio) || {};
            ext = (aCfg.fmt || 'm4a').replace(/^\./, '').toLowerCase();
            const br = aCfg.br || '192k';
            const arFlag = (aCfg.ar && aCfg.ar !== 'keep') ? (' -ar ' + aCfg.ar) : '';
            const chFlag = (aCfg.ch && aCfg.ch !== 'keep') ? (' -ac ' + aCfg.ch) : '';
            const afFlag = aCfg.filter === 'loudnorm' ? ' -af loudnorm=I=-14:TP=-1.5:LRA=11' : (aCfg.filter === 'trim_silence' ? ' -af silenceremove=start_periods=1:start_threshold=-50dB' : '');
            const metaFlag = aCfg.meta === 'wipe' ? ' -map_metadata -1' : '';
            const codecPart = ext === 'flac' ? '-c:a flac'
                 : (ext === 'wav' ? '-c:a pcm_s16le'
                 : (ext === 'mp3' ? '-c:a libmp3lame -b:a ' + br
                 : (ext === 'opus' ? '-c:a libopus -b:a ' + br
                                   : '-c:a aac -b:a ' + br)));
            args = '-y -i {INPUT} -vn ' + codecPart + arFlag + chFlag + afFlag + metaFlag + ' {OUTPUT}';
          } else {
            const vCfg = (pendingCfg.mode === 'single_video' && pendingCfg.video) || (pendingCfg.batch && pendingCfg.batch.byName && pendingCfg.batch.byName[f.name]) || (pendingCfg.batch && pendingCfg.batch.byCat && pendingCfg.batch.byCat.video) || {};
            ext = (vCfg.container || 'mp4').replace(/^\./, '').toLowerCase();
            const vCodec = vCfg.codec || 'libx264';
            const crf = vCfg.crf != null ? vCfg.crf : 20;
            const preset = vCfg.preset || 'fast';
            const aCodec = vCfg.audioCodec || 'aac';
            const aBr = vCfg.audioBr || '192k';
            const aPart = aCodec === 'none' ? '-an' : (aCodec === 'copy' ? '-c:a copy' : (aCodec === 'flac' ? '-c:a flac' : ('-c:a ' + aCodec + ' -b:a ' + aBr)));
            const fastPart = ext === 'mp4' ? ' -movflags +faststart' : '';
            args = vCodec === 'copy'
              ? ('-y -i {INPUT} -c copy' + fastPart + ' {OUTPUT}')
              : ('-y -i {INPUT} -c:v ' + vCodec + ' -pix_fmt yuv420p -crf ' + crf + ' -preset ' + preset + ' ' + aPart + fastPart + ' {OUTPUT}');
          }

          jobSpecs.push({
            module: 'Vault_Core',
            subBucket: bucket,
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
          jobSpecs.forEach((spec, idx) => {
            const res = JSON.parse(window.AndroidBridge.enqueueJob(JSON.stringify(spec)) || '{}');
            if (res && res.ok) { queuedCount++; if (idx === 0 && res.jobId) safeSet('cv_active_job_id', res.jobId); }
            else lastErr = (res && res.error) || 'Failed to queue job';
          });
        }
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
        const count = items.length;
        if (subEl) subEl.textContent = count === 0 ? 'No custom presets saved yet · Create one in Presets Hub' : (count + ' saved preset' + (count === 1 ? '' : 's') + ' · Synced across Single & Batch');
        if (badgeEl) badgeEl.textContent = count + ' SAVED';

        const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        listEl.innerHTML = count === 0
          ? '<div class="cap-row"><div class="cap-l"><span class="cap-name">No saved presets yet</span><span class="cap-sub">Save a Video, Audio, or Photo preset to see it synced here.</span></div><button type="button" class="btn-sm" data-open-presets="1">Open Presets</button></div>'
          : items.map(it =>
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
