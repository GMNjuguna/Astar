/**
 * Live database query tools for the fleet assistant.
 *
 * ── Why RLS does the scoping, not this file ─────────────────────────────────
 * Every query runs on the caller's own request-scoped client
 * (`authorizeRole(...).supabase`), never a service-role client. Row visibility
 * is therefore already enforced by policy before this code sees a row:
 *
 *   cars                       → manager / ceo / developer only; drivers see 0
 *   daily_remittances          → drivers see their own; managers+ see all
 *   driver_documents           → drivers see their own; managers+ see all
 *   driver_onboarding_queue    → manager / ceo / developer only; drivers see 0
 *   vehicle_maintenance        → manager / ceo / developer only; drivers see 0
 *
 * A driver asking "what did the whole fleet earn this month?" therefore gets a
 * correctly filtered empty result, not a leaky one. This module never widens
 * access; it only chooses *which* queries to run and how to describe them.
 *
 * ── Failing loudly ─────────────────────────────────────────────────────────
 * If any query errors, `runAssistantTools` returns `{ ok: false }` and the route
 * turns that into a 503. It does not assemble a partial answer, because a
 * confident reply missing half its figures is worse than an error the operator
 * can see and fix.
 */
import type { AppRole, RequestScopedClient } from '@/lib/auth';
import { formatKsh } from '@/lib/format';

export type ToolName = 'fleet_status' | 'remittance_totals' | 'document_status' | 'maintenance_status';

export type AssistantScope = {
  role: AppRole;
  /** `profiles.id` of the caller — also their `auth.users.id`. */
  driverId: string;
  driverName: string | null;
  /**
   * Whether this role may see other people's records.
   *
   * Mirrors what RLS already enforces; used to choose framing and to avoid
   * running fleet-wide tools for a driver who would only get zeros.
   */
  fleetWide: boolean;
};

export type ToolResult = {
  tool: ToolName;
  /** Already-scoped, plain-language summary suitable for direct display. */
  summary: string;
  /** Structured figures handed to the model. */
  facts: Record<string, unknown>;
  /**
   * Present when a figure could not be computed honestly — e.g. an aggregate was
   * skipped because the table exceeded the row cap. Rendered in the UI so a
   * partial number is never mistaken for a complete one.
   */
  caveat?: string;
};

/**
 * Row cap for in-process aggregates.
 *
 * PostgREST cannot sum a numeric column without an RPC, so totals are summed in
 * JS. Counts come free via `count: 'exact', head: true`, but sums need rows. When
 * a table exceeds this cap the tool reports on the most recent rows and states
 * the truncation rather than presenting a partial sum as the total.
 */
const AGGREGATE_ROW_CAP = 5000;

/** `numeric` arrives as a JSON number, but coerce defensively rather than assume. */
function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// -----------------------------------------------------------------------------
// Tool implementations
// -----------------------------------------------------------------------------

/**
 * Fleet composition: total vehicles, status breakdown, and which drivers are
 * actually driving them.
 *
 * Note on "assigned drivers": `cars` has **no** `driver_id` column, and
 * `driver_onboarding_queue.assigned_car` is free text rather than a foreign key.
 * There is therefore no authoritative driver-to-vehicle assignment in the
 * schema. The most recent remittance per vehicle is used as a proxy and is
 * labelled as such, because presenting an inferred pairing as a hard assignment
 * would be a factual claim the database cannot support.
 */
