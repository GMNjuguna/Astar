'use client';

import { useState } from 'react';

import { AnalyticsPanel } from '@/components/analytics/analytics-panel';
import { CEOChatPanel } from '@/components/ceo/ceo-chat-panel';
import { DocumentApprovalQueue } from '@/components/ceo/document-approval-queue';
import { RemittanceLedgerTable } from '@/components/ceo/remittance-ledger-table';
import { CEOMetricCards } from '@/components/ceo/metric-cards';
import { FleetManagementPanel } from '@/components/manager/fleet-management-panel';
import type { TimeRange } from '@/lib/analytics';
import { useAnalytics } from '@/lib/use-analytics';

export default function CEOPage() {
  /**
   * One range, one response, four consumers.
   *
   * The cards, the charts, the ledger and the fleet panel all read the same
   * payload, so they cannot report different revenue for the same window. The
   * `reload` call after a fleet edit is what keeps the cards honest when a status
   * change moves a vehicle in or out of "Fleet in service" — previously the
   * number could not react to an edit made a few inches below it.
   */
  const [range, setRange] = useState<TimeRange>('30d');
  const { payload, isLoading, error, reload } = useAnalytics(range);

  return (
    <div className="space-y-8">
      <div>
        {/* Eyebrow and heading sit directly on the layout's `bg-canvas`
            shell, with no card behind them.
            brand-500 measures 5.64:1 against #121418. brand-600 was 4.31:1 and
            failed AA for small text.
            text-content measures 18.44:1; text-content was 1.03:1 and rendered
            the heading effectively invisible. */}
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">CEO Dashboard</p>
        <h1 className="mt-2 text-3xl font-bold text-content">Financial performance and fleet control</h1>
      </div>

      <CEOMetricCards payload={payload} range={range} isLoading={isLoading} error={error} />

      {/*
        Analytics sits above the tables because it is the live view: every figure
        in it is read from the database through this session's RLS scope. All four
        surfaces on this page now consume one payload from one request, so the
        range control below re-times the cards and the ledger at the same time.
      */}
      <AnalyticsPanel
        range={range}
        onRangeChange={setRange}
        payload={payload}
        isLoading={isLoading}
        error={error}
      />

      {payload ? (
        <RemittanceLedgerTable
          rows={payload.exports.remittances}
          range={range}
          isLoading={isLoading}
          truncated={payload.truncated.remittances}
        />
      ) : null}

      {/* The previous `FleetManagementTable` here was hardcoded sample data held
          in `useState`, with ids minted from `crypto.randomUUID()` and edits that
          only mutated local React state — it never touched the `cars` table. With
          a real fleet interface now reading and writing that table, keeping it
          would have put a plausible-looking but fictional fleet above the CEO's
          document approvals. */}
      <FleetManagementPanel onChanged={reload} />
      <DocumentApprovalQueue />
      <CEOChatPanel />
    </div>
  );
}