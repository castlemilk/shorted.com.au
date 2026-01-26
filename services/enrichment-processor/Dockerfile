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

# Install system dependencies and clean up in one layer to reduce image size
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
    && pip install --upgrade pip setuptools wheel \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /tmp/* \
    && rm -rf /var/tmp/*

WORKDIR /app

# Copy python requirements and install them
# Install PyTorch CPU-only first (much smaller than CUDA version, saves ~2GB)
# This avoids installing CUDA libraries which are not needed for Cloud Run
COPY enrichment-processor/requirements.txt ./

# Install PyTorch CPU-only versions first (smaller, no CUDA dependencies)
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
    torch>=2.0.0 torchvision>=0.15.0 \
    && pip cache purge

# Install remaining requirements
RUN pip install --no-cache-dir -r requirements.txt \
    && pip cache purge \
    && rm -rf /root/.cache/pip \
    && rm -rf /tmp/* \
    && rm -rf /var/tmp/*

# Download MobileSAM checkpoint
RUN wget https://raw.githubusercontent.com/ChaoningZhang/MobileSAM/master/weights/mobile_sam.pt -O mobile_sam.pt \
    && rm -rf /tmp/* /var/tmp/*

# Pre-download models to avoid download at runtime
# 1. rembg
RUN python -c "from rembg import remove; import numpy as np; from PIL import Image; remove(np.zeros((10,10,3), dtype=np.uint8))" \
    && rm -rf /tmp/* /var/tmp/* /root/.cache/*
# 2. EasyOCR
RUN python -c "import easyocr; reader = easyocr.Reader(['en'])" \
    && rm -rf /tmp/* /var/tmp/* /root/.cache/*

# Copy the built Go binary and the Python processor script
COPY --from=builder /app/enrichment-processor .
COPY enrichment-processor/logo_processor.py .

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV MOBILE_SAM_CHECKPOINT=/app/mobile_sam.pt

CMD ["./enrichment-processor"]
