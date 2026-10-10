import http from 'node:http';
import pg from 'pg';
const db=process.env.DATABASE_URL ? new pg.Client({connectionString:process.env.DATABASE_URL}) : process.env.PGHOST ? new pg.Client() : null;
if(db) await db.connect();
if(process.argv.includes('--init')) {
  if(!db)throw new Error('DB required for migration');
  await db.query('CREATE TABLE IF NOT EXISTS runtime_probe (id INTEGER PRIMARY KEY)');
  await db.query('INSERT INTO runtime_probe VALUES (1) ON CONFLICT DO NOTHING');
  await db.end();
} else {
  http.createServer(async (_req,res)=>{
    try {
      const count=db?Number((await db.query('SELECT COUNT(*) FROM runtime_probe')).rows[0].count):null;
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({language:'node',database:!!db,count}));
    }catch{res.writeHead(503);res.end('not ready');}
  }).listen(Number(process.env.PORT??3000),'0.0.0.0');
}
