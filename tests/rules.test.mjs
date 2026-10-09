import {readFile} from 'node:fs/promises';
import {test, before, after} from 'node:test';
import {initializeTestEnvironment, assertSucceeds, assertFails} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,getDocs,collection,query,where,writeBatch,updateDoc,deleteDoc,serverTimestamp,runTransaction} from 'firebase/firestore';
let env;
const ctx = id => env.authenticatedContext(id,{email:`${id}@example.com`,firebase:{sign_in_provider:'password'}}).firestore();
const base = (id,section='dhl') => ({empNo:id,empName:id,section,shift:'صباح',shiftDate:'2026-10-08',sessionId:'test-session',actorUid:id,at:serverTimestamp()});
const parcel = (id,operationId,section='dhl',port='2201') => ({section,receipt:'A1',year:'2026',port,raw:'20262201A1',contents:'test',shelf:'A1',status:'in',addedBy:id,addedByUid:id,addedByName:id,addedShift:'صباح',addedAt:serverTimestamp(),operationId});
async function seed(path,data) {await env.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),path),data));}
async function add(id,pid,section='dhl',port='2201',log=true) {
 const db=ctx(id),op=`add-${pid}`,p=parcel(id,op,section,port),b=writeBatch(db);
 b.set(doc(db,'parcels',pid),p);
 if(log)b.set(doc(db,'logs',op),{...base(id,section),type:'add',parcelId:pid,receipt:p.receipt,year:p.year,shelf:p.shelf,contents:p.contents});
 return b.commit();
}
async function action(id,pid,type,log=true,override={}) {
 const db=ctx(id),ref=doc(db,'parcels',pid),before=(await getDoc(ref)).data(),op=`${type}-${pid}-${Date.now()}`;
 let patch={operationId:op,changedAt:serverTimestamp(),changedByUid:id,changeReason:'سبب الاختبار'};
 if(type==='move')patch.shelf='B2';
 if(type==='return')Object.assign(patch,{status:'in',shelf:'C3'});
 if(type==='delete')Object.assign(patch,{status:'deleted',deletedFromStatus:before.status,isTest:true});
 if(type==='restore')patch.status=before.deletedFromStatus;
 Object.assign(patch,override);
 const b=writeBatch(db);b.update(ref,patch);
 if(log)b.set(doc(db,'logs',op),{...base(id,before.section),type,parcelId:pid,receipt:before.receipt,year:before.year,shelf:patch.shelf||before.shelf,contents:before.contents,fromShelf:before.shelf,reason:patch.changeReason,before,after:{...before,...patch}});
 return b.commit();
}
async function deliver(id,pid,log=true) {
 const db=ctx(id),p=(await getDoc(doc(db,'parcels',pid))).data(),op=`deliver-${pid}`,b=writeBatch(db);
 const fields={status:'out',operationId:op,deliveredTo:'recipient',deliveryRef:'ref',deliveredBy:id,deliveredByUid:id,deliveredByName:id,deliveredShift:'صباح',deliveredAt:serverTimestamp()};
 b.update(doc(db,'parcels',pid),fields);
 if(log)b.set(doc(db,'logs',op),{...base(id,p.section),type:'deliver',parcelId:pid,receipt:p.receipt,year:p.year,shelf:p.shelf,contents:p.contents,deliveredTo:fields.deliveredTo,deliveryRef:fields.deliveryRef});
 return b.commit();
}
before(async()=>{
 env=await initializeTestEnvironment({projectId:'demo-cstore',firestore:{rules:await readFile('firestore.rules','utf8')}});
 await env.clearFirestore();
 for(const [id,section,admin] of [['worker','dhl',false],['admin','dhl',true],['other','other',true]]) {
  await seed(`employees/${id}`,{name:id,section,isAdmin:admin,isSuper:false});
  await seed(`employeeAccess/${id}`,{generation:1,uid:id,active:true,role:'employee',section});
  await seed(`uidBindings/${id}`,{employeeId:id,generation:1});
 }
 await seed('sections/dhl',{name:'DHL',ports:['2201']});await seed('sections/other',{name:'other',ports:['3301']});
});
after(async()=>env?.cleanup());
test('employee create + log persist and server reread',async()=>{await assertSucceeds(add('worker','ok')); await assertSucceeds(getDoc(doc(ctx('worker'),'parcels','ok')));});
test('create without audit denied and no parcel saved',async()=>{await assertFails(add('worker','noaudit','dhl','2201',false));const s=await getDoc(doc(ctx('worker'),'parcels','noaudit'));if(s.exists())throw Error('partial write');});
test('cross section write and wrong port denied',async()=>{await assertFails(add('worker','foreign','other','3301'));await assertFails(add('worker','wrongport','dhl','3301'));});
test('cross section read and unscoped query denied',async()=>{await add('other','foreign-ok','other','3301');await assertFails(getDoc(doc(ctx('worker'),'parcels','foreign-ok')));await assertFails(getDocs(collection(ctx('worker'),'parcels')));await assertSucceeds(getDocs(query(collection(ctx('worker'),'parcels'),where('section','==','dhl'))));});
test('unauthenticated read/write denied',async()=>{let db=env.unauthenticatedContext().firestore();await assertFails(getDoc(doc(db,'parcels','ok')));await assertFails(setDoc(doc(db,'parcels','anon'),{}));});
test('worker move with audit succeeds',async()=>{await add('worker','move');await assertSucceeds(action('worker','move','move'));});
test('move without audit or with tampered contents denied',async()=>{await add('worker','move-deny');await assertFails(action('worker','move-deny','move',false));await assertFails(action('worker','move-deny','move',true,{contents:'tampered'}));});
test('deliver atomic log mandatory + double delivery denied',async()=>{await add('worker','deliver');await assertFails(deliver('worker','deliver',false));await assertSucceeds(deliver('worker','deliver'));await assertFails(deliver('worker','deliver'));});
test('return admin only with required reason and new shelf',async()=>{await add('worker','return');await deliver('worker','return');await assertFails(action('worker','return','return'));await assertFails(action('admin','return','return',true,{changeReason:''}));await assertSucceeds(action('admin','return','return'));});
test('individual soft delete admin only and restore full record',async()=>{await add('worker','delete');await assertFails(action('worker','delete','delete'));await assertSucceeds(action('admin','delete','delete'));await assertFails(action('worker','delete','restore'));await assertSucceeds(action('admin','delete','restore'));let p=(await getDoc(doc(ctx('admin'),'parcels','delete'))).data();if(p.status!=='in'||p.contents!=='test')throw Error('restore mismatch');});
test('hard delete and audit rewrite denied for admin',async()=>{await assertFails(deleteDoc(doc(ctx('admin'),'parcels','ok')));await assertFails(updateDoc(doc(ctx('admin'),'logs','add-ok'),{contents:'tampered'}));});
test('worker cannot elevate profile or transfer own section',async()=>{await assertFails(updateDoc(doc(ctx('worker'),'employees','worker'),{isAdmin:true}));await assertFails(updateDoc(doc(ctx('worker'),'employeeAccess','worker'),{section:'other'}));});
test('admin cannot manage other outlet employees',async()=>{await assertFails(getDoc(doc(ctx('admin'),'employees','other')));await assertFails(updateDoc(doc(ctx('admin'),'employees','other'),{name:'hijack'}));});
test('employee provisioning saved atomically, visible after reload',async()=>{
 let db=ctx('admin'),b=writeBatch(db),id='12345';
 b.set(doc(db,'loginRoutes',id),{generation:1,state:'pending',enabled:true,alias:'a'.repeat(32)+'@employees.invalid'});
 b.set(doc(db,'employeeAccess',id),{generation:1,uid:'',active:true,role:'employee',section:'dhl'});
 b.set(doc(db,'employees',id),{name:'new',isAdmin:false,isSuper:false,section:'dhl',createdAt:serverTimestamp(),createdBy:'admin'});
 await assertSucceeds(b.commit()); await assertSucceeds(getDoc(doc(ctx('admin'),'employees',id)));
});
test('profile alone cannot be provisioned and client owner bootstrap denied',async()=>{await assertFails(setDoc(doc(ctx('admin'),'employees','67890'),{name:'new',isAdmin:false,isSuper:false,section:'dhl',createdAt:serverTimestamp(),createdBy:'admin'}));await assertFails(setDoc(doc(ctx('worker'),'administrators','worker'),{active:true}));});
test('disabled employee loses parcel access',async()=>{await seed('employeeAccess/disabled',{generation:1,uid:'disabled',active:false,role:'employee',section:'dhl'});await seed('uidBindings/disabled',{employeeId:'disabled',generation:1});await assertFails(getDoc(doc(ctx('disabled'),'parcels','ok')));});
test('admin cannot return to same shelf or restore without audit',async()=>{await add('worker','return-same');await deliver('worker','return-same');await assertFails(action('admin','return-same','return',true,{shelf:'A1'}));await action('admin','return-same','delete');await assertFails(action('admin','return-same','restore',false));await assertSucceeds(action('admin','return-same','restore'));const p=(await getDoc(doc(ctx('admin'),'parcels','return-same'))).data();if(p.status!=='out'||p.deliveredTo!=='recipient')throw Error('delivery lost');});
test('concurrent deliveries: exactly one commit, one delivery log',async()=>{await add('worker','race');const result=await Promise.allSettled([deliver('worker','race'),deliver('worker','race')]);if(result.filter(x=>x.status==='fulfilled').length!==1)throw Error('double delivery');});
test('audit stores previous delivery and actor after return',async()=>{const db=ctx('admin');const logs=await getDocs(query(collection(db,'logs'),where('parcelId','==','return'),where('section','==','dhl')));const l=logs.docs.map(d=>d.data()).find(d=>d.type==='return');if(l.before.deliveredTo!=='recipient'||l.before.status!=='out'||l.after.status!=='in'||l.actorUid!=='admin')throw Error('audit incomplete');});
test('cross section admin cannot move, delete or return foreign parcel',async()=>{await assertFails(action('other','ok','move'));await assertFails(action('other','ok','delete'));});

test('parcel count saves and survives move/delivery; invalid counts rejected',async()=>{for(const count of [3,0,-1,1.5,'3',10001]){const db=ctx('worker'),id='count-'+String(count),op='add-'+id,p={...parcel('worker',op),parcelCount:count},b=writeBatch(db);b.set(doc(db,'parcels',id),p);b.set(doc(db,'logs',op),{...base('worker'),type:'add',parcelId:id,receipt:p.receipt,year:p.year,shelf:p.shelf,contents:p.contents,parcelCount:count});if(count===3){await assertSucceeds(b.commit());await action('worker',id,'move');const saved=(await getDoc(doc(db,'parcels',id))).data();if(saved.parcelCount!==3)throw Error('count lost');}else await assertFails(b.commit());}});
