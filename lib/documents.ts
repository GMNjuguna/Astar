/**
 * Document upload rules, shared by the driver portal and the manager queue.
 *
 * Both surfaces accept files from users, so both must apply the same checks
 * against the same constants. The browser also enforces these for fast feedback,
 * but that is UX only — every value here is re-checked server-side, because a
 * browser check is a suggestion and the file arrives from whoever wants it.
 */

/**
 * The document types the product recognises.
 *
 * A closed list rather than free text: the value becomes a storage path segment,
 * so an unchecked string would let a caller write objects to arbitrary folder
 * names inside the bucket, and would scatter the metadata table with types no
 * reviewer UI knows how to render.
 */
export const DRIVER_DOCUMENT_TYPES = [
  'national_id',
  'driving_license',
  'good_conduct_certificate',
] as const;

export type DriverDocumentType = (typeof DRIVER_DOCUMENT_TYPES)[number];

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Mirrors `allowed_mime_types` on both buckets in baseline.sql section 7.
 *
 * A JPEG file is reported by some browsers as `image/jpg`, which is not a real
 * registered media type. Rejecting it would fail legitimate uploads, so it is
 * normalised to `image/jpeg` — the storage layer already rejects anything else,
 * so accepting it here does not widen the effective policy.
 */
export const ALLOWED_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];

export const DOCUMENT_TYPE_LABELS: Record<DriverDocumentType, string> = {
  national_id: 'National ID',
  driving_license: 'Driving Licence',
  good_conduct_certificate: 'Good Conduct Certificate',
};

/**
 * Human label for a stored `document_type`.
 *
 * `driver_documents.document_type` is free text, not the enum above, because
 * `create-driver` also records a passport scan while the driver portal only
 * offers the three types listed here. Anything outside the known set is
 * title-cased rather than dropped, so a row written by a different code path is
 * still visible to a reviewer instead of silently disappearing from the list.
 */
export function documentTypeLabel(documentType: string): string {
  const known = DOCUMENT_TYPE_LABELS[documentType as DriverDocumentType];

  if (known) {
    return known;
  }

  return documentType
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function isDriverDocumentType(value: unknown): value is DriverDocumentType {
  return typeof value === 'string' && (DRIVER_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function normalizeContentType(value: string): string {
  const trimmed = value.trim().toLowerCase();

  return trimmed === 'image/jpg' ? 'image/jpeg' : trimmed;
}

/**
 * Reduces an uploaded filename to something safe to place in a storage key.
 *
 * Path separators are stripped rather than merely escaped: a key containing
 * `../` would let a caller address an object outside their own prefix, and the
 * storage RLS policies only inspect the first path segment. The document type is
 * inserted by {@link buildDocumentPath} rather than taken from the filename, so
 * sanitising the name cannot change which folder an object lands in.
 */
export function sanitizeFilename(name: string): string {
  const withoutPath = name.split(/[\\/]/).pop() ?? 'upload';
  const cleaned = withoutPath
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80);

  return cleaned || 'upload';
}

export function fileExtension(name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);

  return match ? match[1].toLowerCase() : 'bin';
}

/**
 * Builds the private object key.
 *
 * Shape is `<driver_id>/<document_type>/<filename>`, which the storage policies
 * rely on: they test only `(storage.foldername(name))[1]` against `auth.uid()`.
 * Keeping the driver id first is what makes ownership checkable; the
 * document-type segment is for grouping and is not part of the security
 * boundary.
 */
export function buildDocumentPath(
  ownerId: string,
  documentType: string,
  originalName: string
): string {
  const safeType = isDriverDocumentType(documentType) ? documentType : 'other';
  const base = sanitizeFilename(originalName).replace(/\.[A-Za-z0-9]{1,8}$/, '');

  return `${ownerId}/${safeType}/${Date.now()}-${base}.${fileExtension(originalName)}`;
}

export type FileRejection = { ok: false; message: string };
export type FileAccepted = { ok: true };
export type FileCheck = FileRejection | FileAccepted;

/**
 * Server-side gate applied to every uploaded file.
 *
 * Size is checked before the bytes are buffered rather than after, so an
 * oversized upload is rejected on its declared length instead of being read into
 * memory first. Both buckets additionally enforce `file_size_limit` and
 * `allowed_mime_types`, which is the layer that cannot be bypassed.
 */
export function validateUploadedFile(file: File, label: string): FileCheck {
  if (file.size === 0) {
    return { ok: false, message: `${label} is empty.` };
  }

  if (file.size > MAX_FILE_BYTES) {
    const megabytes = (file.size / (1024 * 1024)).toFixed(1);

    return { ok: false, message: `${label} is ${megabytes} MB. The limit is 5 MB.` };
  }

  const contentType = normalizeContentType(file.type);

  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return { ok: false, message: `${label} must be a PDF, PNG or JPG file.` };
  }

  return { ok: true };
}