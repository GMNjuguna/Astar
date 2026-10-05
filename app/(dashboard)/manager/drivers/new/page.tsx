'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { DriverAvatar } from '@/components/driver/driver-avatar';
import { FACE_PHOTO_CONTENT_TYPES, MAX_FACE_PHOTO_BYTES } from '@/lib/photo';

type DriverFileMap = {
  nationalId: File | null;
  drivingLicense: File | null;
  passport: File | null;
};

const initialForm = {
  fullName: '',
  phone: '',
  nationalId: '',
  drivingLicense: '',
  dailyTarget: '18000',
};

export default function NewDriverPage() {
  const router = useRouter();
  const [form, setForm] = useState(initialForm);
  const [files, setFiles] = useState<DriverFileMap>({
    nationalId: null,
    drivingLicense: null,
    passport: null,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionMessage, setSubmissionMessage] = useState('');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');

  /**
   * The face photo is optional, unlike the three compliance documents. It is held
   * separately from `files` because it is uploaded to a different bucket under
   * different rules, and the required-file checks must not accidentally include it.
   */
  const [facePhoto, setFacePhoto] = useState<File | null>(null);
  const [facePhotoPreview, setFacePhotoPreview] = useState<string | null>(null);
  const [facePhotoError, setFacePhotoError] = useState<string | null>(null);

  const verificationStatus = useMemo(() => {
    const requiredFiles = [files.nationalId, files.drivingLicense, files.passport].every(Boolean);
    const idIsValid = form.nationalId.trim().length >= 6;
    const licenseIsValid = form.drivingLicense.trim().length >= 6;
    return requiredFiles && idIsValid && licenseIsValid ? 'auto_verified' : 'needs_manual_review';
  }, [files, form.drivingLicense, form.nationalId]);

  const handleFileChange = (field: keyof DriverFileMap, file: File | null) => {
    setFiles((current) => ({ ...current, [field]: file }));
  };

  /**
   * Client-side check for the face photo only.
   *
   * `lib/photo.ts` does this again server-side and also sniffs the magic bytes,
   * which is the check that actually binds. This copy exists so a manager learns
   * the photo is too large before the whole onboarding form is submitted. The
   * constants are imported, not retyped, so the two cannot drift.
   */
  function handleFacePhotoChange(file: File | null) {
    setFacePhotoError(null);

    if (!file) {
      setFacePhoto(null);
      setFacePhotoPreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      return;
    }

    if (file.size > MAX_FACE_PHOTO_BYTES) {
      setFacePhotoError(
        `That photo is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is 5 MB.`
      );
      return;
    }

    const declared = file.type.toLowerCase() === 'image/jpg' ? 'image/jpeg' : file.type.toLowerCase();

    if (!(FACE_PHOTO_CONTENT_TYPES as readonly string[]).includes(declared)) {
      setFacePhotoError('The face photo must be a JPG, PNG or WebP image.');
      return;
    }

    setFacePhotoPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });

    setFacePhoto(file);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!form.fullName || !form.phone || !form.nationalId || !form.drivingLicense || !form.dailyTarget) {
      setSubmissionMessage('All driver onboarding details are required.');
      return;
    }

    if (!files.nationalId || !files.drivingLicense || !files.passport) {
      setSubmissionMessage('All driver document uploads are required.');
      return;
    }

    setIsSubmitting(true);
    setSubmissionMessage('');

    try {
      const payload = new FormData();
      payload.set('fullName', form.fullName);
      payload.set('phone', form.phone);
      payload.set('nationalId', form.nationalId);
      payload.set('drivingLicense', form.drivingLicense);
      payload.set('dailyTarget', form.dailyTarget);
      payload.set('nationalIdFile', files.nationalId);
      payload.set('drivingLicenseFile', files.drivingLicense);
      payload.set('passportFile', files.passport);
      // Sent only when chosen: the part must be absent, not an empty File, or the
      // server sees a zero-byte upload and rejects it.
      if (facePhoto) {
        payload.set('facePhotoFile', facePhoto);
      }

      const response = await fetch('/api/manager/create-driver', {
        method: 'POST',
        body: payload,
      });

      const data = await response.json();

      if (!response.ok || !data?.success) {
        setSubmissionMessage(data?.message || 'Driver onboarding failed.');
        return;
      }

      setSubmissionMessage(data.message || 'Driver account created successfully.');
      setTemporaryPassword(data.temporaryPassword || '');
      setInviteUrl(data.inviteUrl || '');

      setTimeout(() => {
        router.push('/manager');
      }, 1200);
    } catch {
      setSubmissionMessage('Driver creation failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-8 rounded-[2rem] border border-line bg-canvas p-6 text-content shadow-[0_30px_80px_rgba(18,20,24,0.45)] lg:p-8">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Manager Portal</p>
          <h1 className="mt-2 text-3xl font-bold text-content">Driver onboarding</h1>
        </div>
        <span
          className={`inline-flex rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] ${
            verificationStatus === 'auto_verified'
              ? 'bg-chart-collected/10 text-chart-collected'
              : 'bg-chart-servicing/5 text-chart-servicing'
          }`}
        >
          {verificationStatus === 'auto_verified' ? 'Auto verified' : 'Needs manual review'}
        </span>
      </div>

      <form onSubmit={handleSubmit} className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-[1.5rem] border border-line bg-surface/80 p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2 text-sm text-content-muted">
              Full name
              <input
                value={form.fullName}
                onChange={(event) => setForm((current) => ({ ...current, fullName: event.target.value }))}
                className="w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-content outline-none focus:border-accent"
                placeholder="John Kamau"
                required
              />
            </label>

            <label className="space-y-2 text-sm text-content-muted">
              Phone number
              <input
                value={form.phone}
                onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
                className="w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-content outline-none focus:border-accent"
                placeholder="+254 700 000 000"
                required
              />
            </label>

            <label className="space-y-2 text-sm text-content-muted">
              National ID
              <input
                value={form.nationalId}
                onChange={(event) => setForm((current) => ({ ...current, nationalId: event.target.value }))}
                className="w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-content outline-none focus:border-accent"
                placeholder="12345678"
                required
              />
            </label>

            <label className="space-y-2 text-sm text-content-muted">
              Driving license number
              <input
                value={form.drivingLicense}
                onChange={(event) => setForm((current) => ({ ...current, drivingLicense: event.target.value }))}
                className="w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-content outline-none focus:border-accent"
                placeholder="DL-2026-2231"
                required
              />
            </label>

            <label className="space-y-2 text-sm text-content-muted md:col-span-2">
              Daily remittance target
              <input
                value={form.dailyTarget}
                onChange={(event) => setForm((current) => ({ ...current, dailyTarget: event.target.value }))}
                className="w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-content outline-none focus:border-accent"
                placeholder="18000"
                required
              />
            </label>
          </div>

          <div className="mt-6 grid gap-3 md:grid-cols-3">
            {[
              { key: 'nationalId', label: 'National ID photo' },
              { key: 'drivingLicense', label: 'Driving license' },
              { key: 'passport', label: 'Passport photo' },
            ].map((item) => (
              <label
                key={item.key}
                className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-canvas p-4 text-center transition hover:border-accent"
              >
                <input
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={(event) => {
                    const nextFile = event.target.files?.[0] ?? null;
                    handleFileChange(item.key as keyof DriverFileMap, nextFile);
                  }}
                />
                <span className="text-sm font-semibold text-content">{item.label}</span>
                <span className="mt-2 text-xs text-content-subtle">
                  {files[item.key as keyof DriverFileMap]?.name ?? 'Upload required document'}
                </span>
              </label>
            ))}
          </div>

          {/* Face photo: optional, and visually separated from the three
              required compliance uploads above so nobody assumes it is a fourth
              required document. */}
          <div className="mt-6 rounded-2xl border border-line bg-canvas p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <DriverAvatar
                photoUrl={facePhotoPreview}
                fullName={form.fullName}
                sizeClassName="h-16 w-16 text-lg"
                label={`${form.fullName || 'Driver'}'s face photo preview`}
              />

              <div className="flex-1">
                <p className="text-sm font-semibold text-content">
                  Face photo{' '}
                  <span className="font-normal text-content-subtle">(optional)</span>
                </p>
                <p className="mt-1 text-sm text-content-subtle">
                  Helps identify this driver in document review. The driver can add or replace it later
                  from their own portal.
                </p>
                <p className="mt-1 text-xs text-content-subtle">
                  JPG, PNG or WebP, up to 5 MB. Stored privately and shared only through short-lived links.
                </p>

                <label className="mt-3 inline-flex cursor-pointer items-center rounded-lg border border-line px-4 py-2 text-sm font-medium text-content-muted transition hover:bg-surface-2">
                  {facePhoto ? 'Choose a different photo' : 'Choose a photo'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(event) => handleFacePhotoChange(event.target.files?.[0] ?? null)}
                  />
                </label>

                {facePhotoError ? (
                  <p role="alert" className="mt-2 text-sm text-chart-danger">
                    {facePhotoError}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="rounded-xl border border-line bg-canvas px-3 py-2 text-sm text-content-muted">
              <span className="font-semibold text-content">Verification:</span>{' '}
              {verificationStatus === 'auto_verified' ? 'Auto-approved by document checks' : 'Manual review required'}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-xl bg-brand-solid px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? 'Provisioning...' : 'Create driver account'}
            </button>
          </div>

          {submissionMessage ? (
            <div className="mt-4 rounded-xl border border-chart-collected/30 bg-chart-collected/10 px-3 py-2 text-sm text-chart-collected">
              {submissionMessage}
            </div>
          ) : null}

          {temporaryPassword ? (
            <div className="mt-4 rounded-xl border border-line bg-canvas p-3 text-sm text-content">
              <p className="font-semibold text-content">Temporary password</p>
              <p className="mt-2 break-all">{temporaryPassword}</p>
            </div>
          ) : null}

          {inviteUrl ? (
            <div className="mt-3 rounded-xl border border-line bg-canvas p-3 text-sm text-content">
              <p className="font-semibold text-content">Invite URL</p>
              <a href={inviteUrl} className="mt-2 block break-all text-accent underline">
                {inviteUrl}
              </a>
            </div>
          ) : null}
        </div>

        <aside className="rounded-[1.5rem] border border-line bg-surface/80 p-5">
          <p className="text-sm font-medium text-content-subtle">Driver setup safeguards</p>
          <h2 className="mt-1 text-2xl font-bold text-content">Internal provisioning only</h2>
          <ul className="mt-4 space-y-3 text-sm text-content-muted">
            <li className="rounded-xl border border-line bg-canvas p-3">Managers only create accounts for approved drivers.</li>
            <li className="rounded-xl border border-line bg-canvas p-3">Driver self-registration is disabled.</li>
            <li className="rounded-xl border border-line bg-canvas p-3">
              Uploads are stored in the private driver-credentials bucket and shared via 1-hour signed links.
            </li>
            <li className="rounded-xl border border-line bg-canvas p-3">New users are assigned the driver role automatically.</li>
          </ul>
        </aside>
      </form>
    </div>
  );
}
