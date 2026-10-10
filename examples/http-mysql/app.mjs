// Dedicated experiment probe; deploy behind a client-restricted ALB.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import mysql from 'mysql2/promise';
import net from 'node:net';
import {readFileSync} from 'node:fs';
const pool=mysql.createPool(process.env.DATABASE_URL);
await pool.query('CREATE TABLE IF NOT EXISTS validation_probe (id VARCHAR(64) PRIMARY KEY, payload VARCHAR(128) NOT NULL)');
http.createServer(async(req,res)=>{
 try{
  const [cipher]=await pool.query("SHOW STATUS LIKE 'Ssl_cipher'");
  const [identity]=await pool.query('SELECT @@hostname AS host');
  if(!cipher[0].Value)throw Error('TLS required');
  let id,found;
  if(req.url==='/tls-negative'){
   const u=new URL(process.env.DATABASE_URL);
   let rejected=false,code;
   try{
    const wrong=await mysql.createConnection({host:'wrong-host.invalid',port:Number(u.port),user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:u.pathname.slice(1),connectTimeout:5000,stream:()=>net.connect(Number(u.port),u.hostname),ssl:{ca:readFileSync('/app/rds-ca.pem'),rejectUnauthorized:true,verifyIdentity:true}});
    await wrong.end();
   }catch(e){code=e.code;rejected=code==='ERR_TLS_CERT_ALTNAME_INVALID'||(code==='HANDSHAKE_SSL_ERROR'&&/Hostname\/IP does not match certificate's altnames/.test(e.message));}
   res.writeHead(rejected?200:503,{'content-type':'application/json'});res.end(JSON.stringify({hostnameMismatchRejected:rejected,code}));return;
  }
  if(req.url==='/probe'){
   id=randomUUID();await pool.execute('INSERT INTO validation_probe (id,payload) VALUES (?,?)',[id,'backup-복원-✓']);
  }
  if(req.url.startsWith('/verify/')){
   id=decodeURIComponent(req.url.slice(8));
   const [rows]=await pool.execute('SELECT payload FROM validation_probe WHERE id=?',[id]);
   found=rows.length===1&&rows[0].payload==='backup-복원-✓';
   if(!found)throw Error('Recorded document absent');
  }
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({ok:true,tlsCipher:cipher[0].Value,host:identity[0].host,id,found}));
 }catch(e){console.error('probe failed',e.code??e.name);res.writeHead(503);res.end('{"ok":false}');}
}).listen(Number(process.env.PORT??3000),'0.0.0.0');
