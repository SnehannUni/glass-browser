// Seite übersetzen (Knopf rechts oben in der Leiste, Rust ruft __glassTranslate.on/off). Wie in Chrome wird der
// Text an Ort und Stelle ersetzt: Anmeldung, Adresse, Zeichnungen und Skripte der Seite bleiben unberührt.
// Einheit ist ein Stück Fließtext (Text und Inline-Elemente wie Links oder Fettdruck zwischen zwei Blöcken). Es geht
// als HTML mit Platzhaltern <a i=N> für die Elemente an Rust (translate.rs) – so übersetzt Google ganze Sätze, und
// die Antwort sagt, wo jedes Element im übersetzten Satz steht. Die Elemente selbst bleiben dieselben Knoten (mit
// ihren Klick-Handlern), sie werden nur umsortiert. Alles lässt sich rückgängig machen („Original anzeigen“).
(() => {
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
  const post = window.ipc.postMessage.bind(window.ipc);
  const send = (tr, extra = {}) => post(JSON.stringify({ tr, ...extra }));

  // Nicht übersetzen: Code, Eingaben, ausdrücklich ausgenommene Stellen, Glass' eigene Zeichenfläche
  const SKIP = 'script,style,noscript,template,textarea,input,select,option,code,pre,kbd,samp,var,svg,math,canvas,'
    + 'iframe,object,video,audio,[translate="no"],.notranslate,[contenteditable=""],[contenteditable="true"],glass-draw';
  const LETTER = /\p{L}/u;
  const MAX_UNIT = 12000;                 // längere Einheiten (ganze Bücher in einem <p>) bleiben, wie sie sind
  const BATCH_CHARS = 6000, BATCH_UNITS = 60, PARALLEL = 3;

  let lang = null;                        // Zielsprache, solange übersetzt
  let busy = 0;                           // laufende Anfragen
  let applied = 0, same = 0, failed = false;
  let undo = [];                          // Schritte zum Wiederherstellen des Originals, in Reihenfolge
  let seen = new WeakSet();               // schon behandelte Textknoten
  let ours = new WeakMap();               // Textknoten → Text, den Glass hineingeschrieben hat
  let queue = [];                         // Einheiten, die noch zu Google müssen
  const pending = new Map();              // Anfrage-Nummer → { batch, generation }
  const token = Math.random().toString(36).slice(2);
  let seq = 0, generation = 0;
  let originalTitle = null;

  const report = () => send('state', { lang, busy: busy > 0 || queue.length > 0 });

  // ---------- Einheiten finden ----------
  const display = (el) => getComputedStyle(el).display;
  const inlineLevel = (el) => ['inline', 'contents'].includes(display(el));
  const isText = (n) => n.nodeType === Node.TEXT_NODE;
  const isElement = (n) => n.nodeType === Node.ELEMENT_NODE;
  const kids = (el) => [...el.childNodes].filter((c) => isText(c) || isElement(c));
  // Inline-Element mit nur Inline-Inhalt (ein <a> um ganze Karten mit <div>s ist dagegen ein eigener Block)
  function flat(el) {
    if (!inlineLevel(el)) return false;
    for (const d of el.querySelectorAll('*')) {
      if (!d.closest(SKIP) && display(d) !== 'none' && !inlineLevel(d)) return false;
    }
    return true;
  }
  const hasText = (n) => isText(n) ? LETTER.test(n.data) : !n.matches(SKIP) && LETTER.test(n.textContent);
  const textsOf = (nodes) => nodes.flatMap((n) => isText(n) ? [n] : isElement(n) && !n.matches(SKIP) ? textsOf(kids(n)) : []);

  // Alle Einheiten unter `root`: aufeinanderfolgende Inline-Knoten eines Blocks
  function collect(root, out) {
    if (!isElement(root) || root.closest(SKIP) || display(root) === 'none') return out;
    let run = [];
    const flush = () => {
      if (run.some(hasText)) out.push({ parent: root, nodes: run });
      run = [];
    };
    for (const child of root.childNodes) {
      if (isText(child)) run.push(child);
      else if (!isElement(child)) continue;
      else if (child.matches(SKIP)) { if (inlineLevel(child)) run.push(child); else flush(); } // Code im Satz bleibt Platzhalter
      else if (flat(child)) run.push(child);
      else { flush(); collect(child, out); }
    }
    flush();
    return out;
  }

  // ---------- HTML mit Platzhaltern ----------
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function serialize(nodes, els) {
    let s = '';
    for (const n of nodes) {
      if (isText(n)) s += esc(n.data);
      else if (isElement(n)) {
        const k = els.push(n) - 1;
        s += `<a i=${k}>${n.matches(SKIP) ? '' : serialize(kids(n), els)}</a>`;
      }
    }
    return s;
  }
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const decode = (s) => s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
  // Antwort zurück in einen Baum: Text als String, Platzhalter als { k, items }. null: unerwartetes HTML
  function parse(html) {
    const root = { items: [] }, stack = [root];
    const re = /<a\s+i\s*=\s*"?(\d+)"?\s*>|<\/a\s*>|<[^>]*>/gi;
    let last = 0, m;
    const text = (s) => { if (s) stack.at(-1).items.push(decode(s)); };
    while ((m = re.exec(html))) {
      text(html.slice(last, m.index));
      last = re.lastIndex;
      if (m[1] != null) {
        const node = { k: Number(m[1]), items: [] };
        stack.at(-1).items.push(node);
        stack.push(node);
      } else if (/^<\/a/i.test(m[0]) && stack.length > 1) {
        stack.pop();
      } else return null; // fremde Tags oder zu viele </a>
    }
    text(html.slice(last));
    return stack.length === 1 ? root.items : null;
  }

  // ---------- Übersetzung einsetzen ----------
  function setText(node, data) {
    const before = node.data;
    undo.push(() => { if (node.data === ours.get(node)) node.data = before; });
    node.data = data;
    ours.set(node, data);
    seen.add(node);
  }
  // Passt die Antwort zu den Knoten dieser Ebene? Jedes Element genau einmal, und nur Elemente dieser Ebene.
  function fits(nodes, items, els) {
    const here = nodes.filter(isElement);
    const keys = items.filter((it) => typeof it !== 'string').map((it) => it.k);
    if (keys.length !== here.length || new Set(keys).size !== keys.length) return false;
    return items.every((it) => typeof it === 'string'
      || (here.includes(els[it.k]) && (els[it.k].matches(SKIP) || fits(kids(els[it.k]), it.items, els))));
  }
  // Knoten in die Reihenfolge der Übersetzung bringen; `after`: Knoten hinter der Einheit (null: ans Ende)
  function reorder(parent, originals, order, after) {
    if (order.length === originals.length && order.every((n, i) => n === originals[i])) return;
    const place = (n) => parent.insertBefore(n, after?.parentNode === parent ? after : null);
    undo.push(() => originals.forEach(place));
    order.forEach(place);
  }
  // Eine Ebene: Texte der Reihe nach wiederverwenden (fehlende neu, übrige leeren), Elemente rekursiv
  function rebuild(parent, nodes, items, els, after) {
    const texts = nodes.filter(isText);
    const order = [];
    for (const it of items) {
      if (typeof it === 'string') {
        let node = texts.shift();
        if (!node) {
          const created = node = document.createTextNode('');
          undo.push(() => created.remove());
        }
        setText(node, it);
        order.push(node);
      } else {
        const el = els[it.k];
        if (!el.matches(SKIP)) rebuild(el, kids(el), it.items, els, null);
        order.push(el);
      }
    }
    for (const rest of texts) { setText(rest, ''); order.push(rest); }
    reorder(parent, nodes, order, after);
  }
  function applyUnit(unit, html) {
    const items = parse(html);
    // Die Seite hat die Stelle inzwischen umgebaut, oder die Platzhalter passen nicht: nicht anfassen
    if (!items || unit.nodes.some((n) => n.parentNode !== unit.parent) || !fits(unit.nodes, items, unit.els)) return false;
    // Leerraum am Rand behält Google nicht – vom Original übernehmen
    const texts = textsOf(unit.nodes);
    const lead = texts[0]?.data.match(/^\s*/)[0] ?? '', trail = texts.at(-1)?.data.match(/\s*$/)[0] ?? '';
    if (typeof items[0] === 'string') items[0] = lead + items[0].trimStart();
    if (typeof items.at(-1) === 'string') items[items.length - 1] = items.at(-1).trimEnd() + trail;
    rebuild(unit.parent, unit.nodes, items, unit.els, unit.nodes.at(-1).nextSibling);
    return true;
  }
  // Passt die Antwort nicht (Google hat Platzhalter verschluckt): Textknoten einzeln übersetzen
  const single = (node) => ({ parent: node.parentNode, nodes: [node], els: [], html: esc(node.data) });

  // ---------- Anfragen ----------
  function enqueue(units) {
    for (const u of units) {
      if (!u.html) { u.els = []; u.html = serialize(u.nodes, u.els); }
      textsOf(u.nodes).forEach((t) => seen.add(t));
      if (u.html.length <= MAX_UNIT) queue.push(u);
    }
    pump();
  }
  function request(batch) {
    const id = `${token}:${++seq}`;
    pending.set(id, { batch, generation });
    busy++;
    send('batch', { id, lang, texts: batch.map((u) => u.html) });
  }
  function pump() {
    while (lang && busy < PARALLEL && queue.length) {
      const batch = [];
      let chars = 0;
      while (queue.length && batch.length < BATCH_UNITS && (!batch.length || chars + queue[0].html.length <= BATCH_CHARS)) {
        chars += queue[0].html.length;
        batch.push(queue.shift());
      }
      request(batch);
    }
    // Alles erledigt und nichts übersetzt, weil die Seite schon in der Zielsprache ist: wieder aus
    if (lang && !busy && !queue.length && !applied && same) {
      send('same');
      return off();
    }
    report();
  }
  const sameLang = (detected) => !!detected && detected.split('-')[0].toLowerCase() === lang.split('-')[0].toLowerCase();
  // Aus Rust: Übersetzungen einer Anfrage (je Text [übersetzt, erkannte Sprache]) oder null bei einem Fehler
  Object.defineProperty(window, '__glassTranslated', { value: (id, results) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    busy--;
    if (job.generation !== generation || !lang) return report();
    if (!Array.isArray(results) || results.length !== job.batch.length) {
      if (!failed) send('error');
      failed = true;
      // Gar nichts übersetzt: aus, statt halb übersetzt zu hängen
      if (!applied) return off();
      return pump();
    }
    const records = observer.takeRecords();
    observer.disconnect();
    const retry = [];
    job.batch.forEach((unit, i) => {
      const [html, detected] = Array.isArray(results[i]) ? results[i] : [results[i], ''];
      if (typeof html !== 'string') return;
      if (sameLang(detected)) { same++; return; }
      if (unit.title) {
        if (originalTitle == null) originalTitle = document.title;
        document.title = (parse(html) ?? []).filter((it) => typeof it === 'string').join('');
        return;
      }
      try {
        if (applyUnit(unit, html)) applied++;
        else if (unit.els.length) retry.push(...textsOf(unit.nodes).filter((t) => t.isConnected && LETTER.test(t.data)).map(single));
      } catch { /* Seite hat umgebaut – dieses Stück bleibt im Original */ }
    });
    watch();
    changed(records);
    if (retry.length) enqueue(retry);
    else pump();
  } });

  // ---------- Seite ändert sich (nachgeladene Inhalte, Kommentare, Chats …) ----------
  const dirty = new Set();
  let dirtyTimer = 0;
  function changed(records) {
    for (const r of records) {
      if (r.type === 'characterData') {
        if (ours.get(r.target) === r.target.data) continue;
        seen.delete(r.target);
        if (r.target.parentElement) dirty.add(r.target.parentElement);
      } else {
        for (const n of r.addedNodes) {
          if (isText(n) && !seen.has(n) && n.parentElement) dirty.add(n.parentElement);
          else if (isElement(n) && n.localName !== 'glass-draw') dirty.add(n);
        }
      }
    }
    if (dirty.size && !dirtyTimer) dirtyTimer = setTimeout(flushDirty, 400);
  }
  const observer = new MutationObserver(changed);
  const watch = () => observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  function blockOf(el) {
    while (el && el !== document.body && flat(el) && el.parentElement) el = el.parentElement;
    return el;
  }
  function flushDirty() {
    dirtyTimer = 0;
    const roots = lang ? new Set([...dirty].filter((el) => el.isConnected).map(blockOf)) : new Set();
    dirty.clear();
    // Nur Einheiten mit Text, den Glass noch nicht kennt (die übrigen sind schon übersetzt)
    const units = [...roots].flatMap((r) => collect(r, []))
      .filter((u) => textsOf(u.nodes).some((t) => !seen.has(t) && LETTER.test(t.data)));
    if (units.length) enqueue(units);
  }

  // ---------- Ein/Aus ----------
  function on(target) {
    if (typeof target !== 'string' || !/^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/.test(target)) return;
    if (lang === target) return report();
    if (lang) restore();
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => on(target), { once: true });
      return;
    }
    lang = target;
    failed = false;
    applied = same = 0;
    generation++;
    const units = collect(document.body, []);
    // Sichtbares zuerst: Einheiten im Fenster vor denen weiter unten
    const inView = (u) => {
      const r = (u.nodes.find(isElement) ?? u.parent).getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight;
    };
    units.sort((a, b) => inView(b) - inView(a));
    if (LETTER.test(document.title)) units.unshift({ title: true, nodes: [], els: [], html: esc(document.title) });
    watch();
    enqueue(units);
  }
  function restore() {
    observer.disconnect();
    clearTimeout(dirtyTimer);
    dirtyTimer = 0;
    dirty.clear();
    for (let i = undo.length - 1; i >= 0; i--) {
      try { undo[i](); } catch { /* Knoten gibt es nicht mehr */ }
    }
    undo = [];
    seen = new WeakSet();
    ours = new WeakMap();
    queue = [];
    if (originalTitle != null) { document.title = originalTitle; originalTitle = null; }
  }
  function off() {
    if (!lang) return report();
    restore();
    lang = null;
    generation++;
    report();
  }
  Object.defineProperty(window, '__glassTranslate', { value: Object.freeze({ on, off }) });
})();
