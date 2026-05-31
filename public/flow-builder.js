import { $, $$ } from './utils.js';
import { reqCard } from './req-card.js';

export function stageRow(dur = '30s', tgt = '20') {
  const row = document.createElement('div');
  row.className = 'stage-row';
  row.innerHTML = `
    <span class="lbl">Selama</span>
    <input class="stage-dur" placeholder="mis. 30s" />
    <span class="lbl">naik ke</span>
    <input class="stage-target" type="number" min="0" placeholder="VUs" />
    <button class="btn-remove-sm">&times;</button>`;
  row.querySelector('.stage-dur').value    = dur;
  row.querySelector('.stage-target').value = tgt;
  row.querySelector('.btn-remove-sm').addEventListener('click', () => row.remove());
  return row;
}

export function buildFlowView() {
  const view = $('#view-flow');
  view.appendChild(buildZone('main', 'Skenario Utama', 'Diulang tiap VU', 'badge-loop',
    'Dijalankan berulang oleh setiap virtual user. Tiap request bisa punya sub-request opsional <em>Sebelum</em> dan <em>Sesudah</em>.', false));
}

function buildZone(ctx, title, badgeText, badgeClass, descHTML, toggleable) {
  const zone = document.createElement('div');
  zone.className = `flow-zone zone-${ctx}`;
  zone.id = `zone-${ctx}`;

  const zHead = document.createElement('div');
  zHead.className = 'zone-header';

  const tGroup = document.createElement('div');
  tGroup.className = 'zone-title-group';
  tGroup.innerHTML = `<span class="zone-title">${title}</span>
    <span class="zone-badge ${badgeClass}">${badgeText}</span>`;

  if (toggleable) {
    const lbl = document.createElement('label');
    lbl.className = 'zone-toggle';
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.id = `${ctx}-enabled`;
    lbl.append(chk, document.createTextNode(' Aktifkan'));
    zHead.append(tGroup, lbl);
  } else {
    zHead.appendChild(tGroup);
  }

  const zDesc = document.createElement('div');
  zDesc.className = 'zone-desc'; zDesc.innerHTML = descHTML;

  const zBody = document.createElement('div');
  zBody.className = `zone-body${toggleable ? ' hidden' : ''}`;
  zBody.id = `zone-body-${ctx}`;

  const reqCont = document.createElement('div');
  reqCont.id = `reqs-${ctx}`;

  const addBtn = document.createElement('button');
  addBtn.className = 'add-req-btn'; addBtn.textContent = '+ Tambah Request';
  addBtn.addEventListener('click', () =>
    reqCont.appendChild(reqCard(reqCont.children.length, ctx)));

  zBody.append(reqCont, addBtn);
  zone.append(zHead, zDesc, zBody);

  if (toggleable) {
    const chk = zone.querySelector(`#${ctx}-enabled`);
    chk.addEventListener('change', () => zBody.classList.toggle('hidden', !chk.checked));
  }

  return zone;
}