async function fleetStatus(supabase: RequestScopedClient): Promise<ToolResult> {
  const [totalRes, activeRes, servicingRes, inactiveRes] = await Promise.all([
    supabase.from('cars').select('*', { count: 'exact', head: true }),
    supabase.from('cars').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('cars').select('*', { count: 'exact', head: true }).eq('status', 'servicing'),
    supabase.from('cars').select('*', { count: 'exact', head: true }).eq('status', 'inactive'),
  ]);

  const error = totalRes.error ?? activeRes.error ?? servicingRes.error ?? inactiveRes.error;

  if (error) {
    throw error;
  }

  const total = totalRes.count ?? 0;
  const active = activeRes.count ?? 0;
  const servicing = servicingRes.count ?? 0;
  const inactive = inactiveRes.count ?? 0;

  // Proxy pairing: most recent remittance per vehicle identifies its operator.
  const { data: remitRows, error: remitError, count: remitCount } = await supabase
    .from('daily_remittances')
    .select('car_id, driver_id')
    .order('created_at', { ascending: false })
    .limit(AGGREGATE_ROW_CAP);

  if (remitError) {
    throw remitError;
  }

  const assignments = new Map<string, string>();
  const truncated = (remitCount ?? 0) > AGGREGATE_ROW_CAP;

  for (const row of remitRows ?? []) {
    if (!assignments.has(row.car_id)) {
      assignments.set(row.car_id, row.driver_id);
    }
  }

  const driverIds = [...new Set(assignments.values())].slice(0, 25);
  const nameById = await resolveDriverNames(supabase, driverIds);
  const activeRate = total > 0 ? Math.round((active / total) * 100) : 0;

  const result: ToolResult = {
    tool: 'fleet_status',
    summary:
      total === 0
        ? 'No vehicles are registered yet.'
        : `The fleet has ${total} ${total === 1 ? 'vehicle' : 'vehicles'}: ${active} active (${activeRate}% of the fleet), ${servicing} in servicing, ${inactive} inactive. ${assignments.size} of ${total} ${total === 1 ? 'vehicle has' : 'vehicles have'} a recent remittance on record.`,
    facts: {
      totalVehicles: total,
      active,
      servicing,
      inactive,
      activeRatePercent: activeRate,
      vehiclesWithRecentRemittance: assignments.size,
      assignedDrivers: [...assignments.entries()]
        .slice(0, 25)
        .map(([carId, driverId]) => ({
          carId,
          driverName: nameById.get(driverId) ?? 'unresolved driver',
        })),
      assignmentBasis: 'derived_from_most_recent_remittance',
    },
  };

  if (truncated) {
    result.caveat = `Remittance history exceeded ${AGGREGATE_ROW_CAP.toLocaleString('en-KE')} rows, so vehicle-to-driver pairing covers the most recent records only.`;
  }

  return result;
}

/** Revenue collected, money outstanding, and the strongest earners. */
async function remittanceTotals(supabase: RequestScopedClient, scope: AssistantScope): Promise<ToolResult> {
  const { data, error, count } = await supabase
    .from('daily_remittances')
    .select('driver_id, amount, status')
    .order('created_at', { ascending: false })
    .limit(AGGREGATE_ROW_CAP);

  if (error) {
    throw error;
  }

  const rows = data ?? [];
  const truncated = (count ?? 0) > AGGREGATE_ROW_CAP;

  let collected = 0;
  let pending = 0;
  let pendingCount = 0;
  let overdue = 0;
  let overdueCount = 0;

  const perDriver = new Map<string, { total: number; entries: number }>();

  for (const row of rows) {
    const amount = toNumber(row.amount);

    if (row.status === 'paid') {
      collected += amount;
    } else if (row.status === 'pending') {
      pending += amount;
      pendingCount += 1;
    } else if (row.status === 'overdue') {
      overdue += amount;
      overdueCount += 1;
    }

    const bucket = perDriver.get(row.driver_id) ?? { total: 0, entries: 0 };
    bucket.total += amount;
    bucket.entries += 1;
    perDriver.set(row.driver_id, bucket);
  }

  const topIds = [...perDriver.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5)
    .map(([id]) => id);

  const nameById = await resolveDriverNames(supabase, topIds);

  const topDrivers = topIds.map((id) => ({
    driverName: nameById.get(id) ?? 'unresolved driver',
    totalRemitted: formatKsh(perDriver.get(id)?.total ?? 0),
    remittanceEntries: perDriver.get(id)?.entries ?? 0,
  }));

  const outstanding = pending + overdue;

  const result: ToolResult = {
    tool: 'remittance_totals',
    summary:
      scope.fleetWide
        ? `Total remitted and paid is ${formatKsh(collected)} across ${rows.length} ${rows.length === 1 ? 'record' : 'records'}. Outstanding: ${formatKsh(outstanding)} — ${pendingCount} pending (${formatKsh(pending)}) and ${overdueCount} overdue (${formatKsh(overdue)}).`
        : `Your remittances total ${formatKsh(collected + pending + overdue)} across ${rows.length} ${rows.length === 1 ? 'record' : 'records'}: ${formatKsh(collected)} paid, ${formatKsh(pending)} pending, ${formatKsh(overdue)} overdue.`,
    facts: {
      scope: scope.fleetWide ? 'fleet' : 'own_records',
      totalCollected: collected,
      totalPending: pending,
      pendingCount,
      totalOverdue: overdue,
      overdueCount,
      totalOutstanding: outstanding,
      recordCount: rows.length,
      topDrivers,
    },
  };

  if (truncated) {
    result.caveat = `More than ${AGGREGATE_ROW_CAP.toLocaleString('en-KE')} remittance records exist; totals cover the ${AGGREGATE_ROW_CAP.toLocaleString('en-KE')} most recent and are not company-wide.`;
  }

  return result;
}

