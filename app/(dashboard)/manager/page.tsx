'use client';

import { useEffect, useMemo, useState } from 'react';
import { createSupabaseClient } from '@/lib/supabase/client';
import { fetchApiJson } from '@/lib/api-client';
import { AnalyticsPanel } from '@/components/analytics/analytics-panel';
import { DriverAvatar } from '@/components/driver/driver-avatar';
import { useDriverFacePhotos } from '@/lib/use-driver-face-photos';
import { useAnalytics } from '@/lib/use-analytics';
import { TIME_RANGES, type TimeRange } from '@/lib/analytics';
import { formatKsh } from '@/lib/format';

/**
 * The database's real status vocabularies.
 *
 * These two unions previously read `'Paid' | 'Pending' | 'Defaulted'` and
 * `'Active' | 'Renovation' | 'Maintenance'` — none of which matched the schema.
 * `remittance_status` is `pending | paid | overdue` and `car_status` is `active |
 * servicing | inactive`. So "Defaulted" was a state no remittance could ever be
 * in, "Renovation" was a vehicle state that does not exist, and the `/api/manager/overview`
 * route this page read from title-cased the stored values — turning a stored
 * `overdue` into an `Overdue` that was not in the union at all, so its badge
 * class resolved to `undefined` and the cell rendered unstyled.
 *
 * Reusing the literal database values means the stored value and the rendered
 * label are the same string, which is what makes a mapping auditable: there is no
 * translation step left to get wrong.
 */
type RemittanceStatus = 'pending' | 'paid' | 'overdue';
type VehicleStatus = 'active' | 'servicing' | 'inactive';

const REMITTANCE_TONES: Record<RemittanceStatus, string> = {
  paid: 'bg-chart-collected/10 text-chart-collected border border-chart-collected/20',
  pending: 'bg-chart-servicing/5 text-chart-servicing border border-chart-servicing/20',
  overdue: 'bg-chart-danger/10 text-chart-danger border border-chart-danger/20',
};

const VEHICLE_TONES: Record<VehicleStatus, string> = {
  active: 'bg-chart-collected/10 text-chart-collected border border-chart-collected/20',
  servicing: 'bg-chart-servicing/5 text-chart-servicing border border-chart-servicing/20',
  inactive: 'bg-canvas text-content-subtle border border-line',
};

const REMITTANCE_LABELS: Record<RemittanceStatus, string> = {
  paid: 'Paid',
  pending: 'Pending',
  overdue: 'Overdue',
};

const VEHICLE_LABELS: Record<VehicleStatus, string> = {
  active: 'In service',
  servicing: 'In maintenance',
  inactive: 'Idle / out of service',
};

const VEHICLE_STATUSES: readonly VehicleStatus[] = ['active', 'servicing', 'inactive'];

/** Narrows an arbitrary stored string to the enum, for use as a lookup key. */
function isRemittanceStatus(value: string): value is RemittanceStatus {
  return value === 'pending' || value === 'paid' || value === 'overdue';
}

function isVehicleStatusValue(value: string): value is VehicleStatus {
  return value === 'active' || value === 'servicing' || value === 'inactive';
}

type QueueEntry = {
  id: string;
  fullName: string;
  phone: string;
  nationalId: string;
  drivingLicense: string;
  assignedCar: string | null;
  dailyRemittanceTarget: number;
  verificationStatus: 'auto_verified' | 'needs_manual_review';
  status: 'pending' | 'approved' | 'rejected' | 'provisioned';
  createdAt: string;
  reviewedAt: string | null;
  driverId: string | null;
  hasNationalIdScan: boolean;
  hasDrivingLicenceScan: boolean;
  rejectionReason: string | null;
};

/**
 * Row shapes for the two dashboard panels, aligned to the export rows the
 * analytics route already builds.
 *
 * The previous shapes were stringly-typed for display: `amount: 'Ksh 18,500'`,
 * `vehicle: 'Assigned vehicle'`, `target: 'Ksh 20,000'`. Formatting a number at
 * the point it is stored means the panel cannot total it, cannot sort it, and
 * cannot tell a real zero from a missing value — which is exactly why
 * `totalRemitted` had to strip every non-digit back out with
 * `String(row.amount).replace(/[^\d]/g, '')`. Amounts are numbers here and are
 * formatted at render time.
 *
 * `paymentReference` replaces `target`. There is no per-remittance revenue target
 * anywhere in the schema — `daily_remittances` has no target column, and
 * `/api/analytics` already reports `targetAvailable: false` with the reason. The
 * old column showed a constant Ksh 20,000 against every row, so "Target" was not
 * a target at all; it was a number that would make any driver look behind or
 * ahead of a budget nobody set.
 *
 * `paymentDate` replaces `insuranceExpiry`. The schema has no insurance table, no
 * insurance column on `cars`, and no expiry date of any kind — the old panel
 * rendered a hardcoded 'PST-STATUS' string from the API as though it were a
 * policy state, next to three hardcoded dates. `payment_date` is real, nullable,
 * and null means the remittance has not been paid, which is a fact worth showing.
 */
