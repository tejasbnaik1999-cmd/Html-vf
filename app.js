/* Folio — library, viewer, backup/restore */
(() => {
'use strict';
const F = window.Folio;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LSK = 'folio.';
const ls = {
  get(k, d) { try { const v = localStorage.getItem(LSK + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(LSK + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(LSK + k); } catch (e) {} }
};
const toast = (m, ms = 2400) => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms); };
const newId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
function ago(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
const stamp = () => new Date().toISOString().slice(0, 10);
const baseName = (n) => n.replace(/\.(html?|xhtml)$/i, '');

let docs = [];          // metadata list
let current = null;     // id of the open document
let swReady = false;

/* ───────── boot ───────── */
async function boot() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js', { scope: './' });
      navigator.serviceWorker.ready.then(() => { swReady = true; });
    } catch (e) { console.warn('SW', e); }
  }
  let persisted = false;
  try { if (navigator.storage && navigator.storage.persist) persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch (e) {}
  ls.set('persisted', persisted);
  await refresh();
  showNotice();
  const reopen = ls.get('open', null);
  if (reopen && docs.some((d) => d.id === reopen)) openDoc(reopen);
}

async function refresh() {
  docs = (await F.getAll('docs')).sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
  render();
}

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const list = q ? docs.filter((d) => (d.title + ' ' + d.name).toLowerCase().includes(q)) : docs;
  $('#empty').hidden = docs.length > 0;
  $('#grid').hidden = docs.length === 0;
  $('#grid').innerHTML = list.map((d) => `
    <article class="card" data-id="${d.id}">
      <h3>${esc(d.title || baseName(d.name))}</h3>
      <div class="fn">${esc(d.name)}</div>
      ${d.keepEdits ? '<span class="badge">Keeps page edits</span>' : ''}
      <div class="meta">
        <span>${fmtSize(d.size)}</span>
        ${d.savedAt ? `<span class="ink">● Changes saved ${esc(ago(d.savedAt))}</span>` : `<span>Added ${esc(ago(d.addedAt))}</span>`}
      </div>
      <button class="more" data-more="${d.id}" aria-label="Options">⋯</button>
    </article>`).join('') || (q ? `<p style="color:var(--muted)">Nothing matches “${esc(q)}”.</p>` : '');
  const lb = ls.get('lastBackup', 0);
  $('#foot').textContent = docs.length
    ? `${docs.length} file${docs.length > 1 ? 's' : ''} · saved on this iPad · ` + (lb ? `last backup ${ago(lb)}` : 'not backed up yet')
    : '';
}

function showNotice() {
  const n = $('#notice');
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const lb = ls.get('lastBackup', 0), anyEdits = docs.some((d) => d.savedAt && d.savedAt > lb);
  let html = '';
  if (!standalone && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
    html = 'Install Folio: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>. Open it from the Home Screen icon so your notes stay safe and it works offline.';
  } else if (anyEdits && (!lb || Date.now() - lb > 7 * 86400000)) {
    html = 'You have changes that aren’t backed up yet. Keep a copy in Files or iCloud Drive in case this iPad is reset. <button id="nBackup">Back up now</button>';
  }
  n.innerHTML = html; n.hidden = !html;
  const b = $('#nBackup'); if (b) b.onclick = () => backupSheet();
}

/* ───────── import ───────── */
$('#bImport').onclick = $('#bImport2').onclick = () => $('#file').click();
$('#file').onchange = async (e) => { const fs = [...e.target.files]; e.target.value = ''; await importFiles(fs); };

