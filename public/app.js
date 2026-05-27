const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// ---------- Request builder ----------
const requestsEl = $("#requests");

function headerRow(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "header-row";
  row.innerHTML = `
    <input class="h-key" placeholder="Header (mis. Content-Type)" />
    <input class="h-val" placeholder="Nilai (mis. application/json)" />
    <button type="button" title="Hapus header">&times;</button>`;
  row.querySelector(".h-key").value = key;
  row.querySelector(".h-val").value = value;
  row.querySelector("button").addEventListener("click", () => row.remove());
  return row;
}

function requestBlock(index) {
  const block = document.createElement("div");
  block.className = "request";
  block.innerHTML = `
    <div class="request-head">
      <span class="num">#${index + 1}</span>
      <select class="method"></select>
      <input class="url" placeholder="https://contoh.com/api" />
      <button type="button" class="req-remove" title="Hapus request">Hapus</button>
    </div>
    <div class="sub-label">Headers</div>
    <div class="headers-list"></div>
    <button type="button" class="btn ghost small add-header">+ Header</button>
    <div class="sub-label" style="margin-top:10px">Body (untuk POST/PUT/PATCH)</div>
    <textarea class="body" placeholder='mis. {"username":"andi","pass":"123"}'></textarea>
    <div class="req-options">
      <label><input type="checkbox" class="check-status" checked /> Cek status sukses (2xx/3xx)</label>
      <label>Jeda setelah request (detik): <input type="number" class="sleep" min="0" step="0.5" value="1" /></label>
    </div>`;

  const methodSel = block.querySelector(".method");
  METHODS.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m; opt.textContent = m;
    methodSel.appendChild(opt);
  });

  block.querySelector(".add-header").addEventListener("click", () => {
    block.querySelector(".headers-list").appendChild(headerRow());
  });
  block.querySelector(".req-remove").addEventListener("click", () => {
    block.remove();
    renumber();
  });

  return block;
}

function renumber() {
  $$(".request").forEach((b, i) => {
    b.querySelector(".num").textContent = `#${i + 1}`;
  });
}

function addRequest() {
  requestsEl.appendChild(requestBlock(requestsEl.children.length));
}

$("#add-request").addEventListener("click", addRequest);

// ---------- Stages builder ----------
const stagesEl = $("#stages");
function stageRow(duration = "30s", target = "20") {
  const row = document.createElement("div");
  row.className = "stage-row";
  row.innerHTML = `
    <span class="lbl">Selama</span>
    <input class="stage-dur" placeholder="mis. 30s" />
    <span class="lbl">naik ke</span>
    <input class="stage-target" type="number" min="0" placeholder="VUs" />
    <button type="button" title="Hapus stage">&times;</button>`;
  row.querySelector(".stage-dur").value = duration;
  row.querySelector(".stage-target").value = target;
  row.querySelector("button").addEventListener("click", () => row.remove());
  return row;
}
$("#add-stage").addEventListener("click", () => stagesEl.appendChild(stageRow()));

// Toggle simple vs stages
$$('input[name="load-mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    const mode = document.querySelector('input[name="load-mode"]:checked').value;
    $("#load-simple").classList.toggle("hidden", mode !== "simple");
    $("#load-stages").classList.toggle("hidden", mode !== "stages");
  });
});

// ---------- Collect config ----------
function collectConfig() {
  const requests = $$(".request").map((b) => ({
    method: b.querySelector(".method").value,
    url: b.querySelector(".url").value.trim(),
    headers: Array.from(b.querySelectorAll(".header-row"))
      .map((h) => ({ key: h.querySelector(".h-key").value.trim(), value: h.querySelector(".h-val").value }))
      .filter((h) => h.key),
    body: b.querySelector(".body").value,
    checkStatus: b.querySelector(".check-status").checked,
    sleepAfter: b.querySelector(".sleep").value,
  }));

  const mode = document.querySelector('input[name="load-mode"]:checked').value;
  const load = { mode };
  if (mode === "simple") {
    load.vus = $("#vus").value;
    load.duration = $("#duration").value.trim();
  } else {
    load.stages = $$(".stage-row").map((s) => ({
      duration: s.querySelector(".stage-dur").value.trim(),
      target: s.querySelector(".stage-target").value,
    }));
  }

  return {
    scenario: { requests },
    load,
    thresholds: { p95: $("#p95").value, errorRate: $("#errorRate").value },
  };
}

function validate(config) {
  const reqs = config.scenario.requests.filter((r) => r.url);
  if (reqs.length === 0) return "Tambahkan minimal satu request dengan URL.";
  if (config.load.mode === "stages") {
    const stages = (config.load.stages || []).filter((s) => s.duration && s.target !== "");
    if (stages.length === 0) return "Tambahkan minimal satu stage yang valid.";
  }
  return null;
}

// ---------- Script preview ----------
async function previewScript() {
  const config = collectConfig();
  const err = validate(config);
  if (err) { alert(err); return; }
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  $("#script-preview").textContent = data.script || data.error || "";
  $("#script-card").classList.remove("hidden");
}
$("#preview-btn").addEventListener("click", previewScript);