type RemittanceRow = {
  id: string;
  driverId: string;
  driverName: string | null;
  vehicleRegistration: string | null;
  amount: number;
  status: string;
  paymentReference: string | null;
  paymentDate: string | null;
  recordedAt: string;
};

type FleetRow = {
  id: string;
  registrationNumber: string;
  model: string;
  year: number;
  status: string;
  dailyRate: number;
  derivedDriverId: string | null;
  derivedDriverAt: string | null;
};

type ChatMessage = {
  id: string;
  sender: 'ceo' | 'manager';
  content: string;
  createdAt: string;
};

/**
 * No default sample rows.
 *
 * This page used to seed `remittances` and `fleet` with three invented records
 * each, so before the request resolved — and permanently, if the request failed —
 * a manager saw Faith Achieng remitting Ksh 18,500 against KCA 332Y and three
 * vehicles with insurance expiries on specific dates. None of it existed. The
 * arrays now start empty and are filled only from the database, so "loading",
 * "nothing on file" and "could not reach the server" are three visibly different
 * states instead of one plausible-looking fiction.
 */

export default function ManagerPage() {
  /**
   * The remittance summary, the vehicle tracker, the four KPI tiles and the
   * charts all read this one response.
   *
   * They used to be four separate reads of the same three tables — the charts
   * from `/api/analytics`, the panels from `/api/manager/overview` — which is how
   * the page came to show a chart of one period beside a table of another, with
   * no two figures agreeing. One range, one request, one set of numbers.
   */
  const [range, setRange] = useState<TimeRange>('30d');
  const {
    payload: analytics,
    isLoading: isLoadingAnalytics,
    error: analyticsError,
    reload: reloadAnalytics,
  } = useAnalytics(range);

  /**
   * The two panel arrays, memoised.
   *
   * `analytics?.exports.remittances ?? []` allocates a fresh `[]` on every render
   * while the payload is loading or after a failure, which would invalidate
   * every `useMemo` downstream and re-run the KPI arithmetic on unrelated state
   * changes. Memoising pins the reference: an empty list stays empty until real
   * rows arrive.
   */
  const remittances = useMemo(
    () => (analytics?.exports.remittances ?? []) as RemittanceRow[],
    [analytics]
  );
  const fleet = useMemo(() => (analytics?.exports.fleet ?? []) as FleetRow[], [analytics]);

  /**
   * Every money tile on this page states its window.
   *
   * "Daily remittance" sat above a 30-day aggregate, so the label and the number
   * described different periods and neither was checkable by reading. The range
   * control is now on the charts directly below these tiles, and it moves all of
   * them together.
   */
  const rangeLabel = TIME_RANGES.find((option) => option.value === range)?.label ?? 'selected window';

  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([]);
  const [queueError, setQueueError] = useState('');
  const [queueNotice, setQueueNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [decidingEntryId, setDecidingEntryId] = useState<string | null>(null);

  /**
   * Face photos for the queued drivers, signed in one batch.
   *
   * Keyed by `driverId` rather than the queue entry id, because the photo lives on
   * `profiles` and every entry created through `/api/manager/create-driver` has
   * one. Entries without a `driverId` simply render no avatar.
   */
  const queuePhotoIds = useMemo(
    () => [...new Set(queueEntries.map((entry) => entry.driverId).filter((id): id is string => Boolean(id)))],
    [queueEntries]
  );
  const queuePhotos = useDriverFacePhotos(queuePhotoIds);

  /**
   * Faces for the vehicle tracker, batched for the same reason as the queue's.
   *
   * Keyed by the `derivedDriverId` the analytics export supplies. A vehicle with
   * no remittance has no derived driver, so it contributes no id and no avatar —
   * which is the honest outcome, since there is no driver record to attribute it
   * to.
   */
  const fleetDriverIds = useMemo(
    () => [
      ...new Set(
        fleet
          .map((vehicle) => vehicle.derivedDriverId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      ),
    ],
    [fleet]
  );
  const fleetDriverPhotos = useDriverFacePhotos(fleetDriverIds);

  /**
   * The chat starts empty.
   *
   * `defaultMessages` held a two-line exchange in which the CEO asked the manager
   * to confirm overdue accounts "before noon" and the manager replied about two
   * flagged drivers — from no account, at no time, about nothing. It rendered as
   * correspondence between two named executives and would have been read as real.
   */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadManagerOverview() {
      /**
       * Only the chat still comes from this route.
       *
       * `/api/manager/overview` also returned `remittances` and `fleet`, but those
       * projections were not derived from the tables — they emitted the literals
       * 'Driver record', 'Assigned vehicle', 'Ksh 20,000', 'PST-STATUS' and
       * `new Date()` for every row. Nothing in this page reads them any more; the
       * two arrays that did are now built from `/api/analytics`, which joins
       * `profiles` and `cars` for real names and plates. The fabricated
       * projections have been removed from the route rather than left in place,
       * because dead code that invents data is worse than no code.
       */
      const result = await fetchApiJson<{
        messages?: unknown;
      }>('/api/manager/overview');

      if (cancelled) {
        return;
      }

      setIsLoading(false);

      if (!result.ok) {
        // A failed load must not be silent. Previously it returned early and left
        // the three invented remittance rows on screen, so an unapplied schema or
        // a database outage rendered as a normal-looking dashboard.
        setLoadError(result.message);
        return;
      }

      setLoadError('');

      const data = result.data;

      // Assign even when the array is empty: "nothing on file" and "cannot
      // reach the database" must not look the same.
      if (Array.isArray(data.messages)) {
        setMessages(
          (data.messages as Array<Record<string, unknown>>).map((message) => ({
            id: String(message.id),
            sender: message.sender === 'manager' ? 'manager' : 'ceo',
            content: String(message.content),
            createdAt: String(message.createdAt),
          }))
        );
      }
    }

    void loadManagerOverview();

    const supabase = createSupabaseClient();

    if (!supabase) {
      return;
    }

    const channel = supabase.channel('manager-ceo-chat');

    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload: any) => {
        const nextMessage: ChatMessage = {
          id: String(payload.new?.id ?? crypto.randomUUID()),
          sender: 'manager',
          content: String(payload.new?.content ?? ''),
          createdAt: new Date(payload.new?.created_at ?? Date.now()).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
        };

        setMessages((current) => {
          const exists = current.some((item) => item.id === nextMessage.id);
          return exists ? current : [...current, nextMessage];
        });
      }
    );

    channel.subscribe();
    return () => {
      channel.unsubscribe();
    };
  }, []);

  /**
   * The KPI figures, computed from the same rows the tables below render.
   *
   * `amount` is a number here, so the old digit-stripping regex is gone — it only
   * existed because the API pre-formatted the value as a string, which meant
   * "Ksh 1,850" and a genuine 1850 were the same thing to any arithmetic done on
   * it. `pendingCount` counts `pending` rows specifically; it previously compared
   * against the title-cased string 'Pending', which no stored row ever had, so the
   * tile read 0 on a database full of unpaid remittances.
   *
   * Overdue is surfaced alongside rather than folded into pending, because the two
   * need different actions and one number hides that.
   */
  const remittanceTotals = useMemo(() => {
    let billed = 0;
    let collected = 0;
    let pending = 0;
    let pendingCount = 0;
    let overdue = 0;
    let overdueCount = 0;

    for (const row of remittances) {
      billed += row.amount;

      if (row.status === 'paid') {
        collected += row.amount;
      } else if (row.status === 'overdue') {
        overdue += row.amount;
        overdueCount += 1;
      } else {
        pending += row.amount;
        pendingCount += 1;
      }
    }

    return { billed, collected, pending, pendingCount, overdue, overdueCount };
  }, [remittances]);

  const vehicleTotals = useMemo(() => {
    let active = 0;
    let servicing = 0;
    let inactive = 0;

    for (const vehicle of fleet) {
      if (vehicle.status === 'active') active += 1;
      else if (vehicle.status === 'servicing') servicing += 1;
      else inactive += 1;
    }

    return { active, servicing, inactive, total: fleet.length };
  }, [fleet]);

  async function handleSubmitMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = chatDraft.trim();
    if (!content) {
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/manager/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        throw new Error('Unable to send message');
      }

      const payload = await response.json();
      if (payload?.message) {
        setMessages((current) => [
          ...current,
          {
            id: payload.message.id ?? crypto.randomUUID(),
            sender: 'manager',
            content: payload.message.content ?? content,
            createdAt: payload.message.createdAt ?? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      }
      setChatDraft('');
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          sender: 'manager',
          content,
          createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsSubmitting(false);
    }
  }

  /**
   * Loads the onboarding verification queue.
   *
   * This replaced a hardcoded three-row sample list whose Approve/Reject buttons
   * only mutated local React state — nothing was ever written, so the panel
   * looked operational while the database was untouched.
   */
  const loadQueue = async () => {
    const result = await fetchApiJson<{ entries?: QueueEntry[] }>('/api/manager/drivers');

    if (!result.ok) {
      setQueueError(result.message);
      return;
    }

    setQueueError('');
    setQueueEntries(Array.isArray(result.data.entries) ? result.data.entries : []);
  };

  useEffect(() => {
    void loadQueue();
  }, []);

  /** Mints a fresh signed URL for one scan and opens it. */
  const previewScan = async (entryId: string, document: 'national_id' | 'driving_license') => {
    setQueueNotice(null);

    const result = await fetchApiJson<{ url?: string }>(
      `/api/manager/drivers/${encodeURIComponent(entryId)}/document?document=${document}`
    );

    if (!result.ok || !result.data.url) {
      setQueueNotice({
        tone: 'error',
        text: result.ok ? 'No secure link was returned for that scan.' : result.message,
      });
      return;
    }

    window.open(result.data.url, '_blank', 'noopener,noreferrer');
  };

  const reviewEntry = async (entryId: string, action: 'approve' | 'reject') => {
    let reason = '';

    if (action === 'reject') {
      // Rejection is not reversible from this panel and the driver is told the
      // reason verbatim, so it is typed rather than confirmed with a yes/no that
      // carries no explanation.
      const entered = window.prompt('Reason for rejection (the driver will see this):');

      // `null` is a dismissed prompt — cancel rather than reject with no reason.
      if (entered === null) {
        return;
      }

      if (!entered.trim()) {
        setQueueNotice({ tone: 'error', text: 'A rejection reason is required.' });
        return;
      }

      reason = entered.trim();
    }

    setQueueNotice(null);
    setDecidingEntryId(entryId);

    const result = await fetchApiJson<{
      awaitingDriverAccount?: boolean;
      profileActivated?: boolean;
    }>('/api/manager/drivers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId, action, reason: reason || undefined }),
    });

    setDecidingEntryId(null);

    if (!result.ok) {
      setQueueNotice({ tone: 'error', text: result.message });
      return;
    }

    setQueueNotice({
      tone: 'success',
      text:
        action === 'approve'
          ? result.data.awaitingDriverAccount
            ? 'Candidate approved. No driver account is linked to this entry yet, so no profile was activated.'
            : 'Candidate approved and the driver profile is now active.'
          : 'Candidate rejected and their documents were flagged for resubmission.',
    });

    await loadQueue();
  };

  /**
   * Status changes now reach the database.
   *
   * `updateFleetStatus` mapped over local React state and returned, so the three
   * status buttons under each vehicle recoloured the card and changed nothing
   * else — the value was gone on refresh, and no one else could see it. That is
   * the worst failure mode for a control like this: it looks like it worked.
   *
   * The write goes to `/api/fleet/vehicles/[id]`, which is RLS-guarded to manager,
   * CEO and developer, and the panel then re-reads the analytics payload so the
   * KPI tiles and the fleet-status chart move with it. The per-vehicle busy state
   * means a second click cannot race the first.
   */
  const [busyVehicleId, setBusyVehicleId] = useState<string | null>(null);
  const [fleetActionError, setFleetActionError] = useState<string | null>(null);

  async function updateFleetStatus(vehicle: FleetRow, nextStatus: VehicleStatus) {
    if (busyVehicleId !== null) {
      return;
    }

    setBusyVehicleId(vehicle.id);
    setFleetActionError(null);

    try {
      const result = await fetchApiJson<{ warnings?: string[] }>(`/api/fleet/vehicles/${vehicle.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });

      if (!result.ok) {
        setFleetActionError(result.message);
        return;
      }

      if (result.data.warnings?.length) {
        setFleetActionError(result.data.warnings.join(' '));
      }

      reloadAnalytics();
    } catch {
      setFleetActionError('The vehicle status could not be changed. Try again.');
    } finally {
      setBusyVehicleId(null);
    }
  }

  return (
    <div className="space-y-8 rounded-[2rem] border border-line bg-canvas p-6 text-content shadow-[0_30px_80px_rgba(18,20,24,0.45)] lg:p-8">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Manager Portal</p>
          <h1 className="mt-2 text-3xl font-bold text-content">Operational control center</h1>
        </div>
        <div className="flex flex-wrap gap-3">
          <a
            href="/fleet"
            className="inline-flex items-center justify-center rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-content-muted transition hover:bg-surface-2"
          >
            Vehicle fleet
          </a>
          <a
            href="/manager/drivers/new"
            className="inline-flex items-center justify-center rounded-xl bg-brand-solid px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-solid-strong"
          >
            New driver onboarding
          </a>
        </div>
      </div>

      {loadError ? (
        <div className="rounded-2xl border border-chart-danger/40 bg-chart-danger/10 px-4 py-3 text-sm text-chart-danger">
          <p className="font-semibold">Executive chat unavailable</p>
          <p className="mt-1">{loadError}</p>
          <p className="mt-1 text-xs text-chart-danger/80">
            No messages could be loaded. Nothing is shown below rather than showing something invented.
          </p>
        </div>
      ) : null}

      {analyticsError ? (
        <div role="alert" className="rounded-2xl border border-chart-danger/40 bg-chart-danger/10 px-4 py-3 text-sm text-chart-danger">
          <p className="font-semibold">Live figures unavailable</p>
          <p className="mt-1">{analyticsError}</p>
          <p className="mt-1 text-xs text-chart-danger/80">
            Every tile, table and chart below is read from the database through your session. Nothing here
            is a sample, so with no connection there is nothing to show.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[1.5rem] border border-line bg-surface/80 p-5">
          <p className="text-sm text-content-subtle">Collected — {rangeLabel}</p>
          <p className="mt-3 text-3xl font-bold text-content">{formatKsh(remittanceTotals.collected)}</p>
          <p className="mt-1 text-xs text-content-subtle">
            {formatKsh(remittanceTotals.billed)} billed across {remittances.length} remittances
          </p>
        </div>
        <div className="rounded-[1.5rem] border border-line bg-surface/80 p-5">
          <p className="text-sm text-content-subtle">Awaiting payment</p>
          <p className="mt-3 text-3xl font-bold text-chart-servicing">
            {remittanceTotals.pendingCount + remittanceTotals.overdueCount}
          </p>
          <p className="mt-1 text-xs text-content-subtle">
            {formatKsh(remittanceTotals.pending)} pending
            {remittanceTotals.overdueCount > 0 ? `, ${formatKsh(remittanceTotals.overdue)} overdue` : ''}
          </p>
        </div>
        <div className="rounded-[1.5rem] border border-line bg-surface/80 p-5">
          {/* "Assigned fleet" was the old label, and it claimed an assignment the
              schema does not record. `cars` has no driver column; nothing links a
              driver to a vehicle except a remittance, which reflects who last used
              it rather than who is assigned. The tile now counts real statuses. */}
          <p className="text-sm text-content-subtle">Fleet on file</p>
          <p className="mt-3 text-3xl font-bold text-chart-collected">{vehicleTotals.active}</p>
          <p className="mt-1 text-xs text-content-subtle">
            in service of {vehicleTotals.total}
            {vehicleTotals.servicing > 0 ? `, ${vehicleTotals.servicing} in maintenance` : ''}
            {vehicleTotals.inactive > 0 ? `, ${vehicleTotals.inactive} idle` : ''}
          </p>
        </div>
        <div className="rounded-[1.5rem] border border-line bg-surface/80 p-5">
          <p className="text-sm text-content-subtle">Awaiting review</p>
          <p className="mt-3 text-3xl font-bold text-chart-billed">
            {queueEntries.filter((item) => item.status === 'pending').length}
          </p>
          <p className="mt-1 text-xs text-content-subtle">candidates in the onboarding queue</p>
        </div>
      </div>

      {/*
        Full width, above the split grid. The charts and the two panels below them
        now read one `/api/analytics` payload, and the range control here re-times
        all of them plus the KPI tiles above. They cannot disagree, because there
        is only one set of numbers.
      */}
      <AnalyticsPanel
        range={range}
        onRangeChange={setRange}
        payload={analytics}
        isLoading={isLoadingAnalytics}
        error={analyticsError}
      />

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <section className="rounded-[1.5rem] border border-line bg-surface/80 p-5">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-sm text-content-subtle">Revenue matrix</p>
                <h2 className="mt-1 text-2xl font-bold text-content">Driver remittance summary</h2>
              </div>
              {/* Was a static "Updated today" pill, which asserted a freshness the
                  data had no way to claim. It now names the window the rows come
                  from, which is verifiable, and tracks the shared range control. */}
              <span className="rounded-full border border-line bg-canvas px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-accent">
                {rangeLabel}
              </span>
            </div>

            {analytics?.truncated.remittances ? (
              <div className="mb-4 rounded-xl border border-chart-servicing/40 bg-chart-servicing/5 px-3 py-2 text-sm text-chart-servicing">
                This window exceeds the {analytics.truncated.rowCap.toLocaleString()}-row analytics cap, so
                these are the most recent remittances only. Narrow the range above for the full list.
              </div>
            ) : null}

            <div className="overflow-hidden rounded-2xl border border-line">
              <table className="min-w-full divide-y divide-line text-left text-sm">
                <thead className="bg-canvas text-content-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">Driver</th>
                    <th className="px-4 py-3 font-medium">Vehicle</th>
                    <th className="px-4 py-3 font-medium">Recorded</th>
                    <th className="px-4 py-3 font-medium">Amount</th>
                    <th className="px-4 py-3 font-medium">Payment</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-surface">
                  {remittances.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-content-subtle">
                        {isLoadingAnalytics
                          ? 'Loading remittances…'
                          : `No remittances recorded in the last ${rangeLabel.toLowerCase()}.`}
                      </td>
                    </tr>
                  ) : (
                    remittances.map((row) => {
                      const status = isRemittanceStatus(row.status) ? row.status : null;

                      return (
                        <tr key={row.id} className="text-content">
                          <td className="px-4 py-3">
                            {row.driverName ?? <span className="text-content-subtle">Name unavailable</span>}
                          </td>
                          <td className="px-4 py-3">
                            {row.vehicleRegistration ?? (
                              <span className="text-content-subtle">Vehicle unavailable</span>
                            )}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-content-muted">
                            {new Date(row.recordedAt).toLocaleDateString('en-KE', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                              timeZone: 'UTC',
                            })}
                          </td>
                          <td className="px-4 py-3 tabular-nums">{formatKsh(row.amount)}</td>
                          <td className="px-4 py-3 text-content-muted">
                            {row.paymentDate ? (
                              <span>
                                Paid {new Date(row.paymentDate).toLocaleDateString('en-KE', {
                                  day: 'numeric',
                                  month: 'short',
                                  timeZone: 'UTC',
                                })}
                                {row.paymentReference ? ` · ${row.paymentReference}` : ''}
                              </span>
                            ) : row.paymentReference ? (
                              <span>{row.paymentReference}</span>
                            ) : (
                              <span className="text-content-subtle">Unpaid</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {/* `status` is null for a value outside the enum. Rather
                                than falling through to a wrong tone, the raw value is
                                shown unstyled — an unknown status is a fact about the
                                data, not something to colour as if it were overdue. */}
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                                status ? REMITTANCE_TONES[status] : 'border border-line bg-canvas text-content-muted'
                              }`}
                            >
                              {status ? REMITTANCE_LABELS[status] : row.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-[1.5rem] border border-line bg-surface/80 p-5">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-content-subtle">Onboarding verification queue</p>
                <h2 className="mt-1 text-2xl font-bold text-content">Driver candidates</h2>
              </div>
              <span className="shrink-0 rounded-full border border-line bg-canvas px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-chart-billed">
                {queueEntries.filter((item) => item.status === 'pending').length} pending
              </span>
            </div>

            {queueError ? (
              <div className="mb-4 rounded-xl border border-chart-danger/40 bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger">
                {queueError}
              </div>
            ) : null}

            {queueNotice ? (
              <div
                role="status"
                className={`mb-4 rounded-xl border px-3 py-2 text-sm ${
                  queueNotice.tone === 'error'
                    ? 'border-chart-danger/40 bg-chart-danger/10 text-chart-danger'
                    : 'border-chart-collected/40 bg-chart-collected/10 text-chart-collected'
                }`}
              >
                {queueNotice.text}
              </div>
            ) : null}

            <div className="space-y-3">
              {queueEntries.map((entry) => {
                const isPending = entry.status === 'pending';
                const isDeciding = decidingEntryId === entry.id;

                return (
                  <div
                    key={entry.id}
                    className="flex flex-col gap-3 rounded-2xl border border-line bg-canvas p-4 md:flex-row md:items-start md:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-3">
                        {/* Shown only when the entry has a driver account, because
                            that is what the photo is keyed by. */}
                        {entry.driverId ? (
                          <DriverAvatar
                            photoUrl={queuePhotos.drivers[entry.driverId]?.photoUrl}
                            fullName={entry.fullName}
                            sizeClassName="h-11 w-11"
                          />
                        ) : null}
                        <p className="text-base font-semibold text-content">{entry.fullName}</p>
                        <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-content-muted">
                          {entry.status}
                        </span>
                      </div>

                      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-content-subtle sm:grid-cols-2">
                        <div>
                          <dt className="inline text-content-subtle">National ID: </dt>
                          <dd className="inline">{entry.nationalId}</dd>
                        </div>
                        <div>
                          <dt className="inline text-content-subtle">Licence: </dt>
                          <dd className="inline">{entry.drivingLicense}</dd>
                        </div>
                        <div>
                          <dt className="inline text-content-subtle">Phone: </dt>
                          <dd className="inline">{entry.phone}</dd>
                        </div>
                        <div>
                          <dt className="inline text-content-subtle">Target: </dt>
                          <dd className="inline">Ksh {entry.dailyRemittanceTarget.toLocaleString('en-KE')}</dd>
                        </div>
                      </dl>

                      {entry.rejectionReason ? (
                        <p className="mt-2 rounded-lg border border-chart-danger/30 bg-chart-danger/10 px-2.5 py-1.5 text-xs text-chart-danger">
                          Rejected: {entry.rejectionReason}
                        </p>
                      ) : null}

                      {!isPending && entry.reviewedAt ? (
                        <p className="mt-2 text-xs text-content-subtle">
                          Reviewed {new Date(entry.reviewedAt).toLocaleDateString('en-KE')}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void previewScan(entry.id, 'national_id')}
                        disabled={!entry.hasNationalIdScan}
                        className="rounded-lg border border-line bg-surface px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-content transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        ID scan
                      </button>
                      <button
                        type="button"
                        onClick={() => void previewScan(entry.id, 'driving_license')}
                        disabled={!entry.hasDrivingLicenceScan}
                        className="rounded-lg border border-line bg-surface px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-content transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Licence scan
                      </button>

                      {isPending ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void reviewEntry(entry.id, 'approve')}
                            disabled={isDeciding}
                            className="rounded-lg bg-chart-collected/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-chart-collected transition hover:bg-chart-collected/20 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void reviewEntry(entry.id, 'reject')}
                            disabled={isDeciding}
                            className="rounded-lg bg-chart-danger/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-chart-danger transition hover:bg-chart-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}

              {queueEntries.length === 0 && !queueError ? (
                <div className="rounded-2xl border border-dashed border-line bg-canvas p-6 text-sm text-content-subtle">
                  No candidates are waiting for review.
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-[1.5rem] border border-line bg-surface/80 p-5">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                {/* Was "Fleet maintenance", which described neither the data nor the
                    control: the panel lists vehicles and their statuses, and
                    maintenance records live in the analytics charts above. */}
                <p className="text-sm text-content-subtle">Fleet register</p>
                <h2 className="mt-1 text-2xl font-bold text-content">Vehicle tracker</h2>
              </div>
              <span className="shrink-0 rounded-full border border-line bg-canvas px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-accent">
                {fleet.length} on file
              </span>
            </div>

            {fleetActionError ? (
              <div role="alert" className="mb-4 rounded-xl border border-chart-danger/40 bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger">
                {fleetActionError}
              </div>
            ) : null}

            <div className="space-y-3">
              {fleet.length === 0 ? (
                <p className="py-6 text-sm text-content-subtle">
                  {isLoadingAnalytics ? 'Loading vehicles…' : 'No vehicles on file yet.'}
                </p>
              ) : (
                fleet.map((vehicle) => {
                  const status = isVehicleStatusValue(vehicle.status) ? vehicle.status : null;
                  const isBusy = busyVehicleId === vehicle.id;

                  return (
                    <div key={vehicle.id} className="rounded-2xl border border-line bg-canvas p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-base font-semibold text-content">
                            {vehicle.registrationNumber}
                          </p>
                          <p className="text-sm text-content-subtle">
                            {vehicle.model} · {vehicle.year} · {formatKsh(vehicle.dailyRate)}/day
                          </p>
                          {/*
                            The old line read "Insurance expires: {insuranceExpiry}",
                            where the value was a hardcoded 'PST-STATUS' string from the
                            API sitting beside three hardcoded dates. The schema has no
                            insurance table and no expiry column of any kind.

                            `derivedDriverId` comes from the newest remittance filed
                            against the vehicle *within the selected range*, which is who
                            most recently used it — not who is assigned. `cars` has no
                            driver column and nothing in the schema records an
                            assignment, so the line is labelled for what it is and names
                            the window, because narrowing the range genuinely can change
                            which driver it names.
                          */}
                          <p className="mt-1 text-xs text-content-subtle">
                            {vehicle.derivedDriverId ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span>Most recent driver in {rangeLabel}:</span>
                                <DriverAvatar
                                  photoUrl={fleetDriverPhotos.drivers[vehicle.derivedDriverId]?.photoUrl}
                                  fullName={fleetDriverPhotos.drivers[vehicle.derivedDriverId]?.fullName}
                                  sizeClassName="h-5 w-5"
                                  label="Most recent driver's photo"
                                />
                                <span className="font-medium text-content-muted">
                                  {fleetDriverPhotos.drivers[vehicle.derivedDriverId]?.fullName ?? 'Name unavailable'}
                                </span>
                              </span>
                            ) : (
                              `No remittance filed against this vehicle in ${rangeLabel.toLowerCase()}`
                            )}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                            status ? VEHICLE_TONES[status] : 'border border-line bg-surface text-content-muted'
                          }`}
                        >
                          {status ? VEHICLE_LABELS[status] : vehicle.status}
                        </span>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {VEHICLE_STATUSES.map((option) => (
                          <button
                            key={option}
                            type="button"
                            // Writes to the database; see `updateFleetStatus`.
                            disabled={isBusy || status === option}
                            onClick={() => void updateFleetStatus(vehicle, option)}
                            aria-pressed={status === option}
                            className={`rounded-lg px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] disabled:cursor-not-allowed ${
                              status === option
                                ? 'bg-brand-solid text-white'
                                : 'border border-line bg-surface text-content-muted hover:bg-surface-2'
                            }`}
                          >
                            {VEHICLE_LABELS[option]}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <a
              href="/fleet"
              className="mt-4 inline-flex items-center justify-center rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-content-muted transition hover:bg-surface-2"
            >
              Manage the full fleet
            </a>
          </section>

          <section className="rounded-[1.5rem] border border-line bg-surface/80 p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-content-subtle">Direct CEO chat</p>
                <h2 className="mt-1 text-2xl font-bold text-content">Executive communication</h2>
              </div>
              <span className="flex h-2.5 w-2.5 rounded-full bg-chart-collected shadow-[0_0_18px_rgba(74,222,128,0.9)]" />
            </div>

            <div className="space-y-3 rounded-2xl border border-line bg-canvas p-3">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                    message.sender === 'manager'
                      ? 'ml-auto bg-[#FF8F3D] text-slate-950'
                      : 'mr-auto bg-surface text-content'
                  }`}
                >
                  <p>{message.content}</p>
                  <p className={`mt-1 text-[10px] ${message.sender === 'manager' ? 'text-content-muted' : 'text-content-subtle'}`}>
                    {message.createdAt}
                  </p>
                </div>
              ))}
            </div>

            <form onSubmit={handleSubmitMessage} className="mt-4 space-y-3">
              <textarea
                value={chatDraft}
                onChange={(event) => setChatDraft(event.target.value)}
                rows={3}
                placeholder="Share a status update with the CEO..."
                className="w-full rounded-2xl border border-line bg-canvas px-3 py-2.5 text-sm text-content outline-none focus:border-accent"
              />
              <button
                type="submit"
                disabled={isSubmitting || !chatDraft.trim()}
                className="inline-flex rounded-xl bg-brand-solid px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? 'Sending...' : 'Send to CEO'}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