async function importFiles(files) {
  files = files.filter((f) => /\.(html?|xhtml)$/i.test(f.name) || f.type === 'text/html');
  if (!files.length) { toast('Pick .html files'); return; }
  let added = 0;
  for (const f of files) {
    const same = docs.find((d) => d.name === f.name);
    if (same) {
      const choice = await ask(`“${f.name}” is already in your library`, 'Replace keeps all the notes and ink you made in it. Keep both adds a separate copy with no notes.',
        [['replace', 'Replace file, keep my notes', 'primary'], ['both', 'Keep both'], ['skip', 'Skip']]);
      if (choice === 'replace') { await replaceFile(same.id, f); added++; continue; }
      if (choice !== 'both') continue;
    }
    await addFile(f); added++;
  }
  await refresh(); showNotice();
  if (added) toast(added === 1 ? 'Added' : `Added ${added} files`);
}

async function describe(file) {
  const blob = file instanceof Blob ? file : new Blob([file]);
  const offset = await F.findInjectOffset(blob);
  let title = '';
  try { title = F.findTitle(await blob.text()); } catch (e) {}
  return { blob, offset, title };
}

async function addFile(file, id) {
  const { blob, offset, title } = await describe(file);
  id = id || newId();
  await F.put('files', blob, id);
  await F.put('docs', { id, name: file.name || 'Untitled.html', title, size: blob.size, offset, addedAt: Date.now(), openedAt: 0, savedAt: 0, keepEdits: false });
  return id;
}

async function replaceFile(id, file) {
  const meta = await F.get('docs', id);
  const { blob, offset, title } = await describe(file);
  await F.put('files', blob, id);
  Object.assign(meta, { name: file.name, title: title || meta.title, size: blob.size, offset, replacedAt: Date.now() });
  await F.put('docs', meta);
}

/* drag & drop from Files (Split View / Slide Over) */
let dragN = 0;
addEventListener('dragenter', (e) => { if (current) return; e.preventDefault(); dragN++; document.body.classList.add('drag'); });
addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('drag'); } });
addEventListener('dragover', (e) => { if (!current) e.preventDefault(); });
addEventListener('drop', (e) => { if (current) return; e.preventDefault(); dragN = 0; document.body.classList.remove('drag'); importFiles([...e.dataTransfer.files]); });

$('#q').oninput = render;
$('#grid').addEventListener('click', (e) => {
  const m = e.target.closest('[data-more]');
  if (m) { e.stopPropagation(); docSheet(m.dataset.more); return; }
  const c = e.target.closest('.card'); if (c) openDoc(c.dataset.id);
});

/* ───────── viewer ───────── */
const frame = $('#frame'), viewer = $('#viewer'), dot = $('#tab .dot'), vStat = $('#vStat');
let blobUrl = null, savedT = null, metaT = null;

async function openDoc(id) {
  const meta = await F.get('docs', id);
  if (!meta) return;
  meta.openedAt = Date.now(); await F.put('docs', meta);
  current = id; ls.set('open', id);
  $('#vTitle').textContent = meta.title || baseName(meta.name);
  setStat('busy', 'Opening…');
  closeSheet(null); viewer.hidden = false; $('#library').hidden = true; hideMenu();
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    frame.src = 'doc/' + id + '/?t=' + Date.now();
  } else {
    const b = await F.composeDoc(id);
    blobUrl = URL.createObjectURL(b); frame.src = blobUrl;
  }
}
frame.addEventListener('load', () => { if (current) setStat('ok', 'Ready · every change is saved on this iPad'); });

function setStat(kind, text) { dot.className = 'dot ' + (kind || ''); vStat.textContent = text; }

/* called by the shim inside the open file */
window.__folioEvent = (id, kind, info) => {
  if (id !== current) return;
  if (kind === 'save') {
    dot.className = 'dot busy';
    clearTimeout(savedT);
    savedT = setTimeout(() => setStat('ok', 'Saved · ' + new Date().toLocaleTimeString()), 250);
    clearTimeout(metaT);
    metaT = setTimeout(async () => { const m = await F.get('docs', id); if (m) { m.savedAt = Date.now(); await F.put('docs', m); } }, 1500);
  } else if (kind === 'error') setStat('bad', 'Not saved: ' + (info || 'error'));
};

