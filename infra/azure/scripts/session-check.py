"""Check login-session sharing on a deployed public URL (Azure/AWS alike).

  python3 infra/azure/scripts/session-check.py <https://...> [requests=20]

Signs up, logs in, then requests /board repeatedly with the session cookie (plus any
ingress affinity cookie) and records status and X-Instance-Id per request.
Exit 0 when every request stays logged in, 1 when login is lost on some instance.
"""
import json, sys, time, urllib.error, urllib.parse, urllib.request
from http.cookiejar import CookieJar


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None


base, count = sys.argv[1].rstrip('/'), int(sys.argv[2]) if len(sys.argv) > 2 else 20
jar = CookieJar()
opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(jar))


def call(path, form=None):
    data = urllib.parse.urlencode(form).encode() if form else None
    try:
        r = opener.open(urllib.request.Request(base + path, data=data, headers={'Cache-Control': 'no-cache'}), timeout=15)
    except urllib.error.HTTPError as e:
        r = e
    r.read()
    return r.status, r.headers.get('Location', ''), r.headers.get('X-Instance-Id', '?')


email, password = f'check{int(time.time())}@example.com', 'check-pass-1234'
assert call('/join', {'email': email, 'nickname': 'check', 'password': password})[0] == 302, 'join failed'
login = call('/login', {'email': email, 'password': password})
assert login[0] == 302 and not login[1].endswith('/login'), f'login failed: {login}'

rows = [call('/board') for _ in range(count)]  # (status, location, instance)
lost = [instance for status, _, instance in rows if status != 200]
summary = {
    'url': base, 'requests': count, 'instances': sorted({r[2] for r in rows}),
    'logged_in': count - len(lost), 'lost': len(lost), 'lost_on': sorted(set(lost)),
}
print(json.dumps(summary, ensure_ascii=False))
sys.exit(1 if lost else 0)
