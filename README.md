# Aegis AI Gateway

요청과 응답의 정책 검사를 워크플로우로 구성하고, 데이터셋 검증을 거쳐 OpenAI 호환 API로 제공하는 관리 도구입니다. **Python + FastAPI 백엔드와 React + TypeScript 관리 화면**으로 구성합니다. Gateway와 데이터셋 검증은 같은 Python 엔진을 사용합니다.

현재는 PoC입니다. 예제 모델로 로컬 실행과 검증을 시작할 수 있으며, 실제 vLLM 연동과 운영 TLS 및 외부 배포는 설치 환경에서 별도로 확인해야 합니다.

## 주요 기능

- 워크플로우: 요청 검사, 응답 생성, 응답 검사, 조건 분기, 병렬 분기와 합류, 최대 3회 추가 응답 재작성
- 정책 관리: 프롬프트, JSON Schema, 예제 출력과 검사 모델을 하나의 불변 버전으로 관리
- 정책 분기: 자유로운 JSON 출력을 필드 조건으로 비교하고 Main 모델 실행, 등록 응답 또는 공개 오류 선택
- 검증: 대화형 테스트, 데이터셋 실행, 예상 결과와 JSON 필드 비교, 변경 전후 비교, 재시도와 이력 검색
- 배포: 검증 근거 확인, 불변 배포 스냅샷, 이전 설정 복원, API 별칭 호출 중지와 재개
- 운영: 모델 연결 진단, 범위와 사용량 제한이 있는 API 키, 요청 기록과 감사 기록, 안전한 결과 내보내기
- 대시보드: 이름 있는 탭, 지표와 차트 및 표, 배치 미리보기, 탭 복제와 템플릿, 구성 가져오기와 내보내기, 화면 링크와 드릴다운
- 관리 화면: 관리자 로그인, 역할별 접근, 미저장 입력 보존, 직접 링크와 뒤로 가기, 키보드와 모바일 상세 패널

영역은 연속된 노드를 화면에서 묶는 표시 정보입니다. 실행 순서나 권한을 바꾸지 않습니다. 워크플로우는 제한된 DAG이며 임의 순환, 임의 코드 실행과 중첩 하위 흐름을 지원하지 않습니다.

## 로컬 실행

Python **3.12 이상**, UI 빌드에는 **Node.js 24**와 **pnpm 11.25.0**을 사용합니다. 정확한 의존성은 `backend/requirements*.txt`, `package.json`, `pnpm-lock.yaml`에 있습니다. Python 서버를 실행할 때는 Node.js 프로세스가 필요하지 않습니다.

