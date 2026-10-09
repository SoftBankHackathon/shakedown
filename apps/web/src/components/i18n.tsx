"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// UI text only. Data coming from the engine (step titles, AI reports) is shown as received.
export const LANGS = { ko: "KR", en: "EN", ja: "JP" } as const;
export type Lang = keyof typeof LANGS;

const DICT = {
  tagline: { ko: "배포 · 사용 · 비교 · 판정", en: "deploy · use · compare · decide", ja: "デプロイ・利用・比較・判定" },
  "home.eyebrow": { ko: "SoftBank Hackathon 2026", en: "SoftBank Hackathon 2026", ja: "SoftBank Hackathon 2026" },
  // The official theme stays in English in every language.
  "home.title": { ko: "One Action, Infinite Clouds.", en: "One Action, Infinite Clouds.", ja: "One Action, Infinite Clouds." },
  "home.lead": {
    ko: "로컬에서 만든 웹 앱을 한 번에 내 PC와 AWS에 배포하고, AI가 두 환경에서 직접 써 보며 똑같이 동작하는지 확인합니다.",
    en: "Deploy a locally built web app to your PC and AWS in one action, and let AI use it on both to confirm it behaves the same everywhere.",
    ja: "ローカルで作ったWebアプリをワンアクションでPCとAWSにデプロイし、AIが両方の環境で実際に使って同じように動くか確認します。",
  },
  "home.step1": { ko: "레포 입력", en: "Add a repo", ja: "リポジトリ入力" },
  "home.step1d": { ko: "GitHub 링크만 넣으면 설정 자동 감지", en: "Paste a GitHub link, settings are detected", ja: "GitHubリンクだけで設定を自動検出" },
  "home.step2": { ko: "Action 한 번", en: "One Action", ja: "Action 1回" },
  "home.step2d": { ko: "내 PC와 AWS에 동시 배포", en: "Ships to your PC and AWS at once", ja: "マイPCとAWSに同時デプロイ" },
  "home.step3": { ko: "AI 시운전", en: "AI shakedown", ja: "AI 試運転" },
  "home.step3d": { ko: "두 환경에서 같은 흐름을 직접 사용", en: "Runs the same journey on both", ja: "両環境で同じ操作を実行" },
  "home.step4": { ko: "판정", en: "Verdict", ja: "判定" },
  "home.step4d": { ko: "같으면 배포 완료, 다르면 차단", en: "Same → release, different → block", ja: "同じならリリース、違えばブロック" },
  "home.placeholder": {
    ko: "GitHub URL 또는 로컬 경로 (예: https://github.com/xodbs1021/kty-board-project)",
    en: "GitHub URL or local path, e.g. https://github.com/xodbs1021/kty-board-project",
    ja: "GitHub URL またはローカルパス(例: https://github.com/xodbs1021/kty-board-project)",
  },
  "home.targets": { ko: "배포 대상", en: "Deploy to", ja: "デプロイ先" },
  "home.soon": { ko: "예정", en: "soon", ja: "予定" },
  "home.needTwo": {
    ko: "비교하려면 대상을 2개 이상 고르세요.",
    en: "Pick at least two targets to compare.",
    ja: "比較するにはデプロイ先を2つ以上選んでください。",
  },
  "home.targetsHint": {
    ko: "고른 환경 모두에 같은 앱을 배포하고, 서로 똑같이 동작하는지 비교합니다.",
    en: "The same app is deployed to every selected target and compared across them.",
    ja: "選んだすべての環境に同じアプリをデプロイし、同じように動くか比較します。",
  },
  // The button is the theme itself, so it reads "Action" in every language.
  action: { ko: "Action", en: "Action", ja: "Action" },
  "home.busy": {
    ko: "{name}은(는) 이미 배포가 진행 중입니다. 끝난 뒤 다시 눌러 주세요.",
    en: "{name} is already deploying. Try again when it finishes.",
    ja: "{name} はすでにデプロイ中です。完了後にもう一度押してください。",
  },
  "home.accepted": { ko: "접수됨", en: "Accepted", ja: "受付済み" },
  "home.actions": { ko: "Action 기록", en: "Actions", ja: "Action 履歴" },
  "home.noActions": { ko: "아직 Action이 없습니다.", en: "No actions yet.", ja: "Action はまだありません。" },
  "pipe.source": { ko: "소스", en: "Source", ja: "ソース" },
  "pipe.image": { ko: "컨테이너 이미지", en: "Container image", ja: "コンテナイメージ" },
  "pipe.steps": { ko: "{passed}/{total}단계 통과", en: "{passed}/{total} steps passed", ja: "{passed}/{total} ステップ通過" },
  "pipe.redeploy": { ko: "재배포 중 ({fix})", en: "Redeploying ({fix})", ja: "再デプロイ中 ({fix})" },
  "pipe.autofix": { ko: "자동 수정: {fix}", en: "Auto-fix: {fix}", ja: "自動修正: {fix}" },
  "home.elapsed": { ko: "경과", en: "elapsed", ja: "経過" },
  "home.total": { ko: "총 소요", en: "total", ja: "所要時間" },
  loading: { ko: "불러오는 중…", en: "Loading…", ja: "読み込み中…" },
  "ago.s": { ko: "{n}초 전", en: "{n}s ago", ja: "{n}秒前" },
  "ago.m": { ko: "{n}분 전", en: "{n}m ago", ja: "{n}分前" },
  "ago.h": { ko: "{n}시간 전", en: "{n}h ago", ja: "{n}時間前" },
  mock: { ko: "데모 데이터 (엔진 미연결)", en: "Demo data (engine not connected)", ja: "デモデータ(エンジン未接続)" },

  "project.back": { ko: "← 프로젝트", en: "← Projects", ja: "← プロジェクト" },
  "project.starting": { ko: "시작 중…", en: "Starting…", ja: "開始中…" },
  "project.detected": { ko: "레포에서 감지한 설정", en: "Detected from the repository", ja: "リポジトリから検出" },
  "project.hiddenFromAi": { ko: "AI에 전달 안 함", en: "hidden from AI", ja: "AIには渡さない" },
  "project.routes": { ko: "코드에서 찾은 라우트 {n}개", en: "{n} routes found in code", ja: "コードから見つかったルート {n} 件" },
  "project.targets": { ko: "배포 대상", en: "Targets", ja: "デプロイ先" },
  "project.localDesc": { ko: "Docker, 인스턴스 1대", en: "Docker, 1 instance", ja: "Docker、インスタンス1台" },
  "project.instances": { ko: "인스턴스", en: "Instances", ja: "インスタンス" },
  "project.affinity": { ko: "세션 고정", en: "Session affinity", ja: "セッション固定" },
  "project.timezone": { ko: "타임존", en: "Timezone", ja: "タイムゾーン" },
  "project.port": { ko: "포트", en: "port", ja: "ポート" },
  "project.after": { ko: "배포 후", en: "After deploy", ja: "デプロイ後" },
  "project.shakedown": { ko: "AI 시운전", en: "AI shakedown", ja: "AI 試運転" },
  "project.shakedownDesc": {
    ko: "두 환경에서 앱을 써 보고, 다르게 동작하면 배포를 막습니다.",
    en: "Use the app on both targets and block the release on differences.",
    ja: "両方の環境でアプリを使い、違いがあればリリースを止めます。",
  },
  "project.autofix": { ko: "환경 설정 자동 수정", en: "Auto-fix environment settings", ja: "環境設定の自動修正" },
  "project.autofixDesc": {
    ko: "허용된 설정(세션 고정, 타임존)만 고칩니다. 코드와 데이터는 건드리지 않습니다.",
    en: "Only whitelisted settings (session affinity, timezone). Never code or data.",
    ja: "許可された設定(セッション固定、タイムゾーン)のみ。コードとデータは変更しません。",
  },
  "project.deployments": { ko: "배포 기록", en: "Deployments", ja: "デプロイ履歴" },
  "project.noDeployments": { ko: "아직 배포가 없습니다.", en: "No deployments yet.", ja: "デプロイはまだありません。" },
  "project.shakedowns": { ko: "시운전 {n}회", en: "{n} shakedown(s)", ja: "試運転 {n} 回" },
  "project.autofixed": { ko: "자동 수정: {x}", en: "auto-fixed {x}", ja: "自動修正: {x}" },

  "dep.back": { ko: "← 프로젝트", en: "← Project", ja: "← プロジェクト" },
  "dep.title": { ko: "배포", en: "Deployment", ja: "デプロイ" },
  "dep.total": { ko: "전체", en: "Total", ja: "合計" },
  "dep.build": { ko: "빌드", en: "Build", ja: "ビルド" },
  "dep.deploy": { ko: "배포", en: "Deploy", ja: "デプロイ" },
  "dep.aiCost": { ko: "AI 비용", en: "AI cost", ja: "AI コスト" },
  "dep.calls": { ko: "호출 {n}회", en: "{n} calls", ja: "{n} 回呼び出し" },
  "live.needLocal": { ko: "배포 대상을 하나 이상 선택하세요.", en: "Select at least one deployment target.", ja: "配備先を選択してください。" },
  "live.scope": { ko: "Local / AWS 배포를 지원합니다. AWS는 팀 계정·기존 ECS 스택·DB 초기화가 필요합니다. 두 대상을 선택하면 자동 비교하며, 자동수정은 미지원입니다.", en: "Deploy to Local / AWS. AWS requires a configured team account, existing ECS stack and initialized database. Selecting both runs a comparison. Autofix is unsupported.", ja: "Local / AWS に配備できます。AWS はチームアカウント・既存 ECS スタック・DB 初期化が必要です。両方を選ぶと比較します。自動修正は未対応です。" },
  "live.candidate": { ko: "비교할 기존 환경 URL (선택)", en: "Existing candidate URL (optional)", ja: "既存の比較先 URL (任意)" },
  "live.compareHint": { ko: "Action 실행 시 새 로컬 배포와 이 주소를 비교합니다. 비우면 배포만 실행합니다.", en: "Action compares the new local deployment with this URL. Leave empty for deploy only.", ja: "Action で新しいローカル環境と比較します。空欄なら配備のみ。" },
  "live.compareTitle": { ko: "HTTP 시운전", en: "HTTP shakedown", ja: "HTTP 試運転" },
  "live.baseline": { ko: "기존 기준 환경 URL (새 배포 없이 비교할 때)", en: "Existing baseline URL (compare without deploying)", ja: "既存の基準 URL (配備せずに比較)" },
  "live.compareNow": { ko: "기존 두 환경 비교", en: "Compare existing environments", ja: "既存の二環境を比較" },
  "live.externalHint": { ko: "테스트 계정·글·댓글을 생성합니다. 본인 또는 팀이 관리하는 테스트 환경만 입력하세요. 기존 환경은 자동 배포·삭제·접속 차단하지 않습니다.", en: "Creates test accounts, posts and comments. Use test environments you control. Existing endpoints are not deployed, deleted or taken offline.", ja: "テストアカウント・投稿・コメントを作成します。管理するテスト環境のみ指定してください。既存環境の配備・削除・通信遮断はしません。" },
  "status.stopped": { ko: "중지됨", en: "stopped", ja: "停止済み" },
  "status.external": { ko: "기존 환경", en: "existing endpoint", ja: "既存環境" },
  "status.warned": { ko: "경고 · 검토 필요", en: "warning · review needed", ja: "警告 · 要確認" },
  "dep.warned": { ko: "시운전 경고: 결과를 검토하세요.", en: "Shakedown warning: review the evidence.", ja: "試運転の警告: 結果を確認してください。" },
  "dep.gateOnly": { ko: "검사 판정만 기록했습니다. 기존 환경의 접속은 차단하지 않았습니다.", en: "Release-gate verdict only. Existing endpoints remain accessible.", ja: "検査判定のみ。既存環境への接続は遮断していません。" },
  "live.lead": { ko: "레포를 분석하고 이미지를 빌드한 뒤, 선택한 Local 또는 준비된 AWS 환경에 PostgreSQL 앱을 배포합니다.", en: "Analyze a repository, build its image and deploy the PostgreSQL app to Local or a prepared AWS environment.", ja: "解析・ビルド後、PostgreSQL アプリを Local または準備済み AWS 環境に配備します。" },
  "dep.deployed": { ko: "로컬 배포 완료 · 시운전 미실행", en: "Locally deployed · shakedown not run", ja: "ローカル配備完了 · 試運転未実行" },
  "status.deployed": { ko: "배포 완료 · 미검사", en: "deployed · untested", ja: "配備完了 · 未検査" },
  "dep.promoted": { ko: "시운전 통과: 실행한 시나리오에서 두 환경이 동일하게 동작했습니다.", en: "Shakedown passed: both environments matched on the tested scenario.", ja: "試運転通過: 実行したシナリオで両環境の動作が一致しました。" },
  "dep.blocked": { ko: "차단됨: 환경마다 다르게 동작합니다.", en: "Blocked: the environments behave differently.", ja: "ブロック: 環境ごとに動作が異なります。" },
  "dep.failed": { ko: "실패", en: "Failed.", ja: "失敗" },
  "dep.working": { ko: "진행 중…", en: "Working…", ja: "進行中…" },
  "dep.instances": { ko: "인스턴스 {n}", en: "instances {n}", ja: "インスタンス {n}" },
  "dep.affinity": { ko: "세션 고정 {v}", en: "session affinity {v}", ja: "セッション固定 {v}" },
  on: { ko: "켬", en: "on", ja: "オン" },
  off: { ko: "끔", en: "off", ja: "オフ" },
  "dep.shakedown": { ko: "시운전", en: "Shakedown", ja: "試運転" },
  "dep.running": { ko: "진행 중", en: "running", ja: "実行中" },
  "dep.aiJourney": { ko: "AI가 쓴 사용 흐름", en: "AI wrote this journey", ja: "AI が作成した利用フロー" },
  "dep.savedJourney": { ko: "저장된 흐름 재사용 · AI ₩0", en: "Saved journey reused · AI ₩0", ja: "保存済みフローを再利用 · AI ₩0" },
  "dep.ruleJourney": { ko: "규칙 기반 흐름 (AI 미사용)", en: "Rule-based journey (AI unavailable)", ja: "ルールベースのフロー(AI 未使用)" },
  "dep.retry": {
    ko: "시운전 #{n}이 차단되어 {fix}을(를) 자동 적용한 뒤 다시 시도",
    en: "Retry after shakedown #{n} was blocked and {fix} was applied automatically.",
    ja: "試運転 #{n} がブロックされたため {fix} を自動適用して再試行",
  },
  "dep.appliedAfter": {
    ko: "이 시운전 뒤 {target}에 {fix} 적용 후 재배포",
    en: "After this shakedown: applied {fix} on {target} and redeployed.",
    ja: "この試運転の後、{target} に {fix} を適用して再デプロイ",
  },
  "dep.notRun": { ko: "시운전이 실행되지 않았습니다.", en: "Shakedown did not run.", ja: "試運転は実行されませんでした。" },
  "dep.waiting": { ko: "두 대상의 배포를 기다리는 중…", en: "Waiting for both targets…", ja: "両方のデプロイ先を待機中…" },
  "dep.log": { ko: "실시간 로그", en: "Live log", ja: "ライブログ" },
  "verdict.BLOCKED": { ko: "차단", en: "Blocked", ja: "ブロック" },
  "verdict.WARN": { ko: "경고와 함께 통과", en: "Passed with warnings", ja: "警告付きで合格" },
  "verdict.PASS": { ko: "통과", en: "Passed", ja: "合格" },
  "verdict.byRules": { ko: "· 규칙이 판정", en: "· decided by rules", ja: "· ルールが判定" },
  "report.deployTitle": { ko: "배포 보고서", en: "Deployment report", ja: "デプロイレポート" },
  "report.pending": {
    ko: "배포가 끝나면 결과, 소요 시간, 발견한 문제와 조치가 여기에 정리됩니다.",
    en: "When the deployment finishes, its result, timing, findings and fixes are summarized here.",
    ja: "デプロイが終わると、結果・所要時間・見つかった問題と対応がここにまとまります。",
  },
  "report.resultOk": { ko: "시운전 통과: 실행한 시나리오에서 두 환경이 동일하게 동작했습니다", en: "Shakedown passed: both environments matched on the tested scenario", ja: "試運転通過: 実行したシナリオで両環境の動作が一致しました" },
  "report.resultBad": { ko: "차단: 환경마다 다르게 동작합니다", en: "Blocked: environments behave differently", ja: "ブロック: 環境ごとに動作が異なります" },
  "report.time": { ko: "소요 시간", en: "Time", ja: "所要時間" },
  "report.targets": { ko: "대상별 결과", en: "Per target", ja: "環境別の結果" },
  "report.found": { ko: "발견한 문제", en: "Found", ja: "見つかった問題" },
  "report.action": { ko: "조치", en: "Action taken", ja: "対応" },
  "report.fixWorked": { ko: "자동 수정 후 재배포 → 시운전 {n}회차에서 통과", en: "Auto-fixed and redeployed → passed on shakedown #{n}", ja: "自動修正して再デプロイ → 試運転 {n} 回目で合格" },
  "report.fixFailed": { ko: "자동 수정 후에도 차단됨 (시운전 {n}회)", en: "Still blocked after the auto-fix ({n} shakedowns)", ja: "自動修正後もブロック(試運転 {n} 回)" },
  "report.manual": { ko: "자동 수정 대상이 아님 · 제안: {what}", en: "Not auto-fixable · suggestion: {what}", ja: "自動修正の対象外 · 提案: {what}" },
  "report.noFix": { ko: "수정 방법을 찾지 못함", en: "No fix found", ja: "修正方法が見つかりません" },
  "report.aiUsage": { ko: "AI 사용", en: "AI usage", ja: "AI の利用" },
  "home.details": { ko: "자세히 보기 →", en: "Details →", ja: "詳細 →" },
  "report.title": { ko: "원인 분석", en: "Cause analysis", ja: "原因分析" },
  "report.ai": { ko: "AI 분석", en: "AI analysis", ja: "AI 分析" },
  "report.rule": { ko: "알려진 패턴", en: "Known pattern", ja: "既知のパターン" },
  "report.fix": { ko: "수정", en: "Fix", ja: "修正" },
  "report.applied": { ko: "자동 적용됨", en: "auto-applied", ja: "自動適用済み" },
  "report.applicable": { ko: "자동 적용 가능", en: "auto-applicable", ja: "自動適用可能" },
  "report.suggestion": { ko: "제안만", en: "suggestion only", ja: "提案のみ" },
  "report.footer": {
    ko: "신뢰도: {c}. 보고서는 판정을 설명할 뿐, 판정을 바꾸지 않습니다.",
    en: "Confidence: {c}. The report explains the verdict; it never decides it.",
    ja: "信頼度: {c}。レポートは判定を説明するだけで、判定は変えません。",
  },
  "stage.building": { ko: "빌드", en: "Build", ja: "ビルド" },
  "stage.deploying": { ko: "배포", en: "Deploy", ja: "デプロイ" },
  "stage.shakedown": { ko: "시운전", en: "Shakedown", ja: "試運転" },
  "stage.analyzing": { ko: "분석", en: "Analyze", ja: "分析" },
  "stage.fixing": { ko: "수정·재배포", en: "Fix & redeploy", ja: "修正・再デプロイ" },
  "stage.verdict": { ko: "판정", en: "verdict", ja: "判定" },

  "step.step": { ko: "단계", en: "Step", ja: "ステップ" },
  "step.result": { ko: "결과", en: "Result", ja: "結果" },
  "step.running": { ko: "실행 중…", en: "running…", ja: "実行中…" },
  "step.hops": { ko: "HTTP 요청 경로", en: "HTTP hops", ja: "HTTP の経路" },
  "step.notExecuted": { ko: "실행되지 않음", en: "not executed", ja: "未実行" },
  "step.server": { ko: "서버 {n}", en: "server {n}", ja: "サーバー {n}" },
  "step.classified": { ko: "분류", en: "classified", ja: "分類" },
  "kind.same": { ko: "같음", en: "same", ja: "同じ" },
  "kind.differs": { ko: "다름", en: "differs", ja: "相違" },
  "kind.notReached": { ko: "도달 못 함", en: "not reached", ja: "未到達" },
  "kind.path_diff": { ko: "다른 페이지", en: "different page", ja: "別のページ" },
  "kind.both_failed": { ko: "둘 다 실패", en: "failed on both", ja: "両方で失敗" },
  "kind.text_diff": { ko: "내용 다름", en: "text differs", ja: "内容が異なる" },
  "kind.ignorable": { ko: "무시 가능한 차이", en: "ignorable diff", ja: "無視できる差分" },
  "kind.skipped": { ko: "건너뜀", en: "skipped", ja: "スキップ" },

  "tag.rule": { ko: "규칙", en: "Rule", ja: "ルール" },
  "tag.default": { ko: "기본값", en: "default", ja: "既定値" },

  // Status badges (values come from the engine; labels are translated here)
  "status.queued": { ko: "대기", en: "queued", ja: "待機" },
  "status.building": { ko: "빌드 중", en: "building", ja: "ビルド中" },
  "status.deploying": { ko: "배포 중", en: "deploying", ja: "デプロイ中" },
  "status.shakedown": { ko: "시운전 중", en: "shakedown", ja: "試運転中" },
  "status.analyzing": { ko: "분석 중", en: "analyzing", ja: "分析中" },
  "status.fixing": { ko: "수정 중", en: "fixing", ja: "修正中" },
  "status.promoted": { ko: "시운전 통과", en: "shakedown passed", ja: "試運転通過" },
  "status.blocked": { ko: "차단", en: "blocked", ja: "ブロック" },
  "status.failed": { ko: "실패", en: "failed", ja: "失敗" },
  "status.ready": { ko: "준비됨", en: "ready", ja: "準備完了" },
  "status.pending": { ko: "대기", en: "pending", ja: "待機" },
  "status.passed": { ko: "통과", en: "passed", ja: "合格" },
} as const;

