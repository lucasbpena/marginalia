// Chromium runs this as a service worker; Firefox loads it after lib/core.js as an event page.
if (typeof importScripts === 'function') importScripts('lib/core.js');

(() => {
  const { api, util, store } = RW;

  // ---------- storage (serialized read-modify-write) ----------

  let chain = Promise.resolve();
  function locked(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  async function put(src) {
    src.updatedAt = Date.now();
    await api.storage.local.set({ [store.sourceKey(src.url)]: src });
    return src;
  }

  function applyMeta(src, meta) {
    for (const k of ['title', 'site', 'author', 'kind', 'favicon', 'published']) {
      if (!meta[k]) continue;
      if (k === 'title' && src.titleEdited) continue;
      src[k] = meta[k];
    }
  }

  // Metadata of the top page in a tab, asked from its content script when possible.
  async function topMeta(tab) {
    try {
      const m = await api.tabs.sendMessage(tab.id, { type: 'page:meta' }, { frameId: 0 });
      if (m?.url) return m;
    } catch {}
    return {
      url: util.normalizeUrl(tab.url),
      title: tab.title || tab.url,
      site: util.siteName(tab.url),
      favicon: tab.favIconUrl || '',
      kind: util.youtubeId(tab.url) ? 'video' : 'article',
    };
  }

  const ops = {
    async addItem({ meta, item }, sender) {
      // Items created inside an iframe belong to the page the user is on.
      if (sender?.tab && (!meta || sender.frameId)) meta = await topMeta(sender.tab);
      if (!meta?.url) throw new Error('Missing page');
      if (sender?.tab?.favIconUrl && !sender.frameId) meta.favicon = sender.tab.favIconUrl;
      return locked(async () => {
        const src = (await store.get(meta.url)) || {
          url: meta.url,
          createdAt: Date.now(),
          items: [],
          export: null,
        };
        applyMeta(src, meta);
        if (item.type === 'bookmark') {
          const open = src.items.find((i) => i.type === 'bookmark' && !i.archivedAt);
          if (open) return { item: open, url: src.url, existed: true };
        }
        const it = {
          id: util.uid(),
          note: '',
          createdAt: Date.now(),
          archivedAt: null,
          exportedAt: null,
          ...item,
        };
        src.items.push(it);
        await put(src);
        return { item: it, url: src.url };
      });
    },

    updateItem({ url, id, patch }) {
      return locked(async () => {
        const src = await store.get(url);
        const it = src?.items.find((i) => i.id === id);
        if (!it) throw new Error('Item not found');
        const { id: _id, ...rest } = patch;
        Object.assign(it, rest, { updatedAt: Date.now() });
        await put(src);
        return it;
      });
    },

    deleteItems({ url, ids }) {
      return locked(async () => {
        const src = await store.get(url);
        if (!src) return null;
        src.items = src.items.filter((i) => !ids.includes(i.id));
        if (!src.items.length) {
          await api.storage.local.remove(store.sourceKey(url));
          return null;
        }
        return put(src);
      });
    },

    // ids omitted → every item of the source.
    archive({ url, ids, archived }) {
      return locked(async () => {
        const src = await store.get(url);
        if (!src) return null;
        for (const it of src.items) {
          if (ids && !ids.includes(it.id)) continue;
          it.archivedAt = archived ? it.archivedAt || Date.now() : null;
        }
        return put(src);
      });
    },

    markExported({ url, ids, path }) {
      return locked(async () => {
        const src = await store.get(url);
        if (!src) return null;
        const now = Date.now();
        for (const it of src.items) {
          if (!ids.includes(it.id)) continue;
          it.archivedAt = now;
          it.exportedAt = now;
        }
        src.export = { path, at: now };
        return put(src);
      });
    },

    patchSource({ url, patch }) {
      return locked(async () => {
        const src = await store.get(url);
        if (!src) throw new Error('Source not found');
        if ('title' in patch) {
          src.title = patch.title;
          src.titleEdited = true;
        }
        if ('export' in patch) src.export = patch.export;
        return put(src);
      });
    },

    deleteSource({ url }) {
      return locked(() => api.storage.local.remove(store.sourceKey(url)));
    },

    // Merge a JSON backup: sources by URL, items by id (newest update wins).
    importData({ sources }) {
      return locked(async () => {
        let added = 0;
        for (const inc of sources || []) {
          if (!inc?.url || !Array.isArray(inc.items)) continue;
          const cur = await store.get(inc.url);
          if (!cur) {
            await api.storage.local.set({ [store.sourceKey(inc.url)]: inc });
            added += inc.items.length;
            continue;
          }
          const byId = new Map(cur.items.map((i) => [i.id, i]));
          for (const it of inc.items) {
            const mine = byId.get(it.id);
            if (!mine) added++;
            if (!mine || (it.updatedAt || it.createdAt) > (mine.updatedAt || mine.createdAt)) byId.set(it.id, it);
          }
          cur.items = [...byId.values()];
          await put(cur);
        }
        return { added };
      });
    },

    async savePage({ tabId }, sender) {
      const tab = tabId != null ? await api.tabs.get(tabId) : sender.tab;
      return ops.addItem({ meta: await topMeta(tab), item: { type: 'bookmark' } }, {});
    },
  };

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const op = ops[msg?.type];
    if (!op) return false;
    Promise.resolve()
      .then(() => op(msg, sender))
      .then(
        (result) => sendResponse({ ok: true, result }),
        (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
      );
    return true;
  });

  // ---------- tab helpers ----------

  function toast(tabId, text) {
    api.tabs.sendMessage(tabId, { type: 'toast', text }, { frameId: 0 }).catch(() => {});
  }

  // The frame holding the most relevant video (playing beats paused, bigger beats smaller).
  async function findVideoFrame(tabId) {
    let results;
    try {
      results = await api.scripting.executeScript({ target: { tabId, allFrames: true }, func: util.probeVideo });
    } catch {
      return null;
    }
    return results
      .filter((r) => r.result)
      .map((r) => ({ ...r.result, frameId: r.frameId }))
      .sort((a, b) => b.score - a.score)[0] || null;
  }

  async function bookmarkVideo(tab) {
    const best = await findVideoFrame(tab.id);
    if (!best) return toast(tab.id, 'No video found on this page');
    api.tabs.sendMessage(tab.id, { type: 'video:bookmark', prompt: true }, { frameId: best.frameId }).catch(() => {
      toast(tab.id, 'Reload the page to bookmark this video');
    });
  }

  function highlight(tab, frameId, withNote) {
    api.tabs.sendMessage(tab.id, { type: 'hl:selection', withNote }, { frameId: frameId || 0 }).catch(() => {});
  }

  // ---------- context menus & shortcuts ----------

  api.runtime.onInstalled.addListener(async () => {
    await api.contextMenus.removeAll();
    const menu = (id, title, contexts, extra = {}) => api.contextMenus.create({ id, title, contexts, ...extra });
    menu('rw-highlight', 'Highlight selection', ['selection']);
    menu('rw-highlight-note', 'Highlight with note…', ['selection']);
    menu('rw-video', 'Bookmark video timestamp', ['video']);
    menu('rw-video-page', 'Bookmark video timestamp', ['page'], {
      documentUrlPatterns: ['*://*.youtube.com/*', '*://*.vimeo.com/*'],
    });
    menu('rw-save', 'Save page to Marginalia', ['page']);
    menu('rw-library', 'Open library', ['action']);
  });

  api.contextMenus.onClicked.addListener(async (info, tab) => {
    switch (info.menuItemId) {
      case 'rw-highlight': return highlight(tab, info.frameId, false);
      case 'rw-highlight-note': return highlight(tab, info.frameId, true);
      case 'rw-video':
      case 'rw-video-page': return bookmarkVideo(tab);
      case 'rw-save': {
        const r = await ops.savePage({ tabId: tab.id }, {});
        return toast(tab.id, r.existed ? 'Page already in your inbox' : 'Page saved to inbox');
      }
      case 'rw-library': return api.tabs.create({ url: api.runtime.getURL('pages/library.html') });
    }
  });

  api.commands.onCommand.addListener(async (command, tab) => {
    tab ??= (await api.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab) return;
    if (command === 'highlight-selection') highlight(tab, 0, false);
    else if (command === 'highlight-note') highlight(tab, 0, true);
    else if (command === 'bookmark-video') bookmarkVideo(tab);
  });

  // ---------- badge: number of items on the current page ----------

  async function updateBadge(tab) {
    if (!tab?.id || !util.isWebUrl(tab.url)) return;
    const src = await store.get(util.normalizeUrl(tab.url));
    const n = src?.items.length || 0;
    api.action.setBadgeBackgroundColor?.({ tabId: tab.id, color: '#7c5cff' });
    api.action.setBadgeText({ tabId: tab.id, text: n ? String(n) : '' });
  }

  async function updateActiveBadge() {
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    updateBadge(tab);
  }

  api.tabs.onActivated.addListener(updateActiveBadge);
  api.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url || change.status === 'complete') updateBadge(tab);
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('src:'))) updateActiveBadge();
  });
})();
