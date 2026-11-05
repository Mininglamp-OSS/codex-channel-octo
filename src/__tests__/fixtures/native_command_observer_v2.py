"""Fresh, offline, test-only derivative of the documented command counter.

Input is sanitized shape metadata, never a rollout/session export. No I/O,
command execution, raw arguments, or output inspection is performed here.
"""

VERSION = 2
MAX_RECORDS = 4096


def observe(records):
    """Count covered *records*, not unique executions or historical causes.

    The producer labels each sanitized interface explicitly: projected events
    cannot be distinguished from SDK events by their shape alone. Optional
    designated_match is a content-free fact supplied by a trusted sanitizer;
    absent that fact matching remains UNOBSERVED. This module never attempts
    to recover commands from private arguments/outputs. No sample means no
    match evidence. Truncated coverage cannot establish a complete match.
    """
    counts = {"rollout_function_call": 0, "sdk_native": 0,
              "app_server_native": 0, "app_server_projected": 0}
    phases = {"started": 0, "completed": 0}
    total = known = 0
    mismatch = limited = False
    for index, record in enumerate(records):
        if index >= MAX_RECORDS:
            limited = True
            break
        if type(record) is not dict:
            continue
        interface = record.get("interface")
        payload = record.get("payload")
        payload = payload if type(payload) is dict else {}
        category = phase = None
        if record.get("type") == "response_item" and payload.get("type") == "function_call":
            if payload.get("name") in ("exec_command", "shell_command", "shell"):
                category = "rollout_function_call"
        elif interface in ("sdk", "app_server_projected"):
            item = record.get("item")
            if type(item) is dict and item.get("type") == "command_execution":
                if record.get("type") in ("item.started", "item.completed"):
                    category = "sdk_native" if interface == "sdk" else "app_server_projected"
                    phase = record["type"].split(".")[1]
        elif interface == "app_server":
            params = record.get("params")
            item = params.get("item") if type(params) is dict else None
            if type(item) is dict and item.get("type") == "commandExecution":
                if record.get("method") in ("item/started", "item/completed"):
                    category = "app_server_native"
                    phase = record["method"].split("/")[1]
        if category is None:
            continue
        counts[category] += 1
        total += 1
        if phase is not None:
            phases[phase] += 1
        match = record.get("designated_match")
        if type(match) is bool:
            known += 1
            mismatch = mismatch or not match
    command_match = "FALSE" if mismatch else "TRUE" if total and known == total and not limited else "UNOBSERVED"
    return {"version": VERSION, "counts": counts, "phases": phases,
            "command_match": command_match, "limited": limited}
