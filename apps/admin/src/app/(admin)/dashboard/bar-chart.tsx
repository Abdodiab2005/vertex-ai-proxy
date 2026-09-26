import type { AnalyticsBucket } from "../../../lib/types";
import { formatAxisTime } from "./format";

const WIDTH = 720;
const HEIGHT = 220;
const PAD_LEFT = 88;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 36;

export function BarChart({
  label,
  bucket,
  points,
}: {
  label: string;
  bucket: AnalyticsBucket;
  points: { t: string; value: string }[];
}) {
  if (points.length === 0) {
    return (
      <figure className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
        <figcaption className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-2">{label}</figcaption>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No points in this range.</p>
      </figure>
    );
  }

  let maxNumber = 0;
  let maxLabel = points[0]?.value ?? "0";
  for (const point of points) {
    const height = chartHeight(point.value);
    if (height >= maxNumber) {
      maxNumber = height;
      maxLabel = point.value;
    }
  }
  const scale = maxNumber > 0 ? maxNumber : 1;
  const innerWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const slot = innerWidth / points.length;
  const baseline = PAD_TOP + innerHeight;
  const labels = labelIndexes(points.length);

  return (
    <figure className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm min-w-0">
      <figcaption className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-3">{label}</figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={label}
        className="w-full h-auto text-zinc-500 dark:text-zinc-400"
      >
        <title>{label}</title>
        <line
          x1={PAD_LEFT}
          y1={baseline}
          x2={WIDTH - PAD_RIGHT}
          y2={baseline}
          stroke="currentColor"
          strokeWidth="1"
        />
        <line
          x1={PAD_LEFT}
          y1={PAD_TOP}
          x2={PAD_LEFT}
          y2={baseline}
          stroke="currentColor"
          strokeWidth="1"
        />
        <text x={PAD_LEFT - 8} y={PAD_TOP + 4} textAnchor="end" fontSize="11" fill="currentColor">
          {maxLabel}
        </text>
        <text x={PAD_LEFT - 8} y={baseline} textAnchor="end" fontSize="11" fill="currentColor">
          0
        </text>
        {points.map((point, index) => {
          const barHeight = (chartHeight(point.value) / scale) * innerHeight;
          const x = PAD_LEFT + index * slot;
          const y = baseline - barHeight;
          const tip = `${formatAxisTime(point.t, bucket)} UTC: ${point.value}`;
          return (
            <g key={point.t}>
              <rect x={x} y={PAD_TOP} width={Math.max(slot, 0)} height={innerHeight} fill="transparent">
                <title>{tip}</title>
              </rect>
              <rect
                x={x + 1}
                y={y}
                width={Math.max(slot - 2, 0.5)}
                height={Math.max(barHeight, 0)}
                className="fill-zinc-800 dark:fill-zinc-100"
              >
                <title>{tip}</title>
              </rect>
            </g>
          );
        })}
        {labels.map((index) => {
          const point = points[index];
          if (point === undefined) {
            return null;
          }
          const anchor = index === 0 ? "start" : index === points.length - 1 ? "end" : "middle";
          const x = PAD_LEFT + index * slot + slot / 2;
          return (
            <text
              key={point.t}
              x={x}
              y={HEIGHT - 10}
              textAnchor={anchor}
              fontSize="11"
              fill="currentColor"
            >
              {formatAxisTime(point.t, bucket)}
            </text>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Time (UTC)</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.t}>
              <td>{point.t}</td>
              <td>{point.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function chartHeight(value: string): number {
  // Pixel scale only. The tooltip and axis keep the original decimal string.
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function labelIndexes(count: number): number[] {
  if (count <= 1) {
    return [0];
  }
  if (count === 2) {
    return [0, 1];
  }
  const mid = Math.floor((count - 1) / 2);
  return [...new Set([0, mid, count - 1])];
}
