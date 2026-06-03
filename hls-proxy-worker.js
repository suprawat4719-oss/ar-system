/**
 * SX Live TV — HLS CORS Proxy
 * Cloudflare Worker
 * 
 * Usage:
 *   https://your-worker.workers.dev/proxy?url=https://edge-2.m-fixer.net:8088/stream/...
 */

const ALLOWED_ORIGINS = [
  "https://suprawat4719-oss.github.io",   // ← GitHub Pages ของคุณ
  "http://localhost",
  "http://127.0.0.1",
];

// Content-types ที่อนุญาต proxy
const ALLOWED_CONTENT = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "video/mp2t",
  "video/mp4",
  "audio/mpeg",
  "audio/aac",
  "text/plain",
  "application/octet-stream",
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url    = new URL(request.url);

    // ─── CORS Preflight ───
    if (request.method === "OPTIONS") {
      return corsResponse(null, origin, 204);
    }

    // ─── Health check ───
    if (url.pathname === "/" || url.pathname === "/health") {
      return corsResponse(
        JSON.stringify({ status: "ok", service: "SX Live HLS Proxy" }),
        origin, 200,
        { "Content-Type": "application/json" }
      );
    }

    // ─── Proxy endpoint ───
    if (url.pathname === "/proxy") {
      const targetUrl = url.searchParams.get("url");

      if (!targetUrl) {
        return corsResponse(
          JSON.stringify({ error: "Missing ?url= parameter" }),
          origin, 400,
          { "Content-Type": "application/json" }
        );
      }

      // ตรวจ URL ปลายทางต้องเป็น http/https
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch {
        return corsResponse(
          JSON.stringify({ error: "Invalid URL" }),
          origin, 400,
          { "Content-Type": "application/json" }
        );
      }

      if (!["http:", "https:"].includes(parsed.protocol)) {
        return corsResponse(
          JSON.stringify({ error: "Only http/https allowed" }),
          origin, 403,
          { "Content-Type": "application/json" }
        );
      }

      try {
        // Forward request ไปยัง stream ต้นทาง
        const refererParam = url.searchParams.get("referer");
        const upstream = await fetch(targetUrl, {
          method:  request.method,
          headers: buildUpstreamHeaders(request, refererParam),
          redirect: "follow",
        });

        const contentType = upstream.headers.get("content-type") || "";

        // ตรวจว่าเป็น m3u8/playlist — รวม text/plain และ #EXTM3U ด้วย
        const looksLikeM3U8 =
          targetUrl.includes(".m3u8") ||
          contentType.includes("mpegurl") ||
          contentType.includes("x-mpegurl") ||
          contentType.includes("text/plain");

        if (looksLikeM3U8) {
          const text = await upstream.text();
          // double-check ด้วย magic header
          if (text.trimStart().startsWith("#EXTM3U") || text.includes("#EXT-X-")) {
            const rewritten = rewriteM3U8(text, targetUrl, url.origin);
            return corsResponse(rewritten, origin, upstream.status, {
              "Content-Type": "application/vnd.apple.mpegurl",
              "Cache-Control": "no-cache, no-store",
            });
          }
          // text/plain แต่ไม่ใช่ m3u8 → ส่งตรงๆ
          return corsResponse(text, origin, upstream.status, {
            "Content-Type": contentType || "text/plain",
            "Cache-Control": "no-cache",
          });
        }

        // ไฟล์อื่น (.ts, .mp4 ฯลฯ) ส่งผ่านตรงๆ
        return corsResponse(upstream.body, origin, upstream.status, {
          "Content-Type": contentType || "application/octet-stream",
          "Cache-Control": "no-cache",
        });

      } catch (err) {
        return corsResponse(
          JSON.stringify({ error: "Upstream fetch failed", detail: err.message }),
          origin, 502,
          { "Content-Type": "application/json" }
        );
      }
    }

    return corsResponse("Not found", origin, 404);
  },
};

// ── แก้ URL ใน .m3u8 ให้ผ่าน proxy ──
// ตาม HLS spec: ทุก non-comment non-empty line คือ URI (segment หรือ child playlist)
function rewriteM3U8(text, baseUrl, workerOrigin) {
  const base = new URL(baseUrl);
  const lines = text.split("\n");

  return lines.map(line => {
    const trimmed = line.trim();

    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      // EXT-X-KEY URI= → แก้ด้วย
      if (trimmed.includes("URI=")) {
        return trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
          const abs = toAbsolute(uri, base);
          return `URI="${workerOrigin}/proxy?url=${encodeURIComponent(abs)}"`;
        });
      }
      // EXT-X-MAP URI= (CMAF/fMP4 init segment)
      return line;
    }

    // ทุก non-comment line คือ URI — proxy ผ่านทั้งหมด
    const abs = toAbsolute(trimmed, base);
    return `${workerOrigin}/proxy?url=${encodeURIComponent(abs)}`;
  }).join("\n");
}

function toAbsolute(uri, base) {
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  if (uri.startsWith("//")) return base.protocol + uri;
  if (uri.startsWith("/")) return base.origin + uri;
  // relative path
  const dir = base.href.substring(0, base.href.lastIndexOf("/") + 1);
  return dir + uri;
}

function buildUpstreamHeaders(request, refererOverride) {
  const h = new Headers();
  const forward = ["user-agent","accept","accept-language","range"];
  for (const k of forward) {
    const v = request.headers.get(k);
    if (v) h.set(k, v);
  }
  if (!h.has("user-agent")) {
    h.set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36");
  }
  // referer จาก query param มีความสำคัญกว่า header
  if (refererOverride) {
    h.set("referer", refererOverride);
    h.set("origin", new URL(refererOverride).origin);
  } else {
    const ref = request.headers.get("referer");
    if (ref) h.set("referer", ref);
  }
  return h;
}

function corsResponse(body, origin, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range, Origin",
    "Access-Control-Expose-Headers":"Content-Length, Content-Range",
    ...extraHeaders,
  });

  return new Response(body, { status, headers });
}
