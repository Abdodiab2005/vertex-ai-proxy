import { NextRequest, NextResponse } from 'next/server';

export function proxy(req: NextRequest) {
  const sessionCookie = req.cookies.get('gw_admin_session');
  
  if (!sessionCookie) {
    // This is an optimistic UX redirect; the API performs the real authorization check.
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/dashboard',
    '/usage/:path*',
    '/usage',
    '/upstreams/:path*',
    '/upstreams',
    '/models/:path*',
    '/models',
    '/api-keys/:path*',
    '/api-keys',
    '/audit-log/:path*',
    '/audit-log',
    '/settings/:path*',
    '/settings',
    '/request-logs/:path*',
    '/request-logs',
  ],
};
