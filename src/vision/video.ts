// Whether the video has a frame to read: a source (a camera or other MediaStream, a file, or a stream URL served with
// CORS), and a decoded frame that isn't mid-seek, when it may be from before the seek or half-decoded
export const videoReady = (video: HTMLVideoElement | null): video is HTMLVideoElement => {
  if (video === null || video.videoWidth === 0 || video.videoHeight === 0 || video.readyState < 2 || video.seeking) {
    return false;
  }
  return (video.srcObject !== null) || (video.currentSrc !== "");
}
