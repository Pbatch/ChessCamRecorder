# @chesscam/recorder

Records chess moves from a camera, video file or stream of a real board, entirely in the browser. It's the move
detection from [ChessCam](https://www.chesscam.net), packaged on its own: a piece model (WebGPU, or the CPU in a
worker) and a move tracker that follows the game frame by frame and corrects misreads a few seconds on.

```ts
import { createRecorder, loadModel } from "@chesscam/recorder";

const model = await loadModel();
const recorder = createRecorder({
  model,
  video: document.querySelector("video")!,
  // The board's region of the video, in video pixels
  roi: { x: 438, y: 384, width: 444, height: 280 },
  onUpdate: (game) => showMoves(game.moves),
  onError: (error) => showStatus(error.code)
});
recorder.start();

// End & Save
recorder.pause();
const pgn = recorder.pgn({ White: "Alice", Black: "Bob", Event: "Club blitz" });
```

`examples/demo` is a working page: a camera or a video file, Start, and End & Save.

## Setup

**Bundler.** The CPU fallback runs in a worker, found with `new URL("./worker.js", import.meta.url)`, which Vite and
webpack follow. With Vite, keep the package out of dependency pre-bundling, which would move its files:

```ts
optimizeDeps: { exclude: ["@chesscam/recorder"] }
```

**The LiteRT.js runtime.** By default it loads from jsDelivr. Serve it yourself (copy
`node_modules/@litertjs/core/wasm/` and pass `loadModel({ wasmUrl })`) to work offline, and so the CPU fallback can use
threads: a browser only starts the runtime's threads from the page's own origin. It must be version `LITERT_VERSION`.

**Cross-origin isolation.** Threads also need these headers on the page. `credentialless` still lets the model load
from Hugging Face.

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

On the CPU in headless Chrome, a desktop managed about 1.4 frames a second on one thread and the cap of 4 with
threads.

**The model** loads from Hugging Face, pinned to a commit (`DEFAULT_MODEL_URL`), and can be self-hosted with
`loadModel({ modelUrl })`.

## Video sources

Anything a `<video>` can play and a page can read the pixels of: a camera (`getUserMedia`), a file (blob URL), a
WebRTC `MediaStream`, or HLS/DASH served with CORS and played with `crossOrigin="anonymous"`. A cross-origin iframe
(YouTube, Twitch) or DRM-protected video can't be read. Detection runs at up to `maxFps` frames a second (default 4),
scaled by the video's playback rate.

Start recording when the game starts: frames of anything else (title cards, an empty board, hands setting up) can be
read as moves.

## API

### `loadModel(options?): Promise<Model>`

Loads the model on WebGPU, or on the CPU in a worker if WebGPU is missing or fails, warmed up so the first frame is
quick. A page has one model: calling again gives the same one until it's deleted. If the browser takes the GPU away
(e.g. a backgrounded phone tab), the model reloads itself, on the CPU if the GPU won't come back.

| Option | |
|---|---|
| `modelUrl` | The `.tflite` model |
| `wasmUrl` | Where LiteRT.js's runtime is served, ending in `/` |
| `cpuOnly` | Skip WebGPU |

`model.accelerator` is `"webgpu"` or `"wasm"`.

### `createRecorder(options): Recorder`

Reads moves off the board until destroyed. It starts paused.

| Option | |
|---|---|
| `model`, `video` | Required |
| `roi` | The board's region, in video pixels. Without one the whole frame is read, which only works when the board fills it. |
| `start` | The start position as FEN |
| `timed` | Time each move, for `[%emt]` in the PGN (default true). Times are in recording time, which a pause stops. |
| `finalMovesOnly` | Report only moves that can't be taken back, about a second later; for moves that go straight to an online game |
| `maxFps` | Detections a second at normal speed (default 4) |
| `onUpdate(game)` | The game whenever its moves change |
| `onFps(fps \| null)` | The detection rate about once a second, and null once it stops |
| `onOrientation(corners)` | The board's corners clockwise from the region's top left, when it turns |
| `onDetect(detection)` | Each frame read |
| `onError(error)` | A frame failed; detection carries on with the next |

**A later update can change earlier moves.** When the tracker finds it misread a move (often a capture and recapture
that a hand over the board seemed to show), it replaces it. Keep the whole game from each `onUpdate`, not just the
newest move.

| Method | |
|---|---|
| `start()`, `pause()` | A pause counts as no time, for move times or for corrections |
| `game`, `running` | The game so far, and whether frames are being read |
| `setGame({ moves, start?, fromOpponent?, times? })` | Changes the game other than by the board, e.g. a takeback or an online opponent's move. The tracker starts again from it. |
| `reset(start?)` | A new game |
| `setRoi(roi)`, `setVideo(video)` | |
| `pgn(headers?)` | The game as PGN, with the seven standard tags, any extra headers, and `[%emt]` move times |
| `destroy()` | |

A game has `moves` (numbered SAN, e.g. `1. e4 e5 2. Nf3`), `fen`, `start`, `lastMove` (UCI), `fromOpponent` and
`times` (ms since recording started, per move).

### `readPosition(model, video, roi?, turn?)`

Reads the position on the board, averaged over three frames, to start a game somewhere other than the start position.
Gives `{ ok: true, fen }`, or `{ ok: false, problem }` when the board isn't a legal position (`"kings"`,
`"pawns-on-backrank"`, ...).

### Errors

`RecorderError` has a `code` for the app to show in its own words:

| Code | |
|---|---|
| `not-ready` | No model, or the video has no frame |
| `gpu-reset` | The GPU was lost and the model is reloading; detection carries on by itself |
| `reload-failed` | The model couldn't be reloaded after that |
| `worker-stopped` | The CPU worker crashed, e.g. out of memory |
| `unloaded` | The model was deleted |
| `detection-failed` | Anything else; see `message` |

## Development

```
npm install
npm run check   # tests, types, lint
npm run build   # dist/
```

To try the demo, run `npm install && npm run dev` in `examples/demo`. Add `?video=<url>&t=<start s>&roi=x,y,w,h` to play a
video, and `&wasm=<url>` to serve the runtime from the page's origin.

The code came from ChessCam's `src/vision` and `src/chess` at commit `880c130`. The tracker's settings are tuned on
replays of recorded games in ChessCam's research repo.

## Licence

MIT. Its dependencies have their own licences:

- [chessops](https://github.com/niklasf/chessops), for the chess rules, SAN, FEN and PGN, is GPL-3.0-or-later. An app
  that bundles this package bundles chessops too, so it must meet the GPL.
- [LiteRT.js](https://www.npmjs.com/package/@litertjs/core), which runs the model, is Apache-2.0.
- The default model, [chessq-chesscam](https://huggingface.co/PBatch23888/chessq-chesscam), is loaded at runtime, not
  shipped in the package, and is under the PolyForm Noncommercial License 1.0.0. Commercial use needs a separate
  licence for it.
