(async () => {
  const { api, store, COLORS } = RW;
  const { h, hydrateIcons } = RW.page;
  const $ = (id) => document.getElementById(id);
  hydrateIcons();

  let s = await RW.getSettings();
  const TEXT = ['vault', 'folder', 'filename', 'tags', 'restUrl', 'restKey'];
  const BOOL = ['openAfterSend', 'selectionToolbar', 'videoButton', 'pauseOnNote', 'markers', 'markerOutline', 'markerLabels'];
  const RANGES = {
    pillSize: (v) => `${v}×`,
    markerSize: (v) => `${v}×`,
    markerOpacity: (v) => `${Math.round(v * 100)}%`,
  };
  const MARKER_KEYS = ['markers', 'markerColor', 'markerShape', 'markerSize', 'markerOpacity', 'markerOutline', 'markerLabels'];

  let savedTimer = null;
  async function save(patch) {
    s = { ...s, ...patch };
    await api.storage.local.set({ settings: s });
    $('saved').textContent = 'Saved';
    $('saved').classList.add('on');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $('saved').classList.remove('on'), 1200);
    sync();
  }

  // Sliders and the color picker fire continuously: update the preview now, write once they settle.
  let soonTimer = null;
  function saveSoon(patch) {
    s = { ...s, ...patch };
    sync();
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => save({}), 200);
  }

  function sync() {
    document.querySelectorAll('[data-method]').forEach((el) => { el.hidden = el.dataset.method !== s.method; });
    document.querySelectorAll('#colors button').forEach((b) => b.classList.toggle('on', b.dataset.color === s.defaultColor));
    for (const k of BOOL) $(k).checked = !!s[k];
    for (const [k, fmt] of Object.entries(RANGES)) {
      $(k).value = s[k];
      $(`${k}-val`).textContent = fmt(Number(s[k]));
    }
    for (const id of ['pillPosition', 'markerShape']) {
      document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.value === s[id]));
    }
    const custom = !RW.MARKER_COLORS.includes(s.markerColor.toLowerCase());
    document.querySelectorAll('#marker-colors button').forEach((b) => b.classList.toggle('on', b.dataset.hex === s.markerColor.toLowerCase()));
    $('markerColor').classList.toggle('on', custom);
    $('markerColor').value = s.markerColor;
    renderMarkerPreview();
    renderPreview();
  }

  // ---------- fields ----------

  for (const r of document.querySelectorAll('input[name="method"]')) {
    r.checked = r.value === s.method;
    r.addEventListener('change', () => r.checked && save({ method: r.value }));
  }
  for (const k of TEXT) {
    $(k).value = s[k];
    $(k).addEventListener('input', () => save({ [k]: $(k).value }));
  }
  for (const k of BOOL) {
    $(k).checked = !!s[k];
    $(k).addEventListener('change', () => save({ [k]: $(k).checked }));
  }
  $('colors').append(...Object.entries(COLORS).map(([name, hex]) =>
    h('button', { dataset: { color: name }, title: name, style: { background: hex }, onclick: () => save({ defaultColor: name }) })));

  // ---------- video button & timeline markers ----------

  for (const k of Object.keys(RANGES)) {
    $(k).addEventListener('input', () => saveSoon({ [k]: Number($(k).value) }));
  }
  $('pillPosition').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (b) save({ pillPosition: b.dataset.value });
  });
  $('markerShape').append(...RW.MARKER_SHAPES.map((shape) =>
    h('button', { dataset: { value: shape }, onclick: () => save({ markerShape: shape }) },
      h('span.shape', {}, h('i')),
      shape[0].toUpperCase() + shape.slice(1))));
  $('marker-colors').prepend(...RW.MARKER_COLORS.map((hex) =>
    h('button', { dataset: { hex }, title: hex, style: { background: hex }, onclick: () => save({ markerColor: hex }) })));
  $('markerColor').addEventListener('input', () => saveSoon({ markerColor: $('markerColor').value }));
  $('reset-markers').onclick = () => save(Object.fromEntries(MARKER_KEYS.map((k) => [k, RW.DEFAULTS[k]])));

  const SAMPLE_MARKS = [
    { at: 0.14, time: 73, note: 'Problem statement' },
    { at: 0.46, time: 241, note: 'Key definition of entropy' },
    { at: 0.79, time: 412, note: '' },
  ];

  function showSampleTip(m) {
    const tip = $('pv-tip');
    tip.querySelector('b').textContent = RW.util.formatTime(m.time);
    tip.querySelector('span').textContent = m.note;
    tip.style.left = `calc(16px + (100% - 32px) * ${m.at})`;
    tip.hidden = false;
  }

  function renderMarkerPreview() {
    $('player').classList.toggle('off', !s.markers);
    const pill = $('pv-pill');
    pill.hidden = !s.videoButton;
    pill.style.setProperty('--s', String(s.pillSize));
    pill.classList.toggle('left', s.pillPosition !== 'top-right');
    pill.classList.toggle('right', s.pillPosition === 'top-right');
    $('pv-tip').hidden = true;
    $('pv-marks').replaceChildren(...SAMPLE_MARKS.map((m) => {
      const label = RW.util.formatTime(m.time) + (m.note ? ` · ${m.note}` : '');
      const mark = h('i', { title: s.markerLabels ? null : label });
      mark.style.left = `${m.at * 100}%`;
      RW.styleMarker(mark, s);
      if (s.markerLabels) {
        mark.onmouseenter = () => showSampleTip(m);
        mark.onmouseleave = () => { $('pv-tip').hidden = true; };
      }
      return mark;
    }));
    // Shape buttons show each shape in the current color.
    for (const b of document.querySelectorAll('#markerShape button')) {
      RW.styleMarker(b.querySelector('i'), { ...s, markerShape: b.dataset.value, markerSize: 1, markerOpacity: 1 });
    }
  }

  $('test-rest').onclick = async () => {
    const out = $('rest-result');
    out.className = 'small';
    out.textContent = 'Testing…';
    try {
      const r = await RW.obsidian.testRest(s);
      out.textContent = r.message;
      out.className = `small ${r.ok ? 'ok' : 'error'}`;
    } catch (e) {
      out.textContent = e.message;
      out.className = 'small error';
    }
  };

  // ---------- preview ----------

  function renderPreview() {
    const now = Date.now();
    const sample = {
      url: 'https://example.com/how-to-take-smart-notes',
      title: 'How to Take Smart Notes',
      site: 'example.com',
      author: 'Sönke Ahrens',
      kind: 'article',
    };
    const items = [
      { type: 'note', note: 'Compare with my Zettelkasten setup.', createdAt: now },
      { type: 'highlight', text: 'Writing is not what follows research, learning or studying, it is the medium of all this work.', note: '#compsci key idea for the methods chapter', anchor: { start: 10 }, createdAt: now },
      { type: 'timestamp', time: 754, note: 'Example of a permanent note', videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoTitle: 'Talk: Smart Notes', createdAt: now },
    ];
    $('preview').textContent = `${RW.obsidian.filePath(sample, s)}\n\n${RW.obsidian.renderNote(sample, items, s)}`;
  }

  // ---------- shortcuts ----------

  const commands = await api.commands.getAll();
  $('keys').append(...commands.map((c) => h('tr', {},
    h('td', {}, c.name === '_execute_action' ? 'Open the popup' : c.description),
    h('td', {}, c.shortcut ? h('kbd', {}, c.shortcut) : h('span.muted.small', {}, 'not set')))));
  const firefox = typeof browser !== 'undefined' && navigator.userAgent.includes('Firefox');
  $('keys-help').textContent = firefox
    ? 'Change them in about:addons → ⚙ → Manage Extension Shortcuts.'
    : 'Change them at chrome://extensions/shortcuts (Vivaldi: vivaldi://extensions/shortcuts).';

  // ---------- data ----------

  async function stats() {
    const all = await store.all();
    const items = all.flatMap((x) => x.items);
    const inbox = items.filter((i) => !i.archivedAt).length;
    $('stats').textContent = `${all.length} page${all.length === 1 ? '' : 's'}, ${items.length} item${items.length === 1 ? '' : 's'} (${inbox} in inbox, ${items.length - inbox} archived).`;
  }
  stats();
  api.storage.onChanged.addListener(stats);

  $('export').onclick = async () => {
    const data = { app: 'marginalia', version: 1, exportedAt: new Date().toISOString(), sources: await store.all() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: `marginalia-${RW.obsidian.stamp(Date.now(), false)}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  $('import').onclick = () => $('import-file').click();
  $('import-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await RW.send('importData', { sources: data.sources });
      $('data-result').textContent = `Imported ${r.added} new item${r.added === 1 ? '' : 's'}.`;
    } catch (err) {
      $('data-result').textContent = `Import failed: ${err.message}`;
    }
    e.target.value = '';
  };

  $('wipe').onclick = async () => {
    if (!confirm('Delete every highlight, note and timestamp? Export a backup first if unsure.')) return;
    const keys = (await store.all()).map((x) => store.sourceKey(x.url));
    await api.storage.local.remove(keys);
    $('data-result').textContent = 'All items deleted.';
  };

  sync();
})();