저장소 루트에서 다음 명령을 실행합니다. pnpm이 없다면 `npm install --global pnpm@11.25.0`으로 준비합니다.

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r backend/requirements.txt
pnpm install --frozen-lockfile
pnpm build:python-ui
if [ ! -e .env ]; then cp .env.example .env; fi
```

Windows PowerShell의 가상환경 활성화 명령은 `.venv\Scripts\Activate.ps1`입니다. `.env` 복사는 기존 파일이 없을 때만 수행하세요.

관리자 비밀번호 해시를 대화형으로 생성합니다. 비밀번호는 셸 명령에 직접 넣지 않습니다.

```sh
PYTHONPATH=backend python -m aegis.password_hash
```

`.env`의 `ADMIN_USER`를 정하고, 생성한 해시를 `ADMIN_PASSWORD_HASH='생성한 해시'`처럼 작은따옴표로 감싸 넣습니다. `ADMIN_PASSWORD`로 설정할 수도 있지만 두 값이 있으면 해시를 우선합니다. 예제 파일에는 실제 비밀번호나 API 키가 없습니다.

```sh
python backend/run.py
```

- 관리 화면: <http://localhost:8787>
- API 문서: `/docs`, `/openapi.json` (관리자 인증 필요)
- 프로세스 상태: `/healthz` (`backend=python-fastapi`, `engineVersion=6-python`)

`/healthz`는 프로세스 실행 상태이며 실제 모델이나 DB 전체의 준비 상태를 보장하지 않습니다. 기본 바인딩은 `127.0.0.1:8787`입니다. UI를 변경하면 `pnpm build:python-ui` 후 서버를 재시작하세요. 백엔드 코드와 로그인에 공개할 빌드 자산 목록은 서버 시작 시 적용합니다.

일반 `pnpm build`, `pnpm start`와 `scripts/local-api.mjs`는 이전 TypeScript 미리보기 경로입니다. Python 서비스 실행에는 `build:python-ui`와 `backend/run.py`를 사용합니다. 기존 TypeScript 엔진은 비교 검사와 이전 실행 경로를 위해 남아 있습니다.

## 설정과 인증

설정 예시는 [`.env.example`](.env.example)에 있습니다. Python 실행기는 이 파일을 복사한 루트 `.env`를 읽으며 이미 설정된 프로세스 환경변수를 덮어쓰지 않습니다.

| 설정 | 기본값 또는 용도 |
| --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8787` |
| `PUBLIC_BASE_URL` | 실제 관리 화면 주소. 예제는 `http://localhost:8787` |
| `AEGIS_ALLOWED_HOSTS` | 선택한 정확한 호스트명 목록. 생략하면 `PUBLIC_BASE_URL`의 호스트 사용 |
| `ADMIN_USER`, `ADMIN_PASSWORD_HASH` | 관리자 계정과 비밀번호 해시 |
| `AEGIS_DATABASE_PATH` | `data/aegis.sqlite` |
| `AEGIS_SESSION_IDLE_SECONDS`, `AEGIS_SESSION_MAX_SECONDS` | 세션 유휴 1,800초, 최대 43,200초 |
| `AEGIS_EVALUATION_WORKER_ENABLED` | `true`, API 프로세스에서 검증 작업자 실행 |
| `AEGIS_MODEL_MAX_CONCURRENT` | 모델 연결별 공유 동시 호출 한도. 기본 8, 범위 1~1,000 |
| `AEGIS_POLICY_MAX_VERSIONS` | 전체 정책 버전 한도. 기본 100, 범위 100~1,000 |
| `AEGIS_ALLOW_PRIVATE_UPSTREAM` | `false`, 사설 모델 주소는 명시적으로 허용 |
| `VLLM_MAIN_API_KEY`, `VLLM_GUARD_API_KEY` | 모델 연결이 참조할 서버 측 비밀 값 |

브라우저는 서버 세션을 사용합니다. 쿠키는 `HttpOnly`, `SameSite=Lax`이며 HTTPS 주소에서는 `Secure`를 적용합니다. 관리 쓰기 요청에는 Origin과 CSRF 검사를 적용하며 로그인 시도 횟수를 제한합니다. 회원가입이나 다중 계정 발급 기능은 없습니다.

관리 계정을 설정하지 않은 loopback 직접 접속은 기존 개발 모드를 유지합니다. 이 접근까지 차단하려면 `AEGIS_REQUIRE_ADMIN_IDENTITY=true`를 설정합니다. 외부 주소에 바인딩할 때는 실행기가 관리자 계정을 요구합니다. 운영에는 HTTPS reverse proxy와 실제 `PUBLIC_BASE_URL`을 사용하세요.

기존 Basic 인증과 별도 `AEGIS_ADMIN_TOKEN`을 사용할 수 있습니다. `AEGIS_ROLE_MAP`이 비어 있으면 인증된 계정은 관리자이며, 맵을 설정하면 미등록 사용자는 조회자가 됩니다. Gateway 키와 외부 검증 작업자 토큰은 관리 인증과 별개입니다.

프록시 사용자 및 IP 헤더는 기본적으로 신뢰하지 않습니다. 신뢰할 프록시를 사용하는 경우에만 `AEGIS_TRUST_PROXY_IDENTITY=true`와 `AEGIS_TRUSTED_PROXY_IPS`를 설정합니다. 허용 목록은 전달된 클라이언트 IP가 아닌 **실제 프록시 소켓의 정확한 IP**이며 CIDR이 아닙니다.

