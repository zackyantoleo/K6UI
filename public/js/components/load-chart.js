// "Load shape" on the Load view: virtual users over time for the load form as
// typed. Presentation only: it reads the load inputs, never the project store,
// and changes nothing that is saved, generated, or run.
import { $, $$ } from '../dom.js';

const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
const MODE_NAMES = { simple: 'Fixed VUs', stages: 'Staged', iterations: 'Iterations' };

// "30s", "5m", "1h30m" → seconds; null for anything k6 would not read as a duration.
export function parseDuration(text) {
  const source = String(text ?? '').trim();
  if (!source) return null;
  let seconds = 0, rest = source;
  while (rest) {
    const part = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)/.exec(rest);
    if (!part) return null;
    seconds += Number(part[1]) * UNIT_SECONDS[part[2]];
    rest = rest.slice(part[0].length);
  }
  return seconds;
}

export function formatDuration(seconds) {
  if (!(seconds > 0)) return '0s';
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  const total = Math.round(seconds);
  const parts = [[Math.floor(total / 3600), 'h'], [Math.floor((total % 3600) / 60), 'm'], [total % 60, 's']];
  return parts.filter(([value]) => value).map(([value, unit]) => `${value}${unit}`).join(' ');
}

const wholeUsers = value => (Math.floor(Number(value)) >= 1 ? Math.floor(Number(value)) : 1);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The shape of a load form: points of [seconds, VUs], its peak and length.
// `open` means the end is not a set time (iterations stop when they are done);
// null means there is nothing to draw yet.
export function loadShape(load) {
  if (load.mode === 'iterations') {
    const vus = wholeUsers(load.vus);
    const iterations = wholeUsers(load.iterations);
    const cap = parseDuration(load.maxDuration) || 3600;
    return {
      mode: 'iterations', points: [[0, vus], [1, vus]], boundaries: [], peak: vus, total: cap, open: true,
      summary: `${plural(vus, 'virtual user')} run the flow ${plural(iterations, 'time')} each: ${plural(vus * iterations, 'run')} in total.`,
    };
  }
  if (load.mode === 'stages') {
    // A row with no target is not sent to k6 (server/generator/options.js), so it is not drawn.
    const stages = (load.stages || [])
      .filter(stage => String(stage.target ?? '').trim() !== '')
      .map(stage => ({ seconds: parseDuration(stage.duration), target: Number(stage.target) }))
      .filter(stage => stage.seconds > 0 && String(stage.target) !== 'NaN' && stage.target >= 0);
    if (!stages.length) return null;
    // k6 starts a staged test at 1 VU and ramps from there.
    const points = [[0, 1]];
    let elapsed = 0;
    for (const stage of stages) {
      elapsed += stage.seconds;
      points.push([elapsed, stage.target]);
    }
    const peak = Math.max(...points.map(([, vus]) => vus));
    return {
      mode: 'stages', points, boundaries: points.slice(1, -1).map(([seconds]) => seconds), peak, total: elapsed, open: false,
      summary: `${plural(stages.length, 'stage')} over ${formatDuration(elapsed)}, reaching ${plural(peak, 'virtual user')} at the peak.`,
    };
  }
  const seconds = parseDuration(load.duration);
  if (!(seconds > 0)) return null;
  const vus = wholeUsers(load.vus);
  return {
    mode: 'simple', points: [[0, vus], [seconds, vus]], boundaries: [], peak: vus, total: seconds, open: false,
    summary: `${plural(vus, 'virtual user')} for ${formatDuration(seconds)}, all starting at once.`,
  };
}

// ── DOM adapter ──────────────────────────────────────────────────
const WIDTH = 600, HEIGHT = 150, HEADROOM = 12;
const SVG = 'http://www.w3.org/2000/svg';

function shape(tag, className, attributes) {
  const element = document.createElementNS(SVG, tag);
  element.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function readLoadForm() {
  const mode = $('input[name="load-mode"]:checked')?.value || 'simple';
  return {
    mode,
    vus: mode === 'iterations' ? $('#iter-vus').value : $('#vus').value,
    duration: $('#duration').value,
    iterations: $('#iterations').value,
    maxDuration: $('#max-duration').value,
    stages: $$('#stages .stage-row').map(row => ({
      duration: row.querySelector('.stage-dur').value,
      target: row.querySelector('.stage-target').value,
    })),
  };
}

function draw(chart, model) {
  const lines = [0, 0.5, 1].map(level => {
    const y = HEIGHT - 1 - level * (HEIGHT - HEADROOM);
    return shape('line', 'grid', { x1: 0, x2: WIDTH, y1: y, y2: y });
  });
  if (!model) return chart.replaceChildren(...lines);
  const span = model.points.at(-1)[0] || 1;
  const x = seconds => (seconds / span) * WIDTH;
  const y = vus => HEIGHT - 1 - (model.peak ? vus / model.peak : 0) * (HEIGHT - HEADROOM);
  const path = model.points.map(([seconds, vus], index) => `${index ? 'L' : 'M'}${x(seconds).toFixed(1)} ${y(vus).toFixed(1)}`).join(' ');
  chart.replaceChildren(
    ...lines,
    ...model.boundaries.map(seconds => shape('line', 'stage', { x1: x(seconds), x2: x(seconds), y1: HEADROOM, y2: HEIGHT })),
    shape('path', 'area', { d: `${path} L${WIDTH} ${HEIGHT} L0 ${HEIGHT} Z` }),
    shape('path', `line${model.open ? ' open' : ''}`, { d: path }),
  );
}

export function initLoadChart() {
  const chart = $('#load-chart');
  if (!chart) return;
  let pending = false;
  function render() {
    pending = false;
    const form = readLoadForm();
    const model = loadShape(form);
    draw(chart, model);
    $('#load-shape-summary').textContent = model ? model.summary : 'Enter a duration such as 30s or 5m to see the shape.';
    $('#load-peak').textContent = model ? plural(model.peak, 'VU') : '—';
    $('#load-total').textContent = !model ? '—' : model.open ? `Up to ${formatDuration(model.total)}` : formatDuration(model.total);
    $('#load-mode-name').textContent = MODE_NAMES[form.mode] || '—';
    $('#load-axis-end').textContent = !model ? '' : model.open ? 'until every iteration is done' : formatDuration(model.total);
  }
  // Presets and opened projects set values from code, which fires no input event.
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(render);
  }
  const view = $('#view-load');
  view.addEventListener('input', schedule);
  view.addEventListener('change', schedule);
  view.addEventListener('click', schedule);
  new MutationObserver(schedule).observe($('#stages'), { childList: true });
  window.addEventListener('k6ui:project-applied', schedule);
  render();
}
