# Copyright (c) 2026 Rishu Goyal. All rights reserved.
# Licensed under the Business Source License 1.1.
# See LICENSE in the project root for license terms.
import json
import os
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, Request, Response
from google.protobuf import json_format
from opentelemetry.proto.collector.logs.v1 import logs_service_pb2
from opentelemetry.proto.collector.metrics.v1 import metrics_service_pb2
from opentelemetry.proto.collector.trace.v1 import trace_service_pb2
from opentelemetry.proto.metrics.v1 import metrics_pb2

app = FastAPI()

TELEMETRY_DIR = Path(os.environ.get("TELEMETRY_DIR", str(Path(__file__).parent / "telemetry")))


def _find_attr(attributes, *keys: str) -> str | None:
    for attr in attributes:
        if attr.key in keys:
            return attr.value.string_value or None
    return None


def _resolve_session(proto_msg) -> str:
    resources = (
        getattr(proto_msg, "resource_spans", None)
        or getattr(proto_msg, "resource_metrics", None)
        or getattr(proto_msg, "resource_logs", None)
    )
    if not resources:
        return "unknown"
    first = resources[0]

    # 1. Try resource-level session.id
    resource = getattr(first, "resource", None)
    if resource:
        v = _find_attr(resource.attributes, "session.id")
        if v:
            return v

    # 2. Try span/record attributes: session.id first, then langsmith.trace.session_name
    for scope_group in (
        getattr(first, "scope_spans", [])
        or getattr(first, "scope_metrics", [])
        or getattr(first, "scope_logs", [])
    ):
        records = (
            getattr(scope_group, "spans", [])
            or getattr(scope_group, "metrics", [])
            or getattr(scope_group, "log_records", [])
        )
        if records:
            # Metric records carry attributes on their data points, not the
            # record itself — getattr guards the AttributeError.
            attrs = getattr(records[0], "attributes", None)
            if attrs is not None:
                v = _find_attr(
                    attrs,
                    "session.id",
                    "langsmith.trace.session_name",
                )
                if v:
                    return v
            break

    # 3. Metrics carry session.id on each data point, not the metric record or
    # the resource (Claude Code / Anthropic SDK cost+usage metrics). Descend
    # into the first data point of the first metric that has one.
    for scope_metrics in getattr(first, "scope_metrics", []):
        for metric in getattr(scope_metrics, "metrics", []):
            shape = metric.WhichOneof("data")
            if not shape:
                continue
            data_points = getattr(getattr(metric, shape), "data_points", None)
            if data_points:
                v = _find_attr(data_points[0].attributes, "session.id")
                if v:
                    return v

    return "unknown"


def _save(signal: str, proto_msg, raw: bytes, session: str) -> None:
    out_dir = TELEMETRY_DIR / session
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = int(time.time() * 1000)
    base = out_dir / f"{signal}_{ts}"
    base.with_suffix(".pb").write_bytes(raw)
    base.with_suffix(".json").write_text(
        json.dumps(json_format.MessageToDict(proto_msg), indent=2)
    )


def _attr_int(attributes, key: str) -> int | None:
    for attr in attributes:
        if attr.key == key:
            v = attr.value
            if v.HasField("int_value"):
                return v.int_value
            if v.HasField("double_value"):
                return int(v.double_value)
    return None


def _derive_and_save_metrics(trace_msg, session: str) -> None:
    """Extract gen_ai.usage.* from span attributes and write a derived metrics file."""
    input_tokens = 0
    output_tokens = 0
    found = False

    for rs in trace_msg.resource_spans:
        for ss in rs.scope_spans:
            for span in ss.spans:
                it = _attr_int(span.attributes, "gen_ai.usage.input_tokens")
                ot = _attr_int(span.attributes, "gen_ai.usage.output_tokens")
                if it is not None:
                    input_tokens += it
                    found = True
                if ot is not None:
                    output_tokens += ot
                    found = True

    if not found:
        return

    ts_ns = int(time.time() * 1e9)

    def _make_sum(name: str, value: int) -> metrics_pb2.Metric:
        return metrics_pb2.Metric(
            name=name,
            sum=metrics_pb2.Sum(
                data_points=[
                    metrics_pb2.NumberDataPoint(
                        as_int=value,
                        start_time_unix_nano=ts_ns,
                        time_unix_nano=ts_ns,
                    )
                ],
                # 1 = AGGREGATION_TEMPORALITY_DELTA
                aggregation_temporality=1,
                is_monotonic=True,
            ),
        )

    metrics_req = metrics_service_pb2.ExportMetricsServiceRequest(
        resource_metrics=[
            metrics_pb2.ResourceMetrics(
                scope_metrics=[
                    metrics_pb2.ScopeMetrics(
                        metrics=[
                            _make_sum("gen_ai.usage.input_tokens", input_tokens),
                            _make_sum("gen_ai.usage.output_tokens", output_tokens),
                        ]
                    )
                ]
            )
        ]
    )
    _save("metrics", metrics_req, metrics_req.SerializeToString(), session)


@app.post("/v1/traces")
async def receive_traces(request: Request) -> Response:
    raw = await request.body()
    msg = trace_service_pb2.ExportTraceServiceRequest()
    msg.ParseFromString(raw)
    session = _resolve_session(msg)
    _save("traces", msg, raw, session)
    _derive_and_save_metrics(msg, session)
    resp = trace_service_pb2.ExportTraceServiceResponse()
    return Response(content=resp.SerializeToString(), media_type="application/x-protobuf")


@app.post("/v1/metrics")
async def receive_metrics(request: Request) -> Response:
    raw = await request.body()
    msg = metrics_service_pb2.ExportMetricsServiceRequest()
    msg.ParseFromString(raw)
    session = _resolve_session(msg)
    _save("metrics", msg, raw, session)
    resp = metrics_service_pb2.ExportMetricsServiceResponse()
    return Response(content=resp.SerializeToString(), media_type="application/x-protobuf")


_BODY_REF_LOG_BODIES = {
    "claude_code.api_request_body",
    "claude_code.api_response_body",
}


def _relocate_body_refs(logs_msg, session: str) -> bytes | None:
    """Move CLI-written raw API body files into telemetry/<session>/api_bodies/
    and rewrite each log record's body_ref attribute to the new path.

    Returns re-serialized protobuf bytes if any record was rewritten, else None.
    """
    target_dir = TELEMETRY_DIR / session / "api_bodies"
    mutated = False

    for rl in logs_msg.resource_logs:
        for sl in rl.scope_logs:
            for rec in sl.log_records:
                if rec.body.string_value not in _BODY_REF_LOG_BODIES:
                    continue
                for attr in rec.attributes:
                    if attr.key != "body_ref":
                        continue
                    src = attr.value.string_value
                    if not src:
                        break
                    src_path = Path(src)
                    if not src_path.is_file():
                        break
                    target_dir.mkdir(parents=True, exist_ok=True)
                    dest = target_dir / src_path.name
                    try:
                        shutil.move(str(src_path), str(dest))
                    except OSError:
                        break
                    attr.value.string_value = str(dest)
                    mutated = True
                    break

    return logs_msg.SerializeToString() if mutated else None


@app.post("/v1/logs")
async def receive_logs(request: Request) -> Response:
    raw = await request.body()
    msg = logs_service_pb2.ExportLogsServiceRequest()
    msg.ParseFromString(raw)
    session = _resolve_session(msg)
    rewritten = _relocate_body_refs(msg, session)
    _save("logs", msg, rewritten or raw, session)
    resp = logs_service_pb2.ExportLogsServiceResponse()
    return Response(content=resp.SerializeToString(), media_type="application/x-protobuf")
