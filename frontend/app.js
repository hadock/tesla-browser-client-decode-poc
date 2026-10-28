/* Tesla Browser Client Decode PoC — Drive-safe
 * Default path: WebCodecs VideoDecoder + decodeAudioData. Zero <video>/<audio> elements.
 * If VideoDecoder missing: labeled JPEG+PCM pack fallback (still no <video>).
 * Old hidden-<video> canvas path only with ?allowVideo=1 (phone debug).
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const ALLOW_VIDEO = params.get("allowVideo") === "1" || params.get("allowvideo") === "1";
  const FORCE_PACK = params.get("pack") === "1";
  const FORCE_DRIVE = params.get("drive") === "1"; // alias: never allow video

  const frameEl = $("frame");
  const scratch = $("scratch");
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  const btnPlay = $("btnPlay");
  const btnStop = $("btnStop");
  const btnPlayAll = $("btnPlayAll");
  const chkLoop = $("chkLoop");
  const statusEl = $("status");
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
  // Live decode needs VideoDecoder + VideoFrame + EncodedVideoChunk (+ MP4Box demux).
  // Audio uses decodeAudioData on the ArrayBuffer — no AudioDecoder, no <audio> required.
  const webCodecsOk = hasVideoDecoder && hasVideoFrame && hasEncodedVideoChunk && hasMP4Box;

  let catalog = null;
  let selected = null;
  let playing = false;
  let stopRequested = false;
  let playlistMode = false;
  let playlistActive = false;
  let playlistIndex = 0;
  let audioCtx = null;
  let audioSource = null;
  let objectUrl = null;
  let frameCount = 0;
  let fpsWindow = [];
  let hiddenVideo = null; // created ONLY if ALLOW_VIDEO && !FORCE_DRIVE

  function countVideoEls() {
    return document.querySelectorAll("video").length;
  }

  function refreshVideoElHud() {
    const n = countVideoEls();
    hud.videoEl.textContent = String(n);
    hud.videoEl.style.color = n === 0 ? "var(--ok)" : "var(--warn)";
  }

  function setStatus(msg) { statusEl.textContent = msg; }

  function setPath(label, ok) {
    hud.path.textContent = label;
    hud.path.style.color = ok ? "var(--ok)" : "var(--warn)";
  }

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
    hud.audio.textContent = `WebAudio ${buffer.sampleRate}Hz / ${buffer.numberOfChannels}ch`;
    return new Promise((resolve) => { src.onended = () => resolve(); });
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

  /* ---------- Capability probe ---------- */
  function renderCaps() {
    const rows = [
      ["VideoDecoder", hasVideoDecoder],
      ["AudioDecoder", hasAudioDecoder],
      ["VideoFrame", hasVideoFrame],
      ["EncodedVideoChunk", hasEncodedVideoChunk],
      ["OffscreenCanvas", hasOffscreenCanvas],
      ["MP4Box demux", hasMP4Box],
      ["Web Audio", !!(window.AudioContext || window.webkitAudioContext)],
      ["decodeAudioData path", true],
      ["allowVideo flag", ALLOW_VIDEO && !FORCE_DRIVE],
      ["<video> in DOM", countVideoEls() > 0],
      ["Live WebCodecs path", webCodecsOk && !FORCE_PACK],
    ];
    capsGrid.innerHTML = "";
    for (const [k, v] of rows) {
      const div = document.createElement("div");
      const yes = !!v;
      // For "<video> in DOM", zero is the good/Drive-safe state
      const good = (k === "<video> in DOM" || k === "allowVideo flag") ? !yes || (k === "allowVideo flag" && !yes) : yes;
      // simplify: show yes/no literally; color by whether Drive-safe preference holds
      let cls = yes ? "cap-ok" : "cap-no";
      if (k === "<video> in DOM") cls = yes ? "cap-no" : "cap-ok";
      if (k === "allowVideo flag") cls = yes ? "cap-no" : "cap-ok";
      div.innerHTML = `<span class="cap-k">${k}</span><span class="${cls}">${yes ? "yes" : "no"}</span>`;
      capsGrid.appendChild(div);
    }
    hud.web.textContent = webCodecsOk ? "yes" : "no";
    hud.web.style.color = webCodecsOk ? "var(--ok)" : "var(--warn)";
    refreshVideoElHud();
  }

  /* ---------- WebCodecs path (no media elements) ---------- */
  function getAvcDescription(file, trackId) {
    const trak = file.getTrackById(trackId);
    if (!trak) return null;
    const entries = (((trak.mdia || {}).minf || {}).stbl || {}).stsd
      ? trak.mdia.minf.stbl.stsd.entries
      : [];
    for (const entry of entries || []) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (!box) continue;
      if (box.data) return box.data;
      if (typeof DataStream === "undefined") continue;
      try {
        const stream = new DataStream();
        stream.endianness = DataStream.BIG_ENDIAN;
        box.write(stream);
        // Skip 8-byte box header (size + type)
        return new Uint8Array(stream.buffer, 8);
      } catch (e) {
        console.warn("avcC serialize failed", e);
      }
    }
    return null;
  }

  async function demuxMp4(url) {
    const ab = await fetch(url).then((r) => {
      if (!r.ok) throw new Error("fetch " + r.status);
      return r.arrayBuffer();
    });
    const file = MP4Box.createFile();
    const samples = { video: [], audio: [] };
    let infoResolve;
    const infoP = new Promise((r) => { infoResolve = r; });
    file.onError = (e) => console.error("mp4box", e);
    file.onReady = (info) => {
      const vt = info.videoTracks[0];
      const at = info.audioTracks[0];
      if (vt) file.setExtractionOptions(vt.id, "video", { nbSamples: Infinity });
      if (at) file.setExtractionOptions(at.id, "audio", { nbSamples: Infinity });
      file.start();
      infoResolve(info);
    };
    file.onSamples = (id, user, list) => {
      for (const s of list) samples[user].push(s);
    };
    const buf = ab;
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
    const info = await infoP;
    // Give extraction a tick to finish for in-memory files
    await new Promise((r) => setTimeout(r, 30));
    if (typeof file.stop === "function") file.stop();
    return { ab, file, info, samples };
  }

  async function playViaWebCodecs(url) {
    if (!webCodecsOk) throw new Error("WebCodecs unavailable");
    setPath("WebCodecs", true);
    hud.renderer.textContent = "WebCodecs → canvas → JPEG <img>";
    hud.renderer.style.color = "var(--ok)";
    refreshVideoElHud();

    const { ab, file, info, samples } = await demuxMp4(url);
    const videoTrack = info.videoTracks[0];
    if (!videoTrack || !samples.video.length) {
      throw new Error("no video samples in MP4");
    }

    const description = getAvcDescription(file, videoTrack.id);
    const codec = videoTrack.codec || "avc1.42E01E";
    const w = videoTrack.track_width || 1280;
    const h = videoTrack.track_height || 720;
    scratch.width = w;
    scratch.height = h;
    frameEl.width = w;
    frameEl.height = h;

    const timescale = videoTrack.timescale || 1000;
    const decodedFrames = [];
    const videoDecoder = new VideoDecoder({
      output: (frame) => { decodedFrames.push(frame); },
      error: (e) => console.error("VideoDecoder", e),
    });
    const config = { codec, codedWidth: w, codedHeight: h };
    if (description) config.description = description;
    // Prefer hardware, fall back
    try {
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) {
        throw new Error("VideoDecoder config unsupported: " + codec);
      }
    } catch (e) {
      if (e && /unsupported/.test(e.message)) throw e;
      // isConfigSupported may itself be missing — continue
    }
    videoDecoder.configure(config);

    for (const s of samples.video) {
      const chunk = new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: (s.cts * 1e6) / timescale,
        duration: (s.duration * 1e6) / timescale,
        data: s.data,
      });
      try { videoDecoder.decode(chunk); } catch (e) { console.warn(e); }
    }
    await videoDecoder.flush();

    // Audio: decodeAudioData on the same MP4 bytes — no <audio>/<video>
    let audioBuffer = null;
    try {
      const ctx = ensureAudioCtx();
      audioBuffer = await ctx.decodeAudioData(ab.slice(0));
    } catch (e) {
      console.warn("decodeAudioData failed", e);
      hud.audio.textContent = "none";
    }

    setStatus("Playing (WebCodecs → JPEG <img>)");
    btnStop.disabled = false;

    decodedFrames.sort((a, b) => a.timestamp - b.timestamp);
    const t0 = performance.now();
    if (audioBuffer) playDecodedAudioBuffer(audioBuffer);

    let i = 0;
    let lastPresent = -FRAME_INTERVAL_MS;
    while (i < decodedFrames.length && !stopRequested) {
      const now = performance.now() - t0;
      if (now - lastPresent < FRAME_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, 4));
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
      refreshVideoElHud();
    }
    while (i < decodedFrames.length) { decodedFrames[i].close(); i++; }
    try { videoDecoder.close(); } catch (_) {}
  }

  /* ---------- Pack fallback: JPEG sequence + PCM (no <video>, not live decode) ---------- */
  async function playViaPack(meta) {
    if (!meta || !meta.pack) throw new Error("no pack for clip");
    setPath("pack fallback", false);
    hud.renderer.textContent = "JPEG pack → <img> (no live decode, no <video>)";
    hud.renderer.style.color = "var(--warn)";
    refreshVideoElHud();

    const manifest = await fetch(meta.pack).then((r) => {
      if (!r.ok) throw new Error("pack manifest " + r.status);
      return r.json();
    });
    const frames = manifest.frames || [];
    if (!frames.length) throw new Error("empty pack");

    const prefix = manifest.frames_prefix || (`/packs/${meta.slug}/frames/`);
    const fps = manifest.fps || 10;
    const interval = 1000 / fps;

    // Start audio first (s16le PCM)
    let audioDone = Promise.resolve();
    try {
      const pcm = await fetch(manifest.audio).then((r) => {
        if (!r.ok) throw new Error("pcm " + r.status);
        return r.arrayBuffer();
      });
      audioDone = playPcmS16le(
        pcm,
        manifest.audio_sample_rate || 24000,
        manifest.audio_channels || 1
      );
      hud.audio.textContent = `PCM s16le ${manifest.audio_sample_rate}Hz`;
    } catch (e) {
      console.warn("pack audio failed", e);
      hud.audio.textContent = "none";
    }

    setStatus("Playing (pack fallback — JPEG + PCM, no <video>)");
    btnStop.disabled = false;

    const t0 = performance.now();
    for (let i = 0; i < frames.length && !stopRequested; i++) {
      const target = t0 + i * interval;
      const wait = target - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      showJpegUrl(prefix + frames[i]);
      hud.time.textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s";
      refreshVideoElHud();
    }
    if (!stopRequested) await audioDone.catch(() => {});
  }

  /* ---------- Phone-only video-element fallback (?allowVideo=1) ---------- */
  function ensureHiddenVideo() {
    if (hiddenVideo) return hiddenVideo;
    if (!ALLOW_VIDEO || FORCE_DRIVE) {
      throw new Error("video element disabled (Drive-safe mode)");
    }
    const v = document.createElement("video");
    v.id = "hiddenVideo";
    v.playsInline = true;
    v.muted = true;
    v.crossOrigin = "anonymous";
    v.hidden = true;
    v.setAttribute("aria-hidden", "true");
    document.querySelector(".stage").appendChild(v);
    hiddenVideo = v;
    renderCaps();
    refreshVideoElHud();
    return v;
  }

  async function playViaVideoElement(url) {
    setPath("video element (debug)", false);
    hud.renderer.textContent = "hidden <video> → canvas → JPEG (NOT Drive-safe)";
    hud.renderer.style.color = "var(--danger)";
    const v = ensureHiddenVideo();
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.muted = true;
    v.src = url;

    await new Promise((resolve, reject) => {
      const onMeta = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error("video load failed")); };
      const cleanup = () => {
        v.removeEventListener("loadedmetadata", onMeta);
        v.removeEventListener("error", onErr);
      };
      v.addEventListener("loadedmetadata", onMeta);
      v.addEventListener("error", onErr);
    });

    try {
      const ab = await fetch(url).then((r) => r.arrayBuffer());
      const ctx = ensureAudioCtx();
      const decoded = await ctx.decodeAudioData(ab.slice(0));
      playDecodedAudioBuffer(decoded);
    } catch (e) {
      console.warn(e);
      v.muted = false;
      hud.audio.textContent = "element audio";
    }

    scratch.width = v.videoWidth || 1280;
    scratch.height = v.videoHeight || 720;
    await v.play().catch(() => {});
    setStatus("Playing (DEBUG video-element path — blocked in Drive)");
    btnStop.disabled = false;

    let lastCapture = 0;
    await new Promise((resolve) => {
      const loop = async (ts) => {
        if (stopRequested || v.ended || v.paused) { resolve(); return; }
        if (ts - lastCapture >= FRAME_INTERVAL_MS - 2) {
          lastCapture = ts;
          scratchCtx.drawImage(v, 0, 0, scratch.width, scratch.height);
          await pushFrameFromCanvas();
          hud.time.textContent = v.currentTime.toFixed(1) + "s";
          refreshVideoElHud();
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
  }

  /* ---------- Orchestration ---------- */
  function highlightPlaying(slug) {
    [...clipList.querySelectorAll(".clip")].forEach((b) => {
      b.classList.toggle("playing", !!slug && b.dataset.slug === slug);
      if (slug) b.classList.toggle("selected", b.dataset.slug === slug);
    });
  }

  function updateNowPlaying(clip, index, total) {
    if (!clip) { nowPlaying.hidden = true; return; }
    nowPlaying.hidden = false;
    nowPlayingText.textContent = `${clip.artist} — "${clip.title}"`;
    nowPlayingPos.textContent = `(${index + 1} / ${total})`;
  }

  async function playOne(src, meta) {
    resetHud();
    setStatus("Loading…");
    showAttribution(meta || null);
    if (meta && meta.slug) highlightPlaying(meta.slug);

    try {
      // 1) Pack forced
      if (FORCE_PACK && meta && meta.pack) {
        await playViaPack(meta);
        return !stopRequested;
      }
      // 2) WebCodecs live decode (preferred Drive-safe)
      if (webCodecsOk) {
        try {
          await playViaWebCodecs(src);
          return !stopRequested;
        } catch (e) {
          console.warn("WebCodecs failed:", e);
          hud.web.textContent = "failed";
          // Fall through to pack if this is a hosted clip
          if (meta && meta.pack && !stopRequested) {
            setStatus("WebCodecs failed — trying pack fallback…");
            await playViaPack(meta);
            return !stopRequested;
          }
          throw e;
        }
      }
      // 3) No WebCodecs: pack fallback for hosted clips
      if (meta && meta.pack) {
        setStatus("WebCodecs unavailable — pack fallback (no <video>)");
        await playViaPack(meta);
        return !stopRequested;
      }
      // 4) Phone debug only
      if (ALLOW_VIDEO && !FORCE_DRIVE) {
        await playViaVideoElement(src);
        return !stopRequested;
      }
      setPath("blocked", false);
      hud.renderer.textContent = "WebCodecs unavailable — Drive blocks <video>; cannot decode";
      hud.renderer.style.color = "var(--danger)";
      throw new Error("WebCodecs unavailable — Drive blocks <video>; cannot decode. Open with a hosted clip (pack fallback) or use a browser with VideoDecoder.");
    } catch (e) {
      console.error(e);
      setStatus("Error: " + (e && e.message ? e.message : e));
      return false;
    } finally {
      try { if (hiddenVideo) hiddenVideo.pause(); } catch (_) {}
      stopAudio();
      revokeObjectUrl();
      refreshVideoElHud();
    }
  }

  async function playSelected() {
    if (!selected || !selected.src || playing) return;
    playlistMode = false;
    playlistActive = false;
    nowPlaying.hidden = true;
    stopRequested = false;
    playing = true;
    btnPlay.disabled = true;
    btnPlayAll.disabled = true;
    btnStop.disabled = false;

    const ok = await playOne(selected.src, selected.meta || null);
    if (ok) setStatus("Finished");
    else if (stopRequested) setStatus("Stopped");

    playing = false;
    btnPlay.disabled = !selected;
    btnPlayAll.disabled = !(catalog && catalog.clips && catalog.clips.length);
    btnStop.disabled = true;
    highlightPlaying(null);
  }

  async function playPlaylist() {
    if (!catalog || !catalog.clips || !catalog.clips.length || playing) return;
    playlistMode = true;
    playlistActive = true;
    stopRequested = false;
    playing = true;
    playlistIndex = 0;
    btnPlay.disabled = true;
    btnPlayAll.disabled = true;
    btnStop.disabled = false;

    const clips = catalog.clips;
    const total = clips.length;

    while (playlistActive && !stopRequested) {
      const clip = clips[playlistIndex];
      selected = { src: clip.src, meta: clip };
      updateNowPlaying(clip, playlistIndex, total);
      setStatus("Playlist — " + clip.artist);

      const finished = await playOne(clip.src, clip);
      if (!finished || stopRequested) break;

      playlistIndex += 1;
      if (playlistIndex >= total) {
        if (chkLoop && chkLoop.checked) {
          playlistIndex = 0;
          setStatus("Playlist — looping…");
          await new Promise((r) => setTimeout(r, 250));
        } else {
          setStatus("Playlist finished");
          break;
        }
      } else {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    if (stopRequested) setStatus("Playlist stopped");
    playlistActive = false;
    playlistMode = false;
    playing = false;
    btnPlay.disabled = !selected;
    btnPlayAll.disabled = false;
    btnStop.disabled = true;
    highlightPlaying(null);
  }

  function stopPlayback() {
    stopRequested = true;
    playlistActive = false;
    try { if (hiddenVideo) hiddenVideo.pause(); } catch (_) {}
    stopAudio();
    setStatus(playlistMode ? "Playlist stopped" : "Stopped");
  }

  function selectClip(clip) {
    if (playing) return;
    selected = { src: clip.src, meta: clip };
    [...clipList.querySelectorAll(".clip")].forEach((b) => {
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
    [...clipList.querySelectorAll(".clip")].forEach((b) => {
      b.classList.remove("selected");
      b.classList.remove("playing");
    });
    btnPlay.disabled = false;
    showAttribution(null);
    nowPlaying.hidden = true;
    setStatus("Ready — custom URL (WebCodecs only; no pack)");
  }

  async function boot() {
    renderCaps();
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
    btnPlayAll.disabled = catalog.clips.length === 0;

    urlInput.addEventListener("change", () => selectUrl(urlInput.value.trim()));
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") selectUrl(urlInput.value.trim());
    });
    btnPlay.addEventListener("click", () => { if (!playing) playSelected(); });
    btnPlayAll.addEventListener("click", () => { if (!playing) playPlaylist(); });
    btnStop.addEventListener("click", stopPlayback);

    if (!webCodecsOk) {
      setStatus("WebCodecs unavailable — hosted clips will use JPEG+PCM pack (no <video>)");
      setPath("pack (no WebCodecs)", false);
    } else {
      setStatus("Ready — WebCodecs path (no <video>). Tap Play all.");
      setPath("WebCodecs ready", true);
    }
    refreshVideoElHud();
  }

  boot().catch((e) => setStatus("Boot error: " + e.message));
})();
