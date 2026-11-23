import { NextResponse, type NextRequest } from 'next/server';

/**
 * Cheap first gate: no session cookie → go to sign-in, remembering where the person was
 * going. The cookie's validity is checked by the API on every request; this only avoids
 * rendering a page that is certain to redirect.
 */
export function middleware(request: NextRequest) {
  if (request.cookies.has('aiw_session')) return NextResponse.next();
  const url = request.nextUrl.clone();
  const next = request.nextUrl.pathname + request.nextUrl.search;
  url.pathname = '/sign-in';
  url.search = next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except sign-in, the API proxy, Next internals and static files.
  matcher: ['/((?!sign-in|api/|_next/|favicon.ico|.*\\..*).*)'],
};
