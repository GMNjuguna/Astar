import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

export type SupabaseBrowserClient = SupabaseClient<Database>;

export function createSupabaseClient(): SupabaseBrowserClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder-project.supabase.co';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-anon-key';

  // See the `SupabaseServerClient` doc comment in `lib/supabase/server.ts` for
  // why the same generic-slot skew needs correcting on the browser client too.
  return createBrowserClient<Database>(url, anonKey) as unknown as SupabaseBrowserClient;
}

export const supabase = typeof window !== 'undefined' ? createSupabaseClient() : null;
