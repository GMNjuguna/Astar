'use client';

/**
 * SVG chart primitives.
 *
 * Hand-rolled rather than pulled from a charting library. The three charts this
 * dashboard needs are an area/line pair, a ring, and a bar set — all of which
 * are a few dozen lines of SVG each. Recharts would add roughly 100 kB to every
 * portal's first load, including the driver portal, which never renders a chart.
 * The trade-off is that axes, ticks and tooltips are ours to get right.
 *
 * Every chart measures its container with a `ResizeObserver` and renders in pixel
 * space rather than relying on `viewBox` scaling. Scaling would also scale the
 * axis text, so a narrow column would get unreadably small labels while a wide one
 * got oversized ones.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { formatKsh, formatKshCompact } from '@/lib/format';

// ── Colour tokens ───────────────────────────────────────────────────────────
// Values chosen for contrast against the analytics panel's `bg-surface`.
/**
 * Chart colours, expressed as CSS colour functions rather than literals.
 *
 * These are `rgb(var(--token))` strings so a theme switch repaints the charts
 * with no React re-render and no duplicated palette in JavaScript. The tokens
 * are declared per theme in app/globals.css.
 *
 * ── Why every consumer uses `style`, not the `fill`/`stroke` attribute ──────
 * SVG presentation attributes are not CSS, so `fill="var(--x)"` is invalid and
 * silently renders as no fill at all. The variable only resolves when the
 * property is set through CSS, which in React means `style={{ fill: ... }}`.
 * Every fill and stroke below goes through `style` for that reason.
 */
export const CHART_COLORS = {
  /** Gridlines: decorative redundancy, deliberately below the 3:1 threshold. */
  grid: 'rgb(var(--chart-grid))',
  /** The empty ring track. Purely structural, so kept very faint. */
  track: 'rgb(var(--chart-track))',
  /** Axis tick labels. Resolves to content-subtle, which meets 4.5:1 in both themes. */
  axis: 'rgb(var(--content-subtle))',
  label: 'rgb(var(--content-muted))',
  collected: 'rgb(var(--chart-collected))',
  billed: 'rgb(var(--chart-billed))',
  active: 'rgb(var(--chart-collected))',
  servicing: 'rgb(var(--chart-servicing))',
  inactive: 'rgb(var(--chart-inactive))',
} as const;

/** Measures the container width. Returns 0 until the first observation lands. */
function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;

    if (!node) {
      return;
    }

    // ResizeObserver rather than a window resize listener: the panel also
    // reflows when the dashboard nav collapses, which a window listener misses.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });

    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);

    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

/**
 * Rounds an axis maximum up to a readable step.
 *
 * Without this the top gridline lands on a value like 18,437.52, which reads as
 * noise. Powers-of-ten-ish steps produce 20,000.
 */
function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;

  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;

  return step * magnitude;
}

/**
 * The tooltip can never be wider than this, which is what makes the clamp below
 * provable rather than a guess: the clamp keeps its left edge at least
 * `TOOLTIP_MAX_WIDTH / 2 + margin` from either end, so a tooltip of any width up
 * to `TOOLTIP_MAX_WIDTH` stays fully inside the chart.
 */
const TOOLTIP_MAX_WIDTH = 240;
const TOOLTIP_HALF_GUARD = TOOLTIP_MAX_WIDTH / 2 + 8;

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  // Clamped so the tooltip stays inside the card when hovering the last bucket.
  const clamped = Math.min(
    Math.max(x, TOOLTIP_HALF_GUARD),
    Math.max(width - TOOLTIP_HALF_GUARD, TOOLTIP_HALF_GUARD)
  );

  return (
    <div
      // The tooltip needs to read as a raised surface against whatever it floats
      // over, in either theme. Previously it shared the card's own background,
      // which made it indistinguishable from the chart lines passing beneath it;
      // the border is now the edge that defines it, and bg-surface-2 sits a step
      // away from the bg-surface card in both palettes.
      className="pointer-events-none absolute top-2 z-10 w-max max-w-[240px] -translate-x-1/2 rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-xs shadow-xl"
      style={{ left: clamped }}
      role="tooltip"
    >
      {children}
    </div>
  );
}