## Docker 실행

먼저 `.env`에 관리자 계정을 설정한 뒤 실행합니다.

```sh
docker compose config --quiet
docker compose up --build -d
docker compose logs -f aegis
```

Node 빌드 단계에서 UI를 생성하고 최종 컨테이너는 Python 3.12에서 실행합니다. 포트는 호스트 `127.0.0.1:8787`에만 열고 SQLite는 `aegis_data` 이름의 볼륨에 보관합니다. 같은 Compose 프로젝트 이름을 유지해야 같은 볼륨을 재사용합니다. 프로젝트 폴더명을 바꾸면 기존 볼륨 이름을 먼저 확인하세요. 데이터 보존이 필요하면 `docker compose down -v`를 실행하지 않습니다.

Compose의 `.env`는 변수 보간용입니다. 컨테이너에는 `docker-compose.yml`의 `environment`에 명시된 설정만 전달하며 `.env` 전체를 전달하지 않습니다. 모델 연결의 `secretEnv`에 기본 두 키 외의 이름을 쓰면 해당 환경변수도 Compose에 추가하세요. `PUBLIC_BASE_URL`과 비밀번호 해시의 작은따옴표도 확인합니다.

`docker compose restart`는 기존 컨테이너를 재시작합니다. 환경변수 변경은 `docker compose up -d`로 재생성하고 코드 변경은 `docker compose up --build -d`로 반영합니다. 외부 공개용 reverse proxy와 인증서 구성은 포함하지 않습니다.

## 모델 연결과 정책 구성

기본 모델 연결은 예제 모드입니다. 실제 모델을 연결하는 순서는 다음과 같습니다.

1. **접근 설정**의 허용 모델 서버에 대상 HTTPS origin을 등록합니다.
2. **모델 연결**에 `/v1`으로 끝나는 서버 주소, 모델 이름과 역할을 등록합니다.
3. `secretEnv`에 서버 환경변수 이름을 지정하고 해당 환경에 키를 설정합니다. UI나 배포 스냅샷에 키 원문을 입력하지 않습니다.
4. 사내 사설 주소는 `AEGIS_ALLOW_PRIVATE_UPSTREAM=true`를 설정하고 연결 진단을 실행합니다.
5. 워크플로우를 구성하고 실제 모델로 데이터셋을 검증한 뒤 배포합니다.

허용 목록과 사설 주소 허용은 서버의 네트워크 경로를 생성하지 않습니다. 전송 계층은 DNS 목적지를 검사하고 검증한 IP로 연결하며 원래 호스트로 TLS를 검증합니다. 프로세스의 프록시와 CA 환경변수를 자동 상속하지 않으므로 사내 CA나 프록시가 필요한 설치는 별도로 확인해야 합니다.

정책은 프롬프트, JSON Schema, 1~30개 예상 출력 예제와 모델 스냅샷을 함께 버전 관리합니다. 필드 편집기와 JSON 직접 편집을 사용할 수 있으며 중첩 객체, 배열, null, 조합과 조건부 스키마 및 재귀 없는 로컬 참조를 지원합니다. `decision` 같은 출력 필드는 고정하지 않습니다.

스키마는 최대 32KiB, 깊이 12, 스키마 노드 256개이며 생성 JSON은 최대 64KiB입니다. 외부 참조와 재귀 참조는 지원하지 않고, 참조 확장과 조합에도 한도를 적용합니다. 허용하지 않는 제약을 삭제하거나 일반 텍스트 생성으로 조용히 우회하지 않습니다.

워크플로우에서 **노드 추가 → 정책 검사 (구조화 출력)**으로 버전을 선택하고, **조건 분기**에서 JSON Pointer와 자료형에 맞는 조건을 정합니다. **정책 액션**으로 다음 동작을 연결합니다.

