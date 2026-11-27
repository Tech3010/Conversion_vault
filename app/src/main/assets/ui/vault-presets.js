/* Conversion Vault — Unified Common Preset Library (100% Room SQLite Single Source of Truth)
 * Linked across: Presets Hub (p7), Settings (p6), Single File Studio (p2a), Batch Studio (p3), Smart Suggestor (t7).
 * Zero dummy presets: any create, edit, duplicate, soft-delete, restore, or permanent delete syncs everywhere.
 */
(function (global) {
  'use strict';

  const DEFAULT_CFG = {
    video: {
      presetName: 'Custom Video',
      container: 'mp4',
      codec: 'libx264',
      rcMode: 'crf_cap',
      crf: 18,
      maxrate: 12,
      preset: 'fast',
      gop: 'auto',
      bframes: 2,
      fps: 'original',
      scale: 'original',
      orient: 'keep',
      pixfmt: 'yuv420p',
      audioCodec: 'aac',
      audioBr: '192k',
      audioAr: '48000',
      audioCh: 'stereo',
      audioNorm: 'none',
      subMode: 'strip',
      meta: 'wipe',
      tune: 'none',
      vfilter: 'none',
      speed: '1.0',
      trimStart: '00:00:00',
      trimEnd: 'End',
      audioGain: '0dB',
      faststart: 'faststart'
    },
    audio: {
      presetName: 'Custom Audio',
      fmt: 'opus',
      codec: 'libopus',
      br: '192k',
      ar: '48000',
      ch: 'stereo',
      filter: 'none',
      gain: '0dB',
      speed: '1.0',
      fade: 'none',
      trimStart: '00:00:00',
      trimEnd: 'End',
      meta: 'wipe'
    },
    image: {
      presetName: 'Custom Image',
      fmt: 'webp',
      qual: 85,
      scale: 'original',
      orient: 'auto',
      crop: 'none',
      filter: 'none',
      brightness: 0,
      meta: 'wipe'
    }
  };

  function hasBridge() {
    return !!(global.AndroidBridge && typeof global.AndroidBridge.getPresets === 'function');
  }

  function normCat(rawCat) {
    const c = String(rawCat || 'Video').toLowerCase();
    if (c.includes('aud')) return 'audio';
    if (c.includes('ima') || c.includes('pho')) return 'image';
    return 'video';
  }

  function catLabel(catKey) {
    if (catKey === 'audio') return 'Audio';
    if (catKey === 'image') return 'Image';
    return 'Video';
  }

  function normalizeRecord(p) {
    let parsed = {};
    try {
      parsed = typeof p.extraFlags === 'string' && p.extraFlags.trim()
        ? JSON.parse(p.extraFlags)
        : (p.extraFlags && typeof p.extraFlags === 'object' ? p.extraFlags : {});
    } catch (_) {
      parsed = {};
    }
    const cat = normCat(p.category);
    const baseCfg = Object.assign({}, DEFAULT_CFG[cat], parsed.cfg || {});
    baseCfg.presetName = p.name || baseCfg.presetName;

    if (cat === 'video') {
      if (p.codec && !parsed.cfg) baseCfg.codec = p.codec;
      if (p.container && !parsed.cfg) baseCfg.container = String(p.container).replace(/^\./, '');
      if (p.crfOrBitrate && !parsed.cfg) {
        const crfNum = parseInt(String(p.crfOrBitrate).replace(/[^\d]/g, ''), 10);
        if (!isNaN(crfNum)) baseCfg.crf = crfNum;
      }
    } else if (cat === 'audio') {
      if (p.container && !parsed.cfg) baseCfg.fmt = String(p.container).replace(/^\./, '');
      if (p.crfOrBitrate && !parsed.cfg) baseCfg.br = String(p.crfOrBitrate);
    } else {
      if (p.container && !parsed.cfg) baseCfg.fmt = String(p.container).replace(/^\./, '');
      if (p.crfOrBitrate && !parsed.cfg) {
        const qNum = parseInt(String(p.crfOrBitrate).replace(/[^\d]/g, ''), 10);
        if (!isNaN(qNum)) baseCfg.qual = qNum;
      }
    }

    const fallbackSpecs = cat === 'video'
      ? ('.' + (p.container || baseCfg.container || 'mp4') + ' · ' + (p.codec || baseCfg.codec || 'libx264') + (p.crfOrBitrate ? ' · ' + p.crfOrBitrate : ''))
      : (cat === 'audio'
        ? ('.' + (p.container || baseCfg.fmt || 'opus') + ' · ' + (p.codec || baseCfg.codec || 'libopus') + (p.crfOrBitrate ? ' · ' + p.crfOrBitrate : ''))
        : ('.' + (p.container || baseCfg.fmt || 'webp') + (p.crfOrBitrate ? ' · ' + p.crfOrBitrate : '')));

    const isBuiltIn = !!p.isBuiltIn;
    return {
      id: String(p.id || ''),
      roomId: String(p.id || ''),
      name: String(p.name || 'Preset'),
      category: catLabel(cat),
      cat: cat,
      isBuiltIn: isBuiltIn,
      origin: isBuiltIn ? 'builtin' : 'saved',
      isDeleted: !!p.isDeleted,
      container: String(p.container || baseCfg.container || baseCfg.fmt || 'mp4').replace(/^\./, ''),
      codec: String(p.codec || baseCfg.codec || baseCfg.fmt || 'libx264'),
      crfOrBitrate: String(p.crfOrBitrate || ''),
      desc: parsed.desc || (isBuiltIn ? 'Built-in preset synced across the entire app.' : 'Saved preset synced across the entire app.'),
      specs: parsed.specs || fallbackSpecs,
      bars: parsed.bars || null,
      cfg: baseCfg,
      raw: p,
      parsed: parsed
    };
  }

  function listActive(catFilter) {
    if (!hasBridge()) return [];
    try {
      const rows = JSON.parse(global.AndroidBridge.getPresets(false) || '[]');
      const normalized = Array.isArray(rows) ? rows.map(normalizeRecord) : [];
      if (!catFilter) return normalized;
      const target = normCat(catFilter);
      return normalized.filter(r => r.cat === target);
    } catch (_) {
      return [];
    }
  }

  function listDeleted() {
    if (!hasBridge()) return [];
    try {
      const rows = JSON.parse(global.AndroidBridge.getPresets(true) || '[]');
      return Array.isArray(rows) ? rows.map(normalizeRecord) : [];
    } catch (_) {
      return [];
    }
  }

  function save(preset) {
    if (!preset || !preset.name) return { ok: false, error: 'Preset name required' };
    const catKey = normCat(preset.category || preset.cat);
    const cfg = preset.cfg || null;
    const extraObj = {
      desc: preset.desc || '',
      specs: preset.specs || '',
      bars: preset.bars || null,
      cfg: cfg
    };
    const payload = {
      id: preset.id || preset.roomId || '',
      name: String(preset.name).trim(),
      category: catLabel(catKey),
      codec: String(preset.codec || (cfg && (cfg.codec || cfg.fmt)) || (catKey === 'audio' ? 'libopus' : (catKey === 'image' ? 'libwebp' : 'libx264'))),
      container: String(preset.container || (cfg && (cfg.container || cfg.fmt)) || (catKey === 'audio' ? 'opus' : (catKey === 'image' ? 'webp' : 'mp4'))).replace(/^\./, ''),
      crfOrBitrate: String(preset.crfOrBitrate !== undefined ? preset.crfOrBitrate : ((cfg && (cfg.crf || cfg.br || cfg.qual)) || '18')),
      isBuiltIn: !!preset.isBuiltIn,
      extraFlags: typeof preset.extraFlags === 'string' ? preset.extraFlags : JSON.stringify(extraObj)
    };
    if (global.AndroidBridge && typeof global.AndroidBridge.savePreset === 'function') {
      try {
        return JSON.parse(global.AndroidBridge.savePreset(JSON.stringify(payload)) || '{}');
      } catch (e) {
        return { ok: false, error: String(e && e.message || 'Save failed') };
      }
    }
    return { ok: true, id: payload.id || String(Date.now()) };
  }


  function rename(id, newName) {
    const sid = String(id || '').trim();
    const trimmed = String(newName || '').trim();
    if (!trimmed) return { ok: false, error: 'Preset name required' };
    const all = listActive();
    const hit = all.find(p => String(p.id) === sid || String(p.roomId) === sid);
    if (!hit) return { ok: false, error: 'Preset not found' };
    const nextCfg = Object.assign({}, hit.cfg || {}, { presetName: trimmed });
    return save({
      id: hit.roomId || hit.id,
      roomId: hit.roomId || hit.id,
      name: trimmed,
      category: hit.category,
      cat: hit.cat,
      codec: hit.codec,
      container: hit.container,
      crfOrBitrate: hit.crfOrBitrate,
      isBuiltIn: hit.isBuiltIn,
      desc: hit.desc,
      specs: hit.specs,
      bars: hit.bars,
      cfg: nextCfg
    });
  }

  function softDelete(id) {
    if (!id) return { ok: false, error: 'Missing preset id' };
    if (global.AndroidBridge && typeof global.AndroidBridge.softDeletePreset === 'function') {
      try { return JSON.parse(global.AndroidBridge.softDeletePreset(String(id)) || '{}'); } catch (_) {}
    }
    return { ok: false, error: 'Bridge unavailable' };
  }

  function restore(id) {
    if (!id) return { ok: false, error: 'Missing preset id' };
    if (global.AndroidBridge && typeof global.AndroidBridge.restorePreset === 'function') {
      try { return JSON.parse(global.AndroidBridge.restorePreset(String(id)) || '{}'); } catch (_) {}
    }
    return { ok: false, error: 'Bridge unavailable' };
  }

  function permanentDelete(id) {
    if (!id) return { ok: false, error: 'Missing preset id' };
    if (global.AndroidBridge && typeof global.AndroidBridge.permanentlyDeletePreset === 'function') {
      try { return JSON.parse(global.AndroidBridge.permanentlyDeletePreset(String(id)) || '{}'); } catch (_) {}
    }
    return { ok: false, error: 'Bridge unavailable' };
  }

  function dedupe() {
    const active = listActive();
    // Keep built-in first, then first custom copy; soft-delete any extra duplicates matching (name + category)
    const sorted = active.slice().sort((a, b) => (b.isBuiltIn ? 1 : 0) - (a.isBuiltIn ? 1 : 0));
    const seen = new Set();
    let removed = 0;
    const removedIds = [];
    sorted.forEach(p => {
      const key = p.name.trim().toLowerCase() + '|' + p.cat;
      if (seen.has(key)) {
        const res = softDelete(p.id);
        if (res && res.ok) {
          removed++;
          removedIds.push(p.id);
        }
      } else {
        seen.add(key);
      }
    });
    return { ok: true, removed, removedIds };
  }

  function exportAll() {
    if (global.AndroidBridge && typeof global.AndroidBridge.exportPresetsJson === 'function') {
      try { return JSON.parse(global.AndroidBridge.exportPresetsJson() || '{}'); } catch (_) {}
    }
    return { ok: false, error: 'Bridge unavailable' };
  }

  function exportSelected(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'No presets selected' };
    if (global.AndroidBridge && typeof global.AndroidBridge.exportSelectedPresetsJson === 'function') {
      try { return JSON.parse(global.AndroidBridge.exportSelectedPresetsJson(JSON.stringify(ids)) || '{}'); } catch (_) {}
    }
    return { ok: false, error: 'Bridge unavailable' };
  }

  function importArray(arr) {
    if (!Array.isArray(arr)) return 0;
    let count = 0;
    arr.forEach(p => {
      if (!p || !p.name) return;
      const res = save({
        name: String(p.name),
        category: String(p.category || 'Video'),
        container: String(p.container || 'mp4'),
        codec: String(p.codec || 'libx264'),
        crfOrBitrate: String(p.crfOrBitrate || '18'),
        isBuiltIn: false,
        extraFlags: typeof p.extraFlags === 'string' ? p.extraFlags : JSON.stringify(p.extraFlags || {})
      });
      if (res && res.ok) count++;
    });
    return count;
  }

  function bindAutoSync(callback) {
    if (typeof callback !== 'function') return;
    global.addEventListener('pageshow', (e) => { if (e && e.persisted) { try { callback(); } catch (_) {} } });
    if (global.document) {
      global.document.addEventListener('visibilitychange', () => {
        if (!global.document.hidden) { try { callback(); } catch (_) {} }
      });
    }
  }

  function setPendingPreset(presetObj) {
    if (!presetObj || !presetObj.name) return;
    const catKey = normCat(presetObj.cat || presetObj.category);
    const cfg = Object.assign({}, DEFAULT_CFG[catKey], presetObj.cfg || {});
    cfg.presetName = presetObj.name;
    const payload = {
      source: presetObj.source || 'presets',
      name: String(presetObj.name),
      cat: catKey,
      category: catLabel(catKey),
      container: String(presetObj.container || cfg.container || cfg.fmt || (catKey === 'audio' ? 'opus' : (catKey === 'image' ? 'webp' : 'mp4'))).replace(/^\./, ''),
      codec: String(presetObj.codec || cfg.codec || cfg.fmt || ''),
      crfOrBitrate: String(presetObj.crfOrBitrate || cfg.crf || cfg.br || cfg.qual || ''),
      specs: String(presetObj.specs || ''),
      cfg: cfg,
      ts: Date.now()
    };
    const raw = JSON.stringify(payload);
    try { localStorage.setItem('cv_pending_preset', raw); } catch (_) {}
    try { localStorage.removeItem('cv_active_files'); } catch (_) {}
    try {
      if (global.AndroidBridge && typeof global.AndroidBridge.setAppState === 'function') {
        global.AndroidBridge.setAppState('cv_pending_preset', raw);
        global.AndroidBridge.setAppState('cv_active_files', '[]');
      }
    } catch (_) {}
  }

  function getPendingPreset() {
    let raw = '';
    try {
      if (global.AndroidBridge && typeof global.AndroidBridge.getAppState === 'function') {
        raw = global.AndroidBridge.getAppState('cv_pending_preset') || '';
      }
    } catch (_) {}
    if (!raw) {
      try { raw = localStorage.getItem('cv_pending_preset') || ''; } catch (_) {}
    }
    if (!raw || raw === 'null') return null;
    try {
      const p = JSON.parse(raw);
      return (p && p.name) ? p : null;
    } catch (_) {
      return null;
    }
  }

  function clearPendingPreset() {
    try { localStorage.removeItem('cv_pending_preset'); } catch (_) {}
    try {
      if (global.AndroidBridge && typeof global.AndroidBridge.setAppState === 'function') {
        global.AndroidBridge.setAppState('cv_pending_preset', '');
      }
    } catch (_) {}
  }

  let _cachedSupport = null;

  function loadDeviceSupportSnapshot() {
    if (_cachedSupport) return _cachedSupport;
    let codecs = null;
    let ffmpegEncoders = null;
    let sourceLabel = 'device data';
    try {
      if (global.AndroidBridge && typeof global.AndroidBridge.getSettings === 'function') {
        const st = JSON.parse(global.AndroidBridge.getSettings() || '{}');
        if (st && st.hwTestJson) {
          const parsed = JSON.parse(st.hwTestJson);
          if (parsed && parsed.ok) {
            if (parsed.codecs) codecs = parsed.codecs;
            if (parsed.ffmpegEncoders && typeof parsed.ffmpegEncoders === 'object' && Object.keys(parsed.ffmpegEncoders).length > 0) {
              ffmpegEncoders = parsed.ffmpegEncoders;
            }
            sourceLabel = 'Settings benchmark';
          }
        }
      }
      if (!codecs && global.AndroidBridge && typeof global.AndroidBridge.getDeviceTelemetry === 'function') {
        const tel = JSON.parse(global.AndroidBridge.getDeviceTelemetry() || '{}');
        if (tel && tel.codecs) codecs = tel.codecs;
      }
    } catch (_) {}
    if (codecs || ffmpegEncoders) {
      _cachedSupport = { codecs: codecs || {}, ffmpegEncoders: ffmpegEncoders || null, sourceLabel: sourceLabel };
    }
    return _cachedSupport;
  }

  function getCodecCompatNote(opts) {
    if (!opts) return '';
    const sup = loadDeviceSupportSnapshot();
    if (!sup) return '';
    const c = sup.codecs || {};
    const enc = sup.ffmpegEncoders || null;
    const cat = normCat(opts.cat || opts.category || 'video');
    const cfg = opts.cfg || {};
    const specLower = String(opts.specs || opts.spec || '').toLowerCase();
    const codec = String(opts.codec || cfg.codec || cfg.vcodec || '').toLowerCase();
    const container = String(opts.container || cfg.container || cfg.fmt || cfg.format || '').replace(/^\./, '').toLowerCase();
    const pix = String(opts.pixfmt || cfg.pixfmt || (specLower.indexOf('yuv420p10le') !== -1 ? 'yuv420p10le' : 'yuv420p')).toLowerCase();
    const acodec = String(opts.acodec || cfg.acodec || '').toLowerCase();
    const reasons = [];

    if (cat === 'video' && codec !== 'copy') {
      const vc = codec || (specLower.indexOf('libsvtav1') !== -1 ? 'libsvtav1'
        : (specLower.indexOf('libx265') !== -1 ? 'libx265'
        : (specLower.indexOf('libvpx-vp9') !== -1 ? 'libvpx-vp9'
        : (specLower.indexOf('libx264') !== -1 ? 'libx264' : ''))));

      if (vc === 'libsvtav1' || vc === 'av1' || vc === 'libaom-av1') {
        const hasSwAv1 = enc ? Boolean(enc['libsvtav1'] || enc['libaom-av1'] || enc['librav1e']) : true;
        const hasHwAv1 = Boolean(c.av1HwEncode) && (!enc || Boolean(enc['av1_mediacodec']));
        if (enc && !hasSwAv1 && !hasHwAv1) {
          reasons.push('AV1 encoding is not supported on your device or engine');
        } else if (c.av1HwEncode === false) {
          reasons.push('AV1 hardware encoding is not supported on your device');
        } else if (c.av1HwDecode === false) {
          reasons.push('AV1 hardware playback is not supported on your device');
        }
      } else if (vc === 'libx265' || vc === 'hevc' || vc === 'h265') {
        if (enc && enc['libx265'] === false) {
          reasons.push('HEVC (libx265) encoder is not available');
        } else if (pix.indexOf('10') !== -1 && c.hevc10bitHwDecode === false) {
          reasons.push('HEVC 10-bit is not supported by your device hardware');
        } else if (c.hevcHwEncode === false) {
          reasons.push('HEVC hardware encoding is not supported on your device');
        }
      } else if (vc === 'libx264' || vc === 'h264' || vc === 'avc') {
        if (enc && enc['libx264'] === false) {
          reasons.push('H.264 (libx264) encoder is not available');
        } else if (pix.indexOf('10') !== -1 && c.h264_10bitHwDecode === false) {
          reasons.push('H.264 10-bit (Hi10P) is not supported by your device hardware');
        } else if (c.h264HwEncode === false) {
          reasons.push('H.264 hardware encoding is not supported on your device');
        }
      } else if (vc === 'libvpx-vp9' || vc === 'vp9') {
        if (enc && enc['libvpx-vp9'] === false) {
          reasons.push('VP9 (libvpx-vp9) encoder is not available');
        }
      }

      if (enc && acodec && Object.prototype.hasOwnProperty.call(enc, acodec) && enc[acodec] === false) {
        reasons.push(acodec + ' audio encoder is not available');
      }
    } else if (cat === 'audio') {
      const ac = codec || (container === 'opus' ? 'libopus' : (container === 'mp3' ? 'libmp3lame' : (container === 'flac' ? 'flac' : (container === 'm4a' ? 'aac' : ''))));
      if (enc && ac && Object.prototype.hasOwnProperty.call(enc, ac) && enc[ac] === false) {
        reasons.push(ac + ' audio encoder is not available');
      }
    } else if (cat === 'image') {
      if (container === 'avif' || /\.avif\b/.test(specLower)) {
        const hasAv1Enc = enc ? Boolean(enc['libaom-av1'] || enc['libsvtav1'] || enc['librav1e']) : Boolean(c.av1HwEncode);
        if (!hasAv1Enc && c.av1HwEncode === false) {
          reasons.push('AV1/AVIF encoding is not supported on your device');
        }
      } else if (container === 'webp' && enc && enc['libwebp'] === false) {
        reasons.push('WebP encoder is not available');
      }
    }

    if (!reasons.length) return '';
    return 'Note: Based on your ' + sup.sourceLabel + ', ' + reasons.join(' and ') + ' — this format may not be supported on your device for conversion.';
  }

  function renderCompatNoteHtml(note) {
    if (!note) return '';
    const esc = String(note).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<div role="note" style="margin-top:6px;background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.42);border-left:3px solid #f59e0b;border-radius:7px;padding:7px 9px;font-size:11.5px;line-height:1.4;color:#fbbf24;display:flex;align-items:flex-start;gap:6px;"><span aria-hidden="true" style="flex-shrink:0;font-size:12.5px;line-height:1.3;">⚠</span><span>' + esc + '</span></div>';
  }

  global.VaultPresets = {
    DEFAULT_CFG,
    hasBridge,
    normCat,
    catLabel,
    listActive,
    listDeleted,
    save,
    rename,
    softDelete,
    restore,
    permanentDelete,
    dedupe,
    exportAll,
    exportSelected,
    importArray,
    bindAutoSync,
    setPendingPreset,
    getPendingPreset,
    clearPendingPreset,
    getCodecCompatNote,
    renderCompatNoteHtml
  };
})(window);
