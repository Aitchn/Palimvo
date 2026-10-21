import { DatabaseSync, backup, constants } from 'node:sqlite';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'s1-'));
const r = {node: process.version, platform: process.platform};
const db = new DatabaseSync(path.join(dir,'a.db'));
r.sqlite_version = db.prepare('select sqlite_version() v').get().v;
r.wal = db.prepare('pragma journal_mode=wal').get();
r.compile = db.prepare('pragma compile_options').all().map(x=>x.compile_options).filter(x=>/FTS|THREADSAFE|JSON|MATH|DBSTAT|SOUNDEX/i.test(x));
try { db.exec("create virtual table t using fts5(body, tokenize='trigram')");
  db.exec("insert into t values('hello 世界 palimvo notes'),('另一篇筆記')");
  r.fts5_trigram = db.prepare("select count(*) c from t where t match 'palim'").get().c;
  r.fts5_trigram_cjk = db.prepare("select count(*) c from t where t match '筆記'").get().c;
  db.exec("create virtual table u using fts5(body)"); r.fts5=true;
} catch(e){ r.fts5_err = e.message; }
try { db.exec('begin'); db.exec('create table x(a)'); db.exec('insert into x values(1)'); db.exec('rollback'); r.rollback_ok = !db.prepare("select name from sqlite_master where name='x'").get(); } catch(e){ r.tx_err=e.message }
try { r.backup = typeof backup; const dst = path.join(dir,'b.db'); const pages = await backup(db, dst); r.backup_pages = pages; const d2=new DatabaseSync(dst); r.backup_rows = d2.prepare('select count(*) c from t').get().c; d2.close(); } catch(e){ r.backup_err = e.message }
try { r.fn = typeof db.function; r.loadExt = typeof db.loadExtension; r.setAuth = typeof db.setAuthorizer; r.session = typeof db.createSession; } catch(e){}
try { r.isOpen = db.isOpen; r.isTransaction = db.isTransaction; } catch(e){}
console.log(JSON.stringify(r));
