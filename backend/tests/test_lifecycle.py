"""Temporary SQLite regressions for reversible operating state and revision caps."""
import copy

import httpx
import pytest
from fastapi import FastAPI

from aegis.api import create_router
from aegis.errors import ApiError
from aegis.lifecycle import handle_lifecycle_action, policy_version_limit
from aegis.schemas import PolicyRevision
from aegis.store import Store, iso_at


@pytest.fixture
async def fixture(tmp_path):
    store = Store(tmp_path / "lifecycle.sqlite")
    await store.seed()
    state = await store.state()
    workflow = state["workflows"][0]
    deployment = await store.deploy({"id": "deployment-1", "workflowId": workflow["id"], "alias": workflow["alias"], "createdAt": iso_at(), "workflow": copy.deepcopy(workflow), "connections": copy.deepcopy(state["connections"])})
    yield store, workflow, deployment
    await store.close()


async def pause(store, deployment, value=True, **extra):
    return await handle_lifecycle_action({"action": "set_deployment_paused", "alias": deployment["alias"], "paused": value, "expectedDeploymentId": deployment["id"], **extra}, store, "local-admin", "admin")


async def archive(store, workflow, value=True, **extra):
    return await handle_lifecycle_action({"action": "set_workflow_archived", "workflowId": workflow["id"], "archived": value, **extra}, store, "local-admin", "admin")


async def test_pause_resume_excludes_public_model_and_gateway_calls_without_touching_snapshots(fixture):
    store, workflow, deployment = fixture
    original = await store.get_deployment(deployment["id"])
    key = await store.create_key("local-lifecycle-fixture")
    app = FastAPI(); app.include_router(create_router(store, {}))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 1)), base_url="http://test") as client:
        headers = {"Authorization": f"Bearer {key['key']}"}
        assert workflow["alias"] in [model["id"] for model in (await client.get("/v1/models", headers=headers)).json()["data"]]
        await pause(store, deployment)
        assert await store.active_deployment(deployment["alias"]) is None
        assert not (await client.get("/v1/models", headers=headers)).json()["data"]
        response = await client.post("/v1/chat/completions", headers=headers, json={"model": deployment["alias"], "messages": [{"role": "user", "content": "배송 문의"}]})
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "model_not_found"
        assert not (await store.state())["logs"]
        await pause(store, deployment, False)
        assert await store.active_deployment(deployment["alias"]) == original
    assert await store.get_deployment(deployment["id"]) == original
    actions = [event["action"] for event in (await store.state())["audit"]]
    assert actions.count("set_deployment_paused") == 2


async def test_workflow_archive_requires_all_aliases_paused_and_resume_requires_restore(fixture):
    store, workflow, deployment = fixture
    another = await store.deploy({**deployment, "id": "second-alias", "alias": "second-api-name", "createdAt": iso_at()})
    with pytest.raises(ApiError) as raised:
        await archive(store, workflow)
    assert raised.value.code == "workflow_in_service"
    await pause(store, deployment)
    with pytest.raises(ApiError):
        await archive(store, workflow)
    await pause(store, another)
    await archive(store, workflow)
    current = await store.state()
    assert current["lifecycle"]["workflows"][workflow["id"]]["archived"] is True
    assert next(item for item in current["workflows"] if item["id"] == workflow["id"]) == workflow
    with pytest.raises(ApiError) as raised:
        await pause(store, deployment, False)
    assert raised.value.code == "workflow_archived"
    with pytest.raises(ApiError):
        await store.save_record_checked("workflow", workflow["id"], workflow)
    with pytest.raises(ApiError):
        await store.deploy({**deployment, "id": "archived-deployment"})
    await archive(store, workflow, False)
    assert await store.active_deployment(deployment["alias"]) is None
    await pause(store, deployment, False)
    assert await store.active_deployment(deployment["alias"])


async def test_paused_alias_stays_paused_after_new_deployment_and_stale_target_is_rejected(fixture):
    store, _, deployment = fixture
    await pause(store, deployment)
    current = await store.deploy({**deployment, "id": "deployment-2", "createdAt": iso_at(), "note": "new settings"})
    assert current["version"] == 2
    assert await store.active_deployment(deployment["alias"]) is None
    with pytest.raises(ApiError) as raised:
        await pause(store, deployment, False)
    assert raised.value.code == "stale_lifecycle"
    await pause(store, current, False)
    assert (await store.active_deployment(deployment["alias"]))["id"] == current["id"]


