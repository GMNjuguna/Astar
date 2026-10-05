import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * A request-scoped Supabase client with full table typing.
 *
 * `@supabase/ssr@0.6.x` declares `createServerClient<Database, SchemaName, Schema>`
 * (three generic slots), but `@supabase/supabase-js@2.116` widened `SupabaseClient`
 * to five slots (`Database, SchemaNameOrClientOptions, SchemaName, Schema,
 * ClientOptions`). The `Schema` object therefore lands in the `SchemaName` slot
 * and `Schema` resolves to `never`, which silently collapses every `.from()` to
 * `never[]` and forces `as any` across the codebase.
 *
 * This is a compile-time-only skew — runtime behaviour is unaffected — so we
 * re-assert the correct client type here instead of casting at every call site.
 * Remove this once `@supabase/ssr` is bumped in lockstep with `@supabase/supabase-js`.
 */
export type SupabaseServerClient = SupabaseClient<Database>;

export function createSupabaseServerClient(): SupabaseServerClient {
  const cookieStore = cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder-project.supabase.co';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-anon-key';

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: Record<string, unknown>) {
        cookieStore.set({ name, value, ...options });
      },
      remove(name: string, options: Record<string, unknown>) {
        cookieStore.set({ name, value: '', ...options });
      },
    },
    // See the `SupabaseServerClient` doc comment for why this cast is needed.
  }) as unknown as SupabaseServerClient;
}
