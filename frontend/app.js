\
/* Tesla Browser Client Decode PoC
 * Loads an MP4 same-origin, decodes it in the browser, and renders
 * JPEG frames into an <img> (or canvas) while playing PCM via Web Audio.
 * A <video> element is NEVER shown — that is the Drive-mode bypass surface.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const frameEl = $("frame");
  const scratch = $("scratch");
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  const hiddenVideo = $("hiddenVideo");
  const btnPlay = $("btnPlay");
  const btnStop = $("btnStop");
  const statusEl = $("status");
  const clipList = $("clipList");
  const urlInput = $("urlInput");
  const attrBox = $("attribution");
  const attrText = $("attrText");
  const attrLicense = $("attrLicense");
  const attrSource = $("attrSource");

  const hud = {
    web: $("hWebCodecs"),
    renderer: $("hRenderer"),
    fps: $("hFps"),
    frames: $("hFrames"),
    audio: $("hAudio"),
    time: $("hTime"),
  };

  const TARGET_FPS = 10;
  const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

  let catalog = null;
  let selected = null; // {src, meta?}
  let playing = false;
  let stopRequested = false;
  let audioCtx = null;
  let audioSource = null;
  let objectUrl = null;
  let frameCount = 0;
  let fpsWindow = [];
  let rendererMode = "—";
  let webCodecsOk = !!(window.VideoDecoder && window.AudioDecoder && window.VideoFrame);

  hud.web.textContent = webCodecsOk ? "yes" : "no (canvas fallback)";
  hud.web.style.color = webCodecsOk ? "var(--ok)" : "var(--warn)";

  function setStatus(msg) { statusEl.textContent = msg; }

  function revokeObjectUrl() {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }

  function showAttribution(meta) {
    if (!meta) { attrBox.hidden = true; return; }
    attrText.textContent = `${meta.artist} — "${meta.title}" (${meta.attribution || meta.artist}, ${meta.license})`;
    attrLicense.href = meta.licenseUrl || "#";
    attrLicense.textContent = meta.license;
    attrSource.href = meta.sourceUrl || "#";
    attrBox.hidden = false;
  }

  function resetHud() {
    frameCount = 0;
    fpsWindow = [];
    hud.frames.textContent = "0";
    hud.fps.textContent = "—";
    hud.time.textContent = "0.0s";
    hud.renderer.textContent = "—";
    hud.audio.textContent = "—";
  }

  function tickFps() {
    const now = performance.now();
    fpsWindow.push(now);
    while (fpsWindow.length && now - fpsWindow[0] > 1000) fpsWindow.shift();
    hud.fps.textContent = String(fpsWindow.length);
    hud.frames.textContent = String(frameCount);
  }

  async function pushFrameFromCanvas() {
    // Prefer Blob URL into <img> — that's the Drive-mode bypass surface.
    return new Promise((resolve) => {
      if (scratch.toBlob) {
        scratch.toBlob((blob) => {
          if (!blob) { resolve(false); return; }
          revokeObjectUrl();
          objectUrl = URL.createObjectURL(blob);
          frameEl.src = objectUrl;
          frameCount++;
          tickFps();
          resolve(true);
        }, "image/jpeg", 0.7);
      } else {
        frameEl.src = scratch.toDataURL("image/jpeg", 0.7);
        frameCount++;
        tickFps();
        resolve(true);
      }
    });
  }

  function ensureAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function stopAudio() {
    try { if (audioSource) { audioSource.stop(0); } } catch (_) {}
    audioSource = null;
  }

  async function playDecodedAudioBuffer(buffer) {
    const ctx = ensureAudioCtx();
    stopAudio();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
    audioSource = src;
    hud.audio.textContent = `WebAudio ${buffer.sampleRate}Hz / ${buffer.numberOfChannels}ch`;
    return new Promise((resolve) => {
      src.onended = () => resolve();
    });
  }

  /* ---------- Canvas / <video> fallback path (Tesla-friendly) ---------- */
  async function playViaCanvas(url) {
    rendererMode = "canvas → JPEG <img> (not <video>)";
    hud.renderer.textContent = rendererMode;
    hud.renderer.style.color = "var(--ok)";

    const v = hiddenVideo;
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.crossOrigin = "anonymous";
    v.muted = true; // audio comes from Web Audio, not the element
    v.playsInline = true;
    v.src = url;

    await new Promise((resolve, reject) => {
      const onMeta = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error("video load failed (CORS or unsupported codec)")); };
      const cleanup = () => {
        v.removeEventListener("loadedmetadata", onMeta);
        v.removeEventListener("error", onErr);
      };
      v.addEventListener("loadedmetadata", onMeta);
      v.addEventListener("error", onErr);
    });

    // Decode audio separately so we can play it via Web Audio while the
    // visible path is only JPEG frames.
    let audioDone = Promise.resolve();
    try {
      const ab = await fetch(url).then((r) => {
        if (!r.ok) throw new Error("audio fetch " + r.status);
        return r.arrayBuffer();
      });
      const ctx = ensureAudioCtx();
      const decoded = await ctx.decodeAudioData(ab.slice(0));
      audioDone = playDecodedAudioBuffer(decoded);
    } catch (e) {
      console.warn("decodeAudioData failed, falling back to element audio", e);
      v.muted = false;
      hud.audio.textContent = "element audio (fallback)";
    }

    // Size the scratch canvas to the video.
    const w = v.videoWidth || 1280;
    const h = v.videoHeight || 720;
    scratch.width = w;
    scratch.height = h;
    frameEl.width = w;
    frameEl.height = h;

    await v.play().catch(() => {}); // may be blocked if unmuted; we keep muted

    setStatus("Playing (canvas → JPEG <img>)");
    btnStop.disabled = false;

    let lastCapture = 0;
    await new Promise((resolve) => {
      const loop = async (ts) => {
        if (stopRequested || v.ended || v.paused) {
          resolve();
          return;
        }
        if (ts - lastCapture >= FRAME_INTERVAL_MS - 2) {
          lastCapture = ts;
          scratchCtx.drawImage(v, 0, 0, scratch.width, scratch.height);
          await pushFrameFromCanvas();
          hud.time.textContent = v.currentTime.toFixed(1) + "s";
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      // Also end when audio finishes if video somehow stalls.
      audioDone.then(() => { if (!stopRequested) resolve(); });
    });
  }

  /* ---------- WebCodecs path (modern Chromium) ---------- */
  async function playViaWebCodecs(url) {
    if (typeof MP4Box === "undefined") throw new Error("mp4box missing");
    rendererMode = "WebCodecs → canvas → JPEG <img>";
    hud.renderer.textContent = rendererMode;
    hud.renderer.style.color = "var(--ok)";

    const ab = await fetch(url).then((r) => {
      if (!r.ok) throw new Error("fetch " + r.status);
      return r.arrayBuffer();
    });

    // MP4Box wants a buffer with a fileStart property.
    const file = MP4Box.createFile();
    let videoTrack = null;
    let audioTrack = null;
    let videoDecoder = null;
    let audioDecoder = null;
    const videoFrames = []; // {timestamp_us, bitmap/canvas ready?}
    const audioChunks = [];
    let videoDesc = null;
    let audioDesc = null;
    let readyResolve;
    const ready = new Promise((r) => { readyResolve = r; });

    file.onError = (e) => console.error("mp4box", e);
    file.onReady = (info) => {
      videoTrack = info.videoTracks[0] || null;
      audioTrack = info.audioTracks[0] || null;
      if (videoTrack) {
        file.setExtractionOptions(videoTrack.id, "video", { nbSamples: 100 });
        const trak = file.getTrackById(videoTrack.id);
        // AVCDecoderConfigurationRecord from avcC
        const entry = trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stsd && trak.mdia.minf.stbl.stsd.entries[0];
        if (entry && entry.avcC) {
          videoDesc = entry.avcC;
        }
      }
      if (audioTrack) {
        file.setExtractionOptions(audioTrack.id, "audio", { nbSamples: 100 });
      }
      file.start();
      readyResolve(info);
    };

    const samples = { video: [], audio: [] };
    let extractDone = false;
    file.onSamples = (id, user, sampleList) => {
      const kind = user;
      for (const s of sampleList) samples[kind].push(s);
    };

    // Feed the whole file.
    const buf = ab;
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
    await ready;

    // Wait briefly for samples to flush.
    await new Promise((r) => setTimeout(r, 50));
    extractDone = true;

    if (!videoTrack || !samples.video.length) {
      throw new Error("no video samples — falling back");
    }

    // Build description bytes for avcC if available.
    let description;
    try {
      if (videoDesc) {
        // mp4box exposes avcC as a box; use DataStream to serialize if present
        if (videoDesc.data) description = videoDesc.data;
        else if (typeof DataStream !== "undefined") {
          const stream = new DataStream();
          stream.endianness = DataStream.BIG_ENDIAN;
          videoDesc.write(stream);
          // skip the 8-byte box header
          description = new Uint8Array(stream.buffer).slice(8);
        }
      }
    } catch (e) {
      console.warn("avcC serialize failed", e);
    }

    const codec = (videoTrack.codec || "avc1.42E01E");
    const w = videoTrack.track_width || 1280;
    const h = videoTrack.track_height || 720;
    scratch.width = w; scratch.height = h;
    frameEl.width = w; frameEl.height = h;

    const decodedFrames = []; // {t_us, frame: VideoFrame}
    videoDecoder = new VideoDecoder({
      output: (frame) => { decodedFrames.push(frame); },
      error: (e) => console.error("VideoDecoder", e),
    });
    const config = { codec, codedWidth: w, codedHeight: h };
    if (description) config.description = description;
    try {
      videoDecoder.configure(config);
    } catch (e) {
      throw new Error("VideoDecoder.configure failed: " + e.message);
    }

    for (const s of samples.video) {
      const chunk = new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: s.cts * (1e6 / (videoTrack.timescale || 1000)),
        duration: s.duration * (1e6 / (videoTrack.timescale || 1000)),
        data: s.data,
      });
      try { videoDecoder.decode(chunk); } catch (e) { console.warn(e); }
    }
    await videoDecoder.flush();

    // Audio via decodeAudioData (simpler + more compatible than AudioDecoder for AAC).
    let audioPromise = Promise.resolve();
    try {
      const ctx = ensureAudioCtx();
      const decoded = await ctx.decodeAudioData(ab.slice(0));
      // We'll start audio when the first frame is shown.
      audioPromise = Promise.resolve(decoded);
    } catch (e) {
      console.warn("audio decode failed", e);
      hud.audio.textContent = "none";
    }

    setStatus("Playing (WebCodecs → JPEG <img>)");
    btnStop.disabled = false;

    // Sort frames by timestamp and present at TARGET_FPS (drop extras).
    decodedFrames.sort((a, b) => a.timestamp - b.timestamp);
    const audioBuffer = await audioPromise;
    const t0 = performance.now();
    if (audioBuffer) {
      // fire and forget; stopAudio handles teardown
      playDecodedAudioBuffer(audioBuffer);
    }

    let i = 0;
    let lastPresent = -FRAME_INTERVAL_MS;
    while (i < decodedFrames.length && !stopRequested) {
      const now = performance.now() - t0;
      if (now - lastPresent < FRAME_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, 4));
        continue;
      }
      // Find the frame closest to `now` in media time (timestamps are µs).
      const targetUs = now * 1000;
      while (i + 1 < decodedFrames.length && decodedFrames[i + 1].timestamp <= targetUs) {
        decodedFrames[i].close();
        i++;
      }
      const f = decodedFrames[i];
      scratchCtx.drawImage(f, 0, 0, scratch.width, scratch.height);
      f.close();
      i++;
      lastPresent = now;
      await pushFrameFromCanvas();
      hud.time.textContent = (now / 1000).toFixed(1) + "s";
    }
    while (i < decodedFrames.length) { decodedFrames[i].close(); i++; }
    try { videoDecoder.close(); } catch (_) {}
  }

  /* ---------- Orchestration ---------- */
  async function playSelected() {
    if (!selected || !selected.src) return;
    stopRequested = false;
    playing = true;
    btnPlay.disabled = true;
    btnStop.disabled = false;
    resetHud();
    setStatus("Loading…");
    showAttribution(selected.meta || null);

    try {
      // Prefer WebCodecs when available; fall back to canvas on any failure.
      if (webCodecsOk) {
        try {
          await playViaWebCodecs(selected.src);
        } catch (e) {
          console.warn("WebCodecs path failed, using canvas fallback:", e);
          hud.web.textContent = "failed → canvas";
          if (!stopRequested) await playViaCanvas(selected.src);
        }
      } else {
        await playViaCanvas(selected.src);
      }
      if (!stopRequested) setStatus("Finished");
    } catch (e) {
      console.error(e);
      setStatus("Error: " + (e && e.message ? e.message : e));
    } finally {
      playing = false;
      btnPlay.disabled = !selected;
      btnStop.disabled = true;
      try { hiddenVideo.pause(); } catch (_) {}
      stopAudio();
      revokeObjectUrl();
    }
  }

  function stopPlayback() {
    stopRequested = true;
    try { hiddenVideo.pause(); } catch (_) {}
    stopAudio();
    setStatus("Stopped");
  }

  function selectClip(clip) {
    selected = { src: clip.src, meta: clip };
    [...clipList.querySelectorAll(".clip")].forEach((b) => {
      b.classList.toggle("selected", b.dataset.slug === clip.slug);
    });
    urlInput.value = "";
    btnPlay.disabled = false;
    showAttribution(clip);
    setStatus("Ready — " + clip.artist);
  }

  function selectUrl(url) {
    if (!url) return;
    selected = { src: url, meta: null };
    [...clipList.querySelectorAll(".clip")].forEach((b) => b.classList.remove("selected"));
    btnPlay.disabled = false;
    showAttribution(null);
    setStatus("Ready — custom URL (needs CORS)");
  }

  async function boot() {
    catalog = await fetch("catalog.json").then((r) => r.json());
    for (const c of catalog.clips) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "clip";
      btn.dataset.slug = c.slug;
      btn.innerHTML = `<div class="title">${c.artist} — ${c.title}</div>
        <div class="meta">${c.description} · ${c.license} · ${c.segment}</div>`;
      btn.addEventListener("click", () => selectClip(c));
      clipList.appendChild(btn);
    }
    const def = catalog.clips.find((c) => c.slug === catalog.defaultClip) || catalog.clips[0];
    if (def) selectClip(def);

    urlInput.addEventListener("change", () => selectUrl(urlInput.value.trim()));
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") selectUrl(urlInput.value.trim());
    });
    btnPlay.addEventListener("click", () => { if (!playing) playSelected(); });
    btnStop.addEventListener("click", stopPlayback);
  }

  boot().catch((e) => setStatus("Boot error: " + e.message));
})();
