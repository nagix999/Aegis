"""One execution's deadline, cancellation and actual upstream call budget."""
from __future__ import annotations
import asyncio
import time
from contextlib import suppress
from typing import Any, Awaitable

DEFAULT_TIMEOUT_MS = 120_000
DEFAULT_MAX_MODEL_CALLS = 64
MAX_RESPONSE_RETRIES = 3
MAX_REPAIR_GUIDANCE_CHARS = 8_000


class ExecutionLimitError(Exception):
    pass


def js_length(text: str) -> int:
    return len(text.encode('utf-16-le', 'surrogatepass')) // 2


def execution_limit_issues(workflow: dict) -> list[str]:
    issues = []
    if workflow.get('inputScope', 'conversation') not in ('conversation', 'user_messages', 'last_user'):
        issues.append('요청 검사 대상을 다시 선택하세요.')
    limits = workflow.get('executionLimits')
    if limits is not None:
        if not isinstance(limits, dict):
            return issues + ['전체 실행 제한을 확인하세요.']
        for field, maximum, message in [('timeoutMs', 600000, '전체 실행 제한 시간은 1~600초로 설정하세요.'), ('maxModelCalls', 1000, '모델 호출 한도는 1~1,000회로 설정하세요.')]:
            value = limits.get(field)
            if type(value) is not int or value < (1000 if field == 'timeoutMs' else 1) or value > maximum:
                issues.append(message)
    return issues


def effective_execution_limits(workflow: dict) -> dict:
    return workflow.get('executionLimits') or {'timeoutMs': DEFAULT_TIMEOUT_MS, 'maxModelCalls': DEFAULT_MAX_MODEL_CALLS}


def request_inspection_text(workflow: dict, messages: list[dict]) -> str:
    users = [m for m in messages if m['role'] == 'user']
    selected = users[-1:] if workflow.get('inputScope') == 'last_user' else users if workflow.get('inputScope') == 'user_messages' else messages
    return '\n'.join(m['content'] for m in selected)


def execution_lease_duration(workflow: dict, connections: list | None = None) -> int:
    return max(120000, effective_execution_limits(workflow)['timeoutMs'] + 60000)


def response_attempt_limit(workflow: dict) -> int:
    policy = workflow.get('responseRetry') or {}
    return 1 + (policy.get('maxRetries', 3) if policy.get('enabled') else 0)


def response_token_reservation(workflow: dict, messages: list[dict], max_output_tokens: int) -> int:
    original = sum(len(m['content'].encode('utf-8')) + 32 for m in messages) + 32
    attempts = response_attempt_limit(workflow)
    return original + max_output_tokens + (attempts - 1) * (original + MAX_REPAIR_GUIDANCE_CHARS * 4 + 32 + max_output_tokens)


class ExecutionRuntime:
    def __init__(self, limits: dict, cancel_event: asyncio.Event | None = None):
        self.deadline = time.monotonic() + limits['timeoutMs'] / 1000
        self.maximum = limits['maxModelCalls']
        self.calls = 0
        self.cancel_event = cancel_event
        self.stopped = asyncio.Event()
        self.reason: str | None = None

    def stop(self, reason: str) -> None:
        self.reason = self.reason or reason
        self.stopped.set()

    def assert_active(self) -> None:
        if self.cancel_event and self.cancel_event.is_set():
            self.stop('실행 취소 요청에 따라 중단했습니다.')
        if time.monotonic() >= self.deadline:
            self.stop('워크플로우 전체 실행 제한 시간을 초과했습니다.')
        if self.reason:
            raise ExecutionLimitError(self.reason)

    def before_model_call(self) -> None:
        self.assert_active()
        if self.calls >= self.maximum:
            self.stop('워크플로우의 모델 호출 한도에 도달했습니다.')
            raise ExecutionLimitError(self.reason)
        self.calls += 1

    async def wait(self, operation: Awaitable[Any]) -> Any:
        task = asyncio.ensure_future(operation)
        waits: list[asyncio.Task] = []
        try:
            self.assert_active()
            waits.append(asyncio.create_task(self.stopped.wait()))
            if self.cancel_event:
                waits.append(asyncio.create_task(self.cancel_event.wait()))
            done, _ = await asyncio.wait([task, *waits], timeout=max(0, self.deadline - time.monotonic()), return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                self.assert_active()
                return await task
            self.assert_active()
            self.stop('워크플로우 전체 실행 제한 시간을 초과했습니다.')
            raise ExecutionLimitError(self.reason)
        finally:
            for waiter in waits:
                waiter.cancel()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, *waits, return_exceptions=True)