- 응답 모델 실행: Main 생성 후 응답 검사와 설정된 재작성 수행
- 등록 안내 응답: Main을 생략하고 등록 문구를 응답 검사한 뒤 반환
- 지정 오류: 등록된 공개 코드와 메시지로 차단

워크플로우당 정책 검사 하나를 지원합니다. 정책 출력의 JSON 또는 스키마가 잘못되면 분기 전에 오류로 종료합니다. 새 정책 버전이나 모델 연결 변경은 기존 워크플로우와 배포에 자동 적용되지 않습니다.

예제 출력 비교는 전체 JSON 일치, 스키마 통과 또는 선택 필드 조건을 사용합니다. 데이터셋에도 최대 12개 정책 필드 조건을 설정할 수 있습니다. 정책이 실행되지 않으면 필드 검증은 불일치입니다. 결과에는 조건 경로와 일치 여부만 남기고 정책 출력 원문은 노출하지 않습니다.

정책의 예제 모델은 등록 입력에 등록 예상 출력을 반환합니다. 새 입력을 분석하지 않으며 예제 테스트 성공은 실제 프롬프트 품질의 증거가 아닙니다. 실제 모델에는 스키마를 전달하고 서버에서 다시 검사합니다. 실제 vLLM의 Structured Output 지원은 서버 버전과 생성 백엔드에 따라 확인해야 합니다.

## OpenAI SDK와 Gateway

지원 경로는 `GET /v1/models`, `POST /v1/chat/completions`입니다. 콘솔에서 워크플로우를 API 별칭으로 배포하고 Gateway 키를 발급합니다. 키 원문은 한 번만 표시하며 허용 모델, 만료, RPM, TPM과 동시 실행 한도를 설정할 수 있습니다.

호출 측 Python 환경에 SDK를 설치합니다. 서버 실행 의존성에는 포함되지 않습니다.

```sh
python -m pip install openai
```

