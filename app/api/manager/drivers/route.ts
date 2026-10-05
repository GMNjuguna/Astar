/**
 * Onboarding verification queue: list, submit, and review driver candidates.
 *
 * ── Why this route had to be rewritten ─────────────────────────────────────
 * The previous version reported `rejected` entries as `pending`, so a manager
 * could never see a rejection they had made. It also accepted `documents` and
 * `storageBucket` in the POST body, stored neither (no such columns existed), and
 * replied "Temporary setup credentials were generated and sent to …" without
 * sending anything. Both were silent-failure shapes rather than errors.
 *
 * ── Role scope ─────────────────────────────────────────────────────────────
 * `ceo` is admitted alongside `manager`, matching the task: the queue is
 * reviewed by both. The backing policy in baseline.sql section 6 was widened to
 * match — it previously allowed `select` for the CEO but not `update`, so the
 * CEO's approve control would have failed at the database.
 *
 * All reads and writes use the caller's own RLS-scoped client.
 */
import { NextResponse } from 'next/server';

import { badRequestResponse, databaseErrorResponse, notFoundResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import {
  buildDocumentPath,
  normalizeContentType,
  validateUploadedFile,
  type DriverDocumentType,
} from '@/lib/documents';
import { STORAGE_BUCKETS } from '@/lib/storage';
import { mapQueueRow, type QueueRow, type QueueStatus } from '@/lib/onboarding';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['manager', 'ceo'];

// Row shape, status union and the row -> API mapping live in lib/onboarding.ts.
// Next.js rejects any non-HTTP export from a route.ts, so a mapper defined
// here could not be imported or asserted against from anywhere else.
export type { QueueEntry } from '@/lib/onboarding';


export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  const { data, error } = await auth.supabase
    .from('driver_onboarding_queue')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return databaseErrorResponse(error, 'load driver onboarding queue');
  }

  const rows = (data ?? []) as QueueRow[];

  return NextResponse.json({
    ok: true,
    entries: rows.map(mapQueueRow),
    /** Distinguishes "queried fine, queue is empty" from a failed load. */
    empty: { entries: rows.length === 0 },
  });
}

/**
 * Submits a candidate to the queue together with their scanned documents.
 *
 * The files go to `driver-credentials` rather than `driver-docs`: this is a
 * manager uploading on a driver's behalf, and the storage policies grant
 * managers INSERT only into `driver-credentials`. The object key is namespaced
 * by the queue entry id, which is the only stable identifier available — a
 * candidate has no auth account yet, so there is no `profiles.id` to namespace
 * by. Reviewer reads cover the whole bucket, so previews still resolve.
 */
export async function POST(request: Request) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return badRequestResponse('Submission must be sent as multipart/form-data.');
  }

  const read = (key: string) => String(formData.get(key) ?? '').trim().replace(/\s+/g, ' ');

  const fullName = read('fullName');
  const phone = read('phone');
  const nationalId = read('nationalId');
  const drivingLicense = read('drivingLicense');
  const dailyTarget = read('dailyRemittanceTarget');
  const assignedCar = read('assignedCar') || null;
  const verificationStatus = read('verificationStatus');

  if (!fullName || !phone || !nationalId || !drivingLicense) {
    return badRequestResponse('Full name, phone, national ID and driving licence are all required.');
  }

  const target = Number(dailyTarget);

  if (!Number.isFinite(target) || target < 0) {
    return badRequestResponse('Daily remittance target must be a number of 0 or more.');
  }

  const nationalIdFile = formData.get('nationalIdFile');
  const drivingLicenseFile = formData.get('drivingLicenseFile');

  if (!(nationalIdFile instanceof File) || !(drivingLicenseFile instanceof File)) {
    return badRequestResponse('Both a national ID scan and a driving licence scan are required.');
  }

  const idCheck = validateUploadedFile(nationalIdFile, 'National ID scan');
  const licenceCheck = validateUploadedFile(drivingLicenseFile, 'Driving licence scan');

  if (!idCheck.ok) {
    return badRequestResponse(idCheck.message);
  }

  if (!licenceCheck.ok) {
    return badRequestResponse(licenceCheck.message);
  }

  const bucket = STORAGE_BUCKETS.credentials;

  // Insert first so the row id is available as the storage namespace. If an
  // upload then fails the row is removed again, so a failed submission does not
  // leave a candidate in the queue that a reviewer cannot inspect.
  const { data: inserted, error: insertError } = await auth.supabase
    .from('driver_onboarding_queue')
    .insert({
      // `manager_id` comes from the session, never the request body.
      manager_id: auth.profile.id,
      full_name: fullName,
      phone,
      national_id: nationalId,
      driving_license_number: drivingLicense,
      assigned_car: assignedCar,
      daily_remittance_target: target,
      verification_status: verificationStatus === 'auto_verified' ? 'auto_verified' : 'needs_manual_review',
      status: 'pending',
    })
    .select()
    .single();

  if (insertError) {
    return databaseErrorResponse(insertError, 'insert driver_onboarding_queue record');
  }

  const row = inserted as QueueRow;
  const uploads: Array<{
    column: 'national_id_storage_path' | 'driving_license_storage_path';
    docType: DriverDocumentType;
    file: File;
    label: string;
  }> = [
    {
      column: 'national_id_storage_path',
      docType: 'national_id',
      file: nationalIdFile,
      label: 'National ID scan',
    },
    {
      column: 'driving_license_storage_path',
      docType: 'driving_license',
      file: drivingLicenseFile,
      label: 'Driving licence scan',
    },
  ];

  // Typed as the exact update shape rather than a generic record: the generated
  // PostgREST types reject an arbitrary key index, which is what stops a column
  // name assembled at runtime from silently reaching the wrong column.
  const paths: {
    national_id_storage_path?: string;
    driving_license_storage_path?: string;
  } = {};

  for (const upload of uploads) {
    const path = buildDocumentPath(row.id, upload.docType, upload.file.name);

    const { error: uploadError } = await auth.supabase.storage.from(bucket).upload(path, upload.file, {
      contentType: normalizeContentType(upload.file.type) || 'application/octet-stream',
      cacheControl: '3600',
      upsert: false,
    });

    if (uploadError) {
      // Roll the row back so the queue never lists a candidate whose documents
      // could not be uploaded — a manager would have nothing to review and no
      // way to tell why.
      await auth.supabase.from('driver_onboarding_queue').delete().eq('id', row.id);

      return databaseErrorResponse(uploadError, `upload ${upload.label}`);
    }

    paths[upload.column] = path;
  }

  const { data: updated, error: updateError } = await auth.supabase
    .from('driver_onboarding_queue')
    .update(paths)
    .eq('id', row.id)
    .select()
    .single();

  if (updateError) {
    return databaseErrorResponse(updateError, 'record uploaded document paths');
  }

  return NextResponse.json({ ok: true, entry: mapQueueRow((updated ?? row) as QueueRow) });
}

