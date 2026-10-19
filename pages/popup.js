(async () => {
  const { api, util, store, COLORS } = RW;
  const { h, icon, hydrateIcons } = RW.page;
  const $ = (id) => document.getElementById(id);
  hydrateIcons();

  $('open-library').onclick = () => { api.tabs.create({ url: api.runtime.getURL('pages/library.html') }); window.close(); };
  $('open-settings').onclick = () => { api.runtime.openOptionsPage(); window.close(); };

  // popup.html?tab=<id> opens the popup for a given tab (handy for debugging it in a full tab).
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const [tab] = forced
    ? [await api.tabs.get(forced)]
    : await api.tabs.query({ active: true, currentWindow: true });
  $('title').textContent = tab?.title || '';
  $('site').textContent = util.siteName(tab?.url || '');
  $('favicon').src = tab?.favIconUrl || '../icons/icon16.png';
  $('favicon').onerror = () => { $('favicon').src = '../icons/icon16.png'; };

  if (!tab || !util.isWebUrl(tab.url)) {
    $('unsupported').hidden = false;
    $('main').hidden = true;
    return;
  }

  const CONTENT_JS = ['lib/core.js', 'content/anchoring.js', 'content/ui.js', 'content/video.js', 'content/content.js'];
  const msg = (m, frameId = 0) => api.tabs.sendMessage(tab.id, m, { frameId });

  // Tabs opened before the extension was installed/reloaded have no content script yet.
  async function ensureContent() {
    try { if (await msg({ type: 'page:ping' })) return true; } catch {}
    try {
      await api.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ['content/content.css'] });
      await api.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_JS });
      return true;
    } catch {
      return false;
    }
  }

  const ready = await ensureContent();
  let meta = null;
  if (ready) meta = await msg({ type: 'page:meta' }).catch(() => null);
  meta ||= { url: util.normalizeUrl(tab.url), title: tab.title, site: util.siteName(tab.url), favicon: tab.favIconUrl };
  const pageUrl = meta.url;
  $('title').textContent = meta.title;
  $('site').textContent = [meta.site, meta.author].filter(Boolean).join(' · ');

  function status(text, kind = '') {
    $('status').textContent = text;
    $('status').className = `status ${kind}`;
  }

  // ---------- video ----------

  let video = null;
  async function probe() {
    try {
      const res = await api.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: util.probeVideo });
      video = res.filter((r) => r.result).map((r) => ({ ...r.result, frameId: r.frameId })).sort((a, b) => b.score - a.score)[0] || null;
    } catch {
      video = null;
    }
    $('video').hidden = !video;
    if (!video) return;
    $('video-time').replaceChildren(icon('play'), util.formatTime(video.time) + (video.duration ? ` / ${util.formatTime(video.duration)}` : ''));
    $('video-title').textContent = video.frameId ? video.title : video.paused ? 'Paused' : 'Playing';
  }
  await probe();
  setInterval(probe, 1000);

  $('video-add').onclick = async () => {
    if (!video) return;
    const note = $('video-note').value.trim();
    const res = await msg({ type: 'video:bookmark', note }, video.frameId).catch(() => null);
    if (res?.item) {
      $('video-note').value = '';
      status(`Bookmarked ${util.formatTime(res.item.time)}`, 'ok');
    } else status('Could not bookmark this video. Try reloading the page.', 'error');
  };
  $('video-note').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('video-add').click(); }
  });

  // ---------- page actions ----------

  $('save-page').onclick = async () => {
    const r = await RW.send('savePage', { tabId: tab.id });
    status(r.existed ? 'Already in your inbox' : 'Page saved to your inbox', 'ok');
  };

  $('add-note').onclick = () => {
    $('note-box').hidden = !$('note-box').hidden;
    if (!$('note-box').hidden) $('note-text').focus();
  };
  $('note-cancel').onclick = () => { $('note-box').hidden = true; };
  $('note-save').onclick = async () => {
    const note = $('note-text').value.trim();
    if (!note) return;
    await RW.send('addItem', { meta, item: { type: 'note', note } });
    $('note-text').value = '';
    $('note-box').hidden = true;
  };
  $('note-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('note-save').click();
  });

  // ---------- items on this page ----------

  function row(item) {
    const archived = !!item.archivedAt;
    let lead, text;
    if (item.type === 'highlight') {
      lead = h('span.bar', { style: { background: COLORS[item.color] || COLORS.yellow } });
      text = item.text;
    } else if (item.type === 'timestamp') {
      lead = h('span.time-badge', {}, icon('play'), util.formatTime(item.time));
      text = item.note || (item.videoTitle && util.canonicalVideoUrl(item.videoUrl) !== pageUrl ? item.videoTitle : '');
    } else {
      lead = h('span.kind', {}, icon(item.type === 'note' ? 'note' : 'bookmark'));
      text = item.type === 'note' ? item.note : 'Saved page';
    }
    const note = item.type === 'highlight' || item.type === 'bookmark' ? item.note : '';
    const del = h('button.ghost.icon.del.danger', {
      title: 'Delete',
      onclick: (e) => { e.stopPropagation(); RW.send('deleteItems', { url: pageUrl, ids: [item.id] }); },
    }, icon('trash'));
    return h('li', {
      className: archived ? 'archived' : '',
      title: archived ? 'Sent to Obsidian / archived' : '',
      onclick: () => {
        if (item.type === 'highlight') msg({ type: 'hl:scroll', id: item.id }).catch(() => {});
        else if (item.type === 'timestamp') msg({ type: 'video:seek', time: item.time }, video?.frameId ?? 0).catch(() => {});
      },
    },
    lead,
    h('div.body', {},
      text ? h('div.text', {}, text) : null,
      note ? h('div.note', {}, note) : null,
      archived ? h('span.tag', {}, icon('check'), item.exportedAt ? 'sent' : 'archived') : null),
    del);
  }

  async function renderList() {
    const src = await store.get(pageUrl);
    const items = [...(src?.items || [])].sort((a, b) => b.createdAt - a.createdAt);
    const fresh = items.filter((i) => !i.archivedAt).length;
    $('items').replaceChildren(...items.map(row));
    $('empty').hidden = items.length > 0;
    $('count').textContent = items.length ? `${items.length} item${items.length > 1 ? 's' : ''} · ${fresh} unsent` : '';
    const btn = $('send');
    btn.disabled = !fresh;
    btn.lastChild.textContent = fresh ? `Send to Obsidian (${fresh})` : 'Nothing new to send';
  }
  renderList();
  api.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch[store.sourceKey(pageUrl)]) renderList();
  });

  $('send').onclick = async () => {
    status('Sending…');
    const [r] = await RW.obsidian.send([pageUrl], { tabId: tab.id });
    if (!r) status('Nothing to send');
    else if (r.error) status(r.error, 'error');
    else status(`Sent to ${r.path}`, 'ok');
  };
})();
