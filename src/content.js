// Wird in jede Webseite injiziert: leitet Browser-Tastenkürzel an die Tab-Verwaltung weiter
// und blendet für den Werbeblocker Werbeflächen aus (die Netzwerk-Sperre selbst läuft in Rust).
(() => {
  if (window.top !== window) return;
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    const cmd =
      key === 't' ? 'new_tab' :
      key === 'n' && e.shiftKey ? 'private_tab' :
      key === 'w' ? 'close_tab' :
      key === 'l' ? 'focus_address' :
      key === 'tab' ? (e.shiftKey ? 'prev_tab' : 'next_tab') : null;
    if (!cmd) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.ipc.postMessage(cmd);
  }, true);

  // ---------- Werbeblocker ----------
  // Seiten ohne Werbeblocker setzt Rust per eigenem Skript, das direkt nach diesem läuft – daher erst bei Bedarf lesen.
  const host = location.hostname.replace(/^www\./, '');
  const off = () => (window.__glassAdblockOff || []).some((s) => host === s || host.endsWith('.' + s));
  const youtube = /(^|\.)youtube\.com$/.test(location.hostname);

  // Ausblend-Regeln: seitenspezifische sofort, allgemeine passend zu den Klassen und IDs der Seite.
  // Eigenes Stylesheet statt <style>: greift auch bei strenger Content-Security-Policy, und ein ungültiger
  // Selektor wirft nur seine eigene Regel raus (eine Regel pro Zeile).
  const sheet = new CSSStyleSheet();
  const mount = () => {
    if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  };
  window.__glassHide = (css) => {
    for (const rule of css.split('\n')) if (rule.trim()) try { sheet.insertRule(rule, sheet.cssRules.length); } catch { /* ungültig */ }
    mount();
  };
  const ask = (msg) => window.ipc.postMessage(JSON.stringify({ url: location.href, ...msg }));
  const seenClasses = new Set(), seenIds = new Set();
  function report(root) {
    const classes = [], ids = [];
    for (const el of root.querySelectorAll ? [root, ...root.querySelectorAll('[class],[id]')] : []) {
      if (el.id && !seenIds.has(el.id)) { seenIds.add(el.id); ids.push(el.id); }
      for (const c of el.classList || []) if (!seenClasses.has(c)) { seenClasses.add(c); classes.push(c); }
    }
    if (classes.length || ids.length) ask({ classes, ids });
  }
  ask({ first: true });
  // Nachgeladene Inhalte (Werbung kommt oft später) gesammelt melden, höchstens alle 500 ms
  let pending = [], timer = 0;
  const flush = () => { timer = 0; const nodes = pending; pending = []; nodes.forEach(report); };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) pending.push(n);
    if (pending.length && !timer) timer = setTimeout(flush, 500);
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { report(document.documentElement); mount(); });

  if (!youtube) return;

  // ---------- YouTube ----------
  // 1. Werbung schon aus den Videodaten entfernen, bevor der Player sie sieht (wie uBlock Origin).
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds'];
  const prune = (o) => {
    if (o && typeof o === 'object' && !off()) {
      for (const k of AD_KEYS) if (k in o) delete o[k];
      if (o.playerResponse) prune(o.playerResponse);
    }
    return o;
  };
  const parse = JSON.parse;
  JSON.parse = function (...args) { return prune(parse.apply(this, args)); };
  const json = Response.prototype.json;
  Response.prototype.json = function () { return json.call(this).then(prune); };
  let initial;
  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    configurable: true, get: () => initial, set: (v) => { initial = prune(v); },
  });

  // 2. Rutscht doch eine Werbung durch: stumm vorspulen und „Überspringen“ drücken.
  let mutedByUs = false;
  setInterval(() => {
    if (off()) return;
    const player = document.querySelector('#movie_player, .html5-video-player');
    const video = player?.querySelector('video');
    if (!video) return;
    if (player.classList.contains('ad-showing')) {
      if (!video.muted) { video.muted = true; mutedByUs = true; }
      if (Number.isFinite(video.duration)) video.currentTime = video.duration;
      document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click();
    } else if (mutedByUs) {
      video.muted = false;
      mutedByUs = false;
    }
  }, 250);

  // 3. Werbeflächen auf der Seite und der „Werbeblocker erkannt“-Dialog
  document.addEventListener('DOMContentLoaded', () => {
    if (off()) return;
    window.__glassHide([
      'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer', 'ytd-banner-promo-renderer', 'ytd-statement-banner-renderer',
      'ytd-promoted-sparkles-web-renderer', 'ytd-promoted-video-renderer', 'ytd-display-ad-renderer', 'ytd-companion-slot-renderer',
      'ytd-player-legacy-desktop-watch-ads-renderer', 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
      '#masthead-ad', '#player-ads', '.ytp-ad-overlay-container', '.ytp-featured-product',
      'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)', 'ytd-rich-section-renderer:has(ytd-statement-banner-renderer)',
      'tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)', 'ytd-enforcement-message-view-model',
    ].map((s) => `${s} { display: none !important; }`).join('\n'));
  });
})();
