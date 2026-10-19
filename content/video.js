// Video timestamps. Runs in every frame, so embedded players (YouTube/Vimeo iframes,
// course platforms) work too; the background worker files bookmarks under the top page.
(() => {
  const RW = globalThis.RW;
  if (RW.video) return;
  const { api, util, ui } = RW;
  const isTop = window === window.top;

  let settings = RW.DEFAULTS;
  RW.getSettings().then((s) => (settings = s));
  api.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) settings = { ...RW.DEFAULTS, ...ch.settings.newValue };
  });

  function videos() {
    return [...document.getElementsByTagName('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height >= 120 * 70;
    });
  }

  // Same ranking as util.probeVideo: playing beats paused, then the biggest.
  function primaryVideo() {
    let best = null, bestScore = 0;
    for (const v of videos()) {
      const r = v.getBoundingClientRect();
      const score = r.width * r.height * (v.paused ? 1 : 10);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  function frameTitle() {
    const t = document.title.replace(/^\(\d+\)\s*/, '').replace(/ [-–|] (YouTube|Vimeo)$/, '').trim();
    return t || util.siteName(location.href);
  }

  let busy = false;
  async function bookmark(opts = {}) {
    if (busy) return null; // ignore double-clicks while the first save is in flight
    busy = true;
    try { return await save(opts); } finally { busy = false; }
  }

  async function save({ video, note = '', prompt = false }) {
    const v = video || primaryVideo();
    if (!v) { ui.toast('No video found'); return null; }
    const time = Math.floor(v.currentTime);
    const item = {
      id: util.uid(),
      type: 'timestamp',
      time,
      duration: Number.isFinite(v.duration) ? Math.floor(v.duration) : 0,
      videoUrl: util.canonicalVideoUrl(location.href),
      videoTitle: frameTitle(),
      note,
    };
    let res;
    try {
      res = await RW.send('addItem', { meta: isTop ? RW.pageMeta?.() : null, item });
    } catch (e) {
      ui.toast(`Could not save: ${e.message}`);
      return null;
    }
    if (!prompt) {
      ui.toast(`Bookmarked ${util.formatTime(time)}`);
      return res;
    }
    const resume = settings.pauseOnNote && !v.paused;
    if (resume) v.pause();
    ui.prompt(v.getBoundingClientRect(), {
      title: `Bookmarked ${util.formatTime(time)}`,
      placeholder: 'What happens here? (optional)',
      onDone: async (text) => {
        if (text) await RW.send('updateItem', { url: res.url, id: res.item.id, patch: { note: text } }).catch(() => {});
        if (resume) v.play().catch(() => {});
      },
    });
    return res;
  }

  // ---------- floating "bookmark" pill over the video under the pointer ----------

  let hovered = null, hideTimer = null, tick = null, raf = 0, lastPoint = null;

  function refreshPill() {
    if (!hovered) return;
    const r = hovered.getBoundingClientRect();
    ui.showPill(r, util.formatTime(hovered.currentTime), () => bookmark({ video: hovered, prompt: true }));
  }

  function hidePill() {
    hovered = null;
    clearInterval(tick);
    ui.hidePill();
  }

  function onPointer() {
    raf = 0;
    if (!settings.videoButton || !lastPoint) return;
    const { x, y } = lastPoint;
    const v = videos().find((v) => {
      const r = v.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (!v) return;
    if (v !== hovered) {
      hovered = v;
      clearInterval(tick);
      tick = setInterval(refreshPill, 500);
    }
    refreshPill();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePill, 2500);
  }

  document.addEventListener('pointermove', (e) => {
    lastPoint = { x: e.clientX, y: e.clientY };
    raf ||= requestAnimationFrame(onPointer);
  }, { passive: true, capture: true });

  // ---------- #t=N seeking for players that don't support it themselves ----------

  function seekFromHash() {
    const m = location.hash.match(/^#t=(\d+)s?$/);
    if (!m || util.youtubeId(location.href) || util.vimeoId(location.href)) return;
    const t = Number(m[1]);
    let tries = 0;
    // Keep trying until the seek sticks: players without range requests can't seek before buffering.
    const timer = setInterval(() => {
      const v = primaryVideo();
      if (v && v.readyState > 0) {
        if (Math.abs(v.currentTime - t) <= 1) return clearInterval(timer);
        v.currentTime = t;
      }
      if (++tries > 40) clearInterval(timer);
    }, 500);
  }
  seekFromHash();
  window.addEventListener('hashchange', seekFromHash);

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'video:bookmark') {
      bookmark({ note: msg.note || '', prompt: !!msg.prompt }).then((r) => sendResponse(r));
      return true;
    }
    if (msg?.type === 'video:seek') {
      const v = primaryVideo();
      if (v) { v.currentTime = msg.time; v.play?.().catch(() => {}); }
      sendResponse(!!v);
    }
    return false;
  });

  RW.video = { bookmark, primaryVideo };
})();
