'use client';

import { useEffect, useRef, useState } from 'react';

import { fetchApiJson } from '@/lib/api-client';
import {
  ALLOWED_CONTENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  DRIVER_DOCUMENT_TYPES,
  MAX_FILE_BYTES,
  documentTypeLabel,
  type DriverDocumentType,
} from '@/lib/documents';

type DocumentStatus = 'pending' | 'approved' | 'rejected' | 'action_required';

type DriverDocument = {
  id: string;
  driver_id: string;
  document_type: string;
  status: DocumentStatus;
  storage_path: string | null;
  storage_bucket: string | null;
  uploaded_at: string;
};

const statusStyles: Record<DocumentStatus, string> = {
  pending: 'bg-chart-servicing/5 text-chart-servicing border-chart-servicing/30',
  approved: 'bg-chart-collected/10 text-chart-collected border-chart-collected/30',
  rejected: 'bg-chart-danger/10 text-chart-danger border-chart-danger/30',
  action_required: 'bg-chart-servicing/5 text-chart-servicing border-chart-servicing/30',
};

const statusLabels: Record<DocumentStatus, string> = {
  pending: 'Awaiting review',
  approved: 'Approved',
  rejected: 'Rejected',
  action_required: 'Resubmission needed',
};

/** Newest upload per type. The table has no unique constraint on (driver, type). */
function latestByType(documents: DriverDocument[]) {
  const latest = new Map<DriverDocumentType, DriverDocument>();

  for (const document of documents) {
    const type = document.document_type as DriverDocumentType;

    if (!DRIVER_DOCUMENT_TYPES.includes(type)) {
      continue;
    }

    const current = latest.get(type);

    if (!current || new Date(document.uploaded_at) > new Date(current.uploaded_at)) {
      latest.set(type, document);
    }
  }

  return latest;
}

