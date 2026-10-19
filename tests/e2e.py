"""End-to-end test: loads the unpacked extension in Playwright's Chromium.

    python3 tests/e2e.py            # needs: pip install playwright && playwright install chromium; ffmpeg (libvpx)
    python3 tests/e2e.py --youtube  # also runs a smoke test against a real YouTube video (network)

Screenshots land in the printed work directory.
"""
import http.server
import json
import re
import pathlib
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.parse

from playwright.sync_api import sync_playwright

EXT = pathlib.Path(__file__).resolve().parent.parent
FIX = EXT / "tests" / "fixtures"
WORK = pathlib.Path(tempfile.mkdtemp(prefix="marginalia-e2e-"))
CSP = "default-src 'self'; style-src 'self'; script-src 'self'; media-src 'self'; require-trusted-types-for 'script'"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else f'  -> {detail}'}")


# ---------- servers ----------

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def site_handler(player_origin):
    class Site(Quiet):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(FIX), **k)

        def do_GET(self):
            path = urllib.parse.urlparse(self.path).path
            if path == "/clip.webm":
                return self._media((WORK / "clip.webm").read_bytes())
            if path == "/embed.html":
                html = (FIX / "embed.html.tpl").read_text().replace("{{PLAYER}}", player_origin)
                return self._raw(200, html.encode(), "text/html")
            return super().do_GET()

        def _media(self, data):
            # Range requests, so the browser can seek like it would on a real site.
            m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
            if not m:
                return self._raw(200, data, "video/webm", {"Accept-Ranges": "bytes"})
            start = int(m[1] or 0)
            end = min(int(m[2]) if m[2] else len(data) - 1, len(data) - 1)
            return self._raw(206, data[start:end + 1], "video/webm",
                             {"Accept-Ranges": "bytes", "Content-Range": f"bytes {start}-{end}/{len(data)}"})

        def _raw(self, code, data, ctype, headers=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def end_headers(self):
            if self.path.startswith("/article"):
                self.send_header("Content-Security-Policy", CSP)
            super().end_headers()

    return Site


VAULT, REQS = {}, []


class Rest(http.server.BaseHTTPRequestHandler):
    """Just enough of the Obsidian Local REST API."""

    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="text/plain"):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        return self.headers.get("Authorization") == "Bearer testkey"

    def _path(self):
        return urllib.parse.unquote(self.path.split("/vault/", 1)[1])

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST")
        self.end_headers()

    def do_GET(self):
        if self.path == "/":
            info = {"status": "OK", "service": "Obsidian Local REST API", "authenticated": self._auth(), "versions": {"self": "mock"}}
            return self._send(200, json.dumps(info).encode(), "application/json")
        if not self._auth():
            return self._send(401)
        p = self._path()
        return self._send(200, VAULT[p].encode(), "text/markdown") if p in VAULT else self._send(404)

    def do_PUT(self):
        if not self._auth():
            return self._send(401)
        p, body = self._path(), self._body()
        VAULT[p] = body
        REQS.append(("PUT", p, body))
        self._send(204)

    def do_POST(self):
        if not self._auth():
            return self._send(401)
        if self.path.startswith("/open/"):
            return self._send(200)
        p, body = self._path(), self._body()
        VAULT[p] = VAULT.get(p, "") + body
        REQS.append(("POST", p, body))
        self._send(204)


def serve(handler):
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}"


# ---------- helpers ----------

def storage(sw):
    return sw.evaluate("() => chrome.storage.local.get(null)")


def source(sw, url):
    return storage(sw).get("src:" + url)


def select(page, js_range):
    """Select a range built by `js_range` (body of a function returning a Range) and release the mouse."""
    text = page.evaluate(f"""() => {{
        const r = (() => {{ {js_range} }})();
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        r.startContainer.parentElement.dispatchEvent(new MouseEvent('mouseup', {{ bubbles: true, button: 0 }}));
        return s.toString();
    }}""")
    page.wait_for_timeout(150)
    return text


