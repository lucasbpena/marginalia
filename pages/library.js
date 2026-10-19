(() => {
  const { api, util, store, COLORS } = RW;
  const { h, icon, relTime, hydrateIcons } = RW.page;
  const $ = (id) => document.getElementById(id);
  hydrateIcons();

  const state = {
    view: location.hash === '#archive' ? 'archive' : 'inbox',
    type: 'all',
    q: '',
    editing: 0,
    dirty: false,
  };
  let sources = [];
  let settings = RW.DEFAULTS;

  // ---------- data ----------

  async function reload() {
    [sources, settings] = await Promise.all([store.all(), RW.getSettings()]);
    render();
  }

  let timer = null;
  api.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.editing) state.dirty = true;
      else reload();
    }, 80);
  });

  function matches(src, item, q) {
    if (!q) return true;
    const hay = [item.text, item.note, item.videoTitle].filter(Boolean).join('\n').toLowerCase();
    return hay.includes(q);
  }

  function visible(src) {
    const archived = state.view === 'archive';
    const q = state.q.trim().toLowerCase();
    const srcHit = q && [src.title, src.url, src.site, src.author].filter(Boolean).join('\n').toLowerCase().includes(q);
    return src.items
      .filter((i) => !!i.archivedAt === archived)
      .filter((i) => state.type === 'all' || i.type === state.type)
      .filter((i) => srcHit || matches(src, i, q));
  }

  // ---------- actions ----------

  function banner(text, kind = '') {
    $('banner').hidden = !text;
    $('banner').className = `banner ${kind}`;
    $('banner-text').textContent = text;
  }
  $('banner-close').onclick = () => banner('');

  async function sendSources(urls) {
    if (!urls.length) return banner('Nothing in your inbox to send.');
    if (settings.method === 'uri' && urls.length > 1 &&
        !confirm(`Send ${urls.length} notes? Obsidian will open ${urls.length} obsidian:// links, one every 1.5 s.\n\nTip: the Local REST API method (Settings) sends silently.`)) return;
    banner(`Sending ${urls.length} note${urls.length > 1 ? 's' : ''} to Obsidian…`);
    const results = await RW.obsidian.send(urls, {
      onProgress: (done, total) => total > 1 && banner(`Sending to Obsidian… ${done}/${total}`),
    });
    const ok = results.filter((r) => !r.error);
    const bad = results.filter((r) => r.error);
    const lines = [];
    if (ok.length) {
      const n = ok.reduce((a, r) => a + r.count, 0);
      lines.push(ok.length === 1
        ? `Sent ${n} item${n > 1 ? 's' : ''} to ${ok[0].path} and archived ${n > 1 ? 'them' : 'it'}.`
        : `Sent ${n} items to ${ok.length} notes in ${settings.folder || 'your vault'} and archived them.`);
    }
    for (const r of bad) lines.push(`✗ ${r.title}: ${r.error}`);
    banner(lines.join('\n'), bad.length ? 'error' : 'ok');
  }

  $('send-all').onclick = () => {
    const urls = sources
      .filter((s) => s.items.some((i) => !i.archivedAt))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map((s) => s.url);
    sendSources(urls);
  };

  $('settings').onclick = () => api.runtime.openOptionsPage();

  async function copyMarkdown(src, items) {
    await navigator.clipboard.writeText(RW.obsidian.renderNote(src, items, settings));
    banner(`Copied “${src.title}” as Markdown.`, 'ok');
  }

  function openUrl(src, item) {
    if (item.type === 'highlight') return util.textFragmentUrl(src.url, item.anchor?.exact || item.text);
    if (item.type === 'timestamp') return util.videoUrlAt(item.videoUrl || src.url, item.time);
    return src.url;
  }

  // ---------- note editor ----------

  function editor(initial, onSave, onCancel) {
    const ta = h('textarea', { value: initial || '', placeholder: 'Write a note…' });
    const finish = (save) => {
      state.editing = Math.max(0, state.editing - 1);
      if (save) onSave(ta.value.trim()); else onCancel();
      if (!state.editing && state.dirty) { state.dirty = false; reload(); }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(true);
      if (e.key === 'Escape') finish(false);
    });
    const box = h('div.editor', {},
      ta,
      h('div.row', {},
        h('span.muted.small.grow', {}, 'Ctrl+Enter to save · Esc to cancel'),
        h('button.ghost', { onclick: () => finish(false) }, 'Cancel'),
        h('button.primary', { onclick: () => finish(true) }, 'Save')));
    state.editing++;
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    return box;
  }

  // ---------- rendering ----------

  function itemRow(src, item) {
    const archived = !!item.archivedAt;
    const main = h('div.item-main');
    const update = (patch) => RW.send('updateItem', { url: src.url, id: item.id, patch });

    let noteSlot = null;
    const startEdit = () => {
      const target = noteSlot || main;
      const box = editor(item.note,
        (note) => { update({ note }); },
        () => { box.replaceWith(noteView()); });
      if (noteSlot) { noteSlot.replaceWith(box); noteSlot = null; } else target.append(box);
    };
    const noteView = () => {
      noteSlot = item.note
        ? h(item.type === 'note' ? 'div.page-note' : 'div.note', { title: 'Click to edit', onclick: startEdit }, item.note)
        : h('span', { hidden: true });
      return noteSlot;
    };

    if (item.type === 'highlight') {
      main.append(h('blockquote.hl', { style: { borderLeftColor: COLORS[item.color] || COLORS.yellow } }, item.text));
    } else if (item.type === 'timestamp') {
      const other = util.canonicalVideoUrl(item.videoUrl || src.url) !== src.url;
      main.append(h('div.ts-row', {},
        h('a.time-badge', { href: util.videoUrlAt(item.videoUrl || src.url, item.time), target: '_blank', title: 'Open at this moment' },
          icon('play'), util.formatTime(item.time)),
        other && item.videoTitle ? h('span.video-title', {}, item.videoTitle) : null,
        item.duration ? h('span.video-title', {}, `of ${util.formatTime(item.duration)}`) : null));
    } else if (item.type === 'bookmark') {
      main.append(h('div.kind-row', {}, icon('bookmark'), 'Saved page'));
    }
    main.append(noteView());

    const act = (name, title, onclick, cls = '') => h(`button.ghost.icon${cls}`, { title, onclick }, icon(name));
    const actions = h('div.item-actions', {},
      act('external', 'Open', () => api.tabs.create({ url: openUrl(src, item) })),
      act('edit', item.note ? 'Edit note' : 'Add note', startEdit),
      archived
        ? act('inbox', 'Move to inbox', () => RW.send('archive', { url: src.url, ids: [item.id], archived: false }))
        : act('archive', 'Archive without sending', () => RW.send('archive', { url: src.url, ids: [item.id], archived: true })),
      act('trash', 'Delete', () => RW.send('deleteItems', { url: src.url, ids: [item.id] }), '.danger'));

    return h('li.item', {},
      main,
      h('div.item-side', {},
        actions,
        item.exportedAt ? h('span.tag', { title: `Sent ${new Date(item.exportedAt).toLocaleString()}` }, icon('check'), 'sent') : null,
        h('time', { title: new Date(item.createdAt).toLocaleString() }, relTime(item.createdAt))));
  }

  function counts(items) {
    const n = (t) => items.filter((i) => i.type === t).length;
    const parts = [];
    const add = (c, one, many) => c && parts.push(`${c} ${c > 1 ? many : one}`);
    add(n('highlight'), 'highlight', 'highlights');
    add(n('timestamp'), 'timestamp', 'timestamps');
    add(n('note'), 'note', 'notes');
    return parts.join(' · ');
  }

  function card(src, items) {
    const inbox = state.view === 'inbox';
    const ids = items.map((i) => i.id);
    const favicon = h('img.favicon', { src: src.favicon || '../icons/icon16.png', alt: '' });
    favicon.onerror = () => { favicon.src = '../icons/icon16.png'; };

    const actions = h('div.card-actions', {},
      inbox
        ? h('button.primary', { title: 'Send these items to Obsidian and archive them', onclick: () => sendSources([src.url]) }, icon('send'), 'Send')
        : h('button', { onclick: () => RW.send('archive', { url: src.url, ids, archived: false }) }, icon('inbox'), 'Move to inbox'),
      inbox ? h('button.ghost.icon', { title: 'Archive without sending', onclick: () => RW.send('archive', { url: src.url, ids, archived: true }) }, icon('archive')) : null,
      h('button.ghost.icon', { title: 'Copy as Markdown', onclick: () => copyMarkdown(src, items) }, icon('copy')),
      h('button.ghost.icon', {
        title: 'Rename',
        onclick: () => {
          const title = prompt('Title (also the Obsidian file name):', src.title);
          if (title?.trim()) RW.send('patchSource', { url: src.url, patch: { title: title.trim() } });
        },
      }, icon('edit')),
      h('button.ghost.icon.danger', {
        title: 'Delete this page and all its items',
        onclick: () => confirm(`Delete “${src.title}” and its ${src.items.length} item(s)?`) && RW.send('deleteSource', { url: src.url }),
      }, icon('trash')));

    const metaBits = [
      h('span', {}, src.site || util.siteName(src.url)),
      src.author ? h('span', {}, src.author) : null,
      counts(items) ? h('span', {}, counts(items)) : null,
      src.export?.path ? h('span.path', { title: `Last sent ${new Date(src.export.at).toLocaleString()}` }, `→ ${src.export.path}`) : null,
    ];

    return h('article.card', {},
      h('header.card-head', {},
        favicon,
        h('div.grow', {},
          h('a.card-title', { href: src.url, target: '_blank' }, src.title || src.url),
          h('div.meta', {}, metaBits)),
        actions),
      h('ul.items', {}, items.map((i) => itemRow(src, i))));
  }

  function render() {
    const inboxN = sources.reduce((a, s) => a + s.items.filter((i) => !i.archivedAt).length, 0);
    const archN = sources.reduce((a, s) => a + s.items.filter((i) => i.archivedAt).length, 0);
    $('n-inbox').textContent = inboxN || '';
    $('n-archive').textContent = archN || '';
    $('send-all').disabled = !inboxN;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
    document.querySelectorAll('.chips button').forEach((b) => b.classList.toggle('on', b.dataset.type === state.type));

    const rows = sources
      .map((src) => ({ src, items: visible(src) }))
      .filter((r) => r.items.length)
      .map((r) => {
        r.items.sort((a, b) =>
          a.type === 'highlight' && b.type === 'highlight'
            ? (a.anchor?.start ?? 0) - (b.anchor?.start ?? 0)
            : a.type === 'timestamp' && b.type === 'timestamp' ? a.time - b.time : a.createdAt - b.createdAt);
        r.latest = Math.max(...r.items.map((i) => (state.view === 'archive' ? i.archivedAt : i.createdAt) || 0));
        return r;
      })
      .sort((a, b) => b.latest - a.latest);

    $('list').replaceChildren(...rows.map((r) => card(r.src, r.items)));
    const empty = !rows.length;
    $('empty').hidden = !empty;
    if (empty) {
      const searching = state.q.trim() || state.type !== 'all';
      $('empty-icon').replaceChildren(icon(searching ? 'search' : state.view === 'inbox' ? 'highlight' : 'archive'));
      $('empty-title').textContent = searching ? 'No matches' : state.view === 'inbox' ? 'Your inbox is empty' : 'Nothing archived yet';
      $('empty-text').textContent = searching
        ? 'Try another search or filter.'
        : state.view === 'inbox'
          ? 'Select text on any page to highlight it, or hover a video and click the bookmark pill (Alt+Shift+Y). Everything lands here until you send it to Obsidian.'
          : 'Items you send to Obsidian, or archive by hand, end up here.';
    }
  }

  // ---------- controls ----------

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    history.replaceState(null, '', state.view === 'archive' ? '#archive' : '#');
    render();
  });
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    state.type = b.dataset.type;
    render();
  });
  $('q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) { e.preventDefault(); $('q').focus(); }
  });

  reload();
})();
