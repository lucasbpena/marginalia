// Highlights on the page: restore saved ones, create new ones from the selection,
// edit them in place. Highlighting runs in the top frame only.
(() => {
  const RW = globalThis.RW;
  if (RW.content) return;
  RW.content = true;
  const { api, util, ui, anchoring, store } = RW;
  const isTop = window === window.top;

  let settings = RW.DEFAULTS;
  let pageUrl = util.normalizeUrl(location.href);
  let spaNavigated = false;

  function pageMeta() {
    const q = (s) => document.querySelector(s);
    const meta = (...names) => {
      for (const n of names) {
        const v = q(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`)?.content?.trim();
        if (v) return v;
      }
      return '';
    };
    let title, author, kind = 'article';
    if (util.youtubeId(location.href)) {
      title = q('ytd-watch-metadata h1')?.textContent?.trim() ||
        document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '');
      author = q('ytd-watch-metadata ytd-channel-name a, #owner #channel-name a')?.textContent?.trim() || '';
      kind = 'video';
    } else {
      // og:* tags go stale after client-side navigation; trust document.title then.
      title = (!spaNavigated && meta('og:title', 'twitter:title')) || document.title;
      author = meta('author', 'article:author', 'parsely-author', 'twitter:creator');
      if (/^video/.test(meta('og:type'))) kind = 'video';
    }
    if (/^https?:\/\//.test(author)) author = '';
    return {
      url: pageUrl,
      title: (title || location.href).replace(/\s+/g, ' ').trim().slice(0, 300),
      site: meta('og:site_name') || util.siteName(location.href),
      author: (author || '').slice(0, 200),
      kind,
      favicon: q('link[rel~="icon"]')?.href || `${location.origin}/favicon.ico`,
      published: meta('article:published_time', 'datePublished', 'date').slice(0, 10),
    };
  }
  RW.pageMeta = pageMeta;

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg?.type) {
      case 'page:meta': sendResponse(isTop ? pageMeta() : null); return false;
      case 'page:ping': sendResponse(true); return false;
      case 'toast': ui.toast(msg.text); return false;
      case 'hl:selection': if (isTop) highlightSelection({ withNote: msg.withNote }); return false;
      case 'hl:scroll': if (isTop) scrollTo(msg.id); return false;
    }
    return false;
  });

  if (!isTop) return;

  // ---------- restoring ----------

  let source = null;
  const placed = new Map(); // id -> item as last rendered
  let orphans = [];

  const highlights = (src) => (src?.items || []).filter((i) => i.type === 'highlight' && i.anchor);

  function render() {
    const items = highlights(source);
    const ids = new Set(items.map((i) => i.id));
    for (const id of [...placed.keys()]) {
      if (!ids.has(id)) { anchoring.unwrap(id); placed.delete(id); }
    }
    for (const it of items) {
      if (!placed.has(it.id)) continue;
      const old = placed.get(it.id);
      if (old.color !== it.color || !!old.note !== !!it.note) anchoring.restyle(it);
      placed.set(it.id, it);
    }
    orphans = items.filter((i) => !placed.has(i.id));
    retryOrphans();
  }

  function retryOrphans() {
    if (!orphans.length) return;
    const ok = new Set(anchoring.anchorAll(orphans));
    for (const it of orphans) if (ok.has(it.id)) placed.set(it.id, it);
    orphans = orphans.filter((i) => !ok.has(i.id));
  }

  // Pages that render late (SPAs, lazy sections): retry unplaced highlights after DOM changes.
  let moTimer = null;
  new MutationObserver(() => {
    if (!orphans.length || moTimer) return;
    moTimer = setTimeout(() => { moTimer = null; retryOrphans(); }, 800);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  async function load() {
    source = await store.get(pageUrl);
    render();
  }

  function reset() {
    for (const id of placed.keys()) anchoring.unwrap(id);
    placed.clear();
    orphans = [];
    source = null;
    ui.hideToolbar();
    ui.hidePopover();
  }

  // Client-side navigation (YouTube, SPAs) doesn't reload the content script.
  setInterval(() => {
    const u = util.normalizeUrl(location.href);
    if (u === pageUrl) return;
    reset();
    pageUrl = u;
    spaNavigated = true;
    load();
  }, 1000);

  api.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.settings) settings = { ...RW.DEFAULTS, ...ch.settings.newValue };
    const c = ch[store.sourceKey(pageUrl)];
    if (c) { source = c.newValue || null; render(); }
  });

  // ---------- creating ----------

  function isEditable(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return !!el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  }

  function currentRange() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (isEditable(range.commonAncestorContainer) || !document.body.contains(range.commonAncestorContainer)) return null;
    if (!sel.toString().trim()) return null;
    return range;
  }

  async function highlightSelection({ color, withNote = false } = {}) {
    const range = currentRange();
    ui.hideToolbar();
    if (!range) { ui.toast('Select some text to highlight'); return; }
    const anchor = anchoring.describe(range);
    if (!anchor?.exact.trim()) return;
    const text = getSelection().toString().replace(/[ \t ]+/g, ' ').replace(/ *\n[\s]*\n */g, '\n\n').trim();
    const item = { id: util.uid(), type: 'highlight', text, color: color || settings.defaultColor, anchor };
    getSelection().removeAllRanges();

    // Wrap right away (before the round trip) so the page reacts instantly.
    anchoring.wrapOffsets(anchor.start, anchor.start + anchor.exact.length, item);
    placed.set(item.id, item);
    try {
      await RW.send('addItem', { meta: pageMeta(), item });
    } catch (e) {
      anchoring.unwrap(item.id);
      placed.delete(item.id);
      ui.toast(`Could not save: ${e.message}`);
      return;
    }
    if (withNote) openEditor(item.id, true);
  }

  // ---------- editing ----------

  const itemById = (id) => source?.items.find((i) => i.id === id) || placed.get(id);

  function markdownFor(item) {
    const link = util.textFragmentUrl(pageUrl, item.anchor?.exact || item.text);
    const quote = item.text.split('\n').map((l) => `> ${l}`).join('\n');
    return `${quote}\n>\n> — [${document.title}](${link})${item.note ? `\n\n${item.note}` : ''}`;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  function setFocus(id, on) {
    for (const m of anchoring.marks(id)) m.classList.toggle('rw-focus', on);
  }

  function openEditor(id, focus = false, rect = null) {
    const item = itemById(id);
    const marks = anchoring.marks(id);
    if (!item || !marks.length) return;
    rect ??= marks[marks.length - 1].getBoundingClientRect();
    setFocus(id, true);
    const update = (patch) => RW.send('updateItem', { url: pageUrl, id, patch }).catch((e) => ui.toast(e.message));
    ui.showPopover(rect, item, {
      focus,
      onColor: (color) => update({ color }),
      onNote: (note) => update({ note }),
      onCopy: () => copy(markdownFor(itemById(id) || item)),
      onDelete: () => {
        setFocus(id, false);
        RW.send('deleteItems', { url: pageUrl, ids: [id] }).catch((e) => ui.toast(e.message));
      },
      onClose: () => setFocus(id, false),
    });
  }

  function scrollTo(id) {
    const m = anchoring.marks(id)[0];
    if (!m) return;
    m.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFocus(id, true);
    setTimeout(() => setFocus(id, false), 1600);
  }

  // ---------- selection toolbar & clicks ----------

  function maybeShowToolbar() {
    if (!settings.selectionToolbar) return;
    const range = currentRange();
    if (!range) return ui.hideToolbar();
    const rects = range.getClientRects();
    const rect = rects.length ? rects[0] : range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const box = range.getBoundingClientRect();
    ui.showToolbar({ top: box.top, bottom: box.bottom, left: box.left, width: box.width, height: box.height }, {
      onColor: (color) => highlightSelection({ color }),
      onNote: () => highlightSelection({ withNote: true }),
    });
  }

  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || ui.isOurs(e)) return;
    setTimeout(maybeShowToolbar, 10);
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' && !ui.isOurs(e)) maybeShowToolbar();
  });
  document.addEventListener('selectionchange', () => {
    if (ui.toolbarOpen && getSelection()?.isCollapsed) ui.hideToolbar();
  });
  window.addEventListener('scroll', () => ui.hideToolbar(), { passive: true, capture: true });

  document.addEventListener('mousedown', (e) => {
    if (!ui.isOurs(e) && ui.popoverOpen) ui.closePopover();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || ui.isOurs(e)) return;
    if (ui.popoverOpen) ui.closePopover();
    ui.hideToolbar();
  }, true);

  document.addEventListener('click', (e) => {
    if (ui.isOurs(e) || e.button !== 0) return;
    const mark = e.target.closest?.('rw-hl');
    if (!mark) return;
    if (!getSelection()?.isCollapsed) return;
    // Highlighted links keep working; Alt+click opens the editor on them.
    if (mark.closest('a[href]') && !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    openEditor(mark.dataset.rwId, false, mark.getBoundingClientRect());
  }, true);

  RW.getSettings().then((s) => { settings = s; });
  load();
})();