export type Key = keyof typeof DICT;
type Vars = Record<string, string | number>;

const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: "ko", setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("ko");
  useEffect(() => {
    // ?lang=ja in a shared link wins over the viewer's saved choice.
    let wanted = new URLSearchParams(window.location.search).get("lang");
    try {
      wanted ??= localStorage.getItem("lang");
    } catch {}
    if (wanted && wanted in LANGS) {
      setLangState(wanted as Lang);
      document.documentElement.lang = wanted;
    }
  }, []);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("lang", l);
    } catch {}
    document.documentElement.lang = l;
  };
  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

function makeT(lang: Lang) {
  const t = (key: Key, vars?: Vars) => {
    let s: string = DICT[key][lang];
    for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{${k}}`, String(v));
    return s;
  };
  /** For keys built from data (e.g. a status value): falls back to the raw value. */
  t.maybe = (key: string, fallback: string) => (key in DICT ? t(key as Key) : fallback);
  /** "3s ago" in the current language. */
  t.ago = (ts: number) => {
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (s < 60) return t("ago.s", { n: s });
    if (s < 3600) return t("ago.m", { n: Math.round(s / 60) });
    return t("ago.h", { n: Math.round(s / 3600) });
  };
  return t;
}

// One stable translator per language, so components can be memoized on it.
const TRANSLATORS = Object.fromEntries((Object.keys(LANGS) as Lang[]).map((l) => [l, makeT(l)])) as Record<Lang, ReturnType<typeof makeT>>;

export function useT() {
  return TRANSLATORS[useContext(LangContext).lang];
}

export function LangSwitcher() {
  const { lang, setLang } = useContext(LangContext);
  return (
    <div className="flex rounded-md border border-line overflow-hidden text-xs">
      {(Object.keys(LANGS) as Lang[]).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className={`px-2.5 py-1 ${l === lang ? "bg-accent text-white" : "text-muted hover:text-text"}`}
        >
          {LANGS[l]}
        </button>
      ))}
    </div>
  );
}

export function Tagline() {
  const t = useT();
  return <span className="text-xs text-muted">{t("tagline")}</span>;
}
