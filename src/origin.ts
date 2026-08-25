// Compute the public-facing origin of the current request.
//
// Cloudflare Workers see the URL Cloudflare parsed off the incoming
// request, which usually already reflects the public Host (and scheme).
// But when a proxy or a custom domain rewrites hosts, the Host header is
// the more truthful source. This helper prefers, in order:
//
//   1. X-Forwarded-Proto / X-Forwarded-Host  (if a trusted proxy set them)
//   2. Host header + inferred scheme         (https for everything except
//                                             localhost/127.0.0.1)
//   3. new URL(request.url).origin           (final fallback)
//
// The result is used to build absolute URLs in the door, the openapi
// dossier, llms.txt and /.well-known/mcp.json so those documents stay
// accurate regardless of the domain serving them.

export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const fallbackOrigin = url.origin;

  const xfProto = firstToken(request.headers.get("x-forwarded-proto"));
  const xfHost = firstToken(request.headers.get("x-forwarded-host"));
  if (xfHost) {
    const proto = xfProto ?? inferScheme(xfHost);
    return `${proto}://${xfHost}`;
  }

  const host = request.headers.get("host");
  if (host && host.length > 0) {
    // If Host matches what request.url already parsed, keep the parsed
    // scheme — it is authoritative.
    if (host === url.host) return `${url.protocol}//${host}`;
    return `${inferScheme(host)}://${host}`;
  }
  return fallbackOrigin;
}

function firstToken(v: string | null): string | null {
  if (!v) return null;
  const t = v.split(",")[0]?.trim() ?? "";
  return t.length > 0 ? t : null;
}

function inferScheme(host: string): "http" | "https" {
  // Everything on Cloudflare's edge is https. Only local dev is http.
  const hostname = host.split(":")[0] ?? "";
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") {
    return "http";
  }
  return "https";
}
