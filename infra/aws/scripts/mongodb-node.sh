#!/bin/bash
# Rendered into CloudFormation UserData. Values are substituted by CloudFormation.
set -euo pipefail
umask 077
node_index='@@INDEX@@'
volume='@@VOLUME@@'
region='${AWS::Region}'
bundle_secret='${MongoClusterSecret}'
ca_secret='${MongoCaSecret}'
password_secret='${DbSecret}'
url_secret='${DbUrlSecret}'
db_name='${DatabaseName}'
ready_handle='${MongoReadyHandle}'
dnf install -y docker openssl
systemctl enable --now docker
security=/etc/shakedown-mongo
mkdir -p "$security" /srv/mongodb
chmod 700 "$security"
device="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_$(echo "$volume" | tr -d '-')"
for i in $(seq 1 120); do test -b "$device" && break; sleep 5; done
test -b "$device"
if ! blkid "$device"; then mkfs -t xfs "$device"; fi
echo "UUID=$(blkid -s UUID -o value "$device") /srv/mongodb xfs defaults,nofail 0 2" >> /etc/fstab
mount /srv/mongodb
# Node 0 creates one cluster bundle. Replacements reuse it; credentials never enter logs.
if [ "$node_index" = 0 ]; then
  aws secretsmanager get-secret-value --region "$region" --secret-id "$bundle_secret" --query SecretString --output text > "$security/bundle.json"
  if ! python3 -c 'import json,sys; assert "pem" in json.load(open(sys.argv[1]))' "$security/bundle.json" 2>/dev/null; then
    openssl req -x509 -newkey rsa:3072 -nodes -keyout "$security/ca.key" -out "$security/ca.pem" -days 3650 -subj '/CN=Shakedown Mongo CA' >/dev/null 2>&1
    openssl req -new -newkey rsa:3072 -nodes -keyout "$security/server.key" -out "$security/server.csr" -subj '/CN=shakedown-mongo' >/dev/null 2>&1
    printf '%s\n' 'subjectAltName=IP:10.42.0.50,IP:10.42.1.50,IP:10.42.2.50,IP:127.0.0.1,DNS:localhost' 'extendedKeyUsage=serverAuth,clientAuth' > "$security/extensions"
    openssl x509 -req -in "$security/server.csr" -CA "$security/ca.pem" -CAkey "$security/ca.key" -CAcreateserial -out "$security/server.crt" -days 365 -extfile "$security/extensions" >/dev/null 2>&1
    python3 - "$security" <<'PY'
import json,pathlib,secrets,sys
p=pathlib.Path(sys.argv[1]); (p/'bundle.json').write_text(json.dumps({'ca':(p/'ca.pem').read_text(),'pem':(p/'server.crt').read_text()+(p/'server.key').read_text(),'keyfile':secrets.token_urlsafe(500).replace('-','A').replace('_','B'),'adminPassword':secrets.token_hex(32)}))
PY
    aws secretsmanager put-secret-value --region "$region" --secret-id "$bundle_secret" --secret-string "file://$security/bundle.json" >/dev/null
    # No CA signing key is persisted. Leaf renewal creates a coordinated new CA/bundle.
    rm -f "$security/ca.key" "$security/server.key" "$security/server.csr" "$security/server.crt" "$security/ca.srl"
  fi
fi
for i in $(seq 1 120); do
  aws secretsmanager get-secret-value --region "$region" --secret-id "$bundle_secret" --query SecretString --output text > "$security/bundle.json"
  if python3 -c 'import json,sys; assert "pem" in json.load(open(sys.argv[1]))' "$security/bundle.json" 2>/dev/null; then break; fi
  sleep 5
done
python3 - "$security" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); b=json.loads((p/'bundle.json').read_text())
for k,f in [('ca','ca.pem'),('pem','server.pem'),('keyfile','keyfile')]: (p/f).write_text(b[k])
(p/'env').write_text('MONGO_INITDB_ROOT_USERNAME=admin\nMONGO_INITDB_ROOT_PASSWORD='+b['adminPassword']+'\n')
PY
rm "$security/bundle.json"
chown 999:999 "$security/ca.pem" "$security/server.pem" "$security/keyfile"
chmod 400 "$security/server.pem" "$security/keyfile"
chmod 444 "$security/ca.pem"
docker pull mongo:8.0
docker run -d --name shakedown-mongo --restart unless-stopped --env-file "$security/env" -p 27017:27017 \
  -v /srv/mongodb:/data/db -v "$security/server.pem:/security/server.pem:ro" -v "$security/keyfile:/security/keyfile:ro" -v "$security/ca.pem:/security/ca.pem:ro" \
  mongo:8.0 --replSet shakedown --keyFile /security/keyfile --tlsMode requireTLS --tlsCertificateKeyFile /security/server.pem --tlsCAFile /security/ca.pem --tlsAllowConnectionsWithoutCertificates
