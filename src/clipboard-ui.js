// Liste des Zwischenablage-Verlaufs nach Strg+V (Rust: clipboard.rs). Liegt in der Oberfläche, nicht in der
// Webseite – die Seite sieht nie, was sonst noch kopiert wurde. Blättern per Pfeiltasten läuft über die Seite.
(() => {
  let panel = null;
  const send = (cmd, extra = {}) => window.ipc.postMessage(JSON.stringify({ cmd, ...extra }));

  window.clipboardHistoryHide = () => {
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
    send('overlay', { key: 'clipboard', rect: { x, y, w, h, r: 14 } });
  };
})();
