'use client';

export function MetricCard({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string;
  detail: string;
  accent: 'blue' | 'amber' | 'emerald' | 'red';
}) {
  const accents: Record<typeof accent, string> = {
    blue: 'bg-chart-blue/10 text-chart-blue border-chart-blue/30',
    amber: 'bg-chart-servicing/5 text-chart-servicing border-chart-servicing/30',
    emerald: 'bg-chart-collected/10 text-chart-collected border-chart-collected/30',
    red: 'bg-chart-danger/10 text-chart-danger border-chart-danger/30',
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-content-subtle">{label}</p>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${accents[accent]}`}>{detail}</span>
      </div>
      <p className="mt-4 text-3xl font-bold text-content">{value}</p>
    </div>
  );
}
