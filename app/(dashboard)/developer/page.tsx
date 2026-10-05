'use client';

/**
 * Developer System Portal.
 *
 * ── Why the page owns the health state ──────────────────────────────────────
 * The header badge, the summary cards and the Overview panel all read the same
 * `/api/developer/health` payload. Fetching it in each of the three would start
 * three independent 30-second polls, and because they resolve separately the
 * badge could say "Degraded" above a panel saying "All clear" while a request
 * lagged. So the page holds the single poll (`useDeveloperHealth`) and passes it
 * down, which is the same split the CEO page uses for the analytics range.
 *
 * ── What the four summary cards now report ─────────────────────────────────
 * They previously read "API latency 132ms", "Active accounts 248", "Webhook
 * failures 2" and "System status Healthy". Three of the four were invented, and
 * "Webhook failures: 2" described Daraja and Paystack callbacks in an application
 * with no payment provider and no webhook route — a failure count for a subsystem
 * that does not exist, which is worse than no card because it looks actionable.
 * The replacements are a measured round trip, the real `profiles` count, the real
 * active policy count, and the worst severity actually observed.
 *
 * The "Infrastructure health / Driver verification pipeline / Payment webhook
 * integrity" progress bars and the three "active incidents" are gone rather than
 * re-sourced; `SystemHealthPanel` carries the real equivalents, with the reasoning
 * recorded in that file.
 */
import { useState } from 'react';

import { ChatbotMonitorPanel } from '@/components/developer/chatbot-monitor-panel';
import { FeatureTogglePanel } from '@/components/developer/feature-toggle-panel';
import { SystemAuditPanel } from '@/components/developer/system-audit-panel';
import { SystemHealthPanel } from '@/components/developer/system-health-panel';
import { UserManagementTable } from '@/components/developer/user-management-table';
import { useDeveloperHealth } from '@/lib/use-developer-health';
import type { HealthSeverity } from '@/types/developer-health';

type DeveloperTab = 'overview' | 'users' | 'audit' | 'config' | 'chatbot';

const tabs: Array<{ key: DeveloperTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'users', label: 'User Management' },
  { key: 'audit', label: 'System Audit' },
  { key: 'config', label: 'Fleet Controls' },
  { key: 'chatbot', label: 'AI Monitor' },
];

/**
 * Worst-severity pill for the header.
 *
 * The badge is now the thing it always claimed to be. "All services nominal" was
 * hardcoded, which meant it read that way straight through a database outage —
 * the one moment a status badge matters.
 */
const badgeStyles: Record<HealthSeverity, { pill: string; dot: string; label: string }> = {
  ok: {
    pill: 'border-chart-collected/30 bg-chart-collected/10 text-chart-collected',
    dot: 'bg-chart-collected',
    label: 'All checks passing',
  },
  warn: {
    pill: 'border-chart-servicing/30 bg-chart-servicing/5 text-chart-servicing',
    dot: 'bg-chart-servicing',
    label: 'Checks degraded',
  },
  error: {
    pill: 'border-chart-danger/30 bg-chart-danger/10 text-chart-danger',
    dot: 'bg-chart-danger',
    label: 'Attention required',
  },
};

function SummaryCard({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-5 shadow-[0_18px_40px_rgba(18,20,24,0.25)]">
      <p className="text-sm text-content-subtle">{label}</p>
      <p className={`mt-3 text-3xl font-bold ${tone}`}>{value}</p>
      <p className="mt-2 text-xs text-content-muted">{detail}</p>
    </div>
  );
}

export default function DeveloperPage() {
  const [activeTab, setActiveTab] = useState<DeveloperTab>('overview');
  const health = useDeveloperHealth();
  const { payload } = health;

  const badge = badgeStyles[payload?.overall ?? 'ok'];
  const accounts = payload?.tables.find((table) => table.table === 'profiles') ?? null;
  const accountsCount = accounts?.count;

  return (
    <div className="space-y-8 rounded-[2rem] border border-line bg-canvas p-6 text-content shadow-[0_30px_80px_rgba(18,20,24,0.45)] lg:p-8">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Developer Super Admin</p>
          <h1 className="mt-2 text-3xl font-bold text-content">Operational command center</h1>
        </div>
        <div
          className={`inline-flex items-center gap-2 self-start rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] ${badge.pill}`}
        >
          <span className={`h-2 w-2 rounded-full ${badge.dot}`} />
          {payload
            ? badge.label
            : health.isLoading
              ? 'Checking systems'
              : 'Status unknown — health check failed'}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <SummaryCard
          label="Database round trip"
          value={payload?.database.latencyMs === null || payload?.database.latencyMs === undefined ? '—' : `${payload.database.latencyMs} ms`}
          tone={payload?.database.reachable === false ? 'text-chart-danger' : 'text-chart-billed'}
          detail={payload?.database.probe ?? 'Waiting for the first health check…'}
        />
        <SummaryCard
          label="Accounts on file"
          value={accountsCount === null || accountsCount === undefined ? 'unknown' : accountsCount.toLocaleString()}
          tone="text-chart-collected"
          detail={
            accounts?.scope === 'caller'
              ? 'Scoped by RLS — you can only see your own row.'
              : 'profiles, all rows'
          }
        />
        <SummaryCard
          label="Active RLS policies"
          value={payload?.rls.policyCount === null || payload?.rls.policyCount === undefined ? 'unavailable' : payload.rls.policyCount.toLocaleString()}
          tone={payload?.rls.available === false ? 'text-chart-servicing' : 'text-chart-collected'}
          detail={
            payload?.rls.available
              ? `${payload.rls.publicPolicies ?? 0} public · ${payload.rls.storagePolicies ?? 0} storage`
              : 'Needs supabase/migrations/20261005_developer_health_introspection.sql'
          }
        />
        <SummaryCard
          label="Findings"
          value={payload ? String(payload.findings.length) : '—'}
          tone={
            !payload
              ? 'text-content-muted'
              : payload.findings.some((finding) => finding.severity === 'error')
                ? 'text-chart-danger'
                : payload.findings.length > 0
                  ? 'text-chart-servicing'
                  : 'text-chart-collected'
          }
          detail={payload ? `Checked ${new Date(payload.checkedAt).toLocaleTimeString()}` : 'No reading yet'}
        />
      </div>

      <div className="rounded-[1.75rem] border border-line bg-surface/90 shadow-[0_18px_40px_rgba(18,20,24,0.25)]">
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              aria-current={activeTab === tab.key ? 'page' : undefined}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                activeTab === tab.key
                  ? 'bg-brand-solid text-white shadow-[0_0_18px_rgba(255,78,66,0.35)]'
                  : 'bg-canvas text-content-muted hover:bg-surface-2 hover:text-content'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-5">
          {activeTab === 'overview' && <SystemHealthPanel health={health} />}
          {activeTab === 'users' && <UserManagementTable />}
          {activeTab === 'audit' && <SystemAuditPanel />}
          {activeTab === 'config' && <FeatureTogglePanel health={health} />}
          {activeTab === 'chatbot' && <ChatbotMonitorPanel />}
        </div>
      </div>
    </div>
  );
}
