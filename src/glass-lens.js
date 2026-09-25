// Linse: Lichtbrechung an den Glaskanten – gemeinsam für die Oberfläche (ui.html) und den PDF-Viewer.
// Für jedes Glas-Element ([data-lens]) wird eine Displacement-Map erzeugt, die den Hintergrund
// zum Rand hin nach innen zieht – wie eine dicke, abgerundete Glasscheibe.
// Blur und Helligkeit lassen sich pro Fläche über --glass-blur und --glass-brightness einstellen.
(() => {
  // Ablage der SVG-Filter: #filters, sonst beim ersten Bedarf angelegt
  const filters = () => document.getElementById('filters') || document.body.appendChild(Object.assign(
    document.createElementNS('http://www.w3.org/2000/svg', 'svg'), { id: 'filters', style: 'position:absolute;width:0;height:0', ariaHidden: 'true' }));
  // Für jedes Glas-Element wird eine Displacement-Map erzeugt, die den Hintergrund
  // zum Rand hin nach innen zieht – wie eine dicke, abgerundete Glasscheibe.
  let lensSeq = 0;
  function lens(el) {
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (!w || !h || el.dataset.lensSize === `${w}x${h}`) return;
    el.dataset.lensSize = `${w}x${h}`;
    const radius = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2);
    const bezel = Math.min(20, h / 2, w / 2);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + .5 - w / 2, py = y + .5 - h / 2;
        const qx = Math.abs(px) - (w / 2 - radius), qy = Math.abs(py) - (h / 2 - radius);
        let nx, ny, dist;
        if (qx > 0 && qy > 0) {
          const len = Math.hypot(qx, qy) || 1;
          nx = qx / len; ny = qy / len; dist = radius - len;
        } else if (qx > qy) { nx = 1; ny = 0; dist = radius - qx; }
        else { nx = 0; ny = 1; dist = radius - qy; }
        // auf 0…1 begrenzen: außerhalb der Rundung (dist < 0) sonst Ausreißer → helle Zacken an der Kante
        const t = Math.min(1, Math.max(0, 1 - dist / bezel));
        const m = t * t * (3 - 2 * t); // weicher Übergang zur Kante
        const i = (y * w + x) * 4;
        d[i] = 128 - Math.sign(px) * nx * m * 127;
        d[i + 1] = 128 - Math.sign(py) * ny * m * 127;
        d[i + 2] = 128; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const map = canvas.toDataURL();
    const token = ++lensSeq;
    el.dataset.lensToken = token;
    // Erst dekodieren: sonst wendet Chromium den Filter mit noch leerer Karte an (= keine Brechung)
    const probe = new Image();
    probe.src = map;
    probe.decode().catch(() => {}).then(() => {
      if (el.dataset.lensToken !== String(token)) return; // inzwischen neu vermessen
      installLens(el, map, w, h, token);
      // feImage lädt seine Karte intern noch einmal; ein zweiter Anstoß stellt sicher, dass sie greift
      setTimeout(() => {
        if (el.dataset.lensToken !== String(token)) return;
        const again = ++lensSeq;
        el.dataset.lensToken = again;
        installLens(el, map, w, h, again);
      }, 150);
    });
  }

  // Jede Linse bekommt eine neue Filter-ID: Chromium zeichnet backdrop-filter nicht neu, wenn sich
  // nur der Inhalt eines SVG-Filters ändert – eine neue url(#…) erzwingt das sofort.
  function installLens(el, map, w, h, token) {
    const id = `lens-${token}`;
    const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.id = id;
    for (const [k, v] of Object.entries({ x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })) {
      filter.setAttribute(k, v);
    }
    // Rot, Grün und Blau werden unterschiedlich stark gebrochen → feine Farbsäume an der Kante
    // kleiner als das Element selbst, sonst greift die Brechung bei kleinen Knöpfen zu weit
    const scale = Math.min(44, Math.min(w, h) * .8);
    const channel = (k, s, matrix) =>
      `<feDisplacementMap in="SourceGraphic" in2="map" scale="${s}" xChannelSelector="R" yChannelSelector="G" result="d${k}"/>` +
      `<feColorMatrix in="d${k}" type="matrix" values="${matrix}" result="${k}"/>`;
    filter.innerHTML =
      `<feImage href="${map}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>` +
      channel('r', scale, '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0') +
      channel('g', scale * .98, '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0') +
      channel('b', scale * .96, '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0') +
      `<feBlend in="r" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b" mode="screen"/>`;
    filters().appendChild(filter);
    const old = el.dataset.lensId && document.getElementById(el.dataset.lensId);
    el.dataset.lensId = id;
    // leicht abdunkeln statt aufhellen: Text im Glas bleibt auf jedem Wallpaper lesbar
    el.style.backdropFilter = `url(#${id}) blur(var(--glass-blur, 2px)) saturate(1.5) brightness(var(--glass-brightness, .82))`;
    // alten Filter erst entfernen, wenn der neue sicher gezeichnet ist
    if (old) requestAnimationFrame(() => requestAnimationFrame(() => old.remove()));
  }
  const lensQueue = new Set();
  let lensFrame = 0;
  const resizeObserver = new ResizeObserver((entries) => {
    // Das Adressfeld bekommt seine Linse erst, wenn es fertig ein-/ausgefahren ist (siehe slide)
    entries.forEach((e) => { if (!e.target.classList.contains('resizing')) lensQueue.add(e.target); });
    if (!lensFrame) lensFrame = requestAnimationFrame(() => {
      lensFrame = 0; lensQueue.forEach(lens); lensQueue.clear();
    });
  });
  const watch = (root = document) => root.querySelectorAll('[data-lens]').forEach((el) => resizeObserver.observe(el));
  window.GlassLens = { lens, watch };
})();
