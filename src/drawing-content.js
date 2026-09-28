// Auf Webseiten zeichnen: Der Stift in der Leiste schaltet den Zeichenmodus ein (Rust ruft __glassDraw.toggle).
// Striche liegen in Dokumentkoordinaten in einem SVG über der Seite und scrollen mit ihr. Jeder Strich ist am Text
// (bzw. Element) unter seinem Anfangspunkt verankert: Verschiebt sich die Seite (Banner, andere Breite, nachgeladene
// Inhalte), wandert er mit – sonst läge er nach dem Neuladen woanders als der Text, auf den er zeigt. Nach jeder Änderung
// schickt das Skript alle Striche an Rust (drawing.rs), das sie je Adresse speichert und beim Laden zurückgibt.
// Alles steckt in einem geschlossenen Shadow-DOM, damit das CSS der Seite nichts verstellt.
(() => {
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
  const post = window.ipc.postMessage.bind(window.ipc);
  // `on` in jeder Nachricht: So weiß die Leiste immer, ob der Stift dieser Seite gerade aktiv ist
  const send = (draw, extra = {}) => post(JSON.stringify({ draw, url: pageKey(), on, ...extra }));
  const pageKey = () => location.href.replace(/#.*$/, '');
  const NS = 'http://www.w3.org/2000/svg';

  const COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2', '#1c1c1e', '#ffffff'];
  const TOOLS = {
    pen: { width: 3, opacity: 1 },
    marker: { width: 18, opacity: 0.38 },
  };
  const ICONS = {
    pen: '<path d="M11.3 2.7a1.6 1.6 0 0 1 2.3 2.3L5.8 12.8l-3.1.8.8-3.1z"/><path d="m10 4 2.3 2.3"/>',
    marker: '<path d="m9.6 3 3.4 3.4-5.6 5.6H4v-3.4z"/><path d="M4 12l-1.6 1.6H6"/>',
    eraser: '<path d="m6.8 13.2 7-7a1.4 1.4 0 0 0 0-2L11.9 2.3a1.4 1.4 0 0 0-2 0l-7.6 7.6a1.4 1.4 0 0 0 0 2l1.3 1.3z"/><path d="M6.4 5.8 10.6 10M6.8 13.2H14"/>',
    undo: '<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7"/>',
    clear: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.3c.1.7.6 1.2 1.3 1.2h3c.7 0 1.2-.5 1.3-1.2l.7-8.3"/>',
    done: '<path d="m3.5 8.4 3 3 6-6.6"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 16 16">${ICONS[name]}</svg>`;

  // { t: 'pen'|'marker', c: Farbe, w: Breite, p: [x, y, x, y, …], a: Anker, o: [x, y] Ankerposition beim Zeichnen }
  let strokes = [];
  let undo = [];      // frühere Stände von `strokes` (flache Kopien, die Striche selbst ändern sich nie)
  let key = pageKey();   // Adresse, zu der `strokes` gehören
  let loadedFor = null;
  let on = false;
  let tool = 'pen', color = COLORS[0];
  let host, root, svg, layer, bar;
  const paths = new Map(); // Strich → <path>
  const shift = new Map(); // Strich → [dx, dy], wie weit sein Anker seit dem Zeichnen gewandert ist

  // ---------- Anker ----------
  // Weg zum Element: vom nächsten Vorfahren mit (eindeutiger) id aus, je Schritt Kind-Nummer und Tag
  function elementPath(el) {
    const path = [];
    while (el && el !== document.body && el !== document.documentElement && path.length < 40) {
      if (el.id && document.getElementById(el.id) === el) return { id: el.id, path: path.reverse() };
      const parent = el.parentElement;
      if (!parent) return null;
      path.push([Array.prototype.indexOf.call(parent.children, el), el.localName]);
      el = parent;
    }
    return el === document.body ? { id: null, path: path.reverse() } : null;
  }
  function resolvePath(a) {
    let el = a.id == null ? document.body : document.getElementById(a.id);
    for (const [i, tag] of a.path) {
      el = el?.children[i];
      if (el?.localName !== tag) return null;
    }
    return el;
  }
  // Liegt das Element in etwas Festem (fixed/sticky)? Dann gilt der Strich der Seite, nicht dem Element.
  function pinned(el) {
    for (; el && el !== document.body; el = el.parentElement) {
      if (/fixed|sticky/.test(getComputedStyle(el).position)) return true;
    }
    return false;
  }
  const textRect = (node, off) => {
    const r = document.createRange();
    r.setStart(node, off); r.setEnd(node, off + 1);
    return [...r.getClientRects()].find((q) => q.width || q.height);
  };
  // Anker unter einem Punkt (Fensterkoordinaten): möglichst ein Zeichen im Text, sonst das Element darunter
  function anchorAt(x, y) {
    layer.style.pointerEvents = 'none';
    try {
      const caret = document.caretPositionFromPoint?.(x, y);
      const node = caret?.offsetNode;
      if (node?.nodeType === Node.TEXT_NODE && node.data.trim()) {
        const off = Math.min(caret.offset, node.data.length - 1);
        const el = node.parentElement, rect = textRect(node, off);
        const a = el && rect && !pinned(el) && elementPath(el);
        // Nur, wenn der Punkt wirklich bei diesem Text liegt (daneben liefert caret die nächstgelegene Stelle)
        if (a && Math.abs(rect.top + rect.height / 2 - y) < rect.height * 2 && Math.abs(rect.left - x) < 200) {
          const n = Array.prototype.indexOf.call(el.childNodes, node);
          return { ...a, n, off, ch: node.data.slice(off, off + 8) };
        }
      }
      let el = document.elementFromPoint(x, y);
      while (el && el !== document.body && ['inline', 'contents'].includes(getComputedStyle(el).display) && el.parentElement) el = el.parentElement;
      return el && el !== host && !pinned(el) ? elementPath(el) : null;
    } finally {
      layer.style.pointerEvents = '';
    }
  }
  // Wo liegt der Anker jetzt (Dokumentkoordinaten)? null: nicht (mehr) da
  function anchorPos(a) {
    const el = resolvePath(a);
    if (!el) return null;
    let r;
    if (a.n != null) {
      const node = el.childNodes[a.n];
      if (node?.nodeType !== Node.TEXT_NODE || node.data.slice(a.off, a.off + 8) !== a.ch) return null;
      r = textRect(node, a.off);
    } else {
      r = el.getBoundingClientRect();
    }
    return r ? [r.left + scrollX, r.top + scrollY] : null;
  }
  // Striche ihren Ankern nachführen. Fehlt ein Anker (noch nicht nachgeladen), bleibt der Strich, wo er war.
  let placeQueued = false;
  function place() {
    placeQueued = false;
    for (const s of strokes) {
      const pos = s.a && anchorPos(s.a);
      const d = pos ? [Math.round(pos[0] - s.o[0]), Math.round(pos[1] - s.o[1])] : [0, 0];
      const old = shift.get(s);
      if (old?.[0] === d[0] && old?.[1] === d[1]) continue;
      shift.set(s, d);
      paths.get(s)?.setAttribute('transform', `translate(${d[0]} ${d[1]})`);
    }
  }
  const queuePlace = () => {
    if (placeQueued || !strokes.some((s) => s.a)) return;
    placeQueued = true;
    requestAnimationFrame(place);
  };

  // ---------- Zeichnen ----------
  // Glatte Linie: Quadratische Kurven durch die Mitten zwischen den Punkten
  function pathData(p) {
    if (p.length <= 2) return `M${p[0]} ${p[1]}l0 0`;
    let d = `M${p[0]} ${p[1]}`;
    for (let i = 2; i < p.length - 2; i += 2) {
      d += `Q${p[i]} ${p[i + 1]} ${(p[i] + p[i + 2]) / 2} ${(p[i + 1] + p[i + 3]) / 2}`;
    }
    return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
  }
  function addPath(s) {
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', pathData(s.p));
    el.setAttribute('stroke', s.c);
    el.setAttribute('stroke-width', s.w);
    el.setAttribute('stroke-opacity', TOOLS[s.t]?.opacity ?? 1);
    svg.append(el);
    paths.set(s, el);
    return el;
  }
  function redraw() {
    if (!svg) return;
    paths.forEach((el) => el.remove());
    paths.clear();
    strokes.forEach(addPath);
    shift.clear();
    place();
    renderBar();
  }
  const valid = (s) => s && TOOLS[s.t] && typeof s.c === 'string' && /^#[0-9a-f]{6}$/i.test(s.c)
    && Number.isFinite(s.w) && Array.isArray(s.p) && s.p.length >= 2 && s.p.length % 2 === 0 && s.p.every(Number.isFinite)
    && (s.a == null || (validAnchor(s.a) && Array.isArray(s.o) && s.o.length === 2 && s.o.every(Number.isFinite)));
  const validAnchor = (a) => typeof a === 'object' && (a.id === null || typeof a.id === 'string')
    && Array.isArray(a.path) && a.path.length <= 40
    && a.path.every((step) => Array.isArray(step) && Number.isInteger(step[0]) && typeof step[1] === 'string')
    && (a.n == null || (Number.isInteger(a.n) && Number.isInteger(a.off) && typeof a.ch === 'string'));

  // Speichern erst, wenn eine Weile nichts mehr passiert – beim Verlassen der Seite sofort
  let saveTimer = 0;
  function change(next) {
    undo.push(strokes);
    if (undo.length > 100) undo.shift();
    strokes = next;
    redraw();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    // `key`, nicht die aktuelle Adresse: Die Seite kann schon weitergewechselt sein, die Striche gehören zur alten
    if (loadedFor === key) post(JSON.stringify({ draw: 'save', url: key, on, strokes }));
  }

  // Radierer: ganze Striche, die der Zeiger berührt
  function near(s, x, y, r) {
    const p = s.p;
    const [sx, sy] = shift.get(s) ?? [0, 0];
    x -= sx; y -= sy;
    r += s.w / 2;
    for (let i = 0; i < p.length; i += 2) {
      const ax = p[i], ay = p[i + 1];
      const bx = p[i + 2] ?? ax, by = p[i + 3] ?? ay;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
      if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= r) return true;
    }
    return false;
  }

  let drawing = null; // laufender Strich oder { erase: true, before }
  const at = (e) => [Math.round((e.clientX + scrollX) * 10) / 10, Math.round((e.clientY + scrollY) * 10) / 10];
  function down(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    if (tool === 'eraser') {
      drawing = { erase: true, before: strokes, kept: strokes.slice() };
      erase(e);
      return;
    }
    const s = { t: tool, c: color, w: TOOLS[tool].width, p: at(e) };
    drawing = { stroke: s, el: addPath(s), start: [e.clientX, e.clientY], scroll: [scrollX, scrollY] };
  }
  function move(e) {
    if (!drawing) return;
    if (drawing.erase) {
      for (const ev of e.getCoalescedEvents?.() ?? [e]) erase(ev);
      return;
    }
    const p = drawing.stroke.p;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const [x, y] = at(ev);
      if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) >= 1.5) p.push(x, y);
    }
    drawing.el.setAttribute('d', pathData(p));
  }
  function erase(e) {
    const [x, y] = at(e);
    const hit = drawing.kept.filter((s) => near(s, x, y, 6));
    if (!hit.length) return;
    drawing.kept = drawing.kept.filter((s) => !hit.includes(s));
    hit.forEach((s) => paths.get(s)?.remove());
  }
  function up() {
    const d = drawing;
    drawing = null;
    if (!d) return;
    if (d.erase) {
      if (d.kept.length !== d.before.length) change(d.kept);
      return;
    }
    d.el.remove();
    // Anker unter dem Anfangspunkt, dort, wo er beim Aufsetzen lag (die Seite kann seitdem gescrollt sein)
    const [x, y] = [d.start[0] + d.scroll[0] - scrollX, d.start[1] + d.scroll[1] - scrollY];
    const a = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? anchorAt(x, y) : null;
    const pos = a && anchorPos(a);
    if (pos) Object.assign(d.stroke, { a, o: pos.map((v) => Math.round(v * 10) / 10) });
    change([...strokes, d.stroke]);
  }

  // ---------- Oberfläche ----------
  const CSS = `
    :host { all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483646; }
    svg.ink { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; pointer-events: none; }
    svg.ink path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .layer { position: fixed; inset: 0; cursor: crosshair; touch-action: none; display: none; }
    .layer.eraser { cursor: cell; }
    :host(.on) .layer { display: block; }
    .bar {
      position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%) translateY(12px) scale(.96); opacity: 0;
      pointer-events: none; transition: transform .35s cubic-bezier(.2, 1.3, .4, 1), opacity .18s;
      display: flex; align-items: center; gap: 2px; padding: 5px; border-radius: 999px;
      font: 12px/1 system-ui, "Segoe UI Variable", "Segoe UI", sans-serif; color: rgba(255, 255, 255, .95);
      background: rgba(40, 40, 46, .58); backdrop-filter: blur(22px) saturate(1.8);
      box-shadow: 0 10px 34px rgba(0, 0, 0, .28), 0 1px 3px rgba(0, 0, 0, .2),
        inset 0 0 0 .5px rgba(255, 255, 255, .28), inset 0 1px 0 rgba(255, 255, 255, .16);
      user-select: none;
    }
    :host(.on) .bar { transform: translateX(-50%); opacity: 1; pointer-events: auto; }
    button {
      all: unset; box-sizing: border-box; width: 32px; height: 32px; border-radius: 50%;
      display: grid; place-items: center; cursor: default; transition: background-color .15s, transform .2s;
    }
    button:hover { background: rgba(255, 255, 255, .13); }
    button:active { background: rgba(255, 255, 255, .2); transform: scale(.94); }
    button[disabled] { opacity: .35; pointer-events: none; }
    button.sel { background: rgba(255, 255, 255, .24); }
    button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
    .dot { width: 26px; height: 26px; }
    .dot i { width: 16px; height: 16px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35); transition: transform .2s; }
    .dot.sel { background: none; }
    .dot.sel i { transform: scale(1.18); box-shadow: 0 0 0 2px rgba(40, 40, 46, .9), 0 0 0 3.5px rgba(255, 255, 255, .95); }
    .sep { width: 1px; height: 18px; margin: 0 5px; background: rgba(255, 255, 255, .2); }
    .done { width: auto; padding: 0 12px 0 9px; gap: 5px; display: flex; border-radius: 999px; background: #0a84ff; font-weight: 600; }
    .done:hover { background: #2a94ff; }
    @media (prefers-color-scheme: light) {
      .bar { color: rgba(14, 16, 24, .92); background: rgba(250, 250, 252, .62);
        box-shadow: 0 10px 34px rgba(0, 0, 0, .16), 0 1px 3px rgba(0, 0, 0, .12), inset 0 0 0 .5px rgba(0, 0, 0, .12), inset 0 1px 0 rgba(255, 255, 255, .7); }
      button:hover { background: rgba(0, 0, 0, .07); }
      button:active { background: rgba(0, 0, 0, .12); }
      button.sel { background: rgba(0, 0, 0, .1); }
      .dot i { box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .18); }
      .dot.sel i { box-shadow: 0 0 0 2px rgba(250, 250, 252, .95), 0 0 0 3.5px rgba(14, 16, 24, .85); }
      .sep { background: rgba(0, 0, 0, .14); }
      .done { color: #fff; }
    }`;

  function mount() {
    if (host) {
      if (!host.isConnected) document.documentElement.append(host); // manche Seiten ersetzen ihr DOM
      return;
    }
    host = document.createElement('glass-draw');
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><svg class="ink" xmlns="${NS}"></svg><div class="layer"></div>
      <div class="bar" role="toolbar" aria-label="Zeichnen">
        <button data-tool="pen" title="Stift (P)">${icon('pen')}</button>
        <button data-tool="marker" title="Textmarker (M)">${icon('marker')}</button>
        <button data-tool="eraser" title="Radierer (E)">${icon('eraser')}</button>
        <span class="sep"></span>
        ${COLORS.map((c) => `<button class="dot" data-color="${c}" title="Farbe"><i style="background:${c}"></i></button>`).join('')}
        <span class="sep"></span>
        <button data-act="undo" title="Rückgängig (Strg+Z)">${icon('undo')}</button>
        <button data-act="clear" title="Alles löschen">${icon('clear')}</button>
        <button class="done" data-act="done" title="Fertig (Esc)">${icon('done')}Fertig</button>
      </div>`;
    svg = root.querySelector('svg.ink');
    layer = root.querySelector('.layer');
    bar = root.querySelector('.bar');
    layer.addEventListener('pointerdown', down);
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    bar.addEventListener('pointerdown', (e) => e.preventDefault()); // Fokus bleibt, wo er ist
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) setTool(b.dataset.tool);
      else if (b.dataset.color) { color = b.dataset.color; if (tool === 'eraser') tool = 'pen'; renderBar(); }
      else if (b.dataset.act === 'undo') doUndo();
      else if (b.dataset.act === 'clear' && strokes.length) change([]);
      else if (b.dataset.act === 'done') setOn(false);
    });
    document.documentElement.append(host);
    new MutationObserver(() => { if (!host.isConnected) document.documentElement?.append(host); })
      .observe(document.documentElement, { childList: true });
    redraw();
  }
  function renderBar() {
    if (!bar) return;
    bar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('sel', b.dataset.tool === tool));
    bar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('sel', tool !== 'eraser' && b.dataset.color === color));
    bar.querySelector('[data-act=undo]').disabled = !undo.length;
    bar.querySelector('[data-act=clear]').disabled = !strokes.length;
    layer.classList.toggle('eraser', tool === 'eraser');
  }
  function setTool(t) { tool = t; renderBar(); }
  function doUndo() {
    if (!undo.length) return;
    strokes = undo.pop();
    redraw();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  function setOn(value) {
    value = !!value;
    if (value === on) return;
    if (value && !document.documentElement) return;
    on = value;
    if (on) mount();
    if (!on) { up(); if (saveTimer) save(); }
    host?.classList.toggle('on', on);
    send('state');
  }

  // Im Zeichenmodus: Esc beendet, Strg+Z nimmt zurück, P/M/E wählen das Werkzeug
  window.addEventListener('keydown', (e) => {
    if (!on || !e.isTrusted || e.isComposing) return;
    const k = e.key.toLowerCase();
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target?.isContentEditable;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !typing;
    let handled = true;
    if (e.key === 'Escape') setOn(false);
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !typing && k === 'z') doUndo();
    else if (plain && k === 'p') setTool('pen');
    else if (plain && k === 'm') setTool('marker');
    else if (plain && k === 'e') setTool('eraser');
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // ---------- Laden, Speichern, Seitenwechsel ----------
  Object.defineProperty(window, '__glassDraw', { value: Object.freeze({ toggle: () => setOn(!on), off: () => setOn(false) }) });
  // Aus Rust: gespeicherte Striche dieser Adresse
  Object.defineProperty(window, '__glassDrawLoad', { value: (data) => {
    if (!data || data.url !== pageKey() || !Array.isArray(data.strokes)) return;
    loadedFor = data.url;
    // Schon gezeichnet, bevor die Antwort kam? Dann die eigenen Striche obendrauf
    const early = strokes;
    strokes = [...data.strokes.filter(valid), ...early];
    undo = [];
    if (early.length) saveTimer = setTimeout(save, 400);
    if (strokes.length) whenReady(mount);
    redraw();
  } });
  const whenReady = (fn) => document.documentElement && document.readyState !== 'loading'
    ? fn() : document.addEventListener('DOMContentLoaded', fn, { once: true });

  send('load');
  // Einseitige Anwendungen wechseln die Adresse ohne neues Dokument: dann die Striche der neuen Adresse zeigen
  function checkUrl() {
    if (pageKey() === key) return;
    up();
    if (saveTimer) save();
    key = pageKey();
    loadedFor = null;
    strokes = [];
    undo = [];
    redraw();
    send('load');
  }
  // pushState, replaceState und navigation.intercept melden sich alle als navigate; die Adresse steht erst danach fest
  window.navigation?.addEventListener('navigate', () => setTimeout(checkUrl, 0));
  window.navigation?.addEventListener('navigatesuccess', checkUrl);
  window.addEventListener('popstate', checkUrl);
  window.addEventListener('pagehide', () => { up(); if (saveTimer) save(); });
  // Die Seite verschiebt sich: nach Größenänderungen, nachgeladenen Bildern und Schriften, Klappmenüs …
  // DOM- und Größenänderungen fangen fast alles ab (höchstens ein Abgleich pro Bild), dazu ein seltener Abgleich für
  // den Rest (z. B. reine CSS-Animationen). Ohne verankerte Striche kostet das nichts (queuePlace kehrt sofort um).
  const sizes = new ResizeObserver(queuePlace);
  const dom = new MutationObserver(queuePlace);
  whenReady(() => {
    sizes.observe(document.documentElement);
    if (document.body) sizes.observe(document.body);
    dom.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  window.addEventListener('resize', queuePlace);
  window.addEventListener('load', queuePlace);
  document.fonts?.addEventListener('loadingdone', queuePlace);
  setInterval(() => { if (!document.hidden) queuePlace(); }, 2000);
})();