/**
 * Approve or reject a queued candidate.
 *
 * Approve:
 *  - marks the entry `approved` and stamps `reviewed_at`;
 *  - activates the linked profile when there is one.
 *
 * Reject:
 *  - marks the entry `rejected` and stores the reason;
 *  - moves the driver's documents to `action_required` so the driver is told to
 *    resubmit rather than that their document was refused.
 *
 * The profile activation is conditional and reported explicitly. A queue entry may
 * legitimately have no account yet (`driver_id` is nullable), and in that case
 * there is no row to activate — reporting success without saying so would leave a
 * reviewer believing a driver was enabled when nothing happened.
 */
export async function PATCH(request: Request) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  let payload: { entryId?: unknown; action?: unknown; reason?: unknown };

  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return badRequestResponse('Request body must be valid JSON.');
  }

  const entryId = typeof payload.entryId === 'string' ? payload.entryId : '';
  const action = payload.action;

  if (!entryId) {
    return badRequestResponse('An "entryId" is required.');
  }

  if (action !== 'approve' && action !== 'reject') {
    return badRequestResponse('"action" must be either "approve" or "reject".');
  }

  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';

  if (action === 'reject' && !reason) {
    return badRequestResponse('A rejection reason is required so the driver knows what to fix.');
  }

  const { data: existing, error: lookupError } = await auth.supabase
    .from('driver_onboarding_queue')
    .select('*')
    .eq('id', entryId)
    .maybeSingle();

  if (lookupError) {
    return databaseErrorResponse(lookupError, 'load onboarding entry for review');
  }

  if (!existing) {
    return notFoundResponse('That onboarding entry does not exist.');
  }

  const row = existing as QueueRow;

  if (row.status !== 'pending') {
    return badRequestResponse(
      `This entry was already ${row.status.replace('_', ' ')} and cannot be reviewed again.`
    );
  }

  const reviewedAt = new Date().toISOString();

  const patch =
    action === 'approve'
      ? { status: 'approved' as const, reviewed_at: reviewedAt, rejection_reason: null }
      : { status: 'rejected' as const, reviewed_at: reviewedAt, rejection_reason: reason };

  const { data: updated, error: updateError } = await auth.supabase
    .from('driver_onboarding_queue')
    .update(patch)
    .eq('id', entryId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (updateError) {
    return databaseErrorResponse(updateError, `record ${action} decision`);
  }

  // `.eq('status','pending')` above makes this a compare-and-set: a second
  // concurrent reviewer loses the race and gets null instead of overwriting the
  // first decision.
  if (!updated) {
    return badRequestResponse('This entry was reviewed by someone else a moment ago. Reload the queue.');
  }

  let profileActivated = false;

  if (action === 'approve' && row.driver_id) {
    const { error: profileError } = await auth.supabase
      .from('profiles')
      .update({ status: 'active' })
      .eq('id', row.driver_id);

    if (profileError) {
      // The queue decision is already committed and must not be silently undone.
      // Reported as a partial success so the reviewer knows to chase the profile.
      return NextResponse.json({
        ok: false,
        partial: true,
        error: {
          code: 'profile_activation_failed',
          message:
            'The entry was approved, but the linked driver profile could not be activated. Check the profile status manually.',
        },
        entry: mapQueueRow(updated as QueueRow),
      }, { status: 500 });
    }

    profileActivated = true;
  }

  if (action === 'reject' && row.driver_id) {
    const { error: documentsError } = await auth.supabase
      .from('driver_documents')
      .update({ status: 'action_required' })
      .eq('driver_id', row.driver_id)
      .in('status', ['pending', 'rejected']);

    if (documentsError) {
      return NextResponse.json({
        ok: false,
        partial: true,
        error: {
          code: 'document_status_update_failed',
          message:
            'The entry was rejected, but the driver\'s documents could not be flagged for resubmission.',
        },
        entry: mapQueueRow(updated as QueueRow),
      }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    entry: mapQueueRow(updated as QueueRow),
    profileActivated,
    /**
     * True when approval succeeded for the queue row but no profile was
     * activated because the candidate has no linked account yet.
     */
    awaitingDriverAccount: action === 'approve' && !row.driver_id,
  });
}