# Chalkd Viewer

A web page that opens [Chalkd](https://github.com/DibsCodes/chalkd) boards (`.chalkd` files) in the browser. You can zoom and pan around a board but not edit it.

Boards are read entirely in the browser. Nothing is uploaded anywhere.

## Using it

- **Open a board…** (or Ctrl+O) picks a `.chalkd` file. You can also drop one anywhere on the page.
- **Move around:** drag with the mouse or one finger. A mouse wheel or touchpad scrolls; flick and let go to keep gliding.
- **Zoom:** pinch with two fingers, pinch on a touchpad, or Ctrl+scroll. The **−** and **+** buttons zoom around the middle of the screen. Tap the percentage for 100%, and use the corners button to fit the whole board.
- **Recently opened:** the start page lists the last 12 boards with a thumbnail. Each one keeps a copy of the file in the browser (IndexedDB), so it reopens with one tap. In Chrome and Edge, the viewer also remembers where the file is and reads the latest version from disk when it's allowed to, falling back to the saved copy. **×** removes one board and **Clear list** removes them all.

| Key | Action |
|---|---|
| Ctrl+O | Open a board |
| + / − | Zoom in / out |
| 0 | Zoom to 100% |
| 1 | Fit the whole board |
| Arrow keys | Move (hold Shift to move further) |
| Esc | Back to the start page |

## Preview

It's a plain static site with no build step:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. It has to be served over HTTP(S), not opened as a `file://` page, because the board reader loads a WebAssembly file.

To publish it with GitHub Pages, go to **Settings › Pages** and deploy from the `main` branch, `/ (root)`.

## How it works

A `.chalkd` file is a SQLite database. Its tables are `meta` (background, last camera), `items` (strokes and pictures) and `assets` (picture bytes). See `src/main/board-file.ts` in the Chalkd repo. The viewer opens it with [sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly). It checks `PRAGMA application_id` (`CHLK`) and the format version, then draws the board on a canvas the same way the app does: images under highlighter under pen ink, round-capped ink through the stroke's midpoints, and a dot, grid or line pattern that gets coarser as you zoom out.

| Path | What it is |
|---|---|
| `index.html` | The page: start screen and viewer |
| `css/style.css` | Styles (light and dark, matching the app and chalkd-site) |
| `js/app.js` | Opening files, the recent list, buttons, keys, drag and drop |
| `js/board.js` | Reads a `.chalkd` file with sql.js |
| `js/render.js` | Draws a board (ported from Chalkd's renderer) |
| `js/viewer.js` | The pan/zoom canvas: mouse, touch, wheel, pinch, glide |
| `js/recent.js` | Recently opened boards in IndexedDB |
| `vendor/sql.js/` | sql.js 1.14.2 (MIT) |
| `fonts/` | Inter and Fraunces (SIL Open Font License) |

## License

GPL-3.0-or-later, like Chalkd: the drawing code is ported from the app. sql.js is MIT-licensed (`vendor/sql.js/LICENSE`), and the fonts are under the SIL Open Font License (`fonts/LICENSE-*.txt`).
