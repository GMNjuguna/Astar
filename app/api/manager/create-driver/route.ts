import { NextResponse } from 'next/server';

import { unexpectedErrorResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';
import { buildDocumentPath } from '@/lib/documents';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  FACE_PHOTO_STORAGE_BUCKET,
  buildFacePhotoPath,
  validateFacePhoto,
} from '@/lib/photo';
import { SIGNED_URL_TTL_SECONDS, STORAGE_BUCKETS } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['manager'];

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];

function buildTemporaryPassword(fullName: string) {
  const seed = normalize(fullName).toLowerCase().replace(/[^a-z]/g, '');
  const prefix = seed || 'driver';
  return `${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}@${Math.random().toString(36).slice(2, 8)}!`;
}

/**
 * Resolves this deployment's own origin for driver invitation links.
 *
 * `NEXT_PUBLIC_APP_URL` is the single source of truth for that origin. Trailing
 * slashes are stripped so a value of `https://host/` cannot produce the
 * double-slash `https://host//login`. A missing value throws in production
 * rather than silently emitting `localhost:3000` — an invite pointing at
 * localhost is undeliverable to the driver, and callers check for this before
 * provisioning anyone so no half-created account is left behind.
 */
function resolveInviteOrigin() {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim();
  const origin = configured.replace(/\/+$/, '');

  if (origin) {
    return origin;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_APP_URL is not set.');
  }

  return 'http://localhost:3000';
}

function buildInviteUrl(origin: string, email: string) {
  return `${origin}/login?email=${encodeURIComponent(email)}`;
}