@pytest.mark.parametrize("role", ["viewer", "editor"])
async def test_lifecycle_actions_are_admin_only(fixture, role):
    store, workflow, deployment = fixture
    for data in [{"action": "set_deployment_paused", "alias": deployment["alias"], "paused": True, "expectedDeploymentId": deployment["id"]}, {"action": "set_workflow_archived", "workflowId": workflow["id"], "archived": True}, {"action": "set_policy_archived", "policyId": "policy", "archived": True}]:
        with pytest.raises(ApiError) as raised:
            await handle_lifecycle_action(data, store, "other", role)
        assert raised.value.status == 403
    assert (await store.state())["lifecycle"] == {"workflows": {}, "policies": {}, "deployments": {}}


async def test_lifecycle_compare_and_swap_and_transactional_audit(fixture):
    store, _, deployment = fixture
    await pause(store, deployment, expectedUpdatedAt=None)
    # Retrying the same completed transition does not append a second audit event.
    await pause(store, deployment, expectedUpdatedAt=None)
    before = (await store.state())["lifecycle"]["deployments"][deployment["alias"]]
    with pytest.raises(ApiError) as raised:
        await pause(store, deployment, False, expectedUpdatedAt=None)
    assert raised.value.code == "stale_lifecycle"
    await pause(store, deployment, False, expectedUpdatedAt=before["updatedAt"])
    assert len((await store.state())["audit"]) == 2
    # A failed audit insert rolls the state transition back in the same SQLite transaction.
    store.db.execute("CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON aegis_records WHEN NEW.namespace='audit' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END")
    with pytest.raises(Exception, match="fixture audit failure"):
        await pause(store, deployment)
    assert (await store.state())["lifecycle"]["deployments"][deployment["alias"]]["paused"] is False


async def test_deployed_workflow_delete_guard_and_unused_archive_cleanup_are_atomic(fixture):
    store, workflow, deployment = fixture
    await pause(store, deployment)
    await archive(store, workflow)
    with pytest.raises(ApiError) as raised:
        await store.remove("workflow", workflow["id"])
    assert raised.value.code == "deployed_workflow"
    assert await store.get_deployment(deployment["id"])
    unused = {**workflow, "id": "unused-draft"}
    await store.put("workflow", unused["id"], unused)
    await archive(store, unused)
    await store.remove("workflow", unused["id"])
    assert await store.get_record("workflow", unused["id"]) is None
    assert unused["id"] not in (await store.state())["lifecycle"]["workflows"]


async def test_lifecycle_survives_restart_and_is_separate_from_snapshots(fixture):
    store, workflow, deployment = fixture
    await pause(store, deployment)
    await archive(store, workflow)
    before = await store.state()
    reopened = Store(store.path)
    try:
        after = await reopened.state()
        assert after["lifecycle"] == before["lifecycle"]
        assert await reopened.get_deployment(deployment["id"]) == await store.get_deployment(deployment["id"])
        assert await reopened.active_deployment(deployment["alias"]) is None
    finally:
        await reopened.close()


async def test_console_lifecycle_response_and_audit_use_camel_case(fixture):
    store, workflow, deployment = fixture
    app = FastAPI(); app.include_router(create_router(store, {}))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 1)), base_url="http://test") as client:
        payload = {"action": "set_deployment_paused", "alias": deployment["alias"], "paused": True, "expectedDeploymentId": deployment["id"], "expectedUpdatedAt": None}
        response = await client.post("/api/console", json=payload)
        assert response.status_code == 200, response.text
        state = response.json()["state"]
        assert state["lifecycle"]["deployments"][deployment["alias"]]["paused"] is True
        assert "updatedAt" in state["lifecycle"]["deployments"][deployment["alias"]]
        assert len([event for event in state["audit"] if event["action"] == "set_deployment_paused"]) == 1
        response = await client.post("/api/console", json={"action": "set_workflow_archived", "workflowId": workflow["id"], "archived": True, "expectedUpdatedAt": None})
        assert response.status_code == 200, response.text
        assert response.json()["state"]["lifecycle"]["workflows"][workflow["id"]]["archived"] is True


@pytest.mark.parametrize("role", ["viewer", "editor"])
async def test_console_role_check_rejects_lifecycle_mutation(fixture, role):
    store, _, deployment = fixture
    app = FastAPI(); app.include_router(create_router(store, {"AEGIS_ROLE_MAP": {"local-admin": role}}))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 1)), base_url="http://test") as client:
        response = await client.post("/api/console", json={"action": "set_deployment_paused", "alias": deployment["alias"], "paused": True, "expectedDeploymentId": deployment["id"]})
        assert response.status_code == 403, response.text
        assert await store.active_deployment(deployment["alias"])


