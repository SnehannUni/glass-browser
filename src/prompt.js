// Tippt einen Prompt in das Chat-Eingabefeld der Seite und schickt ihn ab – für Anbieter, die keinen
// Prompt über die Adresse annehmen (Gemini, Kimi, Z.ai; siehe Search::Typed in main.rs).
// Wird nach dem Laden der Seite mit dem Prompt aufgerufen: (…)("Text").
async (text) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 60 && r.height > 12 && getComputedStyle(el).visibility !== 'hidden';
  };
  // Das Chatfeld: sichtbares Textfeld bzw. bearbeitbares Element, bei mehreren das unterste
  const findBox = () => [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .filter(visible)
    .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  const content = (el) => (el.value ?? el.innerText ?? '').trim();

  // Seiten-Apps bauen ihr Eingabefeld oft erst nach dem Laden auf – bis zu 15 s warten
  let box;
  for (let i = 0; i < 60 && !(box = findBox()); i++) await sleep(250);
  if (!box) return;
  box.focus();
  if (box instanceof HTMLTextAreaElement) {
    // Über den nativen Setter, damit Frameworks wie React die Änderung mitbekommen
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  }
  await sleep(400);

  // Abschicken: erst Enter, sonst den Senden-Knopf drücken
  const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  for (const type of ['keydown', 'keypress', 'keyup']) box.dispatchEvent(new KeyboardEvent(type, enter));
  await sleep(800);
  if (content(box).includes(text.slice(0, 20))) {
    const send = [...document.querySelectorAll('button, [role="button"]')].filter(visible).find((b) =>
      /send|senden|submit|发送/i.test(`${b.getAttribute('aria-label') || ''} ${b.dataset.testid || ''} ${b.title || ''} ${b.className}`));
    send?.click();
  }
}
