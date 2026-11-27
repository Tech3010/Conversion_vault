/* Conversion Vault — Shared Custom Modules Library (Single Source of Truth)
 * Stores user-imported JSON modules persistently via AndroidBridge.getAppState/setAppState + localStorage.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'cv_custom_modules_v1';

  function safeGet(key, fallback) {
    if (global.AndroidBridge && typeof global.AndroidBridge.getAppState === 'function') {
      try {
        const v = global.AndroidBridge.getAppState(key);
        if (v !== '' && v !== null && v !== undefined) return v;
      } catch (_) {}
    }
    try { return global.localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
  }

  function safeSet(key, val) {
    if (global.AndroidBridge && typeof global.AndroidBridge.setAppState === 'function') {
      try { global.AndroidBridge.setAppState(key, String(val)); } catch (_) {}
    }
    try { global.localStorage.setItem(key, String(val)); } catch (_) {}
  }

  function normalizeModule(m) {
    if (!m || typeof m !== 'object') return null;
    const name = String(m.name || m.title || '').trim();
    const cmd = String(m.commandTemplate || m.command || m.ffmpegArgs || '').trim();
    if (!name || !cmd) return null;
    const now = Date.now();
    const rawInputs = Array.isArray(m.inputs) ? m.inputs : [];
    const inputs = rawInputs
      .filter(inp => inp && typeof inp === 'object' && inp.key)
      .map(inp => ({
        key: String(inp.key).trim().toUpperCase().replace(/[^A-Z0-9_]/g, ''),
        label: String(inp.label || inp.key).trim(),
        type: ['text', 'number', 'select', 'range'].includes(String(inp.type || 'text').toLowerCase())
          ? String(inp.type || 'text').toLowerCase()
          : 'text',
        default: inp.default !== undefined ? String(inp.default) : '',
        min: inp.min !== undefined ? Number(inp.min) : undefined,
        max: inp.max !== undefined ? Number(inp.max) : undefined,
        step: inp.step !== undefined ? Number(inp.step) : undefined,
        options: Array.isArray(inp.options) ? inp.options.map(o => typeof o === 'object' ? { value: String(o.value), label: String(o.label || o.value) } : { value: String(o), label: String(o) }) : []
      }))
      .filter(inp => inp.key);

    return {
      id: String(m.id || ('cm_' + now + '_' + Math.random().toString(36).slice(2, 6))),
      name: name,
      badge: String(m.badge || m.tag || 'Custom').trim().slice(0, 18),
      description: String(m.description || m.desc || 'Custom FFmpeg module imported from JSON.').trim(),
      mediaType: String(m.mediaType || 'any').toLowerCase(),
      outputExt: String(m.outputExt || 'mp4').replace(/^\./, '').toLowerCase() || 'mp4',
      outputSubfolder: String(m.outputSubfolder || '').trim().replace(/[\\/:*?"<>|]/g, '_'),
      commandTemplate: cmd,
      inputs: inputs,
      createdAt: Number(m.createdAt) || now
    };
  }

  function list() {
    try {
      const parsed = JSON.parse(safeGet(STORAGE_KEY, '[]') || '[]');
      return Array.isArray(parsed) ? parsed.map(normalizeModule).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }

  function writeAll(arr) {
    safeSet(STORAGE_KEY, JSON.stringify(arr || []));
  }

  function getById(id) {
    const sid = String(id || '');
    if (!sid) return null;
    return list().find(m => m.id === sid) || null;
  }

  function importJson(rawText) {
    try {
      const parsed = JSON.parse(String(rawText || ''));
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const valid = arr.map(normalizeModule).filter(Boolean);
      if (!valid.length) {
        return { ok: false, added: 0, error: 'JSON must include "name" and "commandTemplate"' };
      }
      const existing = list();
      const byId = new Map(existing.map(m => [m.id, m]));
      let added = 0;
      valid.forEach(mod => {
        if (byId.has(mod.id)) {
          const idx = existing.findIndex(x => x.id === mod.id);
          if (idx >= 0) existing[idx] = mod;
        } else {
          existing.push(mod);
          byId.set(mod.id, mod);
        }
        added++;
      });
      writeAll(existing);
      return { ok: true, added: added, modules: valid };
    } catch (_) {
      return { ok: false, added: 0, error: 'Invalid JSON file' };
    }
  }

  function remove(id) {
    const sid = String(id || '');
    if (!sid) return { ok: false };
    const next = list().filter(m => m.id !== sid);
    writeAll(next);
    return { ok: true };
  }

  function buildCommand(mod, values) {
    if (!mod) return '';
    let cmd = String(mod.commandTemplate || '');
    const vals = values || {};
    (mod.inputs || []).forEach(inp => {
      const raw = vals[inp.key] !== undefined ? String(vals[inp.key]) : String(inp.default || '');
      // Strip shell-breaking quotes/newlines while keeping timestamps, filters, and numbers clean
      const safe = raw.replace(/[\r\n`"$;|&]/g, '').trim();
      cmd = cmd.split('{' + inp.key + '}').join(safe);
    });
    if (cmd.indexOf('{INPUT}') === -1) cmd = '-y -i {INPUT} ' + cmd;
    if (cmd.indexOf('{OUTPUT}') === -1) cmd = cmd + ' {OUTPUT}';
    return cmd;
  }

  global.VaultCustomModules = {
    list,
    getById,
    importJson,
    remove,
    buildCommand
  };
})(window);
