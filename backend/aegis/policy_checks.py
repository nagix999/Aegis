"""Find immutable policy bindings without coupling them to visual layout."""
from __future__ import annotations


def workflow_policy_bindings(workflow: dict) -> list[dict]:
    bindings = []
    if workflow.get("policyRouting"):
        bindings.append({"id": "policy", "stage": "pre", "routing": workflow["policyRouting"], "enabled": True})
    for stage in ("pre", "post"):
        for group in workflow.get(stage, []):
            for rule in group.get("rules", []):
                if rule.get("kind") == "policy" and rule.get("config", {}).get("policyRouting"):
                    bindings.append({"id": rule["id"], "stage": stage, "routing": rule["config"]["policyRouting"], "enabled": rule.get("enabled") is True, "rule": rule, "group": group})
    return bindings


def select_policy_binding(workflow: dict, identifier: str | None = None) -> dict | None:
    bindings = workflow_policy_bindings(workflow)
    if identifier is not None:
        matches = [item for item in bindings if item["id"] == identifier]
        return matches[0] if len(matches) == 1 else None
    legacy = next((item for item in bindings if item["id"] == "policy" and "rule" not in item), None)
    return legacy or (bindings[0] if len(bindings) == 1 else None)


def policy_routes(routing: dict) -> list[dict]:
    return [node for node in routing.get("graph", {}).get("nodes", []) if node.get("kind") == "action"] if routing["policy"].get("formatVersion", 1) == 2 else routing.get("routes", [])
