import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Cross-origin + rebinding guard for the API.
 *
 * This dashboard is a single-user localhost tool with no auth, and its API can delete projects and
 * spawn edit-enabled Claude agents on the user's repos. Two things must not be possible:
 *
 *  1. **CSRF from any page the user has open.** A bodyless POST (or one sent as text/plain) is a
 *     CORS "simple request": the browser sends it without a preflight, so a route handler would run
 *     before anything could object. Next's own origin checking covers Server Actions, not route
 *     handlers, so we check `Origin` ourselves and reject anything not from this app.
 *  2. **DNS rebinding.** A hostile name resolving to 127.0.0.1 would carry a foreign `Host`, so we
 *     require the request to actually address localhost.
 *
 * GET/HEAD are left alone: they're not state-changing, and blocking them would break normal
 * navigation. Same-origin browser requests send no `Origin` on GET and a matching one on POST.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Hostname without the port, tolerating IPv6 brackets. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1); // [::1]:3000 -> [::1]
  return h.split(":")[0];
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();

  // Reject requests addressed to a host that isn't this machine (DNS rebinding).
  const host = request.headers.get("host");
  if (host && !LOCAL_HOSTNAMES.has(hostnameOf(host))) {
    return NextResponse.json({ error: "invalid host" }, { status: 403 });
  }

  if (SAFE_METHODS.has(request.method)) return NextResponse.next();

  // State-changing request: if it carries an Origin, it must be one of ours. (Browsers always set
  // Origin on cross-origin requests; a same-origin fetch sets it to this app's own origin.)
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return NextResponse.json({ error: "invalid origin" }, { status: 403 });
    }
    if (!LOCAL_HOSTNAMES.has(originHost) && !LOCAL_HOSTNAMES.has(`[${originHost}]`)) {
      return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
