// Inhalt einer PDF-Seite lesen und gezielt ändern: Content-Stream zerlegen, Text-Zustand nachverfolgen, jede Glyphe
// mit ihrer Lage berechnen (Breiten aus der Schrift). Damit lassen sich Glyphen wirklich entfernen – fürs Schwärzen
// und für „Text bearbeiten“ – statt sie nur zu überdecken. Arbeitet auf pdf-lib-Objekten.

// ---------- Zerlegen ----------
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const isRegular = (b) => !WS.has(b) && !DELIM.has(b);
const dec = new TextDecoder('latin1');

/** Bytes → Liste von Operatoren `{ op, args }`; Inline-Bilder bleiben als Rohbytes (`raw`) erhalten. */
export function parseContent(bytes) {
  let i = 0;
  const n = bytes.length;
  const ops = [];
  let stack = [];
  const skipWs = () => {
    while (i < n) {
      if (WS.has(bytes[i])) i++;
      else if (bytes[i] === 37) { while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++; } // Kommentar
      else break;
    }
  };
  function literal() {
    i++; // (
    const out = [];
    let depth = 1;
    while (i < n) {
      const b = bytes[i++];
      if (b === 92) { // Backslash
        const c = bytes[i++];
        const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
        if (c in map) out.push(map[c]);
        else if (c >= 48 && c <= 55) {
          let v = c - 48;
          for (let k = 0; k < 2 && bytes[i] >= 48 && bytes[i] <= 55; k++) v = v * 8 + bytes[i++] - 48;
          out.push(v & 255);
        } else if (c === 13) { if (bytes[i] === 10) i++; } else if (c !== 10) out.push(c);
      } else if (b === 40) { depth++; out.push(b); } else if (b === 41) { if (--depth === 0) break; out.push(b); } else out.push(b);
    }
    return { t: 'str', bytes: Uint8Array.from(out) };
  }
  function hex() {
    i++; // <
    let s = '';
    while (i < n && bytes[i] !== 62) { const c = bytes[i++]; if (!WS.has(c)) s += String.fromCharCode(c); }
    i++;
    if (s.length % 2) s += '0';
    const out = new Uint8Array(s.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = parseInt(s.substr(k * 2, 2), 16);
    return { t: 'str', bytes: out, hex: true };
  }
  function value() {
    skipWs();
    const b = bytes[i];
    if (b === 40) return literal();
    if (b === 60) {
      if (bytes[i + 1] === 60) {
        i += 2;
        const map = new Map();
        for (;;) {
          skipWs();
          if (bytes[i] === 62 && bytes[i + 1] === 62) { i += 2; break; }
          if (i >= n) break;
          const key = value();
          const val = value();
          map.set(key.v, val);
        }
        return { t: 'dict', v: map };
      }
      return hex();
    }
    if (b === 91) {
      i++;
      const arr = [];
      for (;;) {
        skipWs();
        if (bytes[i] === 93) { i++; break; }
        if (i >= n) break;
        arr.push(value());
      }
      return { t: 'arr', v: arr };
    }
    if (b === 47) {
      i++;
      let s = '';
      while (i < n && isRegular(bytes[i])) {
        if (bytes[i] === 35 && i + 2 < n) { s += String.fromCharCode(parseInt(dec.decode(bytes.subarray(i + 1, i + 3)), 16)); i += 3; } else s += String.fromCharCode(bytes[i++]);
      }
      return { t: 'name', v: s };
    }
    const start = i;
    while (i < n && isRegular(bytes[i])) i++;
    if (i === start) { i++; return { t: 'op', v: dec.decode(bytes.subarray(start, i)) }; }
    const word = dec.decode(bytes.subarray(start, i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: parseFloat(word) };
    if (word === 'true' || word === 'false') return { t: 'bool', v: word === 'true' };
    if (word === 'null') return { t: 'null' };
    return { t: 'op', v: word };
  }
  while (i < n) {
    skipWs();
    if (i >= n) break;
    const start = i;
    const v = value();
    if (v.t !== 'op') { stack.push(v); continue; }
    if (v.v === 'BI') {
      // Inline-Bild: bis „EI“ zwischen Leerraum als Ganzes übernehmen
      let j = i;
      while (j < n - 1) {
        if (bytes[j] === 69 && bytes[j + 1] === 73 && WS.has(bytes[j - 1]) && (j + 2 >= n || WS.has(bytes[j + 2]))) break;
        j++;
      }
      ops.push({ op: 'BI', raw: bytes.slice(start, j + 2), args: [] });
      i = j + 2;
      stack = [];
      continue;
    }
    ops.push({ op: v.v, args: stack });
    stack = [];
  }
  return ops;
}

// ---------- Zurückschreiben ----------
const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
function writeValue(v) {
  switch (v.t) {
    case 'num': return Number.isInteger(v.v) ? String(v.v) : String(+v.v.toFixed(5));
    case 'name': return '/' + [...v.v].map((c) => (/[\x21-\x7e]/.test(c) && !'()<>[]{}/%#'.includes(c) ? c : '#' + c.charCodeAt(0).toString(16).padStart(2, '0'))).join('');
    case 'str': return '<' + [...v.bytes].map((b) => b.toString(16).padStart(2, '0')).join('') + '>';
    case 'arr': return '[' + v.v.map(writeValue).join(' ') + ']';
    case 'dict': return '<<' + [...v.v].map(([k, val]) => writeValue({ t: 'name', v: k }) + ' ' + writeValue(val)).join(' ') + '>>';
    case 'bool': return v.v ? 'true' : 'false';
    case 'null': return 'null';
    default: return '';
  }
}
export function writeContent(ops) {
  const parts = [];
  for (const o of ops) {
    if (o.raw) { parts.push(o.raw, enc('\n')); continue; }
    parts.push(enc((o.args.length ? o.args.map(writeValue).join(' ') + ' ' : '') + o.op + '\n'));
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------- Matrizen ----------
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const nums = (args) => args.map((a) => a.v);

// ---------- Schriften: Breiten in 1/1000 Schriftgröße ----------
/** Breiten der 14 Standardschriften (ohne /Widths im PDF) über pdf-lib. */
export function standardFontFor(lib, baseFont) {
  const { StandardFonts: S } = lib;
  const name = (baseFont || '').replace(/^[A-Z]{6}\+/, '');
  const bold = /Bold|Black|Heavy|Semibold/i.test(name), italic = /Oblique|Italic/i.test(name);
  if (/Courier|Mono/i.test(name)) return bold ? (italic ? S.CourierBoldOblique : S.CourierBold) : italic ? S.CourierOblique : S.Courier;
  if (/Times|Serif|Garamond|Georgia|Cambria|Roman/i.test(name) && !/Sans/i.test(name)) return bold ? (italic ? S.TimesRomanBoldItalic : S.TimesRomanBold) : italic ? S.TimesRomanItalic : S.TimesRoman;
  if (/^Symbol/i.test(name)) return S.Symbol;
  if (/Zapf|Dingbat/i.test(name)) return S.ZapfDingbats;
  return bold ? (italic ? S.HelveticaBoldOblique : S.HelveticaBold) : italic ? S.HelveticaOblique : S.Helvetica;
}
async function standardWidths(lib, pdf, baseFont) {
  const font = await pdf.embedStandardFont(standardFontFor(lib, baseFont));
  const cache = new Map();
  return (code) => {
    if (!cache.has(code)) {
      let w = 500;
      try { w = font.widthOfTextAtSize(String.fromCharCode(code), 1000); } catch { /* Zeichen fehlt in der Schrift */ }
      cache.set(code, w);
    }
    return cache.get(code);
  };
}

/** Schrift aus den Ressourcen: wie viele Bytes ein Zeichen hat und wie breit es ist. */
async function fontInfo(lib, pdf, dict) {
  const { PDFName, PDFArray, PDFNumber } = lib;
  const get = (d, k) => d && pdf.context.lookup(d.get(PDFName.of(k)));
  const num = (o) => (o instanceof PDFNumber ? o.asNumber() : 0);
  const subtype = get(dict, 'Subtype')?.toString() || '';
  const baseFont = (get(dict, 'BaseFont')?.toString() || '').replace(/^\//, '');
  const info = { twoByte: false, width: () => 500, ascent: .8, descent: -.2, baseFont, scale: 1 };
  const descriptorOf = (d) => get(d, 'FontDescriptor');
  const metrics = (desc) => {
    const a = num(get(desc, 'Ascent')), d = num(get(desc, 'Descent'));
    if (a > 0) info.ascent = a / 1000;
    if (d < 0) info.descent = d / 1000;
  };
  if (!dict) return info;
  if (subtype === '/Type0') {
    info.twoByte = true;
    const desc = get(dict, 'DescendantFonts');
    const cid = desc instanceof PDFArray ? pdf.context.lookup(desc.get(0)) : null;
    if (!info.baseFont) info.baseFont = (get(cid, 'BaseFont')?.toString() || '').replace(/^\//, '');
    metrics(descriptorOf(cid));
    const dw = num(get(cid, 'DW')) || 1000;
    const widths = new Map();
    const w = get(cid, 'W');
    if (w instanceof PDFArray) {
      const items = w.asArray().map((o) => pdf.context.lookup(o));
      for (let k = 0; k < items.length;) {
        const first = num(items[k]);
        const next = items[k + 1];
        if (next instanceof PDFArray) {
          next.asArray().forEach((v, j) => widths.set(first + j, num(pdf.context.lookup(v))));
          k += 2;
        } else {
          const last = num(next), width = num(items[k + 2]);
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, width);
          k += 3;
        }
      }
    }
    info.width = (code) => widths.get(code) ?? dw;
    return info;
  }
  metrics(descriptorOf(dict));
  const widthsArr = get(dict, 'Widths');
  if (widthsArr instanceof PDFArray) {
    const first = num(get(dict, 'FirstChar'));
    const list = widthsArr.asArray().map((o) => num(pdf.context.lookup(o)));
    const missing = num(get(descriptorOf(dict), 'MissingWidth'));
    info.width = (code) => list[code - first] ?? missing;
    if (subtype === '/Type3') {
      const fm = get(dict, 'FontMatrix');
      info.scale = fm instanceof PDFArray ? num(pdf.context.lookup(fm.get(0))) * 1000 : 1;
    }
  } else if (info.baseFont) {
    info.width = await standardWidths(lib, pdf, info.baseFont);
  }
  return info;
}

// ---------- Seite auswerten ----------
/**
 * Liest Seite `index` (0-basiert): Operatoren, jede Glyphe mit ihrem Viereck in PDF-Punkten (`quad`: 4 Ecken),
 * und alle Bilder/Formulare mit ihrer Lage. Eine Glyphe: `{ op, part, at, code, quad, origin, size, angle, fill, … }`
 * – `op` Index des Text-Operators, `part` Index im TJ-Array, `at` Byte-Index im String.
 */
export async function readPage(lib, pdf, index) {
  const { PDFName, PDFArray, PDFDict, PDFRawStream, decodePDFRawStream } = lib;
  const page = pdf.getPage(index);
  const node = page.node;
  const contents = pdf.context.lookup(node.get(PDFName.of('Contents')));
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => pdf.context.lookup(r)) : contents ? [contents] : [];
  const chunks = streams.map((s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s?.getContents?.() || new Uint8Array()));
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length + 1, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; all[at++] = 10; }
  const ops = parseContent(all);

  const resources = node.Resources();
  const sub = (kind) => { const d = resources && pdf.context.lookup(resources.get(PDFName.of(kind))); return d instanceof PDFDict ? d : null; };
  const fontsDict = sub('Font'), xobjects = sub('XObject');
  const fonts = new Map();
  const font = async (name) => {
    if (!fonts.has(name)) {
      const dict = fontsDict && pdf.context.lookup(fontsDict.get(PDFName.of(name)));
      fonts.set(name, await fontInfo(lib, pdf, dict instanceof PDFDict ? dict : null));
    }
    return fonts.get(name);
  };

  const glyphs = [], objects = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const gstack = [];
  let fill = { op: 'g', args: [{ t: 'num', v: 0 }] };
  let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0];
  const ts = { tc: 0, tw: 0, th: 1, tl: 0, rise: 0, size: 0, font: null, fontName: '' };
  const nextLine = () => { tlm = mul([1, 0, 0, 1, 0, -ts.tl], tlm); tm = tlm.slice(); };
  const unitSquare = (m) => [apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)];

  function show(opIndex, items) {
    const f = ts.font || { twoByte: false, width: () => 500, ascent: .8, descent: -.2, scale: 1 };
    for (let part = 0; part < items.length; part++) {
      const item = items[part];
      if (item.t === 'num') { tm = mul([1, 0, 0, 1, -item.v / 1000 * ts.size * ts.th, 0], tm); continue; }
      if (item.t !== 'str') continue;
      const b = item.bytes, step = f.twoByte ? 2 : 1;
      for (let k = 0; k + step <= b.length; k += step) {
        const code = f.twoByte ? (b[k] << 8) | b[k + 1] : b[k];
        const w0 = f.width(code) / 1000 * f.scale;
        const trm = mul(mul([ts.size * ts.th, 0, 0, ts.size, 0, ts.rise], tm), ctm);
        glyphs.push({
          op: opIndex, part, at: k, code,
          quad: [apply(trm, 0, f.descent), apply(trm, w0, f.descent), apply(trm, w0, f.ascent), apply(trm, 0, f.ascent)],
          origin: apply(trm, 0, 0), size: Math.hypot(trm[2], trm[3]), angle: Math.atan2(trm[1], trm[0]),
          fill, fontName: ts.fontName, baseFont: f.baseFont, tsSize: ts.size, tc: ts.tc, tw: ts.tw,
        });
        const tx = (w0 * ts.size + ts.tc + (!f.twoByte && code === 32 ? ts.tw : 0)) * ts.th;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    }
  }

  for (let k = 0; k < ops.length; k++) {
    const { op, args } = ops[k];
    switch (op) {
      case 'q': gstack.push({ ctm, fill }); break;
      case 'Q': { const s = gstack.pop(); if (s) ({ ctm, fill } = s); break; }
      case 'cm': if (args.length === 6) ctm = mul(nums(args), ctm); break;
      case 'g': case 'rg': case 'k': case 'sc': case 'scn': fill = { op, args }; break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
      case 'Tc': ts.tc = args[0]?.v || 0; break;
      case 'Tw': ts.tw = args[0]?.v || 0; break;
      case 'Tz': ts.th = (args[0]?.v ?? 100) / 100; break;
      case 'TL': ts.tl = args[0]?.v || 0; break;
      case 'Ts': ts.rise = args[0]?.v || 0; break;
      case 'Tf': ts.fontName = args[0]?.v || ''; ts.size = args[1]?.v || 0; ts.font = await font(ts.fontName); break;
      case 'Td': tlm = mul([1, 0, 0, 1, args[0]?.v || 0, args[1]?.v || 0], tlm); tm = tlm.slice(); break;
      case 'TD': ts.tl = -(args[1]?.v || 0); tlm = mul([1, 0, 0, 1, args[0]?.v || 0, args[1]?.v || 0], tlm); tm = tlm.slice(); break;
      case 'Tm': if (args.length === 6) { tlm = nums(args); tm = tlm.slice(); } break;
      case 'T*': nextLine(); break;
      case 'Tj': show(k, [args[0]]); break;
      case 'TJ': show(k, args[0]?.v || []); break;
      case "'": nextLine(); show(k, [args[0]]); break;
      case '"': ts.tw = args[0]?.v || 0; ts.tc = args[1]?.v || 0; nextLine(); show(k, [args[2]]); break;
      case 'Do': {
        const x = xobjects && pdf.context.lookup(xobjects.get(PDFName.of(args[0]?.v)));
        const kind = x?.dict?.get(PDFName.of('Subtype'))?.toString();
        let quad = unitSquare(ctm);
        if (kind === '/Form') {
          const bb = x.dict.lookup(PDFName.of('BBox'));
          const fm = x.dict.lookup(PDFName.of('Matrix'));
          const m = fm instanceof PDFArray ? mul(fm.asArray().map((o) => o.asNumber()), ctm) : ctm;
          const [x0, y0, x1, y1] = bb instanceof PDFArray ? bb.asArray().map((o) => o.asNumber()) : [0, 0, 1, 1];
          quad = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)];
        }
        objects.push({ op: k, kind: kind === '/Form' ? 'form' : 'image', quad });
        break;
      }
      case 'BI': objects.push({ op: k, kind: 'image', quad: unitSquare(ctm) }); break;
      default: break;
    }
  }
  return { page, node, ops, glyphs, objects, fonts };
}

