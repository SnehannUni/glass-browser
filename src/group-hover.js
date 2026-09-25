// One moving hover surface per compact button group; hit targets never overlap.
(() => {
  let current = null;
  function clear() {
    current?.classList.remove('group-hover-on', 'group-hover-pressed');
    current = null;
  }
  function at(x, y, overUI = true) {
    // Resolve the group first: rounded button corners and the group's padding
    // must not interrupt the moving highlight between neighbouring controls.
    const hit = x == null || !overUI ? null : document.elementFromPoint(x,y);
    const group = hit?.closest('[data-button-group]');
    // [data-group-skip]: content inside a group that is not a button zone (the active tab in the address field)
    if (!group || hit.closest('[data-group-skip]') || (group.id === 'address' && (group.classList.contains('editing') || document.body.classList.contains('start')))) { clear(); return; }
    const buttons = [...group.querySelectorAll(':scope > button.key')]
      .map(button => ({button, rect:button.getBoundingClientRect()}))
      .filter(({rect}) => rect.width > 0 && rect.height > 0);
    // Rectangular, contiguous horizontal zones; disabled buttons keep their own
    // zone so they cannot accidentally highlight an enabled neighbour.
    const target = buttons.reduce((best, candidate) => {
      const distance = Math.abs(x - (candidate.rect.left + candidate.rect.width / 2));
      return !best || distance < best.distance ? {...candidate, distance} : best;
    }, null);
    if (!target || target.button.disabled) { clear(); return; }
    const button = target.button;
    const box = group.getBoundingClientRect(), rect = button.getBoundingClientRect();
    const sx = group.offsetWidth/box.width, sy = group.offsetHeight/box.height;
    const first = current !== group || !group.classList.contains('group-hover-on');
    if (current !== group) clear();
    current = group;
    if (first) group.classList.add('group-hover-instant');
    group.style.setProperty('--group-x', `${(rect.left-box.left)*sx-2}px`);
    group.style.setProperty('--group-y', `${(rect.top-box.top)*sy}px`);
    group.style.setProperty('--group-width', `${rect.width*sx+4}px`);
    group.style.setProperty('--group-height', `${rect.height*sy}px`);
    if (first) { void group.offsetWidth; group.classList.remove('group-hover-instant'); }
    group.classList.add('group-hover-on');
  }
  window.GroupHover = {at};
  document.addEventListener('pointermove', e => at(e.clientX,e.clientY));
  document.addEventListener('pointerdown', e => { at(e.clientX,e.clientY); current?.classList.add('group-hover-pressed'); });
  document.addEventListener('pointerup', () => current?.classList.remove('group-hover-pressed'));
  document.addEventListener('pointercancel', clear);
  document.documentElement.addEventListener('pointerleave', clear);
  window.addEventListener('blur', clear);
})();
