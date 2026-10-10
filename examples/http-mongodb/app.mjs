import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
const client=new MongoClient(process.env.DATABASE_URL,{serverSelectionTimeoutMS:4000,connectTimeoutMS:3000});
await client.connect();
const db=client.db();
http.createServer(async(req,res)=>{
 try{
  const hello=await db.command({hello:1});
  let id;
  if(req.url==='/probe'){
   id=randomUUID();await db.collection('probe').insertOne({_id:id,at:new Date()},{writeConcern:{w:'majority',wtimeoutMS:5000}});
   if(!(await db.collection('probe').findOne({_id:id})))throw Error('read after write failed');
  }
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({ok:true,primary:hello.primary,replicaSet:hello.setName,id,count:await db.collection('probe').countDocuments()}));
 }catch{res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({ok:false}));}
}).listen(Number(process.env.PORT??3000),'0.0.0.0');
