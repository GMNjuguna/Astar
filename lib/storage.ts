import type { SupabaseBrowserClient } from '@/lib/supabase/client';

/**
 * Buckets holding driver credentials and driver uploads.
 *
 * Both are private: objects are addressed by path and only ever exposed through
 * a short-lived signed URL. Never store or render a permanent URL for them.
 */
export const STORAGE_BUCKETS = {
  credentials: 'driver-credentials',
  documents: 'driver-docs',
} as const;

export type StorageBucket = (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

/** Signed URLs expire after this many seconds. */
export const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Builds a signed URL for a private object.
 *
 * Returns `null` when the path is missing or signing fails, so callers must
 * handle the failure rather than rendering a broken link. Never falls back to
 * `getPublicUrl()`: that would defeat the point of a private bucket.
 */
export async function createDocumentSignedUrl(
  supabase: SupabaseBrowserClient,
  bucket: string,
  filePath: string | null | undefined
): Promise<string | null> {
  if (!filePath) {
    return null;
  }

  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(filePath, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    return null;
  }

  return data.signedUrl;
}

/**
 * Derives the bucket from a legacy `document_url` value so rows written before
 * the private-bucket migration still resolve to something renderable.
 *
 * Supabase public URLs look like `<project>.supabase.co/storage/v1/object/public/<bucket>/<path>`.
 */
export function bucketFromLegacyPublicUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  const marker = '/object/public/';
  const index = url.indexOf(marker);

  if (index === -1) {
    return null;
  }

  const remainder = url.slice(index + marker.length);
  return remainder.split('/')[0] || null;
}

/**
 * Extracts the object path from a legacy public URL, so a pre-migration row can
 * still be turned into a signed URL.
 */
export function pathFromLegacyPublicUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  const marker = '/object/public/';
  const index = url.indexOf(marker);

  if (index === -1) {
    return null;
  }

  const remainder = url.slice(index + marker.length);
  const slash = remainder.indexOf('/');

  return slash === -1 ? null : remainder.slice(slash + 1);
}
