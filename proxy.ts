import { NextResponse, type NextRequest } from "next/server";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  getDesktopAuthContext,
  hasValidDesktopSession,
  isDesktopMode,
} from "@/lib/desktop-auth";
import {
  isValidWebSessionToken,
  isValidBasicAuthorization,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
} from "@/lib/web-auth";

function tooManyAttempts(retryAfterMs: number): NextResponse {
  return new NextResponse("Too many failed attempts", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds(retryAfterMs)),
    },
  });
}

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  const passwordEnabled = isWebPasswordEnabled(password);

  // Desktop mode: the shell's session cookie is one accepted credential. The
  // cookie must be exactly one value equal to this run's secret; a mutation
  // must also carry this listener's exact Origin (the transport guard already
  // rejected any other Host/Origin, so this is the second exact check).
  //
  // With a browser password configured, the ordinary Web credentials (Basic or
  // a Web-session cookie) stay accepted as well: the desktop app keeps the
  // password behaviour the shell documents, and a valid desktop cookie never
  // weakens that check. Without a password there is no fallback, so a missing
  // session fails closed (the shell has not handed its secret over yet).
  if (isDesktopMode()) {
    const desktop = getDesktopAuthContext();
    if (desktop && hasValidDesktopSession(request, desktop)) {
      if (request.nextUrl.pathname === "/login") {
        return NextResponse.redirect(new URL("/", request.url));
      }
      const method = request.method.toUpperCase();
      const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
      if (isMutation && (!desktop.origin || request.headers.get("origin") !== desktop.origin)) {
        return isApiRequest
          ? NextResponse.json({ error: "Untrusted API request" }, { status: 403 })
          : new NextResponse("Untrusted request", { status: 403 });
      }
      return NextResponse.next();
    }
    if (!passwordEnabled) {
      // Nothing to log in to; keep the Web build's `/login` redirect and refuse
      // every other page until the shell hands its session over.
      if (request.nextUrl.pathname === "/login") {
        return NextResponse.redirect(new URL("/", request.url));
      }
      return isApiRequest
        ? NextResponse.json({ error: "Desktop session required" }, { status: 401, headers: { "Cache-Control": "no-store" } })
        : new NextResponse("Desktop session required", { status: 403, headers: { "Cache-Control": "no-store" } });
    }
  }

  if (!passwordEnabled) {
    if (request.nextUrl.pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  let authenticated = isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, password);
  const authorization = isApiRequest ? request.headers.get("authorization") : null;
  if (!authenticated && authorization && /^Basic\s/i.test(authorization)) {
    // Every Basic header is a password guess, so it shares the login form's
    // throttle; otherwise any API path (or GET /api/web-auth) answers guesses
    // at full speed. While blocked even the right password is refused, or the
    // answer would leak. A success does not reset the counter: Basic clients
    // authenticate on every request, and each reset would hand an interleaved
    // guesser a fresh short block.
    const retryAfterMs = getAuthRetryAfterMs();
    if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);
    authenticated = isValidBasicAuthorization(authorization, password);
    if (!authenticated) recordAuthFailure();
  }
  if (request.nextUrl.pathname === "/login") {
    return authenticated
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }
  if (request.nextUrl.pathname === "/api/web-auth") return NextResponse.next();

  if (!authenticated) {
    if (!isApiRequest) {
      const loginUrl = new URL("/login", request.url);
      if (request.nextUrl.search) {
        loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      }
      return NextResponse.redirect(loginUrl);
    }
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/api/:path*"] };
