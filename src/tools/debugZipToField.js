require('dotenv').config();
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const axios = require('axios');
const unzipper = require('unzipper');

const bitrix = require('../services/bitrix/bitrixClient');

const ENTITY = 1048;
const ITEM = Number(process.argv[2] || 0);
if (!ITEM) { console.error('Usage: node src/tools/debugZipToField.js <ITEM_ID>'); process.exit(2); }

const F_CAMEL = 'ufCrm8_1768219060503';
const F_ORIG  = 'UF_CRM_8_1768219060503';

function itemOf(r){ return r.item || r.result?.item || r.result || r; }

function isZip(buf){
  return buf && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
function isPdf(buf){
  return buf && buf.length >= 5 && buf.slice(0,5).toString('ascii') === '%PDF-';
}

async function download(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', maxBodyLength: Infinity });
  const buf = Buffer.from(resp.data);
  return { buf, headers: resp.headers || {} };
}

(async () => {
  const got = await bitrix.call('crm.item.get', { entityTypeId: ENTITY, id: ITEM, select: ['*'] });
  const it = itemOf(got);
  const cur = Array.isArray(it[F_CAMEL]) ? it[F_CAMEL] : (it[F_CAMEL] ? [it[F_CAMEL]] : []);

  if (!cur.length) { console.log('No files in field'); return; }

  const last = cur[cur.length - 1];
  if (!last.urlMachine) { console.log('No urlMachine on last file:', last); return; }

  console.log('Last file id:', last.id);
  const { buf } = await download(last.urlMachine);
  console.log('Downloaded bytes:', buf.length);
  console.log('Magic:', buf.slice(0,8).toString('hex'));

  if (!isZip(buf)) {
    console.log('Not a ZIP. (Maybe you selected wrong file)');
    if (isPdf(buf)) console.log('Looks like PDF.');
    return;
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zipdbg-'));
  const zipPath = path.join(tmpDir, 'in.zip');
  await fsp.writeFile(zipPath, buf);

  const dir = await unzipper.Open.file(zipPath);
  const pdfEntries = dir.files.filter(f => !f.path.endsWith('/') && f.path.toLowerCase().endsWith('.pdf'));

  console.log('ZIP entries:', dir.files.length, 'PDF:', pdfEntries.length);
  if (!pdfEntries.length) return;

  // Собираем новые файлы как ["name.pdf", "base64"]
  const newFiles = [];
  for (const e of pdfEntries) {
    const outName = path.basename(e.path) || 'file.pdf';
    const content = await e.buffer();
    if (!isPdf(content)) {
      // бывает, что расширение .pdf, но контент не PDF
      console.log('Skip non-PDF content:', e.path);
      continue;
    }
    newFiles.push([outName, content.toString('base64')]);
  }

  if (!newFiles.length) { console.log('No valid PDFs to upload'); return; }

  // Сохраняем старые id + добавляем новые файлы
  const keepIds = cur.map(x => x.id).filter(Boolean);
  const value = [...keepIds, ...newFiles];

  await bitrix.call('crm.item.update', {
    entityTypeId: ENTITY,
    id: ITEM,
    fields: { [F_ORIG]: value },
    useOriginalUfNames: 'Y',
  });

  const chk = await bitrix.call('crm.item.get', { entityTypeId: ENTITY, id: ITEM, select: ['*'] });
  const after = itemOf(chk);
  const v = after[F_CAMEL] || [];
  console.log('AFTER len:', v.length);
  console.log('AFTER ids:', v.map(x => x.id));
})();
