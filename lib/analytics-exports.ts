/**
 * Column definitions for the three dashboard CSV exports.
 *
 * Column *order and wording* are part of these definitions rather than being
 * written inline at each call site, so the header row and the data cells cannot
 * drift apart — a header saying "Amount" above a column holding a raw string is
 * the kind of mismatch that ships unnoticed.
 *
 * ── Columns deliberately absent ─────────────────────────────────────────────
 * `Mileage` is not exported: `cars` has no mileage column and nothing in the
 * schema records distance travelled. Emitting a blank column would invite a
 * reader to assume the value is zero rather than unrecorded.
 *
 * The fleet export's driver column is `Derived Driver ID`, not `Assigned Driver`:
 * `cars` has no `driver_id` and no assignment record exists anywhere. The value
 * is whoever most recently filed a remittance against that vehicle — see
 * `buildDerivedDriverByCar`.
 */
import { toCsv, type CsvColumn } from '@/lib/csv';

export type RemittanceExportRow = {
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

export type FleetExportRow = {
  id: string;
  registrationNumber: string;
  model: string;
  year: number;
  status: string;
  dailyRate: number;
  derivedDriverId: string | null;
  derivedDriverAt: string | null;
};

export type MaintenanceExportRow = {
  id: string;
  vehicleRegistration: string;
  issueSummary: string;
  estimatedCost: number;
  priority: string;
  status: string;
  recordedAt: string;
};

/** Timestamps are exported as ISO-8601 rather than localised strings. */
function isoOrBlank(value: string | null): string {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

/** Amounts keep two decimals so a spreadsheet can sum them without rounding. */
function amount(value: number): string {
  return value.toFixed(2);
}

const REMITTANCE_COLUMNS: ReadonlyArray<CsvColumn<RemittanceExportRow>> = [
  { header: 'Remittance ID', value: (row) => row.id },
  { header: 'Recorded At (UTC)', value: (row) => isoOrBlank(row.recordedAt) },
  { header: 'Driver ID', value: (row) => row.driverId },
  { header: 'Driver Name', value: (row) => row.driverName },
  { header: 'Vehicle Registration', value: (row) => row.vehicleRegistration },
  { header: 'Amount (KES)', value: (row) => amount(row.amount) },
  { header: 'Status', value: (row) => row.status },
  { header: 'Payment Reference', value: (row) => row.paymentReference },
  { header: 'Payment Date (UTC)', value: (row) => isoOrBlank(row.paymentDate) },
];

const FLEET_COLUMNS: ReadonlyArray<CsvColumn<FleetExportRow>> = [
  { header: 'Vehicle ID', value: (row) => row.id },
  { header: 'Registration', value: (row) => row.registrationNumber },
  { header: 'Model', value: (row) => row.model },
  { header: 'Year', value: (row) => row.year },
  { header: 'Status', value: (row) => row.status },
  { header: 'Daily Rate (KES)', value: (row) => amount(row.dailyRate) },
  {
    header: 'Derived Driver ID (most recent remittance, not an assignment)',
    value: (row) => row.derivedDriverId,
  },
  { header: 'Derived From Remittance At (UTC)', value: (row) => isoOrBlank(row.derivedDriverAt) },
];

const MAINTENANCE_COLUMNS: ReadonlyArray<CsvColumn<MaintenanceExportRow>> = [
  { header: 'Maintenance ID', value: (row) => row.id },
  { header: 'Recorded At (UTC)', value: (row) => isoOrBlank(row.recordedAt) },
  { header: 'Vehicle Registration', value: (row) => row.vehicleRegistration },
  { header: 'Issue Summary', value: (row) => row.issueSummary },
  { header: 'Estimated Cost (KES)', value: (row) => amount(row.estimatedCost) },
  { header: 'Priority', value: (row) => row.priority },
  { header: 'Status', value: (row) => row.status },
];

export const buildRemittanceCsv = (rows: RemittanceExportRow[]) => toCsv(REMITTANCE_COLUMNS, rows);
export const buildFleetCsv = (rows: FleetExportRow[]) => toCsv(FLEET_COLUMNS, rows);
export const buildMaintenanceCsv = (rows: MaintenanceExportRow[]) => toCsv(MAINTENANCE_COLUMNS, rows);