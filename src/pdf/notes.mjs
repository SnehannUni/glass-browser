// Notizen wie in Acrobat: auf die Seite heften, aufklappen, schreiben, verschieben – und alle Kommentare des
// Dokuments in der Seitenleiste. Im PDF sind Notizen /Text-Anmerkungen; beim Öffnen übernimmt Glass sie (auch die aus
// anderen Programmen) in die eigene Ebene, damit sie sich bearbeiten lassen, und schreibt sie beim Speichern zurück.
import { t, LOCALE } from './en.mjs';

const $ = (id) => document.getElementById(id);
const ICON = 22; // Größe des Symbols in PDF-Punkten
// Art der Anmerkung (annotationType von PDF.js) für die Kommentarliste; übersetzt beim Anzeigen
const TYPE_LABEL = {
  1: 'Notiz', 3: 'Text', 4: 'Linie', 5: 'Rechteck', 6: 'Ellipse', 7: 'Vieleck', 8: 'Linienzug', 9: 'Hervorhebung',
  10: 'Unterstrichen', 11: 'Gewellt', 12: 'Durchgestrichen', 13: 'Stempel', 14: 'Einfügen', 15: 'Zeichnung', 17: 'Datei',
  101: 'Unterschrift',
};
const uid = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
const rgbHex = (c) => (c && c.length >= 3 ? '#' + [...c].slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') : null);
// PDF-Datum D:YYYYMMDDHHmmSS
const pdfDate = (d) => 'D:' + d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
const parsePdfDate = (s) => {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
  return m ? new Date(Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0)) : null;
};
const when = (d) => (d ? d.toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export function initNotes(app) {
  let notes = []; // { id, page, x, y (linke obere Ecke, PDF-Punkte), text, author, color, date, open }
  let others = []; // übrige Anmerkungen mit Text, nur für die Liste: { page, type, text, author, rect }
  let active = false;
  const state = { color: '#ffd60a' };
  const authorInput = $('note-author');
  try { authorInput.value = sessionStorage.getItem('glass-note-author') || ''; } catch { /* kein Speicher */ }
  authorInput.addEventListener('input', () => { try { sessionStorage.setItem('glass-note-author', authorInput.value); } catch { /* egal */ } });

  // ---------- Darstellen ----------
  function render(n, layer) {
    for (const el of layer.querySelectorAll('.note-pin, .note-card')) el.remove();
    const g = app.pageGeometry(n);
    for (const note of notes.filter((x) => x.page === n)) {
      const [left, top] = g.toPercent(note.x, note.y);
      const pin = Object.assign(document.createElement('button'), { className: 'note-pin', title: note.text || t('Notiz') });
      pin.dataset.id = note.id;
      pin.style.left = `${left}%`;
      pin.style.top = `${top}%`;
      pin.style.setProperty('--note', note.color);
      pin.innerHTML = '<svg viewBox="0 0 16 16"><use href="#i-note"/></svg>';
      pin.classList.toggle('selected', !!note.open);
      dragPin(pin, note, n);
      layer.append(pin);
      if (note.open) layer.append(card(note, left, top));
    }
  }
  function card(note, left, top) {
    const el = document.createElement('div');
    el.className = 'note-card glass';
    el.dataset.id = note.id;
    // Rechts neben das Symbol, am rechten Rand nach links
    el.style.left = left > 62 ? '' : `calc(${left}% + 30px)`;
    el.style.right = left > 62 ? `calc(${100 - left}% + 8px)` : '';
    el.style.top = `${top}%`;
    el.style.setProperty('--note', note.color);
    el.innerHTML = `<header><b></b><span></span><button class="close" title="${t('Zuklappen')}"><svg><use href="#i-close"/></svg></button></header>
      <textarea placeholder="${t('Notiz schreiben …')}" rows="4"></textarea>
      <footer><button class="delete" title="${t('Notiz löschen')}"><svg><use href="#i-trash"/></svg>${t('Löschen')}</button></footer>`;
    el.querySelector('b').textContent = note.author || t('Notiz');
    el.querySelector('span').textContent = when(note.date);
    const text = el.querySelector('textarea');
    text.value = note.text;
    text.addEventListener('input', () => { note.text = text.value; note.date = new Date(); changed(false); });
    text.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') toggle(note, false); });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.querySelector('.close').onclick = () => toggle(note, false);
    el.querySelector('.delete').onclick = () => remove(note);
    if (note.focus) { delete note.focus; requestAnimationFrame(() => text.focus()); }
    return el;
  }
  const refresh = (page) => app.refreshLayers(page);

  function toggle(note, open = !note.open) {
    for (const other of notes) if (other !== note && other.open) { other.open = false; refresh(other.page); }
    note.open = open;
    refresh(note.page);
  }
  function changed(rerender = true, page) {
    app.setDirty(true);
    app.markEdited();
    dispatchEvent(new Event('glass-edited'));
    if (rerender) refresh(page);
    scheduleList();
  }
  function remove(note) {
    notes = notes.filter((x) => x !== note);
    changed(true, note.page);
    app.toast(t('Notiz gelöscht'), { label: t('Rückgängig'), run: () => { notes.push(note); note.open = false; changed(true, note.page); } });
  }

  // Symbol ziehen = verschieben, kurz klicken = auf/zu
  function dragPin(pin, note, n) {
    pin.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const g = app.pageGeometry(n), start = g.eventToPdf(e), from = [note.x, note.y];
      let moved = false;
      pin.setPointerCapture(e.pointerId);
      pin.onpointermove = (ev) => {
        const [x, y] = g.eventToPdf(ev);
        if (!moved && Math.hypot(x - start[0], y - start[1]) < 3) return;
        moved = true;
        note.x = from[0] + x - start[0];
        note.y = from[1] + y - start[1];
        const [left, top] = g.toPercent(note.x, note.y);
        pin.style.left = `${left}%`;
        pin.style.top = `${top}%`;
      };
      pin.onpointerup = () => {
        pin.onpointermove = pin.onpointerup = null;
        if (moved) changed(true, n); else toggle(note);
      };
    });
  }

  // ---------- Werkzeug: auf die Seite klicken = neue Notiz ----------
  const place = (e) => {
    if (!active || e.button !== 0) return;
    const pageDiv = e.target.closest?.('#viewer .page');
    if (!pageDiv || e.target.closest('.note-pin, .note-card, .annotationLayer a, .annotationLayer input, .annotationLayer textarea')) return;
    e.preventDefault();
    e.stopPropagation();
    const n = +pageDiv.dataset.pageNumber;
    const [x, y] = app.pageGeometry(n).eventToPdf(e);
    const note = { id: uid(), page: n, x: x - ICON / 2, y: y + ICON / 2, text: '', author: authorInput.value.trim(), color: state.color, date: new Date(), open: false, focus: true };
    notes.push(note);
    toggle(note, true);
    changed(false);
  };

  // ---------- Kommentarliste in der Seitenleiste ----------
  let listTimer = 0;
  const scheduleList = () => { clearTimeout(listTimer); listTimer = setTimeout(refreshList, 150); };
  function refreshList() {
    const box = $('comments');
    if (box.hidden) return;
    const items = [
      ...notes.map((n) => ({ page: n.page, y: n.y, label: t('Notiz'), text: n.text, author: n.author, date: n.date, color: n.color, note: n })),
      ...others.map((o) => ({ page: o.page, y: o.rect[3], label: t(TYPE_LABEL[o.type] || 'Anmerkung'), text: o.text, author: o.author, date: o.date, color: o.color })),
    ].sort((a, b) => a.page - b.page || b.y - a.y);
    box.replaceChildren();
    if (!items.length) {
      const empty = Object.assign(document.createElement('p'), { className: 'empty', textContent: t('Noch keine Kommentare. Mit dem Notiz-Werkzeug (N) eine Notiz anheften.') });
      box.append(empty);
      return;
    }
    let page = 0;
    for (const item of items) {
      if (item.page !== page) {
        page = item.page;
        box.append(Object.assign(document.createElement('h4'), { textContent: t('Seite {n}', { n: page }) }));
      }
      const b = document.createElement('button');
      b.className = 'comment';
      b.style.setProperty('--note', item.color || 'var(--label-3)');
      b.innerHTML = '<span class="dot"></span><div><b></b><small></small><p></p></div>';
      b.querySelector('b').textContent = item.author ? `${item.label} · ${item.author}` : item.label;
      b.querySelector('small').textContent = when(item.date);
      b.querySelector('p').textContent = item.text || (item.note ? t('Leere Notiz') : '');
      b.onclick = () => {
        app.viewer.scrollPageIntoView({ pageNumber: item.page, destArray: [null, { name: 'XYZ' }, null, item.y + 60, null] });
        if (item.note) toggle(item.note, true);
      };
      box.append(b);
    }
  }

  // ---------- Öffnen: /Text-Anmerkungen übernehmen ----------
  app.importHooks.push(async (doc) => {
    const found = [], rest = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const annots = await (await doc.getPage(n)).getAnnotations().catch(() => []);
      for (const a of annots) {
        if (a.annotationType === 1) {
          found.push({
            id: uid(), page: n, x: a.rect[0], y: a.rect[3], text: a.contentsObj?.str || '', author: a.titleObj?.str || '',
            color: rgbHex(a.color) || '#ffd60a', date: parsePdfDate(a.modificationDate) || null, open: false,
          });
        } else if (a.annotationType !== 2 && a.annotationType !== 16 && a.annotationType !== 20) {
          // ohne Links (2), Popups (16) und Formularfelder (20)
          rest.push({ page: n, type: a.annotationType, text: a.contentsObj?.str || '', author: a.titleObj?.str || '', rect: a.rect, color: rgbHex(a.color), date: parsePdfDate(a.modificationDate) });
        }
      }
    }
    notes = found;
    others = rest;
    scheduleList();
    if (!found.length) return null;
    // Aus dem PDF nehmen – ab jetzt zeigt und speichert Glass sie
    const lib = await app.loadPdfLib();
    const { PDFDocument, PDFName, PDFArray } = lib;
    const encryptedBytes = !!(await doc.getMetadata().catch(() => null))?.info?.EncryptFilterName;
    const bytes = encryptedBytes ? await doc.extractPages([{ document: null }]) : await doc.getData();
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    for (const page of pdf.getPages()) {
      const annots = page.node.lookup(PDFName.of('Annots'));
      if (!(annots instanceof PDFArray)) continue;
      const keep = annots.asArray().filter((ref) => {
        const dict = pdf.context.lookup(ref);
        const subtype = dict?.get?.(PDFName.of('Subtype'))?.toString();
        if (subtype === '/Text') return false;
        if (subtype === '/Popup') {
          const parent = pdf.context.lookup(dict.get(PDFName.of('Parent')));
          if (parent?.get?.(PDFName.of('Subtype'))?.toString() === '/Text') return false;
        }
        return true;
      });
      page.node.set(PDFName.of('Annots'), pdf.context.obj(keep));
    }
    return pdf.save({ updateFieldAppearances: false });
  });

  // ---------- Speichern: Notizen als /Text-Anmerkungen ----------
  app.exportHooks.push({
    active: () => notes.length > 0,
    async apply(bytes) {
      const lib = await app.loadPdfLib();
      const { PDFDocument, PDFName, PDFArray, PDFHexString, PDFString } = lib;
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      for (const note of notes) {
        const page = pdf.getPage(note.page - 1);
        if (!page) continue;
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(note.color.slice(i, i + 2), 16) / 255);
        const dict = pdf.context.obj({
          Type: 'Annot', Subtype: 'Text', Name: 'Comment',
          Rect: [note.x, note.y - ICON, note.x + ICON, note.y],
          Contents: PDFHexString.fromText(note.text || ''),
          T: PDFHexString.fromText(note.author || ''),
          M: PDFString.of(pdfDate(note.date || new Date())),
          NM: PDFString.of(`glass-note-${note.id}`),
          C: [r, g, b], F: 28, Open: false,
        });
        const ref = pdf.context.register(dict);
        dict.set(PDFName.of('P'), page.ref);
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (annots instanceof PDFArray) annots.push(ref);
        else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
      }
      return pdf.save({ updateFieldAppearances: false });
    },
  });

  app.layerRenderers.push(render);
  app.onDocument(() => { scheduleList(); requestAnimationFrame(() => app.refreshLayers()); });

  return {
    get list() { return notes; },
    set color(c) { state.color = c; },
    refreshList,
    enter() {
      active = true;
      document.body.classList.add('noting');
      app.container.addEventListener('pointerdown', place, true);
    },
    leave() {
      active = false;
      document.body.classList.remove('noting');
      app.container.removeEventListener('pointerdown', place, true);
    },
  };
}