// ---------- Geometrie ----------
export function quadBounds(quad) {
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
/** Überschneiden sich Viereck und Rechteck [x1,y1,x2,y2] (achsparallel genähert) um mehr als `min`? */
export function intersects(quad, rect, min = 0) {
  const [a, b, c, d] = quadBounds(quad);
  return Math.min(c, rect[2]) - Math.max(a, rect[0]) > min && Math.min(d, rect[3]) - Math.max(b, rect[1]) > min;
}
/** Liegt der Mittelpunkt des Vierecks im Rechteck? */
export function centerIn(quad, rect) {
  const [a, b, c, d] = quadBounds(quad);
  const x = (a + c) / 2, y = (b + d) / 2;
  return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
}

// ---------- Glyphen entfernen ----------
/**
 * Entfernt die Glyphen `remove` (aus `readPage`) aus den Operatoren. Was danach kommt, bleibt an seiner Stelle:
 * statt der Zeichen steht im TJ-Array ein Abstand derselben Breite.
 */
export function removeGlyphs(content, remove) {
  const { ops, fonts } = content;
  const byOp = new Map();
  for (const g of remove) {
    if (!byOp.has(g.op)) byOp.set(g.op, new Map());
    byOp.get(g.op).set(`${g.part}:${g.at}`, g);
  }
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    const gone = byOp.get(k);
    if (!gone) { out.push(o); continue; }
    const items = o.op === 'TJ' ? o.args[0].v : o.op === '"' ? [o.args[2]] : [o.args[0]];
    const first = gone.values().next().value;
    const font = fonts.get(first.fontName) || { twoByte: false, width: () => 500, scale: 1 };
    const step = font.twoByte ? 2 : 1;
    const result = [];
    items.forEach((item, part) => {
      if (item.t !== 'str') { result.push(item); return; }
      let keep = [];
      let gap = 0;
      const flushKeep = () => { if (keep.length) { result.push({ t: 'str', bytes: Uint8Array.from(keep) }); keep = []; } };
      const flushGap = () => { if (gap) { result.push({ t: 'num', v: -gap }); gap = 0; } };
      for (let at = 0; at + step <= item.bytes.length; at += step) {
        const g = gone.get(`${part}:${at}`);
        if (g) {
          flushKeep();
          // Abstand in TJ-Einheiten (1/1000 der Schriftgröße): Breite plus Zeichen- und Wortabstand
          const space = !font.twoByte && g.code === 32 ? g.tw : 0;
          gap += font.width(g.code) * font.scale + (g.tsSize ? (g.tc + space) / g.tsSize * 1000 : 0);
        } else {
          flushGap();
          for (let j = 0; j < step; j++) keep.push(item.bytes[at + j]);
        }
      }
      flushKeep();
      flushGap();
    });
    // ' und " springen zuerst in die nächste Zeile (und setzen Abstände) – das bleibt als eigener Operator
    if (o.op === "'") out.push({ op: 'T*', args: [] });
    if (o.op === '"') out.push({ op: 'Tw', args: [o.args[0]] }, { op: 'Tc', args: [o.args[1]] }, { op: 'T*', args: [] });
    out.push({ op: 'TJ', args: [{ t: 'arr', v: result }] });
  }
  content.ops = out;
  return content;
}

