import atexit
import os


def setup():
    # Skip if a TracerProvider is already configured (e.g. opentelemetry-instrument CLI)
    from opentelemetry import trace
    if not isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider):
        return

    from opentelemetry import context
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

    # 1. TracerProvider with OTLP exporter
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
    service_name = os.environ.get("OTEL_SERVICE_NAME", "agentobserve")
    resource = Resource.create({"service.name": service_name})

    provider = TracerProvider(resource=resource)
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
    )
    trace.set_tracer_provider(provider)

    # 2. Load all installed instrumentors
    # Skip in LangSmith OTEL-only mode: LangSmith emits its own LLM spans
    # through the TracerProvider, and the auto-loaded HTTP client
    # instrumentors (urllib3/requests/httpx) inject traceparent headers
    # into outbound calls — which breaks AWS SigV4 signing for Bedrock.
    if not os.environ.get("LANGSMITH_OTEL_ONLY"):
        _load_instrumentors(provider)

    # 3. Create root session span + propagate TRACEPARENT for subprocesses
    # Skip root span for LangChain — LangSmith manages its own hierarchy
    if os.environ.get("LANGSMITH_OTEL_ONLY"):
        return

    tracer = provider.get_tracer("agentobserve")
    root_span = tracer.start_span("agentobserve.session")
    ctx = trace.set_span_in_context(root_span)
    context.attach(ctx)

    carrier = {}
    TraceContextTextMapPropagator().inject(carrier, context=ctx)
    if "traceparent" in carrier:
        os.environ["TRACEPARENT"] = carrier["traceparent"]

    # 4. Cleanup on exit
    def _shutdown():
        root_span.end()
        provider.force_flush(timeout_millis=5000)
        provider.shutdown()
    atexit.register(_shutdown)


def _load_instrumentors(provider):
    """Discover and activate all installed opentelemetry instrumentors."""
    from importlib.metadata import entry_points

    try:
        eps = entry_points(group="opentelemetry_instrumentor")
    except TypeError:
        eps = entry_points().get("opentelemetry_instrumentor", [])

    for ep in eps:
        try:
            instrumentor_class = ep.load()
            instrumentor = instrumentor_class()
            if not instrumentor.is_instrumented_by_opentelemetry:
                instrumentor.instrument(tracer_provider=provider)
        except Exception:
            pass  # Skip instrumentors whose dependencies aren't installed
