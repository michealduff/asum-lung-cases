'use strict';
// Shrinks a scan video on the device before upload: re-encodes to H.264 MP4 (plays on any
// phone or computer), at most 1280 px on the long side, 30 fps, no sound, with the bitrate
// chosen so the file stays under the upload limit. Uses Mediabunny (WebCodecs), loaded only
// when a video is added.

const MEDIABUNNY_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.6/dist/bundles/mediabunny.min.mjs';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const TARGET_BYTES = 44 * 1024 * 1024; // leave headroom under the 50 MB limit
const MAX_SIDE = 1280;
const MAX_BITRATE = 1_500_000;
const MIN_BITRATE = 350_000;

let mediabunnyLoading;
const loadMediabunny = () => (mediabunnyLoading = mediabunnyLoading || import(MEDIABUNNY_URL).catch((e) => {
  mediabunnyLoading = null;
  throw e;
}));

const canShrinkVideos = () => typeof window.VideoEncoder === 'function' && typeof window.VideoDecoder === 'function';

async function shrinkVideo(file, onProgress) {
  if (!canShrinkVideos()) throw new Error('This browser cannot shrink videos');
  const MB = await loadMediabunny();
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video found in this file');
  const duration = Math.max(1, await input.computeDuration());

  const longSide = Math.max(track.displayWidth, track.displayHeight);
  const scale = Math.min(1, MAX_SIDE / longSide);
  const width = Math.max(2, Math.round((track.displayWidth * scale) / 2) * 2);
  const bitrate = Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, (TARGET_BYTES * 8 * 0.95) / duration)));

  const output = new MB.Output({
    format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new MB.BufferTarget(),
  });
  const conversion = await MB.Conversion.init({
    input,
    output,
    video: { width, codec: 'avc', bitrate, frameRate: 30, forceTranscode: true },
    audio: { discard: true },
  });
  if (!conversion.isValid) {
    const why = (conversion.discardedTracks || []).map((t) => t.reason).join(', ');
    throw new Error(`This video can't be converted on this device${why ? ` (${why})` : ''}`);
  }
  conversion.onProgress = (p) => { if (onProgress) onProgress(Math.min(1, p)); };
  await conversion.execute();

  const name = `${file.name.replace(/\.[^.]+$/, '')}.mp4`;
  return new File([output.target.buffer], name, { type: 'video/mp4' });
}

// Keep the screen awake while a long clip is being processed (where supported).
async function keepAwake() {
  try { return await navigator.wakeLock.request('screen'); } catch { return null; }
}

// Photos of CXR/CT etc.: resize to at most 2000 px on the long side and save as JPEG.
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image'))), 'image/jpeg', 0.85));
  return { file: new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' }), width: w, height: h };
}
