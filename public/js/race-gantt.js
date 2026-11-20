// Race burst Gantt chart: one row per VU, a bar from the moment it sent the race
// request to its response, a tick at its planned send time, and a line where the most
// requests were in flight. Pure layout (no DOM): the Race card (race-results.js) and
// the report (run-report.js) draw the same geometry, each in its own way.
//
// Colour follows the outcome label (identity), in the order of the request's outcome
// rules: the first labels take the categorical slots tone-1 … tone-8 (fixed order,
// never cycled), the fallback label and any label past the eighth take the neutral
// tone-other. Without outcome rules every bar is tone-1 and there is no legend. The
// label is also in every row's tooltip and in the table, so colour never carries it alone.
import { raceRecordCells } from './shared/race.js';

export const GANTT_WIDTH = 720;
export const GANTT_MAX_ROWS = 100;
export const GANTT_SLOTS = 8;
const LEFT = 56;          // room for "VU 12"
const RIGHT = 14;
const TOP = 24;           // the time axis labels
const BOTTOM = 8;
const ROW_MAX = 18;
const ROW_MIN = 3;
const PLOT_HEIGHT = 300;  // rows shrink to fit this, down to ROW_MIN
const round = value => Math.round(value * 100) / 100;

// A "nice" tick step (1, 2 or 5 × 10^k) for about `count` ticks over `span` ms.
export function tickStep(span, count = 6) {
  const raw = Math.max(span, 1) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(factor => factor * power).find(value => value >= raw);
  return Math.max(1, step);
}

// label → tone, in rule order. `labels` and `fallback` come from the result.
export function outcomeTones(labels, fallback) {
  const tones = new Map();
  let slot = 0;
  for (const label of labels || []) {
    if (tones.has(label)) continue;
    if (label === fallback || slot >= GANTT_SLOTS) tones.set(label, 'tone-other');
    else tones.set(label, `tone-${++slot}`);
  }
  return tones;
}

// result (race.js readRaceResult) → null without records, else
//   { width, height, left, right, top, bottom, shown, total, ticks: [{ x, label, anchor }],
//     rows: [{ vu, y, h, mid, label, planX, x, w, barY, barH, tone, late, title }],
//     peak: { x, label, labelX, anchor } | null,
//     legend: [{ label, tone, count }] }
// `width` and every x are in viewBox units; the chart scales to its container.
export function raceGantt(result, { maxRows = GANTT_MAX_ROWS, width = GANTT_WIDTH } = {}) {
  const records = Array.isArray(result?.records) ? result.records : [];
  if (!records.length) return null;
  const shown = records.slice(0, maxRows);
  const start = Math.min(0, ...shown.map(entry => Math.min(entry.offset, entry.sent)));
  const end = Math.max(...shown.map(entry => Math.max(entry.offset, entry.sent + entry.ms)));
  const step = tickStep(end - start);
  const from = Math.floor(start / step) * step;
  const to = Math.max(from + step, Math.ceil(end / step) * step);
  const plotWidth = width - LEFT - RIGHT;
  const scale = ms => round(LEFT + ((ms - from) / (to - from)) * plotWidth);

  const rowHeight = Math.max(ROW_MIN, Math.min(ROW_MAX, Math.floor(PLOT_HEIGHT / shown.length)));
  // A gap between neighbouring bars: 6 units on roomy rows, 1 on the thinnest.
  const barHeight = rowHeight >= 10 ? rowHeight - 6 : Math.max(2, rowHeight - 1);
  const labelled = rowHeight >= 12;
  const tones = outcomeTones(result.labels, result.fallback);
  const toneOf = label => (tones.size ? tones.get(label) || 'tone-other' : 'tone-1');

  const rows = shown.map((entry, index) => {
    const y = TOP + index * rowHeight;
    const x = scale(entry.sent);
    const cells = raceRecordCells(entry);
    const parts = [`VU ${entry.vu}`, `planned ${cells[1]}`, `sent ${cells[3]} (${cells[4]})`, `took ${cells[5]}`, `status ${cells[6]}`];
    if (entry.outcome) parts.push(`outcome ${entry.outcome}`);
    if (entry.late) parts.push('late');
    if (entry.newConnection) parts.push('new connection');
    return {
      vu: entry.vu,
      y,
      h: rowHeight,
      mid: y + rowHeight / 2,
      label: labelled ? `VU ${entry.vu}` : '',
      planX: scale(entry.offset),
      x,
      w: Math.max(2, round(scale(entry.sent + entry.ms) - x)),
      barY: round(y + (rowHeight - barHeight) / 2),
      barH: barHeight,
      tone: toneOf(entry.outcome),
      late: entry.late,
      title: parts.join(' · '),
    };
  });

  const ticks = [];
  for (let ms = from; ms <= to + step / 2; ms += step) {
    ticks.push({ x: scale(ms), label: ms === 0 ? 'T0' : `${ms > 0 ? '+' : '−'}${Math.abs(ms).toLocaleString('en-US')} ms`, anchor: 'middle' });
  }
  // The last label ends at its line, so it stays inside the chart.
  ticks.at(-1).anchor = 'end';

  // The peak label sits right of its line, or left of it near the right edge.
  const stats = result.stats;
  const peakX = stats ? scale(stats.peakAt) : 0;
  const peakLeft = peakX > LEFT + plotWidth * 0.8;
  const peak = stats && stats.peakInFlight > 1
    ? { x: peakX, label: `${stats.peakInFlight} in flight`, labelX: round(peakX + (peakLeft ? -4 : 4)), anchor: peakLeft ? 'end' : 'start' }
    : null;

  const counts = new Map();
  for (const entry of records) counts.set(entry.outcome, (counts.get(entry.outcome) || 0) + 1);
  // Only the labels the chart shows; each keeps the tone of its place in the rules.
  const legend = [...tones].filter(([label]) => counts.has(label)).map(([label, tone]) => ({ label, tone, count: counts.get(label) }));

  return {
    width,
    height: TOP + shown.length * rowHeight + BOTTOM,
    left: LEFT,
    right: width - RIGHT,
    top: TOP,
    bottom: TOP + shown.length * rowHeight,
    shown: shown.length,
    total: records.length,
    ticks,
    rows,
    peak,
    legend,
  };
}
