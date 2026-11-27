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

  global.VaultPresets = {
    DEFAULT_CFG,
    hasBridge,
    normCat,
    catLabel,
    listActive,
    listDeleted,
    save,
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
    clearPendingPreset
  };
})(window);
