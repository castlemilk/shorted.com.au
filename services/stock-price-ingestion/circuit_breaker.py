"""
Circuit breaker implementation for external service calls
"""
import time
from enum import Enum
from typing import Callable, Any, Optional, Awaitable
from dataclasses import dataclass
import logging
import asyncio
import inspect

logger = logging.getLogger(__name__)

class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

@dataclass
class CircuitBreakerConfig:
    failure_threshold: int = 5
    recovery_timeout: int = 60  # seconds
    half_open_max_calls: int = 3

class CircuitBreaker:
    def __init__(self, config: Optional[CircuitBreakerConfig] = None):
        self.config = config or CircuitBreakerConfig()
        self.state = CircuitState.CLOSED
        self.failure_count = 0
        self.last_failure_time = None
        self.half_open_calls = 0
        
    async def call(self, func: Callable, *args, **kwargs) -> Any:
        if self.state == CircuitState.OPEN:
            if self._should_attempt_reset():
                self.state = CircuitState.HALF_OPEN
                self.half_open_calls = 0
            else:
                raise Exception("Circuit breaker is OPEN")
        
        try:
            # Check if the function is async
            if inspect.iscoroutinefunction(func):
                result = await func(*args, **kwargs)
            else:
                # Run sync function in executor to avoid blocking
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(None, func, *args, **kwargs)
            
            self._on_success()
            return result
        except Exception as e:
            self._on_failure()
            raise e
    
    def _should_attempt_reset(self) -> bool:
        if self.last_failure_time is None:
            return False
        return time.time() - self.last_failure_time >= self.config.recovery_timeout
    
    def _on_success(self):
        if self.state == CircuitState.HALF_OPEN:
            self.half_open_calls += 1
            if self.half_open_calls >= self.config.half_open_max_calls:
                self.state = CircuitState.CLOSED
                self.failure_count = 0
                logger.info("Circuit breaker closed")
        else:
            self.failure_count = 0
    
    def _on_failure(self):
        self.failure_count += 1
        self.last_failure_time = time.time()
        
        if self.state == CircuitState.HALF_OPEN:
            self.state = CircuitState.OPEN
            logger.warning("Circuit breaker opened from half-open state")
        elif self.failure_count >= self.config.failure_threshold:
            self.state = CircuitState.OPEN
            logger.warning(f"Circuit breaker opened after {self.failure_count} failures")
    
    def get_state(self) -> CircuitState:
        """Get current circuit breaker state"""
        return self.state
    
    def get_metrics(self) -> dict:
        """Get circuit breaker metrics for monitoring"""
        return {
            "state": self.state.value,
            "failure_count": self.failure_count,
            "last_failure_time": self.last_failure_time,
            "half_open_calls": self.half_open_calls
        }