# @chesscam/recorder

[![npm](https://img.shields.io/npm/v/@chesscam/recorder)](https://www.npmjs.com/package/@chesscam/recorder)

Point a camera at a real chess board and get the moves as they're played. Everything runs in the browser: no server,
no uploads.

This is the move detection from [ChessCam](https://www.chesscam.net), as a library. It works with a live camera, a
video file or a video stream.

## Install

```
npm install @chesscam/recorder
```

## Quick start

```ts
import { createRecorder, loadModel } from "@chesscam/recorder";

// 1. Load the model (about 24 MB, downloaded once)
const model = await loadModel();

// 2. Point a recorder at a <video> showing the board
const recorder = createRecorder({
  model,
  video: document.querySelector("video")!,
  roi: { x: 438, y: 384, width: 444, height: 280 }, // where the board is, in video pixels
  onUpdate: (game) => console.log(game.moves)       // e.g. "1. e4 e5 2. Nf3"
});

// 3. Start recording when the game starts
recorder.start();

// 4. When the game ends, stop and save it as PGN
recorder.pause();
const pgn = recorder.pgn({ White: "Alice", Black: "Bob" });
```

For a full working page with a camera or video file, see [`examples/demo`](examples/demo).

## Good to know

- **Tell it where the board is.** `roi` is the rectangle around the board in the video. Without it the whole frame is
  used, which only works if the board fills the picture.
- **Start when the game starts.** Anything else on camera (an empty board, hands setting up the pieces) can be mistaken
  for moves.
- **Earlier moves can change.** If the recorder realises it misread a move, often because a hand was in the way, it
  fixes it a few seconds later. Always show the whole `game.moves` from each `onUpdate`, not just the newest move.
- **Which videos work.** Anything a `<video>` element can play and the page can read the pixels of: a camera, a local
  file, a WebRTC stream, or HLS/DASH served with CORS. YouTube or Twitch embeds and DRM-protected video can't be read.

## Setup with a bundler

The model runs in a web worker, which Vite and webpack pick up automatically. With Vite, add this to your config so the
worker file is found:

```ts
optimizeDeps: { exclude: ["@chesscam/recorder"] }
```

## Making it faster (optional)

By default the model runs on one thread, about 6 frames a second on a Pixel 7a. That's already more than the 4 frames
a second it reads by default. To use up to four threads (about 15 frames a second):

1. Send these headers with your page:

   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: credentialless
   ```

2. Serve the LiteRT.js runtime from your own site: copy `node_modules/@litertjs/core/wasm/` into your public files and
   pass its URL with `loadModel({ wasmUrl: "/litert/" })`. It must be version `LITERT_VERSION`.

Serving the runtime yourself also lets the recorder work offline. You can host the model file yourself too, with
`loadModel({ modelUrl })`. By default it comes from Hugging Face.

## API

### `loadModel(options?)`

Loads the model and returns a promise of it. Calling it again returns the same model.

| Option | What it does |
|---|---|
| `modelUrl` | Load the `.tflite` model from here instead of Hugging Face |
| `wasmUrl` | Load the LiteRT.js runtime from here (a folder URL ending in `/`) instead of jsDelivr |

### `createRecorder(options)`

Creates a recorder. It starts paused; call `start()` to begin.

| Option | What it does |
|---|---|
| `model` | The model from `loadModel()` (required) |
| `video` | The `<video>` element to read (required) |
| `roi` | Where the board is: `{ x, y, width, height }` in video pixels |
| `start` | The starting position as FEN, if not the normal start |
| `timed` | Record how long each move took, saved in the PGN (default `true`) |
| `finalMovesOnly` | Only report moves once they're certain, about 1.5 s after they're played. Useful when sending moves to an online game. |
| `maxFps` | How many frames a second to read (default 4) |
| `onUpdate(game)` | Called whenever the moves change |
| `onError(error)` | Called when a frame fails. Recording carries on. |
| `onFps(fps)` | The current frame rate, about once a second (`null` once it stops) |
| `onOrientation(corners)` | Called when it works out which way round the board is |
| `onDetect(detection)` | Called with the raw result of every frame |

A recorder has these methods and properties:

| | What it does |
|---|---|
| `start()` / `pause()` | Start or pause reading. Paused time doesn't count towards move times. |
| `game` | The game so far |
| `running` | Whether it's currently reading frames |
| `pgn(headers?)` | The game as PGN text, with any headers you pass (e.g. `White`, `Event`) |
| `reset(start?)` | Start a new game |
| `setGame({ moves, start?, fromOpponent?, times? })` | Replace the game yourself, e.g. for a takeback or an online opponent's move |
| `setRoi(roi)` / `setVideo(video)` | Change where the board is, or which video to read |
| `destroy()` | Stop and clean up |

A **game** has:

| | |
|---|---|
| `moves` | The moves so far, e.g. `"1. e4 e5 2. Nf3"` |
| `fen` | The current position |
| `start` | The starting position |
| `lastMove` | The last move, e.g. `"g1f3"` |
| `fromOpponent` | Whether the last move came from `setGame` rather than the board |
| `times` | When each move was played, in ms since recording started |

### `readPosition(model, video, roi?, turn?)`

Reads the current position from the board, to start recording a game that's already under way. Returns
`{ ok: true, fen }`, or `{ ok: false, problem }` if the board doesn't show a legal position (e.g. `"kings"`,
`"pawns-on-backrank"`).

### Errors

Errors are a `RecorderError` with a `code`, so you can show your own message:

| Code | Meaning |
|---|---|
| `not-ready` | The model isn't loaded or the video hasn't got a frame yet |
| `worker-stopped` | The model's worker crashed, e.g. out of memory |
| `unloaded` | The model was deleted |
| `detection-failed` | Something else went wrong; see `error.message` |

### Games, moves and rules

For apps that keep the game themselves (e.g. in a store) and pass changes to the recorder with `setGame`:

| Export | |
|---|---|
| `newGame(start?)`, `makePgn(game, headers?)` | A game with no moves, and a game as PGN |
| `makeBoard(game)`, `GameBoard` | The board after a game's moves, to play more (`playSan`, `playUci`, `undo`) and read its `moves`, `fen`, `history` |
| `makeUpdatePayload(board, fromOpponent?)` | A board's `moves`, `fen`, `lastMove` and `fromOpponent`, for a `Game` |
| `getMoveText(board)` | The last one or two moves, numbered, e.g. `3...Nc6 4.Bb5` |
| `replay(probs, fps, start?)` | Runs saved model outputs through the tracking, frame by frame, giving the moves and when each was played; for scoring the tracking on recorded games |

The chess rules are exported too: `Position` (legal moves, `play`, `isCheck`, `outcome`, `fen()`), `parseFen`,
`makeFen`, `parseSan`, `makeSan`, `parseUci`, `makeUci`, and the types `Color`, `Role`, `Piece`, `Square`,
`SquareName` and `Move`. Castling is the king's two-square move, e.g. `e1g1`.

## Development

```
npm install
npm run check   # tests, types, lint
npm run build   # builds dist/
```

To run the demo: `cd examples/demo && npm install && npm run dev`. You can add `?video=<url>&t=<start s>&roi=x,y,w,h`
to the URL to play a video, and `&wasm=<url>` to load the runtime from the page's own site.

The code came from ChessCam's `src/vision` and `src/chess` at commit `880c130`. The tracker's settings are tuned on
replays of recorded games in ChessCam's research repo.

To release: bump `version` in `package.json`, commit and push, then publish a GitHub release tagged `v<version>`
(e.g. `v0.1.1`). `.github/workflows/publish.yml` publishes it to npm with trusted publishing, so no npm token is
needed.

## Licence

MIT. The chess rules, SAN, FEN and PGN code is its own (`src/rules`). Its dependencies have their own licences:

- [LiteRT.js](https://www.npmjs.com/package/@litertjs/core), which runs the model, is Apache-2.0.
- The default model, [chessq-chesscam](https://huggingface.co/PBatch23888/chessq-chesscam), is downloaded at runtime,
  not included in the package. It is under the PolyForm Noncommercial License 1.0.0, so commercial use needs a
  separate licence for it.