def tab_id(sw, url):
    return sw.evaluate("async (u) => (await chrome.tabs.query({})).find(t => (t.url || '').startsWith(u))?.id", url)


def main():
    youtube = "--youtube" in sys.argv
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=60",
                    "-c:v", "libvpx", "-b:v", "150k", str(WORK / "clip.webm")], check=True)
    player = serve(site_handler(""))
    site = serve(site_handler(player))
    rest = serve(Rest)
    print(f"work dir: {WORK}\nsite {site} · player {player} · rest {rest}")

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(WORK / "profile"), channel="chromium", headless=True,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
            viewport={"width": 1100, "height": 800},
        )
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        ext = f"chrome-extension://{ext_id}"
        check("service worker starts", ext_id)
        cmds = sw.evaluate("() => chrome.commands.getAll()")
        check("every command gets its default shortcut", all(c["shortcut"] for c in cmds), [(c["name"], c["shortcut"]) for c in cmds])

        errors = []

        def watch(page, tag):
            page.on("pageerror", lambda e: errors.append(f"{tag}: {e}"))
            page.on("console", lambda m: m.type == "error" and "Failed to load resource" not in m.text and errors.append(f"{tag}: {m.text}"))
            return page

        # ---------- article: create highlights ----------
        art = watch(ctx.new_page(), "article")
        art_url = f"{site}/article.html"
        art.goto(art_url)
        art.wait_for_timeout(600)

        sel = select(art, """
            const p = document.getElementById('p1'); const r = document.createRange();
            r.setStart(p.firstChild, 10); r.setEnd(p.querySelector('em').nextSibling, 9); return r;""")
        check("selection spans inline element", sel == "brown fox jumps over the lazy", sel)
        bar = art.locator(".bar")
        check("toolbar appears on selection (strict CSP + Trusted Types page)", bar.is_visible())
        art.locator('.bar .sw[data-color="green"]').click()
        art.wait_for_timeout(400)
        marks = art.locator("rw-hl")
        joined = "".join(art.eval_on_selector_all("rw-hl", "els => els.map(e => e.textContent)"))
        check("highlight wraps text across <em>", marks.count() >= 2 and joined == "brown fox jumps over the lazy", joined)
        src = source(sw, art_url)
        check("highlight saved with page metadata",
              src and src["title"] == "Test Article" and src["author"] == "Ada Lovelace" and src["site"] == "Example Site"
              and src["items"][0]["color"] == "green", src and {k: src.get(k) for k in ("title", "author", "site")})

        # second occurrence of a repeated phrase
        select(art, """
            const t = document.getElementById('p3').firstChild; const r = document.createRange();
            r.setStart(t, 0); r.setEnd(t, 'Repeated phrase here'.length); return r;""")
        art.locator('.bar .sw[data-color="yellow"]').click()
        art.wait_for_timeout(300)

        # highlight inside a link, with a note via the toolbar's Note button
        select(art, """
            const t = document.querySelector('#p4 a').firstChild; const r = document.createRange();
            r.setStart(t, 0); r.setEnd(t, t.data.length); return r;""")
        art.locator('.bar [data-act="note"]').click()
        ta = art.locator(".card textarea")
        ta.wait_for(timeout=2000)
        art.wait_for_timeout(100)
        check("note editor opens and is focused", art.evaluate("() => document.querySelector('marginalia-ui').shadowRoot.activeElement?.tagName") == "TEXTAREA")
        art.keyboard.type("link note #compsci")
        art.keyboard.press("Escape")
        art.wait_for_timeout(300)
        items = source(sw, art_url)["items"]
        check("note saved from the highlight popover", any(i.get("note") == "link note #compsci" for i in items), [i.get("note") for i in items])

        # late content
        art.wait_for_selector("#p5")
        select(art, """
            const t = document.getElementById('p5').firstChild; const r = document.createRange();
            r.setStart(t, 0); r.setEnd(t, 'Late content appears'.length); return r;""")
        art.locator('.bar .sw[data-color="blue"]').click()
        art.wait_for_timeout(300)
        check("four highlights stored", len(source(sw, art_url)["items"]) == 4)

        # ---------- reload: restore ----------
        art.reload()
        art.wait_for_timeout(700)
        ids = art.eval_on_selector_all("rw-hl", "els => [...new Set(els.map(e => e.dataset.rwId))]")
        check("highlights restored after reload (before late content)", len(ids) == 3, ids)
        in_p3 = art.evaluate("() => !!document.querySelector('#p3 rw-hl') && !document.querySelector('#p2 rw-hl')")
        check("repeated phrase re-anchored to the right occurrence", in_p3)
        art.wait_for_timeout(2600)
        check("late-rendered highlight anchored once content appears", art.locator("#p5 rw-hl").count() == 1)
        check("note marker on highlight with note", art.locator("#p4 rw-hl[data-note]").count() == 1)

        # ---------- edit / delete in page ----------
        art.locator("#p2").click()  # plain click elsewhere does nothing
        check("clicking plain text opens nothing", not art.locator(".card").is_visible())
        art.locator("#p1 rw-hl").first.click()
        art.locator(".card").wait_for(timeout=2000)
        art.locator('.card .sw[data-color="pink"]').click()
        art.wait_for_timeout(300)
        check("recolor from popover", art.locator('#p1 rw-hl[data-color="pink"]').count() >= 2)
        art.locator('.card [data-act="delete"]').click()
        art.wait_for_timeout(400)
        check("delete from popover unwraps highlight", art.locator("#p1 rw-hl").count() == 0 and
              len(source(sw, art_url)["items"]) == 3)
        art.locator("#p4 rw-hl").click(modifiers=["Alt"])
        art.wait_for_timeout(200)
        check("Alt+click on a highlighted link opens the editor", art.locator(".card").is_visible() and art.url == art_url)
        art.keyboard.press("Escape")
        art.wait_for_timeout(100)
        check("Esc closes the editor even when it isn't focused", not art.locator(".card").is_visible())

        # keyboard-shortcut path (background → content)
        art_tab = tab_id(sw, art_url)
        art.evaluate("""() => { const t = document.getElementById('p4').lastChild; const r = document.createRange();
            r.setStart(t, t.data.indexOf('and a')); r.setEnd(t, t.data.length); getSelection().removeAllRanges(); getSelection().addRange(r); }""")
        sw.evaluate("(id) => chrome.tabs.sendMessage(id, { type: 'hl:selection', withNote: false }, { frameId: 0 })", art_tab)
        art.wait_for_timeout(400)
        check("highlight via shortcut message", any(i["text"] == "and a #hashtag." for i in source(sw, art_url)["items"]))
        art.screenshot(path=str(WORK / "article.png"))

        # ---------- video page ----------
        vid = watch(ctx.new_page(), "video")
        vid_url = f"{site}/video.html"
        vid.goto(vid_url)
        vid.evaluate("() => document.getElementById('v').play()")
        vid.wait_for_timeout(2500)
        box = vid.locator("#v").bounding_box()
        vid.mouse.move(box["x"] + 200, box["y"] + 150)
        vid.mouse.move(box["x"] + 210, box["y"] + 160)
        pill = vid.locator(".pill")
        pill.wait_for(timeout=2000)
        check("bookmark pill shows over video", pill.is_visible())
        pill.click()
        vid.locator(".card textarea").wait_for(timeout=2000)
        check("video paused while typing note", vid.evaluate("() => document.getElementById('v').paused"))
        vid.keyboard.type("intro section")
        vid.keyboard.press("Enter")
        vid.wait_for_timeout(400)
        check("video resumes after note", not vid.evaluate("() => document.getElementById('v').paused"))
        ts = [i for i in (source(sw, vid_url) or {"items": []})["items"] if i["type"] == "timestamp"]
        check("timestamp saved with note and time", ts and ts[0]["note"] == "intro section" and 1 <= ts[0]["time"] <= 5 and ts[0]["videoUrl"] == vid_url, ts)
        vid.screenshot(path=str(WORK / "video.png"))

        seek = watch(ctx.new_page(), "seek")
        seek.goto(f"{vid_url}#t=30")
        seek.wait_for_timeout(2500)
        t = seek.evaluate("() => document.getElementById('v').currentTime")
        check("#t=30 seeks the video", 29 <= t <= 31, t)
        seek.close()

        # ---------- cross-origin embedded player ----------
        emb = watch(ctx.new_page(), "embed")
        emb_url = f"{site}/embed.html"
        emb.goto(emb_url)
        frame = emb.frame_locator("#player")
        frame.locator("#v").wait_for()
        emb.frames[1].evaluate("""async () => { const v = document.getElementById('v');
            if (v.readyState < 3) await new Promise(r => v.addEventListener('canplaythrough', r, { once: true }));
            v.currentTime = 12; await new Promise(r => v.addEventListener('seeked', r, { once: true })); return v.play(); }""")
        emb.wait_for_timeout(1200)
        emb_tab = tab_id(sw, emb_url)
        best = sw.evaluate("""async (id) => {
            const res = await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: RW.util.probeVideo });
            return res.filter(r => r.result).map(r => ({ ...r.result, frameId: r.frameId })).sort((a, b) => b.score - a.score)[0];
        }""", emb_tab)
        check("probe finds the video inside the iframe", best and best["frameId"] != 0, best)
        sw.evaluate("([id, f]) => chrome.tabs.sendMessage(id, { type: 'video:bookmark', prompt: true }, { frameId: f })", [emb_tab, best["frameId"]])
        frame.locator(".card textarea").wait_for(timeout=2000)
        emb.keyboard.type("embedded note")
        emb.keyboard.press("Enter")
        emb.wait_for_timeout(400)
        es = source(sw, emb_url)
        check("iframe bookmark filed under the top page", es and es["title"] == "Course Page With Embedded Player"
              and es["items"][0]["videoUrl"] == f"{player}/video.html" and es["items"][0]["note"] == "embedded note"
              and 12 <= es["items"][0]["time"] <= 15, es)

        # ---------- popup ----------
        pop = watch(ctx.new_page(), "popup")
        pop.set_viewport_size({"width": 370, "height": 590})
        pop.goto(f"{ext}/pages/popup.html?tab={tab_id(sw, vid_url)}")
        pop.wait_for_timeout(1500)
        check("popup shows page title", pop.locator("#title").inner_text() == "Lecture 03 - Video Page", pop.locator("#title").inner_text())
        check("popup detects the playing video", pop.locator("#video").is_visible())
        pop.fill("#video-note", "from popup")
        pop.click("#video-add")
        pop.wait_for_timeout(500)
        check("popup bookmarks a timestamp", len(source(sw, vid_url)["items"]) == 2)
        pop.click("#add-note")
        pop.fill("#note-text", "Whole-lecture note")
        pop.click("#note-save")
        pop.click("#save-page")
        pop.wait_for_timeout(500)
        kinds = sorted(i["type"] for i in source(sw, vid_url)["items"])
        check("popup page note + save page", kinds == ["bookmark", "note", "timestamp", "timestamp"], kinds)
        check("popup list renders", pop.locator("#items li").count() == 4)
        pop.screenshot(path=str(WORK / "popup.png"))
        pop.close()

        # ---------- library + REST export ----------
        sw.evaluate("(s) => chrome.storage.local.set({ settings: s })",
                    {"method": "rest", "restUrl": rest, "restKey": "testkey", "folder": "Highlights", "tags": "highlights, web"})
        opt = watch(ctx.new_page(), "options")
        opt.goto(f"{ext}/pages/options.html")
        opt.click("#test-rest")
        opt.wait_for_timeout(500)
        check("options: REST test connection", "Connected" in opt.locator("#rest-result").inner_text(), opt.locator("#rest-result").inner_text())
        opt.locator("details.preview summary").click()
        opt.screenshot(path=str(WORK / "options.png"), full_page=True)
        opt.close()

        lib = watch(ctx.new_page(), "library")
        lib.goto(f"{ext}/pages/library.html")
        lib.wait_for_timeout(600)
        check("library lists three pages", lib.locator("article.card").count() == 3, lib.locator("article.card").count())
        lib.screenshot(path=str(WORK / "library.png"), full_page=True)
        lib.fill("#q", "lazy")
        lib.wait_for_timeout(100)
        check("search filters", lib.locator("article.card").count() == 0)
        lib.fill("#q", "repeated")
        lib.wait_for_timeout(100)
        check("search finds highlight text", lib.locator("article.card").count() == 1 and lib.locator("li.item").count() == 1)
        lib.fill("#q", "")
        lib.wait_for_timeout(100)

        card = lib.locator("article.card", has=lib.locator("a.card-title", has_text="Test Article"))
        card.locator("button.primary", has_text="Send").click()
        lib.wait_for_timeout(800)
        note = VAULT.get("Highlights/Test Article.md", "")
        check("REST: note created in folder", bool(note), list(VAULT))
        check("REST: frontmatter", note.startswith("---\ncreated: ") and "tags:\n  - highlights\n  - web" in note
              and f'url: "{art_url}"' in note and 'author: "Ada Lovelace"' in note, note[:400])
        check("REST: highlight with text-fragment link", "- Repeated phrase here ([↗](" in note and "#:~:text=Repeated%20phrase%20here" in note, note)
        check("REST: note nested under highlight, tag kept", "\t- link note #compsci" in note, note)
        check("REST: #tags in quoted page text are escaped", "- and a \\#hashtag. ([" in note, note)
        art_items = source(sw, art_url)["items"]
        check("REST: sent items archived", all(i["archivedAt"] and i["exportedAt"] for i in art_items))
        check("library: card left the inbox", lib.locator("article.card", has_text="Test Article").count() == 0)

        # new highlight → append
        art.bring_to_front()
        select(art, """
            const t = document.getElementById('p2').lastChild; const r = document.createRange();
            r.setStart(t, t.data.indexOf('Some filler')); r.setEnd(t, t.data.indexOf(' in between')); return r;""")
        art.locator('.bar .sw[data-color="purple"]').click()
        art.wait_for_timeout(400)
        lib.bring_to_front()
        lib.wait_for_timeout(300)
        lib.locator("article.card", has_text="Test Article").locator("button.primary", has_text="Send").click()
        lib.wait_for_timeout(800)
        check("REST: second send appends", REQS[-1][0] == "POST" and "## Added " in REQS[-1][2] and "Some filler text" in REQS[-1][2], REQS[-1][:2])

        # archive view + move back
        lib.click('button[data-view="archive"]')
        lib.wait_for_timeout(200)
        check("archive tab shows sent page", lib.locator("article.card", has_text="Test Article").count() == 1)
        lib.click('button[data-view="inbox"]')

        # ---------- URI export (captured, not launched) ----------
        sw.evaluate("(s) => chrome.storage.local.set({ settings: s })", {"method": "uri", "vault": "Obsidian", "folder": "Highlights", "tags": "highlights"})
        lib.wait_for_timeout(300)
        lib.evaluate("() => { window.__uris = []; chrome.tabs.update = async (id, o) => { window.__uris.push(o.url); }; }")
        lib.locator("article.card", has=lib.locator("a.card-title", has_text="Lecture 03")).locator("button.primary", has_text="Send").click()
        lib.wait_for_timeout(800)
        uris = lib.evaluate("() => window.__uris")
        ok = len(uris) == 1 and uris[0].startswith("obsidian://new?vault=Obsidian&file=Highlights%2FLecture%2003%20-%20Video%20Page&silent=true&content=")
        content = urllib.parse.unquote(uris[0].split("&content=", 1)[1]) if uris else ""
        check("URI: obsidian://new link built", ok, uris[:1])
        check("URI: timestamps rendered with links", f"- [0:0" in content and "#t=" in content and "## Timestamps" in content and "## Notes" in content, content)
        vs = source(sw, vid_url)
        check("URI: sent items archived + path remembered", all(i["archivedAt"] for i in vs["items"]) and vs["export"]["path"] == "Highlights/Lecture 03 - Video Page.md")

        # ---------- browser accepts tabs.update to obsidian:// without navigating away ----------
        err = sw.evaluate("""async (id) => { try { await chrome.tabs.update(id, { url: 'obsidian://open?vault=__test__' }); return null; } catch (e) { return String(e); } }""", emb_tab)
        emb.wait_for_timeout(800)
        check("tabs.update(obsidian://) accepted and page stays", err is None and emb.url == emb_url, (err, emb.url))

        lib.goto(f"{ext}/pages/library.html#archive")
        lib.wait_for_timeout(500)
        lib.screenshot(path=str(WORK / "library-archive.png"), full_page=True)
        lib.emulate_media(color_scheme="dark")
        lib.goto(f"{ext}/pages/library.html")
        lib.wait_for_timeout(500)
        lib.screenshot(path=str(WORK / "library-dark.png"), full_page=True)
        dpop = ctx.new_page()
        dpop.emulate_media(color_scheme="dark")
        dpop.set_viewport_size({"width": 370, "height": 590})
        dpop.goto(f"{ext}/pages/popup.html?tab={art_tab}")
        dpop.wait_for_timeout(800)
        dpop.screenshot(path=str(WORK / "popup-dark.png"))

        # ---------- optional: real YouTube ----------
        if youtube:
            yt = ctx.new_page()
            yt.goto("https://www.youtube.com/watch?v=jNQXAC9IVRw", wait_until="domcontentloaded")
            try:
                yt.wait_for_selector("video", timeout=20000)
                yt.wait_for_timeout(4000)
                yt_tab = tab_id(sw, "https://www.youtube.com/watch")
                meta = sw.evaluate("(id) => chrome.tabs.sendMessage(id, { type: 'page:meta' }, { frameId: 0 })", yt_tab)
                check("YouTube: page metadata", meta and meta["url"] == "https://www.youtube.com/watch?v=jNQXAC9IVRw" and meta["kind"] == "video", meta)
                yt.evaluate("() => { const v = document.querySelector('video'); v.muted = true; v.currentTime = 7; return v.play().catch(() => {}); }")
                yt.wait_for_timeout(1500)
                r = sw.evaluate("(id) => chrome.tabs.sendMessage(id, { type: 'video:bookmark', note: 'yt' }, { frameId: 0 })", yt_tab)
                check("YouTube: timestamp bookmark", r and r["item"]["videoUrl"] == "https://www.youtube.com/watch?v=jNQXAC9IVRw" and r["item"]["time"] >= 7, r)
                yt.screenshot(path=str(WORK / "youtube.png"))
            except Exception as e:  # network/consent pages are out of our control
                check("YouTube smoke test", False, e)

        # ---------- extension errors reported by Chromium ----------
        ce = ctx.new_page()
        ce.goto("chrome://extensions")
        info = ce.evaluate(f"() => new Promise(r => chrome.developerPrivate.getExtensionInfo('{ext_id}', r))")
        warnings = (info.get("installWarnings") or []) + [e.get("message") for e in info.get("manifestErrors") or []]
        runtime = [e.get("message") for e in info.get("runtimeErrors") or []]
        print("manifest warnings:", warnings or "none")
        check("no runtime errors recorded by Chromium", not runtime, runtime)
        check("no page/console errors", not errors, errors)
        ctx.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed · screenshots in {WORK}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
