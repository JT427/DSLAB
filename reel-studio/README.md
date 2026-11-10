# 🎬 Reel Maker Studio

A browser-based studio for making vertical reels (Instagram Reels, TikTok, Shorts) from your videos, photos, music and AI generations. The backend runs on the DSLAB data-structure experiments in this repo.

```
cd reel-studio
npm start            # → http://127.0.0.1:5173
```

It needs only Node.js 18 or newer, with no `npm install` and no build step.

## How to use it (3 steps)

1. **Add media.** Drop videos and photos onto the left panel. They're added straight to your reel. You can also:
   - **Try a sample** to get a ready-made reel from title cards
   - **AI tab**: describe a shot and generate a photo, a video, or an animated version of one of your photos
   - **Text tab**: one-click title cards
   - **Music tab**: upload a song and set its volume and start point
2. **Arrange & style.**
   - Drag clips to reorder them. Drag a clip's right edge to change its length.
   - Click a clip to edit it: length, trim, filter, framing (fill or fit), Ken Burns motion, transition, text (style, position, animation, size, colour) and volume.
   - With nothing selected, the right panel has one-tap styles (same transition or filter everywhere), **Auto Reel**, and a caption box with hashtag suggestions.
3. **Export.** Renders an MP4 (or WebM, depending on the browser) at 720×1280 with all audio mixed in, and shows your caption ready to copy.

Projects save automatically to the backend. Undo/redo works for every edit.

| Shortcut | Action |
|---|---|
| `Space` | Play / pause |
| `S` / `D` / `Del` | Split at playhead / duplicate / delete clip |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `←` `→` (with `Shift` for 1 s) | Nudge playhead |
| `Ctrl` + mouse wheel on the timeline | Zoom |

Number fields accept arithmetic, e.g. `2*1.5+0.5`.

## AI generation

AI generation uses [MuAPI](https://muapi.ai). The client is adapted from the
[open-generative-ai](https://github.com/JT427/open-generative-ai) repo (same submit → poll flow, same models).
Add your key in **Settings**, or start the server with:

```
MUAPI_KEY=your_key npm start
```

The key stays on the backend and is never sent to the browser. Jobs run through a server-side FIFO queue. The backend downloads finished generations into your library, so they export cleanly.

## Architecture

```
reel-studio/
├── server/
│   ├── server.js     REST API + static files + media streaming (HTTP Range), zero deps
│   └── muapi.js      MuAPI client (from open-generative-ai)
├── public/
│   ├── index.html    UI
│   ├── css/studio.css
│   └── js/
│       ├── ds.js     ← DSLAB experiments ported to JS (shared by browser AND server)
│       ├── engine.js canvas renderer, playback, Web Audio mix, MediaRecorder export
│       ├── api.js    backend client
│       └── app.js    UI logic
├── tests/            node --test (npm test)
└── data/             created at runtime: media/, projects/, library.json, settings.json
```

### The backend (REST API)

| Route | What it does | DSLAB experiment |
|---|---|---|
| `GET /api/media?q=&sort=&kind=` | List, search and sort the library | Exp 1 array, Exp 2 linear search, Exp 8/9/10/12 insertion/quick/merge/heap sort |
| `POST /api/media` | Upload a file (raw body, `X-Filename` header) | Exp 1 insert |
| `PATCH` / `DELETE /api/media/:id` | Rename, update metadata, delete | Exp 1 delete |
| `GET /media/:file` | Stream media with byte-range support | |
| `GET/POST/PUT/DELETE /api/projects[/:id]` | Saved reels | Exp 4 doubly linked list (timeline) |
| `POST /api/generate`, `GET /api/jobs` | AI generation queue | Exp 7 linked-list queue |
| `GET /api/hashtags?q=` | Hashtag suggestions | Exp 11 binary search tree |
| `POST /api/autoreel {mode: bfs|dfs}` | Orders the library into a reel | Exp 13.1 BFS / 13.2 DFS |
| `GET /api/eval?expr=` | Evaluates arithmetic | Exp 6 infix → postfix |
| `GET/POST /api/settings` | MuAPI key | |

In the browser, the same `ds.js` powers the timeline (Exp 4 doubly linked list), undo/redo (Exp 5 stack) and finding the clip under the playhead (Exp 3 binary search).

Environment variables: `PORT` (5173), `HOST` (127.0.0.1; set `0.0.0.0` to expose it on your network), `DATA_DIR`, `MUAPI_KEY`.

## Tests

```
npm test
```
