import { createRecorder, loadModel, type Recorder, type Roi } from "chesscam-recorder";

// ?video=<url> plays a video instead of the camera, ?t= starts it at that second, ?roi=x,y,w,h crops it to the board,
// ?rate= sets its speed, and ?wasm=<url> serves LiteRT.js's runtime from there instead of the CDN (from the page's own
// origin, the CPU fallback can use threads)
const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const status = $("status");
const roiParam = params.get("roi")?.split(",").map(Number);
const roi: Roi | null = (roiParam?.length === 4) ? { x: roiParam[0], y: roiParam[1], width: roiParam[2],
  height: roiParam[3] } : null;

const model = await loadModel({ wasmUrl: params.get("wasm") ?? undefined });
status.textContent = `Model loaded (${model.accelerator})`;

const recorder: Recorder = createRecorder({
  model, video, roi,
  onUpdate: (game) => {
    $("moves").textContent = game.moves;
  },
  onFps: (fps) => {
    status.textContent = (fps === null) ? "Paused" : `Recording, ${fps.toFixed(1)} frames a second (${model.accelerator})`;
  },
  onError: (error) => {
    status.textContent = `${error.code}: ${error.message}`;
  }
});

const ready = () => {
  $<HTMLButtonElement>("start").disabled = false;
  $<HTMLButtonElement>("end").disabled = false;
};

$("camera").onclick = async () => {
  video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  await video.play();
  ready();
};
$<HTMLInputElement>("file").onchange = (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file !== undefined) {
    video.src = URL.createObjectURL(file);
    video.controls = true;
    ready();
  }
};
$("start").onclick = () => {
  recorder.start();
  void video.play();
};
$("end").onclick = () => {
  recorder.pause();
  video.pause();
  $("pgn").textContent = recorder.pgn({ White: "White", Black: "Black", Date: new Date().toISOString().slice(0, 10).replaceAll("-", ".") });
};

const src = params.get("video");
if (src !== null) {
  video.src = src;
  video.currentTime = Number(params.get("t") ?? 0);
  video.playbackRate = Number(params.get("rate") ?? 1);
  ready();
}
// For automated checks
Object.assign(window, { recorder });
