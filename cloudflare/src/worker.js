// Tesla client-decode PoC — Cloudflare Worker.
// Static assets (SPA, /videos, /packs) are served by Workers Static Assets.
// This script only handles POST /api/logs: browser debug log batches → Workers Logs.

const MAX_LINES = 100;
const MAX_BODY = 256 * 1024;

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function sessionIdOf(raw) {
  const s = String(raw ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return s || "unknown";
}

async function handleLogs(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return json(405, { error: "POST only" });

  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, { error: "too large" });
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    return json(400, { error: "bad json" });
  }
  const sessionId = sessionIdOf(body.sessionId);
  const lines = Array.isArray(body.lines) ? body.lines.slice(0, MAX_LINES) : [];
  if (!lines.length) return json(400, { error: "no lines" });

  const cf = request.cf || {};
  const ua = request.headers.get("user-agent") || "";
  for (const line of lines) {
    const row =
      line && typeof line === "object"
        ? { ...line }
        : { ts: Date.now(), level: "info", event: "raw", msg: String(line) };
    row.sessionId ??= sessionId;
    row.source = "car-browser";
    row.colo = cf.colo;
    row.country = cf.country;
    row.ua = ua.slice(0, 200);
    // One structured JSON object per log line → indexed fields in Workers Logs.
    if (row.level === "error") console.error(row);
    else if (row.level === "warn") console.warn(row);
    else console.log(row);
  }
  return json(200, { ok: true, count: lines.length });
}

// Byte-range support for /videos/*.mp4 (Static Assets returns full 200s for Range requests).
async function handleVideo(request, env) {
  const url = new URL(request.url);
  const range = request.headers.get("range");
  const assetReq = new Request(url.toString(), { method: "GET" });
  const res = await env.ASSETS.fetch(assetReq);
  if (res.status !== 200) return res;
  const headers = new Headers(res.headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=86400");
  headers.delete("content-encoding");
  if (!range) {
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(res.body, { status: 200, headers });
  }
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start, end;
  if (m && (m[1] !== "" || m[2] !== "")) {
    if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  }
  if (start === undefined || start >= size || start > end) {
    headers.set("content-range", `bytes */${size}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(request.method === "HEAD" ? null : buf.slice(start, end + 1), { status: 206, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/logs") return handleLogs(request, env);
    if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
    if (url.pathname.startsWith("/videos/") && (request.method === "GET" || request.method === "HEAD")) {
      return handleVideo(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
