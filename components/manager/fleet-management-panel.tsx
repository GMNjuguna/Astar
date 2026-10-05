'use client';

/**
 * Fleet management: the manager portal's vehicle register.
 *
 * ── What is real here and what is derived ──────────────────────────────────
 * Vehicle rows come from `cars`. Two things shown alongside them do not have a
 * column to read, and both are labelled in the UI as what they are:
 *
 *  - **Assigned driver** is derived from the most recent `daily_remittances` row
 *    for that car. `cars` has no `assigned_driver_id`, so "who drives this" is an
 *    inference from a payment record, not a fact the fleet table asserts.
 *  - **Maintenance** is matched on the registration *string*, because
 *    `vehicle_maintenance.vehicle_registration` is free text with no foreign key.
 *    Both sides are normalised before comparison so legacy rows written as
 *    `kda123a` still match the car's `KDA 123A`.
 *
 * Both derivations are stated in the card rather than presented as data, because
 * a manager deciding whether a car is free to dispatch needs to know the answer is
 * inferred.
 *
 * ── Why deletion is confirmed, and why it can be refused ────────────────────
 * `daily_remittances.car_id` cascades on delete, so removing a car with payment
 * history would erase it. The API refuses that case with a 409 naming the
 * blocker, and this panel surfaces the refusal instead of retrying or falling
 * back to "set inactive" on its own — the choice of retiring a vehicle rather
 * than erasing it belongs to the manager.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { fetchApiJson } from '@/lib/api-client';
import {
  MAX_DAILY_RATE,
  MAX_VEHICLE_YEAR,
  MIN_VEHICLE_YEAR,
  VEHICLE_STATUS_LABELS,
  VEHICLE_STATUS_PILL,
  VEHICLE_STATUS_TONES,
  type VehicleStatus,
} from '@/lib/vehicles';

type AssignedDriver = {
  id: string;
  fullName: string | null;
  phone: string | null;
  since: string;
  lastRemittanceStatus: string;
  lastRemittanceAmount: number;
};

type MaintenanceLog = {
  id: string;
  vehicle_registration: string;
  issue_summary: string;
  estimated_cost: number;
  priority: 'high' | 'medium' | 'low';
  status: 'open' | 'scheduled' | 'completed';
  created_at: string;
};

type Vehicle = {
  id: string;
  registrationNumber: string;
  model: string;
  year: number;
  status: VehicleStatus;
  dailyRate: number;
  createdAt: string;
  assignedDriver: AssignedDriver | null;
  maintenance: {
    logs: MaintenanceLog[];
    openCount: number;
    openEstimatedCost: number;
  };
};

type FleetSummary = {
  total: number;
  active: number;
  servicing: number;
  inactive: number;
  unassigned: number;
  openMaintenance: number;
};

type FieldErrors = Partial<Record<'registrationNumber' | 'model' | 'year' | 'dailyRate' | 'status', string>>;

type FormState = {
  registrationNumber: string;
  model: string;
  year: string;
  dailyRate: string;
  status: VehicleStatus;
};

const EMPTY_FORM: FormState = {
  registrationNumber: '',
  model: '',
  year: String(new Date().getFullYear()),
  dailyRate: '',
  status: 'active',
};

const STATUS_FILTERS: Array<{ value: 'all' | VehicleStatus; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'servicing', label: 'Servicing' },
  { value: 'inactive', label: 'Inactive' },
];

function formatKsh(value: number): string {
  return `Ksh ${value.toLocaleString('en-KE')}`;
}

function formatDate(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? 'unknown date'
    : date.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

const PRIORITY_TONES: Record<MaintenanceLog['priority'], string> = {
  high: 'text-chart-danger',
  medium: 'text-chart-servicing',
  low: 'text-content-subtle',
};

/**
 * The fleet editor.
 *
 * `onChanged` fires after any successful create, update or delete so a dashboard
 * can re-read `/api/analytics`. Without it the CEO's "Fleet in service" card and
 * the fleet-status chart read one snapshot while the table immediately below
 * showed the edited value — the two halves of the same page disagreeing about
 * the same row. Optional, so `/fleet` can mount this with nothing to notify.
 */
