# Marginalia

A personal Readwise-style browser extension: highlight and annotate web pages, bookmark moments in YouTube/Vimeo/any HTML5 video (including embedded players), and send everything to Obsidian. Whatever you send is archived in the extension.

## Install

**Vivaldi / Chrome / Chromium**: open `vivaldi://extensions` (or `chrome://extensions`), turn on *Developer mode*, click *Load unpacked*, and pick this folder.

**Firefox / Zen** (untested): `about:debugging` → *This Firefox* → *Load Temporary Add-on* → `manifest.json`. It stays loaded until the browser restarts. Grant "Access your data for all websites" in `about:addons` if highlights don't appear.

## Use

| What | How |
| --- | --- |
| Highlight | Select text, then pick a color in the toolbar (or press `Alt+Shift+H`) |
| Highlight + note | The ✎ Note button in the toolbar, or `Alt+Shift+E` |
| Edit/recolor/delete | Click a highlight (Alt+click when it's inside a link) |
| Video timestamp | Hover the video and click the 🔖 pill, or press `Alt+Shift+Y`, or use the popup |
| Jump to a saved moment | Yellow markers on YouTube's progress bar; on other players hover the video for a marker strip along its bottom edge. Click a marker to seek. Color, shape, size, opacity, outline and hover labels are in Settings → *Timeline markers*; the bookmark button's size and corner in Settings → *Video bookmark button*. |
| Page note / save page | Popup (`Alt+Shift+M`) |
| Library (Inbox/Archive) | Popup → library icon, or right-click the toolbar icon → *Open library* |

Shortcuts can be changed at `vivaldi://extensions/shortcuts`.

## Sending to Obsidian

One note per page in `Highlights/` (configurable). It has frontmatter (`created`, `tags`, `title`, `author`, `site`, `url`, `type`) and sections for Notes, Highlights (each with a scroll-to-text link back to the page) and Timestamps (links that open the video at that second). Sending again appends a `## Added …` section with only the new items. Notes go in as nested bullets, so a note that starts with `#tag` shows up in your tag dashboards. `#words` inside quoted page text are escaped so they don't become tags.

- **Obsidian URI** (default, no setup): the browser asks once to open `obsidian://` links. Tick "always allow". Missing folders are created.
- **Local REST API** (silent, best for "Send inbox"): install the community plugin, enable its *Non-encrypted (HTTP) server*, and paste the API key in Settings → *Test connection*.

Data lives in the browser's extension storage. Use Settings → *Export backup* to save it.

## Test

`python3 tests/e2e.py [--youtube]` loads the extension in Playwright's Chromium. It needs `playwright install chromium` and ffmpeg with libvpx.
