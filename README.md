# K6UI

UI sederhana untuk membuat dan menjalankan load test [k6](https://k6.io) **tanpa menulis kode**. Cocok untuk orang awam: cukup isi form, klik jalankan, dan lihat hasilnya.

## Fitur

- **Skenario request** — satu atau banyak request berurutan (GET/POST/PUT/PATCH/DELETE), dengan headers dan body.
- **Profil beban** — mode sederhana (VUs tetap + durasi) atau bertahap (ramp up/down lewat stages).
- **Target/SLA** — set threshold seperti respons p95 maksimum dan error rate maksimum.
- **Generate script** — lihat & salin script k6 yang dihasilkan.
- **Jalankan langsung** — k6 dijalankan di server, log tampil live, ringkasan metrik ditampilkan otomatis.

## Prasyarat

- [Node.js](https://nodejs.org) 18+
- [k6](https://k6.io/docs/get-started/installation/) terpasang di server (diperlukan untuk menjalankan test; tetap bisa generate script tanpanya).

## Cara pakai

```bash
npm install
npm start
```

Buka http://localhost:3000 di browser.

1. Isi URL dan detail request (tambah request lain bila perlu).
2. Atur jumlah virtual users dan durasi (atau pakai stages untuk ramp up/down).
3. (Opsional) tentukan target p95 dan error rate.
4. Klik **Lihat Script** untuk preview, atau **Jalankan Test** untuk eksekusi langsung.

## Catatan

- Server menjalankan `k6 run` pada script sementara dan menghapusnya setelah selesai.
- Status keluar (exit code) k6 menentukan apakah threshold/SLA terpenuhi.
