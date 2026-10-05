import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Roles permitted under each top-level path prefix.
 *
 * This is the coarse, route-prefix-level guard. It is defence in depth only:
 * the authoritative check for `/api/*` is `authorizeRole()` inside each route
 * handler, which reads the role from `profiles` on every request. Both layers
 * resolve the role the same way, so they cannot disagree.
 */
const PREFIX_ROLES: Record<string, string[]> = {
  '/ceo': ['ceo'],
  '/driver': ['driver'],
  '/developer': ['developer'],
  '/manager': ['manager'],
  '/api/ceo': ['ceo'],
  '/api/manager': ['manager'],
  '/api/developer': ['developer'],
  /*
   * Fleet management is shared.
   *
   * Fleet data is operational rather than role-specific: a manager runs it day to
   * day, a CEO needs to see and correct it, and a developer needs it when
   * diagnosing. Leaving the routes under `/api/manager` pinned them to that one
   * role here -- and this middleware runs *before* `authorizeRole` and the RLS
   * policies, so the wider role list those two layers declare could never
   * actually be reached.
   *
   * `/fleet` (page) and `/api/fleet` (data) are their own prefixes rather than
   * exceptions to the manager ones, so the path and the admitted roles agree.
   */
  '/api/fleet': ['manager', 'ceo', 'developer'],
  '/fleet': ['manager', 'ceo', 'developer'],
  /*
   * Signed face-photo URLs for reviewer surfaces.
   *
   * Listed explicitly rather than left unmatched. An unmatched `/api/*` path
   * returns `NextResponse.next()` here, which is correct but means the middleware
   * contributes nothing at all -- the route's own `authorizeRole` would be the only
   * gate. Listing it keeps the two layers consistent: both admit the same three
   * roles.
   */
  '/api/reviewer': ['manager', 'ceo', 'developer'],
  // Shared assistant: every authenticated, non-suspended role may use it.
  '/api/ai-assistant': ['ceo', 'manager', 'driver', 'developer'],
  /*
   * The role-agnostic settings fallback at /settings.
   *
   * The four portal routes (/ceo/settings etc.) are already covered by their own
   * prefixes above and are correctly restricted to that role. This one is not a
   * portal, so it needs its own entry or it falls outside the matcher entirely
   * and renders for an unauthenticated visitor. All four roles are admitted
   * because Settings is available to everyone.
   */
  '/settings': ['ceo', 'manager', 'driver', 'developer'],
};

const API_PREFIX = '/api/';

/**
 * Returns the most specific matching prefix (longest first) so that
 * `/api/manager/vehicles` resolves to `/api/manager`, not `/api`.
 */
function resolvePrefix(pathname: string): string | null {
  let best: string | null = null;

  for (const prefix of Object.keys(PREFIX_ROLES)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.length) {
        best = prefix;
      }
    }
  }

  return best;
}

function isApiRequest(pathname: string) {
  return pathname === API_PREFIX || pathname.startsWith(API_PREFIX);
}

/**
 * API callers are fetch/XHR clients, not browsers, so a redirect would hand
 * them a 200 HTML login page instead of a failure they can act on. They get a
 * real status code with a JSON body.
 */
function rejectApi(status: 401 | 403, code: string, message: string) {
  return NextResponse.json(
    { error: status === 401 ? 'Unauthorized' : 'Forbidden', code, message },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const prefix = resolvePrefix(pathname);

  if (!prefix) {
    return NextResponse.next();
  }

  const allowedRoles = PREFIX_ROLES[prefix];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return isApiRequest(pathname)
      ? rejectApi(401, 'auth_unconfigured', 'Authentication is not configured.')
      : NextResponse.redirect(new URL('/login', request.url));
  }

  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options ?? {});
        });
      },
    },
  });

  // `getUser()` revalidates the JWT against the auth server, so a forged or
  // stale cookie cannot pass this gate.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    if (isApiRequest(pathname)) {
      return rejectApi(401, 'session_invalid', 'Your session could not be verified. Please sign in again.');
    }

    const redirectUrl = new URL('/login', request.url);
    redirectUrl.searchParams.set('redirectedFrom', pathname);
    return NextResponse.redirect(redirectUrl);
  }

  // `profiles` is the single source of truth for roles, matching
  // `authorizeRole()` in `lib/auth.ts`. Email-address allowlists are
  // deliberately not used: they can be satisfied by self-registered accounts
  // and would let this layer disagree with the API layer.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) {
    if (isApiRequest(pathname)) {
      return rejectApi(403, 'profile_lookup_failed', 'Unable to resolve the role for this account.');
    }

    return NextResponse.redirect(new URL('/unauthorized', request.url));
  }

  const role = profile?.role ?? null;

  if (!role || !allowedRoles.includes(role)) {
    if (isApiRequest(pathname)) {
      return rejectApi(403, 'role_not_permitted', 'This account cannot access this resource.');
    }

    // Signed in, but wrong portal. Let them recover rather than dead-ending.
    const redirectUrl = new URL('/unauthorized', request.url);
    redirectUrl.searchParams.set('attemptedRole', prefix.replace(/^\/api\//, '/'));
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  // Each prefix is listed twice on purpose. `:path*` requires at least one
  // segment, so the bare portal roots (`/ceo`, `/driver`, `/developer`,
  // `/manager`, `/api`) need their own entry or they slip through un-gated.
  matcher: [
    '/ceo/:path*',
    '/ceo',
    '/driver/:path*',
    '/driver',
    '/developer/:path*',
    '/developer',
    '/manager/:path*',
    '/manager',
    // Shared fleet route, admitted to manager + ceo + developer. Must be listed
    // here as well as in PREFIX_ROLES: the matcher decides whether the middleware
    // runs at all, and an unlisted path is never examined.
    '/fleet/:path*',
    '/fleet',
    // Role-agnostic settings fallback; see the PREFIX_ROLES entry above.
    '/settings/:path*',
    '/settings',
    '/api/:path*',
    '/api',
  ],
};