if [ "$node_index" != 0 ]; then exit 0; fi
for i in $(seq 1 120); do
  if docker exec shakedown-mongo mongosh --quiet --tls --tlsCAFile /security/ca.pem --eval 'const a=db.getSiblingDB("admin"); if(!a.auth("admin",process.env.MONGO_INITDB_ROOT_PASSWORD))quit(1); a.runCommand({ping:1});' >/dev/null 2>&1; then break; fi
  sleep 5
done
# Initiate idempotently, then wait for all three authenticated TLS members.
cat > "$security/configure.js" <<'JS'
const a=db.getSiblingDB('admin'); a.auth('admin',process.env.MONGO_INITDB_ROOT_PASSWORD);
try {rs.status();} catch(e) {if(e.code!==94)throw e;const r=rs.initiate({_id:'shakedown',members:[{_id:0,host:'10.42.0.50:27017',priority:2},{_id:1,host:'10.42.1.50:27017'},{_id:2,host:'10.42.2.50:27017'}]}); if(!r.ok)quit(2);}
JS
docker cp "$security/configure.js" shakedown-mongo:/tmp/configure.js
for i in $(seq 1 120); do
  if docker exec shakedown-mongo mongosh --quiet --tls --tlsCAFile /security/ca.pem /tmp/configure.js >/dev/null 2>&1; then break; fi
  sleep 5
done
aws secretsmanager get-secret-value --region "$region" --secret-id "$password_secret" --query SecretString --output text > "$security/password.json"
python3 - "$security" "$db_name" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); password=json.loads((p/'password.json').read_text())['password']; name=sys.argv[2]
(p/'app.js').write_text("const a=db.getSiblingDB('admin'); a.auth('admin',process.env.MONGO_INITDB_ROOT_PASSWORD); const s=rs.status(); if(s.members.filter(m=>m.health===1&&[1,2].includes(m.state)).length!==3)quit(2); if(!db.hello().isWritablePrimary)quit(2); const d=db.getSiblingDB("+json.dumps(name)+"); if(!d.getUser('app'))d.createUser({user:'app',pwd:"+json.dumps(password)+",roles:[{role:'readWrite',db:"+json.dumps(name)+"}]},{w:'majority'});")
PY
docker cp "$security/app.js" shakedown-mongo:/tmp/app.js
for i in $(seq 1 120); do
  if docker exec shakedown-mongo mongosh --quiet --tls --tlsCAFile /security/ca.pem /tmp/app.js >/dev/null 2>&1; then
    python3 - "$security" "$db_name" <<'PY'
import json,pathlib,sys,urllib.parse
p=pathlib.Path(sys.argv[1]); password=json.loads((p/'password.json').read_text())['password']; name=sys.argv[2]
(p/'url').write_text('mongodb://app:'+urllib.parse.quote(password,safe='')+'@10.42.0.50:27017,10.42.1.50:27017,10.42.2.50:27017/'+name+'?authSource='+name+'&replicaSet=shakedown&tls=true&tlsCAFile=/run/shakedown/db-ca/ca.pem&w=majority&retryWrites=true')
PY
    aws secretsmanager put-secret-value --region "$region" --secret-id "$ca_secret" --secret-string "file://$security/ca.pem" >/dev/null
    aws secretsmanager put-secret-value --region "$region" --secret-id "$url_secret" --secret-string "file://$security/url" >/dev/null
    rm -f "$security/url" "$security/password.json" "$security/app.js"
    docker exec shakedown-mongo rm /tmp/app.js
    curl --fail --silent --show-error -X PUT -H 'Content-Type:' --data-binary '{"Status":"SUCCESS","Reason":"TLS replica set ready","UniqueId":"mongo","Data":"ready"}' "$ready_handle"
    exit 0
  fi
  sleep 5
done
exit 1