/* lets files with their own "export" buttons save into Files */
window.__folioSaveFile = (name, blob) => saveFile(name, blob);

async function closeDoc() {
  const id = current; if (!id) return;
  setStat('busy', 'Saving…');
  try {
    const w = frame.contentWindow;
    if (w && w.__folioFlush) {
      w.__folioFlush();
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 350));
      while (w.__folioPending && w.__folioPending() > 0 && Date.now() - t0 < 2500) await new Promise((r) => setTimeout(r, 80));
    }
  } catch (e) {}
  current = null; ls.del('open');
  frame.src = 'about:blank';
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  viewer.hidden = true; $('#library').hidden = false; hideMenu();
  await refresh(); showNotice();
}

/* edge tab: tap for menu, drag to move */
const tab = $('#tab'), vmenu = $('#vmenu');
function placeTab() {
  const p = ls.get('tab', { side: 'right', y: 0.4 });
  tab.classList.toggle('left', p.side === 'left'); vmenu.classList.toggle('left', p.side === 'left');
  tab.style.top = (p.y * 100) + '%';
  vmenu.style.top = `clamp(12px, calc(${p.y * 100}% - 60px), calc(100% - 300px))`;
}
placeTab();
let drag = null;
tab.addEventListener('pointerdown', (e) => { drag = { y0: e.clientY, moved: false }; tab.setPointerCapture(e.pointerId); });
tab.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.abs(e.clientY - drag.y0) > 6) drag.moved = true;
  if (drag.moved) { const y = Math.min(0.92, Math.max(0.04, e.clientY / innerHeight)); tab.style.top = (y * 100) + '%'; drag.y = y; }
});
tab.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.moved && drag.y) { const p = ls.get('tab', { side: 'right', y: 0.4 }); p.y = drag.y; ls.set('tab', p); placeTab(); }
  else toggleMenu();
  drag = null;
});
tab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') toggleMenu(); });
function toggleMenu() { vmenu.hidden = !vmenu.hidden; }
function hideMenu() { vmenu.hidden = true; }
$('#vBack').onclick = closeDoc;
$('#vReload').onclick = async () => { hideMenu(); const id = current; try { frame.contentWindow.__folioFlush(); } catch (e) {} await new Promise((r) => setTimeout(r, 600)); openDoc(id); };
$('#vBackup').onclick = () => { hideMenu(); exportNotes(current); };
$('#vTabSide').onclick = () => { const p = ls.get('tab', { side: 'right', y: 0.4 }); p.side = p.side === 'left' ? 'right' : 'left'; ls.set('tab', p); placeTab(); };
document.addEventListener('pointerdown', (e) => { if (!vmenu.hidden && !e.target.closest('#vmenu,#tab')) hideMenu(); });

