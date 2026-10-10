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
  "pipe.autofix": { ko: "수정 적용: {fix}", en: "Fix applied: {fix}", ja: "修正適用: {fix}" },
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
  "project.autofix": { ko: "차단 뒤 수정 적용", en: "Fix after a block", ja: "ブロック後の修正適用" },
  "project.autofixDesc": {
    ko: "GCP에서 로그인이 풀려 차단되면, 원인 보고서의 버튼으로 세션 저장소를 공유 DB(session-jdbc)로 바꿔 같은 이미지로 GCP만 다시 배포하고 다시 시운전합니다. 코드와 데이터는 건드리지 않습니다.",
    en: "If GCP is blocked because the login is lost, a button in the cause report moves sessions to the shared database (session-jdbc), redeploys only GCP with the same image and reruns the shakedown. Never code or data.",
    ja: "GCP でログインが切れてブロックされたら、原因レポートのボタンでセッション保存先を共有 DB(session-jdbc)に変え、同じイメージで GCP だけ再デプロイして再試運転します。コードとデータは変更しません。",
  },
  "project.deployments": { ko: "배포 기록", en: "Deployments", ja: "デプロイ履歴" },
  "project.noDeployments": { ko: "아직 배포가 없습니다.", en: "No deployments yet.", ja: "デプロイはまだありません。" },
  "project.shakedowns": { ko: "시운전 {n}회", en: "{n} shakedown(s)", ja: "試運転 {n} 回" },
  "project.autofixed": { ko: "수정 적용: {x}", en: "fixed {x}", ja: "修正適用: {x}" },

  "dep.back": { ko: "← 프로젝트", en: "← Project", ja: "← プロジェクト" },
  "dep.title": { ko: "배포", en: "Deployment", ja: "デプロイ" },
  "dep.total": { ko: "전체", en: "Total", ja: "合計" },
  "dep.build": { ko: "빌드", en: "Build", ja: "ビルド" },
  "dep.deploy": { ko: "배포", en: "Deploy", ja: "デプロイ" },
  "dep.aiCost": { ko: "AI 비용", en: "AI cost", ja: "AI コスト" },
  "dep.calls": { ko: "호출 {n}회", en: "{n} calls", ja: "{n} 回呼び出し" },
  "live.needLocal": { ko: "배포 대상을 하나 이상 선택하세요.", en: "Select at least one deployment target.", ja: "配備先を選択してください。" },
  "live.scope": { ko: "Local / AWS / GCP / Azure 배포를 지원합니다. 클라우드는 미리 준비한 스택(AWS ECS, GCP Cloud Run·Cloud SQL, Azure Container Apps)과 DB 초기화가 필요합니다. 여러 클라우드를 함께 고를 수 있고, Local과 함께 고르면 클라우드마다 Local 기준으로 자동 비교합니다. 세션 고정은 GCP·Azure만 지원합니다. GCP에서 로그인이 풀려 차단되면 원인 보고서의 버튼으로 세션 저장소 수정(session-jdbc)을 적용해 다시 시운전할 수 있습니다.", en: "Deploy to Local / AWS / GCP / Azure. Clouds need a prepared stack (AWS ECS, GCP Cloud Run with Cloud SQL, Azure Container Apps) and an initialized database. Select as many clouds as you like; with Local selected, each cloud is compared against Local. Sticky sessions are GCP/Azure-only. If GCP is blocked because the login is lost, apply the session-store fix (session-jdbc) from the cause report and rerun.", ja: "Local / AWS / GCP / Azure に配備できます。クラウドは事前に用意したスタック(AWS ECS、GCP Cloud Run と Cloud SQL、Azure Container Apps)と DB 初期化が必要です。複数のクラウドを同時に選べ、Local と一緒に選ぶとクラウドごとに Local 基準で比較します。セッション固定は GCP・Azure のみ対応です。GCP でログインが切れてブロックされたら、原因レポートのボタンでセッション保存先の修正(session-jdbc)を適用して再試運転できます。" },
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
  "live.lead": { ko: "레포를 분석하고 이미지를 빌드한 뒤, 선택한 Local 또는 준비된 AWS·GCP·Azure 환경에 PostgreSQL 앱을 배포합니다.", en: "Analyze a repository, build its image and deploy the PostgreSQL app to Local or a prepared AWS, GCP or Azure environment.", ja: "解析・ビルド後、PostgreSQL アプリを Local または準備済み AWS・GCP・Azure 環境に配備します。" },
  "dep.deployed": { ko: "로컬 배포 완료 · 시운전 미실행", en: "Locally deployed · shakedown not run", ja: "ローカル配備完了 · 試運転未実行" },
  "status.deployed": { ko: "배포 완료 · 미검사", en: "deployed · untested", ja: "配備完了 · 未検査" },
  "dep.promoted": { ko: "시운전 통과: 실행한 시나리오에서 두 환경이 동일하게 동작했습니다.", en: "Shakedown passed: both environments matched on the tested scenario.", ja: "試運転通過: 実行したシナリオで両環境の動作が一致しました。" },
  "dep.blocked": { ko: "차단됨: 환경마다 다르게 동작합니다.", en: "Blocked: the environments behave differently.", ja: "ブロック: 環境ごとに動作が異なります。" },
  "dep.failed": { ko: "실패", en: "Failed.", ja: "失敗" },
  "dep.working": { ko: "진행 중…", en: "Working…", ja: "進行中…" },
  "dep.instances": { ko: "인스턴스 {n}", en: "instances {n}", ja: "インスタンス {n}" },
  "dep.affinity": { ko: "세션 고정 {v}", en: "session affinity {v}", ja: "セッション固定 {v}" },
  "dep.session": { ko: "세션 저장소 {v}", en: "session store {v}", ja: "セッション保存先 {v}" },
  on: { ko: "켬", en: "on", ja: "オン" },
  off: { ko: "끔", en: "off", ja: "オフ" },
  "dep.shakedown": { ko: "시운전", en: "Shakedown", ja: "試運転" },
  "dep.running": { ko: "진행 중", en: "running", ja: "実行中" },
  "dep.aiJourney": { ko: "AI가 쓴 사용 흐름", en: "AI wrote this journey", ja: "AI が作成した利用フロー" },
  "dep.savedJourney": { ko: "저장된 흐름 재사용 · AI ₩0", en: "Saved journey reused · AI ₩0", ja: "保存済みフローを再利用 · AI ₩0" },
  "dep.ruleJourney": { ko: "규칙 기반 흐름 (AI 미사용)", en: "Rule-based journey (AI unavailable)", ja: "ルールベースのフロー(AI 未使用)" },
  "dep.retry": {
    ko: "시운전 #{n}이 차단되어 {fix}을(를) 적용하고 다시 배포한 뒤 다시 시도",
    en: "Retry after shakedown #{n} was blocked and {fix} was applied and redeployed.",
    ja: "試運転 #{n} がブロックされたため {fix} を適用して再デプロイし再試行",
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
  "report.fixWorked": { ko: "수정 적용 후 재배포 → 시운전 {n}회차에서 통과", en: "Fix applied and redeployed → passed on shakedown #{n}", ja: "修正を適用して再デプロイ → 試運転 {n} 回目で合格" },
  "report.fixFailed": { ko: "수정 적용 후에도 차단됨 (시운전 {n}회)", en: "Still blocked after the fix ({n} shakedowns)", ja: "修正適用後もブロック(試運転 {n} 回)" },
  "report.fixReady": { ko: "자동 적용 가능 · 원인 분석의 버튼으로 적용: {what}", en: "Auto-applicable · apply it with the button in the cause analysis: {what}", ja: "自動適用可能 · 原因分析のボタンで適用: {what}" },
  "report.manual": { ko: "자동 수정 대상이 아님 · 제안: {what}", en: "Not auto-fixable · suggestion: {what}", ja: "自動修正の対象外 · 提案: {what}" },
  "report.noFix": { ko: "수정 방법을 찾지 못함", en: "No fix found", ja: "修正方法が見つかりません" },
  "report.aiUsage": { ko: "AI 사용", en: "AI usage", ja: "AI の利用" },
  "home.details": { ko: "자세히 보기 →", en: "Details →", ja: "詳細 →" },
  "report.title": { ko: "원인 분석", en: "Cause analysis", ja: "原因分析" },
  "report.ai": { ko: "AI 분석", en: "AI analysis", ja: "AI 分析" },
  "report.rule": { ko: "알려진 패턴", en: "Known pattern", ja: "既知のパターン" },
  "report.fix": { ko: "수정", en: "Fix", ja: "修正" },
  "report.applied": { ko: "적용됨", en: "applied", ja: "適用済み" },
  "report.applyFix": { ko: "수정 적용하고 다시 시운전", en: "Apply fix and rerun", ja: "修正を適用して再試運転" },
  "report.applying": { ko: "적용 요청 중…", en: "Applying…", ja: "適用を依頼中…" },
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
  // ---- Prototype layout (top bar, configure grid, run page) ----
  "ui.close": { ko: "닫기", en: "Close", ja: "閉じる" },
  "nav.overview": { ko: "개요", en: "Overview", ja: "概要" },
  "nav.live": { ko: "시운전", en: "Shakedown", ja: "試運転" },
  "nav.settings": { ko: "설정", en: "Settings", ja: "設定" },
  "nav.guide": { ko: "사용 가이드", en: "Guide", ja: "使い方" },
  "nav.main": { ko: "주 메뉴", en: "Main menu", ja: "メインメニュー" },
  "nav.workspace": { ko: "EMERALD 팀", en: "EMERALD TEAM", ja: "EMERALD チーム" },
  "nav.newAction": { ko: "새 Action", en: "New Action", ja: "新しい Action" },
  "nav.history": { ko: "Action 기록 보기", en: "View actions", ja: "Action 履歴" },
  "nav.api": { ko: "API 설정", en: "API settings", ja: "API 設定" },
  "guide.title": { ko: "Shakedown 사용 가이드", en: "How Shakedown works", ja: "Shakedown の使い方" },
  "guide.intro": { ko: "서버가 켜지는 것과 사용자가 실제로 앱을 쓸 수 있는 것은 다릅니다. Shakedown은 배포 후 같은 사용자 흐름을 두 환경에서 직접 실행해 확인합니다.", en: "A server being up is not the same as users being able to use the app. Shakedown runs the same user journey on both environments after deploying.", ja: "サーバーが起動することと、ユーザーが実際にアプリを使えることは違います。Shakedown はデプロイ後に同じ操作を両環境で実行して確認します。" },
  "guide.note": { ko: "Local은 이 컴퓨터의 Docker에서, 클라우드는 미리 준비한 스택에서 실행됩니다. 연결 상태는 설정에서 확인하세요.", en: "Local runs in Docker on this machine; clouds reuse prepared stacks. Check connections in Settings.", ja: "Local はこの PC の Docker、クラウドは事前に用意したスタックで実行します。接続状態は設定で確認してください。" },
  "guide.ok": { ko: "확인했습니다", en: "Got it", ja: "確認しました" },
  "conn.on": { ko: "배포 엔진에 연결됨", en: "Engine connected", ja: "エンジンに接続済み" },
  "conn.off": { ko: "배포 엔진에 연결할 수 없습니다 · 127.0.0.1:8700", en: "Engine unreachable · 127.0.0.1:8700", ja: "エンジンに接続できません · 127.0.0.1:8700" },
  "conn.checking": { ko: "배포 엔진 연결 확인 중", en: "Checking the engine", ja: "エンジン接続を確認中" },
  "conn.mock": { ko: "데모 데이터 · 엔진 미연결", en: "Demo data · engine not connected", ja: "デモデータ · エンジン未接続" },
  "bc.config": { ko: "프로젝트 설정", en: "Project setup", ja: "プロジェクト設定" },
  "bc.run": { ko: "시운전", en: "Shakedown", ja: "試運転" },
  "est.title": { ko: "예상 사용량", en: "Estimate", ja: "予想使用量" },
  "est.env": { ko: "실행 환경", en: "Environments", ja: "実行環境" },
  "est.shakedown": { ko: "시운전", en: "Shakedown", ja: "試運転" },
  "est.ai": { ko: "AI 예상 비용", en: "AI cost", ja: "AI 予想コスト" },
  "est.steps": { ko: "HTTP 8단계 사용자 흐름", en: "8-step HTTP user journey", ja: "HTTP 8 ステップの操作" },
  "est.deployOnly": { ko: "배포만 · 시운전 없음", en: "Deploy only · no shakedown", ja: "デプロイのみ · 試運転なし" },
  "est.aiNone": { ko: "규칙 보고서 · ₩0", en: "Rule report · ₩0", ja: "ルールレポート · ₩0" },
  "est.aiHint": { ko: "AI 보고서를 켰다면 실행 후 실제 토큰으로 산정합니다.", en: "With the AI report on, the cost is measured from real tokens after the run.", ja: "AI レポートを有効にすると実行後に実トークンで算出します。" },
  "est.analysisCost": { ko: "레포 분석 AI 호출 {n}회 · ₩{krw}", en: "Repo analysis: {n} AI calls · ₩{krw}", ja: "リポ解析 AI 呼び出し {n} 回 · ₩{krw}" },
  "est.note": { ko: "Local은 이 컴퓨터의 Docker에서 실행합니다. 클라우드는 미리 준비한 스택을 재사용하며 새 계정 자원을 만들지 않습니다.", en: "Local runs in Docker on this machine. Clouds reuse prepared stacks; no new account resources are created.", ja: "Local はこの PC の Docker で実行します。クラウドは事前に用意したスタックを再利用し、新しいリソースは作りません。" },
  "est.gate": { ko: "검사 통과 후 배포 판정", en: "Verdict after the checks", ja: "検査通過後に判定" },
  "est.gateDesc": { ko: "같은 사용자 흐름을 두 환경에서 HTTP로 실행하고, 차이가 있으면 규칙이 배포를 차단합니다.", en: "The same journey runs over HTTP on both environments; rules block the release on differences.", ja: "同じ操作を両環境で HTTP 実行し、違いがあればルールがリリースを止めます。" },
  "cfg.available": { ko: "사용 가능", en: "Available", ja: "利用可能" },
  "cfg.autoRun": { ko: "배포 후 시운전 자동 실행", en: "Run the shakedown after deploy", ja: "デプロイ後に試運転を自動実行" },
  "cfg.autoRunMeta": { ko: "대상 2개 또는 비교 URL이 있을 때 · 최대 3분", en: "With two targets or a comparison URL · up to 3 min", ja: "対象 2 つまたは比較 URL がある時 · 最大 3 分" },
  "cfg.imageOnly": { ko: "배포 없이 이미지 먼저 만들기", en: "Build the image first", ja: "デプロイせずイメージだけ作成" },
  "cfg.name": { ko: "프로젝트 이름", en: "Project name", ja: "プロジェクト名" },
  "cfg.stack": { ko: "프레임워크", en: "Framework", ja: "フレームワーク" },
  "cfg.autoDetect": { ko: "레포를 등록하면 자동 감지", en: "Detected when the repo is added", ja: "リポジトリ登録時に自動検出" },
  "cfg.port": { ko: "포트", en: "Port", ja: "ポート" },
  "cfg.health": { ko: "헬스체크 경로", en: "Health check path", ja: "ヘルスチェックパス" },
  "cfg.key": { ko: "키", en: "Key", ja: "キー" },
  "cfg.value": { ko: "값", en: "Value", ja: "値" },
  "cfg.detected": { ko: "자동", en: "auto", ja: "自動" },
  "cfg.baseline": { ko: "기준", en: "baseline", ja: "基準" },
  "hist.lead": { ko: "각 Action의 배포와 시운전 결과를 확인하세요.", en: "Deployments and shakedown verdicts for every action.", ja: "各 Action のデプロイと試運転の結果を確認できます。" },
  "hist.project": { ko: "프로젝트 / 배포", en: "Project / deployment", ja: "プロジェクト / デプロイ" },
  "hist.targets": { ko: "배포 대상", en: "Targets", ja: "デプロイ先" },
  "hist.result": { ko: "검사 결과", en: "Result", ja: "検査結果" },
  "hist.ai": { ko: "AI 사용량", en: "AI usage", ja: "AI 使用量" },
  "hist.time": { ko: "시간", en: "Time", ja: "時間" },
  "hist.detail": { ko: "상세", en: "Details", ja: "詳細" },
  "stat.total": { ko: "전체 Action", en: "All actions", ja: "全 Action" },
  "stat.passed": { ko: "검사 통과", en: "Passed", ja: "検査通過" },
  "stat.blocked": { ko: "검사 차단", en: "Blocked", ja: "検査ブロック" },
  "stat.running": { ko: "진행 중", en: "Running", ja: "進行中" },
  "run.tabLive": { ko: "실시간 검사", en: "Live", ja: "リアルタイム検査" },
  "run.tabReport": { ko: "결과 보고서", en: "Report", ja: "結果レポート" },
  "run.tabLogs": { ko: "로그", en: "Logs", ja: "ログ" },
  "run.project": { ko: "프로젝트 설정", en: "Project setup", ja: "プロジェクト設定" },
  "run.logs": { ko: "실행 기록", en: "Execution log", ja: "実行ログ" },
  "run.logsLive": { ko: "실시간 연결됨", en: "Live", ja: "接続中" },
  "run.logsDone": { ko: "실행 완료", en: "Finished", ja: "完了" },
  "run.logsEmpty": { ko: "첫 로그를 기다리고 있습니다.", en: "Waiting for the first log line.", ja: "最初のログを待っています。" },
  "run.open": { ko: "앱 열기", en: "Open app", ja: "アプリを開く" },
  "gate.passed": { ko: "모든 검사를 통과했습니다", en: "All checks passed", ja: "すべての検査に合格しました" },
  "gate.blocked": { ko: "차이가 발견되어 배포를 차단했습니다", en: "Differences found, release blocked", ja: "差異が見つかったためリリースをブロックしました" },
  "gate.pending": { ko: "검사 결과를 정리하고 있습니다", en: "Preparing the verdict", ja: "検査結果を整理しています" },
  "gate.pendingDesc": { ko: "검사가 끝나면 판정과 근거가 표시됩니다.", en: "The verdict and its evidence appear when the checks finish.", ja: "検査が終わると判定と根拠が表示されます。" },
  "report.decision": { ko: "배포 판정", en: "Release decision", ja: "リリース判定" },
  "report.result": { ko: "최종 결과", en: "Final result", ja: "最終結果" },
  "report.attempts": { ko: "시운전 횟수", en: "Shakedowns", ja: "試運転回数" },
  "report.evidence": { ko: "판정 근거", en: "Evidence", ja: "判定根拠" },
  "report.cause": { ko: "추정 원인", en: "Probable cause", ja: "推定原因" },
  "report.recommend": { ko: "권장 조치", en: "Recommended action", ja: "推奨対応" },
  "report.note": { ko: "AI의 분석 결과가 규칙 판정을 바꾸지는 않습니다.", en: "AI analysis never changes the rule verdict.", ja: "AI の分析結果がルール判定を変えることはありません。" },
  "report.noReport": { ko: "원인 분석은 시운전이 차단되었을 때 작성됩니다.", en: "A cause analysis is written when a shakedown is blocked.", ja: "原因分析は試運転がブロックされた時に作成されます。" },
  "usage.calls": { ko: "AI 호출", en: "AI calls", ja: "AI 呼び出し" },
  "usage.tokens": { ko: "입력 / 출력 토큰", en: "Input / output tokens", ja: "入力 / 出力トークン" },
  "usage.cost": { ko: "AI 비용", en: "AI cost", ja: "AI コスト" },
  "usage.time": { ko: "실행 시간", en: "Duration", ja: "実行時間" },
  "usage.note": { ko: "시운전 서비스가 보고한 실제 토큰 사용량입니다. 인프라 사용료는 포함되지 않습니다.", en: "Real token usage reported by the shakedown service. Infrastructure costs are not included.", ja: "試運転サービスが報告した実際のトークン使用量です。インフラ費用は含みません。" },
  "settings.title": { ko: "연결 설정", en: "Connections", ja: "接続設定" },
  "settings.lead": { ko: "배포 엔진과 AI 연결 상태를 확인하세요.", en: "Check the deploy engine and AI connections.", ja: "デプロイエンジンと AI の接続状態を確認します。" },
  "settings.engine": { ko: "배포 엔진", en: "Deploy engine", ja: "デプロイエンジン" },
  "settings.engineDesc": { ko: "127.0.0.1:8700에서 실행 중인 엔진이 레포 분석, 이미지 빌드, Local·클라우드 배포와 시운전을 조율합니다.", en: "The engine on 127.0.0.1:8700 analyzes repos, builds images and orchestrates Local/cloud deploys and shakedowns.", ja: "127.0.0.1:8700 のエンジンがリポ解析・イメージビルド・Local/クラウド配備と試運転を調整します。" },
  "settings.aiDesc": { ko: "규칙으로 Dockerfile을 만들 수 없을 때만 호출합니다. 키는 엔진 메모리에만 보관합니다.", en: "Called only when a Dockerfile cannot be generated by rules. Keys stay in engine memory.", ja: "ルールで Dockerfile を作れない時だけ呼び出します。キーはエンジンのメモリにのみ保持します。" },
  "settings.refresh": { ko: "상태 새로고침", en: "Refresh", ja: "状態を更新" },
  "settings.on": { ko: "연결됨", en: "Connected", ja: "接続済み" },
  "settings.off": { ko: "연결 안 됨", en: "Not connected", ja: "未接続" },
  "settings.checking": { ko: "확인 중", en: "Checking", ja: "確認中" },
  "home.needRepo": { ko: "레포 URL 또는 로컬 앱 경로를 입력하세요.", en: "Enter a repository URL or a local app path.", ja: "リポジトリ URL またはローカルパスを入力してください。" },
  "nav.projects": { ko: "프로젝트", en: "Project", ja: "プロジェクト" },
  "nav.pick": { ko: "선택", en: "select", ja: "選択" },
  "proj.title": { ko: "등록된 프로젝트", en: "Registered projects", ja: "登録済みプロジェクト" },
  "proj.lead": { ko: "엔진에 등록된 레포입니다. 프로젝트를 열면 대상·옵션을 바꿔 다시 Action을 실행할 수 있습니다.", en: "Repositories the engine knows. Open one to change targets and options and run another action.", ja: "エンジンに登録済みのリポジトリです。開くと対象やオプションを変えて再度 Action を実行できます。" },
  "proj.name": { ko: "프로젝트 / 저장소", en: "Project / repository", ja: "プロジェクト / リポジトリ" },
  "proj.last": { ko: "최근 배포", en: "Last deployment", ja: "直近のデプロイ" },
  "proj.added": { ko: "등록", en: "Added", ja: "登録" },
  "proj.none": { ko: "아직 등록된 프로젝트가 없습니다. 위에서 레포를 입력하고 Action을 실행하세요.", en: "No projects yet. Enter a repository above and run an action.", ja: "登録済みプロジェクトはありません。上でリポジトリを入力して Action を実行してください。" },
  "proj.open": { ko: "프로젝트 열기", en: "Open project", ja: "プロジェクトを開く" },
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
    <div className="lang-switch">
      {(Object.keys(LANGS) as Lang[]).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className={l === lang ? "active" : ""}
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
