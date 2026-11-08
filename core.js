/* Folio core — shared by the page (app.js) and the service worker (sw.js).
   Holds: the app database, how a stored HTML file is served, and the shim that
   gives every document its own private storage inside this app. */
(function (root) {
  'use strict';

  const DB_NAME = 'folio-app';
  const DB_VER = 1;
  const NS_PREFIX = '__folio__/';      // every document's storage lives under __folio__/<docId>/
  const META_PREFIX = '__folio_meta__/';

  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { db.close(); dbp = null; };
        res(db);
      };
      r.onerror = () => { dbp = null; rej(r.error); };
    });
    return dbp;
  }
  function reqP(q) { return new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  function txDone(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }

  async function get(store, key) { const db = await openDB(); return reqP(db.transaction(store).objectStore(store).get(key)); }
  async function getAll(store) { const db = await openDB(); return reqP(db.transaction(store).objectStore(store).getAll()); }
  async function put(store, value, key) {
    const db = await openDB(); const tx = db.transaction(store, 'readwrite');
    key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
    return txDone(tx);
  }
  async function del(store, key) { const db = await openDB(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); return txDone(tx); }

  /* Where to place the shim: just inside <head>, else after <html>, else after the doctype.
     Returns a BYTE offset into the file so the large original is never re-encoded. */
  async function findInjectOffset(blob) {
    const headText = await blob.slice(0, 65536).text();
    let m = /<head\b[^>]*>/i.exec(headText) || /<html\b[^>]*>/i.exec(headText) || /<!doctype[^>]*>/i.exec(headText);
    if (!m) return 0;
    const upto = headText.slice(0, m.index + m[0].length);
    return new TextEncoder().encode(upto).length;
  }
  function findTitle(text) {
    const i = text.search(/<title\b/i);
    if (i < 0) return '';
    const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text.slice(i, i + 2000));
    if (!m) return '';
    const t = document_decode(m[1]).replace(/\s+/g, ' ').trim();
    return t.slice(0, 160);
  }
  function document_decode(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  }

  /* ───────────── the in-document shim ─────────────
     Runs first inside each opened file. It:
       • namespaces localStorage / sessionStorage / IndexedDB per document, so two files never collide
       • reports every save to the app (for the "Saved" indicator)
       • lets the app flush pending saves before the file is closed
       • provides a small window.claude.use('downloads') so files' own "export" buttons work
       • optionally remembers typed text / form values for simple pages ("Keep page edits") */
  function shimSource(docId, opts) {
    opts = opts || {};
    const cfg = JSON.stringify({ id: docId, ns: NS_PREFIX + docId + '/', meta: META_PREFIX + docId + '/', keepEdits: !!opts.keepEdits });
    return '<script>(' + shimBody.toString() + ')(' + cfg + ');<\/script>';
  }

  function shimBody(C) {
    'use strict';
    var W = window, NS = C.ns, META = C.meta;
    var P = null; try { P = W.parent !== W ? W.parent : null; if (P) void P.document; } catch (e) { P = null; }
    function tell(kind, info) { try { P && P.__folioEvent && P.__folioEvent(C.id, kind, info); } catch (e) {} }
    var rawLS = null; try { rawLS = W.localStorage; } catch (e) {}

    /* storage namespacing */
    function wrapStorage(name) {
      var real; try { real = W[name]; if (!real) return; } catch (e) { return; }
      function keys() { var o = []; for (var i = 0; i < real.length; i++) { var k = real.key(i); if (k && k.indexOf(NS) === 0) o.push(k.slice(NS.length)); } return o; }
      var api = {
        getItem: function (k) { return real.getItem(NS + k); },
        setItem: function (k, v) { real.setItem(NS + k, String(v)); if (name === 'localStorage') tell('save'); },
        removeItem: function (k) { real.removeItem(NS + k); if (name === 'localStorage') tell('save'); },
        clear: function () { keys().forEach(function (k) { real.removeItem(NS + k); }); },
        key: function (i) { var k = keys()[i]; return k === undefined ? null : k; }
      };
      Object.defineProperty(api, 'length', { get: function () { return keys().length; } });
      var proxy = new Proxy(api, {
        get: function (t, p) { if (p in t) return t[p]; if (typeof p === 'string') { var v = real.getItem(NS + p); return v === null ? undefined : v; } return undefined; },
        set: function (t, p, v) { if (typeof p === 'string') api.setItem(p, v); return true; },
        deleteProperty: function (t, p) { if (typeof p === 'string') api.removeItem(p); return true; },
        has: function (t, p) { return (p in t) || (typeof p === 'string' && real.getItem(NS + p) !== null); },
        ownKeys: function () { return keys(); },
        getOwnPropertyDescriptor: function (t, p) { var v = typeof p === 'string' ? real.getItem(NS + p) : null; if (v !== null) return { value: v, enumerable: true, configurable: true, writable: true }; return undefined; }
      });
      try { Object.defineProperty(W, name, { configurable: true, get: function () { return proxy; } }); } catch (e) {}
    }
    wrapStorage('localStorage');
    wrapStorage('sessionStorage');

    var pending = 0;
    try {
      var f = W.indexedDB;
      if (f) {
        var remember = function (n) {
          try { var k = META + 'dbs', l = JSON.parse(rawLS.getItem(k) || '[]'); if (l.indexOf(n) < 0) { l.push(n); rawLS.setItem(k, JSON.stringify(l)); } } catch (e) {}
        };
        var o = f.open.bind(f), d = f.deleteDatabase.bind(f);
        f.open = function (n, v) { n = String(n); remember(n); return v === undefined ? o(NS + n) : o(NS + n, v); };
        f.deleteDatabase = function (n) { return d(NS + String(n)); };
        if (f.databases) {
          var dbs = f.databases.bind(f);
          f.databases = function () { return dbs().then(function (l) { return l.filter(function (x) { return x.name && x.name.indexOf(NS) === 0; }).map(function (x) { return { name: x.name.slice(NS.length), version: x.version }; }); }); };
        }
        var OS = W.IDBObjectStore && W.IDBObjectStore.prototype;
        ['put', 'add', 'delete', 'clear'].forEach(function (m) {
          var orig = OS && OS[m]; if (!orig) return;
          OS[m] = function () {
            var r = orig.apply(this, arguments);
            try {
              var tx = this.transaction;
              if (tx && !tx.__folio) {
                tx.__folio = 1; pending++;
                var end = function (ok) { return function () { pending--; if (ok) tell('save'); }; };
                tx.addEventListener('complete', end(true)); tx.addEventListener('abort', end(false)); tx.addEventListener('error', end(false));
              }
            } catch (e) {}
            return r;
          };
        });
      }
    } catch (e) {}

    /* the app asks the document to save everything right now */
    W.__folioFlush = function () {
      try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'hidden'; } });
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return true; } });
        document.dispatchEvent(new Event('visibilitychange'));
      } catch (e) {}
      try { W.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); } catch (e) { try { W.dispatchEvent(new Event('pagehide')); } catch (e2) {} }
      try { W.dispatchEvent(new Event('beforeunload')); } catch (e) {}
      try { delete document.visibilityState; delete document.hidden; } catch (e) {}
      if (C.keepEdits && W.__folioSaveEdits) W.__folioSaveEdits();
    };
    W.__folioPending = function () { return pending; };

    /* files that export through window.claude.use('downloads') get a working save */
    if (!W.claude) {
      W.claude = {
        use: function (name) {
          if (name !== 'downloads') return Promise.resolve(null);
          return Promise.resolve({
            save: function (o) {
              o = o || {};
              var blob = o.data instanceof Blob ? o.data : new Blob([o.data == null ? '' : o.data], { type: o.type || 'application/octet-stream' });
              if (P && P.__folioSaveFile) return P.__folioSaveFile(o.filename || 'export', blob);
              var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.filename || 'export'; document.body.appendChild(a); a.click(); a.remove();
              return Promise.resolve();
            }
          });
        }
      };
    }

    /* links: external links open outside the app; in-page anchors behave normally */
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a || e.defaultPrevented) return;
      var href = a.getAttribute('href') || '';
      if (/^(https?:|mailto:|tel:)/i.test(href)) { e.preventDefault(); try { (P || W).open(href, '_blank', 'noopener'); } catch (x) {} }
    }, false);

    /* optional: remember typed text and form values for simple pages */
    if (C.keepEdits) {
      var rawL = rawLS;
      var EK = META + 'edits';
      var pathOf = function (el) {
        if (el.id) return '#' + el.id;
        var parts = [];
        while (el && el.nodeType === 1 && el !== document.body) {
          if (el.id) { parts.unshift('#' + el.id); break; }
          var i = 1, s = el; while ((s = s.previousElementSibling)) i++;
          parts.unshift(el.tagName.toLowerCase() + ':' + i);
          el = el.parentElement;
        }
        return parts.join('>');
      };
      var find = function (p) {
        var segs = p.split('>'), el = document.body;
        for (var i = 0; i < segs.length && el; i++) {
          var s = segs[i];
          if (s[0] === '#') { el = document.getElementById(s.slice(1)); continue; }
          var m = /^([a-z0-9-]+):(\d+)$/.exec(s); if (!m) return null;
          var c = el.children[+m[2] - 1]; el = c && c.tagName.toLowerCase() === m[1] ? c : null;
        }
        return el;
      };
      var load = function () { try { return JSON.parse(rawL.getItem(EK) || '{}'); } catch (e) { return {}; } };
      var dirty = {}, t = null;
      var capture = function (el) {
        var host = el.closest && el.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]');
        if (host) { while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement; dirty[pathOf(host)] = { h: host.innerHTML }; }
        else if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
          if (el.type === 'password' || el.type === 'file') return;
          dirty[pathOf(el)] = (el.type === 'checkbox' || el.type === 'radio') ? { c: el.checked } : { v: el.value };
        } else return;
        clearTimeout(t); t = setTimeout(W.__folioSaveEdits, 400);
      };
      W.__folioSaveEdits = function () {
        clearTimeout(t); var ks = Object.keys(dirty); if (!ks.length) return;
        var all = load(); ks.forEach(function (k) { all[k] = dirty[k]; }); dirty = {};
        try { rawL.setItem(EK, JSON.stringify(all)); tell('save'); } catch (e) { tell('error', 'Storage full'); }
      };
      document.addEventListener('input', function (e) { capture(e.target); }, true);
      document.addEventListener('change', function (e) { capture(e.target); }, true);
      var restored = {};
      var restore = function () {
        var all = load();
        Object.keys(all).forEach(function (p) {
          if (restored[p]) return; var el = find(p); if (!el) return; var v = all[p];
          if ('h' in v) el.innerHTML = v.h; else if ('c' in v) el.checked = v.c; else if ('v' in v) el.value = v.v;
          restored[p] = 1;
        });
      };
      document.addEventListener('DOMContentLoaded', restore);
      W.addEventListener('load', function () { restore(); setTimeout(restore, 800); });
    }
    tell('ready');
  }

  /* A file's served form: original bytes with the shim spliced in. */
  async function composeDoc(docId) {
    const [meta, blob] = await Promise.all([get('docs', docId), get('files', docId)]);
    if (!meta || !blob) return null;
    const off = meta.offset || 0;
    return new Blob([blob.slice(0, off), shimSource(docId, { keepEdits: meta.keepEdits }), blob.slice(off)], { type: 'text/html;charset=utf-8' });
  }

  root.Folio = { DB_NAME, NS_PREFIX, META_PREFIX, openDB, get, getAll, put, del, reqP, txDone, findInjectOffset, findTitle, composeDoc, shimSource };
})(typeof self !== 'undefined' ? self : this);
