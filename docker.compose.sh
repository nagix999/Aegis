#!/usr/bin/env bash
# Operate this checkout with its existing Compose environment and data volume.
set -euo pipefail

AEGIS_SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly AEGIS_SCRIPT_DIR
AEGIS_PORT_STASH=''
AEGIS_COMPOSE_ARGS=(--project-directory "$AEGIS_SCRIPT_DIR")
[[ -z "${AEGIS_PROJECT:-}" ]] || AEGIS_COMPOSE_ARGS+=(--project-name "$AEGIS_PROJECT")
[[ -z "${AEGIS_ENV_FILE:-}" ]] || AEGIS_COMPOSE_ARGS+=(--env-file "$AEGIS_ENV_FILE")
[[ -z "${AEGIS_COMPOSE_FILE:-}" ]] || AEGIS_COMPOSE_ARGS+=(--file "$AEGIS_COMPOSE_FILE")

usage() {
  cat <<'USAGE'
Aegis Docker Compose 실행 도구

사용법: ./docker.compose.sh [명령]

  update      서버별 Compose 설정 보존 후 main 갱신, 빌드와 기동 (기본)
  up          Git 갱신 없이 현재 소스로 빌드와 기동
  build       이미지만 빌드
  restart     환경 설정을 반영하여 컨테이너 재생성
  stop        컨테이너 중지
  down        컨테이너와 Compose 네트워크 정리, 데이터 볼륨 유지
  logs        최근 100줄부터 실시간 로그 보기 (Ctrl+C로 종료)
  ps, status  중지된 컨테이너를 포함한 상태 확인
  check       Compose 구성 검사 (--check, config도 지원)
  menu        대화형 메뉴
  help        도움말 (--help, -h도 지원)

실행 위치와 관계없이 이 스크립트가 있는 프로젝트를 사용합니다.
기존 .env와 Compose 프로젝트 이름, 재정의 파일, 데이터 볼륨을 사용합니다.
별도 설치 설정: AEGIS_PROJECT, AEGIS_ENV_FILE, AEGIS_COMPOSE_FILE
처음 실행하기 전에 .env 또는 프로세스 환경에 관리자 계정을 설정하세요.
환경변수 변경은 restart, 소스와 화면 변경은 up으로 반영하세요.
update는 origin/main의 fast-forward만 허용하며 다른 코드 수정은 먼저 정리해야 합니다.
USAGE
}

compose() {
  docker compose "${AEGIS_COMPOSE_ARGS[@]}" "$@"
}

require_compose() {
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker를 찾을 수 없습니다. Docker와 Compose v2를 설치하세요.\n' >&2
    return 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    printf 'Docker Compose v2를 사용할 수 없습니다. docker compose version을 확인하세요.\n' >&2
    return 1
  fi
}

check_config() {
  local compose_status=0
  # Never print the resolved environment or execute .env as shell code.
  compose config --quiet >/dev/null 2>&1 || compose_status=$?
  if [[ "$compose_status" -ne 0 ]]; then
    printf 'Compose 구성 검사에 실패했습니다. docker compose config --quiet로 원인을 확인하세요.\n' >&2
    return "$compose_status"
  fi
}

restore_compose() {
  [[ -n "$AEGIS_PORT_STASH" ]] || return 0
  local saved_stash="$AEGIS_PORT_STASH"
  # Keep the exact stash object as a recovery copy, including after conflicts.
  AEGIS_PORT_STASH=''
  if git stash apply "$saved_stash" >/dev/null 2>&1; then
    printf '서버별 Compose 설정을 복구했습니다 (보관본: %s).\n' "$saved_stash"
  else
    printf 'Compose 설정 복구에 충돌이 있습니다. 컨테이너는 변경하지 않았습니다.\n' >&2
    printf '복구용 stash: %s\n충돌을 해결한 뒤 up을 실행하세요.\n' "$saved_stash" >&2
    return 1
  fi
}

update_exit() {
  local update_status=$?
  trap - EXIT INT TERM
  restore_compose || update_status=1
  exit "$update_status"
}

check_git() {
  local git_root branch changed
  command -v git >/dev/null 2>&1 || { printf 'update에는 Git이 필요합니다.\n' >&2; return 1; }
  git_root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ "$git_root" == "$AEGIS_SCRIPT_DIR" ]] || { printf '이 스크립트가 있는 Git 저장소에서 실행하세요.\n' >&2; return 1; }
  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" || return 1
  [[ "$branch" == main ]] || { printf 'main 브랜치에서 update를 실행하세요.\n' >&2; return 1; }
  git remote get-url origin >/dev/null 2>&1 || { printf 'origin 원격 저장소를 설정하세요.\n' >&2; return 1; }
  git diff --cached --quiet || { printf '스테이징한 변경을 먼저 정리하세요.\n' >&2; return 1; }
  changed="$(git diff --name-only)" || return $?
  if [[ -n "$changed" && "$changed" != docker-compose.yml ]]; then
    printf 'docker-compose.yml 외의 코드 변경을 먼저 정리하세요. 현재 변경은 유지했습니다.\n' >&2
    return 1
  fi
}

