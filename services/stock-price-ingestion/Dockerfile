# Use Python 3.11 for better performance and compatibility
FROM python:3.11-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PORT=8080

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies with retry and timeout settings
RUN pip install --upgrade pip && \
    pip install --no-cache-dir --timeout 120 --retries 5 -r requirements.txt

# Copy application code
COPY . .

# Copy ASX company list for stock discovery
COPY ../../analysis/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv /app/data/ASX_Listed_Companies_07-04-2024_11-03-45_AEST.csv

# Create non-root user for security
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8080/health')" || exit 1

# Expose port
EXPOSE 8080

# Run the application
CMD ["python", "simple_sync.py"]