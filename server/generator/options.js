// Menyusun objek `options` k6 (beban + threshold) dari konfigurasi UI.

export function buildOptions(config) {
  const load = config.load || {};
  const options = {};

  if (load.mode === "stages" && Array.isArray(load.stages) && load.stages.length > 0) {
    options.stages = load.stages
      .filter((s) => s && s.duration && s.target !== "" && s.target != null)
      .map((s) => ({ duration: String(s.duration), target: Number(s.target) }));
  } else {
    options.vus = Number(load.vus) > 0 ? Number(load.vus) : 1;
    options.duration = load.duration ? String(load.duration) : "30s";
  }

  const t = config.thresholds || {};
  const thresholds = {};
  if (t.p95 !== "" && t.p95 != null && !Number.isNaN(Number(t.p95))) {
    thresholds.http_req_duration = [`p(95)<${Number(t.p95)}`];
  }
  if (t.errorRate !== "" && t.errorRate != null && !Number.isNaN(Number(t.errorRate))) {
    thresholds.http_req_failed = [`rate<${Number(t.errorRate) / 100}`];
  }
  if (Object.keys(thresholds).length > 0) {
    options.thresholds = thresholds;
  }

  return options;
}
