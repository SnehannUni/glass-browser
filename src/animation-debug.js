// One clock multiplier for CSS animations/transitions (including pseudo-elements)
// and Web Animations in the browser UI. Network/input timers remain real-time.
(() => {
  const slowRate = 0.05;
  let enabled = false, frame = 0;
  const rates = new Map();
  const badge = document.createElement('button');
  badge.id = 'animation-debug';
  badge.textContent = 'Animationen ×0,05';
  badge.title = 'Zeitlupe ausschalten (Strg+Umschalt+F8)';
  badge.hidden = true;
  badge.style.cssText = 'flex:none;font-size:10px;padding:4px 7px;border-radius:6px;background:#f5c451;color:#171717;text-shadow:none';
  document.querySelector('#toolbar .side.left').append(badge);

  function tick() {
    frame = 0;
    if (!enabled) return;
    const animations = new Set(document.getAnimations());
    for (const animation of animations) {
      if (rates.has(animation)) continue;
      rates.set(animation, animation.playbackRate);
      // Preserve the current visual position, also when toggled mid-animation.
      animation.updatePlaybackRate(animation.playbackRate * slowRate);
    }
    for (const [animation, rate] of rates) {
      if (!animations.has(animation)) {
        animation.updatePlaybackRate(rate);
        rates.delete(animation);
      }
    }
    frame = requestAnimationFrame(tick);
  }
  function setEnabled(value) {
    if (enabled === !!value) return;
    enabled = !!value;
    badge.hidden = !enabled;
    badge.setAttribute('aria-pressed', String(enabled));
    if (enabled) tick();
    else {
      cancelAnimationFrame(frame); frame = 0;
      for (const [animation, rate] of rates) animation.updatePlaybackRate(rate);
      rates.clear();
    }
  }
  window.AnimationDebug = { setEnabled, toggle: () => setEnabled(!enabled), get enabled() { return enabled; } };
  badge.onclick = () => setEnabled(false);
})();