/* ───────── per-file options ───────── */
async function docSheet(id) {
  const d = await F.get('docs', id); if (!d) return;
  const html = `
    <h2>${esc(d.title || baseName(d.name))}</h2>
    <p>${esc(d.name)} · ${fmtSize(d.size)}${d.savedAt ? ' · changes saved ' + esc(ago(d.savedAt)) : ''}</p>
    <div class="list">
      <button data-a="open" class="primary">Open</button>
      <button data-a="rename">Rename</button>
      <button data-a="replace">Replace with a newer version <small>keeps notes</small></button>
      <label class="switch"><span>Keep page edits<small>For simple files without their own saving: remembers typed text and form answers.</small></span><input type="checkbox" data-a="keep" ${d.keepEdits ? 'checked' : ''}></label>
      <button data-a="notes">Back up this file’s notes <small>.json</small></button>
      <button data-a="restore">Restore notes from a backup</button>
      <button data-a="orig">Save the original HTML to Files</button>
      <button data-a="clear" class="danger">Erase all notes in this file</button>
      <button data-a="delete" class="danger">Remove from library</button>
    </div>
    <div class="row"><button data-a="close">Done</button></div>`;
  const sh = sheet(html);
  sh.querySelector('[data-a="keep"]').onchange = async (e) => { d.keepEdits = e.target.checked; await F.put('docs', d); await refresh(); toast(d.keepEdits ? 'Typed text will be remembered' : 'Turned off'); };
  sh.onclick = async (e) => {
    const a = e.target.closest('button[data-a]'); if (!a) return;
    const act = a.dataset.a;
    if (act === 'close') return closeSheet();
    if (act === 'open') { closeSheet(); return openDoc(id); }
    if (act === 'rename') {
      const v = await promptText('Rename', d.title || baseName(d.name)); if (v == null) return docSheet(id);
      d.title = v.trim() || d.title; await F.put('docs', d); await refresh(); return docSheet(id);
    }
    if (act === 'replace') { closeSheet(); return pickOne('.html,.htm,text/html', async (f) => { await replaceFile(id, f); await refresh(); toast('Replaced · notes kept'); }); }
    if (act === 'notes') { closeSheet(); return exportNotes(id); }
    if (act === 'restore') { closeSheet(); return pickOne('.json,application/json', (f) => restoreFrom(f, id)); }
    if (act === 'orig') { closeSheet(); const b = await F.get('files', id); return saveFile(d.name, new Blob([b], { type: 'text/html' })); }
    if (act === 'clear') {
      const ok = await ask('Erase all notes?', 'This removes every stroke, highlight and note saved inside this file. The file itself stays.', [['yes', 'Erase', 'danger'], ['no', 'Cancel']]);
      if (ok === 'yes') { await wipeStorage(id); d.savedAt = 0; await F.put('docs', d); await refresh(); toast('Erased'); } else docSheet(id);
      return;
    }
    if (act === 'delete') {
      const ok = await ask('Remove this file?', 'The file and everything you wrote in it will be deleted from this iPad. Back up its notes first if you may want them.', [['yes', 'Remove', 'danger'], ['backup', 'Back up notes first'], ['no', 'Cancel']]);
      if (ok === 'backup') return exportNotes(id);
      if (ok === 'yes') { await wipeStorage(id); await F.del('files', id); await F.del('docs', id); await refresh(); toast('Removed'); } else docSheet(id);
    }
  };
}

/* ───────── storage of one document: dump / wipe / load ───────── */
const nsOf = (id) => F.NS_PREFIX + id + '/';
const metaOf = (id) => F.META_PREFIX + id + '/';

async function dbNames(id) {
  const ns = nsOf(id), names = new Set();
  try { (JSON.parse(localStorage.getItem(metaOf(id) + 'dbs') || '[]')).forEach((n) => names.add(n)); } catch (e) {}
  try { if (indexedDB.databases) (await indexedDB.databases()).forEach((x) => { if (x.name && x.name.startsWith(ns)) names.add(x.name.slice(ns.length)); }); } catch (e) {}
  return [...names];
}
function lsKeys(prefix) { const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(prefix)) out.push(k); } return out; }

