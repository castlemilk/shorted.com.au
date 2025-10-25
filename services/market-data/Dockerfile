# Use Python 3.12 for better compatibility with our tested environment
FROM python:3.12

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PORT=8090
ENV PATH="/usr/local/bin:${PATH}"

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies with retry and timeout settings
RUN pip install --upgrade pip && \
    pip install --no-cache-dir --timeout 120 --retries 5 -r requirements.txt

# Copy application code
COPY . .

# Make Python files executable
RUN chmod +x *.py

# Create non-root user for security
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python3 -c "import requests; requests.get('http://localhost:8090/health')" || exit 1

# Expose port
EXPOSE 8090

# Run the enhanced application
CMD ["python3", "cloud_run_service_v4.py"]