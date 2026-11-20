// "Race burst" in the Overview of Run & Results (the `race` of the `done` event, see
// public/js/shared/race.js readRaceResult): a note (all in time, VUs late, VUs that never
// sent), the concurrency figures, the Gantt chart (race-gantt.js: one row per VU, from
// its send time to its response, a tick at its planned time) and a table with every
// VU. Shown in both modes; every text goes in with textContent.
import { el } from './dom.js';
import { RACE_RECORD_COLUMNS, raceFigures, raceRecordCells, raceResultText, raceResultWarns } from './shared/race.js';
import { GANTT_MAX_ROWS, raceGantt } from './race-gantt.js';

const SVG = 'http://www.w3.org/2000/svg';
// The table shows this many rows; the report has them all.
export const RACE_TABLE_MAX_ROWS = 500;

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function drawGantt(target, layout) {
  target.replaceChildren();
  target.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  for (const tick of layout.ticks) {
    target.append(svg('line', { class: tick.label === 'T0' ? 'zero' : 'grid', x1: tick.x, x2: tick.x, y1: layout.top - 6, y2: layout.bottom }));
    const label = svg('text', { class: 'tick', x: tick.x, y: layout.top - 10, 'text-anchor': tick.anchor });
    label.textContent = tick.label;
    target.append(label);
  }
  for (const row of layout.rows) {
    const group = svg('g', { class: `row${row.late ? ' late' : ''}` });
    const title = svg('title');
    title.textContent = row.title;
    group.append(title, svg('rect', { class: 'hit', x: 0, y: row.y, width: layout.width, height: row.h }));
    if (row.label) {
      const label = svg('text', { class: 'vu', x: layout.left - 8, y: row.mid, 'dominant-baseline': 'central' });
      label.textContent = row.label;
      group.append(label);
    }
    group.append(
      svg('rect', { class: `bar ${row.tone}`, x: row.x, y: row.barY, width: row.w, height: row.barH, rx: 2 }),
      svg('line', { class: 'plan', x1: row.planX, x2: row.planX, y1: row.y + 1, y2: row.y + row.h - 1 }),
    );
    target.append(group);
  }
  if (layout.peak) {
    target.append(svg('line', { class: 'peak', x1: layout.peak.x, x2: layout.peak.x, y1: layout.top - 4, y2: layout.bottom }));
    const label = svg('text', { class: 'peak-label', x: layout.peak.labelX, y: layout.bottom + 6, 'dominant-baseline': 'hanging', 'text-anchor': layout.peak.anchor });
    label.textContent = layout.peak.label;
    target.append(label);
    target.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height + 14}`);
  }
}

function caption(result, layout) {
  const rows = layout.shown < layout.total
    ? `The first ${layout.shown} of ${layout.total} VUs by planned time; the table has every VU.`
    : 'One row per VU, by planned time.';
  return `${rows} The bar runs from the moment the VU sent Request ${result.rq} to its response; the tick marks its planned send time${layout.peak ? '; the dashed line is where the most requests were in flight' : ''}. Times are the k6 clock, not arrival at the server.`;
}

function renderLegend(list, legend) {
  list.replaceChildren(...legend.map(item => {
    const entry = document.createElement('li');
    const key = el('span', `run-race-key ${item.tone}`, '');
    key.setAttribute('aria-hidden', 'true');
    entry.append(key, el('span', 'run-race-legend-label', item.label), el('span', 'run-race-legend-count', String(item.count)));
    return entry;
  }));
  list.hidden = legend.length === 0;
}

function renderTable(result) {
  const head = document.querySelector('#run-race-head');
  const body = document.querySelector('#run-race-rows');
  if (!head || !body) return;
  head.replaceChildren(...RACE_RECORD_COLUMNS.map(column => {
    const cell = el('th', '', column);
    cell.scope = 'col';
    return cell;
  }));
  body.replaceChildren(...result.records.slice(0, RACE_TABLE_MAX_ROWS).map(entry => {
    const row = document.createElement('tr');
    if (entry.late) row.className = 'late';
    raceRecordCells(entry).forEach((value, index) => row.append(el('td', RACE_RECORD_COLUMNS[index] === 'Outcome' ? 'outcome' : '', value)));
    return row;
  }));
  const count = document.querySelector('#run-race-record-count');
  if (count) {
    count.textContent = result.records.length > RACE_TABLE_MAX_ROWS
      ? `first ${RACE_TABLE_MAX_ROWS} of ${result.records.length}` : String(result.records.length);
  }
}

// race: the `race` of a `done` event, or null to clear the card.
export function renderRaceResult(race) {
  const section = document.querySelector('#run-race');
  if (!section) return;
  const note = raceResultText(race);
  section.hidden = !note && !race?.records?.length;
  section.classList.toggle('late', raceResultWarns(race));
  document.querySelector('#run-race-note').textContent = note;

  const figures = document.querySelector('#run-race-figures');
  figures.replaceChildren(...raceFigures(race).map(figure => {
    const item = document.createElement('div');
    item.title = figure.hint;
    item.append(el('dt', '', figure.label), el('dd', '', figure.value));
    return item;
  }));

  const chart = document.querySelector('#run-race-chart');
  const layout = race ? raceGantt(race, { maxRows: GANTT_MAX_ROWS }) : null;
  chart.hidden = !layout;
  const records = document.querySelector('#run-race-records');
  records.hidden = !layout;
  if (!layout) {
    document.querySelector('#run-race-gantt').replaceChildren();
    document.querySelector('#run-race-rows')?.replaceChildren();
    return;
  }
  drawGantt(document.querySelector('#run-race-gantt'), layout);
  document.querySelector('#run-race-caption').textContent = caption(race, layout);
  renderLegend(document.querySelector('#run-race-legend'), layout.legend);
  renderTable(race);
}
