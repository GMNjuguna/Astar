/**
 * Issues a short-lived signed URL for one scanned document of a queued candidate.
 *
 * The bucket is private, so a signed URL is the only way a reviewer can inspect
 * a scan. It is minted per request and never stored: a URL that outlived its
 * window would either fail confusingly or, worse, keep working after a
 * candidate's review concluded.
 *
 * The entry is loaded first and the caller must be a manager or CEO, which is
 * what the RLS policy on `driver_onboarding_queue` enforces. `reviewers_read_
 * company_documents` separately permits reviewer reads of the bucket itself.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { badRequestResponse, databaseErrorResponse, notFoundResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import { isDriverDocumentType, type DriverDocumentType } from '@/lib/documents';
import { SIGNED_URL_TTL_SECONDS, STORAGE_BUCKETS } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['manager', 'ceo'];

/**
 * Only the two scans a candidate submits are addressable here, so this is a
 * partial map rather than one entry per document type — `good_conduct_certificate`
 * is a driver-side upload and has no column on a queue entry.
 */
const PATH_COLUMNS: Partial<Record<DriverDocumentType, string>> = {
  national_id: 'national_id_storage_path',
  driving_license: 'driving_license_storage_path',
};

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const documentType = request.nextUrl.searchParams.get('document');

  if (!isDriverDocumentType(documentType)) {
    return badRequestResponse(
      'The "document" query parameter must be one of: national_id, driving_license, good_conduct_certificate.'
    );
  }

  // Only the two scans a candidate submits are addressable here.
  const column = PATH_COLUMNS[documentType];

  if (!column) {
    return badRequestResponse('That document type is not part of the onboarding submission.');
  }

  // Columns are selected statically rather than interpolated from `column`: a
  // computed select string defeats PostgREST's type parser and collapses the
  // result to a parse error, which then needs an unsafe cast to read. The
  // `column` value is still used, just as a key into the typed result below.
  const { data, error } = await auth.supabase
    .from('driver_onboarding_queue')
    .select('id, national_id_storage_path, driving_license_storage_path')
    .eq('id', params.id)
    .maybeSingle();

  if (error) {
    return databaseErrorResponse(error, 'load onboarding entry for preview');
  }

  if (!data) {
    return notFoundResponse('That onboarding entry does not exist.');
  }

  const path = data[column as 'national_id_storage_path' | 'driving_license_storage_path'];

  if (!path) {
    return notFoundResponse('No scan was uploaded for that document.');
  }

  const { data: signed, error: signError } = await auth.supabase.storage
    .from(STORAGE_BUCKETS.credentials)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    return databaseErrorResponse(signError ?? new Error('signing failed'), 'sign onboarding scan');
  }

  return NextResponse.json({
    ok: true,
    url: signed.signedUrl,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
  });
}