function openExisting(full) {
  return new Promise((res) => {
    let created = false;
    const r = indexedDB.open(full);
    r.onupgradeneeded = () => { created = true; r.transaction.abort(); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
    r.onblocked = () => res(null);
    void created;
  });
}

async function enc(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return { $f: 'date', v: v.getTime() };
  if (v instanceof Blob) return { $f: 'blob', type: v.type, name: v.name || undefined, b64: await toB64(new Uint8Array(await v.arrayBuffer())) };
  if (v instanceof ArrayBuffer) return { $f: 'ab', b64: await toB64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { $f: 'ta', ctor: v.constructor.name, b64: await toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (v instanceof Map) return { $f: 'map', v: await Promise.all([...v].map(async ([a, b]) => [await enc(a), await enc(b)])) };
  if (v instanceof Set) return { $f: 'set', v: await Promise.all([...v].map(enc)) };
  if (Array.isArray(v)) return Promise.all(v.map(enc));
  const o = {}; for (const k of Object.keys(v)) o[k] = await enc(v[k]);
  if (o.$f !== undefined) return { $f: 'obj', v: o };
  return o;
}
function dec(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(dec);
  switch (v.$f) {
    case 'date': return new Date(v.v);
    case 'blob': { const b = fromB64(v.b64); return v.name ? new File([b], v.name, { type: v.type }) : new Blob([b], { type: v.type }); }
    case 'ab': return fromB64(v.b64).buffer;
    case 'ta': { const u = fromB64(v.b64); const C = self[v.ctor] || Uint8Array; return new C(u.buffer, 0, u.byteLength / (C.BYTES_PER_ELEMENT || 1)); }
    case 'map': return new Map(v.v.map(([a, b]) => [dec(a), dec(b)]));
    case 'set': return new Set(v.v.map(dec));
    case 'obj': { const o = {}; for (const k of Object.keys(v.v)) o[k] = dec(v.v[k]); return o; }
  }
  const o = {}; for (const k of Object.keys(v)) o[k] = dec(v[k]); return o;
}
async function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); }
function fromB64(b) { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

async function dumpStorage(id) {
  const ns = nsOf(id), mp = metaOf(id);
  const local = {}; lsKeys(ns).forEach((k) => { local[k.slice(ns.length)] = localStorage.getItem(k); });
  const meta = {}; lsKeys(mp).forEach((k) => { meta[k.slice(mp.length)] = localStorage.getItem(k); });
  const dbs = [];
  for (const name of await dbNames(id)) {
    const db = await openExisting(ns + name); if (!db) continue;
    const stores = [];
    for (const sn of [...db.objectStoreNames]) {
      const tx = db.transaction(sn), st = tx.objectStore(sn);
      const [keys, vals] = await Promise.all([F.reqP(st.getAllKeys()), F.reqP(st.getAll())]);
      const indexes = [...st.indexNames].map((n) => { const ix = st.index(n); return { name: n, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }; });
      const records = [];
      for (let i = 0; i < keys.length; i++) records.push([await enc(keys[i]), await enc(vals[i])]);
      stores.push({ name: sn, keyPath: st.keyPath, autoIncrement: st.autoIncrement, indexes, records });
    }
    dbs.push({ name, version: db.version, stores });
    db.close();
  }
  return { local, meta, dbs };
}
const hasData = (s) => s && (Object.keys(s.local).length || s.dbs.some((d) => d.stores.some((x) => x.records.length)) || s.meta.edits);

async function wipeStorage(id) {
  const names = await dbNames(id);
  lsKeys(nsOf(id)).forEach((k) => localStorage.removeItem(k));
  lsKeys(metaOf(id)).forEach((k) => localStorage.removeItem(k));
  for (const n of names) await new Promise((r) => { const q = indexedDB.deleteDatabase(nsOf(id) + n); q.onsuccess = q.onerror = q.onblocked = () => r(); });
}

async function loadStorage(id, s) {
  await wipeStorage(id);
  const ns = nsOf(id), mp = metaOf(id);
  for (const k in s.local) localStorage.setItem(ns + k, s.local[k]);
  for (const k in (s.meta || {})) localStorage.setItem(mp + k, s.meta[k]);
  const names = s.dbs.map((d) => d.name);
  localStorage.setItem(mp + 'dbs', JSON.stringify(names));
  for (const d of s.dbs) {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(ns + d.name, d.version || 1);
      r.onupgradeneeded = () => {
        for (const st of d.stores) {
          const os = r.result.createObjectStore(st.name, { keyPath: st.keyPath == null ? undefined : st.keyPath, autoIncrement: st.autoIncrement });
          for (const ix of st.indexes || []) os.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
        }
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    for (const st of d.stores) {
      if (!st.records.length) continue;
      const tx = db.transaction(st.name, 'readwrite'), os = tx.objectStore(st.name);
      for (const [k, v] of st.records) st.keyPath == null ? os.put(dec(v), dec(k)) : os.put(dec(v));
      await F.txDone(tx);
    }
    db.close();
  }
}

/* ───────── backup & restore ───────── */
async function exportNotes(id) {
  const d = await F.get('docs', id); if (!d) return;
  toast('Preparing backup…', 8000);
  if (current === id) { try { frame.contentWindow.__folioFlush(); } catch (e) {} await new Promise((r) => setTimeout(r, 700)); }
  const storage = await dumpStorage(id);
  if (!hasData(storage)) { toast('No notes saved in this file yet'); return; }
  const payload = { app: 'folio', kind: 'notes', version: 1, exportedAt: new Date().toISOString(), docs: [{ meta: strip(d), storage }] };
  await saveFile(`${baseName(d.name)} — notes ${stamp()}.json`, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
}
const strip = (d) => ({ id: d.id, name: d.name, title: d.title, keepEdits: d.keepEdits, addedAt: d.addedAt, savedAt: d.savedAt });

async function backupAll(withFiles) {
  toast('Preparing backup…', 20000);
  const out = { app: 'folio', kind: withFiles ? 'full' : 'notes', version: 1, exportedAt: new Date().toISOString(), docs: [] };
  for (const d of docs) {
    const item = { meta: strip(d), storage: await dumpStorage(d.id) };
    if (withFiles) item.html = await (await F.get('files', d.id)).text();
    if (withFiles || hasData(item.storage)) out.docs.push(item);
  }
  if (!out.docs.length) { toast('Nothing to back up yet'); return; }
  const ok = await saveFile(`Folio ${withFiles ? 'full backup' : 'notes backup'} ${stamp()}.json`, new Blob([JSON.stringify(out)], { type: 'application/json' }));
  if (ok) { ls.set('lastBackup', Date.now()); render(); showNotice(); }
}

async function restoreFrom(file, onlyId) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('That file is not a Folio backup'); return; }
  if (!data || data.app !== 'folio' || !Array.isArray(data.docs)) {
    if (data && data.notes && onlyId) toast('This is the file’s own export — open the file and use its own import button');
    else toast('That file is not a Folio backup');
    return;
  }
  let items = data.docs;
  if (onlyId) {
    if (items.length > 1) items = items.filter((x) => x.meta.id === onlyId);
    if (!items.length) { toast('This backup has no notes for this file'); return; }
    items = [Object.assign({}, items[0], { meta: Object.assign({}, items[0].meta, { id: onlyId }), html: undefined })];
  }
  const fresh = await F.getAll('docs');
  let n = 0, missing = 0;
  for (const it of items) {
    let target = fresh.find((d) => d.id === it.meta.id) || (!onlyId && fresh.find((d) => d.name === it.meta.name));
    if (!target && it.html) {
      const id = await addFile(new File([it.html], it.meta.name, { type: 'text/html' }), it.meta.id);
      target = await F.get('docs', id);
      Object.assign(target, { title: it.meta.title || target.title, keepEdits: !!it.meta.keepEdits, addedAt: it.meta.addedAt || Date.now() });
    }
    if (!target) { missing++; continue; }
    await loadStorage(target.id, it.storage);
    target.savedAt = it.meta.savedAt || Date.now();
    await F.put('docs', target); n++;
  }
  await refresh(); showNotice();
  toast(`Restored ${n} file${n === 1 ? '' : 's'}` + (missing ? ` · ${missing} skipped (add those HTML files first, then restore again)` : ''), 5000);
}

function backupSheet() {
  const lb = ls.get('lastBackup', 0);
  const sh = sheet(`
    <h2>Backup &amp; restore</h2>
    <p>Everything is saved on this iPad automatically. A backup is a single file you keep in Files or iCloud Drive, so nothing is lost if the iPad is reset or the app is removed.</p>
    <p>${lb ? 'Last backup: ' + esc(ago(lb)) : 'No backup yet.'}${ls.get('persisted', false) ? '' : ' Storage is not yet marked permanent; open Folio from its Home Screen icon.'}</p>
    <div class="list">
      <button data-a="notes" class="primary">Back up all notes <small>small file</small></button>
      <button data-a="full">Full backup <small>HTML files + notes</small></button>
      <button data-a="restore">Restore from a backup…</button>
    </div>
    <div class="row"><button data-a="close">Done</button></div>`);
  sh.onclick = (e) => {
    const a = e.target.closest('button[data-a]'); if (!a) return;
    closeSheet();
    if (a.dataset.a === 'notes') backupAll(false);
    else if (a.dataset.a === 'full') backupAll(true);
    else if (a.dataset.a === 'restore') pickOne('.json,application/json', (f) => restoreFrom(f));
  };
}
$('#bMore').onclick = backupSheet;
$('#restoreFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; const cb = pickOne.cb; pickOne.cb = null; if (f && cb) cb(f); };
function pickOne(accept, cb) { const i = $('#restoreFile'); i.accept = accept; pickOne.cb = cb; i.click(); }

/* Save a file to Files: share sheet when possible, otherwise a download. */
async function saveFile(name, blob) {
  const file = new File([blob], name.replace(/[\\/:*?"<>|]/g, '-'), { type: blob.type || 'application/octet-stream' });
  const tryShare = async () => {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return true; }
    return null;
  };
  try {
    const r = await tryShare();
    if (r) { toast('Saved'); return true; }
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
    if (e && e.name === 'NotAllowedError') {
      // iOS needs a fresh tap for the share sheet after a long preparation step
      const go = await ask('Backup ready', file.name + ' · ' + fmtSize(file.size), [['save', 'Save to Files…', 'primary'], ['no', 'Cancel']]);
      if (go !== 'save') return false;
      try { if (await tryShare()) { toast('Saved'); return true; } } catch (e2) { if (e2 && e2.name === 'AbortError') return false; }
    }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast('Saved to Downloads');
  return true;
}

/* ───────── sheets ───────── */
let sheetResolve = null;
function sheet(html) {
  $('#sheet').innerHTML = html; $('#sheetWrap').hidden = false; $('#sheet').onclick = null;
  return $('#sheet');
}
function closeSheet(v) { $('#sheetWrap').hidden = true; if (sheetResolve) { const r = sheetResolve; sheetResolve = null; r(v); } }
$('#sheetWrap').addEventListener('pointerdown', (e) => { if (e.target.id === 'sheetWrap') closeSheet(null); });
function ask(title, text, buttons) {
  return new Promise((res) => {
    const sh = sheet(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="list">${buttons.map(([v, l, cls]) => `<button data-v="${v}" class="${cls || ''}">${esc(l)}</button>`).join('')}</div>`);
    sheetResolve = res;
    sh.onclick = (e) => { const b = e.target.closest('button[data-v]'); if (b) closeSheet(b.dataset.v); };
  });
}
function promptText(title, value) {
  return new Promise((res) => {
    const sh = sheet(`<h2>${esc(title)}</h2><input type="text" id="pt" value="${esc(value)}"><div class="row"><button data-v="0">Cancel</button><button data-v="1" class="primary">Save</button></div>`);
    sheetResolve = res; const inp = sh.querySelector('#pt'); inp.focus(); inp.select();
    inp.onkeydown = (e) => { if (e.key === 'Enter') closeSheet(inp.value); };
    sh.onclick = (e) => { const b = e.target.closest('button[data-v]'); if (b) closeSheet(b.dataset.v === '1' ? inp.value : null); };
  });
}

/* save before the app is sent to the background */
document.addEventListener('visibilitychange', () => { if (document.hidden && current) { try { frame.contentWindow.__folioFlush(); } catch (e) {} } });

window.__folio = { importFiles, openDoc, closeDoc, dumpStorage, restoreFrom, backupAll }; // used by tests
boot();
})();
