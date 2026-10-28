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

  async function pushFrameFromCanvas() {
    return new Promise(function (resolve) {
      if (scratch.toBlob) {
        scratch.toBlob(function (blob) {
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

  function showJpegUrl(url) {
    frameEl.src = url;
    frameCount++;
    tickFps();
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

  async function playViaWebCodecs(url) {
    if (!webCodecsOk) throw new Error("WebCodecs unavailable");
    setPath("WebCodecs", true);
    hud.renderer.textContent = "WebCodecs → canvas → JPEG <img>";
    hud.renderer.style.color = "var(--ok)";
    refreshVideoElHud();

    const demuxed = await demuxMp4(url);
    const videoTrack = demuxed.info.videoTracks[0];
    if (!videoTrack || !demuxed.samples.video.length) {
      throw new Error("no video samples in MP4");
    }

    setStage("configure VideoDecoder…");
    const description = getAvcDescription(demuxed.file, videoTrack.id);
    const codec = videoTrack.codec || "avc1.42E01E";
    const w = videoTrack.track_width || 1280;
    const h = videoTrack.track_height || 720;
    scratch.width = w;
    scratch.height = h;
    const timescale = videoTrack.timescale || 1000;

    const decodedFrames = [];
    let decoderError = null;
    const videoDecoder = new VideoDecoder({
      output: function (frame) { decodedFrames.push(frame); },
      error: function (e) {
        decoderError = e;
        cwLog("error", "decoder_error", { msg: String(e && (e.message || e)), stage: "VideoDecoder.onerror" });
        setStage("decoder error: " + (e && e.message ? e.message : e));
      },
    });
    const config = { codec: codec, codedWidth: w, codedHeight: h };
    if (description) config.description = description;
    cwLog("info", "stage", { stage: "configure VideoDecoder…", msg: "codec=" + codec + " desc=" + (description ? description.byteLength + "b" : "none") });

    try {
      if (VideoDecoder.isConfigSupported) {
        const support = await VideoDecoder.isConfigSupported(config);
        if (!support.supported) {
          cwLog("error", "decoder_error", { msg: "config unsupported: " + codec });
          throw new Error("VideoDecoder config unsupported: " + codec);
        }
      }
      videoDecoder.configure(config);
    } catch (e) {
      cwLog("error", "decoder_error", { msg: "configure failed: " + e.message });
      throw e;
    }

    setStage("decode frames…");
    for (let i = 0; i < demuxed.samples.video.length; i++) {
      if (stopRequested) break;
      const s = demuxed.samples.video[i];
      const chunk = new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: (s.cts * 1e6) / timescale,
        duration: (s.duration * 1e6) / timescale,
        data: s.data,
      });
      try { videoDecoder.decode(chunk); } catch (e) {
        cwLog("warn", "decoder_error", { msg: "decode chunk: " + e.message });
      }
    }
    await videoDecoder.flush();
    if (decoderError) throw decoderError;
    if (!decodedFrames.length) throw new Error("VideoDecoder produced 0 frames");

    setStage("decode first frame…");
    decodedFrames.sort(function (a, b) { return a.timestamp - b.timestamp; });
    // Prove first frame paints before we invest in audio
    scratchCtx.drawImage(decodedFrames[0], 0, 0, scratch.width, scratch.height);
    await pushFrameFromCanvas();
    cwLog("info", "stage", { stage: "first frame painted", msg: "decodedFrames=" + decodedFrames.length });

    setStage("audio…");
    let audioBuffer = null;
    try {
      const ctx = ensureAudioCtx();
      audioBuffer = await ctx.decodeAudioData(demuxed.ab.slice(0));
    } catch (e) {
      cwLog("warn", "error", { msg: "decodeAudioData failed: " + e.message });
      hud.audio.textContent = "none";
    }

    setStage("playing");
    cwLog("info", "playing", { msg: "WebCodecs playing", path: "webcodecs" });
    btnStop.disabled = false;
    const t0 = performance.now();
    if (audioBuffer) playDecodedAudioBuffer(audioBuffer);

    let i = 0;
    let lastPresent = -FRAME_INTERVAL_MS;
    // first frame already shown — close it and continue from 1
    decodedFrames[0].close();
    i = 1;
    while (i < decodedFrames.length && !stopRequested) {
      const now = performance.now() - t0;
      if (now - lastPresent < FRAME_INTERVAL_MS) {
        await new Promise(function (r) { setTimeout(r, 4); });
        continue;
      }
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

  /* ---------- Pack fallback ---------- */
  async function playViaPack(meta) {
    if (!meta || !meta.pack) throw new Error("no pack for clip");
    setPath("pack fallback", false);
    hud.renderer.textContent = "JPEG pack → <img> (no live decode, no <video>)";
    hud.renderer.style.color = "var(--warn)";
    refreshVideoElHud();
    cwLog("info", "pack_fallback", { msg: "starting pack playback", clip: meta.slug });

    setStage("fetch pack manifest…");
    const manifest = await fetch(meta.pack).then(function (r) {
      if (!r.ok) throw new Error("pack manifest " + r.status);
      return r.json();
    });
    const frames = manifest.frames || [];
    if (!frames.length) throw new Error("empty pack");
    const prefix = manifest.frames_prefix || ("/packs/" + meta.slug + "/frames/");
    const fps = manifest.fps || 10;
    const interval = 1000 / fps;

    setStage("fetch pack audio…");
    let audioDone = Promise.resolve();
    try {
      const pcm = await fetch(manifest.audio).then(function (r) {
        if (!r.ok) throw new Error("pcm " + r.status);
        return r.arrayBuffer();
      });
      audioDone = playPcmS16le(pcm, manifest.audio_sample_rate || 24000, manifest.audio_channels || 1);
      hud.audio.textContent = "PCM s16le " + (manifest.audio_sample_rate || 24000) + "Hz";
    } catch (e) {
      cwLog("warn", "error", { msg: "pack audio failed: " + e.message });
      hud.audio.textContent = "none";
    }

    setStage("playing");
    cwLog("info", "playing", { msg: "pack playing", path: "pack", frames: frames.length });
    btnStop.disabled = false;

    const t0 = performance.now();
    for (let i = 0; i < frames.length && !stopRequested; i++) {
      const target = t0 + i * interval;
      const wait = target - performance.now();
      if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
      if (i === 0) setStage("first pack frame…");
      showJpegUrl(prefix + frames[i]);
      if (i === 0) {
        setStage("playing");
        cwLog("info", "stage", { stage: "first pack frame painted" });
      }
      hud.time.textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s";
    }
    if (!stopRequested) await audioDone.catch(function () {});
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
        await playViaPack(meta);
        return !stopRequested;
      }

      if (webCodecsOk && src) {
        let firstFrameDone = false;
        const wcPromise = (async function () {
          // Instrument inner stages; resolve "first frame ready" via race below
          await playViaWebCodecs(src);
        })();

        // Race: either WebCodecs reaches playing (frameCount>0) within timeout, or we abort
        const started = Date.now();
        while (!stopRequested && frameCount === 0 && (Date.now() - started) < WC_TIMEOUT_MS) {
          await new Promise(function (r) { setTimeout(r, 100); });
          if (currentStage && /error|timed out/i.test(currentStage)) break;
        }

        if (frameCount === 0 && !stopRequested) {
          stopRequested = true; // abort WC loop
          await Promise.race([wcPromise.catch(function () {}), new Promise(function (r) { setTimeout(r, 200); })]);
          stopRequested = false;
          cwLog("warn", "timeout", {
            msg: "WebCodecs timed out → pack fallback",
            stage: currentStage,
            timeoutMs: WC_TIMEOUT_MS,
            probeSaidYes: webCodecsOk,
          });
          cwLog("warn", "pack_fallback", { msg: "after WebCodecs timeout", probeSaidYes: webCodecsOk });
          setStage("WebCodecs timed out → pack fallback");
          setPath("pack (after WC timeout)", false);
          if (meta && meta.pack) {
            await playViaPack(meta);
            return !stopRequested;
          }
          throw new Error("WebCodecs timed out and no pack available");
        }

        // First frame appeared — wait for rest of playback
        await wcPromise;
        return !stopRequested;
      }

      if (meta && meta.pack) {
        cwLog("info", "pack_fallback", { msg: "WebCodecs unavailable — using pack" });
        setStage("WebCodecs unavailable — pack fallback");
        await playViaPack(meta);
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
          await playViaPack(meta);
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
      if (!playing) playSelected({ tryWebCodecs: true, forcePack: FORCE_PACK });
    });
    btnPlayAll.addEventListener("click", function () {
      if (!playing) playPlaylist({ tryWebCodecs: true, forcePack: false });
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