`AEGIS_GATEWAY_KEY`는 호출하는 프로그램의 환경변수로 설정합니다.

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8787/v1",
    api_key=os.environ["AEGIS_GATEWAY_KEY"],
    max_retries=0,
)
messages = [
    {"role": "system", "content": "고객 문의에 답해주세요."},
    {"role": "user", "content": "배송 기간을 알려주세요."},
]
response = client.chat.completions.create(
    model="support-assistant",  # 콘솔에서 배포한 API 별칭
    messages=messages,
    stream=False,
    max_tokens=512,
)
answer = response.choices[0].message.content
print(answer)
messages.append({"role": "assistant", "content": answer})
messages.append({"role": "user", "content": "제주도도 동일한가요?"})
# 다음 호출에 누적한 messages를 다시 전달합니다.
```

멀티턴 이력은 호출 측에서 관리합니다. Aegis가 이전 대화를 자동 저장하거나 이어 붙이지 않습니다. 입력 역할과 순서는 Main 모델에 전달하며 정책의 요청 검사 대상은 전체 대화, 사용자 메시지 전체 또는 마지막 사용자 질문으로 선택합니다.

| 요청 항목 | 지원 범위 |
| --- | --- |
| `model` | 배포한 API 별칭 |
| `messages` | 1~32개, `system` / `user` / `assistant`, 문자열 `content`, `user` 메시지 필수 |
| 메시지 길이 | 메시지별 최대 16,000, 전체 최대 40,000 UTF-16 단위 |
| `temperature` | 0~2 |
| `max_tokens` | 1~8,192 |
| `top_p` | 0~1 |
| `stream` | 생략 또는 `false` |

메시지에는 `role`, `content`만 전달합니다. SDK의 응답 메시지 전체를 `model_dump()`해 넣으면 추가 필드로 거부될 수 있습니다. 지원하지 않는 요청 필드는 400으로 거부합니다. `max_completion_tokens`, `response_format`, SDK 스키마 파싱 호출, 도구 호출, 이미지, `developer` 역할, 임베딩과 Responses API는 지원하지 않습니다. 내부 정책의 Structured Output과 공개 Gateway의 지원 범위는 다릅니다.

성공 응답은 `id`, `object: "chat.completion"`, `created`, `model`, `choices`를 포함하며 `choices[0].message.content`가 최종 답변입니다. `usage`는 있을 때만 포함하며 upstream의 모든 부가 필드를 그대로 전달하지 않습니다. 요청 ID와 워크플로우 버전은 `X-Aegis-Request-Id`, `X-Aegis-Workflow-Version` 헤더에서도 확인합니다.

정책 차단은 **403**과 `error.code="guardrail_blocked"`, 모델 또는 검사 실행 오류는 **502**와 `error.code="guardrail_error"`를 반환합니다. SDK에서는 HTTP 오류 예외를 처리하세요. 지정 정책 오류에는 `policyCode`가 추가될 수 있습니다. 차단된 답변과 원시 정책 출력은 공개 응답에 포함하지 않습니다. 요청 검사 차단 시 Main을 호출하지 않으며, 응답 검사를 모두 통과한 전체 텍스트만 반환합니다. 콘솔의 NDJSON 진행 이벤트는 토큰 스트리밍이 아닙니다.

## 검증과 배포 운영

검증은 서버 작업자가 처리하므로 브라우저를 닫아도 서버가 실행 중이면 진행합니다. 기본 최대 동시 작업은 4개입니다. 별도 작업자를 사용하려면 API의 `AEGIS_EVALUATION_WORKER_ENABLED=false`를 설정하고 같은 DB와 모델 환경으로 실행합니다.

```sh
PYTHONPATH=backend python -m aegis.worker_cli
```

원격 HTTP 작업자는 별도의 `AEGIS_EVALUATION_WORKER_TOKEN`을 사용합니다. 관리자나 Gateway 자격과 공유하지 않습니다. 비정상 종료 후 처리권이 만료되면 일부 호출이 재실행될 수 있으므로 정확히 한 번의 모델 호출을 보장하지 않습니다.

배포는 불변 스냅샷을 사용하므로 초안 수정이 운영 API에 즉시 적용되지 않습니다. 현재 엔진, 실행 설정과 데이터셋에 맞는 전체 검증을 배포 근거로 사용합니다. 검증 의무화를 설정하지 않은 PoC에서는 근거 없는 직접 배포도 허용합니다. 과거 엔진의 검증은 새 배포 근거로 재사용하지 않습니다. 이전 배포도 현재 엔진 코드로 실행하며 과거 엔진 바이너리를 보관해 실행하지 않습니다.

별칭 호출 중지는 새 요청과 `/v1/models` 노출을 막지만 진행 중인 요청은 강제로 취소하지 않습니다. 보관한 워크플로우와 정책은 복원할 수 있으며 복원이나 새 배포가 호출을 자동 재개하지 않습니다. 보관한 정책과 버전도 저장 한도에 포함됩니다.

## 데이터와 백업

기본 DB는 `data/aegis.sqlite`입니다. 공개 JSON과 저장 데이터의 camelCase, 기존 SQLite 테이블과 키 해시를 유지하며 초기 예제가 기존 데이터를 덮어쓰지 않습니다. `.env`, SQLite, 백업, 로컬 도구와 생성 빌드는 저장소에 포함하지 않습니다.

기존 설치를 옮기거나 업데이트하기 전에 `.env`와 DB를 별도로 백업하세요. 실행 중인 SQLite는 파일 하나만 복사하지 말고 SQLite backup API를 사용하거나, 모든 서버와 작업자를 종료한 뒤 복사합니다. 기존 서버와 새 서버를 같은 DB에 동시에 쓰게 하지 않습니다. 경로와 Compose 볼륨이 바뀌지 않았는지 확인하고 시작하세요.

요청 기록은 원문 질문, 답변과 원시 정책 출력을 저장하지 않습니다. 검증 데이터와 결과는 별도 저장 대상이므로 접근과 백업을 관리해야 합니다. 기본 보관은 요청 기록 30일 및 최대 1,000건, 검증 기록 30일, 감사 기록 90일입니다. 배포 이력과 검증 근거 요약은 별도로 유지합니다.

대시보드는 보관된 데이터 범위 안에서 집계합니다. 장기 영구 집계가 아니며 Main 생성 usage가 없는 요청은 토큰 통계에서 빠질 수 있습니다. 정책과 검사 모델 토큰은 Main 토큰 집계에 포함하지 않습니다. 대시보드 탭과 배치는 브라우저별로 저장하고 구성 JSON으로 옮길 수 있으며 서버 동기화는 지원하지 않습니다.

## 개발과 검사

가상환경을 활성화하고 프로젝트 루트에서 실행합니다. Python 전체 검사 전에 UI를 빌드해야 합니다.

```sh
python -m pip install -r backend/requirements-dev.txt
pnpm build:python-ui
pnpm exec tsc --noEmit
python -m pytest -c backend/pytest.ini backend/tests
node --experimental-strip-types --test --test-isolation=none \
  tests/console-auth.test.ts tests/workflow-recovery.test.ts
