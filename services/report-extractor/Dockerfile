# Report extractor — financial-report digests + director-trade (Appendix 3Y) extraction.
# One image, TWO Cloud Run Jobs differentiated by the job's `command`/`args`:
#   - financial-report-extractor: python extract_reports_concurrent.py ...
#   - director-trade-extractor:    python extract_director_trades.py ...
# Both import the sibling `extract` module, so all scripts live in the same WORKDIR.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

# pymupdf + psycopg2-binary wheels are usually prebuilt; gcc/g++ kept defensively.
RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install --no-cache-dir --timeout 120 --retries 5 -r requirements.txt

COPY . .

RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

# No locked CMD: each Cloud Run Job sets `command`/`args` to choose the script + flags.
# `import extract` resolves because WORKDIR=/app holds extract.py + both entrypoints.
ENTRYPOINT ["python"]
