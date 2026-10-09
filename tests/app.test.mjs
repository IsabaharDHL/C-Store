import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to,html.indexOf(from)));
const parseCode=source('function parseReceipt','let actx;');
const parser=vm.createContext({toEn:s=>String(s).replace(/[٠-٩]/g,c=>'٠١٢٣٤٥٦٧٨٩'.indexOf(c))});vm.runInContext(parseCode,parser);
test('Arabic manual receipt and short shelf input',()=>{assert.equal(vm.runInContext("parseReceipt('٢٠٢٦٢٢٠١A١').receipt",parser),'A1');assert.equal(vm.runInContext("parseShelf('SH-a١')",parser),'A1');assert.equal(vm.runInContext("parseReceipt('A1')",parser),null);assert.equal(vm.runInContext("parseShelf('SH-A0')",parser),null);});
const stamp=d=>({toDate:()=>new Date(d),toMillis:()=>+new Date(d)});
const sample=[{year:'2026',receipt:'A10',status:'in',contents:'test',addedByName:'Ali',addedAt:stamp('2026-10-08T08:00Z')},{year:'2025',receipt:'A2',status:'out',contents:'test2',addedByName:'Isa',addedAt:stamp('2026-10-07T08:00Z'),deliveredAt:stamp('2026-10-08T08:00Z'),deliveredTo:'R',deliveryRef:'D',deliveredByName:'B'},{year:'2026',receipt:'A2',status:'in',contents:'test3',addedAt:stamp('2026-10-08T08:00Z')}];
async function workbook(code,kind,admin=true,records=sample){
 let saved,reads=0;
 const cell=({r,c})=>`${r}:${c}`;
 const context=vm.createContext({sessionEpoch:1,me:{isAdmin:admin,isSuper:false},curSec:'dhl',parcels:records,db:{},currentView:()=>()=>true,fail:e=>{throw e},query:(...x)=>x,collection:()=>{},where:()=>{},getDocsFromServer:async()=>{reads++;return {docs:records.map((p,i)=>({id:String(i),data:()=>p}))}},
 XLSX:{utils:{aoa_to_sheet:rows=>Object.fromEntries(rows.flatMap((row,r)=>row.map((v,c)=>[cell({r,c}),{v}]))),encode_range:JSON.stringify,encode_cell:cell,book_new:()=>({}),book_append_sheet:(wb,ws,name)=>{wb.sheet=ws;wb.name=name}},write:wb=>{saved=wb;return new Uint8Array()}},
 toast:()=>{},ymd:d=>d.toISOString().slice(0,10),shiftDay:d=>d||new Date(),shiftOf:()=> 'صباح',pad2:v=>String(v).padStart(2,'0'),secName:()=> 'DHL',Blob,File:class{},navigator:{},document:{createElement:()=>({click(){},remove(){}}),body:{appendChild(){}}},URL:{createObjectURL:()=>'',revokeObjectURL(){}},setTimeout:()=>{}});
 vm.runInContext(code,context);await vm.runInContext(`exportExcel('2026-10-01','2026-10-08',${JSON.stringify(kind)})`,context);
 return {saved:JSON.parse(JSON.stringify(saved??null)),reads};
}
const newExport=source('function receiptKey','/* ---------- قراءة محسّنة');
test('full export exact legacy workbook styles, columns, year and receipt order',async()=>{const baseline=readFileSync(new URL('./fixtures/legacy-export.js.txt',import.meta.url),'utf8');const old=await workbook(baseline,'all'),updated=await workbook(newExport,'all');assert.deepEqual(updated.saved,old.saved);assert.equal(updated.reads,1);});
test('three export choices filter and exclude deleted records',async()=>{const records=[...sample,{...sample[0],status:'deleted'}];const a=await workbook(newExport,'in',true,records),b=await workbook(newExport,'out',true,records);assert.equal(a.saved.sheet['!rows'].length,3);assert.equal(b.saved.sheet['!rows'].length,2);});
test('export forbidden to employee before data fetch',async()=>{assert.deepEqual(await workbook(newExport,'all',false),{saved:null,reads:0});});
test('camera failure preserves manual input controls',()=>{const c=source('        } catch (e) {\n          if (!isCurrent()) return;\n          const rd', '    form(fields');assert.ok(c.includes("querySelector('#manBtn')?.click()"));assert.ok(!c.includes('body.innerHTML ='));});
test('inventory pages have no export button',()=>{const c=source('function renderList','function renderExport');assert.ok(!c.includes('exportExcel'));assert.ok(!c.includes('id="xls"'));});

test('manual receipt uses separate year and receipt and the section port',()=>{const c=vm.createContext({});vm.runInContext(source('const toEn =','/* أي رقم'),c);vm.runInContext(source('function manualReceipt','/* باركود الرف'),c);assert.equal(vm.runInContext("manualReceipt('٢٠٢٥','p١٧',['2201'])",c),'020252201P17');for(const exp of ["manualReceipt('25','P17',['2201'])","manualReceipt('2025','17',['2201'])","manualReceipt('2025','P17',[])","manualReceipt('2025','P17',['2201','2202'])"])assert.throws(()=>vm.runInContext(exp,c));});