def policy_definition(connection):
    return {"id": "policy-fixture", "name": "테스트 분류", "description": "", "connectionId": connection["id"], "prompt": "분류하세요.", "formatVersion": 2, "decisions": [], "outputSchema": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"], "additionalProperties": False}, "examples": [{"id": "example", "input": "문의", "expectedOutput": {"value": "문의"}}]}


async def test_policy_archive_preserves_revisions_references_and_capacity(fixture):
    store, workflow, _ = fixture
    connection = next(item for item in (await store.state())["connections"] if item["role"] in {"guard", "both"})
    captured = await store.get_record_with_version("connection", connection["id"])
    definition = policy_definition(connection)
    revision = await store.save_policy_revision(definition, connection, 0, {"id": "policy-audit", "createdAt": iso_at()}, captured["revision"])
    await store.put("workflow", workflow["id"], {**workflow, "policyRouting": {"policy": revision, "routes": []}})
    await handle_lifecycle_action({"action": "set_policy_archived", "policyId": definition["id"], "archived": True}, store, "local-admin", "admin")
    current = await store.state()
    assert current["policies"] == [revision]
    assert current["policyCapacity"] == {"families": 1, "versions": 1, "maxFamilies": 30, "maxVersions": 100}
    assert (await store.get_record("workflow", workflow["id"]))["policyRouting"]["policy"] == revision
    with pytest.raises(ApiError) as raised:
        await store.save_policy_revision(definition, connection, 1, {"id": "policy-audit-2", "createdAt": iso_at()}, captured["revision"])
    assert raised.value.code == "policy_archived"
    await handle_lifecycle_action({"action": "set_policy_archived", "policyId": definition["id"], "archived": False}, store, "local-admin", "admin")
    second = await store.save_policy_revision(definition, connection, 1, {"id": "policy-audit-2", "createdAt": iso_at()}, captured["revision"])
    assert second["version"] == 2
    assert await store.get_record("policy", f"{definition['id']}:1") == revision


async def test_configured_policy_capacity_above_100_keeps_saved_versions_visible(fixture):
    store, _, _ = fixture
    connection = next(item for item in (await store.state())["connections"] if item["role"] in {"guard", "both"})
    captured = await store.get_record_with_version("connection", connection["id"])
    definition = policy_definition(connection)
    store.env["AEGIS_POLICY_MAX_VERSIONS"] = "101"
    for version in range(101):
        revision = await store.save_policy_revision(definition, connection, version, {"id": f"policy-audit-{version}", "createdAt": iso_at()}, captured["revision"])
    assert revision["version"] == 101
    assert PolicyRevision.model_validate(revision).version == 101
    assert len((await store.state())["policies"]) == 101
    with pytest.raises(ApiError) as raised:
        await store.save_policy_revision(definition, connection, 101, {"id": "over-limit", "createdAt": iso_at()}, captured["revision"])
    assert raised.value.code == "policy_limit"
    store.env["AEGIS_POLICY_MAX_VERSIONS"] = "100"
    assert len((await store.state())["policies"]) == 101
    assert (await store.state())["policyCapacity"]["versions"] == 101


async def test_maximum_saved_revision_reports_capacity_instead_of_invalid_save_basis(fixture):
    store, _, _ = fixture
    connection = next(item for item in (await store.state())["connections"] if item["role"] in {"guard", "both"})
    captured = await store.get_record_with_version("connection", connection["id"])
    definition = policy_definition(connection)
    revision = {**definition, "version": 1000, "updatedAt": iso_at(), "connectionSnapshot": connection}
    await store.put("policy", definition["id"] + ":1000", revision)
    with pytest.raises(ApiError) as raised:
        await store.save_policy_revision(definition, connection, 1000, {"id": "over-version-limit", "createdAt": iso_at()}, captured["revision"])
    assert raised.value.code == "policy_limit"
    assert await store.get_record("policy", definition["id"] + ":1001") is None


@pytest.mark.parametrize("value", [True, False, "invalid", "99", "1001", "100.5", None])
def test_invalid_policy_capacity_fails_explicitly(value):
    with pytest.raises(ApiError) as raised:
        policy_version_limit({"AEGIS_POLICY_MAX_VERSIONS": value})
    assert raised.value.code == "invalid_policy_capacity"


@pytest.mark.parametrize("value", [100, "100", " 250 ", 1000])
def test_valid_policy_capacity_is_bounded(value):
    assert policy_version_limit({"AEGIS_POLICY_MAX_VERSIONS": value}) == int(value)
