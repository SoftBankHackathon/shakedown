import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 셸 스크립트를 실제 GCP·Docker 없이 검사한다. PATH 맨 앞에 가짜 명령을 두고,
// 가짜는 받은 인자를 기록하며 자원의 "있음/없음"을 FAKE_STATE 폴더의 표식 파일로 흉내 낸다.
const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const PASSWORD = '0123456789abcdef'.repeat(3); // 가짜 openssl이 내는 값. 화면·호출 기록에 나오면 안 된다.
const EXPECTED_CONFIG = {
  gcpProject: 'shakedown-511106', gcpProjectNumber: '700410260240', region: 'asia-northeast3',
  projectId: 'prj_board', serviceName: 'shakedown-board', jobName: 'shakedown-board-schema',
  imagePrefixes: ['asia-northeast3-docker.pkg.dev/shakedown-511106/shakedown/'],
  network: 'default', subnetwork: 'default', dbHost: '10.20.0.3', dbName: 'board_db', dbUsername: 'board',
  dbPasswordSecret: 'shakedown-db-password', port: 8080, memory: '1Gi', cpu: '1',
};

const FAKES: Record<string, string> = {
  gcloud: String.raw`#!/usr/bin/env bash
# 가짜 gcloud. 호출 인자를 calls.log에 남기고, 자원 "있음/없음"은 표식 파일로 흉내 낸다.
state="$FAKE_STATE"
echo "$*" >> "$state/calls.log"
# gcloud는 인자와 표준출력을 ~/.config/gcloud/logs 파일에도 남긴다. 파일 로그를 끄고 부른 명령만 따로 적어 둔다.
if [ "$CLOUDSDK_CORE_DISABLE_FILE_LOGGING" = true ]; then echo "$1 $2 $3" >> "$state/nolog.log"; fi
case "$1 $2" in
  "config get") echo "$FAKE_CONFIG_PROJECT"; exit 0 ;;
  "projects describe") echo 700410260240; exit 0 ;;
  "services enable") exit 0 ;;
  "secrets describe") test -e "$state/secrets"; exit $? ;;
  "secrets create") touch "$state/secrets"; exit 0 ;;
  "secrets versions")
    case "$3" in
      add) cat > "$state/secret" ;;
      access) cat "$state/secret" ;;
      list) if [ -e "$state/secret" ]; then echo 1; fi ;;
    esac
    exit $? ;;
  "secrets add-iam-policy-binding") exit 0 ;;
  "services vpc-peerings")
    if [ "$3" = connect ]; then touch "$state/peering"; fi
    if [ "$3" = list ] && [ -e "$state/peering" ]; then echo servicenetworking-googleapis-com; fi
    exit 0 ;;
esac
marker="$state/$1-$2"
if [ "$3" = describe ]; then
  test -e "$marker" || exit 1
  case "$*" in
    *ipAddresses*) printf 'PRIVATE\t10.20.0.3\n' ;;
    *"value(state)"*)
      if [ -e "$state/failed" ]; then echo FAILED
      elif [ -e "$state/pending" ]; then rm "$state/pending"; echo PENDING_CREATE
      else echo RUNNABLE; fi ;;
  esac
  exit 0
fi
if [ "$3" = create ] || [ "$3" = set-password ]; then
  for arg in "$@"; do
    case "$arg" in --flags-file=*) cat "$(echo "$arg" | cut -d= -f2-)" >> "$state/flags.log" ;; esac
  done
  touch "$marker"; exit 0
fi
echo "unexpected gcloud call: $*" >&2
exit 99
`,
  // Cloud SQL 상태를 15초마다 다시 보는 대기를 테스트에서는 건너뛴다.
  sleep: '#!/usr/bin/env bash\nexit 0\n',
  openssl: '#!/usr/bin/env bash\necho "$*" >> "$FAKE_STATE/openssl.log"\necho ' + PASSWORD + '\n',
};

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'gcp-scripts-'));
  const bin = join(root, 'bin'), state = join(root, 'state');
  mkdirSync(bin); mkdirSync(state);
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, FAKE_CONFIG_PROJECT: 'shakedown-511106' };
  delete env.GCP_APP_PROJECT_ID;
  delete env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING; // 스크립트가 스스로 켜는지 보려고 밖에서 물려받은 값은 지운다.
  return { root, state, env, config: join(root, 'out', 'config.json') };
}
const run = (script: string, args: string[], env: NodeJS.ProcessEnv) => spawnSync('bash', [join(SCRIPTS, script), ...args], { env, encoding: 'utf8' });
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const calls = (state: string) => read(join(state, 'calls.log')).split('\n').filter(Boolean);
// 자원을 새로 만들거나 값을 바꾸는 호출(create·connect·비밀값 add·set-password)만 앞 세 단어로 줄여 순서를 비교한다.
const mutations = (lines: string[]) => lines.map(l => l.split(' '))
  .filter(w => w[1] === 'create' || ['create', 'connect', 'add', 'set-password'].includes(w[2]))
  .map(w => w.slice(0, 3).join(' '));

