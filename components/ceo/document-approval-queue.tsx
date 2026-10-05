'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchApiJson } from '@/lib/api-client';
import { DriverAvatar } from '@/components/driver/driver-avatar';
import { createSupabaseClient } from '@/lib/supabase/client';
import {
  STORAGE_BUCKETS,
  bucketFromLegacyPublicUrl,
  createDocumentSignedUrl,
  pathFromLegacyPublicUrl,
} from '@/lib/storage';
import { useDriverFacePhotos } from '@/lib/use-driver-face-photos';

type DocumentApproval = {
  id: string;
  driver_id: string;
  document_type: string;
  /** Legacy permanent URL. Null on rows written after the private-bucket migration. */
  document_url: string | null;
  storage_path: string | null;
  storage_bucket: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'action_required';
  uploaded_at: string;
};

export function DocumentApprovalQueue() {
  const [documents, setDocuments] = useState<DocumentApproval[]>([]);
  const [selected, setSelected] = useState<DocumentApproval | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const fetchDocuments = async () => {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase.from('driver_documents')
      .select('*')
      .eq('status', 'pending')
      .order('uploaded_at', { ascending: false });

    setIsLoading(false);

    // Previously the error was discarded, so an unreachable database rendered an
    // empty queue that looked identical to "no documents awaiting review".
    if (error) {
      setLoadError(error.message);
      return;
    }

    setLoadError(null);
    setDocuments(data ?? []);
  };

  useEffect(() => {
    void fetchDocuments();
  }, []);

  /**
   * Face photos and names for the drivers whose documents are listed, signed in
   * one batch. Derived from `documents`, so it re-requests only when the set of
   * driver ids actually changes.
   */
  const reviewerDriverIds = useMemo(
    () => [...new Set(documents.map((document) => document.driver_id))],
    [documents]
  );
  const reviewerIdentity = useDriverFacePhotos(reviewerDriverIds);

  const closePreview = () => {
    setSelected(null);
    setPreviewUrl(null);
    setPreviewError(null);
  };

  /**
   * Mints a 1-hour signed URL for the review preview. The URL is held in state
   * only while the modal is open and is discarded on close, so an expired link
   * is never left in the DOM or shared in a screenshot.
   */
  const openPreview = async (document: DocumentApproval) => {
    setSelected(document);
    setPreviewUrl(null);
    setPreviewError(null);

    const supabase = createSupabaseClient();
    const bucket = document.storage_bucket ?? bucketFromLegacyPublicUrl(document.document_url);
    const path = document.storage_path ?? pathFromLegacyPublicUrl(document.document_url);

    if (!bucket || !path) {
      setPreviewError('This document has no retrievable file reference.');
      return;
    }

    const signedUrl = await createDocumentSignedUrl(supabase, bucket, path);

    if (!signedUrl) {
      setPreviewError('Unable to generate a secure preview link. Please try again.');
      return;
    }

    setPreviewUrl(signedUrl);
  };

  const changeDocumentStatus = async (documentId: string, status: 'approved' | 'rejected') => {
    setIsUpdating(documentId);

    // Goes through the API route rather than writing from the browser, so the
    // status change is validated (uuid + enum), can distinguish "no such
    // document" from "database unavailable", and reports either instead of
    // failing silently. The previous direct write did neither: on error it
    // discarded the error and left the row in place with no feedback at all.
    const result = await fetchApiJson<{ message?: string }>('/api/ceo/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId, status }),
    });

    setIsUpdating(null);

    if (!result.ok) {
      setStatusMessage({ tone: 'error', text: result.message });
      return;
    }

    setStatusMessage({
      tone: 'success',
      text: result.data.message ?? `Document ${status}.`,
    });
    setDocuments((current) => current.filter((item) => item.id !== documentId));
    closePreview();
  };

  return (
    <div className="card">
      <div className="mb-5">
        <p className="text-sm font-medium text-content-subtle">Compliance</p>
        <h2 className="mt-1 text-2xl font-bold text-content">Document approval queue</h2>
      </div>

      {loadError ? (
        <div className="mb-4 rounded-xl border border-chart-danger/40 bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger">
          <p className="font-semibold">Queue unavailable</p>
          <p className="mt-1">{loadError}</p>
        </div>
      ) : null}

      {statusMessage ? (
        <div
          className={`mb-4 rounded-xl border px-3 py-2 text-sm ${
            statusMessage.tone === 'error'
              ? 'border-chart-danger/40 bg-chart-danger/10 text-chart-danger'
              : 'border-chart-collected/40 bg-chart-collected/10 text-chart-collected'
          }`}
        >
          {statusMessage.text}
        </div>
      ) : null}

      <div className="space-y-3">
        {documents.length ? (
          documents.map((document) => (
            <div key={document.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 p-3">
              <div className="flex min-w-0 items-center gap-3">
                {/* A review queue that cannot show whose document it is
                    cannot be reviewed. `driverName` falls back to the id when the
                    identity request has not resolved, so the row is never blank. */}
                <DriverAvatar
                  photoUrl={reviewerIdentity.drivers[document.driver_id]?.photoUrl}
                  fullName={
                    reviewerIdentity.drivers[document.driver_id]?.fullName ??
                    `Driver ${document.driver_id.slice(0, 8)}`
                  }
                  sizeClassName="h-10 w-10"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-content">{document.document_type}</p>
                  <p className="mt-1 truncate text-xs text-content-subtle">
                    {reviewerIdentity.drivers[document.driver_id]?.fullName ??
                      `Driver ${document.driver_id.slice(0, 8)}`}
                    {' · '}
                    {new Date(document.uploaded_at).toLocaleString()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void openPreview(document)}
                  className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-content-muted transition hover:bg-surface-2"
                >
                  Review
                </button>
                <button
                  type="button"
                  disabled={isUpdating === document.id}
                  onClick={() => void changeDocumentStatus(document.id, 'approved')}
                  className="rounded-lg bg-chart-collected px-3 py-1.5 text-xs font-semibold text-surface transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={isUpdating === document.id}
                  onClick={() => void changeDocumentStatus(document.id, 'rejected')}
                  className="rounded-lg bg-chart-danger px-3 py-1.5 text-xs font-semibold text-surface transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Reject
                </button>
              </div>
            </div>
          ))
        ) : loadError ? (
          <div className="rounded-xl border border-dashed border-line bg-surface-2 p-6 text-sm text-content-subtle">
            The queue could not be loaded, so its contents are unknown.
          </div>
        ) : isLoading ? (
          <div className="rounded-xl border border-dashed border-line bg-surface-2 p-6 text-sm text-content-subtle">
            Loading pending documents&hellip;
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-line bg-surface-2 p-6 text-sm text-content-subtle">
            No pending document uploads.
          </div>
        )}
      </div>

      {selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/50 px-4">
          <div className="w-full max-w-3xl rounded-2xl bg-surface p-6 shadow-xl">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Review</p>
                <h3 className="mt-2 text-2xl font-bold text-content">{selected.document_type}</h3>
              </div>
              <button type="button" onClick={closePreview} className="text-sm text-content-subtle hover:text-content">
                Close
              </button>
            </div>

            <div className="overflow-hidden rounded-xl border border-line bg-surface-2">
              {previewError ? (
                <div className="p-6 text-sm text-content-subtle">{previewError}</div>
              ) : previewUrl ? (
                selected.document_type.toLowerCase().endsWith('pdf') ||
                previewUrl.toLowerCase().includes('.pdf') ? (
                  <iframe
                    src={previewUrl}
                    title="Document preview"
                    className="h-[420px] w-full"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <img
                    src={previewUrl}
                    alt={selected.document_type}
                    className="h-[420px] w-full object-contain"
                    referrerPolicy="no-referrer"
                  />
                )
              ) : (
                <div className="p-6 text-sm text-content-subtle">Generating a secure preview link...</div>
              )}
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => void changeDocumentStatus(selected.id, 'rejected')}
                className="rounded-lg bg-chart-danger px-4 py-2 text-sm font-semibold text-surface transition hover:brightness-110"
              >
                Reject
              </button>
              <button
                type="button"
                onClick={() => void changeDocumentStatus(selected.id, 'approved')}
                className="rounded-lg bg-chart-collected px-4 py-2 text-sm font-semibold text-surface transition hover:brightness-110"
              >
                Approve
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
