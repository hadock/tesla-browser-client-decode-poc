"""Browser log ingest: POST JSON batches → CloudWatch Logs."""
import json
import os
import re
import time
import boto3
from botocore.exceptions import ClientError

LOG_GROUP = os.environ["LOG_GROUP"]
logs = boto3.client("logs")
_seq = {}


def _cors():
    return {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        "content-type": "application/json",
    }


def _session_id(raw):
    s = re.sub(r"[^a-zA-Z0-9._-]", "", str(raw or "unknown"))[:64]
    return s or "unknown"


def _ensure_stream(name):
    try:
        logs.create_log_stream(logGroupName=LOG_GROUP, logStreamName=name)
    except ClientError as e:
        if e.response["Error"]["Code"] != "ResourceAlreadyExistsException":
            raise


def _token(name):
    if name in _seq:
        return _seq[name]
    resp = logs.describe_log_streams(
        logGroupName=LOG_GROUP, logStreamNamePrefix=name, limit=10
    )
    for s in resp.get("logStreams", []):
        if s["logStreamName"] == name:
            return s.get("uploadSequenceToken")
    return None


def _put(name, lines):
    _ensure_stream(name)
    events = []
    for i, line in enumerate(lines):
        if isinstance(line, str):
            ts = int(time.time() * 1000) + i
            msg = line
        else:
            ts = int(line.get("ts") or (time.time() * 1000 + i))
            msg = json.dumps(line, separators=(",", ":"), default=str)
        events.append({"timestamp": ts, "message": msg})
    events.sort(key=lambda e: e["timestamp"])
    for i in range(1, len(events)):
        if events[i]["timestamp"] <= events[i - 1]["timestamp"]:
            events[i]["timestamp"] = events[i - 1]["timestamp"] + 1

    token = _token(name)
    for _ in range(3):
        kwargs = {
            "logGroupName": LOG_GROUP,
            "logStreamName": name,
            "logEvents": events,
        }
        if token:
            kwargs["sequenceToken"] = token
        try:
            out = logs.put_log_events(**kwargs)
            _seq[name] = out.get("nextSequenceToken")
            return {"ok": True, "count": len(events)}
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code in ("InvalidSequenceTokenException", "DataAlreadyAcceptedException"):
                token = e.response["Error"].get("expectedSequenceToken")
                if not token:
                    m = re.search(r"sequenceToken is:\s*(\S+)", e.response["Error"].get("Message", ""))
                    token = m.group(1) if m else None
                _seq[name] = token
                continue
            raise
    raise RuntimeError("PutLogEvents failed after retries")


def handler(event, context):
    method = (
        (event.get("requestContext") or {}).get("http", {}).get("method")
        or event.get("httpMethod")
        or "POST"
    )
    if method == "OPTIONS":
        return {"statusCode": 204, "headers": _cors(), "body": ""}

    try:
        raw = event.get("body") or "{}"
        if event.get("isBase64Encoded"):
            import base64
            raw = base64.b64decode(raw).decode("utf-8")
        body = json.loads(raw) if isinstance(raw, str) else raw
        session_id = _session_id(body.get("sessionId"))
        lines = body.get("lines") or []
        if not isinstance(lines, list) or not lines:
            return {"statusCode": 400, "headers": _cors(), "body": json.dumps({"error": "no lines"})}
        lines = lines[:100]
        enriched = []
        for line in lines:
            if isinstance(line, dict):
                row = dict(line)
                row.setdefault("sessionId", session_id)
                enriched.append(row)
            else:
                enriched.append({"ts": int(time.time() * 1000), "level": "info", "event": "raw", "msg": str(line), "sessionId": session_id})
        result = _put(f"session-{session_id}", enriched)
        return {"statusCode": 200, "headers": _cors(), "body": json.dumps(result)}
    except Exception as e:
        print("ERROR", e)
        return {"statusCode": 500, "headers": _cors(), "body": json.dumps({"error": str(e)})}
