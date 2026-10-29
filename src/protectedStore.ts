import {useEffect,useState} from 'react';
import {getOwner} from './accountStorage';
export interface Attempt{owner:string;op_id:string;entity:string;id:string;op:'upsert'|'delete';data?:any;base_version:number}
export interface PastGuard{key:string;type:string;cat:string;matches:{id:string;version:number}[]}
export interface Pending{action?:PastGuard&{action_id:string};key:string;ops:Attempt[];result?:any;state:'pending'|'uncertain'|'confirmed'|'rejected'|'archived'}
const signal=()=>window.dispatchEvent(new Event('dindin-store'));
const prefix=()=> 'mf.protected.'+encodeURIComponent(getOwner())+'.';
const stable=(v:any):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export function snapshot(){return JSON.parse(localStorage.getItem(prefix()+'confirmed')||'{"records":{},"versions":{}}')}
export function attempts():Pending[]{return Object.keys(localStorage).filter(k=>k.startsWith(prefix()+'attempt.')).map(k=>({...JSON.parse(localStorage.getItem(k)!),key:k}));}
export function updateAttempt(key:string,patch:Partial<Pending>){const old=JSON.parse(localStorage.getItem(key)||'null');if(!old)return;if(['confirmed','rejected','archived'].includes(old.state)&&patch.state&&patch.state!==old.state&&patch.state!=='archived')return;localStorage.setItem(key,JSON.stringify({...old,...patch}));signal()}
export function installConfirmed(body:any,owner:string){if(owner!==getOwner()||body.username!==owner)throw Error('Conta mudou.');const raw=JSON.stringify(body);localStorage.setItem(prefix()+'confirmed',raw);if(localStorage.getItem(prefix()+'confirmed')!==raw)throw Error('Não foi possível guardar os confirmados.');signal()}
function collection(entity:string){return snapshot().records[entity]||[]}
const idOf=(entity:string,v:any)=>String(entity==='catrule'?v.key:v.id);
const editBases=new Map<string,number>();let editContext:Record<string,number>|null=null;let editOwner='';
export function beginEdit(entity:string,id:string){if(editOwner!==getOwner())endEdit();editOwner=getOwner();if(!editContext)editContext={...snapshot().versions};editBases.set(entity+':'+id,snapshot().versions[entity+':'+id]||0)}
export function endEdit(){editBases.clear();editContext=null;editOwner=''}
let staging:Attempt[]|null=null;
export function atomicSave(fn:()=>boolean,guard?:PastGuard):boolean{staging=[];try{if(!fn())return false;const ops=staging.sort((a,b)=>(a.entity==='cat'?(a.op==='delete'?2:0):1)-(b.entity==='cat'?(b.op==='delete'?2:0):1));if(!ops.length)return true;const key=prefix()+'attempt.'+crypto.randomUUID(),raw=JSON.stringify({ops,state:'pending',...(guard?{action:{...guard,action_id:crypto.randomUUID()}}:{})});localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw Error('Gravação não conferida.');signal();window.dispatchEvent(new Event('dindin-send'));return true}catch(e){window.dispatchEvent(new CustomEvent('dindin-error',{detail:'Não foi possível guardar a ação completa no aparelho.'}));return false}finally{staging=null}}
export function saveCollection(entity:string,items:any[],previous:any[]):boolean{
 try{const owner=getOwner();if(editOwner&&editOwner!==owner)endEdit();if(!owner)throw Error('Conta não conferida.');const snap=snapshot(),ops:Attempt[]=[];const old=new Map(previous.map(x=>[idOf(entity,x),x])),now=new Map(items.map(x=>[idOf(entity,x),x]));
 for(const [id,data]of now)if(stable(old.get(id))!==stable(data))ops.push({owner,op_id:crypto.randomUUID(),entity,id,op:'upsert',data,base_version:editBases.get(entity+':'+id)??(editContext?(editContext[entity+':'+id]||0):(snap.versions[entity+':'+id]||0))});
 for(const [id]of old)if(!now.has(id))ops.push({owner,op_id:crypto.randomUUID(),entity,id,op:'delete',base_version:editBases.get(entity+':'+id)??(editContext?(editContext[entity+':'+id]||0):(snap.versions[entity+':'+id]||0))});
 if(!ops.length)return true;
 const active=attempts().filter(x=>!['confirmed','archived'].includes(x.state));
 for(const o of ops)if(active.some(a=>a.ops.some(x=>x.entity===o.entity&&x.id===o.id)))throw Error('Há uma tentativa deste item aguardando conferência. Veja Pendências.');
 // Materialize only a default category actually needed, before its dependent.
 for(const o of [...ops])if(o.entity!=='cat'&&o.data?.cat&&!collection('cat').some((c:any)=>c.id===o.data.cat)&&!active.some(a=>a.ops.some(x=>x.entity==='cat'&&x.id===o.data.cat))){const c=defaults.find(c=>c.id===o.data.cat);if(c)ops.unshift({owner,op_id:crypto.randomUUID(),entity:'cat',id:c.id,op:'upsert',data:c,base_version:snap.versions['cat:'+c.id]||0})}
 if(staging){for(const op of ops){if(!staging.some(x=>x.entity===op.entity&&x.id===op.id))staging.push(op)}return true;}
 const key=prefix()+'attempt.'+crypto.randomUUID(),raw=JSON.stringify({ops,state:'pending'});localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw Error('Gravação local não conferida.');signal();window.dispatchEvent(new Event('dindin-send'));return true;
 }catch(e){window.dispatchEvent(new CustomEvent('dindin-error',{detail:e instanceof Error?e.message:'Não foi possível salvar no aparelho.'}));return false}
}
let defaults:any[]=[];export function setDefaults(c:any[]){defaults=c}
export function useProtectedCollection<T>(entity:string):[T[],(v:T[])=>boolean,{ready:boolean;message:string;failed:boolean;salvage:boolean}]{const [arr,setArr]=useState<T[]>(()=>collection(entity));useEffect(()=>{const f=()=>setArr(collection(entity));window.addEventListener('dindin-store',f);window.addEventListener('storage',f);return()=>{window.removeEventListener('dindin-store',f);window.removeEventListener('storage',f)}},[entity]);return [arr,v=>saveCollection(entity,v,arr),{ready:true,message:'Totais mostram apenas dados confirmados. Tentativas locais ficam em Pendências.',failed:false,salvage:false}]}
export function useAttempts(){const [rows,setRows]=useState(attempts);useEffect(()=>{const f=()=>setRows(attempts());window.addEventListener('dindin-store',f);window.addEventListener('storage',f);return()=>{window.removeEventListener('dindin-store',f);window.removeEventListener('storage',f)}},[]);return rows}
