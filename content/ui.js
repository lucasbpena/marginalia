// In-page UI in a shadow root: selection toolbar, highlight popover,
// video bookmark pill, note prompt and toasts. Styles go in through CSSOM so a
// strict page CSP can't block them.
(() => {
  const RW = globalThis.RW;
  if (RW.ui) return;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .layer { position: fixed; z-index: 2147483647; color: #ececf1; font-size: 13px; line-height: 1.4; }
    .bar, .card, .pill, .toast {
      background: #1f1f24; border: 1px solid #34343c; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.3);
    }
    .bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; animation: pop .12s ease-out; }
    @keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.98); } }
    .sw { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.25); transition: transform .1s; }
    .sw:hover { transform: scale(1.15); }
    .sw.on { border-color: #fff; }
    .sep { width: 1px; height: 18px; background: #3a3a44; margin: 0 2px; }
    button.icon { all: unset; display: inline-flex; align-items: center; gap: 5px; padding: 4px 6px; border-radius: 6px;
      cursor: pointer; color: #d6d6e0; font-size: 12px; }
    button.icon:hover { background: #2e2e36; color: #fff; }
    button.icon.danger:hover { background: #4a1f25; color: #ffb3bd; }
    button.icon svg { width: 15px; height: 15px; }
    .card { width: 320px; padding: 10px; animation: pop .12s ease-out; }
    .row { display: flex; align-items: center; gap: 6px; }
    .grow { flex: 1; }
    textarea, input {
      width: 100%; margin-top: 8px; resize: vertical; min-height: 64px; max-height: 260px;
      background: #141418; color: #f1f1f5; border: 1px solid #3a3a44; border-radius: 7px;
      padding: 8px 9px; font-size: 13px; line-height: 1.45; outline: none;
    }
    input { min-height: 0; }
    textarea:focus, input:focus { border-color: #8b6cff; box-shadow: 0 0 0 3px rgba(139,108,255,.25); }
    .hint { margin-top: 6px; font-size: 11px; color: #9a9aa8; display: flex; justify-content: space-between; gap: 8px; }
    .title { font-weight: 600; font-size: 13px; color: #fff; }
    .pill { all: unset; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px;
      background: rgba(20,20,24,.82); border: 1px solid rgba(255,255,255,.18); color: #fff; font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer; backdrop-filter: blur(6px); box-shadow: 0 4px 14px rgba(0,0,0,.35); }
    .pill:hover { background: rgba(124,92,255,.92); border-color: transparent; }
    .pill svg { width: 14px; height: 14px; }
    .toast { padding: 9px 13px; font-size: 13px; animation: pop .15s ease-out; display: flex; gap: 8px; align-items: center; }
    .toast b { color: #b9a6ff; font-weight: 600; }
  `;

  const ICONS = {
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2h12a1 1 0 0 1 1 1v19l-7-5-7 5V3a1 1 0 0 1 1-1Z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  };

  let host, root;

  function ensureRoot() {
    if (host?.isConnected) return root;
    if (!host) {
      host = document.createElement('marginalia-ui');
      for (const [k, v] of Object.entries({ all: 'initial', position: 'fixed', top: '0', left: '0', width: '0', height: '0', 'z-index': '2147483647' })) {
        host.style.setProperty(k, v, 'important');
      }
      root = host.attachShadow({ mode: 'open' });
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
      } catch {
        const el = document.createElement('style');
        el.textContent = CSS;
        root.append(el);
      }
      // Keep keystrokes and clicks inside our UI away from page shortcuts (YouTube's k/j/f, etc.).
      for (const t of ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu', 'copy', 'paste', 'cut', 'input']) {
        root.addEventListener(t, (e) => e.stopPropagation());
      }
    }
    (document.fullscreenElement || document.documentElement).appendChild(host);
    return root;
  }

  document.addEventListener('fullscreenchange', () => {
    if (host) (document.fullscreenElement || document.documentElement).appendChild(host);
  });

  const isOurs = (e) => !!host && e.composedPath().includes(host);

  // Pages that enforce Trusted Types (YouTube…) reject raw innerHTML in some browsers.
  let policy;
  function el(html) {
    const t = document.createElement('template');
    try {
      t.innerHTML = html.trim();
    } catch {
      policy ??= globalThis.trustedTypes?.createPolicy('marginalia', { createHTML: (s) => s });
      t.innerHTML = policy.createHTML(html.trim());
    }
    return t.content.firstElementChild;
  }

  function layer(child) {
    const l = document.createElement('div');
    l.className = 'layer';
    l.append(child);
    ensureRoot().append(l);
    return l;
  }

  // Put a layer next to `rect`, above it when there's room, otherwise below; clamped to the viewport.
  function place(l, rect, { prefer = 'above', gap = 8, align = 'center' } = {}) {
    const w = l.offsetWidth, h = l.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    let top = prefer === 'above' ? rect.top - h - gap : rect.bottom + gap;
    if (prefer === 'above' && top < 4) top = rect.bottom + gap;
    if (prefer === 'below' && top + h > vh - 4) top = Math.max(4, rect.top - h - gap);
    let left = align === 'center' ? rect.left + rect.width / 2 - w / 2 : rect.left;
    left = Math.min(Math.max(4, left), vw - w - 4);
    top = Math.min(Math.max(4, top), vh - h - 4);
    l.style.top = `${top}px`;
    l.style.left = `${left}px`;
  }

  const swatches = (current) => Object.entries(RW.COLORS)
    .map(([name, hex]) => `<button class="sw${name === current ? ' on' : ''}" data-color="${name}" title="${name}" style="background:${hex}"></button>`)
    .join('');

  // ---------- selection toolbar ----------

  let bar = null;
  function showToolbar(rect, { onColor, onNote }) {
    hideToolbar();
    const node = el(`<div class="bar">${swatches('')}<span class="sep"></span>
      <button class="icon" data-act="note" title="Highlight and add a note">${ICONS.note}<span>Note</span></button></div>`);
    // Clicking the toolbar must not clear the page selection.
    node.addEventListener('mousedown', (e) => e.preventDefault());
    node.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.color) onColor(b.dataset.color);
      else if (b.dataset.act === 'note') onNote();
    });
    bar = layer(node);
    place(bar, rect);
  }
  function hideToolbar() { bar?.remove(); bar = null; }

  // ---------- highlight popover ----------

  let pop = null;
  function showPopover(rect, item, { onColor, onNote, onCopy, onDelete, onClose, focus }) {
    hidePopover();
    const sent = item.exportedAt ? `<span>${ICONS.check.replace('<svg', '<svg width="11" height="11"')} Sent to Obsidian</span>` : '<span></span>';
    const node = el(`<div class="card">
      <div class="row">${swatches(item.color)}<span class="grow"></span>
        <button class="icon" data-act="copy" title="Copy as Markdown">${ICONS.copy}</button>
        <button class="icon danger" data-act="delete" title="Delete highlight">${ICONS.trash}</button>
      </div>
      <textarea placeholder="Add a note…"></textarea>
      <div class="hint">${sent}<span>Esc to close</span></div>
    </div>`);
    const ta = node.querySelector('textarea');
    ta.value = item.note || '';
    let timer = null, last = ta.value;
    const flush = () => {
      clearTimeout(timer);
      if (ta.value !== last) { last = ta.value; onNote(ta.value); }
    };
    ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 500); });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); close(); }
    });
    node.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.color) {
        node.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', s === b));
        onColor(b.dataset.color);
      } else if (b.dataset.act === 'copy') { onCopy(); toast('Copied'); }
      else if (b.dataset.act === 'delete') { timer = null; last = ta.value; hidePopover(); onDelete(); }
    });
    const close = () => { flush(); hidePopover(); onClose?.(); };
    pop = layer(node);
    pop.close = close;
    place(pop, rect, { prefer: 'below' });
    if (focus) setTimeout(() => ta.focus(), 0);
  }
  function hidePopover() { const p = pop; pop = null; p?.remove(); }
  function closePopover() { pop?.close(); }

  // ---------- note prompt (video bookmarks, page notes) ----------

  // One prompt at a time. It closes on Enter/Esc or a click outside, not on blur:
  // players like YouTube grab focus back right after a click.
  let activePrompt = null;
  function prompt(rect, { title, placeholder = 'Add a note…', value = '', onDone }) {
    activePrompt?.close();
    const node = el(`<div class="card">
      <div class="title"></div>
      <textarea placeholder=""></textarea>
      <div class="hint"><span>Enter to save · Shift+Enter for a new line</span><span>Esc to skip</span></div>
    </div>`);
    node.querySelector('.title').textContent = title;
    const ta = node.querySelector('textarea');
    ta.placeholder = placeholder;
    ta.value = value;
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (activePrompt === handle) activePrompt = null;
      l.remove();
      onDone?.(save ? ta.value.trim() : null);
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    const l = layer(node);
    place(l, { top: rect.top + 12, bottom: rect.top + 12, left: rect.left + 12, width: 0, height: 0 }, { prefer: 'below', gap: 0, align: 'left' });
    ta.focus();
    requestAnimationFrame(() => ta.focus());
    const handle = { close: () => finish(true) };
    activePrompt = handle;
    return handle;
  }

  document.addEventListener('mousedown', (e) => {
    if (activePrompt && !isOurs(e)) activePrompt.close();
  }, true);

  // ---------- video pill ----------

  let pill = null;
  function showPill(rect, label, onClick) {
    if (!pill) {
      const node = el(`<button class="pill" tabindex="-1" title="Bookmark this moment (Alt+Shift+Y)">${ICONS.bookmark}<span></span></button>`);
      // Never take focus: a focused button would re-fire on the Space/Enter typed into the note.
      node.addEventListener('mousedown', (e) => e.preventDefault());
      node.addEventListener('click', (e) => { e.preventDefault(); pill?.onClick?.(); });
      pill = layer(node);
    }
    pill.onClick = onClick;
    pill.querySelector('span').textContent = label;
    pill.style.top = `${Math.max(4, rect.top + 12)}px`;
    pill.style.left = `${Math.max(4, rect.left + 12)}px`;
  }
  function hidePill() { pill?.remove(); pill = null; }

  // ---------- toast ----------

  let toastEl = null, toastTimer = null;
  function toast(text, ms = 2200) {
    toastEl?.remove();
    clearTimeout(toastTimer);
    const node = el(`<div class="toast"><b>Marginalia</b><span></span></div>`);
    node.querySelector('span').textContent = text;
    toastEl = layer(node);
    toastEl.style.right = '16px';
    toastEl.style.bottom = '16px';
    toastTimer = setTimeout(() => { toastEl?.remove(); toastEl = null; }, ms);
  }

  RW.ui = {
    isOurs, showToolbar, hideToolbar, showPopover, hidePopover, closePopover, prompt,
    showPill, hidePill, toast,
    get toolbarOpen() { return !!bar; },
    get popoverOpen() { return !!pop; },
  };
})();
