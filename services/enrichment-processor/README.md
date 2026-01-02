# Enrichment Processor

The enrichment processor handles asynchronous enrichment jobs for company metadata, including logo discovery and processing.

## Python Dependencies

The logo processing functionality requires Python dependencies including:
- `rembg` - Background removal
- `mobile-sam` - Segment Anything Model for icon extraction
- `easyocr` - Text detection
- `torch` & `torchvision` - ML framework
- Other dependencies listed in `requirements.txt`

## Setup

### Using Virtual Environment (Recommended)

Set up a Python virtual environment with all dependencies:

```bash
cd services
make setup.enrichment-processor.venv
```

This will:
1. Create a virtual environment in `enrichment-processor/venv/`
2. Install all Python dependencies from `requirements.txt`
3. Download the MobileSAM checkpoint model

### Manual Setup

If you prefer to set up manually:

```bash
cd services/enrichment-processor
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# Download MobileSAM checkpoint
wget https://raw.githubusercontent.com/ChaoningZhang/MobileSAM/master/weights/mobile_sam.pt -O mobile_sam.pt
```

## Running

The enrichment processor will automatically use the venv Python if available, otherwise it falls back to system `python3`.

Start the processor:

```bash
cd services
make run.enrichment-processor
```

Or from the root:

```bash
make dev-enrichment-processor
```

## Logo Processing

The processor includes advanced logo processing:
- **Background removal** using rembg
- **Icon extraction** using SAM + EasyOCR to separate graphical icons from text
- **Multiple sizes** generated (64px, 128px, 256px, 512px)
- **GCS upload** for both full logo and icon-only variants

If SAM is not available, the processor will still work but will only generate the full logo (without icon extraction).

