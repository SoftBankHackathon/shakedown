#!/usr/bin/env python3
"""Exercise the sample's real HTTP form/API flow; no browser driver required."""
import argparse
import http.cookiejar
import json
import secrets
import socket
import ipaddress
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('url')
parser.add_argument('--marker', default='smoke-' + secrets.token_hex(6))
parser.add_argument('--resolve', help='Explicit IP for this host only, like curl --resolve; TLS hostname verification stays enabled')
parser.add_argument('--verify-only', action='store_true')
parser.add_argument('--expect-missing', action='store_true')
args = parser.parse_args()
base = args.url.rstrip('/')
if args.resolve:
    ipaddress.ip_address(args.resolve)
    hostname = urllib.parse.urlparse(base).hostname
    system_lookup = socket.getaddrinfo
    def lookup(host, port, *rest, **kwargs):
        return system_lookup(args.resolve if host == hostname else host, port, *rest, **kwargs)
    socket.getaddrinfo = lookup
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def get(path):
    with opener.open(base + path, timeout=15) as response:
        return response.status, response.read()
def post(path, data):
    with opener.open(base + path, urllib.parse.urlencode(data).encode(), timeout=15) as response:
        return response.status, response.read()
assert get('/health')[0] == 200
if not args.verify_only:
    password = secrets.token_urlsafe(20)
    email = args.marker + '@example.invalid'
    assert post('/join', dict(email=email, nickname='Smoke tester', password=password))[0] == 200
    status, page = post('/login', dict(email=email, password=password))
    assert status == 200 and b'/logout' in page, 'Login did not establish a session'
    assert post('/api/posts/write', dict(title=args.marker, content='PostgreSQL deployment smoke test'))[0] == 200
posts = json.loads(get('/api/posts')[1])
found = next((item for item in posts if item['title'] == args.marker), None)
assert bool(found) != args.expect_missing, ('Unexpected post persistence', args.marker)
if found:
    detail = json.loads(get('/api/posts/' + str(found['id']))[1])
    assert detail['title'] == args.marker
print(json.dumps(dict(ok=True, marker=args.marker, found=bool(found))))
