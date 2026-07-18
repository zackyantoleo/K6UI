# K6UI — Panduan Proyek

UI web untuk membuat dan menjalankan load test [k6](https://k6.io) tanpa menulis kode.
Stack: Express (ESM) + frontend vanilla JS. **Tanpa build step, tanpa framework, tanpa test otomatis.**

## Menjalankan

```bash
npm start        # http://localhost:3000
npm run dev      # auto-restart saat file server berubah
```

Prasyarat: Node 18+, dan binary `k6` di PATH (hanya untuk menjalankan test; generate script tetap bisa tanpanya).

## Peta kode

```
server/                 Backend (Node/Express, ESM)
├── index.js            Bootstrap Express: static public/ + mount /api
├── routes.js           Endpoint API (lihat bagian API)
├── k6-runner.js        Tulis script ke folder temp, spawn `k6 run`, parse output → event
└── generator/          Konfigurasi JSON → source script k6 (string)
    ├── index.js        generateScript() — orkestrasi
    ├── options.js      Objek options k6 (VU/stages + thresholds)
    ├── request.js      Blok kode satu request HTTP
    ├── assertions.js   Blok check() dari assertion per request
    ├── extract.js      Ekstraksi variabel dari respons
    ├── interpolate.js  Interpolasi {{varName}} → template literal
    └── helpers.js      Selector JSON & literal regex

public/                 Frontend statis (ES modules, tanpa bundler)
├── index.html          Seluruh markup: sidebar + satu <section> per view
├── css/style.css       Seluruh styling
└── js/
    ├── app.js          Titik masuk: event wiring + render awal
    ├── nav.js          Pindah antar view
    ├── dom.js          Helper $ / $$
    ├── config.js       Baca form → objek konfigurasi + validasi
    ├── runner.js       POST /api/run, parse stream SSE, render log/tabel/metrik
    ├── project-io.js   Simpan/muat project (file JSON = objek konfigurasi)
    └── components/
        ├── req-card.js  Kartu request: tab Headers/Body/Ekstraksi/Assertions/Opsi + sub-request pre/post
        ├── rows.js      Baris form header & ekstraksi
        ├── counts.js    Badge jumlah ekstraksi/assertion + penomoran kartu
        └── flow-view.js Zona "Skenario Utama" + baris stage profil beban
```

## Alur data

Form UI → `collectConfig()` (js/config.js) → `POST /api/generate` atau `/api/run`
→ `generateScript()` (server/generator) → [khusus run] `k6-runner.js` spawn k6
→ event SSE → `js/runner.js` render log live, tabel detail request, dan metrik.

## API

| Endpoint | Body | Respons |
|---|---|---|
| `GET /api/k6-status` | — | `{ installed, version? }` |
| `POST /api/generate` | objek konfigurasi | `{ script }` atau 400 `{ error }` |
| `POST /api/run` | objek konfigurasi | Stream SSE (lihat event di bawah) |

Event SSE dari `/api/run`: `status` (progres), `log` (baris output k6), `req-log`
(detail satu request, max 500/run), `error`, `done` (`{ code, summary }` — summary
dari `k6 --summary-export`). Exit code 0 = semua threshold terpenuhi; 99 = gagal.

## Skema objek konfigurasi

Objek yang sama dipakai untuk `/api/generate`, `/api/run`, dan file simpan project.

```jsonc
{
  "scenario": { "requests": [ /* request, lihat bawah */ ] },
  "load": { "mode": "simple", "vus": "10", "duration": "30s" },
  // atau: { "mode": "stages", "stages": [{ "duration": "30s", "target": "20" }] }
  "thresholds": { "p95": "500", "errorRate": "1" },   // string kosong = tidak dipakai
  "options": { "logRequests": true }                   // aktifkan event req-log
}
```

Bentuk satu request:

```jsonc
{
  "method": "GET",
  "url": "https://api.contoh.com/{{id}}",
  "headers": [{ "key": "Authorization", "value": "Bearer {{token}}" }],
  "body": "",                    // dipakai hanya untuk POST/PUT/PATCH/DELETE
  "checkStatus": true,           // tambahkan check status 2xx otomatis
  "sleepAfter": "1",             // detik jeda setelah request
  "extractions": [{ "varName": "token", "source": "json", "selector": "data.token" }],
  // source: "json" (JSON path), "header" (nama header), "regex" (grup tangkap ke-1)
  "assertions": [{ "type": "status-eq", "value": "200", "value2": "" }],
  "pre":  null,   // sub-request "Sebelum": bentuk sama, tapi tanpa assertions/pre/post
  "post": null    // sub-request "Sesudah": idem
}
```

- Interpolasi `{{varName}}` di url/header/body memakai nilai hasil ekstraksi request sebelumnya; nama yang tidak dikenal dibiarkan sebagai teks.
- Daftar tipe assertion: `ASSERT_TYPES` di `public/js/components/req-card.js` — **harus sinkron** dengan switch di `server/generator/assertions.js`.

## Konvensi

- Bahasa UI, komentar kode, dan pesan error: Indonesia.
- Nama file kebab-case; frontend tetap vanilla JS (jangan menambah framework/bundler tanpa diminta).
- Menu sidebar bertanda "Segera" adalah placeholder fitur yang belum diimplementasi.

## Verifikasi (tidak ada test otomatis)

1. `node --check` untuk semua file JS yang diubah.
2. `npm start`, lalu `curl localhost:3000/api/k6-status` dan `curl -X POST localhost:3000/api/generate` dengan konfigurasi contoh.
3. Buka UI: isi URL → "Lihat Script" → "Jalankan Test" (durasi pendek, target localhost).
