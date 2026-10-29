/* Live Streaming tab — fixed list of public HLS test feeds.
 * master/media playlist → demux (MPEG-TS via mux.js, or fMP4 via mp4box) →
 * WebCodecs → canvas → JPEG <img>, audio via AudioDecoder + Web Audio.
 * Zero <video>/<audio> elements. No user playlist URL, no proxy, nothing rehosted.
 */
(function (global) {
  "use strict";

  var LIVE_STREAMS = [
    {
      id: "unified-live",
      title: "Unified Streaming live",
      subtitle: "True live HLS test (MPEG-TS)",
      note: "Demo feed © Unified Streaming — not rehosted",
      live: true,
      url: "https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8"
    },
    {
      id: "mux-bbb",
      title: "Mux · Big Buck Bunny",
      subtitle: "VOD HLS test (MPEG-TS)",
      note: "Big Buck Bunny © Blender Foundation (CC BY) via Mux test-streams — not rehosted",
      live: false,
      url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
    },
    {
      id: "tears",
      title: "Tears of Steel",
      subtitle: "VOD HLS test (MPEG-TS)",
      note: "Tears of Steel © Blender Foundation (CC BY) via Unified Streaming demo — not rehosted",
      live: false,
      url: "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8"
    },
    {
      id: "apple",
      title: "Apple HLS example (fMP4)",
      subtitle: "Official Apple test pattern (VOD)",
      note: "Apple HLS example content — not rehosted",
      live: false,
      url: "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8"
    }
  ];

  function resolveUrl(base, rel) {
    try { return new URL(rel, base).href; } catch (_) { return rel; }
  }

  function parseAttrs(s) {
    var out = {}, re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi, m;
    while ((m = re.exec(s))) out[m[1].toUpperCase()] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }

  function parseM3u8(text, playlistUrl) {
    var lines = String(text || "").split(/\r?\n/);
    var baseUrl = playlistUrl;
    var isMaster = false, variants = [], medias = [], segments = [];
    var targetDuration = 6, mediaSequence = 0, endList = false, map = null;
    var i, j, line, attrs, next, look, br, uri, dur, bm;

    for (i = 0; i < lines.length; i++) {
      line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
        isMaster = true;
        attrs = parseAttrs(line.slice(18));
        next = "";
        for (j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() && lines[j].trim().charAt(0) !== "#") {
            next = lines[j].trim(); i = j; break;
          }
        }
        if (next) {
          variants.push({
            bandwidth: parseInt(attrs.BANDWIDTH || attrs["AVERAGE-BANDWIDTH"] || "0", 10) || 0,
            resolution: attrs.RESOLUTION || "",
            codecs: attrs.CODECS || "",
            audio: attrs.AUDIO || "",
            url: resolveUrl(baseUrl, next)
          });
        }
      } else if (line.indexOf("#EXT-X-MEDIA:") === 0) {
        attrs = parseAttrs(line.slice(13));
        if ((attrs.TYPE || "").toUpperCase() === "AUDIO" && attrs.URI) {
          medias.push({
            groupId: attrs["GROUP-ID"] || "",
            name: attrs.NAME || "",
            defaultYes: (attrs.DEFAULT || "").toUpperCase() === "YES",
            channels: attrs.CHANNELS || "",
            url: resolveUrl(baseUrl, attrs.URI)
          });
        }
      } else if (line.indexOf("#EXT-X-TARGETDURATION:") === 0) {
        targetDuration = parseFloat(line.slice(22)) || targetDuration;
      } else if (line.indexOf("#EXT-X-MEDIA-SEQUENCE:") === 0) {
        mediaSequence = parseInt(line.slice(22), 10) || 0;
      } else if (line.indexOf("#EXT-X-ENDLIST") === 0) {
        endList = true;
      } else if (line.indexOf("#EXT-X-MAP:") === 0) {
        attrs = parseAttrs(line.slice(11));
        br = null;
        if (attrs.BYTERANGE) {
          look = /^(\d+)(?:@(\d+))?$/.exec(attrs.BYTERANGE);
          if (look) br = { length: +look[1], offset: look[2] !== undefined ? +look[2] : 0 };
        }
        map = { url: resolveUrl(baseUrl, attrs.URI), byterange: br };
      } else if (line.indexOf("#EXTINF:") === 0) {
        dur = parseFloat(line.slice(8));
        br = null; uri = null;
        for (j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          look = lines[j].trim();
          if (!look) continue;
          if (look.indexOf("#EXT-X-BYTERANGE:") === 0) {
            bm = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?$/.exec(look);
            if (bm) br = { length: +bm[1], offset: bm[2] !== undefined ? +bm[2] : null };
          } else if (look.charAt(0) !== "#") {
            uri = resolveUrl(baseUrl, look); i = j; break;
          }
        }
        if (uri) segments.push({
          duration: dur, url: uri, byterange: br,
          seq: mediaSequence + segments.length
        });
      }
    }
    return {
      isMaster: isMaster, variants: variants, medias: medias, segments: segments,
      targetDuration: targetDuration, mediaSequence: mediaSequence,
      endList: endList, map: map, playlistUrl: playlistUrl
    };
  }

  function pickLowVariant(master) {
    if (!master.variants.length) throw new Error("master playlist has no variants");
    var sorted = master.variants.slice().sort(function (a, b) { return a.bandwidth - b.bandwidth; });
    var withVideo = sorted.filter(function (v) {
      return v.resolution || /avc1|hvc1|hev1|vp09|av01/i.test(v.codecs || "");
    });
    return (withVideo.length ? withVideo : sorted)[0];
  }

  function pickAudio(master, variant) {
    if (!variant.audio) return null;
    var group = master.medias.filter(function (m) { return m.groupId === variant.audio; });
    if (!group.length) return null;
    var stereo = group.filter(function (m) { return m.channels === "2" || /\/a1\//.test(m.url); });
    return stereo[0] || group.filter(function (m) { return m.defaultYes; })[0] || group[0];
  }

  async function fetchText(url) {
    var r = await fetch(url, { credentials: "omit", mode: "cors" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url.replace(/^https?:\/\//, "").split("/").slice(0, 3).join("/").slice(0, 80));
    return { text: await r.text(), url: r.url || url };
  }

  async function fetchBytes(url, byterange) {
    var headers = {};
    if (byterange && byterange.length != null) {
      var start = byterange.offset != null ? byterange.offset : 0;
      headers.Range = "bytes=" + start + "-" + (start + byterange.length - 1);
    }
    var r = await fetch(url, { headers: headers, credentials: "omit", mode: "cors" });
    if (!r.ok && r.status !== 206) throw new Error("segment HTTP " + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  function u8ToBuf(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  function segKey(s) {
    return s.seq + "|" + s.url + "|" + (s.byterange ? (s.byterange.offset + ":" + s.byterange.length) : "full");
  }

  function LivePlayer(opts) {
    this.opts = opts || {};
    this._gen = 0;
    this._stop = false;
    this._timers = [];
    this._videoDec = null;
    this._audioDec = null;
    this._frameQueue = [];
    this._audioQueue = [];
    this._audioCtx = null;
    this._audioStartCtx = 0;
    this._audioMediaStartUs = 0;
    this._nextAudioTime = 0;
    this._avStartCtx = 0;
    this._videoOriginUs = 0;
    this._videoOriginSet = false;
    this._ptsOffsetUs = 0;
    this._lastRawPtsUs = null;
    this._mediaStartUs = 0;
    this._wallStart = 0;
    this._started = false;
    this._audioScheduledSec = 0;
    this.diag = this._freshDiag();
  }

  LivePlayer.prototype._freshDiag = function () {
    return {
      webCodecs: !!(typeof VideoDecoder !== "undefined" && typeof VideoFrame !== "undefined" && typeof EncodedVideoChunk !== "undefined"),
      audioDecoder: typeof AudioDecoder !== "undefined",
      muxjs: typeof muxjs !== "undefined",
      mp4box: typeof MP4Box !== "undefined",
      streamId: null, stage: "idle", variant: "", format: "",
      segmentsFetched: 0, framesDecoded: 0, framesDrawn: 0, audioChunks: 0,
      bufferMs: 0, driftMs: 0, audioBufferedMs: 0,
      error: null, videoEls: 0, audioEls: 0
    };
  };

  LivePlayer.prototype._countEls = function () {
    this.diag.videoEls = document.querySelectorAll("video").length;
    this.diag.audioEls = document.querySelectorAll("audio").length;
  };

  LivePlayer.prototype._emit = function (level, event, fields) {
    if (this.opts.onLog) this.opts.onLog(level, event, fields || {});
  };

  LivePlayer.prototype._setStage = function (stage, extra) {
    this.diag.stage = stage;
    this._countEls();
    if (this.opts.onDiag) this.opts.onDiag(this.diag);
    this._emit("info", "live_stage", Object.assign({ msg: stage, streamId: this.diag.streamId }, extra || {}));
    if (this.opts.onStage) this.opts.onStage(stage, this.diag);
  };

  LivePlayer.prototype._patch = function (p) {
    for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) this.diag[k] = p[k];
    this._countEls();
    if (this.opts.onDiag) this.opts.onDiag(this.diag);
  };

  LivePlayer.prototype.stop = function () {
    this._stop = true;
    this._gen++;
    var t;
    while ((t = this._timers.pop())) clearTimeout(t);
    this._closeDecoders();
    while (this._frameQueue.length) { try { this._frameQueue.shift().close(); } catch (_) {} }
    while (this._audioQueue.length) { try { this._audioQueue.shift().close(); } catch (_) {} }
    this._started = false;
    this._setStage("stopped");
  };

  LivePlayer.prototype._closeDecoders = function () {
    try { if (this._videoDec) this._videoDec.close(); } catch (_) {}
    try { if (this._audioDec) this._audioDec.close(); } catch (_) {}
    this._videoDec = null;
    this._audioDec = null;
  };

  LivePlayer.prototype._aborted = function (gen) {
    return this._stop || gen !== this._gen;
  };

  LivePlayer.prototype._wait = function (ms) {
    var self = this;
    return new Promise(function (resolve) {
      var id = setTimeout(resolve, ms);
      self._timers.push(id);
    });
  };

  LivePlayer.prototype.play = async function (stream) {
    var gen = ++this._gen;
    this._stop = false;
    this._started = false;
    this._audioStartCtx = 0;
    this._audioMediaStartUs = 0;
    this._nextAudioTime = 0;
    this._avStartCtx = 0;
    this._videoOriginUs = 0;
    this._videoOriginSet = false;
    this._ptsOffsetUs = 0;
    this._lastRawPtsUs = null;
    this._audioScheduledSec = 0;
    this._frameQueue = [];
    this._audioQueue = [];
    this._closeDecoders();
    this.diag = this._freshDiag();
    this._patch({ streamId: stream.id, error: null });

    if (!this.diag.webCodecs) {
      var msg = "WebCodecs unavailable (VideoDecoder missing). Live HLS needs WebCodecs; that path previously stalled in the Tesla browser.";
      this._patch({ error: msg });
      this._setStage("WebCodecs unavailable");
      throw new Error(msg);
    }
    if (typeof MP4Box === "undefined") throw new Error("MP4Box demuxer missing");

    try {
      this._setStage("fetch master…");
      var masterRes = await fetchText(stream.url);
      if (this._aborted(gen)) return;
      var master = parseM3u8(masterRes.text, masterRes.url);

      var videoPlUrl, audioPlUrl = null, variantLabel = "media";
      if (master.isMaster) {
        var variant = pickLowVariant(master);
        variantLabel = (variant.resolution || "?") + " @ " + Math.round(variant.bandwidth / 1000) + " kbps";
        this._patch({ variant: variantLabel });
        this._setStage("fetch media playlist…");
        videoPlUrl = variant.url;
        var audioMedia = pickAudio(master, variant);
        if (audioMedia) audioPlUrl = audioMedia.url;
      } else {
        videoPlUrl = masterRes.url;
        this._patch({ variant: "single playlist" });
      }

      await this._runPipeline(stream, videoPlUrl, audioPlUrl, gen);
    } catch (e) {
      if (this._aborted(gen)) return;
      this._patch({ error: String(e && e.message || e) });
      this._setStage("error");
      this._emit("error", "live_error", { msg: String(e && e.message || e), streamId: stream.id });
      throw e;
    }
  };

  LivePlayer.prototype._runPipeline = async function (stream, videoPlUrl, audioPlUrl, gen) {
    var self = this;
    var scratch = this.opts.scratch;
    var scratchCtx = this.opts.scratchCtx;
    var pushFrame = this.opts.pushFrame;
    var ensureAudioCtx = this.opts.ensureAudioCtx;

    var videoTrackInfo = null, audioTrackInfo = null;
    var videoConfigured = false, audioConfigured = false;
    var decoderError = null;

    var file = MP4Box.createFile();
    var filePos = 0;
    var aFile = null, aFilePos = 0;

    function appendVideo(u8) {
      var buf = u8ToBuf(u8);
      buf.fileStart = filePos;
      filePos += buf.byteLength;
      file.appendBuffer(buf);
    }
    function appendAudioFile(u8) {
      var buf = u8ToBuf(u8);
      buf.fileStart = aFilePos;
      aFilePos += buf.byteLength;
      aFile.appendBuffer(buf);
    }

    function getAvcDescription(mp4file, trackId) {
      var trak = mp4file.getTrackById(trackId);
      if (!trak) return null;
      var entries = (((trak.mdia || {}).minf || {}).stbl || {}).stsd
        ? trak.mdia.minf.stbl.stsd.entries : [];
      for (var i = 0; i < (entries || []).length; i++) {
        var entry = entries[i];
        var box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        if (!box) continue;
        if (box.data) return box.data;
        if (typeof DataStream === "undefined") continue;
        try {
          var stream = new DataStream();
          stream.endianness = DataStream.BIG_ENDIAN;
          box.write(stream);
          return new Uint8Array(stream.buffer, 8);
        } catch (_) {}
      }
      return null;
    }

    function getAudioDescription(mp4file, trackId) {
      var trak = mp4file.getTrackById(trackId);
      if (!trak) return null;
      var entries = (((trak.mdia || {}).minf || {}).stbl || {}).stsd
        ? trak.mdia.minf.stbl.stsd.entries : [];
      for (var i = 0; i < (entries || []).length; i++) {
        var entry = entries[i];
        var esds = entry.esds;
        if (!esds && entry.boxes) {
          for (var bi = 0; bi < entry.boxes.length; bi++) {
            if (entry.boxes[bi].type === "esds") { esds = entry.boxes[bi]; break; }
          }
        }
        if (!esds) continue;
        // Prefer the raw AudioSpecificConfig when mp4box exposes it
        try {
          if (esds.esd && esds.esd.descs) {
            for (var di = 0; di < esds.esd.descs.length; di++) {
              var d = esds.esd.descs[di];
              if (d.descs) {
                for (var dj = 0; dj < d.descs.length; dj++) {
                  if (d.descs[dj].data) return d.descs[dj].data;
                }
              }
              if (d.data) return d.data;
            }
          }
        } catch (_) {}
        if (esds.data) return esds.data;
        if (typeof DataStream === "undefined") continue;
        try {
          var stream = new DataStream();
          stream.endianness = DataStream.BIG_ENDIAN;
          esds.write(stream);
          return new Uint8Array(stream.buffer, 8);
        } catch (_) {}
      }
      return null;
    }

    function audioQueueAheadUs() {
      if (!self._audioQueue.length) return 0;
      var a0 = self._audioQueue[0];
      var aN = self._audioQueue[self._audioQueue.length - 1];
      return Math.max(0, (aN.timestamp + (aN.duration || 0)) - a0.timestamp);
    }

    function configureVideo(info, mp4file) {
      if (videoConfigured || !info.videoTracks.length) return;
      videoTrackInfo = info.videoTracks[0];
      var codec = videoTrackInfo.codec || "avc1.42E01E";
      var w = videoTrackInfo.track_width || 640;
      var h = videoTrackInfo.track_height || 360;
      scratch.width = w; scratch.height = h;
      var description = getAvcDescription(mp4file, videoTrackInfo.id);
      self._videoDec = new VideoDecoder({
        output: function (frame) {
          if (self._aborted(gen)) { frame.close(); return; }
          self.diag.framesDecoded++;
          // Remap PTS discontinuities (TS segment joins / PCR jumps) onto a
          // continuous timeline so the audio-locked clock does not stall or
          // skip. A jump >0.5s relative to the prior frame is treated as a
          // discontinuity; smaller gaps (B-frame reorder) pass through.
          var rawTs = frame.timestamp;
          if (self._lastRawPtsUs != null) {
            var delta = rawTs - self._lastRawPtsUs;
            if (delta > 500000 || delta < -500000) {
              var expect = frame.duration || 33333;
              self._ptsOffsetUs += (self._lastRawPtsUs + expect) - rawTs;
            }
          }
          self._lastRawPtsUs = rawTs;
          var adjTs = rawTs + self._ptsOffsetUs;
          try {
            if (typeof frame.timestamp !== "undefined") {
              // VideoFrame.timestamp is readonly; wrap via queue sidecar.
            }
          } catch (_) {}
          if (self._frameQueue.length >= 45) {
            try { frame.close(); } catch (_) {}
            return;
          }
          // Store adjusted PTS on a sidecar; paint loop reads .__ts || .timestamp
          frame.__ts = adjTs;
          var q = self._frameQueue, ts = adjTs, ii = q.length;
          while (ii > 0 && (q[ii - 1].__ts != null ? q[ii - 1].__ts : q[ii - 1].timestamp) > ts) ii--;
          q.splice(ii, 0, frame);
        },
        error: function (e) {
          decoderError = e;
          self._emit("error", "live_decoder", { msg: String(e && (e.message || e)) });
        }
      });
      var config = { codec: codec, codedWidth: w, codedHeight: h, hardwareAcceleration: "no-preference" };
      if (description) config.description = description;
      self._videoDec.configure(config);
      mp4file.setExtractionOptions(videoTrackInfo.id, "video", { nbSamples: 50 });
      videoConfigured = true;
      self._patch({ variant: (self.diag.variant || "") + " · " + codec + " " + w + "x" + h });
    }

    function configureAudio(info, mp4file) {
      if (audioConfigured || !info.audioTracks.length || typeof AudioDecoder === "undefined") return;
      try {
        audioTrackInfo = info.audioTracks[0];
        var codec = audioTrackInfo.codec || "mp4a.40.2";
        self._audioDec = new AudioDecoder({
          output: function (audioData) {
            if (self._aborted(gen)) { audioData.close(); return; }
            self.diag.audioChunks++;
            // Never drop oldest — that caused ~1–2s of audio then silence.
            // Soft safety cap only; decode backpressure keeps this small.
            if (self._audioQueue.length >= 400) {
              try { audioData.close(); } catch (_) {}
              return;
            }
            self._audioQueue.push(audioData);
          },
          error: function (e) {
            self._emit("warn", "live_audio_dec", { msg: String(e && (e.message || e)) });
          }
        });
        var aConfig = {
          codec: codec,
          numberOfChannels: (audioTrackInfo.audio && audioTrackInfo.audio.channel_count) || 2,
          sampleRate: (audioTrackInfo.audio && audioTrackInfo.audio.sample_rate) || 48000
        };
        var aDesc = getAudioDescription(mp4file, audioTrackInfo.id);
        if (aDesc) aConfig.description = aDesc;
        self._audioDec.configure(aConfig);
        mp4file.setExtractionOptions(audioTrackInfo.id, "audio", { nbSamples: 50 });
        audioConfigured = true;
        if (ensureAudioCtx) {
          try { self._audioCtx = ensureAudioCtx(); } catch (_) {}
        }
      } catch (e) {
        self._emit("warn", "live_audio_cfg", { msg: e.message });
        self._audioDec = null;
      }
    }

    file.onError = function (e) { self._emit("error", "live_mp4box", { msg: String(e) }); };
    file.onReady = function (info) {
      configureVideo(info, file);
      configureAudio(info, file);
      file.start();
    };
    file.onSamples = function (id, user, list) {
      var i, s, timescale;
      for (i = 0; i < list.length; i++) {
        s = list[i];
        if (user === "video" && self._videoDec && self._videoDec.state === "configured") {
          if (self._frameQueue.length >= 40 || self._videoDec.decodeQueueSize > 20) {
            continue; // backpressure — wait for the paint loop to drain
          }
          timescale = videoTrackInfo.timescale || 1000;
          try {
            self._videoDec.decode(new EncodedVideoChunk({
              type: s.is_sync ? "key" : "delta",
              timestamp: (s.cts * 1e6) / timescale,
              duration: (s.duration * 1e6) / timescale,
              data: s.data
            }));
          } catch (e) { self._emit("warn", "live_decode", { msg: e.message }); }
        } else if (user === "audio" && self._audioDec && self._audioDec.state === "configured") {
          // Keep ~2.5s of decoded audio queued; more causes the old drop/stack bug.
          if (audioQueueAheadUs() > 2.5e6 || self._audioDec.decodeQueueSize > 40) continue;
          timescale = audioTrackInfo.timescale || 44100;
          try {
            self._audioDec.decode(new EncodedAudioChunk({
              type: "key",
              timestamp: (s.cts * 1e6) / timescale,
              duration: (s.duration * 1e6) / timescale,
              data: s.data
            }));
          } catch (_) {}
        }
      }
    };

    if (audioPlUrl) {
      aFile = MP4Box.createFile();
      aFile.onError = function (e) { self._emit("warn", "live_audio_mp4box", { msg: String(e) }); };
      aFile.onReady = function (info) {
        configureAudio(info, aFile);
        aFile.start();
      };
      aFile.onSamples = file.onSamples;
    }

    var transmuxer = null, tsInitSent = false;

    async function loadPlaylist(url) {
      var res = await fetchText(url);
      return parseM3u8(res.text, res.url);
    }

    function prepareSeg(s, offRef) {
      if (!s.byterange) return s;
      var off = s.byterange.offset;
      if (off == null) off = offRef.v != null ? offRef.v : 0;
      offRef.v = off + s.byterange.length;
      return { duration: s.duration, url: s.url, seq: s.seq, byterange: { length: s.byterange.length, offset: off } };
    }

    async function ingestVideoSeg(seg, format) {
      var bytes = await fetchBytes(seg.url, seg.byterange);
      if (self._aborted(gen)) return;
      self.diag.segmentsFetched++;
      if (format === "fmp4") {
        appendVideo(bytes);
        file.flush();
      } else {
        if (!transmuxer) {
          if (typeof muxjs === "undefined") throw new Error("mux.js required for MPEG-TS");
          transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
          transmuxer.on("data", function (segment) {
            if (segment.initSegment && segment.initSegment.byteLength && !tsInitSent) {
              appendVideo(segment.initSegment);
              tsInitSent = true;
            }
            if (segment.data && segment.data.byteLength) appendVideo(segment.data);
          });
        }
        transmuxer.push(bytes);
        transmuxer.flush();
        file.flush();
      }
    }

    async function ingestAudioSeg(seg) {
      if (!aFile) return;
      var bytes = await fetchBytes(seg.url, seg.byterange);
      if (self._aborted(gen)) return;
      appendAudioFile(bytes);
      aFile.flush();
    }

    // Initial playlists
    this._setStage("fetch media playlist…");
    var media = await loadPlaylist(videoPlUrl);
    if (this._aborted(gen)) return;
    if (!media.segments.length && !media.map) {
      throw new Error("media playlist has no segments (upstream empty or 404 variants)");
    }
    var format = media.map ? "fmp4" : "ts";
    this._patch({ format: format === "fmp4" ? "fMP4" : "MPEG-TS" });

    var audioPl = null;
    if (audioPlUrl) {
      try {
        audioPl = await loadPlaylist(audioPlUrl);
      } catch (e) {
        this._emit("warn", "live_audio", { msg: "audio playlist: " + e.message });
      }
    }

    if (media.map) {
      this._setStage("fetch init…");
      appendVideo(await fetchBytes(media.map.url, media.map.byterange));
      file.flush();
    }
    if (audioPl && audioPl.map && aFile) {
      appendAudioFile(await fetchBytes(audioPl.map.url, audioPl.map.byterange));
      aFile.flush();
    }

    var seenV = {}, seenA = {};
    var offV = { v: media.map && media.map.byterange ? media.map.byterange.offset + media.map.byterange.length : null };
    var offA = { v: audioPl && audioPl.map && audioPl.map.byterange ? audioPl.map.byterange.offset + audioPl.map.byterange.length : null };

    this._setStage("buffering…");

    async function fetchNewSegments(pl, seen, offRef, isAudio) {
      var added = 0;
      var list = pl.segments.slice();
      // Build candidate list without advancing byterange offsets yet
      var candidates = [];
      for (var i = 0; i < list.length; i++) {
        var raw = list[i];
        var probe = {
          duration: raw.duration, url: raw.url, seq: raw.seq,
          byterange: raw.byterange ? { length: raw.byterange.length, offset: raw.byterange.offset } : null
        };
        var k = segKey(probe);
        if (seen[k]) continue;
        candidates.push({ raw: raw, key: k });
      }
      if (!pl.endList && candidates.length > 3) candidates = candidates.slice(-3);
      var cap = pl.endList ? 2 : candidates.length;
      for (i = 0; i < Math.min(candidates.length, cap); i++) {
        if (self._aborted(gen)) return added;
        var s = prepareSeg(candidates[i].raw, offRef);
        seen[candidates[i].key] = true;
        seen[segKey(s)] = true;
        if (isAudio) await ingestAudioSeg(s);
        else await ingestVideoSeg(s, format);
        added++;
      }
      return added;
    }

    // Prime buffer
    await fetchNewSegments(media, seenV, offV, false);
    if (audioPl) await fetchNewSegments(audioPl, seenA, offA, true);
    if (this._aborted(gen)) return;

    // Wait briefly for first decoded frames
    var waitStart = performance.now();
    while (!this._aborted(gen) && this._frameQueue.length < 1 && performance.now() - waitStart < 8000) {
      if (decoderError) throw decoderError;
      await this._wait(30);
    }
    if (!this._frameQueue.length && !decoderError) {
      // Keep pulling a bit more for VOD
      if (media.endList) {
        media = await loadPlaylist(videoPlUrl);
        await fetchNewSegments(media, seenV, offV, false);
        waitStart = performance.now();
        while (!this._aborted(gen) && this._frameQueue.length < 1 && performance.now() - waitStart < 6000) {
          if (decoderError) throw decoderError;
          await this._wait(30);
        }
      }
    }
    if (decoderError) throw decoderError;
    if (!this._frameQueue.length) {
      throw new Error("no frames decoded (WebCodecs may be stalling, or stream has no video)");
    }

    this._setStage("playing");
    var lastPull = 0;
    var lastBeat = performance.now();
    var vodDone = false;

    while (!this._aborted(gen)) {
      if (decoderError) throw decoderError;

      // Gapless audio: chain buffers on AudioContext time. Do NOT drop oldest
      // decoded chunks, and do NOT start late buffers at "now" (that stacked
      // ~1–2s of audio then went silent). Timestamp discontinuities (TS PCR
      // wrap / segment joins) are absorbed by the chain.
      if (this._audioCtx && this._audioQueue.length) {
        if (!this._nextAudioTime) {
          this._nextAudioTime = this._audioCtx.currentTime + 0.08;
          this._avStartCtx = this._nextAudioTime;
          if (this._frameQueue.length && !this._videoOriginSet) {
            var f0 = this._frameQueue[0];
            this._videoOriginUs = f0.__ts != null ? f0.__ts : f0.timestamp;
            this._videoOriginSet = true;
          }
          this._audioMediaStartUs = this._audioQueue[0].timestamp;
          this._audioStartCtx = this._nextAudioTime;
        }
        while (this._audioQueue.length) {
          // Keep ~1.25s scheduled ahead in the AudioContext graph
          if (this._nextAudioTime > this._audioCtx.currentTime + 1.25) break;
          // Underrun recovery: if we fell behind, nudge forward slightly
          if (this._nextAudioTime < this._audioCtx.currentTime - 0.02) {
            this._nextAudioTime = this._audioCtx.currentTime + 0.02;
          }
          var ad = this._audioQueue.shift();
          try {
            var nCh = ad.numberOfChannels, frames = ad.numberOfFrames, rate = ad.sampleRate;
            var ab = this._audioCtx.createBuffer(nCh, frames, rate);
            for (var ch = 0; ch < nCh; ch++) {
              var tmp = new Float32Array(frames);
              ad.copyTo(tmp, { planeIndex: ch, format: "f32-planar" });
              ab.copyToChannel(tmp, ch);
            }
            var src = this._audioCtx.createBufferSource();
            src.buffer = ab;
            src.connect(this._audioCtx.destination);
            src.start(this._nextAudioTime);
            this._nextAudioTime += ab.duration;
            this._audioScheduledSec += ab.duration;
          } catch (e) {
            this._emit("warn", "live_audio_sched", { msg: e.message });
          }
          try { ad.close(); } catch (_) {}
        }
        this.diag.audioBufferedMs = Math.max(0, Math.round(
          (this._nextAudioTime - this._audioCtx.currentTime) * 1000
        ));
      }

      // Start picture clock once we have video (and audio has started if present).
      if (!this._started) {
        var haveAudio = !!(this._audioCtx && this._audioStartCtx);
        var needAudio = !!this._audioDec;
        if (this._frameQueue.length && (!needAudio || haveAudio)) {
          this._started = true;
          if (!this._videoOriginSet) {
            var vf0 = this._frameQueue[0];
            this._videoOriginUs = vf0.__ts != null ? vf0.__ts : vf0.timestamp;
            this._videoOriginSet = true;
          }
          this._mediaStartUs = this._videoOriginUs;
          this._wallStart = performance.now();
          if (!this._avStartCtx) {
            // Video-only: wall clock
            this._avStartCtx = 0;
          }
        } else {
          await this._wait(20);
          continue;
        }
      }

      // Picture at real-time 1x, locked to AudioContext when audio is playing.
      // Late frames are dropped; future frames wait. Snap ONLY on a true PTS
      // discontinuity (queue head >> clock). Chasing the decode frontier caused
      // the timelapse.
      var nowVideoUs;
      var elapsedUs;
      if (this._audioCtx && this._avStartCtx) {
        elapsedUs = (this._audioCtx.currentTime - this._avStartCtx) * 1e6;
        nowVideoUs = this._videoOriginUs + elapsedUs;
      } else {
        elapsedUs = (performance.now() - this._wallStart) * 1000;
        nowVideoUs = this._videoOriginUs + elapsedUs;
      }

      function frameTs(f) { return f.__ts != null ? f.__ts : f.timestamp; }

      // Safety net if remap missed a jump (should be rare).
      if (this._frameQueue.length) {
        var headTs = frameTs(this._frameQueue[0]);
        if (headTs > nowVideoUs + 750000) {
          this._videoOriginUs = headTs - elapsedUs;
          nowVideoUs = headTs;
        }
      }

      while (this._frameQueue.length > 1 && frameTs(this._frameQueue[1]) <= nowVideoUs) {
        try { this._frameQueue.shift().close(); } catch (_) {} // drop late
      }
      if (this._frameQueue.length && frameTs(this._frameQueue[0]) <= nowVideoUs + 40000) {
        var fr = this._frameQueue.shift();
        try {
          this.diag.driftMs = Math.round((frameTs(fr) - nowVideoUs) / 1000);
          scratchCtx.drawImage(fr, 0, 0, scratch.width, scratch.height);
          fr.close();
          this.diag.framesDrawn++;
          if (pushFrame) {
            try { var p = pushFrame(gen); if (p && p.then) p.catch(function () {}); } catch (_) {}
          }
        } catch (e) {
          try { fr.close(); } catch (_) {}
          this._emit("warn", "live_paint", { msg: e && e.message || String(e) });
        }
      }

      var newest = this._frameQueue.length ? frameTs(this._frameQueue[this._frameQueue.length - 1]) : nowVideoUs;
      this.diag.bufferMs = Math.max(0, Math.round((newest - nowVideoUs) / 1000));
      if (this.opts.onHud) {
        this.opts.onHud({
          time: Math.max(0, elapsedUs / 1e6),
          framesDrawn: this.diag.framesDrawn,
          framesDecoded: this.diag.framesDecoded,
          bufferMs: this.diag.bufferMs,
          driftMs: this.diag.driftMs
        });
      }
      if (performance.now() - lastBeat > 4000) {
        lastBeat = performance.now();
        this._countEls();
        if (this.opts.onDiag) this.opts.onDiag(this.diag);
        this._emit("info", "live_heartbeat", {
          msg: "decoded=" + this.diag.framesDecoded + " drawn=" + this.diag.framesDrawn +
            " segs=" + this.diag.segmentsFetched + " bufMs=" + this.diag.bufferMs +
            " driftMs=" + this.diag.driftMs + " aBufMs=" + this.diag.audioBufferedMs,
          streamId: stream.id,
          framesDecoded: this.diag.framesDecoded,
          framesDrawn: this.diag.framesDrawn,
          bufferMs: this.diag.bufferMs,
          driftMs: this.diag.driftMs,
          audioBufferedMs: this.diag.audioBufferedMs
        });
      }

      if (vodDone && this._frameQueue.length === 0 &&
          this._audioQueue.length === 0 &&
          (!this._nextAudioTime || !this._audioCtx ||
            this._nextAudioTime <= this._audioCtx.currentTime + 0.05)) {
        this._setStage("ended");
        break;
      }

      // Network pull AFTER A/V so a slow transmux cannot stall audio/picture.
      if (performance.now() - lastPull > (media.endList ? 500 : Math.max(1000, media.targetDuration * 400))) {
        lastPull = performance.now();
        try {
          if (!vodDone) {
            media = await loadPlaylist(videoPlUrl);
            var n = await fetchNewSegments(media, seenV, offV, false);
            if (audioPlUrl) {
              audioPl = await loadPlaylist(audioPlUrl);
              await fetchNewSegments(audioPl, seenA, offA, true);
            }
            if (media.endList && n === 0 && self._frameQueue.length === 0 &&
                (!self._videoDec || self._videoDec.decodeQueueSize === 0)) {
              vodDone = true;
            }
          }
        } catch (e) {
          this._emit("warn", "live_pull", { msg: e.message });
          if (!this._started) throw e;
        }
      }
      await this._wait(8);
    }
  };

  global.LiveHls = {
    STREAMS: LIVE_STREAMS,
    parseM3u8: parseM3u8,
    LivePlayer: LivePlayer
  };
})(window);
