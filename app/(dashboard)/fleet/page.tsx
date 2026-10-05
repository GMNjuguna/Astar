import type { Metadata } from 'next';

import { FleetManagementPanel } from '@/components/manager/fleet-management-panel';

export const metadata: Metadata = {
  title: 'Vehicle fleet',
  description: 'Add, update and retire vehicles, and review maintenance history.',
};

/**
 * Fleet management.
 *
 * A server component that renders one client panel. The data fetch lives in the
 * panel rather than here because every action on this page (add, edit, status
 * change, maintenance, delete) is a mutation followed by a refetch, and splitting
 * that across a server page and a client island would mean the page re-rendering
 * underneath a pending edit.
 *
 * Lives at `/fleet` rather than under `/manager` because the middleware guards
 * portal prefixes by role, and this interface is intentionally reachable by
 * manager, CEO and developer alike.
 */
export default function FleetPage() {
  return (
    <div className="space-y-8 rounded-[2rem] border border-line bg-canvas p-6 text-content shadow-[0_30px_80px_rgba(18,20,24,0.45)] lg:p-8">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Fleet</p>
          <h1 className="mt-2 text-3xl font-bold text-content">Vehicle fleet</h1>
          <p className="mt-2 max-w-2xl text-sm text-content-muted">
            Add vehicles, keep daily rates current, and move them through servicing and retirement.
            The assigned driver is derived from the most recent remittance recorded against each car.
          </p>
        </div>
      </div>

      <FleetManagementPanel />
    </div>
  );
}