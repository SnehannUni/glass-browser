// Field detection only. Account selection lives in Glass's trusted UI, outside the website.
(() => {
  if (window !== top || location.protocol !== 'https:') return;
  const post = window.ipc.postMessage.bind(window.ipc);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  let active = null, token = null;
  const visible = el => el instanceof HTMLInputElement && !el.disabled && !el.readOnly &&
    el.type !== 'hidden' && el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
  const hint = el => (el.autocomplete || '').toLowerCase().split(/\s+/);
  function loginField(el) {
    if (!visible(el) || hint(el).some(h => ['new-password', 'one-time-code'].includes(h))) return false;
    const scope = el.form || el.getRootNode();
    const passwords = [...scope.querySelectorAll('input[type="password"]')].filter(visible);
    if (passwords.length && passwords.every(p => hint(p).includes('new-password'))) return false;
    if (passwords.length > 1 && !passwords.some(p => hint(p).includes('current-password'))) return false;
    if (el.type === 'password' || hint(el).includes('username')) return true;
    if (!['text', 'email'].includes(el.type)) return false;
    const label = [el.name, el.id, el.getAttribute('aria-label'), ...[...(el.labels || [])].map(l => l.textContent)].join(' ');
    return /user.?name|benutzer|e.?mail|login|account/i.test(label) ||
      passwords.some(p => !!(el.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING));
  }
  function cancel() {
    if (token) post(JSON.stringify({ autofill: 'cancel', token }));
    token = null; active = null;
  }
  function focus(el) {
    if (!loginField(el)) { cancel(); return; }
    if (active === el && token) return;
    active = el; token = crypto.randomUUID();
    const r = el.getBoundingClientRect();
    post(JSON.stringify({ autofill: 'focus', token, rect: [r.x, r.y, r.width, r.height] }));
  }
  document.addEventListener('focusin', e => { if (e.isTrusted) focus(e.composedPath()[0]); }, true);
  document.addEventListener('pointerdown', e => {
    if (!e.isTrusted) return;
    const target = e.composedPath()[0];
    if (target === active && token) return;
    if (!loginField(target)) cancel();
    else if (target === document.activeElement) focus(target);
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') cancel(); }, true);
  addEventListener('scroll', cancel, true);
  addEventListener('pagehide', cancel);
  Object.defineProperty(window, '__glassAutofillFill', { value: (expected, origin, username, password) => {
    if (expected !== token || origin !== location.origin || !active?.isConnected || !loginField(active)) return;
    const scope = active.form || active.getRootNode();
    const fields = [...scope.querySelectorAll('input')].filter(visible);
    const pw = active.type === 'password' ? active : fields.find(el => el.type === 'password' && !hint(el).includes('new-password'));
    const user = active.type !== 'password' ? active : fields.filter(el => ['text', 'email'].includes(el.type) && loginField(el) && (!pw || (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING))).at(-1);
    const fill = (el, value) => {
      if (!el) return;
      setValue.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    fill(user, username); fill(pw, password);
    active = null; token = null;
  } });
})();
