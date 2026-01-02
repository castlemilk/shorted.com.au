# Builder stage
FROM golang:1.24-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -o enrichment-processor ./enrichment-processor

# Final stage
FROM python:3.11-slim-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libpng-dev \
    libjpeg-dev \
    libfreetype6-dev \
    libcairo2 \
    libpangocairo-1.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    g++ \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy python requirements and install them
COPY enrichment-processor/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Download MobileSAM checkpoint
RUN wget https://raw.githubusercontent.com/ChaoningZhang/MobileSAM/master/weights/mobile_sam.pt -O mobile_sam.pt

# Pre-download models to avoid download at runtime
# 1. rembg
RUN python -c "from rembg import remove; import numpy as np; from PIL import Image; remove(np.zeros((10,10,3), dtype=np.uint8))"
# 2. EasyOCR
RUN python -c "import easyocr; reader = easyocr.Reader(['en'])"

# Copy the built Go binary and the Python processor script
COPY --from=builder /app/enrichment-processor .
COPY enrichment-processor/logo_processor.py .

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV MOBILE_SAM_CHECKPOINT=/app/mobile_sam.pt

CMD ["./enrichment-processor"]
