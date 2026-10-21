import { DatabaseSync } from 'node:sqlite';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
const SCHEMA = `create table if not exists sessions(id text primary key, account_id integer, created_at integer, last_seen integer, data text) without rowid;
create index if not exists sess_acc on sessions(account_id);`;
function open(file){ const db=new DatabaseSync(file); db.exec('pragma busy_timeout=5000; pragma journal_mode=wal; pragma synchronous=normal; pragma foreign_keys=on'); return db; }
if (!isMainThread) {
  const { file, n, id } = workerData; const db = open(file);
  const ins = db.prepare('insert into sessions values(?,?,?,?,?)'); const upd = db.prepare('update sessions set last_seen=? where id=?');
  const lat=[]; let busy=0, err=0;
  for (let i=0;i<n;i++){ const sid=crypto.randomUUID(); const t=performance.now();
    try { db.exec('begin immediate'); ins.run(sid,id,Date.now(),Date.now(),'{"ua":"x"}'); upd.run(Date.now(),sid); db.exec('commit'); }
    catch(e){ err++; if(/busy|locked/i.test(e.message)) busy++; try{db.exec('rollback')}catch{} }
    lat.push(performance.now()-t); }
  db.close(); parentPort.postMessage({lat,busy,err});
} else {
  const W=+process.argv[2]||50, N=+process.argv[3]||200;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s1b-')); const file=path.join(dir,'b.db');
  const db=open(file); db.exec(SCHEMA); db.close();
  const t0=performance.now();
  const res=await Promise.all(Array.from({length:W},(_,id)=>new Promise((ok,ko)=>{const w=new Worker(new URL(import.meta.url),{workerData:{file,n:N,id}});w.on('message',ok);w.on('error',ko);})));
  const dt=performance.now()-t0; const lat=res.flatMap(r=>r.lat).sort((a,b)=>a-b); const q=p=>lat[Math.floor(p*(lat.length-1))].toFixed(2);
  const check=open(file); const rows=check.prepare('select count(*) c from sessions').get().c; const ic=check.prepare('pragma integrity_check').get();
  console.log(JSON.stringify({node:process.version,os:process.platform,workers:W,perWorker:N,rows,expected:W*N,busyErrors:res.reduce((a,r)=>a+r.busy,0),otherErrors:res.reduce((a,r)=>a+r.err,0),txPerSec:Math.round(W*N/(dt/1000)),p50ms:q(.5),p95ms:q(.95),p99ms:q(.99),maxms:q(1),integrity:ic.integrity_check}));
}
