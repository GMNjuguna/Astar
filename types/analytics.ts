import type { RevenuePoint } from '@/components/analytics/charts';
import type {
  FleetExportRow,
  MaintenanceExportRow,
  RemittanceExportRow,
} from '@/lib/analytics-exports';
import type { TimeRange } from '@/lib/analytics';

/**
 * Response shape of `GET /api/analytics`.
 *
 * Declared once, here, rather than inside `components/analytics/analytics-panel.tsx`,
 * because four consumers now read it: the panel, the CEO metric cards, the CEO
 * remittance ledger and the manager dashboard panels. While the figures were
 * hardcoded per component, each one declared whatever shape it liked — which is
 * how a card could read `revenue.collection` while the chart beside it read
 * `revenue.buckets` and neither was checked against the route. One type, one
 * route, and a missing or renamed field is now a compile error in every consumer
 * at once rather than a silent divergence in one.
 *
 * ── Why the one type-only import is safe ────────────────────────────────────
 * `RevenuePoint` is the chart's view model and the only symbol not already owned
 * by `lib/`. It is imported with `import type`, which the compiler erases, so
 * this module contributes nothing to any runtime bundle and cannot create a
 * cycle through `components/`. Everything else comes from `lib/`, which is pure
 * by contract, and from `types/`, which is types only.
 */
export type AnalyticsPayload = {
  range: TimeRange;
  window: { start: string; end: string; bucket: 'day' | 'week' | 'month' };
  truncated: { remittances: boolean; maintenance: boolean; cars: boolean; rowCap: number };
  revenue: {
    buckets: RevenuePoint[];
    collection: {
      billed: number;
      collected: number;
      pending: number;
      overdue: number;
      collectionRate: number | null;
      paidEntries: number;
      overdueEntries: number;
      entries: number;
    };
    drivers: {
      activeDrivers: number;
      averagePerDriver: number | null;
      averagePerEntry: number | null;
    };
    targetAvailable: boolean;
    targetUnavailableReason: string;
  };
  fleet: {
    slices: Array<{ status: string; label: string; count: number; share: number }>;
    total: number;
    totalDailyRate: number;
  };
  maintenance: {
    records: number;
    totalEstimated: number;
    openRecords: number;
    highestSingleEstimate: number;
    byVehicle: Array<{ key: string; count: number; totalEstimated: number }>;
    byPriority: Array<{ key: string; count: number; totalEstimated: number }>;
    recurring: Array<{
      vehicleRegistration: string;
      occurrences: number;
      totalEstimated: number;
      share: number;
    }>;
  };
  exports: {
    remittances: RemittanceExportRow[];
    fleet: FleetExportRow[];
    maintenance: MaintenanceExportRow[];
  };
};