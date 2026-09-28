// Liste des Zwischenablage-Verlaufs nach Strg+V (Rust: clipboard.rs). Liegt in der Oberfläche, nicht in der
// Webseite – die Seite sieht nie, was sonst noch kopiert wurde. Blättern per Pfeiltasten läuft über die Seite.
(() => {
  let panel = null, page = null;
  // Tab der Liste und wie weit seine Seite seit dem Öffnen geglitten ist (für ein später eintreffendes Seitenbild)
  let tab = null, shift = [0, 0];
  const send = (cmd, extra = {}) => window.ipc.postMessage(JSON.stringify({ cmd, ...extra }));

  window.clipboardHistoryHide = () => {
    page?.remove();
    page = null;
    if (!panel) return;
    panel.remove();
    panel = null;
    send('overlay', { key: 'clipboard', rect: null });
  };

  window.clipboardHistorySelect = (index) => {
    panel?.querySelectorAll('.clip-item').forEach((el, i) => el.classList.toggle('on', i === index));
  };

  window.clipboardHistory = (data) => {
    window.clipboardHistoryHide();
    tab = data.tab;
    shift = [0, 0];
    panel = document.createElement('div');
    panel.className = 'glass';
    panel.id = 'clipboard-history';
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', 'Zwischenablage');
    const heading = document.createElement('div');
    heading.className = 'clip-head';
    heading.textContent = 'Zwischenablage';
    panel.append(heading);
    data.items.forEach((text, i) => {
      const item = document.createElement('div');
      item.className = 'clip-item' + (i === data.index ? ' on' : '');
      item.setAttribute('role', 'option');
      const n = document.createElement('span');
      n.className = 'clip-n';
      n.textContent = i + 1;
      const label = document.createElement('span');
      label.className = 'clip-t';
      label.textContent = text;
      item.append(n, label);
      // Beim Drücken, nicht erst beim Loslassen: Rust holt den Fokus sofort in die Seite zurück
      item.addEventListener('pointerdown', (e) => {
        if (!e.isTrusted || e.button !== 0) return;
        e.preventDefault();
        send('clip_pick', { index: i });
      });
      panel.append(item);
    });
    const hint = document.createElement('div');
    hint.className = 'clip-hint';
    hint.textContent = '↑ ↓ wechseln · Esc zurück';
    panel.append(hint);
    document.body.append(panel);
    // Unter die Einfügestelle, bei zu wenig Platz darüber
    const w = panel.offsetWidth, h = panel.offsetHeight, gap = 6;
    const x = Math.max(4, Math.min(data.x, innerWidth - w - 4));
    const y = data.bottom + gap + h <= innerHeight - 4 ? data.bottom + gap : Math.max(4, data.top - gap - h);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    send('overlay', { key: 'clipboard', rect: { x, y, w, h, r: 18 } });
    window.glassLens?.(panel);
  };

  // Bild der Webseite, genau dort, wo sie im Fenster liegt – nur unter der Liste sichtbar (dort ist die Seite
  // ausgespart), damit die Glas-Linse die Seite bricht statt des Wallpapers
  window.clipboardBackdrop = async (data) => {
    if (!panel || page) return;
    const image = new Image();
    image.src = data.image;
    try { await image.decode(); } catch { return; }
    if (!panel || page) return;
    page = document.createElement('div');
    page.id = 'clipboard-page';
    data = { ...data, x: data.x + shift[0], y: data.y + shift[1] };
    Object.assign(page.style, { left: `${data.x}px`, top: `${data.y}px`, width: `${data.w}px`, height: `${data.h}px`,
      backgroundImage: `url("${data.image}")` });
    // Auf die Liste zuschneiden: Außerhalb davon liegt die echte Seite ohnehin darüber
    // (Maße aus left/top statt getBoundingClientRect: die Einblend-Animation verschiebt und skaliert noch)
    const [left, top] = [parseFloat(panel.style.left), parseFloat(panel.style.top)];
    const [right, bottom] = [left + panel.offsetWidth, top + panel.offsetHeight];
    page.style.clipPath = `inset(${top - data.y}px ${data.x + data.w - right}px ${data.y + data.h - bottom}px ${left - data.x}px round 18px)`;
    panel.before(page);
    requestAnimationFrame(() => page?.classList.add('ready'));
  };

  // Die Leiste fährt ein oder aus, die Seite gleitet: Liste und Seitenbild gleiten mit (Kurve wie renderPanes).
  // Die Aussparung in der Seite wandert von selbst mit (Rust zählt sie ab der Seite).
  window.clipboardFollow = (from, to) => {
    const a = from.find((p) => p.id === tab), b = to.find((p) => p.id === tab);
    if (!panel || !a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (!dx && !dy) return;
    shift = [shift[0] + dx, shift[1] + dy];
    const [dur, ...curve] = getComputedStyle(document.documentElement).getPropertyValue('--chrome-slide').trim().split(' ');
    for (const el of [panel, page]) {
      if (!el) continue;
      const left = parseFloat(el.style.left), top = parseFloat(el.style.top);
      el.style.left = `${left + dx}px`;
      el.style.top = `${top + dy}px`;
      el.animate([{ left: `${left}px`, top: `${top}px` }, { left: el.style.left, top: el.style.top }],
        { duration: parseFloat(dur) * 1000, easing: curve.join(' ') });
    }
  };
})();
