// Trusted account picker. Websites never receive the list of saved usernames.
(() => {
  let panel, request;
  const send = (cmd, extra = {}) => window.ipc.postMessage(JSON.stringify({ cmd, ...extra }));
  window.hidePasswordSuggestions = () => {
    if (!panel) return;
    panel.remove(); panel = null; request = null;
    send('overlay', { rect: null });
  };
  window.passwordSuggestions = data => {
    if (!panel) window.preparePasswordSuggestions?.();
    request = data.id;
    panel ||= document.createElement('div');
    panel.replaceChildren();
    panel.className = 'glass';
    panel.id = 'password-suggestions';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'iCloud-Passwörter');
    Object.assign(panel.style, { position: 'fixed', zIndex: 25, padding: '6px', borderRadius: '14px', width: '300px', backdropFilter: 'blur(24px) brightness(.6)', backgroundColor: 'rgba(28,30,38,.92)', color: 'white' });
    const heading = document.createElement('div');
    heading.textContent = 'iCloud-Passwörter';
    Object.assign(heading.style, { padding: '6px 8px', fontSize: '11px', opacity: '.7' });
    panel.append(heading);
    if (data.message || !data.accounts?.length) {
      const text = document.createElement('div');
      text.textContent = data.message || 'Keine passenden Passwörter';
      Object.assign(text.style, { padding: '8px', maxWidth: '280px' });
      panel.append(text);
      if (data.retry) {
        const retry = document.createElement('button');
        retry.className = 'key'; retry.textContent = 'Erneut versuchen';
        retry.addEventListener('click', e => { if (e.isTrusted) send('autofill_retry', {id:request}); });
        panel.append(retry);
      }
    } else data.accounts.slice(0, 5).forEach((account, index) => {
      const button = document.createElement('button');
      button.className = 'key';
      button.type = 'button';
      button.textContent = account.username || account.label;
      Object.assign(button.style, { display: 'block', textAlign: 'left', width: '100%', height: '38px', padding: '0 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
      button.addEventListener('click', e => {
        if (!e.isTrusted) return;
        send('autofill_pick', { id: request, index });
        window.hidePasswordSuggestions();
      });
      panel.append(button);
    });
    document.body.append(panel);
    const x = Math.max(4, Math.min(data.x, innerWidth - panel.offsetWidth - 4));
    const y = Math.max(44, Math.min(data.y, innerHeight - panel.offsetHeight - 4));
    panel.style.left = `${x}px`; panel.style.top = `${y}px`;
    send('overlay', { rect: { x, y, w: panel.offsetWidth, h: panel.offsetHeight, r: 14 } });
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel) send('autofill_dismiss'); });
  document.addEventListener('pointerdown', e => { if (panel && !panel.contains(e.target)) send('autofill_dismiss'); }, true);
})();
