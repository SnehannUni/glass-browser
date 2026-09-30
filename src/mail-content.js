// Web-Postfächer von iCloud, Outlook und Gmail (siehe mail.rs): Ungelesene zählen und die neuesten Mails des
// Posteingangs für die gemeinsame Liste hinter dem Mail-Knopf auslesen – Absender, Betreff, Vorschau, Zeit.
// Gemeldet wird nur an Glass selbst (window.ipc), nie ins Netz. Läuft in allen anderen Seiten gar nicht erst.
// Die Zeilen erkennt das Skript an dem, was die Postfächer für Screenreader und ihre eigene Logik ohnehin
// setzen (role, data-…-id, title mit vollem Datum); die Klassennamen sind nur Beiwerk.
(() => {
  const HOSTS = {
    icloud: ['www.icloud.com', 'icloud.com'],
    outlook: ['outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft'],
    gmail: ['mail.google.com'],
  };
  const provider = Object.keys(HOSTS).find((k) => HOSTS[k].includes(location.hostname));
  if (!provider || window.top !== window) return;
  const MAX = 30;
  // Kein \b: In textContent klebt die Zahl oft direkt am Namen („Posteingang3“). iCloud sagt „Eingang“.
  const INBOX = /^\s*(posteingang|eingang|inbox)(?![a-zäöüß])/i;
  const UNREAD = /(\d[\d.,  ]*)\s*(?:ungelesen|unread)|(?:ungelesen|unread)\D{0,12}(\d[\d.,  ]*)/i;
  const toNumber = (s) => (s == null ? null : Number(s.replace(/\D/g, '')));
  const firstNumber = (s) => toNumber(/\d[\d.,  ]*/.exec(s)?.[0]);
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  // iCloud Mail läuft in einem iframe desselben Ursprungs (der Titel mit der Zahl gehört dem obersten Dokument):
  // alles in der Seite und in erreichbaren iframes suchen
  const docs = () => [document, ...[...document.querySelectorAll('iframe')].flatMap((f) => {
    try { return f.contentDocument?.documentElement ? [f.contentDocument] : []; } catch { return []; }
  })];
  const all = (selector) => docs().flatMap((d) => [...d.querySelectorAll(selector)]);

  // ---------- Ungelesene ----------
  // Text eines Ordners ohne seine Unterordner (Outlook schachtelt sie in den Eintrag des Posteingangs)
  const NESTED = '[role="group"], [role="tree"], ul, ol';
  function ownText(el) {
    if (!el.querySelector(NESTED)) return el.textContent || '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll(NESTED).forEach((n) => n.remove());
    return copy.textContent || '';
  }
  // Zahl zu einem Ordner „Posteingang“: bevorzugt „3 ungelesen“ aus der Beschriftung für Screenreader (dort kann
  // auch die Gesamtzahl stehen), sonst die sichtbare Zahl daneben – ein paar Ebenen höher, solange dort nur
  // „Posteingang“ und eine Zahl stehen.
  function countAt(el) {
    const aria = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
    const unread = UNREAD.exec(aria);
    if (unread) return toNumber(unread[1] || unread[2]);
    for (let n = el, depth = 0; n && depth < 4; n = n.parentElement, depth++) {
      const t = ownText(n).replace(/\s+/g, ' ').trim();
      if (!INBOX.test(t) || t.length > 40) break;
      const rest = t.replace(INBOX, '');
      const said = UNREAD.exec(rest); // Outlook: „Posteingang634ungelesen“ (Zahl und Wort für Screenreader im Text)
      if (said) return toNumber(said[1] || said[2]);
      if (/^\W*\d[\d.,  ]*\W*$/.test(rest)) return firstNumber(rest);
      if (rest.trim() && depth > 0) break; // ein anderer Ordner steht mit darin
    }
    return firstNumber(aria.replace(INBOX, '')) ?? 0;
  }
  function fromFolders() {
    const gmailLink = provider === 'gmail' && document.querySelector('a[href$="#inbox"]');
    if (gmailLink) return countAt(gmailLink);
    for (const el of all('[role="treeitem"], [role="option"], [role="link"], [role="button"], a[href], li')) {
      if (el.matches('[role="treeitem"].thread-list-item, [role="option"][data-convid], [role="row"]')) continue; // Mails, keine Ordner
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || ownText(el);
      if (INBOX.test(label) && label.length < 80) return countAt(el);
    }
    return null;
  }
  // Gmail „Posteingang (1.700) - …“, iCloud „Eingang (2810) | iCloud Mail“ – solange der Posteingang offen ist
  function fromTitle() {
    if (provider === 'outlook' || !INBOX.test(document.title)) return null;
    return toNumber(/\((\d[\d.,  ]*)\)/.exec(document.title)?.[1]) ?? 0;
  }

  // ---------- Zeit ----------
  const MONTHS = ['jan', 'feb', 'mär', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'];
  const DAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
  const EN_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  // „09:05“, „Gestern“, „Montag“, „28.9.2026“, „Di., 29. Sept. 2026, 09:05“ (Gmail-Tooltip) → ms seit 1970
  function parseTime(s) {
    s = (s || '').trim().toLowerCase();
    if (!s) return null;
    const clock = /(\d{1,2}):(\d{2})\s*(am|pm)?/.exec(s);
    const at = (d) => {
      if (clock) {
        let h = +clock[1] % (clock[3] ? 12 : 24);
        if (clock[3] === 'pm') h += 12;
        d.setHours(h, +clock[2], 0, 0);
      } else d.setHours(12, 0, 0, 0);
      return d.getTime();
    };
    let m = /(\d{1,2})\.\s*([a-zä]{3,})\.?\s*(\d{4})?/.exec(s);
    if (m) {
      const month = MONTHS.findIndex((p) => m[2].startsWith(p));
      if (month >= 0) return at(new Date(m[3] ? +m[3] : new Date().getFullYear(), month, +m[1]));
    }
    m = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(s);
    if (m) return at(new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1]));
    const d = new Date();
    if (/^(gestern|yesterday)/.test(s)) { d.setDate(d.getDate() - 1); return at(d); }
    const day = [DAYS, EN_DAYS].map((list) => list.findIndex((n) => s.startsWith(n))).find((i) => i >= 0);
    if (day != null) { d.setDate(d.getDate() - ((d.getDay() - day + 7) % 7 || 7)); return at(d); }
    if (clock && s.length <= 8) return at(d);
    const parsed = Date.parse(s); // englische Gmail-Tooltips („Tue, Sep 29, 2026, 9:05 AM“)
    return Number.isFinite(parsed) ? parsed : null;
  }

  // ---------- Neueste Mails ----------
  // key: womit __glassMailOpen die Mail wiederfindet. Ohne eigene Id (iCloud) aus Absender, Betreff und Zeit.
  const keyOf = (...parts) => parts.join('␟').slice(0, 300);
  const icloudRows = () => all('[role="treeitem"].thread-list-item');
  const outlookRows = () => [...document.querySelectorAll('div[role="option"][data-convid]')];
  const UNREAD_ROW = /^\s*(ungelesen|unread)\b/i; // Outlook beginnt die Beschriftung ungelesener Zeilen so
  const icloudParts = (row) => ['.thread-participants', '.thread-subject > span', '.thread-timestamp'].map((s) => text(row.querySelector(s)));
  const LISTS = {
    gmail() {
      return [...document.querySelectorAll('tr[role="row"]')].flatMap((row) => {
        const id = row.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id');
        if (!id) return [];
        const senders = [...row.querySelectorAll('span[email]')];
        const from = [...new Set(senders.map((s) => s.getAttribute('name') || text(s)))].join(', ');
        const stamp = row.querySelector('td[role="gridcell"] span[title]');
        return [{
          key: id, from, subject: text(row.querySelector('span[data-legacy-thread-id]')),
          snippet: text(row.querySelector('.y2')).replace(/^[-–]\s*/, ''),
          time: parseTime(stamp?.getAttribute('title') || text(stamp)),
          // Gmail markiert ungelesene Zeilen mit .zE und schreibt sie fett
          unread: row.classList.contains('zE') || +getComputedStyle(senders[0] || row).fontWeight >= 600,
        }];
      });
    },
    icloud() {
      return icloudRows().map((row) => {
        const [from, subject, stamp] = icloudParts(row);
        return {
          key: keyOf(from, subject, stamp), from, subject, snippet: text(row.querySelector('.thread-preview')),
          time: parseTime(stamp), unread: !!row.querySelector('[data-testid="unread-glyph"], .adornment-unread'),
        };
      });
    },
    outlook() {
      return outlookRows().map((row) => {
        const sender = row.querySelector('span[title*="@"]');
        // Zweite Zeile: Betreff und Zeit (deren title trägt das volle Datum „Mi, 30.09.2026 14:04“)
        const stamp = [...row.querySelectorAll('span[title]')].find((s) => /\d{1,2}\.\d{1,2}\.\d{4}|\d{4}/.test(s.title) && s !== sender);
        const line = stamp?.parentElement;
        const subject = line && [...line.children].find((c) => c !== stamp);
        // Vorschau: die Zeile danach
        const snippet = line?.nextElementSibling;
        return {
          key: row.getAttribute('data-convid'), from: text(sender), subject: text(subject), snippet: text(snippet),
          time: parseTime(stamp?.getAttribute('title') || text(stamp)),
          unread: UNREAD_ROW.test(row.getAttribute('aria-label') || '') || +getComputedStyle(sender || row).fontWeight >= 600,
        };
      }).filter((m) => m.key);
    },
  };
  // Nur solange der Posteingang zu sehen ist – sonst stünde z. B. „Gesendet“ in der gemeinsamen Liste
  const inInbox = () => ({
    gmail: () => /^#inbox\/?$/.test(location.hash) || location.hash === '',
    icloud: () => INBOX.test(document.title),
    // Outlook zeigt die Liste auch neben einer offenen Mail (/mail/inbox/id/…); nur andere Ordner zählen nicht
    outlook: () => /^\/mail\/(\d+\/)?(inbox(\/id\/.*)?|id\/.*)?\/?$/i.test(location.pathname),
  })[provider]();

  function readList() {
    if (!inInbox()) return null;
    const list = LISTS[provider]();
    if (!list) return null;
    // Mails ohne erkannte Zeit behalten ihre Reihenfolge: knapp unter der vorigen einsortieren
    let last = Date.now();
    return list.slice(0, MAX).map((m) => {
      last = m.time ?? last - 1000;
      return { ...m, time: last, subject: m.subject.slice(0, 200), snippet: m.snippet.slice(0, 160), from: m.from.slice(0, 120) };
    });
  }

  // ---------- Leseansicht ----------
  // Glass zeigt eine Mail aus der gemeinsamen Liste ohne die Leisten des Postfachs (Ordner, Mail-Liste, Kopfzeile):
  // nur die Mail mit ihrer eigenen Werkzeugleiste (Antworten, Löschen …). Die Kapsel in Glass zeigt das ganze Postfach.
  const READER = {
    // Gmail: Kopfzeile, Navigation links und Seitenleiste rechts weg; der Hauptteil hält sonst Platz für beide frei
    // und rechnet seine Höhe mit der Kopfzeile
    gmail: `header#gb, div[role="navigation"].aeN, .aqk > :not(:has([role="main"])) { display: none !important; }
      .aqk > :has([role="main"]) { margin-left: 0 !important; flex: 1 1 auto !important; width: auto !important; }
      .Tm.aeJ { height: calc(100vh - 48px) !important; }`,
    // iCloud (im iframe): Werkzeugleiste oben und Postfächer weg, die Mail bekommt die ganze Breite. Die Mail-Liste
    // bleibt unsichtbar unter der Mail liegen: Anklicken geht nur mit einem echten Klick an ihre Stelle
    // (__glassMailOpen) – dafür holt html.glass-pick sie kurz nach vorn, weiterhin unsichtbar
    icloud: `header.cloudos-toolbar { display: none !important; }
      .primary-container > ui-split:not(:has(.thread-detail-pane)) { display: none !important; }
      .secondary-container { position: relative !important; }
      .secondary-container > ui-split:not(:has(.thread-detail-pane)) {
        position: absolute !important; left: 0 !important; top: 0 !important; bottom: 0 !important; width: 320px !important;
        opacity: 0 !important; pointer-events: none !important; z-index: 0 !important; }
      html.glass-pick .secondary-container > ui-split:not(:has(.thread-detail-pane)) { pointer-events: auto !important; z-index: 100 !important; }
      :is(.primary-container, .secondary-container) > ui-split:has(.thread-detail-pane) {
        flex: 1 1 100% !important; width: 100% !important; min-width: 100% !important; max-width: none !important; }
      .secondary-outer-container, .thread-detail-pane { width: 100% !important; max-width: none !important; }
      #app-body { top: 0 !important; }`,
    // Outlook: Die Lesefläche legt sich über alles (Kopfzeile, App-Leiste, Ordner, Liste) – die Liste bleibt darunter
    // erhalten; für den Klick auf eine Zeile lässt html.glass-pick die Lesefläche kurz durch
    outlook: `#ReadingPaneContainerId { position: fixed !important; inset: 0 !important; width: auto !important;
        height: auto !important; max-width: none !important; z-index: 1000 !important; }
      html.glass-pick #ReadingPaneContainerId { pointer-events: none !important; }`,
  };
  let reader = false;
  function applyReader() {
    for (const d of docs()) {
      let style = d.getElementById('__glass-reader');
      if (!reader || !READER[provider]) { style?.remove(); continue; }
      if (!style) { style = d.createElement('style'); style.id = '__glass-reader'; (d.head || d.documentElement).append(style); }
      if (style.textContent !== READER[provider]) style.textContent = READER[provider];
    }
  }
  window.__glassMailReader = (on) => {
    reader = !!on;
    applyReader();
    // Gmail und iCloud messen ihre Bereiche bei resize neu
    for (const d of docs()) d.defaultView?.dispatchEvent(new Event('resize'));
    schedule();
  };

  // Im Hintergrund zurück in den Posteingang (mail.rs, beim Aufwecken): Steht Gmail noch in einer gelesenen Mail,
  // bliebe die gemeinsame Liste sonst stehen
  window.__glassMailHome = () => { if (provider === 'gmail' && !inInbox()) location.hash = '#inbox'; };

  // Mail aus der gemeinsamen Liste im Postfach öffnen (Rust ruft das nach dem Tabwechsel auf)
  window.__glassMailOpen = (key) => {
    if (provider === 'gmail') { location.hash = `#inbox/${encodeURIComponent(key)}`; return; }
    // iCloud: Zeile mit gleichem Absender, Betreff und Zeit (die Liste verwendet ihre Zeilen wieder). Anklicken muss
    // Glass selbst mit einem echten Mausklick: Nachgemachte Ereignisse wählen nichts aus, und ein pointerdown ohne
    // echten Zeiger lässt iCloud Mail abstürzen (setPointerCapture schlägt fehl). Die Seite meldet nur, wohin.
    const row = provider === 'icloud' ? icloudRows().find((r) => keyOf(...icloudParts(r)) === key)
      : provider === 'outlook' ? outlookRows().find((r) => r.getAttribute('data-convid') === key) : null;
    if (!row) return;
    // Leseansicht: Die unsichtbare Liste für den Klick nach vorn holen, nach dem echten Klick (oder spätestens nach
    // 3 s) wieder zurück unter die Mail
    const root = row.ownerDocument.documentElement;
    if (reader) {
      root.classList.add('glass-pick');
      const done = () => { clearTimeout(timeout); root.classList.remove('glass-pick'); row.ownerDocument.removeEventListener('click', onClick, true); };
      const onClick = (e) => { if (e.isTrusted) setTimeout(done, 0); };
      const timeout = setTimeout(done, 3000);
      row.ownerDocument.addEventListener('click', onClick, true);
    }
    row.scrollIntoView({ block: 'nearest' });
    requestAnimationFrame(() => {
      const r = row.getBoundingClientRect();
      let x = r.left + Math.min(60, r.width / 2), y = r.top + r.height / 2;
      // Koordinaten des iframes hinzurechnen: Glass klickt ins oberste Dokument
      for (let w = row.ownerDocument.defaultView; w !== window && w.frameElement; w = w.parent) {
        const f = w.frameElement.getBoundingClientRect();
        x += f.left; y += f.top;
      }
      window.ipc.postMessage(JSON.stringify({ mail: { click: [Math.round(x), Math.round(y)] } }));
    });
  };

  let sent = '', timer = 0;
  function check() {
    timer = 0;
    const unread = fromTitle() ?? fromFolders();
    const list = readList();
    // `reader`: ob die Leseansicht gerade gilt – so merkt Glass, wenn sie nach einem Neuladen fehlt
    const msg = { unread: Number.isFinite(unread) ? unread : null, reader };
    if (list) msg.list = list;
    const json = JSON.stringify({ mail: msg });
    if (json === sent || (msg.unread == null && !list)) return;
    sent = json;
    window.ipc.postMessage(json);
  }
  // Die Postfächer ändern ihr DOM ständig: höchstens alle 2 s nachsehen
  const schedule = () => { if (!timer) timer = setTimeout(check, 2000); };
  const observed = new WeakSet();
  const observer = new MutationObserver(schedule);
  // Auch iframes beobachten, die erst später dazukommen (iCloud lädt die Mail-App nach)
  function observe() {
    for (const d of docs()) {
      if (observed.has(d)) continue;
      observed.add(d);
      if (reader) applyReader(); // neues iframe-Dokument (iCloud lädt die Mail-App nach)
      observer.observe(d.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'class'],
      });
    }
  }
  function start() {
    observe();
    new MutationObserver(() => { observe(); schedule(); }).observe(document.documentElement, { subtree: true, childList: true });
    // Ein neu geladenes iframe tauscht sein Dokument aus, ohne dass sich oben etwas ändert
    document.addEventListener('load', (e) => { if (e.target.tagName === 'IFRAME') { observe(); schedule(); } }, true);
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  // Nach dem Aufwecken (mail.rs) sofort nachsehen, auch wenn sich seitdem nichts geändert hat
  document.addEventListener('resume', () => { sent = ''; schedule(); });
  // Lebenszeichen, auch wenn sich nichts ändert: Glass lädt ein Postfach neu, das lange schweigt (mail.rs, SILENT_FOR)
  setInterval(() => { sent = ''; schedule(); }, 4 * 60_000);
  addEventListener('hashchange', schedule);
})();
