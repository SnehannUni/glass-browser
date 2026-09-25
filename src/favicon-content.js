// Run in the content profile: never fetch website icons from the chrome/UI profile.
(() => {
  if (window.top !== window) return;
  let revision = 0, timer, lastKey = '';
  const send = icon => window.ipc.postMessage(JSON.stringify({ favicon: icon }));
  function candidates(target) {
    return [...document.querySelectorAll('link[rel]')].flatMap((link, order) => {
      if (!link.rel.toLowerCase().split(/\s+/).includes('icon')) return [];
      if (link.media && !matchMedia(link.media).matches) return [];
      let url;
      try { url = new URL(link.href, document.baseURI); } catch { return []; }
      if (!['http:', 'https:', 'data:'].includes(url.protocol)) return [];
      const sizes = (link.getAttribute('sizes') || '').toLowerCase().split(/\s+/);
      const vector = link.type === 'image/svg+xml' || /\.svg$/i.test(url.pathname);
      const dimensions = sizes.flatMap(s => {
        const m = /^(\d+)x(\d+)$/.exec(s);
        return m && +m[1] === +m[2] && +m[1] > 0 ? [+m[1]] : [];
      });
      const adequate = dimensions.filter(n => n >= target);
      const size = adequate.length ? Math.min(...adequate) : Math.max(0, ...dimensions);
      // Scalable first, then the smallest adequate bitmap, unknown size, largest undersized.
      const rank = vector ? 0 : size >= target ? 1 : !size ? 2 : 3;
      return [{ url: url.href, vector, rank, size, order }];
    }).sort((a, b) => a.rank - b.rank ||
      (a.rank === 3 ? b.size - a.size : a.size - b.size) || b.order - a.order);
  }
  function load(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const timeout = setTimeout(() => { img.src = ''; reject(new Error('Icon timeout')); }, 4000);
      img.onload = () => { clearTimeout(timeout); resolve(img); };
      img.onerror = () => { clearTimeout(timeout); reject(new Error('Icon unavailable')); };
      img.src = url;
    });
  }
  async function refresh(target, icons, current) {
    send(''); // Return to Chromium's fallback while a changed declaration loads.
    let best = null;
    for (const icon of icons) {
      try {
        const img = await load(icon.url);
        if (current !== revision) return;
        const available = icon.vector ? target : Math.min(img.naturalWidth, img.naturalHeight);
        if (!available || (best && available <= best.available)) continue;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = Math.min(target, available);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
        const width = img.naturalWidth * scale, height = img.naturalHeight * scale;
        ctx.drawImage(img, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        best = { available, data: canvas.toDataURL('image/png') };
        if (available >= target) break;
      } catch { /* CSP/CORS, unsupported or broken image: try the next declaration. */ }
    }
    if (current === revision && best) send(best.data);
  }
  function schedule() {
    // The tab is 16 CSS px; the largest consumer (resize preview) is 40 CSS px.
    // Ignore floating-point noise in Chromium's reported DPR; bound PNG output.
    const target = Math.min(256, Math.max(40, Math.ceil(40 * devicePixelRatio - 1e-5)));
    const icons = candidates(target).slice(0, 12);
    const key = JSON.stringify([target, icons]);
    if (key === lastKey) return;
    lastKey = key;
    const current = ++revision;
    clearTimeout(timer);
    timer = setTimeout(() => refresh(target, icons, current), 100);
  }
  function start() {
    watchDensity();
    new MutationObserver(records => {
      if (records.some(r => (r.type === 'attributes' && r.target.matches('link, base')) || [...r.addedNodes, ...r.removedNodes]
        .some(n => n.nodeType === 1 && (n.matches('link, base') || n.querySelector('link, base'))))) {
        schedule();
      }
    }).observe(document.head || document.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['href', 'rel', 'sizes', 'type', 'media'],
    });
    schedule();
  }
  let densityQuery;
  function watchDensity() {
    densityQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    void densityQuery.matches;
    densityQuery.addEventListener('change', () => {
      schedule(); watchDensity();
    }, { once: true });
  }
  let density = devicePixelRatio;
  addEventListener('resize', () => {
    if (density !== devicePixelRatio) { density = devicePixelRatio; schedule(); }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { lastKey = ''; schedule(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
  addEventListener('pagehide', () => { ++revision; clearTimeout(timer); });
  addEventListener('pageshow', () => { lastKey = ''; schedule(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
