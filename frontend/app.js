/* Tesla Browser Client Decode PoC — Drive-safe + CloudWatch client logs
 * Paths: pack (recommended) | WebCodecs (10s timeout → pack) | ?allowVideo=1 debug
 * Zero <video> unless allowVideo=1.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const ALLOW_VIDEO = params.get("allowVideo") === "1" || params.get("allowvideo") === "1";
  const FORCE_PACK = params.get("pack") === "1";
  const PREFER_PACK = params.get("preferPack") !== "0"; // default prefer pack in car
  const FORCE_DRIVE = params.get("drive") === "1";
  const TRY_WC = params.get("wc") === "1"; // opt-in: WebCodecs first (car stalls; pack is default)
  const CFG = window.POC_CONFIG || {};
  const LOGS_URL = CFG.logsUrl || "/api/logs";
  const WC_TIMEOUT_MS = CFG.webCodecsTimeoutMs || 10000;

  const SESSION_ID = (function () {
    try {
      const k = "pocSessionId";
      let id = sessionStorage.getItem(k);
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) ||
          ("s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
        sessionStorage.setItem(k, id);
      }
      return id;
    } catch (_) {
      return "s-" + Date.now().toString(36);
    }
  })();

  const frameEl = $("frame");
  const scratch = $("scratch");
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  const btnPlay = $("btnPlay");
  const btnStop = $("btnStop");
  const btnPlayAll = $("btnPlayAll");
  const btnForcePack = $("btnForcePack");
  const chkLoop = $("chkLoop");
  const statusEl = $("status");
  const loadStatusEl = $("loadStatus");
  const clipList = $("clipList");
  const urlInput = $("urlInput");
  const attrBox = $("attribution");
  const attrText = $("attrText");
  const attrLicense = $("attrLicense");
  const attrSource = $("attrSource");
  const nowPlaying = $("nowPlaying");
  const nowPlayingText = $("nowPlayingText");
  const nowPlayingPos = $("nowPlayingPos");
  const capsGrid = $("capsGrid");
  const sessionIdDisplay = $("sessionIdDisplay");

  const hud = {
    web: $("hWebCodecs"),
    path: $("hPath"),
    renderer: $("hRenderer"),
    fps: $("hFps"),
    frames: $("hFrames"),
    audio: $("hAudio"),
    videoEl: $("hVideoEl"),
    time: $("hTime"),
  };

  const TARGET_FPS = 10;
  const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

  const hasVideoDecoder = typeof VideoDecoder !== "undefined";
  const hasAudioDecoder = typeof AudioDecoder !== "undefined";
  const hasVideoFrame = typeof VideoFrame !== "undefined";
  const hasEncodedVideoChunk = typeof EncodedVideoChunk !== "undefined";
  const hasOffscreenCanvas = typeof OffscreenCanvas !== "undefined";
  const hasMP4Box = typeof MP4Box !== "undefined";
  const webCodecsOk = hasVideoDecoder && hasVideoFrame && hasEncodedVideoChunk && hasMP4Box;

  let catalog = null;
  let selected = null;
  let playing = false;
  let stopRequested = false;
  let playlistMode = false;
  let playlistActive = false;
  let playlistIndex = 0;
  let forcePackMode = FORCE_PACK || PREFER_PACK;
  let audioCtx = null;
  let audioSource = null;
  let objectUrl = null;
  let frameCount = 0;
  let fpsWindow = [];
  let hiddenVideo = null;
  let currentClip = null;
  let currentPath = "—";
  let currentStage = "idle";
  let playGen = 0;          // bumps on every new attempt; zombie loops check it
  let paintedCount = 0;     // frames actually loaded+shown by <img>
  let assignedCount = 0;    // frames we tried to show
  function isAborted(gen) { return stopRequested || gen !== playGen; }

  /* ---------- CloudWatch client logger ---------- */
  const logQueue = [];
  let flushTimer = null;
  let flushing = false;

  function cwLog(level, event, fields) {
    const row = Object.assign({
      ts: Date.now(),
      level: level || "info",
      event: event || "log",
      stage: currentStage,
      path: currentPath,
      clip: currentClip ? currentClip.slug : null,
      sessionId: SESSION_ID,
      ua: navigator.userAgent,
      msg: (fields && fields.msg) || undefined,
    }, fields || {});
    try {
      const line = "[" + row.level + "] " + row.event + (row.stage ? " @" + row.stage : "") + (row.msg ? " " + row.msg : "");
      if (level === "error") console.error(line, row);
      else if (level === "warn") console.warn(line, row);
      else console.log(line, row);
    } catch (_) {}
    logQueue.push(row);
    if (logQueue.length >= 20) flushLogs();
    else if (!flushTimer) flushTimer = setTimeout(flushLogs, 2000);
  }

  function flushLogs() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!logQueue.length || flushing) return;
    flushing = true;
    const batch = logQueue.splice(0, 100);
    const body = JSON.stringify({ sessionId: SESSION_ID, lines: batch });
    const url = LOGS_URL;
    let sent = false;
    try {
      if (navigator.sendBeacon && batch.length <= 10) {
        sent = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      }
    } catch (_) {}
    if (!sent) {
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body,
        keepalive: true,
      }).catch(function () {});
    }
    flushing = false;
    if (logQueue.length) flushTimer = setTimeout(flushLogs, 500);
  }

  window.addEventListener("pagehide", flushLogs);
  window.addEventListener("beforeunload", flushLogs);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushLogs();
  });

  function setStage(stage, extra) {
    currentStage = stage;
    if (loadStatusEl) loadStatusEl.textContent = stage;
    cwLog("info", "stage", Object.assign({ stage: stage, msg: stage }, extra || {}));
    setStatus(stage);
  }

  function setStatus(msg) { statusEl.textContent = msg; }

  function setPath(label, ok) {
    currentPath = label;
    hud.path.textContent = label;
    hud.path.style.color = ok ? "var(--ok)" : "var(--warn)";
  }

  function countVideoEls() { return document.querySelectorAll("video").length; }

  function refreshVideoElHud() {
    const n = countVideoEls();
    hud.videoEl.textContent = String(n);
    hud.videoEl.style.color = n === 0 ? "var(--ok)" : "var(--warn)";
  }

  function revokeObjectUrl() {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }

  function showAttribution(meta) {
    if (!meta) { attrBox.hidden = true; return; }
    attrText.textContent = meta.artist + ' — "' + meta.title + '" (' + (meta.attribution || meta.artist) + ", " + meta.license + ")";
    attrLicense.href = meta.licenseUrl || "#";
    attrLicense.textContent = meta.license;
    attrSource.href = meta.sourceUrl || "#";
    attrBox.hidden = false;
  }

  function resetHud() {
    frameCount = 0;
    paintedCount = 0;
    assignedCount = 0;
    imgBusy = false;
    fpsWindow = [];
    hud.frames.textContent = "0";
    hud.fps.textContent = "—";
    hud.time.textContent = "0.0s";
    hud.renderer.textContent = "—";
    hud.audio.textContent = "—";
    refreshVideoElHud();
  }

  function tickFps() {
    const now = performance.now();
    fpsWindow.push(now);
    while (fpsWindow.length && now - fpsWindow[0] > 1000) fpsWindow.shift();
    hud.fps.textContent = String(fpsWindow.length);
    hud.frames.textContent = String(frameCount);
  }

  // Paint path: only count a frame once the <img> has actually loaded it.
  // Never assign a new src while the previous one is still loading (that aborts
  // the in-flight load and the picture freezes while counters keep ticking).
  let imgBusy = false;
  let prevObjectUrl = null;
  frameEl.decoding = "sync";
  frameEl.addEventListener("load", function () {
    imgBusy = false;
    paintedCount++;
    frameCount = paintedCount;
    tickFps();
    if (prevObjectUrl) { URL.revokeObjectURL(prevObjectUrl); prevObjectUrl = null; }
  });
  frameEl.addEventListener("error", function () {
    imgBusy = false;
    cwLog("warn", "error", { msg: "img load error " + String(frameEl.src).slice(-40) });
  });

  function setImgSrc(url, isObjectUrl) {
    if (imgBusy) return false;            // drop frame, keep the current picture
    imgBusy = true;
    assignedCount++;
    if (isObjectUrl) { prevObjectUrl = objectUrl; objectUrl = url; }
    frameEl.src = url;
    return true;
  }

  let blobBusy = false;
  async function pushFrameFromCanvas(gen) {
    if (gen !== undefined && isAborted(gen)) return false;
    if (blobBusy || imgBusy) return false;  // backpressure: skip, don't queue
    blobBusy = true;
    return new Promise(function (resolve) {
      if (scratch.toBlob) {
        scratch.toBlob(function (blob) {
          blobBusy = false;
          if (!blob || (gen !== undefined && isAborted(gen))) { resolve(false); return; }
          resolve(setImgSrc(URL.createObjectURL(blob), true));
        }, "image/jpeg", 0.7);
      } else {
        blobBusy = false;
        resolve(setImgSrc(scratch.toDataURL("image/jpeg", 0.7), false));
      }
    });
  }

  function ensureAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("Web Audio API unavailable");
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function stopAudio() {
    try { if (audioSource) audioSource.stop(0); } catch (_) {}
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
    hud.audio.textContent = "WebAudio " + buffer.sampleRate + "Hz / " + buffer.numberOfChannels + "ch";
    return new Promise(function (resolve) { src.onended = function () { resolve(); }; });
  }

  async function playPcmS16le(arrayBuffer, sampleRate, channels) {
    const ctx = ensureAudioCtx();
    const samples = arrayBuffer.byteLength / 2;
    const frames = Math.floor(samples / channels);
    const audioBuffer = ctx.createBuffer(channels, frames, sampleRate);
    const view = new DataView(arrayBuffer);
    for (let ch = 0; ch < channels; ch++) {
      const out = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        out[i] = view.getInt16((i * channels + ch) * 2, true) / 32768;
      }
    }
    return playDecodedAudioBuffer(audioBuffer);
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const t = setTimeout(function () {
        if (done) return;
        done = true;
        const err = new Error((label || "operation") + " timed out after " + ms + "ms");
        err.code = "TIMEOUT";
        reject(err);
      }, ms);
      promise.then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      }, function (e) {
        if (done) return;
        done = true;
        clearTimeout(t);
        reject(e);
      });
    });
  }

  /* ---------- Capability probe ---------- */
  function renderCaps() {
    if (sessionIdDisplay) sessionIdDisplay.textContent = SESSION_ID;
    const rows = [
      ["VideoDecoder", hasVideoDecoder],
      ["AudioDecoder", hasAudioDecoder],
      ["VideoFrame", hasVideoFrame],
      ["EncodedVideoChunk", hasEncodedVideoChunk],
      ["OffscreenCanvas", hasOffscreenCanvas],
      ["MP4Box demux", hasMP4Box],
      ["Web Audio", !!(window.AudioContext || window.webkitAudioContext)],
      ["allowVideo flag", ALLOW_VIDEO && !FORCE_DRIVE],
      ["<video> in DOM", countVideoEls() > 0],
      ["Live WebCodecs path", webCodecsOk],
      ["preferPack", forcePackMode],
    ];
    capsGrid.innerHTML = "";
    rows.forEach(function (pair) {
      const k = pair[0], v = pair[1];
      const div = document.createElement("div");
      let cls = v ? "cap-ok" : "cap-no";
      if (k === "<video> in DOM" || k === "allowVideo flag") cls = v ? "cap-no" : "cap-ok";
      if (k === "preferPack") cls = "cap-ok";
      div.innerHTML = '<span class="cap-k">' + k + '</span><span class="' + cls + '">' + (v ? "yes" : "no") + "</span>";
      capsGrid.appendChild(div);
    });
    hud.web.textContent = webCodecsOk ? "yes" : "no";
    hud.web.style.color = webCodecsOk ? "var(--ok)" : "var(--warn)";
    refreshVideoElHud();
    cwLog("info", "probe", {
      msg: "capability probe",
      videoDecoder: hasVideoDecoder,
      audioDecoder: hasAudioDecoder,
      videoFrame: hasVideoFrame,
      encodedVideoChunk: hasEncodedVideoChunk,
      offscreenCanvas: hasOffscreenCanvas,
      mp4box: hasMP4Box,
      webCodecsOk: webCodecsOk,
      preferPack: forcePackMode,
      videoEls: countVideoEls(),
    });
  }

  /* ---------- WebCodecs ---------- */
  function getAvcDescription(file, trackId) {
    const trak = file.getTrackById(trackId);
    if (!trak) return null;
    const entries = (((trak.mdia || {}).minf || {}).stbl || {}).stsd
      ? trak.mdia.minf.stbl.stsd.entries : [];
    for (let i = 0; i < (entries || []).length; i++) {
      const entry = entries[i];
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (!box) continue;
      if (box.data) return box.data;
      if (typeof DataStream === "undefined") continue;
      try {
        const stream = new DataStream();
        stream.endianness = DataStream.BIG_ENDIAN;
        box.write(stream);
        return new Uint8Array(stream.buffer, 8);
      } catch (e) {
        cwLog("warn", "decoder_error", { msg: "avcC serialize failed: " + e.message });
      }
    }
    return null;
  }

  async function demuxMp4(url) {
    setStage("fetch mp4…");
    const t0 = performance.now();
    const ab = await fetch(url).then(function (r) {
      if (!r.ok) throw new Error("fetch " + r.status);
      return r.arrayBuffer();
    });
    cwLog("info", "stage", { stage: "fetch mp4 done", msg: "fetched " + ab.byteLength + " bytes in " + Math.round(performance.now() - t0) + "ms" });

    setStage("demux…");
    const file = MP4Box.createFile();
    const samples = { video: [], audio: [] };
    let infoResolve, infoReject;
    const infoP = new Promise(function (r, j) { infoResolve = r; infoReject = j; });
    file.onError = function (e) {
      cwLog("error", "error", { msg: "mp4box error: " + e });
      infoReject(new Error("mp4box: " + e));
    };
    file.onReady = function (info) {
      const vt = info.videoTracks[0];
      const at = info.audioTracks[0];
      if (vt) file.setExtractionOptions(vt.id, "video", { nbSamples: Infinity });
      if (at) file.setExtractionOptions(at.id, "audio", { nbSamples: Infinity });
      file.start();
      infoResolve(info);
    };
    file.onSamples = function (id, user, list) {
      for (let i = 0; i < list.length; i++) samples[user].push(list[i]);
    };
    const buf = ab;
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
    const info = await infoP;
    await new Promise(function (r) { setTimeout(r, 30); });
    if (typeof file.stop === "function") file.stop();
    cwLog("info", "stage", {
      stage: "demux done",
      msg: "videoSamples=" + samples.video.length + " audioSamples=" + samples.audio.length,
      codec: info.videoTracks[0] && info.videoTracks[0].codec,
    });
    return { ab: ab, file: file, info: info, samples: samples };
  }

  async function playViaWebCodecs(url, gen, onFetched) {
    if (!webCodecsOk) throw new Error("WebCodecs unavailable");
    setPath("WebCodecs", true);
    hud.renderer.textContent = "WebCodecs → canvas → JPEG <img>";
    hud.renderer.style.color = "var(--ok)";
    refreshVideoElHud();

    const demuxed = await demuxMp4(url);
    if (onFetched) onFetched();
    if (isAborted(gen)) return;
    const videoTrack = demuxed.info.videoTracks[0];
    if (!videoTrack || !demuxed.samples.video.length) throw new Error("no video samples in MP4");

    setStage("configure VideoDecoder…");
    const description = getAvcDescription(demuxed.file, videoTrack.id);
    const codec = videoTrack.codec || "avc1.42E01E";
    const w = videoTrack.track_width || 1280;
    const h = videoTrack.track_height || 720;
    scratch.width = w; scratch.height = h;
    const timescale = videoTrack.timescale || 1000;

    // Streaming: keep only a few VideoFrames alive. Holding hundreds of
    // unclosed frames starves the HW decoder pool and stalls output (car hang).
    const queue = [];
    let decoderError = null;
    let outCount = 0;
    const dec = new VideoDecoder({
      output: function (frame) {
        if (isAborted(gen)) { frame.close(); return; }
        outCount++;
        queue.push(frame);
      },
      error: function (e) {
        decoderError = e;
        cwLog("error", "decoder_error", { msg: String(e && (e.message || e)), stage: "VideoDecoder.onerror" });
      },
    });
    const config = { codec: codec, codedWidth: w, codedHeight: h, hardwareAcceleration: "no-preference" };
    if (description) config.description = description;
    cwLog("info", "stage", { stage: "configure VideoDecoder…", msg: "codec=" + codec + " desc=" + (description ? description.byteLength + "b" : "none") });
    if (VideoDecoder.isConfigSupported) {
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) { cwLog("error", "decoder_error", { msg: "config unsupported: " + codec }); throw new Error("VideoDecoder config unsupported: " + codec); }
    }
    dec.configure(config);

    setStage("decode frames…");
    const samples = demuxed.samples.video;
    let fed = 0;
    function feed() {
      while (fed < samples.length && queue.length + dec.decodeQueueSize < 6 && !isAborted(gen)) {
        const s = samples[fed++];
        try {
          dec.decode(new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            timestamp: (s.cts * 1e6) / timescale,
            duration: (s.duration * 1e6) / timescale,
            data: s.data,
          }));
        } catch (e) { cwLog("warn", "decoder_error", { msg: "decode chunk: " + e.message }); }
      }
      if (fed >= samples.length && dec.state === "configured") { dec.flush().catch(function () {}); fed++; }
    }

    let audioBuffer = null;
    let t0 = 0;
    let started = false;
    let lastBeat = performance.now();
    try {
      while (!isAborted(gen)) {
        if (decoderError) throw decoderError;
        feed();
        if (!queue.length) {
          if (fed > samples.length && dec.decodeQueueSize === 0) break; // done
          await new Promise(function (r) { setTimeout(r, 5); });
          continue;
        }
        if (!started) {
          // First frame: paint immediately, then audio + clock
          const f0 = queue.shift();
          scratchCtx.drawImage(f0, 0, 0, scratch.width, scratch.height);
          f0.close();
          await pushFrameFromCanvas(gen);
          cwLog("info", "stage", { stage: "first frame painted", msg: "webcodecs" });
          setStage("audio…");
          try { audioBuffer = await ensureAudioCtx().decodeAudioData(demuxed.ab.slice(0)); }
          catch (e) { cwLog("warn", "error", { msg: "decodeAudioData failed: " + e.message }); hud.audio.textContent = "none"; }
          if (isAborted(gen)) break;
          setStage("playing");
          cwLog("info", "playing", { msg: "WebCodecs playing", path: "webcodecs" });
          btnStop.disabled = false;
          if (audioBuffer) playDecodedAudioBuffer(audioBuffer);
          t0 = performance.now();
          started = true;
          continue;
        }
        const nowUs = (performance.now() - t0) * 1000;
        // Drop late frames (keep newest due one)
        while (queue.length > 1 && queue[1].timestamp <= nowUs) queue.shift().close();
        const f = queue[0];
        if (f.timestamp > nowUs) { await new Promise(function (r) { setTimeout(r, 8); }); continue; }
        queue.shift();
        if (!imgBusy && !blobBusy) {
          scratchCtx.drawImage(f, 0, 0, scratch.width, scratch.height);
          f.close();
          pushFrameFromCanvas(gen);
        } else {
          f.close();
        }
        hud.time.textContent = (nowUs / 1e6).toFixed(1) + "s";
        if (performance.now() - lastBeat > 5000) {
          lastBeat = performance.now();
          cwLog("info", "heartbeat", { path: "webcodecs", msg: "decoded=" + outCount + " assigned=" + assignedCount + " painted=" + paintedCount + " t=" + (nowUs / 1e6).toFixed(1) });
        }
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    } finally {
      while (queue.length) queue.shift().close();
      try { dec.close(); } catch (_) {}
    }
  }

  /* ---------- Pack fallback ---------- */
  async function playViaPack(meta, gen) {
    if (gen === undefined) gen = playGen;
    if (!meta || !meta.pack) throw new Error("no pack for clip");
    setPath("pack fallback", false);
    hud.renderer.textContent = "JPEG pack → <img> (preloaded, no <video>)";
    hud.renderer.style.color = "var(--warn)";
    refreshVideoElHud();
    cwLog("info", "pack_fallback", { msg: "starting pack playback", clip: meta.slug });

    setStage("fetch pack manifest…");
    const manifest = await fetch(meta.pack, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("pack manifest " + r.status);
      return r.json();
    });
    const frames = manifest.frames || [];
    if (!frames.length) throw new Error("empty pack");
    const prefix = manifest.frames_prefix || ("/packs/" + meta.slug + "/frames/");
    const fps = manifest.fps || 10;
    const interval = 1000 / fps;
    const url = function (i) { return prefix + frames[i]; };

    // Preloader: keep up to AHEAD frames decoded in memory (Image objects).
    // We only ever put an already-loaded URL into the visible <img>, so the
    // swap is instant and never aborts an in-flight network load.
    const AHEAD = 20;
    const ready = new Map();   // index -> true when loaded
    const loading = new Map(); // index -> Image
    let nextToLoad = 0;
    function pump(cur) {
      while (nextToLoad < frames.length && nextToLoad < cur + AHEAD && loading.size < 6) {
        const idx = nextToLoad++;
        if (idx < cur) continue;
        const im = new Image();
        loading.set(idx, im);
        im.onload = function () {
          loading.delete(idx);
          const done = function () { ready.set(idx, im); };
          if (im.decode) im.decode().then(done, done); else done();
        };
        im.onerror = function () { loading.delete(idx); cwLog("warn", "error", { msg: "pack frame failed " + idx }); };
        im.src = url(idx);
      }
    }

    setStage("buffering pack…");
    pump(0);
    // Wait for the first few frames before starting the clock
    const bufStart = performance.now();
    while (!isAborted(gen) && ready.size < Math.min(8, frames.length) && performance.now() - bufStart < 8000) {
      pump(0);
      await new Promise(function (r) { setTimeout(r, 30); });
    }

    setStage("fetch pack audio…");
    let audioDone = Promise.resolve();
    let pcm = null;
    try {
      pcm = await fetch(manifest.audio).then(function (r) {
        if (!r.ok) throw new Error("pcm " + r.status);
        return r.arrayBuffer();
      });
    } catch (e) {
      cwLog("warn", "error", { msg: "pack audio failed: " + e.message });
      hud.audio.textContent = "none";
    }
    if (isAborted(gen)) return;

    setStage("playing");
    cwLog("info", "playing", { msg: "pack playing", path: "pack", frames: frames.length, buffered: ready.size });
    btnStop.disabled = false;
    if (pcm) {
      audioDone = playPcmS16le(pcm, manifest.audio_sample_rate || 24000, manifest.audio_channels || 1);
      hud.audio.textContent = "PCM s16le " + (manifest.audio_sample_rate || 24000) + "Hz";
    }

    const t0 = performance.now();
    let shown = -1;
    let stalls = 0;
    let lastBeat = performance.now();
    while (!isAborted(gen)) {
      const elapsed = performance.now() - t0;
      const due = Math.min(frames.length - 1, Math.floor(elapsed / interval));
      pump(Math.max(shown, 0));
      // newest ready frame <= due, newer than what is shown
      let pick = -1;
      for (let k = due; k > shown; k--) { if (ready.has(k)) { pick = k; break; } }
      if (pick > shown) {
        if (setImgSrc(url(pick), false)) {
          for (let k = shown + 1; k <= pick; k++) ready.delete(k);
          if (shown < 0) cwLog("info", "stage", { stage: "first pack frame painted" });
          shown = pick;
        }
      } else if (due > shown) {
        stalls++;
      }
      hud.time.textContent = (elapsed / 1000).toFixed(1) + "s";
      if (performance.now() - lastBeat > 5000) {
        lastBeat = performance.now();
        cwLog("info", "heartbeat", { path: "pack", msg: "due=" + due + " shown=" + shown + " ready=" + ready.size + " loading=" + loading.size + " assigned=" + assignedCount + " painted=" + paintedCount + " stalls=" + stalls });
      }
      if (shown >= frames.length - 1 || elapsed > frames.length * interval + 3000) break;
      await new Promise(function (r) { setTimeout(r, 20); });
    }
    loading.forEach(function (im) { im.src = ""; });
    if (!isAborted(gen)) await audioDone.catch(function () {});
  }

  /* ---------- Phone debug video path ---------- */
  function ensureHiddenVideo() {
    if (hiddenVideo) return hiddenVideo;
    if (!ALLOW_VIDEO || FORCE_DRIVE) throw new Error("video element disabled");
    const v = document.createElement("video");
    v.id = "hiddenVideo";
    v.playsInline = true;
    v.muted = true;
    v.crossOrigin = "anonymous";
    v.hidden = true;
    document.querySelector(".stage").appendChild(v);
    hiddenVideo = v;
    renderCaps();
    return v;
  }

  async function playViaVideoElement(url) {
    setPath("video element (debug)", false);
    hud.renderer.textContent = "hidden <video> → canvas (NOT Drive-safe)";
    hud.renderer.style.color = "var(--danger)";
    const v = ensureHiddenVideo();
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.muted = true;
    v.src = url;
    setStage("video element load…");
    await new Promise(function (resolve, reject) {
      const onMeta = function () { cleanup(); resolve(); };
      const onErr = function () { cleanup(); reject(new Error("video load failed")); };
      function cleanup() {
        v.removeEventListener("loadedmetadata", onMeta);
        v.removeEventListener("error", onErr);
      }
      v.addEventListener("loadedmetadata", onMeta);
      v.addEventListener("error", onErr);
    });
    try {
      const ab = await fetch(url).then(function (r) { return r.arrayBuffer(); });
      const decoded = await ensureAudioCtx().decodeAudioData(ab.slice(0));
      playDecodedAudioBuffer(decoded);
    } catch (e) {
      v.muted = false;
      hud.audio.textContent = "element audio";
    }
    scratch.width = v.videoWidth || 1280;
    scratch.height = v.videoHeight || 720;
    await v.play().catch(function () {});
    setStage("playing");
    let lastCapture = 0;
    await new Promise(function (resolve) {
      function loop(ts) {
        if (stopRequested || v.ended || v.paused) { resolve(); return; }
        if (ts - lastCapture >= FRAME_INTERVAL_MS - 2) {
          lastCapture = ts;
          scratchCtx.drawImage(v, 0, 0, scratch.width, scratch.height);
          pushFrameFromCanvas();
          hud.time.textContent = v.currentTime.toFixed(1) + "s";
        }
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    });
  }

  /* ---------- Orchestration ---------- */
  function highlightPlaying(slug) {
    [].forEach.call(clipList.querySelectorAll(".clip"), function (b) {
      b.classList.toggle("playing", !!slug && b.dataset.slug === slug);
      if (slug) b.classList.toggle("selected", b.dataset.slug === slug);
    });
  }

  function updateNowPlaying(clip, index, total) {
    if (!clip) { nowPlaying.hidden = true; return; }
    nowPlaying.hidden = false;
    nowPlayingText.textContent = clip.artist + ' — "' + clip.title + '"';
    nowPlayingPos.textContent = "(" + (index + 1) + " / " + total + ")";
  }

  async function playOneClean(src, meta, opts) {
    opts = opts || {};
    const usePack = !!(opts.forcePack || FORCE_PACK || (forcePackMode && meta && meta.pack && !opts.tryWebCodecs));
    currentClip = meta;
    resetHud();
    setStage("loading…");
    showAttribution(meta || null);
    if (meta && meta.slug) highlightPlaying(meta.slug);

    try {
      if (usePack && meta && meta.pack) {
        await playViaPack(meta, ++playGen);
        return !stopRequested;
      }

      if (webCodecsOk && src) {
        const wcGen = ++playGen;
        let fetchedAt = 0;
        let wcErr = null;
        let wcDone = false;
        const wcPromise = playViaWebCodecs(src, wcGen, function () { fetchedAt = Date.now(); })
          .then(function () { wcDone = true; }, function (e) { wcErr = e; wcDone = true; });

        // Timeout counts from when the MP4 finished downloading (slow LTE
        // download is not a decoder stall). Hard cap 45s for the download.
        const started = Date.now();
        while (!stopRequested && paintedCount === 0 && !wcDone) {
          const now = Date.now();
          if (fetchedAt && now - fetchedAt > WC_TIMEOUT_MS) break;
          if (!fetchedAt && now - started > 45000) break;
          await new Promise(function (r) { setTimeout(r, 100); });
        }

        if (paintedCount === 0 && !stopRequested) {
          playGen++; // kills the WebCodecs attempt (its loops check the gen)
          if (wcErr) {
            cwLog("error", "decoder_error", { msg: "WebCodecs failed: " + (wcErr.message || wcErr), probeSaidYes: webCodecsOk });
          } else {
            cwLog("warn", "timeout", {
              msg: "WebCodecs timed out → pack fallback",
              stage: currentStage,
              timeoutMs: WC_TIMEOUT_MS,
              fetched: !!fetchedAt,
              probeSaidYes: webCodecsOk,
            });
          }
          cwLog("warn", "pack_fallback", { msg: wcErr ? "after WebCodecs error" : "after WebCodecs timeout", probeSaidYes: webCodecsOk });
          setStage("WebCodecs failed → pack fallback");
          resetHud();
          if (meta && meta.pack) {
            await playViaPack(meta, playGen);
            return !stopRequested;
          }
          throw wcErr || new Error("WebCodecs timed out and no pack available");
        }

        await wcPromise;
        if (wcErr) throw wcErr;
        return !stopRequested;
      }

      if (meta && meta.pack) {
        cwLog("info", "pack_fallback", { msg: "WebCodecs unavailable — using pack" });
        setStage("WebCodecs unavailable — pack fallback");
        await playViaPack(meta, ++playGen);
        return !stopRequested;
      }

      if (ALLOW_VIDEO && !FORCE_DRIVE) {
        await playViaVideoElement(src);
        return !stopRequested;
      }

      setPath("blocked", false);
      throw new Error("WebCodecs unavailable — Drive blocks <video>; cannot decode");
    } catch (e) {
      // If WC failed mid-way and we have a pack, try pack
      if (meta && meta.pack && !stopRequested && e && e.code !== "USER_STOP") {
        cwLog("warn", "pack_fallback", { msg: "after error: " + e.message, probeSaidYes: webCodecsOk });
        try {
          setStage("error → pack fallback: " + e.message);
          stopAudio();
          resetHud();
          await playViaPack(meta, ++playGen);
          return !stopRequested;
        } catch (e2) {
          cwLog("error", "error", { msg: "pack also failed: " + e2.message });
          setStage("error: " + e2.message);
          return false;
        }
      }
      console.error(e);
      setStage("error: " + (e && e.message ? e.message : e));
      cwLog("error", "error", { msg: String(e && e.message ? e.message : e) });
      return false;
    } finally {
      try { if (hiddenVideo) hiddenVideo.pause(); } catch (_) {}
      stopAudio();
      revokeObjectUrl();
      refreshVideoElHud();
      flushLogs();
    }
  }

  async function playSelected(opts) {
    if (!selected || !selected.src || playing) return;
    playlistMode = false;
    playlistActive = false;
    nowPlaying.hidden = true;
    stopRequested = false;
    playing = true;
    btnPlay.disabled = true;
    btnPlayAll.disabled = true;
    btnForcePack.disabled = true;
    btnStop.disabled = false;

    const ok = await playOneClean(selected.src, selected.meta || null, opts || {});
    if (ok) setStatus("Finished");
    else if (stopRequested) setStatus("Stopped");

    playing = false;
    btnPlay.disabled = !selected;
    btnPlayAll.disabled = !(catalog && catalog.clips && catalog.clips.length);
    btnForcePack.disabled = btnPlayAll.disabled;
    btnStop.disabled = true;
    highlightPlaying(null);
  }

  async function playPlaylist(opts) {
    if (!catalog || !catalog.clips || !catalog.clips.length || playing) return;
    opts = opts || {};
    playlistMode = true;
    playlistActive = true;
    stopRequested = false;
    playing = true;
    playlistIndex = 0;
    btnPlay.disabled = true;
    btnPlayAll.disabled = true;
    btnForcePack.disabled = true;
    btnStop.disabled = false;

    const clips = catalog.clips;
    const total = clips.length;
    cwLog("info", "stage", { stage: "playlist start", msg: "clips=" + total + " forcePack=" + !!opts.forcePack });

    while (playlistActive && !stopRequested) {
      const clip = clips[playlistIndex];
      selected = { src: clip.src, meta: clip };
      updateNowPlaying(clip, playlistIndex, total);
      setStatus("Playlist — " + clip.artist);
      cwLog("info", "stage", { stage: "playlist advance", clip: clip.slug, msg: (playlistIndex + 1) + "/" + total });

      const finished = await playOneClean(clip.src, clip, opts);
      if (!finished || stopRequested) break;

      playlistIndex += 1;
      if (playlistIndex >= total) {
        if (chkLoop && chkLoop.checked) {
          playlistIndex = 0;
          setStatus("Playlist — looping…");
          await new Promise(function (r) { setTimeout(r, 250); });
        } else {
          setStatus("Playlist finished");
          break;
        }
      } else {
        await new Promise(function (r) { setTimeout(r, 150); });
      }
    }

    if (stopRequested) setStatus("Playlist stopped");
    playlistActive = false;
    playlistMode = false;
    playing = false;
    btnPlay.disabled = !selected;
    btnPlayAll.disabled = false;
    btnForcePack.disabled = false;
    btnStop.disabled = true;
    highlightPlaying(null);
    flushLogs();
  }

  function stopPlayback() {
    stopRequested = true;
    playGen++;
    playlistActive = false;
    try { if (hiddenVideo) hiddenVideo.pause(); } catch (_) {}
    stopAudio();
    setStage(playlistMode ? "playlist stopped" : "stopped");
    cwLog("info", "stage", { stage: "stopped" });
    flushLogs();
  }

  function selectClip(clip) {
    if (playing) return;
    selected = { src: clip.src, meta: clip };
    [].forEach.call(clipList.querySelectorAll(".clip"), function (b) {
      b.classList.toggle("selected", b.dataset.slug === clip.slug);
      b.classList.remove("playing");
    });
    urlInput.value = "";
    btnPlay.disabled = false;
    showAttribution(clip);
    setStatus("Ready — " + clip.artist);
  }

  function selectUrl(url) {
    if (!url || playing) return;
    selected = { src: url, meta: null };
    [].forEach.call(clipList.querySelectorAll(".clip"), function (b) {
      b.classList.remove("selected");
      b.classList.remove("playing");
    });
    btnPlay.disabled = false;
    showAttribution(null);
    nowPlaying.hidden = true;
    setStatus("Ready — custom URL");
  }

  async function boot() {
    renderCaps();
    catalog = await fetch("catalog.json").then(function (r) { return r.json(); });
    catalog.clips.forEach(function (c) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "clip";
      btn.dataset.slug = c.slug;
      btn.innerHTML = '<div class="title">' + c.artist + " — " + c.title + "</div>" +
        '<div class="meta">' + c.description + " · " + c.license + " · " + c.segment + "</div>";
      btn.addEventListener("click", function () { selectClip(c); });
      clipList.appendChild(btn);
    });
    const def = catalog.clips.find(function (c) { return c.slug === catalog.defaultClip; }) || catalog.clips[0];
    if (def) selectClip(def);
    const ready = catalog.clips.length === 0;
    btnPlayAll.disabled = ready;
    btnForcePack.disabled = ready;

    urlInput.addEventListener("change", function () { selectUrl(urlInput.value.trim()); });
    urlInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") selectUrl(urlInput.value.trim());
    });
    btnPlay.addEventListener("click", function () {
      if (!playing) playSelected({ tryWebCodecs: TRY_WC, forcePack: FORCE_PACK });
    });
    btnPlayAll.addEventListener("click", function () {
      if (!playing) playPlaylist({ tryWebCodecs: TRY_WC, forcePack: false });
    });
    btnForcePack.addEventListener("click", function () {
      if (!playing) {
        forcePackMode = true;
        playPlaylist({ forcePack: true });
      }
    });
    btnStop.addEventListener("click", stopPlayback);

    setStage("idle — tap Force pack fallback (recommended)");
    setPath(forcePackMode ? "prefer pack" : (webCodecsOk ? "WebCodecs ready" : "pack only"), webCodecsOk && !forcePackMode);
    refreshVideoElHud();
    flushLogs();

    // Auto-start pack playlist if ?pack=1
    if (FORCE_PACK && catalog.clips.length) {
      setTimeout(function () { playPlaylist({ forcePack: true }); }, 300);
    }
  }

  boot().catch(function (e) {
    setStage("Boot error: " + e.message);
    cwLog("error", "error", { msg: "boot: " + e.message });
  });
})();
