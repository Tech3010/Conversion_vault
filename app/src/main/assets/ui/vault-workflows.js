/* Conversion Vault — Unified Common Workflow Library (Single Source of Truth)
 * Mirrors vault-presets.js architecture across:
 * Workflows Hub (p9), Settings (p6), File Selector (p2_select), Batch Preview (p3_batch).
 * All create, edit, rename, soft-delete, restore, permanent delete, dedupe, import, and export
 * operations go through window.VaultWorkflows so every screen stays 100% in sync.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'cv_workflows_v1';
  const PENDING_KEY = 'cv_pending_workflow';
  const TTL_KEY = 'cv_workflow_trash_ttl';

  function hasBridge() {
    return !!(global.AndroidBridge && typeof global.AndroidBridge.getAppState === 'function');
  }

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

  function getTrashTtlRaw() {
    return safeGet(TTL_KEY, '30') || '30';
  }

  function getTrashTtlDays() {
    const raw = getTrashTtlRaw();
    if (raw === 'never') return 0;
    const n = parseInt(raw, 10);
    return isNaN(n) || n < 0 ? 30 : n;
  }

  function setTrashTtlDays(val) {
    const s = String(val || '30');
    safeSet(TTL_KEY, s);
    return s;
  }

  function normalizeWorkflow(v) {
    if (!v || typeof v !== 'object') return null;
    const now = Date.now();
    return {
      id: String(v.id || ('wf_' + now + '_' + Math.random().toString(36).slice(2, 6))),
      name: String(v.name || 'Untitled Workflow').trim() || 'Untitled Workflow',
      desc: String(v.desc || '').trim(),
      video: {
        presetId: String((v.video && v.video.presetId) || '__skip__'),
        outputDir: String((v.video && v.video.outputDir) || '').trim()
      },
      audio: {
        presetId: String((v.audio && v.audio.presetId) || '__skip__'),
        outputDir: String((v.audio && v.audio.outputDir) || '').trim()
      },
      image: {
        presetId: String((v.image && v.image.presetId) || '__skip__'),
        outputDir: String((v.image && v.image.outputDir) || '').trim()
      },
      rules: Object.assign(
        {
          filenameRule: 'keep',
          customSuffix: '',
          metaPolicy: 'preset',
          skipRule: 'none',
          skipSmallerMB: 5,
          sourceAction: 'keep'
        },
        v.rules || {}
      ),
      deleted: !!v.deleted,
      deletedAt: v.deleted ? (Number(v.deletedAt) || now) : null,
      createdAt: Number(v.createdAt) || now,
      updatedAt: Number(v.updatedAt) || now
    };
  }

  function readAllRaw() {
    let arr = [];
    try {
      const parsed = JSON.parse(safeGet(STORAGE_KEY, '[]') || '[]');
      if (Array.isArray(parsed)) arr = parsed.map(normalizeWorkflow).filter(Boolean);
    } catch (_) {
      arr = [];
    }
    const ttlDays = getTrashTtlDays();
    if (ttlDays > 0 && arr.length > 0) {
      const cutoff = Date.now() - ttlDays * 86400000;
      const kept = arr.filter(w => !w.deleted || !w.deletedAt || w.deletedAt >= cutoff);
      if (kept.length !== arr.length) {
        writeAllRaw(kept);
        return kept;
      }
    }
    return arr;
  }

  function writeAllRaw(list) {
    safeSet(STORAGE_KEY, JSON.stringify(list || []));
  }

  function listActive() {
    return readAllRaw().filter(w => !w.deleted);
  }

  function listDeleted() {
    return readAllRaw().filter(w => !!w.deleted);
  }

  function getById(id) {
    const sid = String(id || '');
    if (!sid) return null;
    return readAllRaw().find(w => w.id === sid) || null;
  }

  function save(wf) {
    const clean = normalizeWorkflow(wf);
    if (!clean) return { ok: false, error: 'Invalid workflow' };
    const all = readAllRaw();
    const idx = all.findIndex(x => x.id === clean.id);
    if (idx >= 0) {
      clean.createdAt = all[idx].createdAt || clean.createdAt;
      clean.updatedAt = Date.now();
      all[idx] = clean;
    } else {
      all.unshift(clean);
    }
    writeAllRaw(all);
    return { ok: true, id: clean.id, workflow: clean };
  }

  function rename(id, newName) {
    const sid = String(id || '');
    const trimmed = String(newName || '').trim();
    if (!sid) return { ok: false, error: 'Missing workflow id' };
    if (!trimmed) return { ok: false, error: 'Workflow name required' };
    const all = readAllRaw();
    const hit = all.find(x => x.id === sid);
    if (!hit) return { ok: false, error: 'Workflow not found' };
    hit.name = trimmed;
    hit.updatedAt = Date.now();
    writeAllRaw(all);
    // Sync pending workflow if currently active
    const pending = getPendingWorkflow();
    if (pending && pending.id === sid) {
      pending.name = trimmed;
      setPendingWorkflow(pending);
    }
    return { ok: true, id: sid, name: trimmed, workflow: hit };
  }

  function softDelete(id) {
    const sid = String(id || '');
    if (!sid) return { ok: false, error: 'Missing workflow id' };
    const all = readAllRaw();
    const hit = all.find(x => x.id === sid);
    if (!hit) return { ok: false, error: 'Workflow not found' };
    hit.deleted = true;
    hit.deletedAt = Date.now();
    writeAllRaw(all);
    return { ok: true, id: sid };
  }

  function restore(id) {
    const sid = String(id || '');
    if (!sid) return { ok: false, error: 'Missing workflow id' };
    const all = readAllRaw();
    const hit = all.find(x => x.id === sid);
    if (!hit) return { ok: false, error: 'Workflow not found' };
    hit.deleted = false;
    hit.deletedAt = null;
    hit.updatedAt = Date.now();
    writeAllRaw(all);
    return { ok: true, id: sid };
  }

  function permanentDelete(id) {
    const sid = String(id || '');
    if (!sid) return { ok: false, error: 'Missing workflow id' };
    const all = readAllRaw();
    const next = all.filter(x => x.id !== sid);
    writeAllRaw(next);
    return { ok: true, id: sid };
  }

  function dedupe() {
    const all = readAllRaw();
    const seen = new Set();
    let removed = 0;
    const removedIds = [];
    const kept = [];
    all.forEach(w => {
      if (w.deleted) {
        kept.push(w);
        return;
      }
      const sig = [
        w.name.toLowerCase(),
        w.video.presetId, w.video.outputDir,
        w.audio.presetId, w.audio.outputDir,
        w.image.presetId, w.image.outputDir
      ].join('|');
      if (seen.has(sig)) {
        removed++;
        removedIds.push(w.id);
      } else {
        seen.add(sig);
        kept.push(w);
      }
    });
    if (removed > 0) writeAllRaw(kept);
    return { ok: true, removed, removedIds };
  }

  function exportItems(items, baseName) {
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, error: 'No workflows selected' };
    }
    const payload = items.length === 1 ? items[0] : items;
    const str = JSON.stringify(payload, null, 2);
    const safeName = String(baseName || 'conversion_vault_workflows').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'conversion_vault_workflows';
    if (global.AndroidBridge && typeof global.AndroidBridge.exportWorkflowJson === 'function') {
      try {
        const res = JSON.parse(global.AndroidBridge.exportWorkflowJson(safeName, str) || '{}');
        if (res && res.ok) return { ok: true, count: items.length, path: res.path || '', name: res.name || (safeName + '.json') };
        return { ok: false, error: (res && res.error) || 'Export failed' };
      } catch (e) {
        return { ok: false, error: String(e && e.message || 'Export failed') };
      }
    }
    try {
      const blob = new Blob([str], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = safeName + '.json';
      a.click();
      return { ok: true, count: items.length, name: safeName + '.json' };
    } catch (_) {
      return { ok: false, error: 'Export failed' };
    }
  }

  function exportAll() {
    return exportItems(listActive(), 'conversion_vault_workflows');
  }

  function exportSelected(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'No workflows selected' };
    const want = new Set(ids.map(String));
    const picked = listActive().filter(w => want.has(w.id));
    const base = picked.length === 1 ? picked[0].name : 'conversion_vault_selected_workflows';
    return exportItems(picked, base);
  }

  function importJson(rawText) {
    try {
      const parsed = JSON.parse(String(rawText || ''));
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const valid = arr.filter(x => x && typeof x === 'object' && x.name && (x.video || x.audio || x.image));
      if (!valid.length) return { ok: false, added: 0, error: 'Invalid workflow JSON file' };
      const all = readAllRaw();
      const existingIds = new Set(all.map(x => x.id));
      let added = 0;
      valid.forEach(v => {
        const norm = normalizeWorkflow(v);
        if (!norm) return;
        if (existingIds.has(norm.id)) {
          norm.id = 'wf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        }
        norm.deleted = false;
        norm.deletedAt = null;
        norm.updatedAt = Date.now();
        existingIds.add(norm.id);
        all.unshift(norm);
        added++;
      });
      writeAllRaw(all);
      return { ok: true, added };
    } catch (_) {
      return { ok: false, added: 0, error: 'Could not parse workflow JSON' };
    }
  }

  function setPendingWorkflow(wf) {
    if (!wf) return;
    safeSet(PENDING_KEY, JSON.stringify(wf));
  }

  function getPendingWorkflow() {
    try {
      const raw = safeGet(PENDING_KEY, '') || '';
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return (obj && obj.id) ? obj : null;
    } catch (_) {
      return null;
    }
  }

  function clearPendingWorkflow() {
    safeSet(PENDING_KEY, '');
  }

  global.VaultWorkflows = {
    hasBridge,
    listActive,
    listDeleted,
    getById,
    save,
    rename,
    softDelete,
    restore,
    permanentDelete,
    dedupe,
    exportItems,
    exportAll,
    exportSelected,
    importJson,
    getTrashTtlRaw,
    getTrashTtlDays,
    setTrashTtlDays,
    setPendingWorkflow,
    getPendingWorkflow,
    clearPendingWorkflow
  };
})(window);
