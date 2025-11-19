# Dockerfile for Comprehensive Daily Sync Job
# Updates both shorts data and stock prices
# Optimized for Cloud Run Jobs - runs once and exits

FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the sync script
COPY comprehensive_daily_sync.py .

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV SYNC_DAYS_STOCK_PRICES=5
ENV SYNC_DAYS_SHORTS=7
# ALPHA_VANTAGE_API_KEY should be set via Cloud Run environment variables

# Run the sync script
CMD ["python", "comprehensive_daily_sync.py"]

