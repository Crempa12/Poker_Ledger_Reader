// Small SVG charts, drawn by hand so the page needs no chart library. Green is money
// won and red is money lost, as in the console app.
import { useMemo, useState, type PointerEvent } from "react";

import { moneySigned, toneOf } from "../format.ts";

// One bar per night, oldest first: taller means a bigger night.
export function Sparkbars({ values }: { values: number[] }) {
  const w = 7;
  const gap = 2;
  const h = 22;
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  return (
    <svg className="sparkbars" width={values.length * (w + gap)} height={h} role="img" aria-label="last nights">
      <line x1={0} x2={values.length * (w + gap)} y1={h / 2} y2={h / 2} className="axis" />
      {values.map((v, i) => {
        const len = Math.max(1, (Math.abs(v) / max) * (h / 2 - 1));
        const y = v >= 0 ? h / 2 - len : h / 2;
        return <rect key={i} x={i * (w + gap)} y={y} width={w} height={len} rx={1} className={toneOf(v)} />;
      })}
    </svg>
  );
}

export interface LinePoint {
  label: string; // shown on hover, e.g. the date
  value: number; // dollars
}

// A running total with the $0 line marked. Hover (or touch) reads the value at a point.
export function LineChart({ points, height = 200 }: { points: LinePoint[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const pad = { top: 16, right: 12, bottom: 18, left: 12 };
  const geo = useMemo(() => {
    const values = points.map((p) => p.value);
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const span = hi - lo || 1;
    const x = (i: number): number =>
      pad.left + (points.length <= 1 ? 0.5 : i / (points.length - 1)) * (width - pad.left - pad.right);
    const y = (v: number): number => pad.top + ((hi - v) / span) * (height - pad.top - pad.bottom);
    return { x, y };
  }, [points, height]);

  if (points.length === 0) return <p className="muted">No nights in this scope.</p>;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${geo.x(i).toFixed(1)},${geo.y(p.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const shown = hover === null ? null : points[hover];

  const onMove = (e: PointerEvent<SVGSVGElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - box.left) / box.width) * width;
    const t = (fx - pad.left) / (width - pad.left - pad.right);
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(t * (points.length - 1)))));
  };

  return (
    <figure className="linechart">
      <figcaption>
        {shown !== null && shown !== undefined ? (
          <>
            <span className="muted">{shown.label}</span> <strong className={toneOf(shown.value)}>{moneySigned(shown.value)}</strong>
          </>
        ) : last !== undefined ? (
          <>
            <span className="muted">Now</span> <strong className={toneOf(last.value)}>{moneySigned(last.value)}</strong>
          </>
        ) : null}
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="running total"
      >
        <line x1={pad.left} x2={width - pad.right} y1={geo.y(0)} y2={geo.y(0)} className="zero" />
        <path d={path} className={`line ${toneOf(last?.value ?? 0)}`} vectorEffect="non-scaling-stroke" />
        {hover !== null && shown !== undefined && shown !== null ? (
          <>
            <line x1={geo.x(hover)} x2={geo.x(hover)} y1={pad.top} y2={height - pad.bottom} className="cross" vectorEffect="non-scaling-stroke" />
            <circle cx={geo.x(hover)} cy={geo.y(shown.value)} r={4} className={`dot ${toneOf(shown.value)}`} />
          </>
        ) : null}
      </svg>
    </figure>
  );
}

// A horizontal bar for a table cell, scaled against the biggest value in the table.
export function NetBar({ value, max }: { value: number; max: number }) {
  const pct = max <= 0 ? 0 : Math.min(100, (Math.abs(value) / max) * 100);
  return (
    <span className="netbar" aria-hidden="true">
      <span className={toneOf(value)} style={{ width: `${pct}%` }} />
    </span>
  );
}
