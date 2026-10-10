import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
import pg8000.dbapi

def connect():
    return pg8000.dbapi.connect(host=os.environ['APP_DB_HOST'], port=int(os.environ['APP_DB_PORT']), database=os.environ['APP_DB_NAME'], user=os.environ['APP_DB_USER'], password=os.environ['APP_DB_PASSWORD'])

if '--init' in sys.argv:
    with connect() as db:
        cursor=db.cursor()
        cursor.execute('CREATE TABLE IF NOT EXISTS runtime_probe (id INTEGER PRIMARY KEY)')
        cursor.execute('INSERT INTO runtime_probe VALUES (1) ON CONFLICT DO NOTHING')
        db.commit()
else:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            try:
                count=None
                if os.environ.get('APP_DB_HOST'):
                    with connect() as db:
                        cursor=db.cursor()
                        cursor.execute('SELECT COUNT(*) FROM runtime_probe')
                        count=cursor.fetchone()[0]
                body=json.dumps(dict(language='python',database=count is not None,count=count)).encode()
                self.send_response(200)
                self.send_header('Content-Type','application/json')
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                self.send_response(503);self.end_headers()
        def log_message(self,*args):pass
    HTTPServer(('0.0.0.0',int(os.environ.get('PORT','3000'))),Handler).serve_forever()
