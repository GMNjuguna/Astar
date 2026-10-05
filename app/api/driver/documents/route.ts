/**
 * Driver document upload, listing and signed-URL issuance.
 *
 * Every operation runs on the caller's own request-scoped client, so the
 * `driver_manage_own_documents` policy (`auth.uid() = driver_id`) is what scopes
 * the data. The route never selects a row the caller did not create, and never
 * accepts a `driverId` from the request body — the owner is always the session,
 * so a forged body field cannot redirect an upload into another driver's folder.
 *
 * Object keys are `<driver_id>/<document_type>/<filename>`. The storage policies
 * test only the first segment against `auth.uid()`, so ownership is derived from
 * the path rather than trusted from a column.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { badRequestResponse, databaseErrorResponse, notFoundResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import {
  DOCUMENT_TYPE_LABELS,
  buildDocumentPath,
  isDriverDocumentType,
  validateUploadedFile,
} from '@/lib/documents';
import { SIGNED_URL_TTL_SECONDS, STORAGE_BUCKETS } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['driver'];

type DocumentRow = {
  id: string;
  driver_id: string;
  document_type: string;
  status: 'pending' | 'approved' | 'rejected' | 'action_required';
  storage_path: string | null;
  storage_bucket: string | null;
  uploaded_at: string;
};

/** Lists the caller's own documents. */
export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const { data, error } = await auth.supabase
    .from('driver_documents')
    .select('id, driver_id, document_type, status, storage_path, storage_bucket, uploaded_at')
    .eq('driver_id', auth.profile.id)
    .order('uploaded_at', { ascending: false });

  if (error) {
    return databaseErrorResponse(error, 'list driver documents');
  }

  const documents = (data ?? []) as DocumentRow[];

  return NextResponse.json({
    ok: true,
    documents,
    /** Distinguishes "no documents yet" from "the list failed to load". */
    empty: { documents: documents.length === 0 },
  });
}

/**
 * Mints a short-lived signed URL for one of the caller's own documents.
 *
 * Signed on demand and never persisted: a stored signed URL outlives neither the
 * session nor the one-hour window, and re-minting on each view keeps a URL
 * pasted into a chat or a screenshot from resolving later.
 */
export async function POST(request: NextRequest) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const intent = request.nextUrl.searchParams.get('intent');

  if (intent === 'signed-url') {
    return signedUrl(request, auth);
  }

  return upload(request, auth);
}

type Authorized = Extract<
  Awaited<ReturnType<typeof authorizeRole>>,
  { authorized: true }
>;

async function signedUrl(request: NextRequest, auth: Authorized) {
  const documentId = request.nextUrl.searchParams.get('documentId');

  if (!documentId) {
    return badRequestResponse('A "documentId" query parameter is required.');
  }

  // Scoped by driver_id as well as by RLS, so an id belonging to another driver
  // resolves to "not found" rather than an empty success.
  const { data, error } = await auth.supabase
    .from('driver_documents')
    .select('id, storage_path, storage_bucket')
    .eq('id', documentId)
    .eq('driver_id', auth.profile.id)
    .maybeSingle();

  if (error) {
    return databaseErrorResponse(error, 'load document for signing');
  }

  if (!data) {
    return notFoundResponse('That document does not exist, or is not yours.');
  }

  const bucket = data.storage_bucket ?? STORAGE_BUCKETS.documents;
  const path = data.storage_path;

  if (!path) {
    return notFoundResponse(
      'This document has no stored file reference. Please upload it again.'
    );
  }

  const { data: signed, error: signError } = await auth.supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    return databaseErrorResponse(signError ?? new Error('signing failed'), 'sign document URL');
  }

  return NextResponse.json({
    ok: true,
    url: signed.signedUrl,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
  });
}

async function upload(request: NextRequest, auth: Authorized) {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return badRequestResponse('Upload must be sent as multipart/form-data.');
  }

  const documentType = formData.get('documentType');
  const file = formData.get('file');

  if (!isDriverDocumentType(documentType)) {
    return badRequestResponse(
      'documentType must be one of: national_id, driving_license, good_conduct_certificate.'
    );
  }

  if (!(file instanceof File)) {
    return badRequestResponse('A "file" part is required.');
  }

  const label = DOCUMENT_TYPE_LABELS[documentType];
  const check = validateUploadedFile(file, label);

  if (!check.ok) {
    return badRequestResponse(check.message);
  }

  // The owner is the session, never the request body.
  const driverId = auth.profile.id;
  const storagePath = buildDocumentPath(driverId, documentType, file.name);
  const bucket = STORAGE_BUCKETS.documents;

  const { error: uploadError } = await auth.supabase.storage.from(bucket).upload(storagePath, file, {
    // The declared MIME type is passed through rather than inferred, so the
    // object metadata matches what was validated above.
    contentType: file.type || 'application/octet-stream',
    cacheControl: '3600',
    // Never overwrite: a re-upload creates a new object and a new metadata row,
    // so a reviewer can see what was submitted when rather than only the latest.
    upsert: false,
  });

  if (uploadError) {
    return databaseErrorResponse(uploadError, `upload ${label}`);
  }

  // The metadata row is a second, separate write. If it fails the object is
  // orphaned in the bucket — invisible to reviewers and to the driver, since
  // both read this table. Reported honestly rather than silently: the uploaded
  // bytes are unreachable until a human cleans them up.
  const { data: inserted, error: insertError } = await auth.supabase
    .from('driver_documents')
    .insert({
      driver_id: driverId,
      document_type: documentType,
      storage_path: storagePath,
      storage_bucket: bucket,
      status: 'pending',
    })
    .select('id, document_type, status, storage_path, storage_bucket, uploaded_at')
    .single();

  if (insertError) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'document_metadata_write_failed',
          message: `${label} was uploaded but its record could not be saved, so it is not visible to reviewers yet. Please contact an administrator.`,
        },
        /** Lets support locate the orphaned object in the bucket. */
        orphanedStoragePath: storagePath,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, document: inserted as DocumentRow });
}