// ── Revenue trend ───────────────────────────────────────────────────────────

export type RevenuePoint = {
  key: string;
  label: string;
  fullLabel: string;
  collected: number;
  billed: number;
  entries: number;
  drivers: number;
};

export function RevenueTrendChart({
  points,
  hasTarget = false,
}: {
  points: RevenuePoint[];
  hasTarget?: boolean;
}) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const height = 260;
  const padding = { top: 16, right: 16, bottom: 30, left: 62 };

  const plotWidth = Math.max(width - padding.left - padding.right, 10);
  const plotHeight = height - padding.top - padding.bottom;

  const max = useMemo(
    () => niceMax(Math.max(...points.map((point) => point.billed), 1)),
    [points]
  );

  const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0;
  const xAt = (index: number) => padding.left + (points.length > 1 ? index * stepX : plotWidth / 2);
  const yAt = (value: number) => padding.top + plotHeight - (value / max) * plotHeight;

  const line = (pick: (point: RevenuePoint) => number) =>
    points.map((point, index) => `${index === 0 ? 'M' : 'L'}${xAt(index)},${yAt(pick(point))}`).join(' ');

  const area = `${line((point) => point.billed)} L${xAt(points.length - 1)},${padding.top + plotHeight} L${xAt(0)},${padding.top + plotHeight} Z`;

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  // Label density scales with width so 30 buckets do not overprint each other.
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(3, Math.floor(plotWidth / 70))));

  const totalCollected = points.reduce((sum, point) => sum + point.collected, 0);
  const totalBilled = points.reduce((sum, point) => sum + point.billed, 0);

  const handleMove = (event: React.MouseEvent<SVGRectElement>) => {
    if (points.length === 0 || stepX === 0) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - bounds.left;
    const index = Math.round(offset / stepX);

    setHover(Math.min(Math.max(index, 0), points.length - 1));
  };

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 ? (
        <>
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Revenue trend. Collected ${formatKsh(totalCollected)} against ${formatKsh(totalBilled)} billed.`}
          >
            {gridLines.map((fraction) => {
              const y = padding.top + plotHeight - fraction * plotHeight;

              return (
                <g key={fraction}>
                  <line x1={padding.left} y1={y} x2={padding.left + plotWidth} y2={y} style={{ stroke: CHART_COLORS.grid }} strokeWidth={1} />
                  <text x={padding.left - 8} y={y + 4} textAnchor="end" fontSize={10} style={{ fill: CHART_COLORS.axis }}>
                    {formatKshCompact(max * fraction)}
                  </text>
                </g>
              );
            })}

            <path d={area} style={{ fill: CHART_COLORS.billed }} fillOpacity={0.12} />
            <path d={line((point) => point.billed)} fill="none" style={{ stroke: CHART_COLORS.billed }} strokeWidth={2} strokeDasharray="4 3" />
            <path d={line((point) => point.collected)} fill="none" style={{ stroke: CHART_COLORS.collected }} strokeWidth={2.5} />

            {points.map((point, index) =>
              index % labelEvery === 0 || index === points.length - 1 ? (
                <text
                  key={point.key}
                  x={xAt(index)}
                  y={height - 10}
                  textAnchor="middle"
                  fontSize={10}
                  style={{ fill: CHART_COLORS.axis }}
                >
                  {point.label}
                </text>
              ) : null
            )}

            {hover !== null ? (
              <>
                <line
                  x1={xAt(hover)}
                  y1={padding.top}
                  x2={xAt(hover)}
                  y2={padding.top + plotHeight}
                  style={{ stroke: CHART_COLORS.axis }}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <circle cx={xAt(hover)} cy={yAt(points[hover].collected)} r={4.5} style={{ fill: CHART_COLORS.collected }} />
              </>
            ) : null}

            <rect
              x={padding.left}
              y={padding.top}
              width={plotWidth}
              height={plotHeight}
              fill="transparent"
              onMouseMove={handleMove}
              onMouseLeave={() => setHover(null)}
            />
          </svg>

          {hover !== null ? (
            <Tooltip x={xAt(hover)} width={width}>
              <p className="font-semibold text-content">{points[hover].fullLabel}</p>
              <dl className="mt-1 space-y-0.5">
                <div className="flex items-center justify-between gap-4">
                  <dt className="flex items-center gap-1.5 text-content-subtle">
                    <span className="h-2 w-2 rounded-full" style={{ background: CHART_COLORS.collected }} />
                    Collected
                  </dt>
                  <dd className="font-semibold text-chart-collected">{formatKsh(points[hover].collected)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="flex items-center gap-1.5 text-content-subtle">
                    <span className="h-2 w-2 rounded-full" style={{ background: CHART_COLORS.billed }} />
                    Billed
                  </dt>
                  <dd className="font-semibold text-chart-billed">{formatKsh(points[hover].billed)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4 text-content-subtle">
                  <dt>Entries</dt>
                  <dd>{points[hover].entries}</dd>
                </div>
                <div className="flex items-center justify-between gap-4 text-content-subtle">
                  <dt>Drivers</dt>
                  <dd>{points[hover].drivers}</dd>
                </div>
              </dl>
            </Tooltip>
          ) : null}
        </>
      ) : (
        <div style={{ height }} />
      )}

      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-content-subtle">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-full" style={{ background: CHART_COLORS.collected }} />
          Collected
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-0.5 w-4 rounded-full"
            style={{ backgroundImage: `repeating-linear-gradient(90deg, ${CHART_COLORS.billed} 0 4px, transparent 4px 7px)` }}
          />
          Billed
        </span>
        {hasTarget ? null : (
          <span className="text-content-subtle">No target line: the database stores no revenue target.</span>
        )}
      </div>
    </div>
  );
}

// ── Fleet status ring ───────────────────────────────────────────────────────

export type FleetSliceView = {
  status: string;
  label: string;
  count: number;
  share: number;
  color: string;
};

export function FleetStatusRing({ slices }: { slices: FleetSliceView[] }) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const size = 200;
  const thickness = 26;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);

  let offset = 0;

  return (
    <div ref={ref} className="flex w-full flex-wrap items-center justify-center gap-6">
      {width > 0 ? (
        <svg
          width={size}
          height={size}
          role="img"
          aria-label={`Fleet availability: ${slices.map((slice) => `${slice.count} ${slice.label.toLowerCase()}`).join(', ')}.`}
        >
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <circle cx={size / 2} cy={size / 2} r={radius} fill="none" style={{ stroke: CHART_COLORS.track }} strokeWidth={thickness} />
            {slices.map((slice, index) => {
              if (slice.count === 0 || total === 0) {
                return null;
              }

              const length = (slice.count / total) * circumference;
              // Drawn as a dashed stroke rather than a <path> arc: an arc path
              // degenerates when a single slice spans the full circle, which is
              // exactly what a fleet of one active vehicle produces.
              const dash = `${length} ${circumference - length}`;
              const dashOffset = -offset;
              const dimmed = hover !== null && hover !== index;

              offset += length;

              return (
                <circle
                  key={slice.status}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  strokeWidth={hover === index ? thickness + 6 : thickness}
                  strokeDasharray={dash}
                  strokeDashoffset={dashOffset}
                  opacity={dimmed ? 0.3 : 1}
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                  style={{
                    stroke: slice.color,
                    transition: 'opacity 120ms, stroke-width 120ms',
                    cursor: 'pointer',
                  }}
                />
              );
            })}
          </g>
          {/* The ring centre total. Uses the content token rather than white so it
              stays legible when the ring sits on a light surface. */}
          <text x={size / 2} y={size / 2 - 4} textAnchor="middle" fontSize={30} fontWeight={700} style={{ fill: 'rgb(var(--content))' }}>
            {hover !== null ? slices[hover].count : total}
          </text>
          <text x={size / 2} y={size / 2 + 18} textAnchor="middle" fontSize={11} style={{ fill: CHART_COLORS.axis }}>
            {hover !== null ? slices[hover].label : 'vehicles'}
          </text>
        </svg>
      ) : (
        <div style={{ width: size, height: size }} />
      )}

      <ul className="min-w-[200px] flex-1 space-y-2">
        {slices.map((slice, index) => (
          <li
            key={slice.status}
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
            className="flex items-center justify-between gap-3 rounded-md px-2 py-1 text-sm"
            // A white wash would be invisible on a light card, so the hover wash is derived
            // from the content token and reads correctly on either canvas.
            style={{ background: hover === index ? 'rgb(var(--content) / 0.06)' : 'transparent' }}
          >
            <span className="flex items-center gap-2 text-content-muted">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: slice.color }} />
              {slice.label}
            </span>
            <span className="tabular-nums text-content-subtle">
              <span className="font-semibold text-content">{slice.count}</span>
              <span className="ml-2 w-12 text-right text-xs">{slice.share.toFixed(0)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Maintenance bars ────────────────────────────────────────────────────────

export type MaintenanceBar = {
  key: string;
  label: string;
  count: number;
  value: number;
};

export function MaintenanceBarChart({ bars }: { bars: MaintenanceBar[] }) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const height = 260;
  const padding = { top: 16, right: 16, bottom: 46, left: 62 };

  const plotWidth = Math.max(width - padding.left - padding.right, 10);
  const plotHeight = height - padding.top - padding.bottom;

  const max = useMemo(() => niceMax(Math.max(...bars.map((bar) => bar.value), 1)), [bars]);

  const slot = bars.length > 0 ? plotWidth / bars.length : plotWidth;
  const barWidth = Math.min(Math.max(slot * 0.62, 6), 48);

  const labelEvery = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(plotWidth / 64))));

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 ? (
        <>
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Maintenance estimated cost by vehicle. Highest is ${bars[0]?.label ?? 'none'} at ${formatKsh(bars[0]?.value ?? 0)}.`}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
              const y = padding.top + plotHeight - fraction * plotHeight;

              return (
                <g key={fraction}>
                  <line x1={padding.left} y1={y} x2={padding.left + plotWidth} y2={y} style={{ stroke: CHART_COLORS.grid }} strokeWidth={1} />
                  <text x={padding.left - 8} y={y + 4} textAnchor="end" fontSize={10} style={{ fill: CHART_COLORS.axis }}>
                    {formatKshCompact(max * fraction)}
                  </text>
                </g>
              );
            })}

            {bars.map((bar, index) => {
              const barHeight = (bar.value / max) * plotHeight;
              const x = padding.left + index * slot + (slot - barWidth) / 2;
              const y = padding.top + plotHeight - barHeight;

              return (
                <g key={bar.key}>
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(barHeight, 1)}
                    rx={3}
                    opacity={hover === null || hover === index ? 1 : 0.45}
                    onMouseEnter={() => setHover(index)}
                    onMouseLeave={() => setHover(null)}
                    style={{ fill: CHART_COLORS.servicing, transition: 'opacity 120ms', cursor: 'pointer' }}
                  />
                  {index % labelEvery === 0 ? (
                    <text x={x + barWidth / 2} y={padding.top + plotHeight + 16} textAnchor="middle" fontSize={10} style={{ fill: CHART_COLORS.axis }}>
                      {bar.label.length > 9 ? `${bar.label.slice(0, 8)}…` : bar.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>

          {hover !== null ? (
            <Tooltip x={padding.left + hover * slot + slot / 2} width={width}>
              <p className="font-semibold text-content">{bars[hover].label}</p>
              <p className="mt-1 text-chart-collected">{formatKsh(bars[hover].value)} estimated</p>
              <p className="text-content-subtle">
                {bars[hover].count} record{bars[hover].count === 1 ? '' : 's'}
              </p>
            </Tooltip>
          ) : null}
        </>
      ) : (
        <div style={{ height }} />
      )}
    </div>
  );
}