import os

if os.environ.get("AGENTOBSERVE_ENABLED"):
    from agentobserve._auto import setup
    setup()
