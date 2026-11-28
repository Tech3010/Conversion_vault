/* Conversion Vault — JSON Security & Privacy Guard
 * Scans every imported .json file (Custom Modules, Workflows, Presets) BEFORE saving or running.
 * Blocks XSS/HTML injection, prototype pollution, path traversal, shell chaining, and network exfiltration.
 */
(function (global) {
  'use strict';

  const MAX_JSON_BYTES = 512 * 1024; // 512 KB cap
  const MAX_DEPTH = 12;

  const ALLOWED_EXTS = new Set([
    'mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', '3gp',
    'mp3', 'm4a', 'opus', 'flac', 'wav', 'ogg', 'aac', 'ac3',
    'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'heic', 'bmp', 'tiff',
    'srt', 'vtt', 'txt', 'json'
  ]);

  const XSS_PATTERNS = [
    /<\s*script\b/i,
    /<\s*iframe\b/i,
    /<\s*object\b/i,
    /<\s*embed\b/i,
    /<\s*svg\b/i,
    /\bjavascript\s*:/i,
    /\bdata\s*:\s*text\/html/i,
    /\bon(error|load|click|mouseover|focus|input|submit)\s*=/i,
    /\beval\s*\(/i,
    /\bnew\s+Function\s*\(/i,
    /\bdocument\.(cookie|write|location)\b/i,
    /\bwindow\.location\b/i,
    /\bAndroidBridge\./i
  ];

  const FORBIDDEN_PATHS = [
    /(^|[\\/])\.\.([\\/]|$)/,
    /\/data\/(data|user|system)\b/i,
    /^\/(system|proc|dev|etc|root|sys|vendor)\b/i,
    /\/Android\/(data|obb)\b/i
  ];

  const NET_PROTOCOLS = /\b(https?|ftps?|rtmps?|rtsp|tcp|udp|srt|smb|sftp|gopher|tls|ssl|mmsh?|rtmpt|hls\+http|concat:http)\s*:/i;
  const SHELL_INJECT = /[;`$|\r\n]|&&|\|\||\$\(|>>|<<|[\x00-\x08\x0B\x0C\x0E-\x1F]/;
  const DANGEROUS_FFMPEG_FLAGS = /(^|\s)-(filter_script|filter_complex_script|passlogfile|sdp_file|progress|f\s+tee|protocol_whitelist)(\s|$)/i;

  function sanitizeAndInspectTree(node, depth, findings) {
    if (depth > MAX_DEPTH) {
      findings.push('JSON nesting exceeds safe depth limit');
      return null;
    }
    if (typeof node === 'string') {
      if (node.indexOf('\0') !== -1) {
        findings.push('Null byte detected in text field');
      }
      for (let i = 0; i < XSS_PATTERNS.length; i++) {
        if (XSS_PATTERNS[i].test(node)) {
          findings.push('Blocked unsafe script/HTML pattern in JSON');
          break;
        }
      }
      return node;
    }
    if (Array.isArray(node)) {
      if (node.length > 200) {
        findings.push('Too many items in a single JSON file (max 200)');
        return [];
      }
      return node.map(item => sanitizeAndInspectTree(item, depth + 1, findings));
    }
    if (node && typeof node === 'object') {
      const clean = {};
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
          findings.push('Blocked prototype-pollution key: ' + k);
          continue;
        }
        clean[k] = sanitizeAndInspectTree(node[k], depth + 1, findings);
      }
      return clean;
    }
    return node;
  }

  function checkPathSafety(pathStr, label, findings) {
    const p = String(pathStr || '').trim();
    if (!p) return;
    for (let i = 0; i < FORBIDDEN_PATHS.length; i++) {
      if (FORBIDDEN_PATHS[i].test(p)) {
        findings.push('Blocked restricted system or traversal path in ' + label);
        return;
      }
    }
  }

  function validateCustomModuleItem(m, findings) {
    if (!m || typeof m !== 'object') {
      findings.push('Invalid custom module entry');
      return;
    }
    const name = String(m.name || m.title || '').trim();
    const cmd = String(m.commandTemplate || m.command || m.ffmpegArgs || '').trim();
    if (!name || !cmd) {
      findings.push('Custom module must include "name" and "commandTemplate"');
      return;
    }
    if (cmd.length > 1500) {
      findings.push('Command template exceeds safe length (1500 chars)');
    }
    if (NET_PROTOCOLS.test(cmd)) {
      findings.push('Network URLs/protocols are blocked for offline privacy');
    }
    if (SHELL_INJECT.test(cmd)) {
      findings.push('Shell chaining or control characters are blocked');
    }
    if (DANGEROUS_FFMPEG_FLAGS.test(cmd)) {
      findings.push('Blocked restricted FFmpeg script/file flag');
    }
    // Block hardcoded absolute filesystem paths inside commandTemplate (must use {INPUT}/{OUTPUT})
    if (/(^|\s)["']?\/(storage|sdcard|data|system|proc|etc|mnt)\//i.test(cmd)) {
      findings.push('Hardcoded device paths are blocked in commandTemplate (use {INPUT} and {OUTPUT})');
    }
    const ext = String(m.outputExt || 'mp4').replace(/^\./, '').toLowerCase();
    if (ext && !ALLOWED_EXTS.has(ext)) {
      findings.push('Unsupported or unsafe output extension: .' + ext);
    }
    if (m.outputSubfolder) {
      checkPathSafety(m.outputSubfolder, 'outputSubfolder', findings);
    }
    if (Array.isArray(m.inputs)) {
      m.inputs.forEach(inp => {
        if (!inp || typeof inp !== 'object') return;
        const defVal = String(inp.default || '');
        if (NET_PROTOCOLS.test(defVal) || SHELL_INJECT.test(defVal)) {
          findings.push('Unsafe default value in module input "' + String(inp.key || '') + '"');
        }
      });
    }
  }

  function validateWorkflowItem(w, findings) {
    if (!w || typeof w !== 'object') {
      findings.push('Invalid workflow entry');
      return;
    }
    if (!String(w.name || '').trim()) {
      findings.push('Workflow is missing a name');
    }
    checkPathSafety(w.video && w.video.outputDir, 'video output folder', findings);
    checkPathSafety(w.audio && w.audio.outputDir, 'audio output folder', findings);
    checkPathSafety(w.image && w.image.outputDir, 'image output folder', findings);
    const suf = String((w.rules && w.rules.customSuffix) || '');
    if (suf && (/[\\/:*?"<>|]/.test(suf) || SHELL_INJECT.test(suf))) {
      findings.push('Unsafe characters in workflow filename suffix');
    }
  }

  function validatePresetItem(p, findings) {
    if (!p || typeof p !== 'object') {
      findings.push('Invalid preset entry');
      return;
    }
    const checkStr = [p.name, p.codec, p.container, p.crfOrBitrate, typeof p.extraFlags === 'string' ? p.extraFlags : ''].join(' ');
    if (NET_PROTOCOLS.test(checkStr)) {
      findings.push('Network URLs are blocked in preset files');
    }
    if (SHELL_INJECT.test(String(p.codec || '')) || SHELL_INJECT.test(String(p.container || ''))) {
      findings.push('Unsafe shell characters in preset codec/container');
    }
  }

  function validateJson(rawText, kind) {
    const str = String(rawText || '');
    if (!str.trim()) return { ok: false, reason: 'Empty JSON file' };
    if (str.length > MAX_JSON_BYTES) {
      return { ok: false, reason: 'JSON file is too large (max 512 KB)' };
    }
    let parsed;
    try {
      parsed = JSON.parse(str);
    } catch (_) {
      return { ok: false, reason: 'Malformed JSON syntax' };
    }

    const findings = [];
    const clean = sanitizeAndInspectTree(parsed, 0, findings);
    const items = Array.isArray(clean) ? clean : [clean];

    if (kind === 'custom_module') {
      items.forEach(m => validateCustomModuleItem(m, findings));
    } else if (kind === 'workflow') {
      items.forEach(w => validateWorkflowItem(w, findings));
    } else if (kind === 'preset') {
      items.forEach(p => validatePresetItem(p, findings));
    }

    if (findings.length > 0) {
      return { ok: false, reason: findings[0], reasons: findings };
    }
    return { ok: true, data: clean, items: items };
  }

  global.VaultJsonGuard = {
    validateJson
  };
})(window);