```

일반 Python 검사와 실제 브라우저 검사는 별도입니다. 브라우저용 의존성과 관리형 Chromium을 추가로 설치합니다. Linux에서 시스템 라이브러리 설치가 필요하면 `python -m playwright install --with-deps chromium`을 사용합니다.

```sh
python -m pip install -r backend/requirements-browser.txt
python -m playwright install chromium
pnpm build:python-ui
pnpm test:browser:auth --junitxml=test-results/browser/junit.xml
```

명령 이름은 `auth`지만 인증 외에 정책과 데이터셋 편집, 결과 탐색과 화면 이동 회귀도 실행합니다. 검사는 임시 SQLite, 합성 계정, 자동 할당한 loopback 포트와 새 브라우저 프로필을 사용합니다. 실제 `.env`나 실행 중인 서비스를 재사용하지 않습니다. 브라우저가 없으면 안내 후 실패합니다. 기존 Chromium 계열 실행 파일을 쓰려면 `--browser-executable /path/to/chrome`을 지정합니다.

실패 진단은 `test-results/auth/`에 저장합니다. trace는 `python -m playwright show-trace <trace.zip>`으로 확인합니다. GitHub Actions는 Python 3.12, Node 24, pnpm 11.25.0에서 빌드와 타입, Python, 관련 Node 및 브라우저 검사를 실행하도록 구성되어 있습니다. 원격 실행 성공은 각 저장소의 Actions 결과로 확인하세요.

API를 변경하면 명세를 다시 생성합니다.

```sh
python scripts/export-python-openapi.py
```

| 경로 | 역할 |
| --- | --- |
| `backend/aegis/` | FastAPI, 인증, 공통 실행 엔진, SQLite, 검증 작업자 |
| `backend/openapi.json` | FastAPI에서 생성한 API 명세 |
| `app/`, `components/`, `frontend/`, `lib/` | React 화면, Python UI 진입점과 공유 타입 및 편집 로직 |
| `drizzle/` | 기존 SQLite와 공유하는 SQL 마이그레이션 |
| `scripts/` | UI 빌드와 명세 생성 및 개발 도구 |
| `backend/tests/`, `tests/` | Python과 TypeScript 회귀 검사 |
| `backend/browser_tests/` | 격리된 실제 브라우저 검사 |
| `.github/workflows/` | GitHub Actions 구성 |

실제 vLLM, 사내 CA와 프록시, 운영 부하 및 외부 배포는 별도 검증 대상입니다. 감사 이력의 상세 검색, 장기 일별 영구 집계, 대시보드 서버 동기화와 참조 없는 정책 버전 정리는 아직 제공하지 않습니다.
