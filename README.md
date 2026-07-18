# K6UI

UI sederhana untuk membuat dan menjalankan load test [k6](https://k6.io) **tanpa menulis kode**. Cukup isi form, klik jalankan, dan lihat hasilnya — cocok untuk yang belum familiar dengan scripting k6.

## Fitur

- **Alur request** — satu atau banyak request berurutan (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS) dengan headers dan body; tiap request bisa punya sub-request opsional *Sebelum* dan *Sesudah*.
- **Ekstraksi & variabel** — ambil nilai dari respons (JSON path, header, atau regex), lalu pakai di request berikutnya dengan `{{nama_variabel}}` di URL, header, atau body (mis. token login).
- **Assertions per request** — validasi status code, isi body, header, atau waktu respons.
- **Profil beban** — VU tetap + durasi, atau bertahap (ramp up/down lewat stages).
- **Threshold / SLA** — target p95 dan error rate maksimum; jika tidak terpenuhi, k6 keluar dengan exit code ≠ 0 (berguna untuk CI/CD).
- **Generate script** — lihat & salin script k6 hasil generate, bisa dijalankan sendiri di luar UI.
- **Jalankan & monitor** — k6 dijalankan di server; log tampil live, ada tabel detail per request (filter error/URL), dan ringkasan metrik otomatis.
- **Simpan / buka project** — konfigurasi disimpan sebagai file JSON dan bisa dimuat kembali.

## Prasyarat

- [Node.js](https://nodejs.org) 18+
- [k6](https://k6.io/docs/get-started/installation/) terpasang di server — diperlukan untuk menjalankan test; generate script tetap bisa tanpanya.

## Cara pakai

```bash
npm install
npm start
```

Buka http://localhost:3000 di browser.

1. Isi URL dan detail request di **Alur Request** (tambah request, ekstraksi, atau assertion bila perlu).
2. Atur jumlah virtual users dan durasi di **Profil Beban** (atau pakai stages untuk ramp up/down).
3. (Opsional) tentukan target p95 dan error rate di **Threshold / SLA**.
4. Klik **Lihat Script** untuk preview, atau **Jalankan Test** untuk eksekusi langsung.

Untuk pengembangan: `npm run dev` (server auto-restart saat file berubah).

## Struktur project

```
server/                 Backend Express
├── index.js            Titik masuk server
├── routes.js           Endpoint API
├── k6-runner.js        Menjalankan proses k6 + streaming output
└── generator/          Mengubah konfigurasi UI menjadi script k6

public/                 Frontend (vanilla JS, tanpa build step)
├── index.html          Markup seluruh view
├── css/style.css       Styling
└── js/                 Modul per fitur + components/ untuk pembangun DOM
```

Penjelasan arsitektur, skema konfigurasi, dan detail API ada di [CLAUDE.md](CLAUDE.md).

## Cara kerja singkat

1. Frontend membaca isi form menjadi satu objek konfigurasi JSON.
2. Server men-generate script k6 dari konfigurasi tersebut (`POST /api/generate`).
3. Saat dijalankan (`POST /api/run`), server menulis script ke folder sementara, menjalankan `k6 run`, dan mengalirkan output live ke browser via Server-Sent Events; folder sementara dihapus setelah selesai.
4. Exit code k6 menentukan apakah threshold/SLA terpenuhi (0 = lulus, 99 = threshold gagal).

## API

| Endpoint | Fungsi |
|---|---|
| `GET /api/k6-status` | Cek apakah binary k6 tersedia |
| `POST /api/generate` | Generate script k6 dari konfigurasi |
| `POST /api/run` | Jalankan test, hasil di-stream via SSE |
