/* Tesla Browser Client Decode PoC — Drive-safe + client debug logs (/api/logs)
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
  // Remote debug logs are optional (ENABLE_LOGS at deploy time). Off => console + Debug panel only.
  const LOGS_ENABLED = CFG.logsEnabled === true && params.get("logs") !== "0";
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
  const stageEl = $("stage");
  const stageStatus = $("stageStatus");
  const overlayIcon = $("overlayIcon");
  const chkAutoplay = $("chkAutoplay");
  const btnTryWC = $("btnTryWC");
  const npArtist = $("npArtist");
  const playlistCount = $("playlistCount");

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
  let userPaused = false;   // tap-on-player pause (pack path)
  let runSeq = 0;           // bumps per playSelected/playPlaylist run; stale runs don't touch UI
  let runPromise = null;    // current run, awaited before switching clips
  let switchToken = 0;      // latest playlist tap wins
  function isAborted(gen) { return stopRequested || gen !== playGen; }

  /* ---------- client logger: console always; POST /api/logs only when LOGS_ENABLED
   * (CloudWatch on AWS, Workers Logs on Cloudflare). Playback never depends on it. ---------- */
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
    if (!LOGS_ENABLED) return;
    logQueue.push(row);
    if (logQueue.length >= 20) flushLogs();
    else if (!flushTimer) flushTimer = setTimeout(flushLogs, 2000);
  }

  // Debug telemetry (only sent when ENABLE_LOGS is on): coarse client/device
  // info so we can tell a Tesla in-car browser from a phone or desktop.
  // No IP, no cookies, no fingerprint storage — one event per page load.
  function clientInfo() {
    const n = navigator, uad = n.userAgentData;
    return {
      ua: n.userAgent, platform: n.platform, vendor: n.vendor,
      uad: uad ? { brands: (uad.brands || []).map(function (b) { return b.brand + "/" + b.version; }),
                   mobile: !!uad.mobile, platform: uad.platform } : null,
      deviceMemory: n.deviceMemory, hardwareConcurrency: n.hardwareConcurrency,
      screen: (screen.width || 0) + "x" + (screen.height || 0) + "@" + (window.devicePixelRatio || 1),
      viewport: (window.innerWidth || 0) + "x" + (window.innerHeight || 0),
      maxTouchPoints: n.maxTouchPoints || 0,
      webCodecs: typeof VideoDecoder !== "undefined", audioDecoder: typeof AudioDecoder !== "undefined"
    };
  }
  setTimeout(function () { try { cwLog("info", "client_info", clientInfo()); } catch (_) {} }, 0);

  function flushLogs() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!LOGS_ENABLED || !logQueue.length || flushing) return;
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
    updateStageUi();
  }

  function setStatus(msg) { statusEl.textContent = msg; }

  function updateStageUi() {
    stageEl.classList.toggle("playing", playing);
    stageEl.classList.toggle("paused", playing && userPaused);
    overlayIcon.textContent = playing && !userPaused ? "❚❚" : "▶";
    const showMsg = playing && (userPaused || (currentStage !== "playing" && currentStage !== "first pack frame painted"));
    stageStatus.hidden = !showMsg;
    if (showMsg) stageStatus.textContent = userPaused ? "Paused — tap to resume" : currentStage;
  }

  function thumbUrl(clip) {
    return "/packs/" + clip.slug + "/frames/000350.jpg";
  }

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
    if (objectUrl) { rmUrl(objectUrl); objectUrl = null; }
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
  // Every blob: URL we create goes through mkUrl/rmUrl so the heartbeat can
  // report live blob URLs (a leak shows up as a number that only goes up).
  let liveBlobUrls = 0;
  function mkUrl(blob) { liveBlobUrls++; return URL.createObjectURL(blob); }
  function rmUrl(u) { if (u && u.indexOf("blob:") === 0) { liveBlobUrls--; URL.revokeObjectURL(u); } }
  frameEl.decoding = "sync";
  frameEl.addEventListener("load", function () {
    imgBusy = false;
    if (frameEl.src) stageEl.classList.remove("idle");
    paintedCount++;
    frameCount = paintedCount;
    tickFps();
    if (prevObjectUrl) { rmUrl(prevObjectUrl); prevObjectUrl = null; }
  });
  frameEl.addEventListener("error", function () {
    imgBusy = false;
    if (prevObjectUrl) { rmUrl(prevObjectUrl); prevObjectUrl = null; }
    cwLog("warn", "error", { msg: "img load error " + String(frameEl.src).slice(-40) });
  });

  function setImgSrc(url, isObjectUrl) {
    if (imgBusy) return false;            // drop frame, keep the current picture
    imgBusy = true;
    assignedCount++;
    if (isObjectUrl) {
      if (prevObjectUrl) rmUrl(prevObjectUrl); // superseded before it ever loaded
      prevObjectUrl = objectUrl; objectUrl = url;
    }
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
          resolve(setImgSrc(mkUrl(blob), true));
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
    resumeAudioIfAllowed();
    return audioCtx;
  }

  // iOS/WebKit: a context can be "suspended" (no gesture yet, background) or
  // "interrupted" (lock screen, call, Siri, route change) and never comes back
  // on its own. Resume on any gesture/visibility return unless the user paused.
  let liveUserPaused = false;
  function resumeAudioIfAllowed() {
    if (!audioCtx || audioCtx.state === "running" || audioCtx.state === "closed") return;
    if (userPaused || liveUserPaused) return;
    try { var p = audioCtx.resume(); if (p && p.catch) p.catch(function () {}); } catch (_) {}
  }
  try {
    // Play through the iOS ring/silent switch like media does (Safari 16.4+).
    if (navigator.audioSession) navigator.audioSession.type = "playback";
  } catch (_) {}
  ["pointerdown", "touchend", "click", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, resumeAudioIfAllowed, { capture: true, passive: true });
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") resumeAudioIfAllowed();
  });
  window.addEventListener("pageshow", resumeAudioIfAllowed);
  window.addEventListener("focus", resumeAudioIfAllowed);

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
    const logDest = $("logDest");
    if (logDest) {
      logDest.textContent = !LOGS_ENABLED ? "remote logs off (console only)"
        : CFG.logTarget === "aws" ? "search it in CloudWatch Logs" + (CFG.logGroup ? " (" + CFG.logGroup + ")" : "")
        : CFG.logTarget === "cloudflare" ? "search it in Workers Logs"
        : "logs → " + LOGS_URL;
    }
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
      // textContent, not innerHTML: the label "<video> in DOM" parsed as HTML
      // used to create a real (empty) <video> element and break the zero-<video> claim.
      const kEl = document.createElement("span"); kEl.className = "cap-k"; kEl.textContent = k;
      const vEl = document.createElement("span"); vEl.className = cls; vEl.textContent = v ? "yes" : "no";
      div.appendChild(kEl); div.appendChild(vEl);
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
  // Streaming JPEG+PCM player, built for the car's high-latency LTE link:
  //  * frames come in multi-frame chunks (20 frames = 2s per request) instead
  //    of one request per frame, so throughput isn't capped by RTT x 6 slots;
  //  * the fetch window is anchored at the *playhead* (due), sized from the
  //    measured p95 chunk load time, and requests that fall behind are aborted;
  //  * only a small bounded ring of frames is decoded (Image + blob URL); every
  //    frame behind the playhead is released immediately;
  //  * the picture follows the audio clock (AudioContext.currentTime). If the
  //    picture underruns we pause audio (rebuffer) instead of drifting apart.
  const PACK_DECODE_AHEAD = 6;     // decoded <img>-ready frames kept ahead
  const PACK_MIN_AHEAD_MS = 4000;  // minimum compressed buffer ahead
  const PACK_MAX_AHEAD_MS = 20000;
  const PACK_REBUFFER_LAG_MS = 700;   // picture this far behind audio -> pause audio
  const PACK_RESUME_AHEAD_MS = 2000;  // resume once this much is buffered

  function pctl(arr, p) {
    if (!arr.length) return 0;
    const a = arr.slice().sort(function (x, y) { return x - y; });
    return Math.round(a[Math.min(a.length - 1, Math.floor(p * a.length))]);
  }

  // Main-thread health: long tasks (where supported) + timer-loop gaps.
  const perfStats = { longTasks: 0, longTaskMaxMs: 0 };
  try {
    if (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes &&
        PerformanceObserver.supportedEntryTypes.indexOf("longtask") >= 0) {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          perfStats.longTasks++;
          perfStats.longTaskMaxMs = Math.max(perfStats.longTaskMaxMs, Math.round(e.duration));
        });
      }).observe({ entryTypes: ["longtask"] });
    }
  } catch (_) {}

  async function playViaPack(meta, gen) {
    if (gen === undefined) gen = playGen;
    if (!meta || !meta.pack) throw new Error("no pack for clip");
    setPath("pack fallback", false);
    hud.renderer.textContent = "JPEG pack → <img> (streamed chunks, no <video>)";
    hud.renderer.style.color = "var(--warn)";
    refreshVideoElHud();
    cwLog("info", "pack_fallback", { msg: "starting pack playback", clip: meta.slug });

    setStage("fetch pack manifest…");
    const manifest = await fetch(meta.pack, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("pack manifest " + r.status);
      return r.json();
    });
    const frames = manifest.frames || [];
    const N = frames.length;
    if (!N) throw new Error("empty pack");
    const prefix = manifest.frames_prefix || ("/packs/" + meta.slug + "/frames/");
    const fps = manifest.fps || 10;
    const interval = 1000 / fps;
    const durMs = N * interval;

    // Fetch units: a chunk of frames, or a single frame (?chunks=0 / old packs).
    const useChunks = !!(manifest.chunks && manifest.chunks.length) && params.get("chunks") !== "0";
    const units = useChunks
      ? manifest.chunks.map(function (c) { return { url: (manifest.chunks_prefix || ("/packs/" + meta.slug + "/chunks/")) + c.file, first: c.first, lengths: c.lengths, count: c.lengths.length }; })
      : frames.map(function (f, i) { return { url: prefix + f, first: i, lengths: null, count: 1 }; });
    const unitOfFrame = new Int32Array(N);
    units.forEach(function (u, ui) { for (let k = 0; k < u.count; k++) unitOfFrame[u.first + k] = ui; });
    const MAX_INFLIGHT = useChunks ? 3 : 6;

    const blobs = new Map();     // frame -> compressed Blob (cheap)
    const ring = new Map();      // frame -> { url, img, ok } decoded window (bounded)
    const inflight = new Map();  // unit -> AbortController
    const fetched = new Set();   // units already delivered
    const loadMs = [];           // last 30 request times
    let bytesIn = 0, bytesSinceBeat = 0, fetchErrors = 0, aborted = 0;
    let due = 0, shown = -1;
    let decoding = 0;

    function aheadTargetMs() {
      const p95 = pctl(loadMs, 0.95) || 1000;
      // enough buffered to ride out ~3 slow requests back to back
      return Math.max(PACK_MIN_AHEAD_MS, Math.min(PACK_MAX_AHEAD_MS, p95 * 3 + 1000));
    }
    function contiguousAhead() {        // frames buffered contiguously from due
      let k = Math.max(due, shown + 1);
      while (k < N && (blobs.has(k) || ring.has(k))) k++;
      return k - due;
    }

    function fetchUnit(ui) {
      const u = units[ui];
      const ac = window.AbortController ? new AbortController() : null;
      inflight.set(ui, ac);
      const t = performance.now();
      fetch(u.url, ac ? { signal: ac.signal } : {}).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      }).then(function (ab) {
        inflight.delete(ui);
        if (isAborted(gen)) return;
        fetched.add(ui);
        loadMs.push(performance.now() - t); if (loadMs.length > 30) loadMs.shift();
        bytesIn += ab.byteLength; bytesSinceBeat += ab.byteLength;
        if (!u.lengths) { if (u.first > shown) blobs.set(u.first, new Blob([ab], { type: "image/jpeg" })); return; }
        let off = 0;
        for (let k = 0; k < u.count; k++) {
          const len = u.lengths[k], idx = u.first + k;
          if (idx > shown && idx >= due - 1) blobs.set(idx, new Blob([new Uint8Array(ab, off, len)], { type: "image/jpeg" }));
          off += len;
        }
      }).catch(function (e) {
        inflight.delete(ui);
        if (e && e.name === "AbortError") return;
        fetchErrors++;
        cwLog("warn", "error", { msg: "pack fetch failed unit " + ui + ": " + (e && e.message) });
      });
    }

    function schedule() {
      const curUnit = unitOfFrame[Math.min(due, N - 1)];
      // abort requests that can no longer arrive in time to be shown
      inflight.forEach(function (ac, ui) {
        const u = units[ui];
        if (u.first + u.count - 1 < due) { if (ac) ac.abort(); inflight.delete(ui); aborted++; }
      });
      const limitFrame = Math.min(N - 1, due + Math.ceil(aheadTargetMs() / interval));
      for (let ui = curUnit; ui < units.length && inflight.size < MAX_INFLIGHT; ui++) {
        if (units[ui].first > limitFrame) break;
        if (fetched.has(ui) || inflight.has(ui)) continue;
        fetchUnit(ui);
      }
    }

    function release() {           // drop everything at/behind the shown frame
      blobs.forEach(function (_, k) { if (k <= shown) blobs.delete(k); });
      ring.forEach(function (e, k) {
        if (k <= shown || k > due + PACK_DECODE_AHEAD * 3) { rmUrl(e.url); e.img.src = ""; ring.delete(k); }
      });
    }

    function decodeAhead() {
      for (let k = Math.max(due, shown + 1); k < Math.min(N, due + PACK_DECODE_AHEAD) && decoding < 2; k++) {
        if (ring.has(k) || !blobs.has(k)) continue;
        const blob = blobs.get(k); blobs.delete(k);
        const e = { url: mkUrl(blob), img: new Image(), ok: false };
        ring.set(k, e);
        decoding++;
        const done = function () { decoding--; e.ok = true; };
        e.img.onload = function () { if (e.img.decode) e.img.decode().then(done, done); else done(); };
        e.img.onerror = function () { decoding--; e.ok = true; e.bad = true; };
        e.img.src = e.url;
      }
    }

    setStage("buffering pack…");
    // Pre-roll: start the audio fetch in parallel with the first frames.
    const pcmP = fetch(manifest.audio).then(function (r) {
      if (!r.ok) throw new Error("pcm " + r.status);
      return r.arrayBuffer();
    });
    const bufStart = performance.now();
    const preroll = Math.min(N, Math.ceil(PACK_RESUME_AHEAD_MS / interval));
    while (!isAborted(gen) && contiguousAhead() < preroll && performance.now() - bufStart < 15000) {
      schedule(); decodeAhead();
      await new Promise(function (r) { setTimeout(r, 30); });
    }

    setStage("fetch pack audio…");
    let pcm = null;
    try { pcm = await pcmP; } catch (e) {
      cwLog("warn", "error", { msg: "pack audio failed: " + e.message });
      hud.audio.textContent = "none";
    }
    if (isAborted(gen)) { ring.forEach(function (e) { rmUrl(e.url); }); return; }

    setStage("playing");
    cwLog("info", "playing", { msg: "pack playing", path: "pack", frames: N, chunks: useChunks ? units.length : 0, buffered: contiguousAhead(), prerollMs: Math.round(performance.now() - bufStart) });
    btnStop.disabled = false;

    // Master clock: audio when we have it, wall clock otherwise.
    let audioDone = Promise.resolve();
    let audioEnded = false;
    let ctx = null, a0 = 0;
    if (pcm) {
      audioDone = playPcmS16le(pcm, manifest.audio_sample_rate || 24000, manifest.audio_channels || 1);
      audioDone.then(function () { audioEnded = true; });
      ctx = audioCtx; a0 = ctx.currentTime;
      hud.audio.textContent = "PCM s16le " + (manifest.audio_sample_rate || 24000) + "Hz";
    }
    pcm = null;
    let wall0 = performance.now(), pausedMs = 0, lastT = 0, inRebuffer = false, clockSrc = ctx ? "audio" : "wall";
    function clockMs() {
      if (ctx && !audioEnded && !(ctx.state !== "running" && !inRebuffer && performance.now() - wall0 > 1500)) {
        lastT = (ctx.currentTime - a0) * 1000;
        return lastT;
      }
      if (ctx) {                       // audio blocked/ended -> continue on wall clock
        cwLog("warn", "clock", { msg: "audio clock unavailable (" + (audioEnded ? "ended" : ctx.state) + ") -> wall clock at " + Math.round(lastT) + "ms" });
        ctx = null; wall0 = performance.now() - lastT; pausedMs = 0; clockSrc = "wall";
      }
      lastT = performance.now() - wall0 - pausedMs;
      return lastT;
    }

    let stallMs = 0, rebuffers = 0, rebufferMs = 0, maxLagMs = 0, loopGapMaxMs = 0;
    let lastLoop = performance.now(), lastBeat = performance.now();
    let lastBeatPainted = paintedCount;
    try {
      while (!isAborted(gen)) {
        if (userPaused) {
          const p0 = performance.now();
          if (ctx && !audioEnded && ctx.state === "running") { try { await ctx.suspend(); } catch (_) {} }
          cwLog("info", "pause", { msg: "paused at frame " + due, frame: due });
          while (userPaused && !isAborted(gen)) await new Promise(function (r) { setTimeout(r, 50); });
          const d = performance.now() - p0;
          if (!ctx) pausedMs += d;
          if (ctx && !audioEnded && ctx.state !== "running") { try { await ctx.resume(); } catch (_) {} }
          if (isAborted(gen)) break;
          cwLog("info", "resume", { msg: "resumed after " + Math.round(d) + "ms", durMs: Math.round(d) });
          updateStageUi();
          lastLoop = performance.now(); lastBeat = performance.now();
          continue;
        }
        const now = performance.now();
        const gap = now - lastLoop; lastLoop = now;
        if (gap > loopGapMaxMs) loopGapMaxMs = gap;
        const t = clockMs();
        due = Math.min(N - 1, Math.max(0, Math.floor(t / interval)));
        release(); schedule(); decodeAhead();

        // newest decoded frame <= due, newer than what is shown
        let pick = -1;
        for (let k = due; k > shown; k--) { const e = ring.get(k); if (e && e.ok && !e.bad) { pick = k; break; } }
        if (pick > shown && !imgBusy) {
          const e = ring.get(pick);
          ring.delete(pick);                  // ownership -> visible <img>
          if (setImgSrc(e.url, true)) {
            if (shown < 0) cwLog("info", "stage", { stage: "first pack frame painted" });
            shown = pick;
            e.img.src = "";
          }
        } else if (due > shown + 1) {
          stallMs += gap;
        }
        const lagMs = Math.max(0, (due - Math.max(shown, 0)) * interval);
        if (lagMs > maxLagMs) maxLagMs = lagMs;

        // Rebuffer: picture starved behind the audio clock -> pause the clock.
        if (lagMs > PACK_REBUFFER_LAG_MS && contiguousAhead() < 2 && t < durMs - 1000) {
          rebuffers++;
          inRebuffer = true;
          const r0 = performance.now();
          setStage("rebuffering…");
          if (ctx && !audioEnded) { try { await ctx.suspend(); } catch (_) {} }
          // jump to the newest frame we can get; resume once 2s are buffered
          while (!isAborted(gen) && contiguousAhead() * interval < PACK_RESUME_AHEAD_MS && performance.now() - r0 < 8000) {
            schedule(); decodeAhead();
            await new Promise(function (r) { setTimeout(r, 50); });
          }
          const d = performance.now() - r0;
          rebufferMs += d; pausedMs += d;
          if (ctx && !audioEnded) { try { await ctx.resume(); } catch (_) {} }
          inRebuffer = false;
          setStage("playing");
          cwLog("info", "rebuffer", { msg: "rebuffered " + Math.round(d) + "ms at frame " + due, durMs: Math.round(d), frame: due });
          lastLoop = performance.now();
          continue;
        }

        hud.time.textContent = (t / 1000).toFixed(1) + "s";
        if (now - lastBeat > 5000) {
          const beatMs = now - lastBeat;
          lastBeat = now;
          const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
          const hb = {
            path: "pack", due: due, shown: shown,
            lagMs: Math.round(lagMs), maxLagMs: Math.round(maxLagMs),
            bufAheadMs: Math.round(contiguousAhead() * interval),
            aheadTargetMs: Math.round(aheadTargetMs()),
            decodedAhead: ring.size, blobsHeld: blobs.size, liveImgs: ring.size + 1,
            liveBlobUrls: liveBlobUrls, inflight: inflight.size,
            loadP50: pctl(loadMs, 0.5), loadP95: pctl(loadMs, 0.95),
            kbps: Math.round(bytesSinceBeat * 8 / beatMs),
            paintFps: Math.round((paintedCount - lastBeatPainted) * 10000 / beatMs) / 10,
            stallMs: Math.round(stallMs), rebuffers: rebuffers, rebufferMs: Math.round(rebufferMs),
            fetchErrors: fetchErrors, aborted: aborted,
            loopGapMaxMs: Math.round(loopGapMaxMs), longTasks: perfStats.longTasks, longTaskMaxMs: perfStats.longTaskMaxMs,
            heapMB: mem, chunks: useChunks ? 1 : 0, clock: clockSrc
          };
          hb.msg = "due=" + due + " shown=" + shown + " lag=" + hb.lagMs + "ms buf=" + hb.bufAheadMs + "ms fps=" + hb.paintFps +
            " p50/p95=" + hb.loadP50 + "/" + hb.loadP95 + "ms inflight=" + hb.inflight + " imgs=" + hb.liveImgs +
            " urls=" + liveBlobUrls + " heap=" + mem + "MB rebuf=" + rebuffers + " stallMs=" + hb.stallMs + " gapMax=" + hb.loopGapMaxMs;
          cwLog("info", "heartbeat", hb);
          bytesSinceBeat = 0; lastBeatPainted = paintedCount; maxLagMs = 0; loopGapMaxMs = 0; perfStats.longTaskMaxMs = 0;
        }
        if (shown >= N - 1 || t > durMs + 3000) break;
        await new Promise(function (r) { setTimeout(r, 20); });
      }
    } finally {
      inflight.forEach(function (ac) { if (ac) ac.abort(); });
      inflight.clear();
      ring.forEach(function (e) { rmUrl(e.url); e.img.src = ""; });
      ring.clear(); blobs.clear();
      if (ctx && ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }
    }
    cwLog("info", "pack_done", { msg: "clip done", clip: meta.slug, shown: shown, frames: N, rebuffers: rebuffers, rebufferMs: Math.round(rebufferMs), stallMs: Math.round(stallMs), fetchErrors: fetchErrors, aborted: aborted, kB: Math.round(bytesIn / 1024), loadP50: pctl(loadMs, 0.5), loadP95: pctl(loadMs, 0.95), liveBlobUrls: liveBlobUrls });
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
    if (!clip) { nowPlayingText.textContent = "Custom URL"; npArtist.textContent = ""; nowPlayingPos.textContent = ""; return; }
    nowPlayingText.textContent = clip.title;
    npArtist.textContent = clip.artist;
    nowPlayingPos.textContent = index >= 0 && total ? "· " + (index + 1) + " / " + total : "";
  }

  function setPoster(clip) {
    stageEl.style.backgroundImage = clip ? 'url("' + thumbUrl(clip) + '")' : "";
    stageEl.classList.add("idle");      // hide the old frame until the new clip paints
  }

  async function playOneClean(src, meta, opts) {
    opts = opts || {};
    const usePack = !!(opts.forcePack || FORCE_PACK || (forcePackMode && meta && meta.pack && !opts.tryWebCodecs));
    currentClip = meta;
    setPoster(meta);
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
    const myRun = ++runSeq;
    playlistMode = false;
    playlistActive = false;
    stopRequested = false;
    userPaused = false;
    playing = true;
    updateStageUi();
    btnPlay.disabled = true;
    btnStop.disabled = false;

    const ok = await playOneClean(selected.src, selected.meta || null, opts || {});
    if (myRun !== runSeq) return;     // superseded by a newer tap
    if (ok) setStatus("Finished");
    else if (stopRequested) setStatus("Stopped");

    playing = false;
    userPaused = false;
    updateStageUi();
    btnPlay.disabled = !selected;
    btnPlayAll.disabled = !(catalog && catalog.clips && catalog.clips.length);
    btnForcePack.disabled = btnPlayAll.disabled;
    btnStop.disabled = true;
    highlightPlaying(null);
  }

  async function playPlaylist(opts) {
    if (!catalog || !catalog.clips || !catalog.clips.length || playing) return;
    opts = opts || {};
    const myRun = ++runSeq;
    playlistMode = true;
    playlistActive = true;
    stopRequested = false;
    userPaused = false;
    playing = true;
    playlistIndex = Math.max(0, Math.min(catalog.clips.length - 1, opts.startIndex | 0));
    updateStageUi();
    btnPlay.disabled = true;
    btnStop.disabled = false;

    const clips = catalog.clips;
    const total = clips.length;
    cwLog("info", "stage", { stage: "playlist start", msg: "clips=" + total + " forcePack=" + !!opts.forcePack });

    while (playlistActive && !stopRequested && myRun === runSeq) {
      const clip = clips[playlistIndex];
      selected = { src: clip.src, meta: clip };
      updateNowPlaying(clip, playlistIndex, total);
      setStatus("Playlist — " + clip.artist);
      cwLog("info", "stage", { stage: "playlist advance", clip: clip.slug, msg: (playlistIndex + 1) + "/" + total });

      const finished = await playOneClean(clip.src, clip, opts);
      if (!finished || stopRequested || myRun !== runSeq) break;
      if (chkAutoplay && !chkAutoplay.checked) { setStatus("Finished — tap a clip"); break; }

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

    if (myRun !== runSeq) return;     // superseded by a newer tap
    if (stopRequested) setStatus("Stopped");
    playlistActive = false;
    playlistMode = false;
    playing = false;
    userPaused = false;
    updateStageUi();
    btnPlay.disabled = !selected;
    btnTryWC.disabled = !selected;
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
    userPaused = false;
    try { if (hiddenVideo) hiddenVideo.pause(); } catch (_) {}
    stopAudio();
    setStage(playlistMode ? "playlist stopped" : "stopped");
    cwLog("info", "stage", { stage: "stopped" });
    flushLogs();
  }

  // Must be called synchronously inside a tap handler: creating/resuming the
  // AudioContext and starting a (silent) source there unlocks audio for later awaits.
  function unlockAudio() {
    try {
      const ctx = ensureAudioCtx();
      const b = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = b; src.connect(ctx.destination); src.start(0);
    } catch (e) {
      cwLog("warn", "error", { msg: "audio unlock failed: " + (e && e.message) });
    }
  }

  // Stop whatever is playing (reusing stopPlayback / playGen kill), wait for that
  // run to unwind, then start the given clip with the default pack player.
  async function startFromIndex(index, opts) {
    const token = ++switchToken;
    unlockAudio();                                    // still inside the user gesture
    const clip = catalog.clips[index];
    if (clip) { selected = { src: clip.src, meta: clip }; highlightPlaying(clip.slug); updateNowPlaying(clip, index, catalog.clips.length); setPoster(clip); showAttribution(clip); }
    cwLog("info", "stage", { stage: "tap play", clip: clip && clip.slug, msg: "tap row " + index + (playing ? " (switch)" : "") });
    if (playing) {
      stopPlayback();
      const prev = runPromise;
      if (prev) await Promise.race([prev.catch(function () {}), new Promise(function (r) { setTimeout(r, 4000); })]);
      if (token !== switchToken) return;              // a newer tap took over
      stopAudio();
      playing = false;
    }
    runPromise = playPlaylist(Object.assign({ forcePack: true }, opts || {}, { startIndex: index }));
    return runPromise;
  }

  function togglePlayPause() {
    if (!catalog || !catalog.clips.length) return;
    if (!playing) {
      const slug = selected && selected.meta && selected.meta.slug;
      let idx = catalog.clips.findIndex(function (c) { return c.slug === slug; });
      startFromIndex(idx < 0 ? 0 : idx);
      return;
    }
    userPaused = !userPaused;
    if (audioCtx) {                                   // act on audio inside the gesture
      try { if (userPaused) audioCtx.suspend(); else audioCtx.resume(); } catch (_) {}
    }
    if (userPaused) setStage("paused"); else setStage("playing");
  }

  function fmtDur(sec) {
    sec = Math.round(sec);
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
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
    btnTryWC.disabled = false;
    showAttribution(clip);
    setPoster(clip);
    updateNowPlaying(clip, catalog.clips.indexOf(clip), catalog.clips.length);
    setStatus("Tap the player or a clip to play");
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
    updateNowPlaying(null);
    setPoster(null);
    setStatus("Ready — custom URL");
  }

  async function boot() {
    renderCaps();
    catalog = await fetch("catalog.json").then(function (r) { return r.json(); });
    playlistCount.textContent = "· " + catalog.clips.length + " clips";
    catalog.clips.forEach(function (c, i) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "clip";
      btn.dataset.slug = c.slug;
      btn.setAttribute("role", "listitem");
      const thumb = document.createElement("div"); thumb.className = "thumb";
      const im = document.createElement("img"); im.alt = ""; im.loading = "lazy"; im.src = thumbUrl(c);
      const dur = document.createElement("span"); dur.className = "dur"; dur.textContent = "1:10";
      const now = document.createElement("span"); now.className = "now"; now.textContent = "NOW PLAYING";
      thumb.appendChild(im); thumb.appendChild(dur); thumb.appendChild(now);
      const txt = document.createElement("div");
      const t = document.createElement("div"); t.className = "title"; t.textContent = c.title;
      const a = document.createElement("div"); a.className = "artist"; a.textContent = c.artist;
      const m = document.createElement("div"); m.className = "meta"; m.textContent = c.license;
      txt.appendChild(t); txt.appendChild(a); txt.appendChild(m);
      btn.appendChild(thumb); btn.appendChild(txt);
      btn.addEventListener("click", function () { startFromIndex(i); });
      clipList.appendChild(btn);
      if (c.pack) fetch(c.pack).then(function (r) { return r.json(); }).then(function (mf) {
        const n = mf.frame_count || (mf.frames && mf.frames.length);
        if (n && mf.fps) dur.textContent = fmtDur(n / mf.fps);
        if (mf.frames && mf.frames.length) {
          const mid = mf.frames[Math.floor(mf.frames.length / 2)];
          const u = (mf.frames_prefix || ("/packs/" + c.slug + "/frames/")) + mid;
          if (im.src.indexOf(mid) < 0) im.src = u;
        }
      }).catch(function () {});
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
      unlockAudio();
      if (!playing) runPromise = playSelected({ tryWebCodecs: TRY_WC, forcePack: FORCE_PACK });
    });
    btnTryWC.addEventListener("click", function () {
      unlockAudio();
      if (!playing) runPromise = playSelected({ tryWebCodecs: true });
    });
    btnPlayAll.addEventListener("click", function () {
      chkAutoplay.checked = true;
      startFromIndex(0, TRY_WC ? { forcePack: false, tryWebCodecs: true } : {});
    });
    btnForcePack.addEventListener("click", function () {
      forcePackMode = true;
      chkAutoplay.checked = true;
      startFromIndex(0, { forcePack: true });
    });
    btnStop.addEventListener("click", function () { stopPlayback(); updateStageUi(); });
    stageEl.addEventListener("click", togglePlayPause);
    stageEl.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); togglePlayPause(); } });

    setStage("idle — tap a clip to play");
    setPath(forcePackMode ? "prefer pack" : (webCodecsOk ? "WebCodecs ready" : "pack only"), webCodecsOk && !forcePackMode);
    refreshVideoElHud();
    flushLogs();

    initLiveTab();

    // Auto-start pack playlist if ?pack=1
    if (FORCE_PACK && catalog.clips.length) {
      setTimeout(function () { startFromIndex(0, { forcePack: true }); }, 300);
    }
  }


  /* ---------- Live Streaming tab (fixed 3 public HLS test feeds) ---------- */
  var livePlayer = null;
  var liveObjectUrl = null;
  var livePrevUrl = null;
  var liveImgBusy = false;
  var liveBlobBusy = false;
  var liveActive = false;
  var liveSelectedId = null;

  var liveFrameEl = $("liveFrame");
  var liveScratch = $("liveScratch");
  var liveScratchCtx = liveScratch ? liveScratch.getContext("2d", { willReadFrequently: true }) : null;
  var liveStageEl = $("liveStage");
  var liveStageStatus = $("liveStageStatus");
  var liveOverlayIcon = $("liveOverlayIcon");
  var liveStatusEl = $("liveStatus");
  var liveTitleEl = $("liveTitle");
  var liveSubtitleEl = $("liveSubtitle");
  var liveList = $("liveList");
  var liveDiagGrid = $("liveDiagGrid");
  var btnLiveStop = $("btnLiveStop");
  var liveWcBanner = $("liveWcBanner");
  var tabClips = $("tabClips");
  var tabLive = $("tabLive");
  var panelClips = $("panelClips");
  var panelLive = $("panelLive");

  function liveRmUrl(u) {
    if (u && String(u).indexOf("blob:") === 0) {
      try { URL.revokeObjectURL(u); } catch (_) {}
    }
  }

  // Present is non-blocking: always accept the next JPEG URL. Waiting on
  // <img>.load gated the display to ~11–14 fps and forced the ready queue to
  // overflow (then drop). The browser paints src updates; we revoke the prior
  // blob after a short delay. Never skip the head in the player — only hold
  // when a frame is still in the future relative to the audio clock.
  function liveSetImg(url) {
    if (!url) return false;
    if (livePrevUrl) liveRmUrl(livePrevUrl);
    livePrevUrl = liveObjectUrl;
    liveObjectUrl = url;
    liveFrameEl.src = url;
    liveImgBusy = false;
    return true;
  }

  if (liveFrameEl) {
    liveFrameEl.decoding = "async";
    liveFrameEl.addEventListener("load", function () {
      if (liveFrameEl.src) liveStageEl.classList.remove("idle");
      if (livePrevUrl) { liveRmUrl(livePrevUrl); livePrevUrl = null; }
    });
    liveFrameEl.addEventListener("error", function () {
      if (livePrevUrl) { liveRmUrl(livePrevUrl); livePrevUrl = null; }
    });
  }

  function livePresentFrame(url) {
    return liveSetImg(url);
  }

  function renderLiveDiag(d) {
    if (!liveDiagGrid || !d) return;
    var rows = [
      ["WebCodecs", d.webCodecs ? "yes" : "NO — live path blocked", d.webCodecs ? "ok" : "bad"],
      ["AudioDecoder", d.audioDecoder ? "yes" : "no", d.audioDecoder ? "ok" : "warn"],
      ["mux.js", d.muxjs ? "yes" : "no", d.muxjs ? "ok" : "bad"],
      ["MP4Box", d.mp4box ? "yes" : "no", d.mp4box ? "ok" : "bad"],
      ["Stage", d.stage || "—", ""],
      ["Stream", d.streamId || "—", ""],
      ["Variant", d.variant || "—", ""],
      ["Format", d.format || "—", ""],
      ["Segments", String(d.segmentsFetched || 0), ""],
      ["Decoded", String(d.framesDecoded || 0), ""],
      ["Shown", String(d.framesShown != null ? d.framesShown : (d.framesDrawn || 0)), ""],
      ["Late", String(d.framesLate || 0), (d.framesLate || 0) > 30 ? "warn" : "ok"],
      ["Dropped", String(d.framesDropped || 0), (d.framesDropped || 0) > 0 ? "warn" : "ok"],
      ["Ready Q", String(d.readyQ || 0), ""],
      ["Audio chunks", String(d.audioChunks || 0), ""],
      ["Audio queued", (d.audioQueuedSec != null ? d.audioQueuedSec + " s" : "—"), ""],
      ["Audio dec Q", String(d.audioDecQ || 0), ""],
      ["Audio chunk Q", String(d.audioChunkQ || 0), ""],
      ["Audio buffered", (d.audioBufferedMs != null ? d.audioBufferedMs + " ms" : "—"),
        (d.audioBufferedMs != null && d.audioBufferedMs < 200 ? "warn" : "ok")],
      ["Audio underruns", String(d.audioUnderruns || 0), (d.audioUnderruns || 0) > 0 ? "warn" : "ok"],
      ["Audio last gap", (d.audioLastGapMs != null ? d.audioLastGapMs + " ms" : "—"),
        (d.audioLastGapMs || 0) > 150 ? "warn" : "ok"],
      ["Audio dec resets", String(d.audioDecResets || 0), (d.audioDecResets || 0) > 0 ? "warn" : "ok"],
      ["Audio gaps >150ms", String(d.audioGaps150 || 0) + (d.audioMaxGapMs ? " (max " + d.audioMaxGapMs + " ms)" : ""), (d.audioGaps150 || 0) > 0 ? "warn" : "ok"],
      ["A/V sync (video−audio)", (d.avSyncMs != null ? d.avSyncMs + " ms" : "—"), Math.abs(d.avSyncMs || 0) > 80 ? "warn" : "ok"],
      ["Output latency", (d.outLatencyMs || 0) + " ms" + (d.avOffsetMs ? " · manual " + d.avOffsetMs + " ms" : ""), ""],
      ["Audio ctx", d.audioCtxState || "—", d.audioCtxState && d.audioCtxState !== "running" ? "warn" : "ok"],
      ["Audio out", d.audioOut || "—", ""],
      ["Quality", (d.variantH ? d.variantH + "p src · " : "") + (d.outW || "?") + "w · q" + (d.jpegQ || "?") + " · L" + (d.qLevel != null ? d.qLevel : "?") + (d.encMsAvg != null ? " · enc " + d.encMsAvg + " ms" : ""), ""],
      ["Buffer", (d.bufferMs != null ? d.bufferMs + " ms" : "—"), ""],
      ["A/V drift", (d.driftMs != null ? d.driftMs + " ms" : "—"), Math.abs(d.driftMs || 0) > 120 ? "warn" : "ok"],
      ["<video> els", String(d.videoEls || 0), d.videoEls ? "bad" : "ok"],
      ["<audio> els", String(d.audioEls || 0), d.audioEls ? "bad" : "ok"],
      ["Error", d.error || "—", d.error ? "bad" : "ok"]
    ];
    liveDiagGrid.textContent = "";
    rows.forEach(function (row) {
      var div = document.createElement("div");
      var k = document.createElement("span"); k.className = "k"; k.textContent = row[0];
      var v = document.createElement("span");
      if (row[2]) v.className = row[2];
      v.textContent = row[1];
      div.appendChild(k); div.appendChild(v);
      liveDiagGrid.appendChild(div);
    });
  }

  function updateLiveStageUi(playingLive, paused) {
    if (!liveStageEl) return;
    liveStageEl.classList.toggle("playing", !!playingLive);
    liveStageEl.classList.toggle("paused", !!paused);
    if (liveOverlayIcon) liveOverlayIcon.textContent = playingLive && !paused ? "❚❚" : "▶";
  }

  function stopLive() {
    if (livePlayer) livePlayer.stop();
    liveActive = false;
    if (btnLiveStop) btnLiveStop.disabled = true;
    updateLiveStageUi(false, false);
    if (liveStatusEl) liveStatusEl.textContent = "Stopped";
    [].forEach.call(liveList.querySelectorAll(".clip"), function (b) { b.classList.remove("playing"); });
  }

  function switchTab(which) {
    var toLive = which === "live";
    if (toLive) {
      // Stop clip playback when entering live
      if (playing) stopPlayback();
      panelClips.hidden = true;
      panelLive.hidden = false;
      tabClips.classList.remove("active"); tabClips.setAttribute("aria-selected", "false");
      tabLive.classList.add("active"); tabLive.setAttribute("aria-selected", "true");
      try { history.replaceState(null, "", (location.pathname + location.search).replace(/([?&])tab=live&?/, "$1").replace(/[?&]$/, "") + (location.search ? (location.search.indexOf("tab=") >= 0 ? "" : "&tab=live") : "?tab=live")); } catch (_) {}
    } else {
      stopLive();
      panelLive.hidden = true;
      panelClips.hidden = false;
      tabLive.classList.remove("active"); tabLive.setAttribute("aria-selected", "false");
      tabClips.classList.add("active"); tabClips.setAttribute("aria-selected", "true");
    }
  }

  async function startLiveStream(stream) {
    if (!window.LiveHls || !LiveHls.LivePlayer) {
      if (liveStatusEl) liveStatusEl.textContent = "live.js failed to load";
      return;
    }
    liveUserPaused = false;
    unlockAudio();
    if (playing) stopPlayback();
    stopLive();
    liveSelectedId = stream.id;
    liveActive = true;
    liveImgBusy = false;
    liveBlobBusy = false;
    liveStageEl.classList.add("idle");
    if (liveTitleEl) liveTitleEl.textContent = stream.title;
    if (liveSubtitleEl) liveSubtitleEl.textContent = stream.subtitle + " · " + stream.note;
    if (liveStatusEl) liveStatusEl.textContent = "Starting…";
    if (btnLiveStop) btnLiveStop.disabled = false;
    [].forEach.call(liveList.querySelectorAll(".clip"), function (b) {
      b.classList.toggle("playing", b.dataset.id === stream.id);
      b.classList.toggle("selected", b.dataset.id === stream.id);
    });
    setPath("Live HLS → WebCodecs", true);
    hud.renderer.textContent = "Live HLS → WebCodecs → canvas → JPEG <img>";
    hud.renderer.style.color = "var(--ok)";
    refreshVideoElHud();
    cwLog("info", "live_start", { msg: "start " + stream.id, streamId: stream.id, clip: stream.id });

    var thisPlayer = null;
    livePlayer = thisPlayer = new LiveHls.LivePlayer({
      scratch: liveScratch,
      scratchCtx: liveScratchCtx,
      // A late frame from a torn-down player must never reach the <img>.
      presentFrame: function (u) { return livePlayer === thisPlayer ? livePresentFrame(u) : false; },
      ensureAudioCtx: ensureAudioCtx,
      onLog: function (level, event, fields) {
        cwLog(level, event, Object.assign({ clip: stream.id }, fields || {}));
      },
      onDiag: function (d) {
        if (livePlayer !== thisPlayer) return;
        renderLiveDiag(d); refreshVideoElHud();
        // Periodic sync telemetry (~5 s; cwLog only POSTs when ENABLE_LOGS is on).
        var nowT = Date.now();
        if (!thisPlayer._lastSyncLog || nowT - thisPlayer._lastSyncLog >= 4900) {
          thisPlayer._lastSyncLog = nowT;
          try {
            cwLog("info", "live_sync", {
              clip: stream.id, avSyncMs: d.avSyncMs, outLatencyMs: d.outLatencyMs, avOffsetMs: d.avOffsetMs || 0,
              driftMs: d.driftMs, audioDecResets: d.audioDecResets || 0, audioCtxState: d.audioCtxState || null,
              audioUnderruns: d.audioUnderruns || 0, audioGaps150: d.audioGaps150 || 0, audioMaxGapMs: d.audioMaxGapMs || 0,
              framesLate: d.framesLate || 0, framesDropped: d.framesDropped || 0, framesShown: d.framesShown || 0,
              audioOut: d.audioOut || null, outW: d.outW, jpegQ: d.jpegQ, variantH: d.variantH, qLevel: d.qLevel, qChanges: d.qChanges || 0, encMsAvg: d.encMsAvg, jpegKB: d.jpegKB, mediaEls: (d.videoEls || 0) + (d.audioEls || 0)
            });
          } catch (_) {}
        }
      },
      onStage: function (stage) {
        if (livePlayer !== thisPlayer) return;
        if (liveStatusEl) liveStatusEl.textContent = stage;
        if (liveStageStatus) {
          var show = stage && stage !== "playing";
          liveStageStatus.hidden = !show;
          if (show) liveStageStatus.textContent = stage;
        }
        updateLiveStageUi(liveActive && stage !== "stopped" && stage !== "ended" && stage !== "error", false);
      },
      onHud: function (h) {
        if (livePlayer !== thisPlayer) return;
        hud.time.textContent = (h.time || 0).toFixed(1) + "s";
        hud.frames.textContent = String(h.framesDrawn || 0);
        hud.fps.textContent = "buf " + (h.bufferMs || 0) + "ms";
        frameCount = h.framesDrawn || 0;
      }
    });
    renderLiveDiag(livePlayer.diag);
    try {
      await livePlayer.play(stream);
    } catch (e) {
      liveActive = false;
      if (liveStatusEl) liveStatusEl.textContent = "Error: " + (e && e.message || e);
      updateLiveStageUi(false, false);
    }
  }

  function initLiveTab() {
    if (!liveList || !window.LiveHls) {
      cwLog("warn", "error", { msg: "LiveHls not available" });
      return;
    }
    var wcOk = !!(typeof VideoDecoder !== "undefined" && typeof VideoFrame !== "undefined");
    if (liveWcBanner) liveWcBanner.hidden = wcOk;
    LiveHls.STREAMS.forEach(function (s) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "clip live";
      btn.dataset.id = s.id;
      btn.setAttribute("role", "listitem");
      var thumb = document.createElement("div"); thumb.className = "thumb";
      var badge = document.createElement("span"); badge.textContent = "LIVE";
      thumb.appendChild(badge);
      var txt = document.createElement("div");
      var t = document.createElement("div"); t.className = "title"; t.textContent = s.title;
      var a = document.createElement("div"); a.className = "artist"; a.textContent = s.subtitle;
      var m = document.createElement("div"); m.className = "meta"; m.textContent = s.note;
      txt.appendChild(t); txt.appendChild(a); txt.appendChild(m);
      btn.appendChild(thumb); btn.appendChild(txt);
      btn.addEventListener("click", function () { startLiveStream(s); });
      liveList.appendChild(btn);
    });
    renderLiveDiag({
      webCodecs: wcOk,
      audioDecoder: typeof AudioDecoder !== "undefined",
      muxjs: typeof muxjs !== "undefined",
      mp4box: typeof MP4Box !== "undefined",
      stage: "idle", segmentsFetched: 0, framesDecoded: 0, framesDrawn: 0,
      framesShown: 0, framesLate: 0, framesDropped: 0, readyQ: 0,
      audioChunks: 0, audioQueuedSec: 0, audioDecQ: 0, audioChunkQ: 0,
      audioUnderruns: 0, audioLastGapMs: 0,
      bufferMs: 0, driftMs: 0, audioBufferedMs: 0,
      videoEls: 0, audioEls: 0, error: null
    });
    if (btnLiveStop) btnLiveStop.addEventListener("click", function () { stopLive(); });
    if (liveStageEl) {
      liveStageEl.addEventListener("click", function () {
        if (!liveActive || !livePlayer) {
          var first = LiveHls.STREAMS[0];
          if (first) startLiveStream(first);
          return;
        }
        // pause/resume via AudioContext suspend
        if (!audioCtx) return;
        if (audioCtx.state === "running") {
          liveUserPaused = true;
          audioCtx.suspend();
          updateLiveStageUi(true, true);
          if (liveStatusEl) liveStatusEl.textContent = "Paused — tap to resume";
        } else {
          liveUserPaused = false;
          audioCtx.resume();
          updateLiveStageUi(true, false);
          if (liveStatusEl) liveStatusEl.textContent = "playing";
        }
      });
    }
    if (tabClips) tabClips.addEventListener("click", function () { switchTab("clips"); });
    if (tabLive) tabLive.addEventListener("click", function () { switchTab("live"); });
    if (params.get("tab") === "live") switchTab("live");
  }


  boot().catch(function (e) {
    setStage("Boot error: " + e.message);
    cwLog("error", "error", { msg: "boot: " + e.message });
  });
})();
