"""Public JSON contracts shared by the Python API and its OpenAPI schema.

Camel-case fields intentionally match the existing React and stored JSON format.
Only the strict graph/message/config objects reject unknown keys; other objects
strip unknown keys as the original API did.
"""
from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, RootModel, TypeAdapter, ValidationError, field_validator, model_serializer, model_validator

from .errors import ApiError


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def text(maximum: int = 160, minimum: int = 1, trim: bool = True):
    def clean(value: Any) -> str:
        if not isinstance(value, str):
            raise ValueError("문자열을 입력하세요.")
        value = value.strip() if trim else value
        if not minimum <= utf16_length(value) <= maximum:
            raise ValueError(f"길이는 {minimum}~{maximum}자여야 합니다.")
        return value
    return Annotated[str, BeforeValidator(clean)]


def integer(minimum: int, maximum: int):
    def clean(value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value:
            raise ValueError("정수를 입력하세요.")
        return int(value)
    return Annotated[int, BeforeValidator(clean), Field(ge=minimum, le=maximum)]


Identifier = text(120)
Name100 = text(100)
ModelAlias = Annotated[str, Field(strict=True, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$")]
RuleKind = Literal["keyword", "regex", "length", "llm", "pii", "json", "required"]


class ContractModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore", allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def reject_null_fields(cls, value: Any):
        if isinstance(value, dict):
            for key, part in value.items():
                if key in cls.model_fields and part is None:
                    raise ValueError(f"{key}: null 대신 값을 입력하거나 항목을 생략하세요.")
        return value


class ExactModel(ContractModel):
    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False)


class RuleConfig(ContractModel):
    pattern: text(2000, 0, False) | None = None
    maxLength: integer(1, 40000) | None = None
    prompt: text(4000, 0, False) | None = None
    connectionId: Identifier | None = None
    piiTypes: Annotated[list[Literal["email", "phone", "resident"]], Field(max_length=3)] | None = None
    requiredKeys: Annotated[list[text(100)], Field(max_length=32)] | None = None
    jsonMode: Literal["object", "any"] | None = None
    matchMode: Literal["any", "all"] | None = None
    guardProfile: Literal["custom", "injection", "safety"] | None = None


class Rule(ContractModel):
    id: Identifier
    name: Name100
    description: text(500, 0, False)
    kind: RuleKind
    enabled: bool
    config: RuleConfig


class RuleGroup(ContractModel):
    id: Identifier
    name: Name100
    mode: Literal["any", "all"]
    rules: Annotated[list[Rule], Field(min_length=1, max_length=12)]
    required: bool | None = None


class FlowCondition(ExactModel):
    operator: Literal["contains", "not_contains", "length_gte", "length_lte"]
    value: text(2000, 0, False)
    caseSensitive: bool | None = None


class FlowControlNode(ExactModel):
    id: Identifier
    name: Name100
    kind: Literal["condition", "fork", "join"]
    condition: FlowCondition | None = None


class FlowEdge(ExactModel):
    id: Identifier
    from_: text(150) = Field(alias="from")
    to: text(150)
    port: Literal["next", "true", "false"] | None = None


class StageGraph(ExactModel):
    nodes: Annotated[list[FlowControlNode], Field(max_length=12)]
    edges: Annotated[list[FlowEdge], Field(max_length=64)]


class WorkflowGraph(ExactModel):
    version: integer(1, 1)
    pre: StageGraph
    post: StageGraph


class Position(ContractModel):
    x: Annotated[float, Field(ge=0, le=40000)]
    y: Annotated[float, Field(ge=0, le=40000)]


class CanvasZone(ExactModel):
    id: Name100
    name: Name100
    color: Literal["slate", "blue", "green", "amber", "violet"]
    nodeKeys: Annotated[list[text(150, trim=False)], Field(max_length=988)]
    x: Annotated[float, Field(ge=0, le=40000)]
    y: Annotated[float, Field(ge=0, le=40000)]
    width: Annotated[float, Field(ge=240, le=50000)]
    height: Annotated[float, Field(ge=160, le=50000)]


class WorkflowLayout(ContractModel):
    version: integer(1, 1)
    positions: dict[text(150, trim=False), Position]
    zones: Annotated[list[CanvasZone], Field(max_length=32)] | None = None
    pinnedKeys: Annotated[list[text(150, trim=False)], Field(max_length=124)] | None = None

    @field_validator("positions")
    @classmethod
    def position_capacity(cls, value):
        if len(value) > 988:
            raise ValueError("노드 위치는 최대 988개까지 저장할 수 있습니다.")
        return value

    @field_validator("pinnedKeys")
    @classmethod
    def unique_pins(cls, value):
        if value is not None and len(value) != len(set(value)):
            raise ValueError("위치 고정 노드는 중복 없이 선택하세요.")
        return value


def lineage_identifier(value: str) -> str:
    if value in {"__proto__", "constructor", "prototype"} or re.search(r"[\x00-\x1f\x7f]", value):
        raise ValueError("검사 연결 ID를 확인하세요.")
    return value


LineageId = Annotated[Identifier, AfterValidator(lineage_identifier)]


class WorkflowCloneSource(ExactModel):
    workflowId: LineageId
    ruleIds: dict[LineageId, LineageId]

    @field_validator("ruleIds")
    @classmethod
    def unique_lineage(cls, value):
        if len(value) > 864 or len(set(value.values())) != len(value):
            raise ValueError("복제 연결 정보는 중복 없이 최대 864개까지 저장할 수 있습니다.")
        return value


class ExecutionLimits(ExactModel):
    timeoutMs: integer(1000, 600000)
    maxModelCalls: integer(1, 1000)


class ResponseRetryPolicy(ContractModel):
    enabled: bool
    maxRetries: integer(1, 3)
    instruction: text(2000, 0, False) | None = None


class ReleasePolicy(ExactModel):
    requireVerification: bool
    requiredDatasetIds: Annotated[list[Identifier], Field(max_length=30)]

    @field_validator("requiredDatasetIds")
    @classmethod
    def unique_datasets(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("필수 데이터셋은 중복 없이 선택하세요.")
        return value


class Workflow(ContractModel):
    id: Identifier
    name: text(120)
    description: text(1000, 0, False)
    alias: ModelAlias
    mainConnectionId: Identifier
    inputScope: Literal["conversation", "user_messages", "last_user"] | None = None
    executionLimits: ExecutionLimits | None = None
    pre: Annotated[list[RuleGroup], Field(max_length=36)]
    post: Annotated[list[RuleGroup], Field(max_length=36)]
    updatedAt: text(100, 0, False)
    responseRetry: ResponseRetryPolicy | None = None
    releasePolicy: ReleasePolicy | None = None
    layout: WorkflowLayout | None = None
    graph: WorkflowGraph | None = None
    cloneSource: WorkflowCloneSource | None = None
    policyRouting: PolicyRouting | None = None


class Connection(ContractModel):
    id: Identifier
    name: text(120)
    baseUrl: text(500, 0)
    model: text(200)
    role: Literal["main", "guard", "both"]
    mode: Literal["demo", "vllm"]
    secretEnv: text(100, 0)
    timeoutMs: integer(1000, 60000)


PolicyCode = Annotated[str, Field(strict=True, pattern=r"^[A-Z][A-Z0-9_]{0,63}$")]


class PolicyDecision(ExactModel):
    code: PolicyCode
    label: text(80)
    description: text(1000, 0, False)


class PolicyExample(ExactModel):
    id: Identifier
    input: text(16000, trim=False)
    expectedDecision: PolicyCode

    @field_validator("input")
    @classmethod
    def nonblank_input(cls, value):
        if not value.strip():
            raise ValueError("예제 입력에는 공백 외의 문자가 필요합니다.")
        return value


class PolicyOutputExpectation(ExactModel):
    mode: Literal["exact", "schema", "fields"]
    fields: Annotated[list["PolicyPredicate"], Field(min_length=1, max_length=12)] | None = None

    @model_validator(mode="after")
    def consistent_fields(self):
        if (self.mode == "fields") != (self.fields is not None):
            raise ValueError("필드 비교일 때만 비교할 출력 필드 조건을 지정하세요.")
        if self.fields is not None:
            from .output_expectations import validate_field_assertions
            validate_field_assertions([field.model_dump(exclude_none=True) for field in self.fields])
        return self


class StructuredPolicyExample(ExactModel):
    id: Identifier
    input: text(16000, trim=False)
    expectedOutput: Any
    expectation: PolicyOutputExpectation | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_fields(cls, value):
        if isinstance(value, dict) and any(part is None for key, part in value.items() if key in cls.model_fields and key != "expectedOutput"):
            raise ValueError("예제 ID와 입력에는 null을 사용할 수 없습니다.")
        return value

    @field_validator("input")
    @classmethod
    def nonblank_input(cls, value):
        if not value.strip():
            raise ValueError("예제 입력에는 공백 외의 문자가 필요합니다.")
        return value

    @model_serializer(mode="wrap")
    def keep_expected_null(self, handler):
        value = handler(self)
        value["expectedOutput"] = self.expectedOutput
        return value


class PolicyDefinition(ExactModel):
    id: Identifier
    name: text(120)
    description: text(1000, 0, False)
    prompt: text(4000, trim=False)
    connectionId: Identifier
    decisions: Annotated[list[PolicyDecision], Field(max_length=12)]
    examples: Annotated[list[PolicyExample | StructuredPolicyExample], Field(min_length=1, max_length=30)]
    formatVersion: integer(2, 2) | None = None
    outputSchema: dict[str, Any] | None = None
    maxOutputTokens: integer(256, 4096) | None = None

    @model_validator(mode="after")
    def consistent_decisions(self):
        if self.formatVersion == 2:
            from .structured_schema import validate_output_schema, validate_structured_output
            if self.decisions or self.outputSchema is None or any(not isinstance(example, StructuredPolicyExample) for example in self.examples):
                raise ValueError("자유 출력 정책에는 출력 스키마, 예상 JSON 예제와 빈 legacy 판정 목록을 지정하세요.")
            validate_output_schema(self.outputSchema)
            for example in self.examples:
                validate_structured_output(example.expectedOutput, self.outputSchema)
                if example.expectation is not None and example.expectation.mode == "fields":
                    from .output_expectations import validate_field_assertions
                    validate_field_assertions([field.model_dump(exclude_none=True) for field in example.expectation.fields], self.outputSchema)
        elif not 2 <= len(self.decisions) <= 12 or self.outputSchema is not None or self.maxOutputTokens is not None or any(not isinstance(example, PolicyExample) for example in self.examples):
            raise ValueError("기존 정책은 2~12개 판정 코드와 예상 판정 예제를 사용합니다.")
        codes = [decision.code for decision in self.decisions]
        if len(codes) != len(set(codes)):
            raise ValueError("정책 판정 코드는 서로 달라야 합니다.")
        if len({example.id for example in self.examples}) != len(self.examples) or len({example.input for example in self.examples}) != len(self.examples):
            raise ValueError("예제 ID와 입력은 중복 없이 작성하세요.")
        if self.formatVersion != 2 and any(example.expectedDecision not in codes for example in self.examples):
            raise ValueError("예제의 예상 판정은 등록된 코드를 선택하세요.")
        if not self.prompt.strip():
            raise ValueError("판정 기준에는 공백 외의 문자가 필요합니다.")
        return self


class PolicyRevision(PolicyDefinition):
    connectionSnapshot: Connection
    version: integer(1, 1000)
    updatedAt: text(100)

    @model_validator(mode="after")
    def guard_connection(self):
        if self.connectionSnapshot.id != self.connectionId or self.connectionSnapshot.role not in {"guard", "both"}:
            raise ValueError("정책에는 검사 또는 공용 모델 연결을 선택하세요.")
        return self


class PolicyRoute(ExactModel):
    decision: PolicyCode
    action: Literal["main", "respond", "error"]
    responseText: text(4000, trim=False) | None = None
    errorCode: PolicyCode | None = None
    errorMessage: text(500, trim=False) | None = None

    @model_validator(mode="after")
    def action_fields(self):
        if self.action == "respond":
            if not self.responseText or not self.responseText.strip() or self.errorCode is not None or self.errorMessage is not None:
                raise ValueError("안내 응답 경로에는 응답 문구만 지정하세요.")
        elif self.action == "error":
            if not self.errorCode or not self.errorMessage or not self.errorMessage.strip() or self.responseText is not None:
                raise ValueError("오류 경로에는 공개 오류 코드와 메시지만 지정하세요.")
        elif any(value is not None for value in (self.responseText, self.errorCode, self.errorMessage)):
            raise ValueError("Main LLM 경로에는 응답 또는 오류 문구를 지정할 수 없습니다.")
        return self


class PolicyPredicate(ExactModel):
    path: text(512, 0, False)
    operator: Literal["eq", "ne", "gt", "gte", "lt", "lte", "contains", "in", "exists"]
    value: Any = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_fields(cls, value):
        if isinstance(value, dict) and any(part is None for key, part in value.items() if key in cls.model_fields and key != "value"):
            raise ValueError("조건 경로와 연산자는 null일 수 없습니다.")
        return value

    @field_validator("value")
    @classmethod
    def bounded_value(cls, value):
        from .structured_schema import validate_json_value
        return validate_json_value(value)

    @model_serializer(mode="wrap")
    def keep_explicit_null(self, handler):
        value = handler(self)
        if "value" in self.model_fields_set:
            value["value"] = self.value
        return value


class PolicyCondition(ExactModel):
    mode: Literal["all", "any"]
    predicates: Annotated[list[PolicyPredicate], Field(min_length=1, max_length=12)]


class PolicyConditionNode(ExactModel):
    id: Identifier
    name: Name100
    kind: Literal["branch", "rule"]
    condition: PolicyCondition


class PolicySwitchCase(ExactModel):
    id: Annotated[str, Field(strict=True, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")]
    value: Any = Field(json_schema_extra={"anyOf": [
        {"type": "string"}, {"type": "number"}, {"type": "boolean"}, {"type": "null"},
    ]})

    @model_validator(mode="before")
    @classmethod
    def reject_null_fields(cls, value):
        if isinstance(value, dict) and any(part is None for key, part in value.items() if key in cls.model_fields and key != "value"):
            raise ValueError("Switch 경로 ID는 null일 수 없습니다.")
        return value

    @field_validator("id")
    @classmethod
    def reserved_port(cls, value):
        if value == "default":
            raise ValueError("default는 기본 경로에 예약된 ID입니다.")
        return value

    @field_validator("value")
    @classmethod
    def scalar_value(cls, value):
        from .structured_schema import validate_json_value
        if value is not None and type(value) not in (str, int, float, bool):
            raise ValueError("Switch 비교값에는 문자열, 숫자, 불리언 또는 null을 지정하세요.")
        return validate_json_value(value, max_bytes=4096)

    @model_serializer(mode="wrap")
    def keep_explicit_null(self, handler):
        value = handler(self)
        value["value"] = self.value
        return value


class PolicySwitchNode(ExactModel):
    id: Identifier
    name: Name100
    kind: Literal["switch"]
    path: text(512, 0, False)
    cases: Annotated[list[PolicySwitchCase], Field(min_length=1, max_length=12)]


class PolicyActionNode(ExactModel):
    id: Identifier
    name: Name100
    kind: Literal["action"]
    action: Literal["main", "respond", "error"]
    responseText: text(4000, trim=False) | None = None
    errorCode: PolicyCode | None = None
    errorMessage: text(500, trim=False) | None = None

    @model_validator(mode="after")
    def action_fields(self):
        PolicyRoute.model_validate({"decision": "ACTION", **self.model_dump(exclude={"id", "name", "kind"}, exclude_none=True)})
        return self


class PolicyGraphEdge(ExactModel):
    id: Identifier
    from_: Identifier = Field(alias="from")
    to: Identifier
    port: Annotated[str, Field(strict=True, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")]


class PolicyGraph(ExactModel):
    version: integer(1, 1)
    entryNodeId: Identifier
    nodes: Annotated[list[PolicyConditionNode | PolicySwitchNode | PolicyActionNode], Field(min_length=2, max_length=24)]
    edges: Annotated[list[PolicyGraphEdge], Field(min_length=2, max_length=48)]


class PolicyRouting(ExactModel):
    policy: PolicyRevision
    routes: Annotated[list[PolicyRoute], Field(max_length=12)]
    graph: PolicyGraph | None = None

    @model_validator(mode="after")
    def complete_routes(self):
        if self.policy.formatVersion == 2:
            if self.routes or self.graph is None:
                raise ValueError("자유 출력 정책에는 분기 그래프와 빈 legacy 경로 목록을 지정하세요.")
            from .policy_graph import validate_policy_graph
            issues = validate_policy_graph(self.graph.model_dump(by_alias=True, exclude_none=True), self.policy.outputSchema)
            if issues:
                raise ValueError("; ".join(issues[:3]))
            return self
        if self.graph is not None:
            raise ValueError("기존 정책에는 판정 코드별 경로를 사용하세요.")
        decisions = [route.decision for route in self.routes]
        if len(decisions) != len(set(decisions)) or set(decisions) != {decision.code for decision in self.policy.decisions}:
            raise ValueError("모든 정책 판정에 실행 경로를 하나씩 지정하세요.")
        return self


class IngressPolicy(ContractModel):
    enabled: bool
    allowedCidrs: Annotated[list[text(64, 0)], Field(max_length=100)]
    allowedOrigins: Annotated[list[text(400, 0)], Field(max_length=100)]


class ConversationMessage(ExactModel):
    role: Literal["system", "user", "assistant"]
    content: text(16000, trim=False)


class Conversation(RootModel[list[ConversationMessage]]):
    model_config = ConfigDict(strict=True)
    root: Annotated[list[ConversationMessage], Field(min_length=1, max_length=32)]

    @model_validator(mode="after")
    def bounded_conversation(self):
        if not any(message.role == "user" for message in self.root):
            raise ValueError("user 메시지가 하나 이상 필요합니다.")
        if sum(utf16_length(message.content) for message in self.root) > 40000:
            raise ValueError("메시지 전체 길이는 40,000자 이하로 보내세요.")
        return self


class GenerationSettings(ExactModel):
    temperature: Annotated[float, Field(ge=0, le=2)] | None = None
    max_tokens: integer(1, 8192) | None = None
    top_p: Annotated[float, Field(ge=0, le=1)] | None = None


class DatasetRow(ContractModel):
    id: Identifier
    input: text(16000, trim=False)
    messages: Conversation | None = None
    generationOptions: GenerationSettings | None = None
    expected: Literal["allow", "block"]
    category: text(80, 0) | None = None
    note: text(1000, 0, False) | None = None
    expectedStage: Literal["pre", "post", "main", "complete"] | None = None
    expectedRuleId: Identifier | None = None
    expectedDecision: PolicyCode | None = None
    expectedRoute: Literal["main", "respond", "error"] | None = None
    expectedPolicyCode: PolicyCode | None = None
    expectedPolicyFields: Annotated[list[PolicyPredicate], Field(min_length=1, max_length=12)] | None = None

    @field_validator("expectedPolicyFields")
    @classmethod
    def bounded_policy_fields(cls, fields):
        if fields is not None:
            from .output_expectations import validate_field_assertions
            validate_field_assertions([field.model_dump(exclude_none=True) for field in fields])
        return fields

    @field_validator("input")
    @classmethod
    def nonblank_input(cls, value):
        if not value.strip():
            raise ValueError("입력에는 공백 외의 문자가 필요합니다.")
        return value


class Dataset(ContractModel):
    id: Identifier
    name: text(120)
    description: text(1000, 0, False)
    rows: Annotated[list[DatasetRow], Field(min_length=1, max_length=100)]
    updatedAt: text(100, 0, False) | None = None


class KeyPolicy(ContractModel):
    allowedModels: Annotated[list[ModelAlias], Field(max_length=100)] | None = None
    expiresAt: str | None = None
    rpmLimit: integer(1, 100000) | None = None
    tpmLimit: integer(1, 10000000) | None = None
    maxConcurrent: integer(1, 1000) | None = None

    @field_validator("expiresAt")
    @classmethod
    def iso_datetime(cls, value):
        if value is not None:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value):
                raise ValueError("만료 시각은 UTC ISO 형식으로 입력하세요.")
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value


class RetentionPolicy(ContractModel):
    logDays: integer(1, 3650)
    evaluationDays: integer(1, 3650)
    auditDays: integer(1, 3650)


Workflow.model_rebuild()

_MODELS = {"workflow": Workflow, "connection": Connection, "ingress": IngressPolicy, "dataset": Dataset,
           "policy": PolicyDefinition, "policy_revision": PolicyRevision, "policy_routing": PolicyRouting,
           "key_policy": KeyPolicy, "retention": RetentionPolicy, "conversation": Conversation, "generation": GenerationSettings}


def validate_payload(kind: str, value: Any) -> Any:
    """Validate API data without introducing defaults into stored snapshots."""
    if kind not in _MODELS:
        raise ApiError("지원하지 않는 입력 종류입니다.")
    try:
        return _MODELS[kind].model_validate(value).model_dump(mode="python", by_alias=True, exclude_none=True)
    except ValidationError as exc:
        messages = []
        for issue in exc.errors()[:3]:
            path = ".".join(str(part) for part in issue["loc"]) or "request"
            messages.append(f"{path} {issue['msg']}")
        raise ApiError("입력값을 확인하세요: " + "; ".join(messages)) from None
