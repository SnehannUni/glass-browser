// Constant-width vector rim; light falloff is measured in CSS pixels along its path.
(() => {
  const states = new WeakMap(), watched = new WeakSet();
  const ns = 'http://www.w3.org/2000/svg';
  let pointer = null;
  function node(name, attrs) {
    const el = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  }
  function illuminate(el, state) {
    const { w, h, radius: r, perimeter: p } = state;
    const bounds = el.getBoundingClientRect();
    const dx = pointer ? (pointer.x - bounds.left) * w / bounds.width - w / 2 : -1;
    const dy = pointer ? (pointer.y - bounds.top) * h / bounds.height - h / 2 : -1;
    // Distance to the visible rounded shape, not its centre: long controls
    // respond equally at either end. Smoothstep has no hard fade boundary.
    const radius = (r + state.thickness/2) * Math.min(bounds.width/w, bounds.height/h);
    const qx = Math.abs((pointer?.x ?? bounds.left) - (bounds.left+bounds.width/2)) - (bounds.width/2-radius);
    const qy = Math.abs((pointer?.y ?? bounds.top) - (bounds.top+bounds.height/2)) - (bounds.height/2-radius);
    const distance = Math.max(0, Math.hypot(Math.max(qx,0), Math.max(qy,0)) + Math.min(Math.max(qx,qy),0) - radius);
    const t = Math.min(1, Math.max(0, (distance-24)/256));
    state.svg.style.setProperty('--rim-proximity', pointer ? String(1-t*t*(3-2*t)) : '0');
    if (!Number.isFinite(dx + dy)) return;
    // Project onto the nearest point of the rounded contour. Straight edges
    // preserve the cursor's tangential coordinate; corners use their own centre.
    const W = w - state.thickness, H = h - state.thickness;
    const innerX = W/2-r, innerY = H/2-r;
    function anchor(side) {
      const localY = side * Math.max(Math.abs(dy), .000001);
      const cx = Math.max(-innerX, Math.min(innerX, dx));
      const cy = Math.max(-innerY, Math.min(innerY, localY));
      const vx = dx-cx, vy = localY-cy, length = Math.hypot(vx,vy);
      let x, y;
      if (length > .000001) {
        x = W/2+cx+r*vx/length; y = H/2+cy+r*vy/length;
      } else if (innerX-Math.abs(dx) < innerY-Math.abs(localY)) {
        x = dx < 0 ? 0 : W; y = H/2+localY;
      } else {
        x = W/2+dx; y = side < 0 ? 0 : H;
      }
      const a = W - 2 * r, b = H - 2 * r, arc = Math.PI * r / 2;
      let at;
      if (y <= r && x >= r && x <= W - r) at = x - r;
      else if (x > W - r && y < r) at = a + r * (Math.atan2(y-r, x-(W-r)) + Math.PI/2);
      else if (x >= W-r && y >= r && y <= H-r) at = a + arc + y-r;
      else if (x > W-r && y > H-r) at = a + arc + b + r * Math.atan2(y-(H-r), x-(W-r));
      else if (y >= H-r && x >= r && x <= W-r) at = a + 2*arc + b + W-r-x;
      else if (x < r && y > H-r) at = 2*a + 2*arc + b + r * (Math.atan2(y-(H-r), x-r)-Math.PI/2);
      else if (x <= r && y >= r && y <= H-r) at = 2*a + 3*arc + b + H-r-y;
      else at = 2*a + 3*arc + 2*b + r * (Math.atan2(y-r, x-r)+Math.PI);
      return at;
      }
    // Spatial crossfade through the full height; no nearest-edge switch at the midline.
    const across = Math.max(0, Math.min(1, (dy+H/2)/H));
    const bottom = across*across*(3-2*across);
    state.lobes.forEach((lobe,index) => {
      const at = anchor(index === 0 ? -1 : 1);
      lobe.group.setAttribute('opacity', String(index === 0 ? 1-bottom : bottom));
      for (const light of lobe.paths) light.el.setAttribute('stroke-dashoffset', (light.half-at-light.opposite*p/2).toFixed(3));
    });
  }
  function update(el) {
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    const style = getComputedStyle(el), thickness = parseFloat(style.getPropertyValue('--glass-rim')) || 1;
    const outerRadius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, w/2, h/2);
    const signature = `${w}/${h}/${outerRadius}/${thickness}`;
    let state = states.get(el);
    if (state?.signature === signature && state.svg.parentNode === el) return;
    state?.svg.remove();
    const inset = thickness/2, W = w-thickness, H = h-thickness, r = Math.max(0, outerRadius-inset);
    const p = 2*(W+H-4*r)+2*Math.PI*r;
    const d = `M ${r} 0 H ${W-r} A ${r} ${r} 0 0 1 ${W} ${r} V ${H-r} A ${r} ${r} 0 0 1 ${W-r} ${H} H ${r} A ${r} ${r} 0 0 1 0 ${H-r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    const svg = node('svg', { class: 'glass-rim', width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true', focusable: 'false' });
    // The quiet outline shares exactly the highlight geometry, without fading
    // with cursor distance or introducing another antialiased border edge.
    svg.append(node('path', { class:'glass-outline', d, transform:`translate(${inset} ${inset})`,
      fill:'none', stroke:'white', 'stroke-width':thickness }));
    const highlights = node('g', {class:'glass-highlights'});
    svg.append(highlights);
    const lobes = [], halfWidth = Math.min(44, p*.24);
    for (const side of ['top','bottom']) {
      const group = node('g', {class:'glass-lobe', 'data-side':side});
      highlights.append(group);
      const paths = [];
      lobes.push({group,paths});
      for (const opposite of [0, 1]) {
        const peak = parseFloat(style.getPropertyValue(opposite ? '--glass-reflection' : '--glass-highlight')) || 0;
        let previous = 0;
        for (let i = 0; i < 24; i++) {
          const half = halfWidth*(1-i/24);
          const intensity = peak*(1+Math.cos(Math.PI*half/halfWidth))/2;
          const opacity = (intensity-previous)/(1-previous);
          previous = intensity;
          const path = node('path', { d, transform: `translate(${inset} ${inset})`, fill:'none', stroke:'white', 'stroke-width':thickness,
            'stroke-linecap':'butt', 'stroke-opacity':opacity, 'stroke-dasharray':`${2*half} ${p-2*half}` });
          group.append(path); paths.push({el:path, half, opposite});
        }
      }
      }
    state = {signature, svg, lobes, w, h, radius:r, thickness, perimeter:p};
    states.set(el, state); el.append(svg); illuminate(el, state);
  }
  window.GlassRim = {
    move(el, x, y) { pointer = {x, y}; update(el); const state=states.get(el); if(state) illuminate(el,state); },
    leave() { pointer = null; document.querySelectorAll('.glass-rim').forEach(svg => svg.style.setProperty('--rim-proximity','0')); }
  };
  const sizes = new ResizeObserver(entries => entries.forEach(e => update(e.target)));
  function watch(root) {
    for (const el of [...(root.matches?.('.glass') ? [root] : []), ...(root.querySelectorAll?.('.glass') || [])]) {
      if (!watched.has(el)) { watched.add(el); sizes.observe(el); }
      update(el);
    }
  }
  const changes = new MutationObserver(records => {
    for (const record of records) {
      if (record.target.matches?.('.glass')) update(record.target);
      for (const child of record.addedNodes) if (child.nodeType === 1 && !child.matches('.glass-rim')) watch(child);
    }
  });
  watch(document); changes.observe(document.body, {childList:true, subtree:true});
})();
