// Wird in jede Webseite injiziert: leitet Browser-Tastenkürzel an die Tab-Verwaltung weiter
// und blendet für den Werbeblocker Werbeflächen aus (die Netzwerk-Sperre selbst läuft in Rust).
(() => {
  if (window.top !== window) return;
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'f8' && e.shiftKey && e.repeat) { e.preventDefault(); return; }
    const cmd =
      key === 'f8' && e.shiftKey ? 'animation_debug' :
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
  // Seitentasten der Maus (WebView2 navigiert damit nicht von selbst): zurück bzw. vor wie die Knöpfe in der Leiste –
  // am Anfang des Verlaufs also weiter zum Startbildschirm
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.ipc.postMessage(e.button === 3 ? 'back' : 'forward');
  }, true);

  // ---------- Fenster am oberen Seitenrand anfassen ----------
  // Steht die Leiste links oder ist sie oben ausgeblendet, fehlt oben die Titelleiste. Leere Stellen im oberen
  // Streifen der Seite ersetzen sie: Ziehen verschiebt das Fenster, Doppelklick maximiert. Rust entscheidet, ob.
  // Erst bei Bewegung ziehen – ein einfacher Klick bleibt ein Klick für die Seite.
  const GRAB_BAND = 40, GRAB_SLOP = 4;
  const INTERACTIVE = 'a, button, input, select, textarea, label, summary, video, audio, iframe, embed, object, canvas, '
    + '[contenteditable]:not([contenteditable="false"]), [draggable="true"], [onclick], [tabindex]:not([tabindex="-1"]), '
    + '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], '
    + '[role="switch"], [role="textbox"], [role="combobox"], [role="slider"], [role="option"]';
  // Liegt unter dem Punkt Text? (Text hat meist den Cursor „auto“, zeigt aber einen Textcursor)
  function textAt(x, y) {
    const caret = document.caretRangeFromPoint?.(x, y);
    if (caret?.startContainer.nodeType !== Node.TEXT_NODE) return false;
    const range = document.createRange();
    range.selectNodeContents(caret.startContainer);
    return [...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }
  function grabbable(e) {
    if (e.button !== 0 || e.clientY >= GRAB_BAND || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
    if (document.fullscreenElement) return false;
    const el = e.target;
    if (!(el instanceof Element) || el.closest(INTERACTIVE)) return false;
    if (!['auto', 'default'].includes(getComputedStyle(el).cursor)) return false; // Hand, Textcursor, Greifen …
    return !textAt(e.clientX, e.clientY);
  }
  let grab = null;
  window.addEventListener('mousedown', (e) => { grab = grabbable(e) ? { x: e.clientX, y: e.clientY } : null; }, true);
  window.addEventListener('mousemove', (e) => {
    if (!grab) return;
    if (!(e.buttons & 1)) { grab = null; return; }
    if (Math.hypot(e.clientX - grab.x, e.clientY - grab.y) < GRAB_SLOP) return;
    grab = null;
    window.ipc.postMessage('window_drag');
  }, true);
  window.addEventListener('mouseup', () => { grab = null; }, true);
  window.addEventListener('dblclick', (e) => { if (grabbable(e)) window.ipc.postMessage('window_maximize'); }, true);

  // ---------- Scrollen melden ----------
  // Liegt Glas der Oberfläche über der Seite (Favoriten, Vorschläge …), zeigt es ein Bild von ihr – nach dem Scrollen
  // muss es neu. Höchstens alle 50 ms eine Meldung, die letzte kommt erst nach der letzten Bewegung (auch Scrollbereiche
  // in der Seite zählen).
  let scrollTimer = 0;
  document.addEventListener('scroll', () => {
    if (scrollTimer || document.visibilityState !== 'visible') return;
    scrollTimer = setTimeout(() => { scrollTimer = 0; window.ipc.postMessage('scrolled'); }, 50);
  }, { capture: true, passive: true });

  // ---------- Werbeblocker ----------
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
})();