export async function POST(request: Request) {
  // Gate first. The service-role client below must never be reachable before
  // this returns `authorized: true`.
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  // Resolve the deployment origin before any side effect. A missing
  // NEXT_PUBLIC_APP_URL in production is a configuration fault, and failing here
  // means we never provision a driver whose invitation email is unusable.
  let inviteOrigin: string;

  try {
    inviteOrigin = resolveInviteOrigin();
  } catch {
    return NextResponse.json(
      {
        success: false,
        message:
          'Driver invitations cannot be generated because NEXT_PUBLIC_APP_URL is not configured on this deployment.',
      },
      { status: 503 }
    );
  }

  try {
    const formData = await request.formData();

    const fullName = normalize(String(formData.get('fullName') ?? ''));
    const phone = normalize(String(formData.get('phone') ?? ''));
    const nationalId = normalize(String(formData.get('nationalId') ?? ''));
    const drivingLicense = normalize(String(formData.get('drivingLicense') ?? ''));
    const dailyTarget = normalize(String(formData.get('dailyTarget') ?? ''));

    const nationalIdFile = formData.get('nationalIdFile');
    const drivingLicenseFile = formData.get('drivingLicenseFile');
    const passportFile = formData.get('passportFile');
    const facePhotoFile = formData.get('facePhotoFile');

    if (!fullName || !phone || !nationalId || !drivingLicense || !dailyTarget) {
      return NextResponse.json(
        { success: false, message: 'All driver onboarding fields are required.' },
        { status: 400 }
      );
    }

    if (!(nationalIdFile instanceof File) || !(drivingLicenseFile instanceof File) || !(passportFile instanceof File)) {
      return NextResponse.json(
        { success: false, message: 'National ID, driving license, and passport photos are required.' },
        { status: 400 }
      );
    }

    for (const file of [nationalIdFile, drivingLicenseFile, passportFile]) {
      if (!ALLOWED_CONTENT_TYPES.includes(file.type) || file.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { success: false, message: 'Each document must be a PDF, PNG or JPG no larger than 5MB.' },
          { status: 400 }
        );
      }
    }

    /*
     * The face photo is optional, unlike the three documents.
     *
     * Making it required would block onboarding over an image that has no legal
     * bearing on a driver's compliance status, and the driver can add one later
     * from their own portal. When present it is held to the stricter face-photo
     * rules -- images only, magic bytes checked -- rather than the looser
     * document rules above, which permit PDF.
     */
    let facePhotoPath: string | null = null;

    if (facePhotoFile instanceof File && facePhotoFile.size > 0) {
      const photoCheck = await validateFacePhoto(facePhotoFile);

      if (!photoCheck.ok) {
        return NextResponse.json(
          { success: false, message: photoCheck.message },
          { status: 400 }
        );
      }
    }

    // Service-role access is unavoidable here: `auth.admin.createUser`,
    // inserting a profile row owned by another user, and writing to the
    // private credentials bucket are all admin-only operations that RLS cannot
    // express. It is constructed strictly after authorization succeeds.
    const supabase = createSupabaseAdminClient();

    if (!supabase) {
      return NextResponse.json(
        { success: false, message: 'Supabase admin configuration is missing. Please set SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 500 }
      );
    }

    const emailLocalPart = fullName.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
    const email = `${emailLocalPart}.${Date.now()}@driver.astartravels.local`;
    const temporaryPassword = buildTemporaryPassword(fullName);

    const { data: userData, error: createUserError } = await supabase.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        role: 'driver',
        phone,
        provisioned_by: auth.user.id,
      },
    });

    if (createUserError || !userData.user) {
      return NextResponse.json(
        { success: false, message: createUserError?.message ?? 'Unable to create driver account.' },
        { status: 500 }
      );
    }

    const driverId = userData.user.id;

    /*
     * Face photo uploaded here, between account creation and the profile write,
     * so the path can be part of that single insert rather than a second update
     * against a row that may not exist yet.
     *
     * `upsert: true` onto the driver's one fixed key. There is nothing to
     * overwrite on a brand-new driver, but using the same call as the driver's
     * own upload keeps a re-provisioned account from stacking up old photos.
     *
     * Failure here rolls the account back, matching what every other upload in
     * this route does. The alternative — accepting a driver whose photo silently
     * did not save — would leave the manager looking at a success screen for a
     * file that is not there.
     */
    if (facePhotoFile instanceof File && facePhotoFile.size > 0) {
      const candidatePath = buildFacePhotoPath(driverId);

      const { error: photoError } = await supabase.storage
        .from(FACE_PHOTO_STORAGE_BUCKET)
        .upload(candidatePath, facePhotoFile, {
          cacheControl: String(SIGNED_URL_TTL_SECONDS),
          upsert: true,
          contentType: facePhotoFile.type || 'application/octet-stream',
        });

      if (photoError) {
        await supabase.auth.admin.deleteUser(driverId);
        return NextResponse.json(
          {
            success: false,
            message: `Face photo upload failed: ${photoError.message}. The provisional account was rolled back.`,
          },
          { status: 500 }
        );
      }

      facePhotoPath = candidatePath;
    }

    const { error: profileError } = await supabase.from('profiles').upsert(
      {
        id: driverId,
        email,
        full_name: fullName,
        role: 'driver',
        phone,
        // The account exists, but nobody has looked at the scans yet. Leaving
        // this at the column default of 'active' would make the approve action
        // a no-op — it would set a profile to the value it already had, and the
        // verification queue would appear to work while verifying nothing.
        status: 'pending',
        driver_profile_photo_path: facePhotoPath,
      },
      { onConflict: 'id' }
    );

    if (profileError) {
      await supabase.auth.admin.deleteUser(driverId);
      return NextResponse.json(
        { success: false, message: 'Driver profile could not be stored. Account creation was rolled back.' },
        { status: 500 }
      );
    }

    // Object keys are namespaced `<driver_id>/<document_type>/<filename>` so the
    // storage RLS policies can derive ownership from the first path segment and
    // each type's uploads stay grouped.
    const uploads = [
      {
        label: 'nationalId',
        documentType: 'national_id',
        queueColumn: 'national_id_storage_path',
        file: nationalIdFile,
        path: buildDocumentPath(driverId, 'national_id', nationalIdFile.name),
      },
      {
        label: 'drivingLicense',
        documentType: 'driving_license',
        queueColumn: 'driving_license_storage_path',
        file: drivingLicenseFile,
        path: buildDocumentPath(driverId, 'driving_license', drivingLicenseFile.name),
      },
      {
        label: 'passport',
        documentType: 'passport',
        queueColumn: null,
        file: passportFile,
        path: buildDocumentPath(driverId, 'passport', passportFile.name),
      },
    ];

    const uploadedDocuments: Array<{
      label: string;
      documentType: string;
      path: string;
      signedUrl: string;
      expiresInSeconds: number;
    }> = [];

    for (const upload of uploads) {
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKETS.credentials)
        .upload(upload.path, upload.file, {
          cacheControl: '3600',
          upsert: true,
          contentType: upload.file.type || 'application/octet-stream',
        });

      if (uploadError) {
        await supabase.auth.admin.deleteUser(driverId);
        return NextResponse.json(
          {
            success: false,
            message: `Document upload failed: ${uploadError.message}. The provisional account was rolled back.`,
          },
          { status: 500 }
        );
      }

      // The bucket is private, so a signed URL is the only way to hand the
      // manager viewable access. It expires in one hour and the `path` is the
      // durable reference for later re-signing.
      const { data: signed, error: signError } = await supabase.storage
        .from(STORAGE_BUCKETS.credentials)
        .createSignedUrl(upload.path, SIGNED_URL_TTL_SECONDS);

      if (signError || !signed?.signedUrl) {
        // The upload succeeded but is unreachable to the caller. Fail loudly
        // rather than reporting success with a dead link.
        await supabase.auth.admin.deleteUser(driverId);
        return NextResponse.json(
          {
            success: false,
            message: `Document stored but a secure link could not be created: ${signError?.message ?? 'unknown error'}. The provisional account was rolled back.`,
          },
          { status: 500 }
        );
      }

      uploadedDocuments.push({
        label: upload.label,
        documentType: upload.documentType,
        path: upload.path,
        signedUrl: signed.signedUrl,
        expiresInSeconds: SIGNED_URL_TTL_SECONDS,
      });
    }

    /*
     * Record the uploads in the two tables the review workflows actually read.
     *
     * Until this existed, the objects were uploaded and then orphaned: nothing
     * inserted a `driver_documents` row, so the CEO's approval queue could never
     * show them, and nothing inserted a `driver_onboarding_queue` row, so a
     * manager had no pending entry to approve. The files were reachable only
     * through the signed URLs returned in this response, which expire in an hour.
     *
     * Both writes go through the service-role client because `profiles`, and
     * therefore this driver's id, was just created above and the caller's own RLS
     * context cannot yet see the new rows.
     */
    const { error: documentsError } = await supabase.from('driver_documents').insert(
      uploads.map((upload) => ({
        driver_id: driverId,
        document_type: upload.documentType,
        storage_path: upload.path,
        storage_bucket: STORAGE_BUCKETS.credentials,
        status: 'pending',
      }))
    );

    if (documentsError) {
      await supabase.auth.admin.deleteUser(driverId);
      return NextResponse.json(
        {
          success: false,
          message: `Documents were uploaded but could not be recorded for review: ${documentsError.message}. The provisional account was rolled back.`,
        },
        { status: 500 }
      );
    }

    const inviteUrl = buildInviteUrl(inviteOrigin, email);

    const queuePaths: {
      national_id_storage_path: string;
      driving_license_storage_path: string;
    } = {
      national_id_storage_path: uploads[0].path,
      driving_license_storage_path: uploads[1].path,
    };

    const { error: queueError } = await supabase.from('driver_onboarding_queue').insert({
      manager_id: auth.profile.id,
      driver_id: driverId,
      full_name: fullName,
      phone,
      national_id: nationalId,
      driving_license_number: drivingLicense,
      // This form does not collect a vehicle, so `assigned_car` is left null and
      // a manager fills it in later. It is nullable for exactly this reason.
      assigned_car: null,
      daily_remittance_target: Number(dailyTarget),
      setup_email: email,
      setup_link: inviteUrl,
      // `pending`, not `approved`: the account exists, but the documents have not
      // been reviewed yet. The account's `profiles.status` is set to `active` by
      // the approve action, so a candidate cannot be treated as verified before a
      // manager has looked at their scans.
      status: 'pending',
      ...queuePaths,
    });

    if (queueError) {
      await supabase.auth.admin.deleteUser(driverId);
      return NextResponse.json(
        {
          success: false,
          message: `The driver was onboarded but could not be added to the verification queue: ${queueError.message}. The provisional account was rolled back.`,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Driver account created successfully. Documents were uploaded and queued for review.',
      driver: {
        id: driverId,
        email,
        fullName,
        phone,
        nationalId,
        drivingLicense,
        dailyTarget,
        /** False when no photo was supplied, which is allowed. */
        hasFacePhoto: facePhotoPath !== null,
      },
      temporaryPassword,
      inviteUrl,
      uploadedDocuments,
    });
  } catch (error) {
    // The raw exception text used to be returned to the client verbatim, which
    // can name internal hosts, file paths or connection strings. The detail is
    // now kept server-side and the body carries a fixed message.
    return unexpectedErrorResponse(
      `create driver account: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}