"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// UI text only. Data coming from the engine (step titles, AI reports) is shown as received.
export const LANGS = { ko: "KR", en: "EN", ja: "JP" } as const;
export type Lang = keyof typeof LANGS;

const DICT = {
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
  "home.listError": { ko: "엔진에서 프로젝트·Action 목록을 받지 못했습니다: {detail}", en: "Could not load projects and actions from the engine: {detail}", ja: "エンジンからプロジェクトと Action の一覧を取得できませんでした: {detail}" },
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
    ko: "Local과 GCP만 골라 배포했을 때 GCP에서 로그인이 풀려 차단되면, 원인 보고서의 버튼으로 세션 저장소를 공유 DB(session-jdbc)로 바꿔 같은 이미지로 GCP만 다시 배포하고 다시 시운전합니다. 코드와 데이터는 건드리지 않습니다.",
    en: "When only Local and GCP are deployed and GCP is blocked because the login is lost, a button in the cause report moves sessions to the shared database (session-jdbc), redeploys only GCP with the same image and reruns the shakedown. Never code or data.",
    ja: "Local と GCP だけを配備して GCP でログインが切れてブロックされたら、原因レポートのボタンでセッション保存先を共有 DB(session-jdbc)に変え、同じイメージで GCP だけ再デプロイして再試運転します。コードとデータは変更しません。",
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
  "live.scope": { ko: "Local / AWS / Azure / GCP 배포를 지원합니다. 클라우드는 미리 준비한 스택(AWS ECS, Azure Container Apps, GCP Cloud Run과 Cloud SQL)과 DB 초기화가 필요합니다. 두 대상 이상을 선택하면 첫 대상(Local을 고르면 Local)을 기준으로 나머지 클라우드마다 자동 비교합니다. 세션 고정은 Azure와 GCP만 지원합니다. Local과 GCP만 골랐을 때 GCP에서 로그인이 풀려 차단되면 원인 보고서의 버튼으로 세션 저장소 수정(session-jdbc)을 적용해 다시 시운전할 수 있습니다.", en: "Deploy to Local / AWS / Azure / GCP. Clouds need a prepared stack (AWS ECS, Azure Container Apps, GCP Cloud Run with Cloud SQL) and an initialized database. Selecting two or more compares each remaining cloud against the first target (Local when selected). Sticky sessions are Azure and GCP only. With only Local and GCP selected, if GCP is blocked because the login is lost, apply the session-store fix (session-jdbc) from the cause report and rerun.", ja: "Local / AWS / Azure / GCP に配備できます。クラウドは事前に用意したスタック(AWS ECS、Azure Container Apps、GCP Cloud Run と Cloud SQL)と DB 初期化が必要です。2 つ以上選ぶと最初の対象(Local を選んだら Local)を基準に残りのクラウドごとに比較します。セッション固定は Azure と GCP のみ対応です。Local と GCP だけを選んだとき GCP でログインが切れてブロックされたら、原因レポートのボタンでセッション保存先の修正(session-jdbc)を適用して再試運転できます。" },
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
  "live.lead": { ko: "레포를 분석하고 이미지를 빌드한 뒤, 선택한 Local 또는 준비된 AWS·GCP·Azure 환경에 앱을 배포합니다. DB는 앱에 필요할 때만 연결합니다.", en: "Analyze a repository, build its image and deploy the app to Local or a prepared AWS, GCP or Azure environment. A database is attached only when the app needs one.", ja: "リポジトリを解析してイメージをビルドし、Local または準備済みの AWS・GCP・Azure 環境にアプリを配備します。DB はアプリに必要な場合だけ接続します。" },
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
  "dep.aiJourney": { ko: "AI가 만든 흐름", en: "AI-written journey", ja: "AI が作ったフロー" },
  "dep.savedJourney": { ko: "저장된 흐름", en: "Saved journey", ja: "保存済みフロー" },
  "dep.ruleJourney": { ko: "규칙 기반 흐름", en: "Rule-based journey", ja: "ルールベースのフロー" },
  "dep.retry": {
    ko: "{n}회차 시운전이 차단되어 다음 수정을 적용하고 다시 배포한 뒤 재시도했습니다: {fix}",
    en: "Shakedown #{n} was blocked, so this retry ran after applying and redeploying: {fix}",
    ja: "{n} 回目の試運転がブロックされたため、次の修正を適用して再デプロイしてから再試行しました: {fix}",
  },
  "dep.appliedAfter": {
    ko: "이 시운전 뒤 {target}에 다음 수정을 적용하고 다시 배포했습니다: {fix}",
    en: "After this shakedown, {target} was redeployed with: {fix}",
    ja: "この試運転の後、{target} に次の修正を適用して再デプロイしました: {fix}",
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
  "nav.newAction": { ko: "새 Action", en: "New Action", ja: "新しい Action" },
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
  "settings.aiDesc": { ko: "레포 분석·Dockerfile 생성(규칙으로 안 될 때)과 아키텍처 판단에 쓰는 배포 엔진의 Claude입니다. 시운전 서비스의 AI(원인 보고서·시나리오)와는 별개이며, 키는 엔진 메모리에만 보관합니다.", en: "The deploy engine's Claude, used for Dockerfiles (when rules cannot generate one) and architecture decisions. It is separate from the shakedown service's AI (cause reports, journeys). Keys stay in engine memory.", ja: "デプロイエンジンの Claude です。Dockerfile 生成(ルールで作れない時)とアーキテクチャ判断に使います。試運転サービスの AI(原因レポート・シナリオ)とは別で、キーはエンジンのメモリにのみ保持します。" },
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
  "settings.mock": { ko: "데모 모드입니다. 실제 엔진을 연결하면 설정할 수 있습니다.", en: "Demo mode. Connect a real engine to change settings.", ja: "デモモードです。実際のエンジンに接続すると設定できます。" },
  "settings.footnote": { ko: "엔진·Target·Shakedown 서비스는 loopback에서만 동작하는 개발용 구성입니다. 공개 멀티유저 서비스용 인증과 사용자별 키 격리는 범위에 없습니다.", en: "The engine, target and shakedown services are a loopback-only development setup. Authentication and per-user key isolation for a public multi-user service are out of scope.", ja: "エンジン・Target・Shakedown サービスは loopback 専用の開発構成です。公開マルチユーザー向けの認証やユーザー別キー分離は範囲外です。" },
  "ai.title": { ko: "배포 엔진 AI API 연결", en: "Deploy engine AI API connection", ja: "デプロイエンジンの AI API 接続" },
  "ai.lead": { ko: "규칙으로 Dockerfile을 생성할 수 없을 때 사용할 Claude 모델을 연결하세요. 모델을 선택한 뒤 연결 테스트 후 적용을 눌러주세요. 계정별 모델 사용 가능 여부도 함께 확인합니다.", en: "Connect the Claude model used when a Dockerfile cannot be generated by rules. Pick a model, then press Test and apply; model availability for your account is checked too.", ja: "ルールで Dockerfile を生成できない時に使う Claude モデルを接続します。モデルを選び、「接続テスト後に適用」を押してください。アカウントでのモデル利用可否も確認します。" },
  "ai.model": { ko: "모델 선택", en: "Model", ja: "モデル選択" },
  "ai.custom": { ko: "다른 모델 직접 입력", en: "Enter another model ID", ja: "他のモデルを直接入力" },
  "ai.modelId": { ko: "모델 ID", en: "Model ID", ja: "モデル ID" },
  "ai.modelIdPh": { ko: "사용할 Claude 모델 ID", en: "Claude model ID to use", ja: "使用する Claude モデル ID" },
  "ai.key": { ko: "API 키", en: "API key", ja: "API キー" },
  "ai.keyKeep": { ko: "비워두면 현재 키 사용", en: "Leave empty to keep the current key", ja: "空欄なら現在のキーを使用" },
  "ai.keyPh": { ko: "Anthropic API 키", en: "Anthropic API key", ja: "Anthropic API キー" },
  "ai.keyNote": { ko: "입력한 키는 엔진 메모리에만 보관하며 재시작하면 사라집니다. 연결 테스트는 짧은 API 요청을 보내므로 사용 요금이 발생할 수 있습니다. 이 설정은 이미지 계획용이며 기존 시운전 보고서 설정과 별개입니다.", en: "The key is kept only in engine memory and is gone after a restart. The connection test sends a short API request, so it may incur usage charges. This setting is for image planning and is separate from the shakedown report setting.", ja: "キーはエンジンのメモリにのみ保持され、再起動で消えます。接続テストは短い API リクエストを送るため利用料金が発生することがあります。この設定はイメージ計画用で、試運転レポートの設定とは別です。" },
  "ai.connect": { ko: "연결 테스트 후 적용", en: "Test and apply", ja: "接続テスト後に適用" },
  "ai.connecting": { ko: "연결 중…", en: "Connecting…", ja: "接続中…" },
  "ai.disconnect": { ko: "연결 해제", en: "Disconnect", ja: "接続解除" },
  "ai.loadError": { ko: "설정을 불러오지 못했습니다. 엔진 연결을 확인하세요.", en: "Could not load the settings. Check the engine connection.", ja: "設定を読み込めませんでした。エンジン接続を確認してください。" },
  "ai.connectError": { ko: "연결에 실패했습니다.", en: "Connection failed.", ja: "接続に失敗しました。" },
  "ai.disconnected": { ko: "현재 엔진의 API 연결을 해제했습니다.", en: "The engine's API connection was removed.", ja: "エンジンの API 接続を解除しました。" },
  "ai.connected": { ko: "Claude 응답을 확인했습니다. 규칙으로 생성할 수 없을 때 자동으로 호출합니다.", en: "Claude answered. It will be called automatically when rules cannot generate a Dockerfile.", ja: "Claude の応答を確認しました。ルールで生成できない時に自動で呼び出します。" },
  "ai.current": { ko: "현재 설정:", en: "Current:", ja: "現在の設定:" },
  "ai.stateVerified": { ko: "연결 확인됨", en: "Verified", ja: "接続確認済み" },
  "ai.stateConfigured": { ko: "설정됨 · 테스트 필요", en: "Configured · test needed", ja: "設定済み · テスト必要" },
  "ai.stateNone": { ko: "미연결", en: "Not connected", ja: "未接続" },
  "ui.skip": { ko: "본문으로 이동", en: "Skip to content", ja: "本文へ移動" },
  "ui.aiSettings": { ko: "AI API 설정", en: "AI API settings", ja: "AI API 設定" },
  "project.awsPlanNote": { ko: "Action 버튼은 기본으로 설계안 없이 배포합니다. 배포 대상 아래 '설계안 적용'을 켜거나 아키텍처 판단의 배포 버튼을 쓰면, 저장한 최신 등급을 고른 클라우드(AWS·GCP·Azure)마다 적용하고 그 클라우드의 인스턴스 수는 설계안이 정합니다.", en: "The Action button deploys without a design by default. Turn on 'Apply the saved design' under the targets, or use the deploy button in the architecture advisor, to apply the latest saved tier to each selected cloud (AWS, GCP, Azure); the design then sets their instance count.", ja: "Action ボタンは既定では設計案なしで配備します。デプロイ先の下の「設計案を適用」をオンにするか、アーキテクチャ判断の配備ボタンを使うと、保存済みの最新等級を選んだクラウド(AWS・GCP・Azure)ごとに適用し、そのクラウドのインスタンス数は設計案が決めます。" },
  "project.applyPlan": { ko: "설계안 적용: 저장한 아키텍처 등급을 고른 클라우드에 적용 (끄면 위 인스턴스 수와 기본 구성 사용)", en: "Apply the saved design: use the saved architecture tier on the selected clouds (off: the instance counts above and the default setup)", ja: "設計案を適用: 保存したアーキテクチャ等級を選んだクラウドに適用(オフなら上のインスタンス数と既定構成)" },
  "project.planCheckError": { ko: "아키텍처 선택 상태를 확인하지 못했습니다.", en: "Could not check the architecture selection.", ja: "アーキテクチャの選択状態を確認できませんでした。" },
  "arch.title": { ko: "아키텍처 판단", en: "Architecture advisor", ja: "アーキテクチャ判断" },
  "arch.lead": { ko: "저장소의 구조와 운영 요구를 함께 보고 소·중·대 설계안을 비교합니다. 현재는 HTTP 컨테이너 서비스용 설계 판단을 지원하며, 선택을 저장한 뒤 아래 배포 버튼으로 고른 클라우드(AWS·GCP·Azure)에 같은 등급을 적용할 수 있습니다. 선택 저장만으로는 과금 자원을 변경하지 않습니다.", en: "Compares small, medium and large designs from the repository structure and your operating requirements. Only HTTP container services are supported for now; save a choice, then apply the same tier to the clouds you pick (AWS, GCP, Azure) with the deploy button below. Saving alone changes no billable resources.", ja: "リポジトリ構造と運用要件から小・中・大の設計案を比較します。現在は HTTP コンテナサービス向けのみ対応し、選択を保存した後、下のデプロイボタンで選んだクラウド(AWS・GCP・Azure)に同じ等級を適用できます。保存だけでは課金リソースは変わりません。" },
  "arch.workload": { ko: "서비스 형태", en: "Workload", ja: "サービス形態" },
  "arch.wAuto": { ko: "코드에서 감지", en: "Detect from code", ja: "コードから検出" },
  "arch.wHttp": { ko: "HTTP 앱 / API", en: "HTTP app / API", ja: "HTTP アプリ / API" },
  "arch.wWorker": { ko: "백그라운드 워커", en: "Background worker", ja: "バックグラウンドワーカー" },
  "arch.wBatch": { ko: "배치 작업", en: "Batch job", ja: "バッチ処理" },
  "arch.wStatic": { ko: "정적 사이트", en: "Static site", ja: "静的サイト" },
  "arch.rps": { ko: "예상 피크 요청 수 (RPS)", en: "Expected peak requests (RPS)", ja: "想定ピークリクエスト数 (RPS)" },
  "arch.rpsPh": { ko: "모르면 비워 두세요", en: "Leave empty if unknown", ja: "不明なら空欄" },
  "arch.avail": { ko: "가용성 요구", en: "Availability", ja: "可用性要件" },
  "arch.unknown": { ko: "미정", en: "Unknown", ja: "未定" },
  "arch.aBest": { ko: "일시 중단 허용 / 데모", en: "Downtime acceptable / demo", ja: "一時停止許容 / デモ" },
  "arch.aHigh": { ko: "다중 AZ 필요", en: "Multi-AZ required", ja: "マルチ AZ 必須" },
  "arch.traffic": { ko: "트래픽 변화", en: "Traffic pattern", ja: "トラフィック変動" },
  "arch.tSteady": { ko: "비교적 일정", en: "Mostly steady", ja: "ほぼ一定" },
  "arch.tBursty": { ko: "급증 가능", en: "Bursty", ja: "急増あり" },
  "arch.priority": { ko: "우선순위", en: "Priority", ja: "優先順位" },
  "arch.pBalanced": { ko: "균형", en: "Balanced", ja: "バランス" },
  "arch.pCost": { ko: "비용", en: "Cost", ja: "コスト" },
  "arch.pAvail": { ko: "가용성", en: "Availability", ja: "可用性" },
  "arch.useAi": { ko: "연결된 Claude로 판단", en: "Decide with the connected Claude", ja: "接続済みの Claude で判断" },
  "arch.run": { ko: "아키텍처 판단하기", en: "Evaluate architecture", ja: "アーキテクチャを判断" },
  "arch.busy": { ko: "처리 중…", en: "Working…", ja: "処理中…" },
  "arch.costNote": { ko: "AI 연결 시 요청당 1회 호출하며 요금이 발생할 수 있습니다. 운영 입력과 스택·DB·의존성·README 키워드 등 추출 정보만 전송합니다. 미연결 시 규칙 판단을 사용합니다.", en: "With AI connected, one call per request may incur charges. Only extracted facts (your inputs, stack, DB, dependencies, README keywords) are sent. Without AI, rules decide.", ja: "AI 接続時はリクエストごとに 1 回呼び出し、料金が発生することがあります。運用入力・スタック・DB・依存関係・README キーワードなど抽出情報のみ送信します。未接続時はルールで判断します。" },
  "arch.saved": { ko: "저장한 설계: {name}", en: "Saved design: {name}", ja: "保存した設計: {name}" },
  "arch.recommended": { ko: "추천: {name}", en: "Recommended: {name}", ja: "推奨: {name}" },
  "arch.needsMore": { ko: "추가 설계가 필요합니다", en: "Further design input needed", ja: "追加の設計が必要です" },
  "arch.byAi": { ko: "Claude 판단", en: "Decided by Claude", ja: "Claude の判断" },
  "arch.byRule": { ko: "규칙 판단", en: "Decided by rules", ja: "ルールの判断" },
  "arch.dirty": { ko: "운영 입력이 바뀌었습니다. 아래 결과는 이전 입력 기준이며, 다시 판단해야 선택할 수 있습니다.", en: "Inputs changed. The result below is for the previous inputs; evaluate again before selecting.", ja: "入力が変わりました。下の結果は以前の入力に基づくもので、再判断してから選択できます。" },
  "arch.missing": { ko: "확인할 운영 요구", en: "Inputs to confirm", ja: "確認が必要な運用要件" },
  "arch.blockers": { ko: "현재 설계 적용을 막는 항목", en: "Blocking items", ja: "設計適用を妨げる項目" },
  "arch.caption": { ko: "AWS 기준 설계안(ALB와 ECS Fargate) · CPU/메모리/확장 수치는 부하 테스트 전 가정 · GCP·Azure 수치는 아래 클라우드별 사양을 보세요", en: "AWS reference designs (ALB + ECS Fargate) · CPU, memory and scaling figures are assumptions before load testing · see the per-cloud specs below for GCP and Azure", ja: "AWS 基準の設計案(ALB と ECS Fargate) · CPU/メモリ/拡張値は負荷テスト前の仮定 · GCP・Azure の値は下のクラウド別仕様を参照" },
  "arch.col": { ko: "구성", en: "Design", ja: "構成" },
  "arch.tag": { ko: "추천", en: "recommended", ja: "推奨" },
  "arch.rowRes": { ko: "태스크당 자원", en: "Resources per task", ja: "タスクあたりリソース" },
  "arch.rowTasks": { ko: "태스크 / AZ", en: "Tasks / AZs", ja: "タスク / AZ" },
  "arch.tasksVal": { ko: "{min}–{max}개 / {az} AZ", en: "{min}–{max} / {az} AZ", ja: "{min}–{max} 個 / {az} AZ" },
  "arch.rowScale": { ko: "확장", en: "Scaling", ja: "拡張" },
  "arch.autoscale": { ko: "CPU 목표 추적 자동 확장", en: "CPU target-tracking autoscaling", ja: "CPU 目標追跡の自動拡張" },
  "arch.fixed": { ko: "고정 용량", en: "Fixed capacity", ja: "固定容量" },
  "arch.rowData": { ko: "데이터 계층", en: "Data tier", ja: "データ層" },
  "arch.rowReview": { ko: "검토 사항", en: "Trade-offs", ja: "検討事項" },
  "arch.rowSelect": { ko: "설계안 저장", en: "Save design", ja: "設計案を保存" },
  "arch.chosen": { ko: "선택됨", en: "Selected", ja: "選択済み" },
  "arch.choose": { ko: "이 설계 선택", en: "Select this design", ja: "この設計を選択" },
  "arch.deploy": { ko: "{tier} 구성으로 배포 (Local + {clouds})", en: "Deploy with the {tier} design (Local + {clouds})", ja: "{tier} 構成で配備 (Local + {clouds})" },
  "arch.deploying": { ko: "배포 준비 중…", en: "Preparing deployment…", ja: "デプロイ準備中…" },
  "arch.deployNote": { ko: "고른 클라우드의 기존 앱 배포를 교체하고 Local을 기준으로 시운전합니다. 배포 준비 중 접근이 중단되며 클라우드 요금이 발생합니다. AWS 관리형 PostgreSQL은 RDS 가용성도 바뀝니다. 환경 정리는 앱을 멈추지만 DB와 기반 스택은 유지합니다.", en: "Replaces the current app deployment on the selected clouds and runs the shakedown against Local. Access is interrupted while preparing and cloud charges apply. On AWS with managed PostgreSQL, RDS availability changes too. Cleaning up removes the app but keeps the DB and base stack.", ja: "選んだクラウドの既存アプリ配備を置き換え、Local を基準に試運転します。準備中はアクセスが中断し、クラウド料金が発生します。AWS のマネージド PostgreSQL は RDS の可用性も変わります。環境の片付けはアプリを止めますが DB と基盤スタックは残ります。" },
  "arch.details": { ko: "분석 근거와 주의사항", en: "Evidence and caveats", ja: "分析根拠と注意事項" },
  "arch.facts": { ko: "감지 스택: {stack} / 서비스 형태: {workload}", en: "Detected stack: {stack} / workload: {workload}", ja: "検出スタック: {stack} / サービス形態: {workload}" },
  "arch.loadError": { ko: "저장된 설계안을 가져오지 못했습니다.", en: "Could not load the saved design.", ja: "保存済み設計案を取得できませんでした。" },
  "arch.failed": { ko: "아키텍처 판단 실패", en: "Architecture evaluation failed", ja: "アーキテクチャ判断に失敗" },
  "arch.deployFailed": { ko: "배포 시작 실패", en: "Could not start the deployment", ja: "デプロイ開始に失敗" },
  "img.title": { ko: "Docker 이미지 만들기", en: "Build a Docker image", ja: "Docker イメージ作成" },
  "img.lead": { ko: "기존 Dockerfile을 사용하거나 지원하는 스택에 맞춰 생성합니다. 원본 저장소를 수정하지 않으며, 이 작업은 배포 없이 이미지까지만 만듭니다.", en: "Uses an existing Dockerfile or generates one for supported stacks. The repository is not modified and nothing is deployed; only the image is built.", ja: "既存の Dockerfile を使うか、対応スタック向けに生成します。元のリポジトリは変更せず、配備せずイメージだけ作ります。" },
  "img.runtime": { ko: "런타임 버전 (선택)", en: "Runtime version (optional)", ja: "ランタイムバージョン(任意)" },
  "img.runtimePh": { ko: "자동 감지 · 예: 21, 22, 3.12", en: "Auto-detected · e.g. 21, 22, 3.12", ja: "自動検出 · 例: 21, 22, 3.12" },
  "img.entry": { ko: "FastAPI 실행 대상 (선택)", en: "FastAPI entrypoint (optional)", ja: "FastAPI 実行対象(任意)" },
  "img.entryPh": { ko: "예: main:app", en: "e.g. main:app", ja: "例: main:app" },
  "img.note": { ko: "규칙으로 생성할 수 없으면 연결된 Claude를 자동 호출합니다. 파일명·의존성 이름·실행 대상 등 추출 정보만 보내며 원본 코드·README·환경변수 값은 보내지 않습니다. 이때 API 요금이 발생할 수 있습니다.", en: "If rules cannot generate one, the connected Claude is called automatically. Only extracted facts (file names, dependency names, entrypoints) are sent, never source, README or env values. API charges may apply.", ja: "ルールで生成できない場合は接続済みの Claude を自動で呼び出します。ファイル名・依存関係名・実行対象など抽出情報のみ送り、ソース・README・環境変数の値は送りません。API 料金が発生することがあります。" },
  "img.generate": { ko: "빌드 계획 생성", en: "Generate build plan", ja: "ビルド計画を生成" },
  "img.generating": { ko: "계획 생성 중…", en: "Generating…", ja: "計画を生成中…" },
  "img.source": { ko: "생성 방식: {how}", en: "Source: {how}", ja: "生成方式: {how}" },
  "img.srcExisting": { ko: "기존 Dockerfile", en: "existing Dockerfile", ja: "既存の Dockerfile" },
  "img.srcAi": { ko: "AI 자동 생성 · 구조 검증 완료", en: "AI-generated · structure validated", ja: "AI 自動生成 · 構造検証済み" },
  "img.srcRule": { ko: "규칙 기반 템플릿", en: "rule-based template", ja: "ルールベースのテンプレート" },
  "img.runtimeOf": { ko: "런타임 {rt}", en: "runtime {rt}", ja: "ランタイム {rt}" },
  "img.fallback": { ko: "AI 호출 이유: {why}", en: "Why AI was called: {why}", ja: "AI 呼び出しの理由: {why}" },
  "img.build": { ko: "확인한 계획으로 이미지 빌드", en: "Build the image from this plan", ja: "確認した計画でイメージをビルド" },
  "img.stQueued": { ko: "대기 중", en: "Queued", ja: "待機中" },
  "img.stBuilding": { ko: "이미지 빌드 중", en: "Building the image", ja: "イメージをビルド中" },
  "img.stBuilt": { ko: "이미지 빌드 완료 · 앱 실행 미검증", en: "Image built · app not yet run", ja: "イメージビルド完了 · アプリ実行は未検証" },
  "img.stFailed": { ko: "이미지 빌드 실패", en: "Image build failed", ja: "イメージビルド失敗" },
  "img.planFail": { ko: "계획 생성 실패", en: "Plan generation failed", ja: "計画生成に失敗" },
  "img.buildFail": { ko: "빌드 시작 실패", en: "Could not start the build", ja: "ビルド開始に失敗" },
  "img.statusFail": { ko: "빌드 상태를 가져오지 못했습니다. 엔진을 재시작했다면 계획을 다시 생성하세요.", en: "Could not fetch the build status. If the engine restarted, generate the plan again.", ja: "ビルド状態を取得できませんでした。エンジンを再起動した場合は計画を再生成してください。" },
  "rt.title": { ko: "HTTP 앱 실행 설정", en: "HTTP app runtime", ja: "HTTP アプリ実行設定" },
  "rt.lead": { ko: "언어와 관계없이 단일 HTTP 컨테이너를 실행합니다. 앱은 0.0.0.0에서 연결을 받고 헬스체크에 200을 반환해야 합니다. 저장 전에는 기존 샘플 배포 설정을 사용합니다.", en: "Runs a single HTTP container regardless of language. The app must listen on 0.0.0.0 and answer the health check with 200. Until saved, the sample deployment settings are used.", ja: "言語を問わず単一の HTTP コンテナを実行します。アプリは 0.0.0.0 で接続を受け、ヘルスチェックに 200 を返す必要があります。保存前はサンプル配備設定を使います。" },
  "rt.legend": { ko: "실행 설정", en: "Runtime settings", ja: "実行設定" },
  "rt.port": { ko: "앱 포트", en: "App port", ja: "アプリポート" },
  "rt.health": { ko: "헬스체크 경로", en: "Health check path", ja: "ヘルスチェックパス" },
  "rt.db": { ko: "데이터베이스", en: "Database", ja: "データベース" },
  "rt.dbNone": { ko: "DB 없음", en: "No database", ja: "DB なし" },
  "rt.dbPostgres": { ko: "관리형 PostgreSQL", en: "Managed PostgreSQL", ja: "マネージド PostgreSQL" },
  "rt.dbMysql": { ko: "관리형 MySQL", en: "Managed MySQL", ja: "マネージド MySQL" },
  "rt.dbMongo": { ko: "MongoDB (AWS: 3 AZ replica set)", en: "MongoDB (AWS: 3-AZ replica set)", ja: "MongoDB (AWS: 3 AZ レプリカセット)" },
  "rt.dbExternal": { ko: "기존 외부 DB 연결", en: "Existing external database", ja: "既存の外部 DB に接続" },
  "rt.dbName": { ko: "DB 이름", en: "Database name", ja: "DB 名" },
  "rt.bindings": { ko: "앱의 DB 환경변수 연결 (JSON)", en: "App DB environment bindings (JSON)", ja: "アプリの DB 環境変数バインド (JSON)" },
  "rt.bindingsNote": { ko: "환경변수 이름을 앱에 맞게 바꾸세요. 값은 host, port, name, username, password, jdbc_url, postgres_url, mysql_url, mongodb_url 중 선택합니다. 선택한 DB에 맞는 URL 바인딩을 사용하세요. PostgreSQL 예: {example}로 설정하세요. AWS에서는 준비된 DB 엔진·이름과 일치해야 합니다. AWS MongoDB는 3 AZ TLS replica set으로 구성됩니다.", en: "Rename the variables to match your app. Values are one of host, port, name, username, password, jdbc_url, postgres_url, mysql_url, mongodb_url; use the URL binding for the chosen DB, e.g. PostgreSQL: {example}. On AWS the engine and name must match the provisioned DB. AWS MongoDB is a 3-AZ TLS replica set.", ja: "環境変数名はアプリに合わせて変更します。値は host, port, name, username, password, jdbc_url, postgres_url, mysql_url, mongodb_url から選び、選んだ DB に合う URL バインドを使います。PostgreSQL の例: {example}。AWS では用意した DB エンジン・名前と一致させます。AWS の MongoDB は 3 AZ TLS レプリカセットです。" },
  "rt.more": { ko: "환경변수·비밀값 참조·DB 초기화", en: "Environment, secret references, DB init", ja: "環境変数・シークレット参照・DB 初期化" },
  "rt.env": { ko: "일반 환경변수 (JSON)", en: "Environment variables (JSON)", ja: "環境変数 (JSON)" },
  "rt.refs": { ko: "비밀값 참조 (JSON)", en: "Secret references (JSON)", ja: "シークレット参照 (JSON)" },
  "rt.refsNote": { ko: "비밀값 자체를 입력하지 마세요. 예: {example} — 해당 이름을 로컬 Secret 파일 또는 AWS 어댑터의 Secrets Manager 매핑에 먼저 등록하세요. 외부 DB는 연결만 하며 생성·변경하지 않습니다.", en: "Never enter the secret itself. Example: {example}; register that name in the local secrets file or the AWS adapter's Secrets Manager mapping first. External databases are only connected, never created or changed.", ja: "シークレットの値そのものは入力しないでください。例: {example}。その名前をローカルのシークレットファイルか AWS アダプターの Secrets Manager マッピングに先に登録します。外部 DB は接続のみで作成・変更しません。" },
  "rt.init": { ko: "DB 초기화 명령 (JSON 배열, 생략 시 [])", en: "DB init command (JSON array, default [])", ja: "DB 初期化コマンド (JSON 配列、省略時 [])" },
  "rt.initNote": { ko: "예: [\"python\",\"migrate.py\"]. 같은 이미지에서 배포마다 1회 실행하고 성공해야 앱을 시작합니다. 반복 실행해도 안전한 명령을 사용하세요.", en: "e.g. [\"python\",\"migrate.py\"]. Runs once per deployment from the same image and must succeed before the app starts; use an idempotent command.", ja: "例: [\"python\",\"migrate.py\"]。同じイメージで配備ごとに 1 回実行し、成功後にアプリを起動します。繰り返し実行しても安全なコマンドを使ってください。" },
  "rt.save": { ko: "실행 설정 저장", en: "Save runtime settings", ja: "実行設定を保存" },
  "rt.saving": { ko: "저장 중…", en: "Saving…", ja: "保存中…" },
  "rt.saved": { ko: "저장했어요. 아키텍처 설계는 새 설정으로 다시 판단하세요.", en: "Saved. Re-evaluate the architecture with the new settings.", ja: "保存しました。アーキテクチャは新しい設定で再判断してください。" },
  "rt.invalid": { ko: "실행 설정을 확인하세요.", en: "Check the runtime settings.", ja: "実行設定を確認してください。" },
  "https.title": { ko: "사용자 도메인 · HTTPS", en: "Custom domain · HTTPS", ja: "カスタムドメイン · HTTPS" },
  "https.lead": { ko: "배포한 앱에 도메인을 연결합니다. 안내된 DNS 레코드를 등록하면 인증서와 실제 접속을 확인합니다.", en: "Attach a domain to the deployed app. Once the listed DNS records exist, the certificate and real access are verified.", ja: "配備したアプリにドメインを接続します。案内された DNS レコードを登録すると証明書と実際の接続を確認します。" },
  "https.mock": { ko: "미리보기 모드입니다. 실제 HTTPS 설정은 엔진을 연결한 후 사용할 수 있습니다.", en: "Preview mode. Real HTTPS setup needs a connected engine.", ja: "プレビューモードです。実際の HTTPS 設定はエンジン接続後に使えます。" },
  "https.target": { ko: "배포 대상", en: "Target", ja: "デプロイ先" },
  "https.tGcp": { ko: "GCP 로드밸런서", en: "GCP load balancer", ja: "GCP ロードバランサー" },
  "https.tLocal": { ko: "로컬", en: "Local", ja: "ローカル" },
  "https.mode": { ko: "연결 방식", en: "Method", ja: "接続方式" },
  "https.mCaddy": { ko: "Caddy 직접 연결", en: "Caddy direct", ja: "Caddy 直接接続" },
  "https.domain": { ko: "서브도메인", en: "Subdomain", ja: "サブドメイン" },
  "https.connect": { ko: "HTTPS 연결", en: "Connect HTTPS", ja: "HTTPS を接続" },
  "https.connecting": { ko: "설정 요청 중…", en: "Requesting…", ja: "設定を依頼中…" },
  "https.loading": { ko: "연결 상태를 불러오고 있습니다…", en: "Loading connection status…", ja: "接続状態を読み込み中…" },
  "https.statusError": { ko: "연결 상태를 확인할 수 없습니다.", en: "Could not check the connection status.", ja: "接続状態を確認できません。" },
  "https.requestError": { ko: "요청을 처리하지 못했습니다.", en: "The request failed.", ja: "リクエストを処理できませんでした。" },
  "https.connError": { ko: "연결 오류", en: "Connection error", ja: "接続エラー" },
  "https.blockedReady": { ko: "HTTPS 구성 완료 · 배포 경로 차단됨", en: "HTTPS configured · deployment route blocked", ja: "HTTPS 構成完了 · 配備経路はブロック中" },
  "https.recheck": { ko: "DNS·접속 다시 확인", en: "Re-check DNS and access", ja: "DNS・接続を再確認" },
  "https.rechecking": { ko: "확인 요청 중…", en: "Re-checking…", ja: "確認を依頼中…" },
  "https.dnsLead": { ko: "도메인 관리 화면에서 다음 레코드를 직접 등록하세요. 인증서 검증 레코드는 갱신을 위해 유지합니다.", en: "Add these records in your DNS provider. Keep the certificate validation record for renewals.", ja: "DNS 管理画面で次のレコードを登録してください。証明書検証レコードは更新のため残します。" },
  "https.dnsType": { ko: "유형", en: "Type", ja: "種類" },
  "https.dnsName": { ko: "이름", en: "Name", ja: "名前" },
  "https.dnsValue": { ko: "값", en: "Value", ja: "値" },
  "https.url": { ko: "접속 주소:", en: "URL:", ja: "接続先:" },
  "https.cert": { ko: "인증서 만료: {date} · 자동 갱신", en: "Certificate expires: {date} · auto-renewed", ja: "証明書期限: {date} · 自動更新" },
  "https.internal": { ko: "공개 진입점 이후 연결: {v}. HTTPS 준비 완료와 앱 기능 검사 통과는 별도로 판정합니다.", en: "Connection behind the public entry point: {v}. HTTPS readiness and the app shakedown are judged separately.", ja: "公開エントリ以降の接続: {v}。HTTPS 準備完了とアプリ検査の合格は別に判定します。" },
  "https.unverified": { ko: "미확인", en: "unverified", ja: "未確認" },
  "https.s.preflight": { ko: "연결 확인 중", en: "Checking", ja: "接続確認中" },
  "https.s.dns_pending": { ko: "DNS 설정 대기", en: "Waiting for DNS", ja: "DNS 設定待ち" },
  "https.s.certificate_pending": { ko: "인증서 발급 중", en: "Issuing certificate", ja: "証明書発行中" },
  "https.s.applying": { ko: "HTTPS 연결 중", en: "Applying HTTPS", ja: "HTTPS 接続中" },
  "https.s.verifying": { ko: "접속 검증 중", en: "Verifying access", ja: "接続検証中" },
  "https.s.ready": { ko: "사용 가능", en: "Ready", ja: "利用可能" },
  "https.s.needs_action": { ko: "확인 필요", en: "Action needed", ja: "要確認" },
  "https.s.failed": { ko: "설정 실패", en: "Setup failed", ja: "設定失敗" },
  "https.serviceOff": { ko: "HTTPS 연결 서비스가 꺼져 있습니다.", en: "The HTTPS service is not running.", ja: "HTTPS 接続サービスが停止しています。" },
  "https.serviceHint": { ko: "엔진에 SHAKEDOWN_HTTPS_URL(127.0.0.1:9301)을 설정하고 서비스를 켜면 사용할 수 있습니다.", en: "Set SHAKEDOWN_HTTPS_URL (127.0.0.1:9301) on the engine and start the service to use it.", ja: "エンジンに SHAKEDOWN_HTTPS_URL(127.0.0.1:9301)を設定してサービスを起動すると使えます。" },

  // ---- Service status (GET /api/services) ----
  "svc.offline": { ko: "연결 안 됨", en: "Offline", ja: "未接続" },
  "est.aiOn": { ko: "AI 보고서·시나리오를 쓸 수 있음 · 실행 후 실제 토큰으로 과금", en: "AI report and journey may be used · billed by real tokens after the run", ja: "AI レポート・シナリオを使う場合あり · 実行後に実トークンで課金" },
  "est.aiOnHint": { ko: "보통 1회 약 ₩30", en: "Typically about ₩30 per run", ja: "通常 1 回あたり約 ₩30" },
  "report.journey": { ko: "사용 흐름", en: "Journey", ja: "利用フロー" },
  "report.noAi": { ko: "AI 미사용", en: "No AI used", ja: "AI 未使用" },
  "report.pastTitle": { ko: "{n}회차 차단 원인 (수정 완료)", en: "Why shakedown #{n} was blocked (fixed)", ja: "{n} 回目のブロック原因(修正済み)" },
  "report.pastCause": { ko: "당시 원인", en: "Cause at the time", ja: "当時の原因" },
  "fix.sessionJdbc": { ko: "세션 저장소를 DB로 변경(session-jdbc)", en: "Moved sessions to the database (session-jdbc)", ja: "セッション保存先を DB に変更(session-jdbc)" },
  "settings.shakedown": { ko: "시운전 서비스", en: "Shakedown service", ja: "試運転サービス" },
  "settings.shakedownDesc": { ko: "127.0.0.1:9201에서 고른 환경들에 같은 사용자 흐름을 실행하고 원인 보고서를 씁니다. AI 키는 이 서비스에 따로 설정하며, 아래 엔진 Claude 설정과 별개입니다.", en: "Runs the same user journey on the selected environments from 127.0.0.1:9201 and writes the cause report. Its AI key is configured on this service, separately from the engine's Claude below.", ja: "127.0.0.1:9201 で選んだ環境に同じ操作を実行し、原因レポートを書きます。AI キーはこのサービスに別途設定し、下のエンジンの Claude 設定とは別です。" },
  "settings.serviceOff": { ko: "꺼짐", en: "Off", ja: "停止中" },
  "settings.aiOn": { ko: "AI 연결됨 · {model}", en: "AI connected · {model}", ja: "AI 接続済み · {model}" },
  "settings.aiRules": { ko: "규칙 보고서만", en: "Rule reports only", ja: "ルールレポートのみ" },
  "settings.unknown": { ko: "알 수 없음 (엔진이 상태를 알려 주지 않음)", en: "Unknown (the engine does not report it)", ja: "不明(エンジンが状態を返しません)" },
  "settings.targets": { ko: "배포 대상 서버", en: "Target servers", ja: "デプロイ先サーバー" },
  "settings.targetsDesc": { ko: "엔진이 각 대상 어댑터에 짧게 물어본 연결 상태입니다. 연결 안 된 대상은 배포 화면에서 고를 수 없습니다.", en: "Connection state the engine got from each target adapter. Offline targets cannot be selected for a deployment.", ja: "エンジンが各デプロイ先アダプターに確認した接続状態です。未接続の対象はデプロイ画面で選べません。" },
  "settings.engineAi": { ko: "배포 엔진의 Claude", en: "Deploy engine's Claude", ja: "デプロイエンジンの Claude" },

  // ---- Clean up (POST /api/deployments/{id}/stop) ----
  "dep.stop": { ko: "환경 정리", en: "Clean up environments", ja: "環境を片付ける" },
  "dep.stopping": { ko: "정리 중…", en: "Cleaning up…", ja: "片付け中…" },
  "dep.stopConfirm": { ko: "이 배포로 만든 환경(Local·클라우드의 앱)을 삭제합니다. 판정 결과와 기록은 그대로 남습니다. 계속할까요?", en: "This deletes the environments this deployment created (the app on Local and the clouds). The verdict and history stay. Continue?", ja: "このデプロイで作った環境(Local・クラウドのアプリ)を削除します。判定結果と履歴はそのまま残ります。続けますか?" },
  "dep.stoppedAt": { ko: "정리됨 · {time}", en: "Cleaned up · {time}", ja: "片付け済み · {time}" },
  "dep.stopFailed": { ko: "환경 정리 실패: {detail}", en: "Clean-up failed: {detail}", ja: "環境の片付けに失敗: {detail}" },

  // ---- Placeholders in a journey step (apps/shakedown/src/placeholders.ts) ----
  "ph.email": { ko: "(테스트 계정 이메일)", en: "(test account email)", ja: "(テストアカウントのメール)" },
  "ph.nickname": { ko: "(테스트 닉네임)", en: "(test nickname)", ja: "(テストのニックネーム)" },
  "ph.password": { ko: "(테스트 비밀번호)", en: "(test password)", ja: "(テストのパスワード)" },
  "ph.title": { ko: "(방금 만든 글 제목)", en: "(title of the post just created)", ja: "(作成したばかりの投稿タイトル)" },
  "ph.content": { ko: "(방금 쓴 글 본문)", en: "(body of the post just created)", ja: "(作成したばかりの投稿本文)" },
  "ph.comment": { ko: "(방금 쓴 댓글)", en: "(comment just written)", ja: "(書いたばかりのコメント)" },

  // ---- Runtime DB support per cloud ----
  "rt.dbGcpOnly": { ko: "GCP를 고르면 DB 없음과 관리형 PostgreSQL만 쓸 수 있습니다 (MySQL·MongoDB·외부 DB 미지원).", en: "With GCP selected only No database and Managed PostgreSQL are available (no MySQL, MongoDB or external DB).", ja: "GCP を選ぶと DB なしとマネージド PostgreSQL のみ使えます(MySQL・MongoDB・外部 DB は非対応)。" },
  "rt.dbUnsupported": { ko: "저장된 DB 방식을 고른 클라우드가 지원하지 않습니다. 다른 방식을 고르세요.", en: "The saved database mode is not supported by the selected clouds. Pick another one.", ja: "保存済みの DB 方式は選んだクラウドで非対応です。別の方式を選んでください。" },
  "rt.dbStackNote": { ko: "AWS·Azure는 준비된 스택의 DB 엔진 한 가지만 연결합니다.", en: "AWS and Azure connect only the one database engine their prepared stack has.", ja: "AWS・Azure は準備済みスタックの DB エンジン 1 種類のみ接続します。" },

  // ---- Architecture per cloud ----
  "arch.clouds": { ko: "적용할 클라우드", en: "Apply to", ja: "適用するクラウド" },
  "arch.needCloud": { ko: "클라우드를 하나 이상 고르세요.", en: "Pick at least one cloud.", ja: "クラウドを 1 つ以上選んでください。" },
  "arch.specTitle": { ko: "{tier} 등급의 클라우드별 사양", en: "{tier} tier per cloud", ja: "{tier} 等級のクラウド別仕様" },
  "arch.specFixed": { ko: "{cpu} vCPU / {mem} GiB · {min}대 고정", en: "{cpu} vCPU / {mem} GiB · {min} fixed", ja: "{cpu} vCPU / {mem} GiB · {min} 台固定" },
  "arch.specAuto": { ko: "{cpu} vCPU / {mem} GiB · {min}–{max}대 자동 확장", en: "{cpu} vCPU / {mem} GiB · {min}–{max} autoscaled", ja: "{cpu} vCPU / {mem} GiB · {min}–{max} 台自動拡張" },

  // ---- In-page navigation on the project page ----
  "pnav.label": { ko: "이 페이지 바로가기", en: "On this page", ja: "このページ内" },
  "pnav.compare": { ko: "비교", en: "Compare", ja: "比較" },
  "pnav.runtime": { ko: "실행 설정", en: "Runtime", ja: "実行設定" },
  "pnav.arch": { ko: "아키텍처", en: "Architecture", ja: "アーキテクチャ" },
  "pnav.image": { ko: "이미지", en: "Image", ja: "イメージ" },
  "pnav.https": { ko: "HTTPS", en: "HTTPS", ja: "HTTPS" },
} as const;

// Repo analysis warnings and the static-rule summary arrive in English from apps/engine/engine/analyzer.py and legacy_analyzer.py.
// [English text or pattern, ko, ja]. Anything not listed is shown as received.
const ENGINE_TEXT: [string | RegExp, string, string][] = [
  [/^Static rules detected (.+); (\d+) Spring route candidates\. Deployment readiness is unverified\.$/, "정적 규칙으로 감지한 스택: $1 · Spring 라우트 후보 $2개 · 배포 가능 여부는 아직 확인 전입니다.", "静的ルールで検出したスタック: $1 · Spring ルート候補 $2 件 · デプロイ可否は未確認です。"],
  ["A hardcoded sensitive compose setting was omitted; inject it through the target secret store.", "compose 파일에 직접 적힌 민감한 설정을 뺐습니다. 배포 환경의 비밀값 저장소로 넣어 주세요.", "compose に直接書かれた機密設定を除外しました。デプロイ先のシークレットストアから注入してください。"],
  ["A hardcoded sensitive setting was omitted; inject it through the target secret store.", "직접 적힌 민감한 설정을 뺐습니다. 배포 환경의 비밀값 저장소로 넣어 주세요.", "直接書かれた機密設定を除外しました。デプロイ先のシークレットストアから注入してください。"],
  ["JDBC query parameters were omitted from env; verify required connection options.", "JDBC 주소의 쿼리 옵션을 환경변수에서 뺐습니다. 필요한 연결 옵션을 확인하세요.", "JDBC のクエリパラメータを環境変数から除外しました。必要な接続オプションを確認してください。"],
  ["Datasource URL is unresolved or includes unsupported data; supply it before deployment.", "DB 접속 주소를 확정하지 못했거나 지원하지 않는 값이 있습니다. 배포 전에 직접 넣어 주세요.", "データソース URL が未解決か未対応の値を含みます。デプロイ前に指定してください。"],
  ["port uses a framework default; verify the actual listening port before deployment.", "포트는 프레임워크 기본값입니다. 배포 전에 실제 포트를 확인하세요.", "ポートはフレームワークの既定値です。デプロイ前に実際の待受ポートを確認してください。"],
  ["health_path defaults to /; HTTP availability has not been checked.", "헬스체크 경로가 기본값(/)입니다. HTTP 응답은 아직 확인하지 않았습니다.", "ヘルスチェックパスは既定値(/)です。HTTP の応答はまだ確認していません。"],
  ["health_path is a static candidate; target infrastructure must verify public URL health.", "헬스체크 경로는 코드에서 찾은 후보입니다. 배포 환경에서 공개 주소로 확인해야 합니다.", "ヘルスチェックパスはコードから見つけた候補です。デプロイ先で公開 URL を確認する必要があります。"],
  ["Server session references were detected; runtime behavior has not been checked.", "서버 세션을 쓰는 코드를 찾았습니다. 실제 동작은 아직 확인하지 않았습니다.", "サーバーセッションを使うコードが見つかりました。実際の動作はまだ確認していません。"],
  ["No server session use was detected; uses_server_session=false needs confirmation.", "서버 세션 사용을 찾지 못했습니다. 정말 쓰지 않는지 확인이 필요합니다.", "サーバーセッションの使用は見つかりませんでした。本当に使わないか確認が必要です。"],
  ["Conflicting environment settings were omitted; select an application profile.", "서로 충돌하는 환경 설정을 뺐습니다. 사용할 프로필을 고르세요.", "競合する環境設定を除外しました。使うプロファイルを選んでください。"],
  ["secret_env lists names only, including unclassified environment references; confirm secret mappings with infra.", "비밀값 목록에는 이름만 있고, 분류되지 않은 환경변수도 섞여 있습니다. 인프라 담당과 비밀값 연결을 확인하세요.", "シークレット一覧は名前のみで、未分類の環境変数参照も含みます。インフラ側とシークレットの対応を確認してください。"],
  ["database_name is unknown or ambiguous; confirm database provisioning settings.", "DB 이름을 모르거나 여러 개입니다. DB 준비 설정을 확인하세요.", "DB 名が不明か曖昧です。DB の準備設定を確認してください。"],
  ["Linked Java source directory was skipped; route/session analysis is incomplete.", "링크된 Java 소스 폴더를 건너뛰어 라우트·세션 분석이 완전하지 않습니다.", "リンクされた Java ソースフォルダをスキップしたため、ルート・セッション解析は不完全です。"],
  ["Java directory scan limit reached; route/session analysis is incomplete.", "Java 폴더 검사 한도에 도달해 라우트·세션 분석이 완전하지 않습니다.", "Java フォルダの走査上限に達したため、ルート・セッション解析は不完全です。"],
  ["Java file scan limit reached; route/session analysis is incomplete.", "Java 파일 검사 한도에 도달해 라우트·세션 분석이 완전하지 않습니다.", "Java ファイルの走査上限に達したため、ルート・セッション解析は不完全です。"],
  ["Java file exceeds size limit; route/session analysis is incomplete.", "크기 제한을 넘는 Java 파일이 있어 라우트·세션 분석이 완전하지 않습니다.", "サイズ上限を超える Java ファイルがあるため、ルート・セッション解析は不完全です。"],
  ["Java source could not be read; route/session analysis is incomplete.", "읽지 못한 Java 소스가 있어 라우트·세션 분석이 완전하지 않습니다.", "読めない Java ソースがあるため、ルート・セッション解析は不完全です。"],
  ["Unsupported Spring route path was omitted.", "지원하지 않는 Spring 라우트 경로를 뺐습니다.", "未対応の Spring ルートパスを除外しました。"],
  ["RequestMapping without one explicit method was omitted.", "HTTP 메서드가 하나로 정해지지 않은 RequestMapping을 뺐습니다.", "HTTP メソッドが 1 つに決まらない RequestMapping を除外しました。"],
  ["Route discovery supports simple Spring annotations only; request bodies and dynamic mappings need confirmation.", "라우트는 단순한 Spring 어노테이션만 찾습니다. 요청 본문과 동적 매핑은 확인이 필요합니다.", "ルート検出は単純な Spring アノテーションのみ対応です。リクエスト本文と動的マッピングは確認が必要です。"],
  ["Complex Spring route annotations were omitted; route discovery is partial.", "복잡한 Spring 라우트 어노테이션을 빼서 라우트 목록이 일부만 있습니다.", "複雑な Spring ルートアノテーションを除外したため、ルート一覧は一部のみです。"],
  ["Directory scan limit reached; analysis is incomplete.", "폴더 검사 한도에 도달해 분석이 완전하지 않습니다.", "フォルダの走査上限に達したため解析は不完全です。"],
  ["Profile-specific Spring configuration is not evaluated; verify the active deployment profile.", "프로필별 Spring 설정은 평가하지 않았습니다. 배포에 쓸 프로필을 확인하세요.", "プロファイル別の Spring 設定は評価していません。デプロイで使うプロファイルを確認してください。"],
  ["File scan limit reached; analysis is incomplete.", "파일 검사 한도에 도달해 분석이 완전하지 않습니다.", "ファイルの走査上限に達したため解析は不完全です。"],
  ["Nested project manifests found; only the root application is analyzed.", "하위 폴더에 다른 프로젝트 설정이 있어 루트 앱만 분석했습니다.", "入れ子のプロジェクト設定が見つかったため、ルートのアプリのみ解析しました。"],
  ["Application is in a subdirectory; repository-level deployment files are not applied.", "앱이 하위 폴더에 있어 저장소 최상위의 배포 파일은 적용하지 않았습니다.", "アプリがサブフォルダにあるため、リポジトリ直下のデプロイ用ファイルは適用していません。"],
  ["Multiple application roots found; select a local application directory explicitly.", "앱 폴더가 여러 개입니다. 사용할 앱 폴더를 직접 지정하세요.", "アプリのルートが複数あります。使うアプリのフォルダを明示してください。"],
  ["Actuator health path is a candidate; availability and authentication are unverified.", "Actuator 헬스체크 경로는 후보입니다. 응답 여부와 인증은 확인하지 않았습니다.", "Actuator のヘルスチェックパスは候補です。応答と認証は未確認です。"],
  ["Actuator has conflicting paths or a separate management port; health path needs confirmation.", "Actuator 경로가 충돌하거나 관리 포트가 따로 있습니다. 헬스체크 경로를 확인하세요.", "Actuator のパスが競合しているか、管理ポートが別です。ヘルスチェックパスを確認してください。"],
  ["Database is required but its type is unknown or ambiguous.", "DB가 필요하지만 종류를 확정하지 못했습니다.", "DB が必要ですが、種類が不明か曖昧です。"],
  ["Database is required, but external database configuration was not confirmed; verify connection and secret injection before deployment.", "DB가 필요하지만 외부 DB 설정을 확인하지 못했습니다. 배포 전에 연결과 비밀값 주입을 확인하세요.", "DB が必要ですが外部 DB の設定を確認できませんでした。デプロイ前に接続とシークレット注入を確認してください。"],
  ["No dedicated health endpoint was confirmed; configure a post-deployment health check.", "전용 헬스체크 주소를 찾지 못했습니다. 배포 후 헬스체크를 설정하세요.", "専用のヘルスチェック URL が見つかりませんでした。デプロイ後のヘルスチェックを設定してください。"],
  ["Environment key names were detected; values and deployment availability were not checked.", "환경변수 이름을 찾았습니다. 값과 배포 환경에서 쓸 수 있는지는 확인하지 않았습니다.", "環境変数名を検出しました。値とデプロイ先での利用可否は確認していません。"],
  [/^Conflicting (.+) evidence; manual selection is required\.$/, "$1 값의 근거가 서로 다릅니다. 직접 골라 주세요.", "$1 の根拠が食い違っています。手動で選んでください。"],
  [/^(\S+) is unknown or ambiguous; no default was assumed\.$/, "$1 값을 모르거나 여러 개라 기본값을 가정하지 않았습니다.", "$1 が不明か曖昧なため、既定値は仮定していません。"],
  [/^(.+) exceeds the size limit and was skipped\.$/, "$1 파일이 크기 제한을 넘어 건너뛰었습니다.", "$1 はサイズ上限を超えたためスキップしました。"],
  [/^(.+) could not be read as UTF-8\.$/, "$1 파일을 UTF-8로 읽지 못했습니다.", "$1 を UTF-8 として読めませんでした。"],
  [/^(.+) could not be parsed; affected fields require confirmation\.$/, "$1 파일을 해석하지 못했습니다. 관련 항목을 확인하세요.", "$1 を解析できませんでした。関連する項目を確認してください。"],
];

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
    // in은 상속 속성(constructor 등)까지 참으로 본다. 화면 언어가 배포·비교 요청의 lang으로도 가므로 목록에 있는 값만 받는다.
    if (wanted && Object.hasOwn(LANGS, wanted)) {
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
  /** English analysis text from the engine (warnings, rule summary) in the current language; unknown text is kept. */
  t.engine = (text: string) => {
    if (lang === "en") return text;
    for (const [en, ko, ja] of ENGINE_TEXT) {
      const out = lang === "ko" ? ko : ja;
      if (typeof en === "string" ? en === text : en.test(text)) return typeof en === "string" ? out : text.replace(en, out);
    }
    return text;
  };
  /** An applied fix in words: the known session-jdbc env fix gets a sentence, anything else a short option=value. */
  t.fix = (f: { option: string; value: string }) =>
    f.option === "env" && f.value.includes("session-jdbc") ? t("fix.sessionJdbc") : f.option === "env" ? f.value : `${f.option}=${f.value}`;
  /** "3s ago" in the current language. */
  /** BCP 47 tag for Date/number formatting in the current language. */
  t.locale = ({ ko: "ko-KR", en: "en-US", ja: "ja-JP" } as const)[lang];
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

/** 지금 화면 언어. 배포·비교 요청에 넣어 시운전 보고서도 같은 언어로 받는다. */
export function useLang(): Lang {
  return useContext(LangContext).lang;
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