/** Schreibt die (geänderten) Operatoren als neuen Content-Stream der Seite; `extra`: Befehle, die danach kommen. */
export function saveContent(lib, pdf, content, extra = '') {
  const { PDFName } = lib;
  const body = writeContent(content.ops);
  // Seite in q/Q, eigene Befehle dahinter – so wirkt ein offener Zustand der Seite nicht auf sie
  const head = enc('q\n'), tail = enc(`Q\n${extra ? `q\n${extra}\nQ\n` : ''}`);
  const bytes = new Uint8Array(head.length + body.length + tail.length);
  bytes.set(head, 0);
  bytes.set(body, head.length);
  bytes.set(tail, head.length + body.length);
  content.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream(bytes)));
}

/** Füllfarbe eines Operators als pdf-lib-Farbe (Gerätefarben; anderes wird Schwarz). */
export function fillColor(lib, fill) {
  const v = (fill?.args || []).map((a) => a.v).filter((x) => typeof x === 'number');
  if (fill?.op === 'g' || v.length === 1) return lib.grayscale(v[0] ?? 0);
  if (fill?.op === 'k' || v.length === 4) return lib.cmyk(...v.slice(0, 4));
  if (v.length >= 3) return lib.rgb(v[0], v[1], v[2]);
  return lib.rgb(0, 0, 0);
}
