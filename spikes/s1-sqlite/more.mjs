import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync, spawn } from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s1m-')); const out={node:process.version};
// trigram semantics
const db=new DatabaseSync(path.join(dir,'f.db'));
db.exec("create virtual table t using fts5(body, tokenize='trigram')");
db.prepare("insert into t values(?)").run('決策紀錄與版本控制 Palimvo decision log');
const q=s=>{try{return db.prepare("select count(*) c from t where t match ?").get(s).c}catch(e){return 'ERR '+e.message}};
out.trigram={ 'CJK3 決策紀':q('"決策紀"'), 'CJK2 決策':q('"決策"'), 'latin3 dec':q('"dec"'), 'latin2 de':q('"de"'), 'LIKE CJK2':db.prepare("select count(*) c from t where body like '%決策%'").get().c };
// kill -9 durability: child writes in loop, parent kills
const f=path.join(dir,'k.db'); const d=new DatabaseSync(f); d.exec('pragma journal_mode=wal;create table k(i integer primary key, v text)'); d.close();
const child=spawn(process.execPath,['-e',`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(f)});d.exec('pragma busy_timeout=5000;pragma synchronous=normal');let i=0;for(;;){d.exec('begin');d.prepare('insert into k(v) values(?)').run('x'.repeat(500));d.prepare('insert into k(v) values(?)').run('y');d.exec('commit');if(++i%100==0)process.stdout.write('.')}`],{stdio:['ignore','pipe','inherit']});
await new Promise(r=>child.stdout.once('data',r)); await new Promise(r=>setTimeout(r,300)); child.kill('SIGKILL'); await new Promise(r=>child.on('exit',r));
const c=new DatabaseSync(f); out.kill9={rows:c.prepare('select count(*) c from k').get().c, even:c.prepare('select count(*)%2=0 e from k').get().e===1, integrity:c.prepare('pragma integrity_check').get().integrity_check}; c.close();
// online backup while writing
const src=new DatabaseSync(path.join(dir,'s.db')); src.exec('pragma journal_mode=wal;create table r(i integer primary key, v text)');
const ins=src.prepare('insert into r(v) values(?)'); for(let i=0;i<50000;i++) ins.run('z'.repeat(200));
let writes=0, stop=false; const wl=(async()=>{while(!stop){src.exec('begin');ins.run('w');src.exec('commit');writes++; if(writes%50==0) await new Promise(r=>setImmediate(r));}})();
const t=performance.now(); const pages=await backup(src,path.join(dir,'bk.db'),{rate:100}); const ms=performance.now()-t; stop=true; await wl;
const b=new DatabaseSync(path.join(dir,'bk.db')); out.backup={pages,ms:Math.round(ms),writesDuringBackup:writes,backupRows:b.prepare('select count(*) c from r').get().c,integrity:b.prepare('pragma integrity_check').get().integrity_check,sizeMB:+(fs.statSync(path.join(dir,'bk.db')).size/1e6).toFixed(1)};
// second process opening same db while first holds write tx: busy behaviour
const a=new DatabaseSync(path.join(dir,'s.db')); a.exec('begin immediate');
const r2=spawnSync(process.execPath,['-e',`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(path.join(dir,'s.db'))},{timeout:200});try{d.exec('begin immediate');console.log('got')}catch(e){console.log(e.code,e.errcode,e.message)}`],{encoding:'utf8'});
out.busyOtherProcess=r2.stdout.trim(); a.exec('rollback');
// stability index / warnings
const w=spawnSync(process.execPath,['-e',"require('node:sqlite')"],{encoding:'utf8'}); out.requireWarning=w.stderr.trim()||'(none)';
out.hasTimeoutOption=(()=>{try{new DatabaseSync(':memory:',{timeout:100});return true}catch(e){return e.message}})();
out.strictNamedParams=(()=>{try{const x=new DatabaseSync(':memory:');x.exec('create table a(x)');x.prepare('insert into a values($x)').run({x:1});return 'bare-names ok'}catch(e){return e.message}})();
console.log(JSON.stringify(out,null,1));