export function DocumentManagementHub() {
  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [uploadingType, setUploadingType] = useState<DriverDocumentType | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const inputRefs = useRef<Partial<Record<DriverDocumentType, HTMLInputElement | null>>>({});

  const fetchDocuments = async () => {
    const result = await fetchApiJson<{ documents?: DriverDocument[] }>('/api/driver/documents');

    setIsLoading(false);

    // A failed load is reported rather than swallowed: an unreachable database
    // previously rendered as "No documents uploaded yet", which reads as a fact
    // about the driver's account rather than a fault.
    if (!result.ok) {
      setLoadError(result.message);
      return;
    }

    setLoadError('');
    setDocuments(Array.isArray(result.data.documents) ? result.data.documents : []);
  };

  useEffect(() => {
    void fetchDocuments();
  }, []);

  /**
   * Requests a fresh signed URL each time rather than holding one.
   *
   * Signed URLs expire after an hour, so a URL kept in component state would
   * keep failing after the window closed, and one shared into a chat or a
   * screenshot would still resolve for as long as it was valid.
   */
  const openDocument = async (document: DriverDocument) => {
    setNotice(null);
    setOpeningId(document.id);

    const result = await fetchApiJson<{ url?: string }>(
      `/api/driver/documents?intent=signed-url&documentId=${encodeURIComponent(document.id)}`
    );

    setOpeningId(null);

    if (!result.ok || !result.data.url) {
      setNotice({ tone: 'error', text: result.ok ? 'No secure link was returned.' : result.message });
      return;
    }

    window.open(result.data.url, '_blank', 'noopener,noreferrer');
  };

  const upload = async (type: DriverDocumentType, file: File) => {
    setNotice(null);

    // Mirrors the server check so the user gets an answer without a round trip.
    // `lib/documents.ts` is shared, so the two cannot drift; the server re-runs
    // it regardless, since a browser check proves nothing about the bytes.
    if (file.size > MAX_FILE_BYTES) {
      setNotice({
        tone: 'error',
        text: `${DOCUMENT_TYPE_LABELS[type]} is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is 5 MB.`,
      });
      return;
    }

    if (!ALLOWED_CONTENT_TYPES.includes(file.type)) {
      setNotice({ tone: 'error', text: `${DOCUMENT_TYPE_LABELS[type]} must be a PDF, PNG or JPG file.` });
      return;
    }

    setUploadingType(type);

    const body = new FormData();
    body.set('documentType', type);
    body.set('file', file);

    const result = await fetchApiJson<{ document?: DriverDocument }>('/api/driver/documents', {
      method: 'POST',
      body,
    });

    setUploadingType(null);

    if (!result.ok) {
      setNotice({ tone: 'error', text: result.message });
      return;
    }

    setNotice({
      tone: 'success',
      text: `${DOCUMENT_TYPE_LABELS[type]} uploaded and queued for review.`,
    });

    await fetchDocuments();
  };

  const latest = latestByType(documents);

  return (
    <div className="card">
      <div className="mb-5">
        <p className="text-sm font-medium text-content-subtle">Document management</p>
        <h2 className="mt-1 text-2xl font-bold text-content">Driver documents</h2>
        <p className="mt-2 text-sm text-content-subtle">
          Upload a PDF, PNG or JPG up to 5 MB. Files are stored privately and only ever opened through a
          short-lived secure link.
        </p>
      </div>

      {loadError ? (
        <div className="mb-4 rounded-lg border border-chart-danger/30 bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger">
          <p className="font-semibold">Could not load your documents</p>
          <p className="mt-1">{loadError}</p>
        </div>
      ) : null}

      {notice ? (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
            notice.tone === 'error'
              ? 'border-chart-danger/30 bg-chart-danger/10 text-chart-danger'
              : 'border-chart-collected/30 bg-chart-collected/10 text-chart-collected'
          }`}
          role="status"
        >
          {notice.text}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        {DRIVER_DOCUMENT_TYPES.map((type) => {
          const document = latest.get(type);
          const isUploading = uploadingType === type;
          const label = DOCUMENT_TYPE_LABELS[type];

          return (
            <div key={type} className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-sm">
              <div className="mb-3 flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-content">{label}</p>
                {document ? (
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusStyles[document.status]}`}
                  >
                    {statusLabels[document.status]}
                  </span>
                ) : null}
              </div>

              <p className="mb-3 text-xs text-content-subtle">
                {document
                  ? `Uploaded ${new Date(document.uploaded_at).toLocaleDateString('en-KE', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}`
                  : 'Not uploaded yet'}
              </p>

              {document?.status === 'action_required' ? (
                <p className="mb-3 rounded-lg border border-chart-servicing/30 bg-chart-servicing/5 px-2.5 py-2 text-xs leading-5 text-chart-servicing">
                  A reviewer asked for a clearer or corrected copy. Uploading a new file replaces this one for review.
                </p>
              ) : null}

              <div className="mt-auto flex flex-col gap-2">
                {document ? (
                  <button
                    type="button"
                    onClick={() => void openDocument(document)}
                    disabled={openingId === document.id}
                    className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-content-muted transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {openingId === document.id ? 'Opening…' : 'Open file'}
                  </button>
                ) : null}

                <input
                  ref={(node) => {
                    inputRefs.current[type] = node;
                  }}
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];

                    // Reset immediately so re-picking the same file still fires a
                    // change event; without this, choosing a rejected file twice
                    // silently does nothing the second time.
                    event.target.value = '';

                    if (file) {
                      void upload(type, file);
                    }
                  }}
                />

                <button
                  type="button"
                  onClick={() => inputRefs.current[type]?.click()}
                  disabled={isUploading}
                  className="rounded-md bg-brand-solid px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-solid-strong disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isUploading ? 'Uploading…' : document ? 'Upload replacement' : 'Upload'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {isLoading ? (
        <p className="mt-4 text-sm text-content-subtle">Loading your documents…</p>
      ) : null}

      {!isLoading && !loadError && documents.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-line bg-surface-2 p-4 text-sm text-content-subtle">
          You have not uploaded any documents yet. Uploading your National ID and Driving Licence starts your
          verification.
        </div>
      ) : null}

      {documents.length > 0 ? (
        <details className="mt-4 rounded-xl border border-line bg-surface-2 p-3">
          <summary className="cursor-pointer text-sm font-medium text-content-muted">
            Upload history ({documents.length})
          </summary>
          <ul className="mt-3 space-y-1.5">
            {documents.map((document) => (
              <li key={document.id} className="flex items-center justify-between gap-3 text-xs text-content-subtle">
                <span>
                  {documentTypeLabel(document.document_type)}
                  {' · '}
                  {new Date(document.uploaded_at).toLocaleDateString('en-KE')}
                </span>
                <span className={`rounded-full border px-2 py-0.5 font-bold uppercase ${statusStyles[document.status]}`}>
                  {statusLabels[document.status]}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}