/**
 * Onboarding verification queue: row shape and the row → API mapping.
 *
 * This lives in `lib/` rather than in the route because Next.js rejects any
 * export from a `route.ts` that is not an HTTP method or a route config option,
 * so a mapper defined there cannot be imported or asserted against. Keeping it
 * here also means a second surface (the CEO portal, a future export) reads the
 * queue through the same translation instead of re-deriving it.
 *
 * The mapping is the component that decides what a reviewer actually sees. Its
 * previous version collapsed `rejected` into `pending`, which meant a manager
 * could never see a rejection they had just made — the row was stored
 * correctly and displayed as if nothing had happened.
 */

export type QueueStatus = 'pending' | 'approved' | 'rejected' | 'provisioned';

export type QueueRow = {
  id: string;
  manager_id: string | null;
  full_name: string;
  phone: string;
  national_id: string;
  driving_license_number: string;
  assigned_car: string | null;
  daily_remittance_target: number;
  verification_status: 'auto_verified' | 'needs_manual_review';
  setup_email: string | null;
  setup_link: string | null;
  status: QueueStatus;
  created_at: string;
  reviewed_at: string | null;
  driver_id: string | null;
  national_id_storage_path: string | null;
  driving_license_storage_path: string | null;
  rejection_reason: string | null;
};

export type QueueEntry = {
  id: string;
  managerId: string | null;
  fullName: string;
  phone: string;
  nationalId: string;
  drivingLicense: string;
  assignedCar: string | null;
  dailyRemittanceTarget: number;
  verificationStatus: 'auto_verified' | 'needs_manual_review';
  setupEmail: string | null;
  setupLink: string | null;
  status: QueueStatus;
  createdAt: string;
  reviewedAt: string | null;
  driverId: string | null;
  /**
   * Whether a scan exists to preview. Derived from the stored object key rather
   * than carried as its own column: a key is the only thing a signed URL can be
   * minted from, so "has a scan" and "can be previewed" cannot drift apart.
   */
  hasNationalIdScan: boolean;
  hasDrivingLicenceScan: boolean;
  rejectionReason: string | null;
};

export const QUEUE_STATUSES: readonly QueueStatus[] = [
  'pending',
  'approved',
  'rejected',
  'provisioned',
];

export function mapQueueRow(row: QueueRow): QueueEntry {
  return {
    id: row.id,
    managerId: row.manager_id,
    fullName: row.full_name,
    phone: row.phone,
    nationalId: row.national_id,
    drivingLicense: row.driving_license_number,
    assignedCar: row.assigned_car,
    // PostgREST returns `numeric` as a string over JSON, so this is a real
    // coercion rather than a defensive one — `20000.00` arrives as `"20000.00"`.
    dailyRemittanceTarget: Number(row.daily_remittance_target ?? 0),
    verificationStatus: row.verification_status,
    setupEmail: row.setup_email,
    setupLink: row.setup_link,
    // Membership is checked rather than collapsed. An unrecognised value is a
    // data fault worth surfacing as `pending` in the UI, but it must never be
    // passed through: an unknown status reaching the client would render as
    // undefined in the badge and make the entry look un-reviewed.
    status: QUEUE_STATUSES.includes(row.status) ? row.status : 'pending',
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    driverId: row.driver_id,
    hasNationalIdScan: Boolean(row.national_id_storage_path),
    hasDrivingLicenceScan: Boolean(row.driving_license_storage_path),
    rejectionReason: row.rejection_reason,
  };
}