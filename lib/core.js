// Shared by the background worker, content scripts and extension pages.
// Everything hangs off globalThis.RW so the classic scripts can share it.
(() => {
  if (globalThis.RW?.core) return;
  const RW = (globalThis.RW ??= {});
  // Firefox exposes a promise-based `browser`; Chromium MV3 `chrome` returns promises too.
  const api = (RW.api = globalThis.browser ?? globalThis.chrome);
  RW.core = true;

  RW.COLORS = {
    yellow: '#ffd43b',
    green: '#69db7c',
    blue: '#74c0fc',
    pink: '#f783ac',
    purple: '#b197fc',
  };

  RW.DEFAULTS = {
    method: 'uri', // 'uri' (obsidian://) or 'rest' (Local REST API plugin)
    vault: 'Obsidian',
    folder: 'Highlights',
    filename: '{{title}}',
    tags: 'highlights',
    openAfterSend: false,
    restUrl: 'http://127.0.0.1:27123',
    restKey: '',
    defaultColor: 'yellow',
    selectionToolbar: true,
    videoButton: true,
    pauseOnNote: true,
    pillSize: 1, // scale of the floating bookmark button
    pillPosition: 'top-left', // 'top-left' | 'top-right'
    markers: true, // saved timestamps on video timelines
    markerColor: '#ffd43b',
    markerShape: 'pill',
    markerSize: 1,
    markerOpacity: 1,
    markerOutline: true,
    markerLabels: true, // styled time/note bubble on hover instead of the native tooltip
  };

  // ---------- timeline marker look ----------

  const SHAPES = {
    pill: { w: 5, h: 13, r: '999px' },
    dot: { w: 10, h: 10, r: '50%' },
    line: { w: 2.5, h: 16, r: '1px' },
    diamond: { w: 9, h: 9, r: '2px', rotate: '45deg' },
  };
  RW.MARKER_SHAPES = Object.keys(SHAPES);
  RW.MARKER_COLORS = ['#ffd43b', '#ff922b', '#ff5c5c', '#f783ac', '#b197fc', '#74c0fc', '#69db7c', '#ffffff'];

  // Inline styles for one marker. YouTube's progress bar, the hover strip and the
  // settings preview all use this, so they always look the same.
  RW.markerStyle = (s) => {
    const shape = SHAPES[s.markerShape] || SHAPES.pill;
    const k = Math.min(3, Math.max(0.5, Number(s.markerSize) || 1));
    return {
      width: `${shape.w * k}px`,
      height: `${shape.h * k}px`,
      'border-radius': shape.r,
      rotate: shape.rotate || '0deg',
      background: s.markerColor || RW.DEFAULTS.markerColor,
      opacity: String(Math.min(1, Math.max(0.2, Number(s.markerOpacity) || 1))),
      'box-shadow': s.markerOutline ? '0 0 0 1px rgba(0,0,0,.65), 0 1px 3px rgba(0,0,0,.4)' : 'none',
    };
  };

  RW.styleMarker = (el, s) => {
    for (const [k, v] of Object.entries(RW.markerStyle(s))) el.style.setProperty(k, v, 'important');
  };

  // Changes whenever anything that affects how a set of markers renders changes.
  RW.markerSignature = (s, marks, duration) =>
    JSON.stringify([RW.markerStyle(s), !!s.markerLabels, duration, marks.map((m) => [m.time, m.note])]);

  RW.getSettings = async () => {
    const { settings } = await api.storage.local.get('settings');
    return { ...RW.DEFAULTS, ...settings };
  };

  // Mutations go through the background worker so concurrent writers don't clobber each other.
  RW.send = async (type, data = {}) => {
    const res = await api.runtime.sendMessage({ type, ...data });
    if (!res?.ok) throw new Error(res?.error || `No response to ${type}`);
    return res.result;
  };

  const sourceKey = (url) => 'src:' + url;

  RW.store = {
    sourceKey,
    async get(url) {
      const key = sourceKey(url);
      return (await api.storage.local.get(key))[key] || null;
    },
    async all() {
      const data = await api.storage.local.get(null);
      return Object.entries(data)
        .filter(([k]) => k.startsWith('src:'))
        .map(([, v]) => v);
    },
  };

  // ---------- URLs ----------

  // Query params that only track the visit; dropped so the same page always maps to one source.
  const TRACKING = /^(utm_\w+|mc_\w+|pk_\w+|hsa_\w+|_hs\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|mkt_tok|ref_src|ref_url|__s)$/i;

  function youtubeId(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/);
    return m ? m[1] : null;
  }

  function vimeoId(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if (u.hostname === 'player.vimeo.com') return u.pathname.match(/^\/video\/(\d+)/)?.[1] || null;
    if (/(^|\.)vimeo\.com$/.test(u.hostname)) return u.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] || null;
    return null;
  }

  function normalizeUrl(href) {
    let u;
    try { u = new URL(href); } catch { return href; }
    const yt = youtubeId(u.href);
    if (yt) return `https://www.youtube.com/watch?v=${yt}`;
    // Keep hash routes (#/page, #!/page); drop plain anchors and text fragments.
    if (!/^#!?\//.test(u.hash)) u.hash = '';
    if (/^https?:$/.test(u.protocol)) {
      const drop = [...u.searchParams.keys()].filter((k) => TRACKING.test(k));
      drop.forEach((k) => u.searchParams.delete(k));
    }
    return u.href.replace(/\?(?=#|$)/, '');
  }

  // The canonical, shareable URL of a video shown in a page or frame.
  function canonicalVideoUrl(href) {
    const yt = youtubeId(href);
    if (yt) return `https://www.youtube.com/watch?v=${yt}`;
    const vm = vimeoId(href);
    if (vm) return `https://vimeo.com/${vm}`;
    return normalizeUrl(href);
  }

  // URL that opens the video at `seconds`. YouTube and Vimeo understand their own
  // params; for any other page the content script seeks the video on `#t=N`.
  function videoUrlAt(href, seconds) {
    const t = Math.max(0, Math.floor(seconds || 0));
    const yt = youtubeId(href);
    if (yt) return `https://www.youtube.com/watch?v=${yt}${t ? `&t=${t}s` : ''}`;
    const vm = vimeoId(href);
    if (vm) return `https://vimeo.com/${vm}${t ? `#t=${t}s` : ''}`;
    const u = new URL(href);
    u.hash = `t=${t}`;
    return u.href;
  }

  // Scroll-to-text link (supported by Chromium and Firefox 131+).
  function textFragmentUrl(url, exact) {
    const text = (exact || '').replace(/\s+/g, ' ').trim();
    if (!text) return url;
    const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');
    const words = text.split(' ');
    const frag = text.length <= 80 || words.length <= 8
      ? enc(text)
      : `${enc(words.slice(0, 4).join(' '))},${enc(words.slice(-4).join(' '))}`;
    return `${url}${url.includes('#') ? '' : '#'}:~:text=${frag}`;
  }

  function siteName(href) {
    try { return new URL(href).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const isWebUrl = (href) => /^(https?|file):/.test(href || '');

  // Self-contained: serialized and run in every frame with scripting.executeScript.
  function probeVideo() {
    let best = null;
    for (const v of document.getElementsByTagName('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 120 * 70 || v.readyState === 0) continue;
      const score = area * (v.paused ? 1 : 10) * (document.visibilityState === 'visible' ? 1 : 0.5);
      if (!best || score > best.score) {
        best = {
          score,
          time: v.currentTime,
          duration: Number.isFinite(v.duration) ? v.duration : 0,
          paused: v.paused,
          frameUrl: location.href,
          title: document.title,
        };
      }
    }
    return best;
  }

  RW.util = {
    youtubeId, vimeoId, normalizeUrl, canonicalVideoUrl, videoUrlAt, textFragmentUrl,
    siteName, formatTime, uid, isWebUrl, probeVideo,
  };
})();
