// Real official-image database checks. Only temporary loopback ports; no AWS/tunnel.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import mysql from 'mysql2/promise';
import {MongoClient} from 'mongodb';
import {composeSpec} from './runtime.mjs';
const root=await mkdtemp(path.join(tmpdir(),'shakedown-databases-'));
const results=[];
try {
 for(const mode of ['mysql','mongodb']) {
  const id=`sd-${mode}-${Date.now()}`,file=path.join(root,mode+'.json');
  const password='secret@:/?#%$ 한글';
  const runtime={version:'http-runtime.v1',port:3000,health_path:'/',env:{},secret_refs:{},database:{mode,name:'app',bindings:{DATABASE_URL:mode+'_url'}},init_command:[]};
  const spec=composeSpec({runtime,image:'unused'},password);
  const url=new URL(spec.services.app.environment.DATABASE_URL);
  delete spec.services.app;delete spec.services.tunnel;
  spec.services.db.ports=[`127.0.0.1::${mode==='mysql'?3306:27017}`];
  await writeFile(file,JSON.stringify(spec),{mode:0o600});
  const run=args=>execFileSync('docker',['compose','-p',id,'-f',file,...args],{encoding:'utf8',timeout:360000,stdio:['ignore','pipe','pipe']}).trim();
  try {
   run(['up','-d','--wait','--wait-timeout','240']);
   const address=run(['port','db',mode==='mysql'?'3306':'27017']);
   url.hostname='127.0.0.1';url.port=address.split(':').at(-1);
   if(mode==='mysql') {
    const db=await mysql.createConnection(url.href);
    try {await db.execute('CREATE TABLE IF NOT EXISTS probe (id INT PRIMARY KEY)');await db.execute('INSERT IGNORE INTO probe VALUES (1)');}finally{await db.end();}
   }else{
    const db=new MongoClient(url.href);try{await db.connect();await db.db('app').collection('probe').updateOne({_id:1},{$set:{value:'saved'}},{upsert:true});}finally{await db.close();}
   }
   run(['restart','db']);run(['up','-d','--wait','--wait-timeout','240']);
   url.port=run(['port','db',mode==='mysql'?'3306':'27017']).split(':').at(-1);
   let count,denied=false;
   const wrong=new URL(url);wrong.password='incorrect';
   if(mode==='mysql') {
    const db=await mysql.createConnection(url.href);try{const [rows]=await db.execute('SELECT COUNT(*) AS n FROM probe');count=rows[0].n;}finally{await db.end();}
    try{const bad=await mysql.createConnection(wrong.href);await bad.end();}catch{denied=true;}
   }else{
    const db=new MongoClient(url.href);try{await db.connect();count=await db.db('app').collection('probe').countDocuments();let forbidden=false;try{await db.db('admin').command({usersInfo:1});}catch{forbidden=true;}if(!forbidden)throw Error('App has admin permissions');}finally{await db.close();}
    const bad=new MongoClient(wrong.href,{serverSelectionTimeoutMS:2000});try{await bad.connect();}catch{denied=true;}finally{await bad.close();}
   }
   if(count!==1||!denied)throw Error('Persistence/auth verification failed');
   results.push({mode,read_write:true,restart_persistence:true,wrong_password_rejected:true,special_character_password:true});
  }finally{run(['down','-v','--remove-orphans']);}
 }
 console.log(JSON.stringify({results,cleanup:'completed',scope:'local official database images, driver connections; no AWS or public endpoint'},null,2));
}finally{await rm(root,{recursive:true,force:true});}