test('provision creates every resource once in dependency order, and a re-run creates nothing', () => {
  const box = sandbox();
  try {
    const first = run('provision.sh', ['shakedown-511106', box.config], box.env);
    assert.equal(first.status, 0, first.stderr);
    const firstCalls = calls(box.state);
    assert.deepEqual(mutations(firstCalls), [
      'artifacts repositories create',
      'compute addresses create',
      'services vpc-peerings connect',
      'sql instances create',
      'sql databases create',
      'secrets create shakedown-db-password',
      'secrets versions add',
      'sql users create',
    ]);
    const line = (prefix: string) => firstCalls.find(l => l.startsWith(prefix)) ?? '';
    for (const api of ['run', 'sqladmin', 'compute', 'servicenetworking', 'secretmanager', 'artifactregistry', 'cloudresourcemanager', 'logging']) {
      assert.ok(line('services enable').includes(`${api}.googleapis.com`), api);
    }
    for (const flag of ['--database-version=POSTGRES_17', '--edition=enterprise', '--tier=db-f1-micro', '--region=asia-northeast3', '--network=default', '--no-assign-ip']) {
      assert.ok(line('sql instances create').includes(flag), flag);
    }
    assert.ok(line('compute addresses create').includes('--purpose=VPC_PEERING'));
    assert.ok(line('artifacts repositories create').includes('--repository-format=docker --location=asia-northeast3'));
    assert.ok(line('secrets add-iam-policy-binding').includes('--member=serviceAccount:700410260240-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor'));
    assert.match(first.stdout, /Cloud SQL 생성 시간: \d+초/);
    assert.deepEqual(JSON.parse(read(box.config)), EXPECTED_CONFIG);

    writeFileSync(join(box.state, 'calls.log'), '');
    const second = run('provision.sh', ['shakedown-511106', box.config], box.env);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(mutations(calls(box.state)), []);
    assert.doesNotMatch(second.stdout, /Cloud SQL 생성 시간/);
    assert.equal(read(join(box.state, 'openssl.log')).split('\n').filter(Boolean).length, 1);
    assert.deepEqual(JSON.parse(read(box.config)), EXPECTED_CONFIG);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('provision keeps the DB password out of stdout, stderr, call log and config', () => {
  const box = sandbox();
  try {
    const result = run('provision.sh', ['shakedown-511106', box.config], box.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(join(box.state, 'secret')), PASSWORD);
    assert.ok(read(join(box.state, 'flags.log')).includes(PASSWORD));
    for (const text of [result.stdout, result.stderr, read(join(box.state, 'calls.log')), read(box.config)]) {
      assert.ok(!text.includes(PASSWORD));
    }
    const userCall = calls(box.state).find(l => l.startsWith('sql users create')) ?? '';
    const flagsFile = /--flags-file=(\S+)/.exec(userCall)?.[1] ?? '';
    assert.notEqual(flagsFile, '');
    assert.equal(existsSync(flagsFile), false);
    // 비밀번호가 인자로 풀리는 명령은 gcloud 파일 로그를 끄고 부른다.
    assert.deepEqual(read(join(box.state, 'nolog.log')).split('\n').filter(Boolean), ['sql users create']);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('provision resumes a stopped run: waits for the creating instance and reuses the stored secret', () => {
  const box = sandbox();
  const stored = 'reused0secret'.repeat(4);
  try {
    // 앞선 실행이 Cloud SQL 생성 요청만 보내고 끊긴 상태: 인스턴스는 아직 PENDING_CREATE, DB 사용자는 없다.
    for (const marker of ['artifacts-repositories', 'compute-addresses', 'peering', 'sql-instances', 'pending', 'sql-databases', 'secrets']) {
      writeFileSync(join(box.state, marker), '');
    }
    writeFileSync(join(box.state, 'secret'), stored);
    const result = run('provision.sh', ['shakedown-511106', box.config], box.env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(mutations(calls(box.state)), ['sql users create']);
    assert.equal(calls(box.state).filter(l => l.includes('value(state)')).length, 2); // PENDING_CREATE → RUNNABLE
    assert.doesNotMatch(result.stdout, /Cloud SQL 생성 시간/);
    assert.equal(read(join(box.state, 'openssl.log')), '');
    assert.ok(read(join(box.state, 'flags.log')).includes(stored));
    assert.ok(!result.stdout.includes(stored) && !result.stderr.includes(stored));
    assert.deepEqual(read(join(box.state, 'nolog.log')).split('\n').filter(Boolean), ['secrets versions access', 'sql users create']);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('provision fills a secret left without a value and resets the existing user to it', () => {
  const box = sandbox();
  try {
    // 앞선 실행이 비밀을 만든 직후 값을 넣기 전에 끊겼고, DB 사용자는 그 전부터 있던 상태.
    for (const marker of ['artifacts-repositories', 'compute-addresses', 'peering', 'sql-instances', 'sql-databases', 'secrets', 'sql-users']) {
      writeFileSync(join(box.state, marker), '');
    }
    const result = run('provision.sh', ['shakedown-511106', box.config], box.env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(mutations(calls(box.state)), ['secrets versions add', 'sql users set-password']);
    assert.equal(read(join(box.state, 'secret')), PASSWORD);
    assert.ok(read(join(box.state, 'flags.log')).includes(PASSWORD));
    for (const text of [result.stdout, result.stderr, read(join(box.state, 'calls.log'))]) {
      assert.ok(!text.includes(PASSWORD));
    }
    assert.deepEqual(read(join(box.state, 'nolog.log')).split('\n').filter(Boolean), ['sql users set-password']);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('provision stops at once when Cloud SQL creation has failed', () => {
  const box = sandbox();
  try {
    for (const marker of ['artifacts-repositories', 'compute-addresses', 'peering', 'sql-instances', 'failed']) {
      writeFileSync(join(box.state, marker), '');
    }
    const result = run('provision.sh', ['shakedown-511106', box.config], box.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FAILED/);
    assert.equal(calls(box.state).filter(l => l.includes('value(state)')).length, 1);
    assert.equal(existsSync(box.config), false);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('provision stops before any change when gcloud points at another project', () => {
  const box = sandbox();
  try {
    const result = run('provision.sh', ['shakedown-511106', box.config], { ...box.env, FAKE_CONFIG_PROJECT: 'someone-else-1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /현재 프로젝트\(someone-else-1\)/);
    assert.deepEqual(calls(box.state), ['config get project']);
    assert.equal(existsSync(box.config), false);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('provision writes the engine project id from GCP_APP_PROJECT_ID and rejects unsafe values', () => {
  const box = sandbox();
  try {
    const ok = run('provision.sh', ['shakedown-511106', box.config], { ...box.env, GCP_APP_PROJECT_ID: 'prj_0123456789abcdef' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(read(box.config)).projectId, 'prj_0123456789abcdef');
    const bad = run('provision.sh', ['shakedown-511106', box.config], { ...box.env, GCP_APP_PROJECT_ID: 'prj"x' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /GCP_APP_PROJECT_ID/);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});
