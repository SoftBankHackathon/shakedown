import httpx
import pytest
from engine.https_client import HttpsClient, HttpsError, loopback_url, target_address


def registry(**patch):
    return dict(project_id='project', target='aws', status='ready', domain='app.example.com',
                https_url='https://app.example.com', origin_url='http://demo.elb.amazonaws.com',
                certificate={'expires_at':'2099-01-01T00:00:00Z'}, checked_at='2026-10-09T00:00:00Z', **patch)


def client(body=None, status=200):
    return HttpsClient('http://127.0.0.1:9301',httpx.MockTransport(lambda r:httpx.Response(status,json=body or {})))


def test_verified_domain_is_selected_and_unregistered_domain_is_rejected():
    c=client(registry())
    assert c.deployment_url('project','aws','http://demo.elb.amazonaws.com',True)=='https://app.example.com'
    assert c.deployment_url('project','aws','https://app.example.com',False)=='https://app.example.com'
    with pytest.raises(HttpsError):
        c.deployment_url('project','aws','https://attacker.example.com',False)
    with pytest.raises(HttpsError):
        c.deployment_url('project','aws','http://other.elb.amazonaws.com',True)


@pytest.mark.parametrize('patch',[{'status':'certificate_pending'},{'certificate':None},{'target':'local'},
    {'https_url':'https://app.example.com@evil.example.com'}, {'https_url':'http://app.example.com'},
    {'https_url':'https://app.example.com/path'},{'https_url':'https://app.example.com:444'},
    {'certificate':{'expires_at':'2000-01-01T00:00:00Z'}}])
def test_pending_or_invalid_registry_cannot_fallback_to_plain_http(patch):
    b=registry();b.update(patch)
    with pytest.raises(HttpsError):
        client(b).deployment_url('project','aws','http://demo.elb.amazonaws.com',True)


def test_disabled_registry_preserves_existing_behavior(monkeypatch):
    monkeypatch.delenv('SHAKEDOWN_HTTPS_URL',raising=False)
    assert HttpsClient().deployment_url('project','local','https://native.trycloudflare.com',True)=='https://native.trycloudflare.com'
    with pytest.raises(HttpsError): HttpsClient().deployment_url('project','local','https://evil.example.com',False)


def test_service_missing_binding_is_different_from_service_outage():
    assert client(status=404).binding('project','aws') is None
    with pytest.raises(HttpsError): client(status=500).binding('project','aws')


def test_reference_only_body_and_configurable_fixed_loopback_target(monkeypatch):
    with pytest.raises(HttpsError): loopback_url('http://169.254.169.254:80')
    with pytest.raises(HttpsError): loopback_url('http://127.0.0.1:65536')
    monkeypatch.setenv('SHAKEDOWN_TARGET_AWS_URL','http://127.0.0.1:9108')
    assert target_address('aws','http://127.0.0.1:9102')=='http://127.0.0.1:9108'
    with pytest.raises(HttpsError): client().call('POST','../secret','aws',{})



def test_engine_proxies_https_only_for_known_projects_and_rejects_credentials(client, repository):
    project=client.post('/api/projects',json={'repo':str(repository)}).json()['id']
    seen=[]
    def response(request):
        seen.append(request)
        return httpx.Response(202 if request.method=='POST' else 200,json={'binding_id':'tls_test','status':'dns_pending'})
    client.app.state.https=HttpsClient('http://127.0.0.1:9301',httpx.MockTransport(response))
    path=f'/api/projects/{project}/targets/aws/https'
    assert client.post(path,json={'domain':'app.example.com'}).status_code==202
    assert client.get(path).json()['status']=='dns_pending'
    assert client.post(path+'/recheck').status_code==202
    r=client.post(path,json={'domain':'app.example.com','token':'PRIVATE_API_KEY'})
    assert r.status_code==400 and 'PRIVATE_API_KEY' not in r.text
    assert client.post(path+'/gate',json={'open':True}).status_code==404
    assert client.post('/api/projects/missing/targets/aws/https',json={'domain':'app.example.com'}).status_code==404
    assert len(seen)==3
