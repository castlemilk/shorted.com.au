"""Thread-safe Gemini token accounting (contract 6.1 "Thinking and tokens").

Every Gemini response carries usage_metadata (prompt, candidates and thoughts
token counts). The extractor sums them per report and per run, so a run logs
what it actually spent instead of an estimate. A report's TokenUsage forwards
into the run's (its parent), so the run total is exact across worker threads.

No third-party dependencies.
"""
from __future__ import annotations

import threading
from typing import Any, Optional

# usage_metadata attribute -> the key it is summed under.
USAGE_FIELDS = {
    "prompt_token_count": "prompt",
    "candidates_token_count": "candidates",
    "thoughts_token_count": "thoughts",
}


class TokenUsage:
    """Summed prompt / candidates / thoughts tokens and the response count."""

    def __init__(self, parent: Optional["TokenUsage"] = None):
        self._lock = threading.Lock()
        self._parent = parent
        self.prompt = 0
        self.candidates = 0
        self.thoughts = 0
        self.responses = 0

    def add(self, usage_metadata: Any) -> None:
        """Add one response's usage_metadata (an SDK object or a dict). A
        missing field counts as 0; a response with no metadata still counts as
        a response."""
        counts = {}
        for attr, key in USAGE_FIELDS.items():
            if usage_metadata is None:
                value = None
            elif isinstance(usage_metadata, dict):
                value = usage_metadata.get(attr)
            else:
                value = getattr(usage_metadata, attr, None)
            counts[key] = int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0
        self._add_counts(counts, 1)

    def _add_counts(self, counts: dict, responses: int) -> None:
        with self._lock:
            self.prompt += counts["prompt"]
            self.candidates += counts["candidates"]
            self.thoughts += counts["thoughts"]
            self.responses += responses
        if self._parent is not None:
            self._parent._add_counts(counts, responses)

    @property
    def total(self) -> int:
        return self.prompt + self.candidates + self.thoughts

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "responses": self.responses,
                "prompt": self.prompt,
                "candidates": self.candidates,
                "thoughts": self.thoughts,
                "total": self.prompt + self.candidates + self.thoughts,
            }

    def summary(self) -> str:
        s = self.snapshot()
        return (
            f"responses={s['responses']} prompt={s['prompt']} candidates={s['candidates']} "
            f"thoughts={s['thoughts']} total={s['total']}"
        )
