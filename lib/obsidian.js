// Markdown rendering and delivery to Obsidian (extension pages only).
//   uri  → obsidian://new (no setup; Obsidian opens the link)
//   rest → Local REST API community plugin (silent, reliable for bulk sends)
// Every item that gets sent is archived.
(() => {
  const RW = globalThis.RW;
  if (RW.obsidian) return;
  const { api, util } = RW;

  const pad = (n) => String(n).padStart(2, '0');
  function stamp(ts, time = true) {
    const d = new Date(ts);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return time ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
  }

  const yaml = (s) => JSON.stringify(String(s ?? '')); // a JSON string is a valid YAML scalar
  const target = (u) => u.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  // Quoted text must not turn into vault tags.
  const escapeTags = (s) => s.replace(/(^|[\s(])#(?=[\p{L}\p{N}_/-])/gu, '$1\\#');

  function bullet(text, depth = 0) {
    const ind = '\t'.repeat(depth);
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l, i) => (i ? `${ind}  ` : `${ind}- `) + l.trim())
      .join('\n');
  }

  function highlightMd(item, src) {
    const link = target(util.textFragmentUrl(src.url, item.anchor?.exact || item.text));
    let md = bullet(`${escapeTags(item.text)} ([↗](${link}))`);
    if (item.note?.trim()) md += '\n' + bullet(item.note, 1);
    return md;
  }

  function timestampMd(item, src) {
    const video = item.videoUrl || src.url;
    const link = target(util.videoUrlAt(video, item.time));
    const other = util.canonicalVideoUrl(video) !== src.url && item.videoTitle ? ` *${item.videoTitle}*` : '';
    const [first = '', ...rest] = (item.note || '').trim().split('\n');
    return `- [${util.formatTime(item.time)}](${link})${other}${first ? ` ${first}` : ''}` +
      rest.filter((l) => l.trim()).map((l) => `\n  ${l.trim()}`).join('');
  }

  function sections(items, src, h = '##') {
    const notes = items
      .filter((i) => (i.type === 'note' || i.type === 'bookmark') && i.note?.trim())
      .sort((a, b) => a.createdAt - b.createdAt);
    const hls = items
      .filter((i) => i.type === 'highlight')
      .sort((a, b) => (a.anchor?.start ?? 0) - (b.anchor?.start ?? 0) || a.createdAt - b.createdAt);
    const ts = items
      .filter((i) => i.type === 'timestamp')
      .sort((a, b) => (a.videoUrl || '').localeCompare(b.videoUrl || '') || a.time - b.time);
    const out = [];
    if (notes.length) out.push(`${h} Notes\n\n${notes.map((n) => bullet(n.note)).join('\n')}`);
    if (hls.length) out.push(`${h} Highlights\n\n${hls.map((i) => highlightMd(i, src)).join('\n')}`);
    if (ts.length) out.push(`${h} Timestamps\n\n${ts.map((i) => timestampMd(i, src)).join('\n')}`);
    return out.join('\n\n');
  }

  function tagList(s) {
    return s.tags.split(/[,\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
  }

  function renderNote(src, items, s) {
    const tags = tagList(s);
    const fm = ['---', `created: ${stamp(Date.now())}`];
    fm.push(tags.length ? `tags:\n${tags.map((t) => `  - ${t}`).join('\n')}` : 'tags: []');
    fm.push(`title: ${yaml(src.title)}`);
    if (src.author) fm.push(`author: ${yaml(src.author)}`);
    fm.push(`site: ${yaml(src.site)}`, `url: ${yaml(src.url)}`, `type: ${src.kind === 'video' ? 'video' : 'article'}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(src.published || '')) fm.push(`published: ${src.published}`);
    fm.push('---');

    const by = src.author ? ` · ${src.author}` : '';
    const head = [`[${src.site || util.siteName(src.url)}](${target(src.url)})${by}`];
    if (util.youtubeId(src.url)) head.push(`![](${src.url})`); // Obsidian embeds YouTube players
    const body = sections(items, src);
    return `${fm.join('\n')}\n\n${head.join('\n\n')}\n${body ? `\n${body}\n` : ''}`;
  }

  function renderAppend(src, items) {
    const d = new Date();
    const when = `${stamp(d, false)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `\n\n## Added ${when}\n\n${sections(items, src, '###') || '- (bookmark)'}\n`;
  }

  function sanitize(name) {
    return name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120).trim() || 'Untitled';
  }

  function filePath(src, s) {
    const vars = {
      title: src.title || src.site || 'Untitled',
      site: src.site || '',
      author: src.author || '',
      date: stamp(Date.now(), false),
    };
    const name = sanitize(s.filename.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? ''));
    const folder = s.folder.split('/').map((p) => p.trim()).filter(Boolean).join('/');
    return `${folder ? `${folder}/` : ''}${name}.md`;
  }

  // ---------- delivery ----------

  async function launch(uri, tabId) {
    tabId ??= (await api.tabs.getCurrent())?.id;
    try {
      await api.tabs.update(tabId, { url: uri });
    } catch {
      location.href = uri;
    }
  }

  async function viaUri(src, items, s, tabId) {
    const append = !!src.export?.path;
    const path = src.export?.path || filePath(src, s);
    const content = append ? renderAppend(src, items) : renderNote(src, items, s);
    const enc = encodeURIComponent;
    let uri = `obsidian://new?vault=${enc(s.vault)}&file=${enc(path.replace(/\.md$/, ''))}`;
    if (append) uri += '&append=true';
    if (!s.openAfterSend) uri += '&silent=true';
    const encoded = enc(content);
    // Long notes overflow the command line handed to Obsidian; pass them via the clipboard.
    if (uri.length + encoded.length > 30000) {
      await navigator.clipboard.writeText(content);
      uri += '&clipboard=true';
    } else {
      uri += `&content=${encoded}`;
    }
    // Archive first: the popup closes as soon as Obsidian takes focus.
    await RW.send('markExported', { url: src.url, ids: items.map((i) => i.id), path });
    await launch(uri, tabId);
    return path;
  }

  function rest(s) {
    const base = s.restUrl.trim().replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${s.restKey.trim()}` };
    const fileUrl = (p) => `${base}/vault/${p.split('/').map(encodeURIComponent).join('/')}`;
    const call = async (url, init = {}) => {
      try {
        return await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
      } catch {
        throw new Error(`Can't reach Obsidian at ${base}. Is Obsidian open with the Local REST API plugin enabled?`);
      }
    };
    return { base, fileUrl, call };
  }

  async function viaRest(src, items, s) {
    const { base, fileUrl, call } = rest(s);
    const first = src.export?.path || filePath(src, s);
    let path = first, append = false;
    for (let n = 2; ; n++) {
      const r = await call(fileUrl(path));
      if (r.status === 404) break;
      if (r.status === 401 || r.status === 403) throw new Error('The Local REST API rejected the API key (check Settings).');
      if (!r.ok) throw new Error(`Local REST API error ${r.status}`);
      // Same note from an earlier send → append; an unrelated note with that name → pick another name.
      if ((await r.text()).includes(src.url)) { append = true; break; }
      if (n > 50) throw new Error('No free file name');
      path = first.replace(/\.md$/, ` ${n}.md`);
    }
    const body = append ? renderAppend(src, items) : renderNote(src, items, s);
    const r = await call(fileUrl(path), {
      method: append ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body,
    });
    if (!r.ok) throw new Error(`Local REST API error ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await RW.send('markExported', { url: src.url, ids: items.map((i) => i.id), path });
    if (s.openAfterSend) {
      call(`${base}/open/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST' }).catch(() => {});
    }
    return path;
  }

  // Send the inbox items of each source. Returns one result per source that had something to send.
  async function send(urls, { tabId, onProgress } = {}) {
    const s = await RW.getSettings();
    const results = [];
    const todo = [];
    for (const url of urls) {
      const src = await RW.store.get(url);
      const items = (src?.items || []).filter((i) => !i.archivedAt);
      if (items.length) todo.push({ src, items });
    }
    for (const [i, { src, items }] of todo.entries()) {
      try {
        const path = s.method === 'rest' ? await viaRest(src, items, s) : await viaUri(src, items, s, tabId);
        results.push({ url: src.url, title: src.title, path, count: items.length });
      } catch (e) {
        results.push({ url: src.url, title: src.title, error: e.message });
        if (/reach Obsidian|API key/.test(e.message)) break;
      }
      onProgress?.(i + 1, todo.length);
      // obsidian:// launches in quick succession get dropped; space them out.
      if (s.method === 'uri' && i < todo.length - 1) await new Promise((r) => setTimeout(r, 1500));
    }
    return results;
  }

  async function testRest(s) {
    const { base, call } = rest(s);
    const r = await call(`${base}/`);
    const info = await r.json().catch(() => ({}));
    if (!info.authenticated) return { ok: false, message: 'Connected, but the API key is missing or wrong.' };
    return { ok: true, message: `Connected to ${info.service || 'Local REST API'}${info.versions?.self ? ` ${info.versions.self}` : ''}.` };
  }

  RW.obsidian = { renderNote, renderAppend, filePath, send, testRest, stamp };
})();
