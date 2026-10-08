#!/usr/bin/env python3
"""Isolated PostgreSQL + two real app containers; no AWS calls. Removes only its own resources."""
import http.client as http_client
import json, os, secrets, subprocess, tempfile, time, urllib.parse
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
PLATFORM = os.environ.get('SHAKEDOWN_TEST_PLATFORM', 'linux/amd64')
IMAGE = os.environ.get('SHAKEDOWN_TEST_IMAGE', 'shakedown-board:aws-session-test')
PREFIX = 'shakedown-smoke-' + secrets.token_hex(4)
NETWORK = PREFIX + '-net'
containers, checks = [], []

def docker(*args, timeout=180):
    r = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode: raise RuntimeError(f'Docker {args[0]} failed: {r.stderr[-2000:]}')
    return r.stdout.strip()

def wait(fn, label, timeout=150):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if fn(): return
        except (ConnectionError, OSError, http_client.HTTPException): pass
        time.sleep(1)
    raise AssertionError('Timed out: ' + label)

def http(port, path, method='GET', data=None, cookie=None):
    c = http_client.HTTPConnection('127.0.0.1', port, timeout=8)
    h = {}
    if data is not None: h['Content-Type'] = 'application/x-www-form-urlencoded'; data = urllib.parse.urlencode(data)
    if cookie: h['Cookie'] = cookie
    c.request(method, path, data, h)
    r = c.getresponse()
    result = (r.status, {k.lower(): v for k, v in r.getheaders()}, r.read().decode())
    c.close()
    return result

def app(envfile, suffix, profile):
    name = PREFIX + '-' + suffix; containers.append(name)
    docker('run', '-d', '--platform', PLATFORM, '--name', name, '--network', NETWORK, '--env-file', str(envfile), '-e', 'SPRING_PROFILES_ACTIVE=demo,' + profile, '-p', '127.0.0.1::8080', IMAGE)
    port = int(docker('port', name, '8080/tcp').rsplit(':', 1)[1])
    wait(lambda: http(port, '/')[0] == 200, suffix)
    return name, port

def check(condition, message):
    assert condition, message
    checks.append(message); print('PASS:', message, flush=True)

try:
    docker('network', 'create', NETWORK)
    with tempfile.TemporaryDirectory(prefix=PREFIX) as directory:
        password = secrets.token_urlsafe(24)
        pgenv = Path(directory) / 'postgres.env'
        pgenv.write_text(f'POSTGRES_DB=board_db\nPOSTGRES_USER=board_admin\nPOSTGRES_PASSWORD={password}\n'); pgenv.chmod(0o600)
        appenv = Path(directory) / 'app.env'
        appenv.write_text(f'SPRING_DATASOURCE_URL=jdbc:postgresql://db:5432/board_db\nSPRING_DATASOURCE_USERNAME=board_admin\nSPRING_DATASOURCE_PASSWORD={password}\n'); appenv.chmod(0o600)
        db = PREFIX + '-db'; containers.append(db)
        docker('run', '-d', '--name', db, '--network', NETWORK, '--network-alias', 'db', '--env-file', str(pgenv), 'postgres:17-alpine')
        # Probe TCP as the app user after the temporary initialization server exits.
        wait(lambda: subprocess.run(['docker','exec',db,'pg_isready','-U','board_admin','-d','board_db'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0, 'PostgreSQL')
        for n in range(2):
            name = PREFIX + f'-init{n}'; containers.append(name)
            docker('run', '--platform', PLATFORM, '--name', name, '--network', NETWORK, '--env-file', str(appenv), '-e', 'SPRING_PROFILES_ACTIVE=schema-init', IMAGE)
        check(True, 'schema initialization is repeatable without deleting data')
        first,a = app(appenv, 'memory-a', 'session-memory'); second,b = app(appenv, 'memory-b', 'session-memory')
        email = PREFIX + '@example.test'; userpass = secrets.token_urlsafe(20)
        assert http(a, '/join', 'POST', {'email':email,'nickname':'smoke','password':userpass})[0] == 302
        login = http(a, '/login', 'POST', {'email':email,'password':userpass}); assert login[0] == 302
        cookie = login[1]['set-cookie'].split(';')[0]
        check(http(a, '/board', cookie=cookie)[0] == 200, 'memory session works on login instance')
        cross = http(b, '/board', cookie=cookie)
        check(cross[0] == 302 and cross[1]['location'].endswith('/'), 'memory session fails on another healthy instance')
        check(http(a, '/')[1]['x-instance-id'] != http(b, '/')[1]['x-instance-id'], 'response evidence distinguishes two instances')
        docker('rm', '-f', '-v', first, second)
        first,a = app(appenv, 'jdbc-a', 'session-jdbc'); second,b = app(appenv, 'jdbc-b', 'session-jdbc')
        login = http(a, '/login', 'POST', {'email':email,'password':userpass}); assert login[0] == 302
        cookie = login[1]['set-cookie'].split(';')[0]
        check(all(http(port, '/board', cookie=cookie)[0] == 200 for port in [a,b] * 5), 'JDBC session passes 10 alternating requests across instances')
        title = 'persistent-' + PREFIX
        written = http(b, '/api/posts/write', 'POST', {'title':title,'content':'durable evidence'}, cookie)
        check(written[0] == 302 and written[1]['location'].endswith('/board'), 'authenticated cross-instance post creation succeeds')
        for port in (a,b): check(any(p['title'] == title for p in json.loads(http(port,'/api/posts')[2])), 'post is visible on instance port '+str(port))
        docker('restart',first)
        a = int(docker('port',first,'8080/tcp').rsplit(':',1)[1])
        wait(lambda: http(a,'/')[0] == 200,'app restart')
        check(http(a,'/board',cookie=cookie)[0] == 200,'JDBC login survives app restart')
        check(any(p['title'] == title for p in json.loads(http(a,'/api/posts')[2])),'post survives app restart')
        output = ROOT / '.data/session-smoke/latest.json'; output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps({'checked_at':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'image':IMAGE,'checks':checks,'database':'PostgreSQL 17','aws_verified':False},ensure_ascii=False,indent=2)+'\n')
        print('Evidence:',output,flush=True)
except Exception:
    for name in containers:
        r = subprocess.run(['docker','inspect','--format','{{.State.Status}} {{.State.ExitCode}}',name],capture_output=True,text=True)
        print(name,r.stdout.strip(),flush=True)
    raise
finally:
    for name in reversed(containers): subprocess.run(['docker','rm','-f','-v',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['docker','network','rm',NETWORK],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
