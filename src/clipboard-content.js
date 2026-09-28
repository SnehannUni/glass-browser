// Zwischenablage-Verlauf in Webseiten: Strg+V fügt wie gewohnt den neuesten Eintrag ein, danach tauscht ↑/↓ den
// eingefügten Text gegen eine ältere Kopie. Die Liste zeigt Glass in der eigenen Oberfläche (clipboard-ui.js) –
// die Webseite bekommt den Verlauf nie zu sehen, nur den Text, den der Nutzer auswählt. Dieses Skript meldet nur
// „eingefügt“, „Pfeil gedrückt“ und „fertig“; Rust prüft selbst, ob die Taste wirklich gedrückt ist.
(() => {
  if (window.top !== window) return;
  const post = window.ipc.postMessage.bind(window.ipc);
  const send = (clip, extra = {}) => post(JSON.stringify({ clip, ...extra }));

  const TEXT_INPUTS = ['text', 'search', 'url', 'tel', 'email', 'password', ''];
  // Fokussiertes Element, auch in Shadow-DOMs (z. B. Web Components mit eigenem Eingabefeld)
  const focused = () => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  const isField = (el) => el instanceof HTMLTextAreaElement
    || (el instanceof HTMLInputElement && TEXT_INPUTS.includes(el.getAttribute('type')?.toLowerCase() ?? ''));
  const squash = (s) => s.replace(/\s+/g, ' ').trim();

  // Wohin zuletzt eingefügt wurde: Element und Anfang des eingefügten Texts
  let target = null;
  // Die Liste ist offen, Pfeiltasten blättern
  let active = false;
  let moved = false;

  function finish() {
    if (!active) return;
    active = false;
    send('end');
  }

  document.addEventListener('paste', (e) => {
    finish();
    target = null;
    const el = focused();
    const text = e.clipboardData?.getData('text/plain');
    if (!e.isTrusted || !text || !el || (!isField(el) && !el.isContentEditable) || el.readOnly) return;
    const t = { el };
    if (isField(el)) {
      t.start = Math.min(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    } else {
      const sel = getSelection();
      if (!sel?.rangeCount) return;
      // Eine Range wandert bei Änderungen am DOM mit – sie bleibt so vor dem eingefügten Text stehen
      t.startRange = sel.getRangeAt(0).cloneRange();
      t.startRange.collapse(true);
    }
    target = t;
    // Nach dem Einfügen (das Standardverhalten läuft erst nach diesem Ereignis) prüfen, was tatsächlich drinsteht:
    // Fängt die Seite das Einfügen selbst ab und macht etwas anderes daraus, blättert Glass nicht.
    setTimeout(() => {
      if (target !== t || !measure(t) || squash(current(t)) !== squash(text)) return;
      const r = caretRect(t);
      active = true;
      moved = false;
      send('start', { rect: [r.left, r.top, r.width, r.height] });
    }, 0);
  }, true);

  // Bereich des eingefügten Texts neu bestimmen: vom gemerkten Anfang bis zum Cursor
  function measure(t) {
    if (isField(t.el)) {
      t.len = (t.el.selectionEnd ?? 0) - t.start;
      return t.len >= 0;
    }
    const sel = getSelection();
    if (!sel?.rangeCount) return false;
    const range = document.createRange();
    try {
      range.setStart(t.startRange.startContainer, t.startRange.startOffset);
      range.setEnd(sel.focusNode, sel.focusOffset);
    } catch { return false; }
    t.range = range;
    return true;
  }
  const current = (t) => isField(t.el) ? t.el.value.slice(t.start, t.start + t.len) : t.range.toString();
  function caretRect(t) {
    const rects = !isField(t.el) && t.range ? t.range.getClientRects() : [];
    return rects.length ? rects[rects.length - 1] : t.el.getBoundingClientRect();
  }

  // Aus Rust: den eingefügten Text durch den gewählten Eintrag ersetzen
  Object.defineProperty(window, '__glassClipInsert', { value: (text) => {
    const t = target;
    if (typeof text !== 'string' || !t?.el.isConnected) return;
    const el = t.el;
    // Nach einem Klick in die Liste liegt der Fokus kurz woanders – der Cursor steht aber noch am Ende des Texts
    if (isField(el)) {
      el.focus();
      if (!measure(t)) return;
      el.setSelectionRange(t.start, t.start + t.len);
    } else {
      if (!t.range) return;
      el.focus();
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(t.range);
    }
    // insertText statt value zu setzen: Die Seite (React & Co.) bekommt ein echtes input-Ereignis, Strg+Z funktioniert
    if (!document.execCommand('insertText', false, text) && isField(el)) {
      el.setRangeText(text, t.start, t.start + t.len, 'end');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
    }
    measure(t);
  } });
  // Aus Rust: Liste zu (Tabwechsel, Klick in die Liste …)
  Object.defineProperty(window, '__glassClipEnd', { value: () => { active = false; } });

  window.addEventListener('keydown', (e) => {
    if (!active || !e.isTrusted || e.isComposing) return;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return; // z. B. Strg noch gedrückt nach Strg+V
    const plain = !e.altKey && !e.shiftKey && !e.metaKey;
    const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (plain && dir) {
      e.preventDefault();
      e.stopImmediatePropagation();
      moved = true;
      send('step', { dir });
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      active = false;
      send('revert');
      return;
    }
    if (e.key === 'Enter' && moved) {
      // Nur nach dem Blättern schluckt Enter die Taste – sonst schickt es wie gewohnt das Formular ab
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    finish();
  }, true);

  window.addEventListener('mousedown', finish, true);
  window.addEventListener('blur', finish);
  window.addEventListener('scroll', finish, true);
  window.addEventListener('pagehide', finish);
})();
