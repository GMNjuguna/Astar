import { NextResponse, type NextRequest } from 'next/server';

import { badRequestResponse, databaseErrorResponse, notFoundResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['ceo'];

/** Mirrors the `public.document_status` enum in supabase/baseline.sql. */
const VALID_STATUSES = ['approved', 'rejected'] as const;
type DocumentStatus = (typeof VALID_STATUSES)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDocumentStatus(value: unknown): value is DocumentStatus {
  return typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value);
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  let body: { documentId?: unknown; status?: unknown };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badRequestResponse('Request body must be valid JSON.');
  }

  const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : '';

  if (!documentId) {
    return badRequestResponse('Missing document identifier.');
  }

  // `driver_documents.id` is a uuid. Without this check a malformed value is
  // rejected by Postgres as `invalid input syntax for type uuid`, which surfaces
  // as a generic 503 and hides a plain client bug behind a database outage.
  if (!UUID_PATTERN.test(documentId)) {
    return badRequestResponse('Document identifier must be a UUID.');
  }

  if (!isDocumentStatus(body.status)) {
    return badRequestResponse(`Status must be one of: ${VALID_STATUSES.join(', ')}.`);
  }

  // `ceo_manage_all_documents` covers SELECT/UPDATE for a CEO, so this runs on
  // the request-scoped client with no service-role bypass: a CEO cannot approve
  // a document that belongs to a row RLS has excluded, and no other role can
  // reach this handler at all.
  //
  // `.select()` after the update is deliberate. Without it PostgREST reports
  // success for a statement that matched zero rows, so approving a deleted
  // document would answer "approved successfully" having changed nothing.
  const { data, error } = await auth.supabase
    .from('driver_documents')
    .update({ status: body.status })
    .eq('id', documentId)
    .select('id, driver_id, document_type, status, storage_bucket, storage_path, document_url, uploaded_at')
    .maybeSingle();

  if (error) {
    return databaseErrorResponse(error, `update driver_documents status for "${documentId}"`);
  }

  if (!data) {
    return notFoundResponse(
      'No document with that identifier exists, or it is not visible to this account.'
    );
  }

  const approved = body.status === 'approved';

  return NextResponse.json({
    ok: true,
    documentId: String(data.id),
    updatedStatus: data.status,
    document: {
      id: String(data.id),
      driverId: String(data.driver_id),
      documentType: String(data.document_type),
      status: String(data.status),
      storageBucket: data.storage_bucket ?? null,
      storagePath: data.storage_path ?? null,
      uploadedAt: data.uploaded_at ?? null,
    },
    message: `Document ${approved ? 'approved' : 'rejected'} successfully.`,
  });
}