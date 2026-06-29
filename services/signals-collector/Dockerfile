# Signals collector — calls brandbrain ResolveBusinessSignals and upserts stock_signals.
# Runs as a scheduled Cloud Run Job (scale-to-zero, no min instances).
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Only psycopg2-binary + requests are needed (brandbrain does the grounded research
# server-side, so no Gemini/LLM deps here). gcc kept for any psycopg2 source fallback.
RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install --no-cache-dir --timeout 120 --retries 5 -r requirements.txt

COPY . .

RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

# Cloud Run Job supplies the flags via the job's `args`; this is the default entrypoint.
ENTRYPOINT ["python", "collect.py"]