$("#copy-script").addEventListener("click", () => {
  navigator.clipboard.writeText($("#script-preview").textContent);
  $("#copy-script").textContent = "Tersalin!";
  setTimeout(() => ($("#copy-script").textContent = "Salin"), 1500);
});

// ---------- Run test ----------
let controller = null;

function setRunning(running) {
  $("#run-btn").classList.toggle("hidden", running);
  $("#stop-btn").classList.toggle("hidden", !running);
}

async function runTest() {
  const config = collectConfig();
  const err = validate(config);
  if (err) { alert(err); return; }

  const logEl = $("#log");
  const stateEl = $("#run-state");
  logEl.textContent = "";
  $("#metrics").classList.add("hidden");
  $("#metrics").innerHTML = "";
  $("#results-hint").textContent = "Test sedang berjalan...";
  stateEl.textContent = "BERJALAN";
  stateEl.className = "run-state running";
  setRunning(true);

  controller = new AbortController();

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
      signal: controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server error ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop();

      for (const raw of events) {
        if (!raw.trim()) continue;
        const eventMatch = raw.match(/^event: (.+)$/m);
        const dataMatch = raw.match(/^data: (.+)$/m);
        if (!dataMatch) continue;
        const event = eventMatch ? eventMatch[1] : "message";
        const data = JSON.parse(dataMatch[1]);
        handleEvent(event, data);
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      $("#log").textContent += `\n[ERROR] ${e.message}\n`;
      stateEl.textContent = "GAGAL";
      stateEl.className = "run-state fail";
    }
  } finally {
    setRunning(false);
    controller = null;
  }
}

function handleEvent(event, data) {
  const logEl = $("#log");
  const stateEl = $("#run-state");

  if (event === "log") {
    logEl.textContent += data.line;
    logEl.scrollTop = logEl.scrollHeight;
  } else if (event === "status") {
    logEl.textContent += `[${data.message}]\n`;
  } else if (event === "error") {
    logEl.textContent += `\n[ERROR] ${data.message}\n`;
    stateEl.textContent = "GAGAL";
    stateEl.className = "run-state fail";
  } else if (event === "done") {
    const passed = data.code === 0;
    stateEl.textContent = passed ? "SELESAI" : "TARGET TIDAK TERCAPAI";
    stateEl.className = "run-state " + (passed ? "ok" : "fail");
    $("#results-hint").textContent = passed
      ? "Test selesai. Lihat ringkasan di bawah."
      : "Test selesai, namun ada target/threshold yang tidak terpenuhi (exit code " + data.code + ").";
    if (data.summary) renderMetrics(data.summary);
  }
}

function fmt(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return "-";
  return Number(n).toFixed(digits);
}

function renderMetrics(summary) {
  const m = summary.metrics || {};
  const cards = [];

  const reqs = m.http_reqs;
  if (reqs) cards.push({ label: "Total Request", value: reqs.count ?? "-" });
  if (reqs && reqs.rate != null) cards.push({ label: "Request/detik", value: fmt(reqs.rate, 1) });

  const dur = m.http_req_duration;
  if (dur) {
    cards.push({ label: "Respons rata-rata", value: fmt(dur.avg) + " ms" });
    cards.push({ label: "Respons p95", value: fmt(dur["p(95)"]) + " ms" });
    cards.push({ label: "Respons maks", value: fmt(dur.max) + " ms" });
  }

  const failed = m.http_req_failed;
  if (failed && failed.value != null) {
    const pct = failed.value * 100;
    cards.push({ label: "Error rate", value: fmt(pct, 2) + " %", good: pct === 0 });
  }

  const vus = m.vus_max;
  if (vus && vus.value != null) cards.push({ label: "VUs maksimum", value: vus.value });

  const metricsEl = $("#metrics");
  metricsEl.innerHTML = cards.map((c) => `
    <div class="metric">
      <div class="label">${c.label}</div>
      <div class="value ${c.good === true ? "ok" : c.good === false ? "bad" : ""}">${c.value}</div>
    </div>`).join("");
  metricsEl.classList.remove("hidden");
}

$("#run-btn").addEventListener("click", runTest);
$("#stop-btn").addEventListener("click", () => {
  if (controller) controller.abort();
  $("#run-state").textContent = "DIHENTIKAN";
  $("#run-state").className = "run-state fail";
});

// ---------- k6 status ----------
async function checkK6() {
  const el = $("#k6-status");
  try {
    const res = await fetch("/api/k6-status");
    const data = await res.json();
    if (data.installed) {
      el.textContent = "k6 terpasang ✓";
      el.className = "k6-status ok";
    } else {
      el.textContent = "k6 tidak terpasang — test tidak bisa dijalankan";
      el.className = "k6-status missing";
    }
  } catch {
    el.textContent = "Tidak dapat memeriksa k6";
    el.className = "k6-status missing";
  }
}

// ---------- Init ----------
addRequest();
stagesEl.appendChild(stageRow("30s", "10"));
stagesEl.appendChild(stageRow("1m", "20"));
stagesEl.appendChild(stageRow("30s", "0"));
checkK6();
