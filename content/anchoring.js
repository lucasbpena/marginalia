// Text-quote anchoring (the W3C Web Annotation / Hypothesis approach): a highlight is
// stored as its exact text plus some context and a position hint, then found again in
// the page text on every visit and wrapped in <rw-hl> elements.
(() => {
  const RW = globalThis.RW;
  if (RW.anchoring) return;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION',
    'IFRAME', 'OBJECT', 'SVG', 'svg', 'MATH', 'math', 'MARGINALIA-UI']);
  const CONTEXT = 40;

  // All text nodes under body, in document order, with their offset in the joined text.
  function buildIndex(root = document.body) {
    const nodes = [];
    const parts = [];
    let length = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        return SKIP.has(n.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: length });
      parts.push(n.data);
      length += n.data.length;
    }
    return { nodes, text: parts.join(''), byNode: null, norm: null };
  }

  // Index of the last node starting at or before `pos`.
  function nodeIndexAt(idx, pos) {
    let lo = 0, hi = idx.nodes.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (idx.nodes[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function pointToOffset(idx, container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      idx.byNode ??= new Map(idx.nodes.map((e) => [e.node, e]));
      const e = idx.byNode.get(container);
      if (e) return e.start + Math.min(offset, container.data.length);
    }
    // First indexed text node at or after the boundary point.
    const probe = document.createRange();
    probe.setStart(container, offset);
    let lo = 0, hi = idx.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (probe.comparePoint(idx.nodes[mid].node, 0) < 0) lo = mid + 1; else hi = mid;
    }
    return lo < idx.nodes.length ? idx.nodes[lo].start : idx.text.length;
  }

  function describe(range) {
    const idx = buildIndex();
    const start = pointToOffset(idx, range.startContainer, range.startOffset);
    const end = pointToOffset(idx, range.endContainer, range.endOffset);
    if (end <= start) return null;
    return {
      exact: idx.text.slice(start, end),
      prefix: idx.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: idx.text.slice(end, end + CONTEXT),
      start,
    };
  }

  // ---------- locating ----------

  const squash = (s) => s.replace(/\s+/g, ' ');

  // Whitespace-collapsed copy of the page text with a map back to original offsets.
  function normalized(idx) {
    if (idx.norm) return idx.norm;
    const { text } = idx;
    const out = [], map = [];
    let space = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ' ' || c === '\f') {
        if (!space) { out.push(' '); map.push(i); }
        space = true;
      } else {
        out.push(c); map.push(i);
        space = false;
      }
    }
    return (idx.norm = { text: out.join(''), map });
  }

  function findAll(hay, needle, limit = 300) {
    const res = [];
    if (!needle) return res;
    for (let i = hay.indexOf(needle); i !== -1 && res.length < limit; i = hay.indexOf(needle, i + 1)) res.push(i);
    return res;
  }

  function candidates(idx, exact) {
    const direct = findAll(idx.text, exact).map((i) => [i, i + exact.length]);
    if (direct.length) return direct;
    const norm = normalized(idx);
    const needle = squash(exact).trim();
    let hits = findAll(norm.text, needle);
    if (!hits.length) {
      const lower = norm.text.toLowerCase();
      if (lower.length === norm.text.length) hits = findAll(lower, needle.toLowerCase());
    }
    return hits.map((i) => [norm.map[i], norm.map[i + needle.length - 1] + 1]);
  }

  function sharedTail(a, b) {
    a = squash(a); b = squash(b);
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  function sharedHead(a, b) {
    a = squash(a); b = squash(b);
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  function locate(idx, anchor) {
    if (!anchor?.exact) return null;
    const cands = candidates(idx, anchor.exact);
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    const { prefix = '', suffix = '', start = 0 } = anchor;
    let best = null, bestScore = -Infinity;
    for (const [s, e] of cands) {
      const score =
        sharedTail(idx.text.slice(Math.max(0, s - prefix.length - 20), s), prefix) +
        sharedHead(idx.text.slice(e, e + suffix.length + 20), suffix) -
        (Math.abs(s - start) / Math.max(idx.text.length, 1)) * 20;
      if (score > bestScore) { bestScore = score; best = [s, e]; }
    }
    return best;
  }

  // ---------- wrapping ----------

  // Split idx.nodes[i] at a local offset, keeping the index in sync. Returns the second half's index.
  function splitAt(idx, i, offset) {
    const e = idx.nodes[i];
    const rest = e.node.splitText(offset);
    idx.nodes.splice(i + 1, 0, { node: rest, start: e.start + offset });
    idx.byNode = null;
    return i + 1;
  }

  function wrap(idx, start, end, item) {
    const els = [];
    let i = nodeIndexAt(idx, start);
    while (i < idx.nodes.length && idx.nodes[i].start < end) {
      const e = idx.nodes[i];
      const len = e.node.data.length;
      if (e.start + len <= start) { i++; continue; }
      if (e.start < start) { i = splitAt(idx, i, start - e.start); continue; }
      if (e.start + len > end) splitAt(idx, i, end - e.start);
      const node = idx.nodes[i].node;
      if (node.data.trim() && node.parentNode) {
        const el = document.createElement('rw-hl');
        el.dataset.rwId = item.id;
        node.parentNode.insertBefore(el, node);
        el.appendChild(node);
        els.push(el);
      }
      i++;
    }
    style(els, item);
    return els.length > 0;
  }

  function marks(id) {
    return document.querySelectorAll(`rw-hl[data-rw-id="${CSS.escape(id)}"]`);
  }

  function style(els, item) {
    for (const el of els) {
      el.dataset.color = item.color || 'yellow';
      if (item.note) el.dataset.note = ''; else delete el.dataset.note;
    }
  }

  function unwrap(id) {
    for (const el of marks(id)) {
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
  }

  // Anchor many highlights with one text index. Returns the ids that were placed.
  function anchorAll(items) {
    const placed = [];
    if (!items.length || !document.body) return placed;
    const idx = buildIndex();
    for (const item of items) {
      const loc = locate(idx, item.anchor);
      if (loc && wrap(idx, loc[0], loc[1], item)) placed.push(item.id);
    }
    return placed;
  }

  // Wrap an exact offset range right after the user made a selection.
  function wrapOffsets(start, end, item) {
    return wrap(buildIndex(), start, end, item);
  }

  RW.anchoring = { describe, anchorAll, wrapOffsets, unwrap, marks, restyle: (item) => style(marks(item.id), item) };
})();
