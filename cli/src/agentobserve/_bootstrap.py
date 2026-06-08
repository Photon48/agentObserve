# Copyright (c) 2026 Rishu Goyal. All rights reserved.
# Licensed under the Business Source License 1.1.
# See LICENSE in the project root for license terms.
import os

if os.environ.get("AGENTOBSERVE_ENABLED"):
    from agentobserve._auto import setup
    setup()
