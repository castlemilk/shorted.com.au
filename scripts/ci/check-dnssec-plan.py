#!/usr/bin/env python3
"""Fail closed on any DNSSEC action. Read private plan JSON only from stdin."""
import json
import sys

ADDRESS = "module.edge.cloudflare_zone_dnssec.shorted[0]"
MAX_BYTES = 64 * 1024 * 1024


def require(condition):
    if not condition:
        raise ValueError("invalid plan")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def resources(module):
    require(isinstance(module, dict))
    values = module.get("resources", [])
    children = module.get("child_modules", [])
    require(isinstance(values, list) and isinstance(children, list))
    for value in values:
        require(isinstance(value, dict))
        yield value
    for child in children:
        yield from resources(child)


def check(plan):
    require(isinstance(plan, dict) and plan.get("format_version") == "1.2")
    require(plan.get("errored") is False and plan.get("complete") is True)
    require(not plan.get("deferred_changes"))
    changes = plan.get("resource_changes")
    require(isinstance(changes, list) and all(isinstance(x, dict) for x in changes))
    # Another address must not mutate the same zone behind this no-op resource.
    # Conservatively reject every additional DNSSEC resource, rather than infer
    # the zone of a deletion, import, or unknown planned value.
    dnssec = [x for x in changes if x.get("type") == "cloudflare_zone_dnssec"]
    require(len(dnssec) == 1 and dnssec[0].get("address") == ADDRESS)
    matches = [x for x in changes if x.get("address") == ADDRESS]
    require(len(matches) == 1)
    resource = matches[0]
    require(resource.get("mode") == "managed")
    require(resource.get("type") == "cloudflare_zone_dnssec")
    require("deposed" not in resource and "previous_address" not in resource)
    change = resource.get("change")
    require(isinstance(change, dict) and change.get("actions") == ["no-op"])
    require(change.get("after_unknown") == {})
    before, after = change.get("before"), change.get("after")
    require(isinstance(before, dict) and isinstance(after, dict))
    require(before == after)
    require(before.get("status") in ("active", "pending", "disabled", "pending-disabled", "error"))
    require(isinstance(before.get("zone_id"), str) and bool(before["zone_id"]))
    require(before.get("id") == before["zone_id"])
    planned = plan.get("planned_values")
    require(isinstance(planned, dict))
    found = [x for x in resources(planned.get("root_module")) if x.get("address") == ADDRESS]
    require(len(found) == 1)
    require(found[0].get("mode") == "managed" and found[0].get("type") == "cloudflare_zone_dnssec")
    require(found[0].get("values") == after)


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        require(len(raw) <= MAX_BYTES)
        plan = json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=lambda _: require(False))
        check(plan)
    except (ValueError, TypeError, KeyError, RecursionError):
        print("DNSSEC gate: rejected malformed, incomplete, or non-preserving plan.", file=sys.stderr)
        return 1
    print("DNSSEC gate: existing resource is unchanged.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
