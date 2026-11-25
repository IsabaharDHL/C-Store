import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const validation = source('function normalizeWaybill', 'function parcelCard');
const makeContext = extra => vm.createContext({
  toEn: value => String(value).replace(/[٠-٩]/g, digit => '٠١٢٣٤٥٦٧٨٩'.indexOf(digit)),
  ...extra
});

test('waybill accepts numeric and alphanumeric carrier numbers with Arabic manual digits', () => {
  const ctx = makeContext();
  vm.runInContext(validation, ctx);
  for (const input of ['١٢٣٤٥٦٧٨٩٠', 'ab123456', '123-456 789']) {
    ctx.input = input;
    assert.equal(vm.runInContext('validWaybill(normalizeWaybill(input))', ctx), true);
  }
  for (const input of ['', '  ', 'SH-A1', '<script>', 'x'.repeat(101)]) {
    ctx.input = input;
    assert.equal(vm.runInContext('validWaybill(normalizeWaybill(input))', ctx), false);
  }
});

test('normal add sequence requires waybill before contents and saves it in parcel and audit', async () => {
  const writes = [], stages = [];
  const flow = {
    isCurrent: () => true, step() {}, busy() {}, result() {},
    scan: async (label, validate, receiptMode, waybillMode) => {
      stages.push(label);
      if (receiptMode) return { receipt: 'P1', year: '2026', port: '2201', raw: 'raw', docId: 'parcel' };
      const result = await validate(waybillMode ? '١٢٣٤٥٦٧٨٩٠' : 'SH-A1');
      return result.ok;
    },
    form: async () => { stages.push('contents'); return { contents: 'books', parcelCount: '2' }; }
  };
  const ctx = makeContext({
    me: { uid: 'admin', no: '1', name: 'name' }, curSec: 'dhl', db: {},
    isAll: () => false, openFlow: () => flow, esc: value => value,
    parseShelf: () => 'A1', logFields: () => ({ shift: 'day' }), uid: () => 'operation',
    doc: (...args) => args.slice(1).join('/'), serverTimestamp: () => 123,
    writeBatch: () => ({ set: (path, data) => writes.push({ path, data }), commit: async () => {} })
  });
  vm.runInContext(validation + source('async function flowAdd()', '/* ---------- تسليم طرد'), ctx);
  await vm.runInContext('flowAdd()', ctx);
  assert.deepEqual(stages, ['امسح باركود وصل الأمانة', 'امسح باركود بوليصة الشحن', 'contents', 'امسح باركود الرف']);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].data.waybill, '1234567890');
  assert.equal(writes[1].data.waybill, writes[0].data.waybill);
  writes.length = 0;
  const originalScan = flow.scan;
  flow.scan = async (...args) => args[3] ? null : originalScan(...args);
  await vm.runInContext('flowAdd()', ctx);
  assert.equal(writes.length, 0);
});

test('legacy waybill edit is admin-only and refuses changed parcel snapshots', async () => {
  const parcel = { id: 'old', receipt: 'P1', year: '2020', section: 'dhl', status: 'out', shelf: 'A1', contents: 'books' };
  const writes = [], results = [];
  let fresh = { ...parcel };
  const ctx = makeContext({
    me: { uid: 'admin', isAdmin: false }, inSec: () => true, esc: String, db: {},
    uid: () => 'operation', doc: (...args) => args.slice(1).join('/'), serverTimestamp: () => 123,
    logFields: () => ({ actorUid: 'admin' }), errMsg: e => e.message,
    openFlow: () => ({ isCurrent: () => true, busy() {},
      scan: async () => 'AB12345', form: async () => ({ reason: 'old parcel' }),
      result: (ok, msg) => results.push({ ok, msg }) }),
    runTransaction: async (_, run) => run({ get: async () => ({ exists: () => true, data: () => fresh }),
      update: (path, data) => writes.push({ path, data }), set: (path, data) => writes.push({ path, data }) }),
    parcel
  });
  vm.runInContext(validation + source('async function editParcelWaybill', '/* Each action'), ctx);
  await vm.runInContext('editParcelWaybill(parcel)', ctx);
  assert.equal(writes.length, 0);
  ctx.me.isAdmin = true;
  await vm.runInContext('editParcelWaybill(parcel)', ctx);
  assert.equal(writes[0].data.waybill, 'AB12345');
  assert.equal(writes[1].data.before.status, 'out');
  assert.equal(writes[1].data.after.contents, 'books');
  writes.length = 0;
  fresh = { ...parcel, waybill: 'concurrent' };
  await vm.runInContext('editParcelWaybill(parcel)', ctx);
  assert.equal(writes.length, 0);
  assert.equal(results.at(-1).ok, false);
});

test('all dated workbook rows include waybill text with legacy blanks', () => {
  let rows;
  const ctx = makeContext({
    parts: () => ['', '', ''], DECLARATION_LABEL: 'declaration',
    XLSX: { utils: {
      aoa_to_sheet: data => { rows = data; return Object.fromEntries(data.flatMap((row, r) => row.map((v, c) => [r + ':' + c, { v }]))); },
      encode_cell: ({ r, c }) => r + ':' + c, encode_range: JSON.stringify,
      book_new: () => ({}), book_append_sheet() {}
    }, write: () => new Uint8Array() }
  });
  vm.runInContext(source('function datedExportWorkbook', '/* ---------- قراءة محسّنة'), ctx);
  vm.runInContext("datedExportWorkbook([{status:'in',waybill:'0012345'},{status:'out'},{status:'declaration'}])", ctx);
  assert.equal(rows[0][11], 'بوليصة الشحن');
  assert.equal(rows[1][11], '0012345');
  assert.equal(rows[2][11], '');
});