/** Document verification backlog, plus drivers still stuck in onboarding. */
async function documentStatus(supabase: RequestScopedClient, scope: AssistantScope): Promise<ToolResult> {
  const [pendingDocs, approvedDocs, rejectedDocs, onboardingTotal, onboardingPending, onboardingProvisioned] =
    await Promise.all([
      supabase.from('driver_documents').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('driver_documents').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase.from('driver_documents').select('*', { count: 'exact', head: true }).eq('status', 'rejected'),
      supabase.from('driver_onboarding_queue').select('*', { count: 'exact', head: true }),
      supabase.from('driver_onboarding_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('driver_onboarding_queue').select('*', { count: 'exact', head: true }).eq('status', 'provisioned'),
    ]);

  const error =
    pendingDocs.error ?? approvedDocs.error ?? rejectedDocs.error ?? onboardingTotal.error ?? onboardingPending.error ?? onboardingProvisioned.error;

  if (error) {
    throw error;
  }

  const pending = pendingDocs.count ?? 0;
  const approved = approvedDocs.count ?? 0;
  const rejected = rejectedDocs.count ?? 0;
  const queueTotal = onboardingTotal.count ?? 0;
  const queuePending = onboardingPending.count ?? 0;
  const provisioned = onboardingProvisioned.count ?? 0;

  const result: ToolResult = {
    tool: 'document_status',
    summary: scope.fleetWide
      ? `${pending} ${pending === 1 ? 'document is' : 'documents are'} awaiting verification, ${approved} approved, ${rejected} rejected. The onboarding queue holds ${queueTotal} ${queueTotal === 1 ? 'entry' : 'entries'}, ${queuePending} still pending and ${provisioned} provisioned.`
      : `${pending} of your ${pending + approved + rejected} submitted ${pending + approved + rejected === 1 ? 'document is' : 'documents are'} still awaiting verification, ${approved} approved, ${rejected} rejected.`,
    facts: {
      scope: scope.fleetWide ? 'fleet' : 'own_records',
      documentsPending: pending,
      documentsApproved: approved,
      documentsRejected: rejected,
      onboardingQueueTotal: queueTotal,
      onboardingPending: queuePending,
      onboardingProvisioned: provisioned,
    },
  };

  // The onboarding queue has no driver-facing RLS policy, so a driver always
  // sees zero here. Saying so is better than letting a silent zero read as
  // "nothing is stuck in onboarding".
  if (!scope.fleetWide) {
    result.caveat = 'Onboarding-queue counts cover managers and above; drivers cannot view them.';
  }

  return result;
}

/** Open repair work, prioritised. */
async function maintenanceStatus(supabase: RequestScopedClient): Promise<ToolResult> {
  const [totalRes, openRes, scheduledRes, highRes] = await Promise.all([
    supabase.from('vehicle_maintenance').select('*', { count: 'exact', head: true }),
    supabase.from('vehicle_maintenance').select('*', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('vehicle_maintenance').select('*', { count: 'exact', head: true }).eq('status', 'scheduled'),
    supabase.from('vehicle_maintenance').select('*', { count: 'exact', head: true }).eq('status', 'open').eq('priority', 'high'),
  ]);

  const error = totalRes.error ?? openRes.error ?? scheduledRes.error ?? highRes.error;

  if (error) {
    throw error;
  }

  const { data: urgent, error: urgentError } = await supabase
    .from('vehicle_maintenance')
    .select('vehicle_registration, issue_summary, priority, status, estimated_cost')
    .eq('status', 'open')
    .in('priority', ['high', 'medium'])
    .order('created_at', { ascending: false })
    .limit(8);

  if (urgentError) {
    throw urgentError;
  }

  const total = totalRes.count ?? 0;
  const open = openRes.count ?? 0;
  const scheduled = scheduledRes.count ?? 0;
  const high = highRes.count ?? 0;

  return {
    tool: 'maintenance_status',
    summary:
      total === 0
        ? 'No maintenance records have been logged.'
        : `${open} open ${open === 1 ? 'log' : 'logs'} and ${scheduled} scheduled, ${high} of them high priority. Estimated cost on the open items shown is ${formatKsh((urgent ?? []).reduce((sum, row) => sum + toNumber(row.estimated_cost), 0))}.`,
    facts: {
      totalLogs: total,
      open,
      scheduled,
      highPriorityOpen: high,
      urgentItems: (urgent ?? []).map((row) => ({
        vehicleRegistration: row.vehicle_registration,
        issueSummary: row.issue_summary,
        priority: row.priority,
        estimatedCost: toNumber(row.estimated_cost),
      })),
    },
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Resolves display names for a set of driver ids.
 *
 * A driver id that does not resolve is left unresolved rather than dropped: the
 * caller still counts it in totals, so hiding it would make the figure
 * irreconcilable with the driver list.
 */
async function resolveDriverNames(
  supabase: RequestScopedClient,
  ids: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];

  if (unique.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase.from('profiles').select('id, full_name').in('id', unique);

  if (error) {
    // Name lookup is cosmetic. A failure here must not void the totals, so it is
    // deliberately tolerated and surfaced as "unresolved driver" instead.
    return new Map();
  }

  const names = new Map<string, string>();

  for (const row of data ?? []) {
    names.set(row.id, row.full_name?.trim() || row.id.slice(0, 8));
  }

  return names;
}

/**
 * Intent routing.
 *
 * Deliberately deterministic keyword matching rather than embedding the user's
 * message and classifying it: this runs identically with or without an LLM key,
 * so the tools a question triggers are predictable and testable. Patterns are
 * matched case-insensitively and overlap on purpose — "which cars need servicing"
 * correctly selects both fleet composition and maintenance.
 */
const TOOL_PATTERNS: Record<ToolName, RegExp> = {
  fleet_status:
    /\b(vehicle|vehicles|car|cars|van|vans|truck|trucks|fleet|tyre|tyres|assigned|assignment|utilis|utiliz|active|inactive|servicing)\b/i,
  remittance_totals:
    /\b(remit|remittance|remittances|revenue|earn|earned|earning|income|made|balance|owe|owing|outstanding|pending|overdue|paid|payout|payouts|collection|collect|top|best driver|how much)\b/i,
  document_status:
    /\b(document|documents|doc|licence|license|permit|identification|id card|verification|verify|verified|upload|uploaded|compliance|onboard|onboarding|approve|approval)\b/i,
  maintenance_status:
    /\b(repair|repairs|maintenance|maintain|service|servicing|scheduled service|breakdown|broken|mechanic|mechanical|urgent|critical|issue|issues|engine|brake|tyres|part|parts)\b/i,
};

/** Tools a role can meaningfully run, given what RLS will let it see. */
function allowedTools(scope: AssistantScope): ToolName[] {
  if (scope.fleetWide) {
    return ['fleet_status', 'remittance_totals', 'document_status', 'maintenance_status'];
  }

  // Drivers: no fleet or maintenance tables are readable at all, so those tools
  // are not run — they would only return zeros and invite a misleading answer.
  return ['remittance_totals', 'document_status'];
}

/** Picks tools for a message. Falls back to the role's default set. */
export function selectTools(message: string, scope: AssistantScope): ToolName[] {
  const permitted = allowedTools(scope);
  const matched = permitted.filter((tool) => TOOL_PATTERNS[tool].test(message));

  if (matched.length > 0) {
    return matched;
  }

  return permitted;
}

export type ToolRunResult =
  | { ok: true; results: ToolResult[] }
  | { ok: false; error: unknown };

/**
 * Runs the selected tools. Any failure propagates so the route can 503 rather
 * than answer from partial data.
 */
export async function runAssistantTools(
  supabase: RequestScopedClient,
  scope: AssistantScope,
  tools: ToolName[]
): Promise<ToolRunResult> {
  try {
    const results = await Promise.all(
      tools.map((tool) => {
        switch (tool) {
          case 'fleet_status':
            return fleetStatus(supabase);
          case 'remittance_totals':
            return remittanceTotals(supabase, scope);
          case 'document_status':
            return documentStatus(supabase, scope);
          case 'maintenance_status':
            return maintenanceStatus(supabase);
          default: {
            // Unreachable: ToolName is a closed union.
            const exhaustive: never = tool;
            return exhaustive;
          }
        }
      })
    );

    return { ok: true, results };
  } catch (error) {
    return { ok: false, error };
  }
}