update_source() {
  local diff_status=0 before_stash after_stash pull_status=0
  check_git || return $?
  check_config || return $?
  trap update_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  git diff --quiet -- docker-compose.yml || diff_status=$?
  if [[ "$diff_status" -eq 1 ]]; then
    before_stash="$(git rev-parse --quiet --verify refs/stash 2>/dev/null || true)"
    git stash push --quiet -m keep-aegis-server-compose -- docker-compose.yml || return $?
    after_stash="$(git rev-parse --quiet --verify refs/stash 2>/dev/null)" || return 1
    if [[ -z "$after_stash" || "$after_stash" == "$before_stash" ]]; then
      printf '새 Compose 보관본을 확인하지 못했습니다. Git 갱신을 중단했습니다.\n' >&2
      return 1
    fi
    AEGIS_PORT_STASH="$after_stash"
  elif [[ "$diff_status" -ne 0 ]]; then
    return "$diff_status"
  fi
  printf 'origin/main을 fast-forward로 갱신합니다.\n'
  git pull --ff-only origin main || pull_status=$?
  restore_compose || return $?
  [[ "$pull_status" -eq 0 ]] || return "$pull_status"
}

wait_api() {
  # Python is supplied by the image. Host checks still apply to /healthz.
  compose exec -T aegis python - <<'AEGIS_HEALTHCHECK'
import json
import os
import time
import urllib.request
from urllib.parse import urlsplit

allowed = [value.strip() for value in os.environ.get("AEGIS_ALLOWED_HOSTS", "").split(",") if value.strip()]
host = allowed[0] if allowed else urlsplit(os.environ.get("PUBLIC_BASE_URL", "")).hostname or "localhost"
if ":" in host and not host.startswith("["):
    host = "[" + host + "]"
url = "http://127.0.0.1:" + os.environ.get("PORT", "8787") + "/healthz"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    try:
        request = urllib.request.Request(url, headers={"Host": host})
        with opener.open(request, timeout=2) as response:
            value = json.loads(response.read(4096))
        if isinstance(value, dict) and value.get("status") == "ok" and value.get("backend") == "python-fastapi":
            print("Aegis API 기동을 확인했습니다.")
            raise SystemExit(0)
    except (OSError, ValueError):
        pass
    time.sleep(1)
raise SystemExit("API 준비 상태를 확인하지 못했습니다. docker.compose.sh logs로 확인하세요.")
AEGIS_HEALTHCHECK
}

start_built_image() {
  compose up -d --no-build --pull never --force-recreate aegis || return $?
  wait_api || return $?
  compose ps --all
}

run_action() {
  case "$1" in
    update)
      update_source || return $?
      run_action up
      ;;
    up)
      check_config || return $?
      printf 'Aegis 이미지를 빌드합니다. 빌드 후 컨테이너를 교체합니다.\n'
      compose build aegis || return $?
      start_built_image
      ;;
    build)
      check_config || return $?
      printf 'Aegis 이미지를 빌드합니다. 반영하려면 up을 실행하세요.\n'
      compose build aegis
      ;;
    restart)
      check_config || return $?
      printf '현재 설정으로 Aegis 컨테이너를 재생성합니다.\n'
      start_built_image
      ;;
    stop)
      compose stop aegis
      ;;
    down)
      printf 'Compose 컨테이너와 네트워크를 정리합니다. 데이터 볼륨은 유지합니다.\n'
      compose down
      ;;
    logs)
      compose logs --follow --tail 100 aegis
      ;;
    ps|status)
      compose ps --all
      ;;
    check|config|--check)
      check_config || return $?
      printf 'Compose 구성 검사를 통과했습니다.\n'
      ;;
  esac
}

menu() {
  local choice action action_status
  while true; do
    printf '\nAegis Docker Compose\n'
    printf '  1) 빌드하고 기동\n  2) 설정을 반영하여 재시작\n'
    printf '  3) 상태 확인\n  4) 로그 보기\n  5) 이미지만 빌드\n'
    printf '  6) 컨테이너 중지\n  7) 컨테이너 정리 (데이터 유지)\n'
    printf '  8) 구성 검사\n  9) 서버 설정 보존 후 Git 갱신과 기동\n  0) 종료\n선택: '
    if ! IFS= read -r choice; then
      printf '\n'
      return 0
    fi
    case "$choice" in
      1) action=up ;;
      2) action=restart ;;
      3) action=ps ;;
      4) action=logs ;;
      5) action=build ;;
      6) action=stop ;;
      7) action=down ;;
      8) action=check ;;
      9) action=update ;;
      0|q|quit) return 0 ;;
      *) printf '0~9 중 하나를 선택하세요.\n' >&2; continue ;;
    esac
    if run_action "$action"; then
      :
    else
      action_status=$?
      printf '명령이 실패했습니다 (종료 코드 %s). 설정과 Docker 상태를 확인하세요.\n' "$action_status" >&2
    fi
  done
}

main() {
  if [[ "$#" -gt 1 ]]; then
    printf '명령은 하나만 지정하세요. ./docker.compose.sh --help를 확인하세요.\n' >&2
    return 2
  fi
  local action="${1:-update}"
  case "$action" in
    help|--help|-h) usage; return 0 ;;
    update|up|build|restart|stop|down|logs|ps|status|check|config|--check|menu) ;;
    *) printf '지원하지 않는 명령입니다. ./docker.compose.sh --help를 확인하세요.\n' >&2; return 2 ;;
  esac
  cd -- "$AEGIS_SCRIPT_DIR"
  require_compose || return $?
  if [[ "$action" == menu ]]; then
    menu
  else
    run_action "$action"
  fi
}

# Parse the exit with main before update can replace this file via git pull.
{ main "$@"; exit "$?"; }
