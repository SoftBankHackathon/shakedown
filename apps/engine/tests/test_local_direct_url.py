from engine.deployments import LocalRunner


def test_local_direct_url_is_operator_exact_origin(monkeypatch):
    monkeypatch.setenv('LOCAL_DELIVERY_MODE', 'direct')
    monkeypatch.setenv('LOCAL_PUBLIC_URL', 'http://192.0.2.1:18080')
    assert LocalRunner.valid_url('http://192.0.2.1:18080')
    for url in ['http://192.0.2.2:18080', 'http://192.0.2.1:9101',
                'http://192.0.2.1:18080@evil.test', 'http://192.0.2.1:18080/path',
                'http://192.0.2.1:18080?q=1', 'https://x.trycloudflare.com']:
        assert not LocalRunner.valid_url(url)
    monkeypatch.delenv('LOCAL_PUBLIC_URL')
    assert not LocalRunner.valid_url('http://192.0.2.1:18080')


def test_local_tunnel_url_still_restricted(monkeypatch):
    monkeypatch.delenv('LOCAL_DELIVERY_MODE', raising=False)
    assert LocalRunner.valid_url('https://test.trycloudflare.com')
    assert not LocalRunner.valid_url('http://test.trycloudflare.com')
    assert not LocalRunner.valid_url('https://test.trycloudflare.com.evil.test')
    assert not LocalRunner.valid_url('https://user:pass@test.trycloudflare.com')


def test_direct_origin_normalization_and_invalid_port(monkeypatch):
    monkeypatch.setenv('LOCAL_DELIVERY_MODE', 'direct')
    monkeypatch.setenv('LOCAL_PUBLIC_URL', 'http://EXAMPLE.COM:80/')
    assert LocalRunner.valid_url('http://example.com')
    assert not LocalRunner.valid_url('http://example.com:0')
    monkeypatch.setenv('LOCAL_PUBLIC_URL', 'http://example.com:invalid')
    assert not LocalRunner.valid_url('http://example.com:invalid')