export function FleetManagementPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [summary, setSummary] = useState<FleetSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | VehicleStatus>('all');

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  /** Set after a successful save, to confirm what changed without a refetch. */
  const [notice, setNotice] = useState<string | null>(null);

  const [busyVehicleId, setBusyVehicleId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState<Vehicle | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  /**
   * The clicked Delete button, so focus returns to *that* card rather than to
   * whichever card happens to render last.
   */
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [maintenanceFor, setMaintenanceFor] = useState<Vehicle | null>(null);
  const [maintenanceIssue, setMaintenanceIssue] = useState('');
  const [maintenancePriority, setMaintenancePriority] = useState<MaintenanceLog['priority']>('medium');
  const [maintenanceCost, setMaintenanceCost] = useState('');
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [isLogging, setIsLogging] = useState(false);
  const maintenanceIssueRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);

    const result = await fetchApiJson<{ vehicles?: Vehicle[]; summary?: FleetSummary }>(
      '/api/fleet/vehicles'
    );

    if (!result.ok) {
      // `vehicles` stays null so the panel can tell "failed to load" from
      // "loaded and genuinely empty" -- the distinction is the whole point of
      // the empty state.
      setLoadError(result.message);
      setIsLoading(false);
      return;
    }

    setVehicles(result.data.vehicles ?? []);
    setSummary(result.data.summary ?? null);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const rows = vehicles ?? [];
    const needle = search.trim().toLowerCase();

    return rows.filter((vehicle) => {
      if (statusFilter !== 'all' && vehicle.status !== statusFilter) return false;

      if (!needle) return true;

      const haystack = [
        vehicle.registrationNumber,
        vehicle.model,
        String(vehicle.year),
        vehicle.assignedDriver?.fullName ?? '',
        // Inactive cars are the ones a manager most often hunts for by plate, so
        // the plate stays in the haystack rather than being filtered out earlier.
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(needle);
    });
  }, [vehicles, search, statusFilter]);

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setFormError(null);
  }

  function startEdit(vehicle: Vehicle) {
    setEditingId(vehicle.id);
    setForm({
      registrationNumber: vehicle.registrationNumber,
      model: vehicle.model,
      year: String(vehicle.year),
      dailyRate: String(vehicle.dailyRate),
      status: vehicle.status,
    });
    setFieldErrors({});
    setFormError(null);
  }

  async function saveVehicle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setFieldErrors({});
    setFormError(null);
    setNotice(null);

    const isEditing = editingId !== null;
    const endpoint = isEditing ? `/api/fleet/vehicles/${editingId}` : '/api/fleet/vehicles';

    try {
      const response = await fetch(endpoint, {
        method: isEditing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registration_number: form.registrationNumber,
          model: form.model,
          year: form.year,
          daily_rate: form.dailyRate,
          status: form.status,
        }),
      });

      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        errors?: FieldErrors;
      };

      if (!response.ok || !payload.ok) {
        // Field-level errors replace the form, so the manager is told which input
        // is wrong rather than just that "something" was.
        if (payload.errors) setFieldErrors(payload.errors);
        setFormError(payload.message ?? 'The vehicle could not be saved.');
        return;
      }

      setNotice(
        isEditing
          ? `${form.registrationNumber.trim().toUpperCase()} updated.`
          : `${form.registrationNumber.trim().toUpperCase()} added to the fleet.`
      );

      setEditingId(null);
      setForm(EMPTY_FORM);
      await load();
      onChanged?.();
    } catch {
      setFormError('The fleet could not be reached. Check your connection and try again.');
    } finally {
      setIsSaving(false);
    }
  }

  async function changeStatus(vehicle: Vehicle, status: VehicleStatus) {
    setBusyVehicleId(vehicle.id);
    setActionError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/fleet/vehicles/${vehicle.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      const payload = (await response.json()) as { ok?: boolean; message?: string };

      if (!response.ok || !payload.ok) {
        setActionError(payload.message ?? `${vehicle.registrationNumber} could not be updated.`);
        return;
      }

      setNotice(`${vehicle.registrationNumber} is now ${VEHICLE_STATUS_LABELS[status].toLowerCase()}.`);
      await load();
      onChanged?.();
    } catch {
      setActionError('The fleet could not be reached. Check your connection and try again.');
    } finally {
      setBusyVehicleId(null);
    }
  }

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const response = await fetch(`/api/fleet/vehicles/${pendingDelete.id}`, { method: 'DELETE' });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        warnings?: string[];
      };

      if (!response.ok || !payload.ok) {
        // The 409 "has remittances" case lands here. It is a refusal, not a
        // failure to try, so the dialog stays open with the explanation rather
        // than the vehicle disappearing from the list behind the manager's back.
        setDeleteError(payload.message ?? `${pendingDelete.registrationNumber} could not be deleted.`);
        setIsDeleting(false);
        return;
      }

      setNotice(`${pendingDelete.registrationNumber} was removed from the fleet.`);
      if (payload.warnings?.length) {
        setActionError(payload.warnings.join(' '));
      }

      setPendingDelete(null);
      await load();
      onChanged?.();
      setIsDeleting(false);
    } catch {
      setDeleteError('The fleet could not be reached. Check your connection and try again.');
      setIsDeleting(false);
    }
    // `onChanged` is a dep rather than assumed stable: a parent that passes an
    // inline arrow would otherwise have its notification fire against a stale
    // closure the first time it re-rendered.
  }, [pendingDelete, load, onChanged]);

  async function logMaintenance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!maintenanceFor) return;

    if (!maintenanceIssue.trim()) {
      setMaintenanceError('Describe the issue so the log is readable later.');
      return;
    }

    setIsLogging(true);
    setMaintenanceError(null);

    try {
      const response = await fetch(`/api/fleet/vehicles/${maintenanceFor.id}/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issue_summary: maintenanceIssue,
          priority: maintenancePriority,
          estimated_cost: maintenanceCost,
        }),
      });

      const payload = (await response.json()) as { ok?: boolean; message?: string };

      if (!response.ok || !payload.ok) {
        setMaintenanceError(payload.message ?? 'The maintenance log could not be saved.');
        return;
      }

      setNotice(`Maintenance logged against ${maintenanceFor.registrationNumber}.`);
      setMaintenanceFor(null);
      setMaintenanceIssue('');
      setMaintenanceCost('');
      setMaintenancePriority('medium');
      await load();
      onChanged?.();
    } catch {
      setMaintenanceError('The fleet could not be reached. Check your connection and try again.');
    } finally {
      setIsLogging(false);
    }
  }

  const inputClass =
    'w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-content outline-none focus:border-accent';

  return (
    <div className="space-y-6">
      {/* ── summary ── */}
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        {[
          { label: 'Vehicles', value: summary?.total ?? 0 },
          { label: 'Active', value: summary?.active ?? 0 },
          { label: 'Servicing', value: summary?.servicing ?? 0 },
          { label: 'Inactive', value: summary?.inactive ?? 0 },
          { label: 'No driver yet', value: summary?.unassigned ?? 0 },
          { label: 'Open jobs', value: summary?.openMaintenance ?? 0 },
        ].map((stat) => (
          <div key={stat.label} className="rounded-2xl border border-line bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-content-subtle">
              {stat.label}
            </p>
            <p className="mt-2 text-3xl font-bold text-content">{stat.value}</p>
          </div>
        ))}
      </div>

      {loadError ? (
        <div
          role="alert"
          className="rounded-2xl border border-chart-danger/30 bg-chart-danger/10 p-4 text-sm text-chart-danger"
        >
          <p className="font-semibold text-chart-danger">The fleet could not be loaded</p>
          <p className="mt-1 text-chart-danger">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-lg border border-chart-danger/40 px-3 py-1.5 text-sm font-medium text-chart-danger transition hover:bg-chart-danger/10"
          >
            Try again
          </button>
        </div>
      ) : null}

      {actionError ? (
        <p
          role="alert"
          className="rounded-2xl border border-chart-danger/30 bg-chart-danger/10 px-4 py-3 text-sm text-chart-danger"
        >
          {actionError}
        </p>
      ) : null}

      {notice ? (
        <p className="rounded-2xl border border-chart-collected/30 bg-chart-collected/10 px-4 py-3 text-sm text-chart-collected">
          {notice}
        </p>
      ) : null}

      {/* ── add / edit ── */}
      <section className="rounded-[1.5rem] border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold text-content">
            {editingId ? 'Edit vehicle' : 'Add a vehicle'}
          </h2>
          {editingId ? (
            <button
              type="button"
              onClick={startCreate}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-content-muted transition hover:bg-surface-2"
            >
              Cancel edit
            </button>
          ) : null}
        </div>

        <form onSubmit={saveVehicle} className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <label className="space-y-2 text-sm text-content-muted">
            Registration number
            <input
              value={form.registrationNumber}
              onChange={(event) =>
                setForm((current) => ({ ...current, registrationNumber: event.target.value }))
              }
              className={inputClass}
              placeholder="KDA 123A"
              aria-invalid={fieldErrors.registrationNumber ? true : undefined}
              aria-describedby={fieldErrors.registrationNumber ? 'fleet-registration-error' : undefined}
              required
            />
            {fieldErrors.registrationNumber ? (
              <span id="fleet-registration-error" className="block text-xs text-chart-danger">
                {fieldErrors.registrationNumber}
              </span>
            ) : null}
          </label>

          <label className="space-y-2 text-sm text-content-muted">
            Model
            <input
              value={form.model}
              onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
              className={inputClass}
              placeholder="Toyota Hiace"
              aria-invalid={fieldErrors.model ? true : undefined}
              aria-describedby={fieldErrors.model ? 'fleet-model-error' : undefined}
              required
            />
            {fieldErrors.model ? (
              <span id="fleet-model-error" className="block text-xs text-chart-danger">
                {fieldErrors.model}
              </span>
            ) : null}
          </label>

          <label className="space-y-2 text-sm text-content-muted">
            Year
            <input
              value={form.year}
              onChange={(event) => setForm((current) => ({ ...current, year: event.target.value }))}
              className={inputClass}
              placeholder="2019"
              inputMode="numeric"
              aria-invalid={fieldErrors.year ? true : undefined}
              aria-describedby={fieldErrors.year ? 'fleet-year-error' : undefined}
              required
            />
            {fieldErrors.year ? (
              <span id="fleet-year-error" className="block text-xs text-chart-danger">
                {fieldErrors.year}
              </span>
            ) : (
              <span className="block text-xs text-content-subtle">
                {MIN_VEHICLE_YEAR}–{MAX_VEHICLE_YEAR}
              </span>
            )}
          </label>

          <label className="space-y-2 text-sm text-content-muted">
            Daily rate (Ksh)
            <input
              value={form.dailyRate}
              onChange={(event) => setForm((current) => ({ ...current, dailyRate: event.target.value }))}
              className={inputClass}
              placeholder="4500"
              inputMode="decimal"
              aria-invalid={fieldErrors.dailyRate ? true : undefined}
              aria-describedby={fieldErrors.dailyRate ? 'fleet-rate-error' : undefined}
              required
            />
            {fieldErrors.dailyRate ? (
              <span id="fleet-rate-error" className="block text-xs text-chart-danger">
                {fieldErrors.dailyRate}
              </span>
            ) : null}
          </label>

          <label className="space-y-2 text-sm text-content-muted">
            Status
            <select
              value={form.status}
              onChange={(event) =>
                setForm((current) => ({ ...current, status: event.target.value as VehicleStatus }))
              }
              className={inputClass}
              aria-invalid={fieldErrors.status ? true : undefined}
            >
              {(['active', 'servicing', 'inactive'] as VehicleStatus[]).map((value) => (
                <option key={value} value={value}>
                  {VEHICLE_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
            {fieldErrors.status ? (
              <span className="block text-xs text-chart-danger">{fieldErrors.status}</span>
            ) : null}
          </label>

          <div className="md:col-span-2 xl:col-span-5">
            {formError ? (
              <p role="alert" className="mb-3 text-sm text-chart-danger">
                {formError}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={isSaving}
              className="rounded-xl bg-brand-solid px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-solid-strong disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? 'Saving...' : editingId ? 'Save changes' : 'Add to fleet'}
            </button>
          </div>
        </form>
      </section>

      {/* ── filters ── */}
      <section className="rounded-[1.5rem] border border-line bg-surface p-5">
        <div className="grid gap-4 md:grid-cols-[1fr_auto]">
          <label className="space-y-2 text-sm text-content-muted">
            Search
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={inputClass}
              placeholder="Registration, model, year or driver"
              type="search"
            />
          </label>

          <label className="space-y-2 text-sm text-content-muted">
            Status
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as 'all' | VehicleStatus)}
              className={inputClass}
            >
              {STATUS_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="mt-3 text-sm text-content-subtle">
          Showing {visible.length} of {vehicles?.length ?? 0} vehicles
        </p>
      </section>

      {/*
        ── log maintenance, inline rather than in a dialog ──
        A three-field form does not need a modal. `ConfirmDialog` is the wrong
        abstraction for it (its confirm button is `type="button"`, so Enter inside
        a text field would do nothing), and forcing this into a dialog would also
        have meant duplicating the focus trap just to avoid a second abstraction.
        Inline keeps it a real `<form>`, so Enter submits as expected.
      */}
      {maintenanceFor ? (
        <section className="rounded-[1.5rem] border border-accent/40 bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-bold text-content">
              Log maintenance for {maintenanceFor.registrationNumber}
            </h2>
            <button
              type="button"
              onClick={() => {
                setMaintenanceFor(null);
                setMaintenanceError(null);
              }}
              disabled={isLogging}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-content-muted transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
          </div>

          <form onSubmit={logMaintenance} className="mt-4 grid gap-4 md:grid-cols-3">
            <label className="space-y-2 text-sm text-content-muted md:col-span-3">
              Issue
              <input
                ref={maintenanceIssueRef}
                value={maintenanceIssue}
                onChange={(event) => setMaintenanceIssue(event.target.value)}
                className={inputClass}
                placeholder="Brake pads worn"
                maxLength={400}
                aria-invalid={maintenanceError ? true : undefined}
                aria-describedby={maintenanceError ? 'fleet-maintenance-error' : undefined}
                required
              />
            </label>

            <label className="space-y-2 text-sm text-content-muted">
              Priority
              <select
                value={maintenancePriority}
                onChange={(event) =>
                  setMaintenancePriority(event.target.value as MaintenanceLog['priority'])
                }
                className={inputClass}
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>

            <label className="space-y-2 text-sm text-content-muted">
              Estimated cost (Ksh)
              <input
                value={maintenanceCost}
                onChange={(event) => setMaintenanceCost(event.target.value)}
                className={inputClass}
                placeholder="12000"
                inputMode="decimal"
              />
            </label>

            <div className="flex items-end">
              <button
                type="submit"
                disabled={isLogging}
                className="w-full rounded-xl bg-brand-solid px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-solid-strong disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLogging ? 'Saving...' : 'Log job'}
              </button>
            </div>

            {maintenanceError ? (
              <p id="fleet-maintenance-error" role="alert" className="text-sm text-chart-danger md:col-span-3">
                {maintenanceError}
              </p>
            ) : null}
          </form>
        </section>
      ) : null}

      {/* ── the fleet ── */}
      {isLoading ? (
        <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm text-content-subtle">
          Loading the fleet...
        </p>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface p-8 text-center">
          <p className="text-lg font-semibold text-content">
            {vehicles && vehicles.length > 0 ? 'No vehicles match these filters' : 'No vehicles yet'}
          </p>
          <p className="mt-2 text-sm text-content-subtle">
            {vehicles && vehicles.length > 0
              ? 'Try a different registration, model or status.'
              : 'Add the first vehicle using the form above.'}
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((vehicle) => {
            const isBusy = busyVehicleId === vehicle.id;

            return (
              <li
                key={vehicle.id}
                className="flex flex-col rounded-2xl border border-line bg-surface p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xl font-bold text-content">{vehicle.registrationNumber}</p>
                    <p className="mt-1 text-sm text-content-muted">
                      {vehicle.model} · {vehicle.year}
                    </p>
                  </div>
                  <span className={`${VEHICLE_STATUS_PILL} ${VEHICLE_STATUS_TONES[vehicle.status]}`}>
                    {VEHICLE_STATUS_LABELS[vehicle.status]}
                  </span>
                </div>

                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-content-subtle">Daily rate</dt>
                    <dd className="font-semibold text-content">{formatKsh(vehicle.dailyRate)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-content-subtle">Open maintenance</dt>
                    <dd className="font-semibold text-content">
                      {vehicle.maintenance.openCount}
                      {vehicle.maintenance.openCount > 0
                        ? ` · ${formatKsh(vehicle.maintenance.openEstimatedCost)}`
                        : ''}
                    </dd>
                  </div>
                </dl>

                <div className="mt-4 rounded-xl border border-line bg-canvas p-3">
                  <p className="text-xs font-medium uppercase tracking-[0.12em] text-content-subtle">
                    Assigned driver
                  </p>
                  {vehicle.assignedDriver ? (
                    <>
                      <p className="mt-1 text-sm font-semibold text-content">
                        {vehicle.assignedDriver.fullName ?? 'Name not recorded'}
                      </p>
                      {vehicle.assignedDriver.phone ? (
                        <p className="text-sm text-content-muted">{vehicle.assignedDriver.phone}</p>
                      ) : null}
                      {/* Stated as derived, because no column asserts this pairing. */}
                      <p className="mt-1 text-xs text-content-subtle">
                        Derived from the remittance recorded {formatDate(vehicle.assignedDriver.since)}
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-sm text-content-subtle">
                      No remittance recorded for this vehicle yet.
                    </p>
                  )}
                </div>

                {vehicle.maintenance.logs.length > 0 ? (
                  <details className="mt-3 rounded-xl border border-line bg-canvas p-3">
                    <summary className="cursor-pointer text-sm font-medium text-content">
                      Maintenance log ({vehicle.maintenance.logs.length})
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {vehicle.maintenance.logs.map((log) => (
                        <li key={log.id} className="text-sm">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-content">{log.issue_summary}</span>
                            <span className={`text-xs font-semibold uppercase ${PRIORITY_TONES[log.priority]}`}>
                              {log.priority}
                            </span>
                          </div>
                          <p className="text-xs text-content-subtle">
                            {log.status} · {formatKsh(Number(log.estimated_cost ?? 0))} ·{' '}
                            {formatDate(log.created_at)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                  {vehicle.status !== 'servicing' ? (
                    <button
                      type="button"
                      onClick={() => void changeStatus(vehicle, 'servicing')}
                      disabled={isBusy}
                      className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-content-muted transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Send to servicing
                    </button>
                  ) : null}

                  {vehicle.status !== 'active' ? (
                    <button
                      type="button"
                      onClick={() => void changeStatus(vehicle, 'active')}
                      disabled={isBusy}
                      className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-content-muted transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Return to active
                    </button>
                  ) : null}

                  {vehicle.status !== 'inactive' ? (
                    <button
                      type="button"
                      onClick={() => void changeStatus(vehicle, 'inactive')}
                      disabled={isBusy}
                      className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-content-muted transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Retire
                    </button>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => startEdit(vehicle)}
                    disabled={isBusy}
                    className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-content-muted transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Edit details
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setMaintenanceFor(vehicle);
                      setMaintenanceError(null);
                      // Focus the first field, since the form appears above the
                      // card that was just clicked.
                      window.setTimeout(() => maintenanceIssueRef.current?.focus(), 0);
                    }}
                    disabled={isBusy}
                    className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-content-muted transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Log maintenance
                  </button>

                  <button
                    ref={deleteTriggerRef}
                    type="button"
                    onClick={(event) => {
                      setPendingDelete(vehicle);
                      setDeleteError(null);
                      deleteTriggerRef.current = event.currentTarget;
                    }}
                    disabled={isBusy}
                    className="rounded-lg border border-chart-danger/40 px-3 py-1.5 text-xs font-medium text-chart-danger transition hover:bg-chart-danger/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── delete confirmation ── */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        eyebrow="Fleet"
        title={`Delete ${pendingDelete?.registrationNumber ?? 'this vehicle'}?`}
        description={
          pendingDelete && pendingDelete.maintenance.openCount > 0 ? (
            <>
              This vehicle has {pendingDelete.maintenance.openCount} open maintenance{' '}
              {pendingDelete.maintenance.openCount === 1 ? 'job' : 'jobs'}. Deleting it also removes its
              maintenance log.
            </>
          ) : (
            <>This removes the vehicle from the fleet. This cannot be undone.</>
          )
        }
        confirmLabel="Delete vehicle"
        tone="danger"
        busy={isDeleting}
        error={deleteError}
        returnFocusRef={deleteTriggerRef}
      />
    </div>
  );
}