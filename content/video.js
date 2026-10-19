// Video timestamps. Runs in every frame, so embedded players (YouTube/Vimeo iframes,
// course platforms) work too; the background worker files bookmarks under the top page.
(() => {
  const RW = globalThis.RW;
  if (RW.video) return;
  const { api, util, ui, store } = RW;
  const isTop = window === window.top;

  let settings = RW.DEFAULTS;
  RW.getSettings().then((s) => (settings = s));
  api.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.settings) {
      settings = { ...RW.DEFAULTS, ...ch.settings.newValue };
      if (marks !== null) { syncMarks(); refreshPill(); } // restyle live
    }
    if (marks !== null && Object.keys(ch).some((k) => k.startsWith('src:'))) loadMarks();
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
    const v = hovered;
    const r = v.getBoundingClientRect();
    if (settings.videoButton) {
      ui.showPill(r, util.formatTime(v.currentTime), () => bookmark({ video: v, prompt: true }),
        { scale: settings.pillSize, position: settings.pillPosition });
    } else ui.hidePill();
    // YouTube gets markers on its own progress bar (syncMarks); other players get a strip.
    if (settings.markers && marks?.length && hasDuration(v) && !youtubePlayer(v)) {
      ui.showMarks(r, marks, v.duration, (t) => { v.currentTime = t; }, settings);
    } else ui.hideMarks();
  }

  function hidePill() {
    hovered = null;
    clearInterval(tick);
    ui.hidePill();
    ui.hideMarks();
  }

  function onPointer() {
    raf = 0;
    if (!lastPoint) return;
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

  // ---------- timeline markers for saved timestamps ----------
  // Native controls live in the browser's own shadow DOM, out of reach, so only YouTube's
  // progress bar gets real markers; every other player gets the hover strip from refreshPill.

  let marks = null; // saved timestamps of this frame's video; null until a video shows up
  let marksKey = '', loading = false, ytBox = null;

  const hasDuration = (v) => Number.isFinite(v.duration) && v.duration > 0;
  const youtubePlayer = (v) => v.closest('.html5-video-player');

  // Every timestamp saved for this video, whichever page it was bookmarked from.
  async function loadMarks() {
    const key = util.canonicalVideoUrl(location.href);
    if (key !== marksKey) { ytBox?.remove(); ytBox = null; }
    marksKey = key;
    loading = true;
    try {
      const found = [];
      for (const src of await store.all()) {
        for (const i of src.items) {
          if (i.type === 'timestamp' && util.canonicalVideoUrl(i.videoUrl || src.url) === key) {
            found.push({ time: i.time, note: i.note || '' });
          }
        }
      }
      if (key !== marksKey) return;
      marks = found.sort((a, b) => a.time - b.time);
    } finally {
      loading = false;
    }
    syncMarks();
  }

  function markEl(m, v) {
    const el = document.createElement('rw-mark');
    el.style.left = `${Math.min(100, (m.time / v.duration) * 100)}%`;
    RW.styleMarker(el, settings);
    // Below the bar: YouTube shows its own preview thumbnail above it.
    ui.labelMarker(el, m, settings, 'below');
    // Jump exactly to the mark instead of letting the player scrub to the click position.
    for (const t of ['pointerdown', 'mousedown', 'touchstart']) {
      el.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); });
    }
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); v.currentTime = m.time; });
    return el;
  }

  function syncMarks() {
    const v = primaryVideo();
    const player = v && youtubePlayer(v);
    // During ads the video element plays the ad, so its duration would misplace the marks.
    const bar = settings.markers && player && !player.classList.contains('ad-showing') && marks?.length && hasDuration(v)
      ? player.querySelector('.ytp-progress-bar')
      : null;
    if (!bar) {
      if (ytBox) { ytBox.remove(); ytBox = null; ui.hideTip(); }
      return;
    }
    const sig = RW.markerSignature(settings, marks, v.duration);
    if (ytBox?.parentNode === bar && ytBox.sig === sig) return;
    ytBox?.remove();
    ui.hideTip();
    ytBox = document.createElement('rw-marks');
    ytBox.sig = sig;
    ytBox.append(...marks.map((m) => markEl(m, v)));
    bar.append(ytBox);
  }

  // Cheap poll: catches videos that appear late, SPA navigation and players rebuilding their bar.
  function pollMarks() {
    if (!document.getElementsByTagName('video').length || loading) return;
    if (marks === null || util.canonicalVideoUrl(location.href) !== marksKey) loadMarks();
    else syncMarks();
  }
  pollMarks();
  setInterval(pollMarks, 1000);

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
