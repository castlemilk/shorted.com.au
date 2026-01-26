"""
Logo Processor v2 - Smarter icon extraction using SAM and improved heuristics.

Key improvements over v1:
1. Uses SAM for semantic segmentation to find distinct visual components
2. Scores segments to identify primary brand mark vs taglines
3. Only removes clearly separated taglines, preserves integrated logo marks
4. Falls back to full logo if icon extraction doesn't produce good results
"""
import sys
import os
import argparse
import json
from PIL import Image
import numpy as np
from rembg import remove
import io
import torch
import cv2

# Configuration constants
MIN_ICON_SIZE = 128
TARGET_UPSCALE_SIZE = 256
NOISE_THRESHOLD_RATIO = 0.005
ICON_ASPECT_RATIO_THRESHOLD = 1.5
LOGO_VARIANTS_SIZES = [64, 128, 256, 512]

# Icon extraction thresholds
MIN_ICON_AREA_RATIO = 0.15  # Icon must be at least 15% of total logo area
MAX_TAGLINE_AREA_RATIO = 0.4  # Tagline should be less than 40% of logo
MIN_SEPARATION_RATIO = 0.1  # Minimum vertical/horizontal gap between mark and tagline

# Global model instances
_reader = None
_sam_model = None


def get_reader():
    """Get or initialize EasyOCR reader."""
    global _reader
    if _reader is None:
        import easyocr
        _reader = easyocr.Reader(["en"])
    return _reader


def get_sam_model():
    """Get or initialize MobileSAM model."""
    global _sam_model
    if _sam_model is None:
        try:
            from mobile_sam import sam_model_registry, SamPredictor

            model_type = "vit_t"
            sam_checkpoint = os.environ.get("MOBILE_SAM_CHECKPOINT", "mobile_sam.pt")
            if not os.path.exists(sam_checkpoint):
                sam_checkpoint = "services/enrichment-processor/mobile_sam.pt"
            if not os.path.exists(sam_checkpoint):
                # Try current directory
                sam_checkpoint = os.path.join(os.path.dirname(__file__), "mobile_sam.pt")

            if not os.path.exists(sam_checkpoint):
                print(f"Warning: MobileSAM checkpoint not found", file=sys.stderr)
                _sam_model = False
                return None

            device = "cuda" if torch.cuda.is_available() else "cpu"
            mobile_sam = sam_model_registry[model_type](checkpoint=sam_checkpoint)
            mobile_sam.to(device=device)
            mobile_sam.eval()
            _sam_model = SamPredictor(mobile_sam)
            print(f"Loaded MobileSAM on {device}", file=sys.stderr)
        except ImportError as e:
            print(f"Warning: SAM not available: {e}", file=sys.stderr)
            _sam_model = False
            return None
        except Exception as e:
            print(f"Warning: Failed to initialize SAM: {e}", file=sys.stderr)
            _sam_model = False
            return None
    if _sam_model is False:
        return None
    return _sam_model


def analyze_logo_structure(img):
    """
    Analyze the logo to understand its structure:
    - Is there a clear icon/mark + tagline separation?
    - Or is the text integrated into the mark?
    
    Returns:
        dict with analysis results
    """
    result = {
        'has_text': False,
        'text_regions': [],
        'has_separate_tagline': False,
        'integrated_text_logo': False,
        'primary_mark_bbox': None,
        'tagline_bbox': None,
    }
    
    # Convert to OpenCV format
    img_array = np.array(img)
    if img_array.shape[2] == 4:
        img_bgr = cv2.cvtColor(img_array, cv2.COLOR_RGBA2BGR)
        alpha = img_array[:, :, 3]
    else:
        img_bgr = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
        alpha = np.ones(img_array.shape[:2], dtype=np.uint8) * 255
    
    h, w = img_bgr.shape[:2]
    content_mask = (alpha > 0).astype(np.uint8) * 255
    total_content_area = content_mask.sum() // 255
    
    if total_content_area == 0:
        return result
    
    # Detect text regions
    reader = get_reader()
    text_results = reader.readtext(img_bgr)
    
    if not text_results:
        return result
    
    result['has_text'] = True
    
    # Analyze each text region
    for bbox, text, conf in text_results:
        pts = np.array(bbox, np.int32)
        x_min, y_min = pts.min(axis=0)
        x_max, y_max = pts.max(axis=0)
        text_w, text_h = x_max - x_min, y_max - y_min
        text_area = text_w * text_h
        
        region = {
            'text': text,
            'confidence': conf,
            'bbox': (x_min, y_min, x_max, y_max),
            'area': text_area,
            'area_ratio': text_area / total_content_area,
            'center_y': (y_min + y_max) / 2,
            'is_upper': (y_min + y_max) / 2 < h / 2,
        }
        result['text_regions'].append(region)
        print(f"  Text: '{text}' conf={conf:.2f}, area_ratio={region['area_ratio']:.2f}, upper={region['is_upper']}", file=sys.stderr)
    
    # Determine if there's a separate tagline
    # A tagline is typically:
    # 1. Below or beside the main mark
    # 2. Smaller area than the main content
    # 3. Clearly separated from the mark
    
    if len(result['text_regions']) >= 2:
        # Sort by area (largest first)
        sorted_regions = sorted(result['text_regions'], key=lambda x: x['area'], reverse=True)
        
        # Check if there's a clear primary mark vs tagline
        primary = sorted_regions[0]
        secondary = sorted_regions[1]
        
        # If secondary is much smaller and positioned below/beside, it's likely a tagline
        if secondary['area_ratio'] < MAX_TAGLINE_AREA_RATIO:
            # Check vertical separation
            if secondary['center_y'] > primary['center_y']:
                # Secondary is below primary - likely tagline
                gap = secondary['bbox'][1] - primary['bbox'][3]
                if gap > h * MIN_SEPARATION_RATIO * 0.5:  # Some vertical gap
                    result['has_separate_tagline'] = True
                    result['primary_mark_bbox'] = primary['bbox']
                    result['tagline_bbox'] = secondary['bbox']
                    print(f"  Detected separate tagline: '{secondary['text']}' below '{primary['text']}'", file=sys.stderr)
    
    # Check if there's a graphical element (non-text) that could be an icon
    # Create a mask of all text regions
    text_mask = np.zeros((h, w), dtype=np.uint8)
    for region in result['text_regions']:
        x1, y1, x2, y2 = region['bbox']
        # Expand bbox slightly
        pad = 5
        x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
        x2, y2 = min(w, x2 + pad), min(h, y2 + pad)
        text_mask[y1:y2, x1:x2] = 255
    
    # Find non-text content
    non_text_mask = cv2.bitwise_and(content_mask, cv2.bitwise_not(text_mask))
    non_text_area = non_text_mask.sum() // 255
    
    # Calculate actual text coverage (intersection of text bbox with content)
    text_content_intersection = cv2.bitwise_and(content_mask, text_mask).sum() // 255
    text_coverage = text_content_intersection / total_content_area if total_content_area > 0 else 0
    
    print(f"  Non-text area: {non_text_area}, Text coverage: {text_coverage:.1%}", file=sys.stderr)
    
    # Check if there's a significant non-text graphical element (potential icon)
    if non_text_area > total_content_area * 0.15:  # At least 15% is graphical
        # There's a clear icon/graphic separate from text
        result['has_graphical_icon'] = True
        
        # Find the bounding box of the non-text content
        contours, _ = cv2.findContours(non_text_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if contours:
            largest_contour = max(contours, key=cv2.contourArea)
            x, y, gw, gh = cv2.boundingRect(largest_contour)
            result['icon_bbox'] = (x, y, x + gw, y + gh)
            print(f"  Found graphical icon: {gw}x{gh} at ({x},{y})", file=sys.stderr)
    
    # Logo is "text-integrated" only if:
    # 1. Text covers most of the content (>70%)
    # 2. AND there's no significant graphical element
    if text_coverage > 0.7 and not result.get('has_graphical_icon'):
        result['integrated_text_logo'] = True
        print(f"  Text-integrated logo (text coverage: {text_coverage:.1%})", file=sys.stderr)
    
    return result


def extract_icon_smart(img, stock_code, analysis):
    """
    Smart icon extraction that considers logo structure.
    
    Strategy:
    1. If there's a clear graphical icon separate from text, extract it
    2. If logo has integrated text (like "4DS"), keep full logo
    3. If there's a clear tagline, remove only the tagline
    4. Use SAM to find the best segment for the icon
    """
    img_array = np.array(img)
    h, w = img_array.shape[:2]
    alpha = img_array[:, :, 3] if img_array.shape[2] == 4 else np.ones((h, w), dtype=np.uint8) * 255
    content_mask = (alpha > 0).astype(np.uint8) * 255
    
    # Strategy 0: Pure graphic logo (no text) - use full logo as icon
    if not analysis.get('has_text'):
        print(f"  Pure graphic logo (no text) - using full logo", file=sys.stderr)
        return None  # Use full logo
    
    # Strategy 0.5: If there's a clear graphical icon, extract it directly
    if analysis.get('has_graphical_icon') and analysis.get('icon_bbox'):
        print(f"  Extracting graphical icon (separate from text)", file=sys.stderr)
        x1, y1, x2, y2 = analysis['icon_bbox']
        # Add some padding
        pad = 10
        x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
        x2, y2 = min(w, x2 + pad), min(h, y2 + pad)
        
        # Create mask for just the icon region
        icon_mask = np.zeros((h, w), dtype=bool)
        # Use the content mask within the icon bbox
        icon_mask[y1:y2, x1:x2] = content_mask[y1:y2, x1:x2] > 0
        
        icon_area = icon_mask.sum()
        total_area = content_mask.sum() // 255
        if icon_area > total_area * MIN_ICON_AREA_RATIO:
            return icon_mask
    
    # Strategy 1: Integrated text logo - keep full logo
    if analysis.get('integrated_text_logo'):
        print(f"  Keeping full logo (text integrated into mark)", file=sys.stderr)
        return None  # Signal to use full logo
    
    # Strategy 2: Separate tagline - remove only tagline
    if analysis.get('has_separate_tagline') and analysis.get('tagline_bbox'):
        print(f"  Removing tagline, keeping primary mark", file=sys.stderr)
        tagline_bbox = analysis['tagline_bbox']
        
        # Create mask that excludes tagline area
        icon_mask = content_mask.copy()
        x1, y1, x2, y2 = tagline_bbox
        # Add padding around tagline
        pad = 10
        y1 = max(0, y1 - pad)
        y2 = min(h, y2 + pad)
        x1 = max(0, x1 - pad)
        x2 = min(w, x2 + pad)
        icon_mask[y1:y2, x1:x2] = 0
        
        # Clean up with morphological operations
        kernel = np.ones((3, 3), np.uint8)
        icon_mask = cv2.morphologyEx(icon_mask, cv2.MORPH_OPEN, kernel)
        
        if icon_mask.sum() > content_mask.sum() * MIN_ICON_AREA_RATIO:
            return icon_mask > 0
    
    # Strategy 3: Try SAM segmentation
    sam = get_sam_model()
    if sam is not None:
        print(f"  Attempting SAM segmentation", file=sys.stderr)
        try:
            img_rgb = cv2.cvtColor(img_array, cv2.COLOR_RGBA2RGB) if img_array.shape[2] == 4 else img_array
            sam.set_image(img_rgb)
            
            # Use grid of points to find segments
            masks, scores, _ = sam.predict(
                point_coords=None,
                point_labels=None,
                multimask_output=True,
                box=None,
            )
            
            if masks is not None and len(masks) > 0:
                # Score each mask - prefer compact, icon-like shapes
                best_mask = None
                best_score = -1
                
                for mask, model_score in zip(masks, scores):
                    # Calculate shape metrics
                    mask_uint8 = mask.astype(np.uint8)
                    contours, _ = cv2.findContours(mask_uint8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    if not contours:
                        continue
                    
                    cnt = max(contours, key=cv2.contourArea)
                    area = cv2.contourArea(cnt)
                    x, y, mw, mh = cv2.boundingRect(cnt)
                    
                    if area < content_mask.sum() * MIN_ICON_AREA_RATIO // 255:
                        continue  # Too small
                    
                    # Prefer square-ish shapes (icon-like)
                    aspect = max(mw, mh) / max(min(mw, mh), 1)
                    compactness = area / (mw * mh) if mw * mh > 0 else 0
                    
                    # Score: higher is better
                    score = model_score * compactness / (aspect ** 0.5)
                    
                    if score > best_score:
                        best_score = score
                        best_mask = mask
                
                if best_mask is not None:
                    print(f"  SAM found icon segment (score={best_score:.2f})", file=sys.stderr)
                    return best_mask
        except Exception as e:
            print(f"  SAM segmentation failed: {e}", file=sys.stderr)
    
    # Strategy 4: Fall back to original method (but more conservative)
    print(f"  Using conservative text removal", file=sys.stderr)
    
    # Only remove text if we have clear, high-confidence tagline text
    if not analysis.get('has_text') or len(analysis.get('text_regions', [])) < 2:
        return None  # Keep full logo
    
    # Find text that looks like a tagline (small, below main content)
    text_regions = analysis.get('text_regions', [])
    tagline_regions = [r for r in text_regions if r['area_ratio'] < 0.2 and not r['is_upper']]
    
    if not tagline_regions:
        return None  # No clear tagline, keep full logo
    
    # Create mask removing only clear taglines
    icon_mask = content_mask.copy()
    for region in tagline_regions:
        x1, y1, x2, y2 = region['bbox']
        pad = 15
        y1 = max(0, y1 - pad)
        y2 = min(h, y2 + pad)
        x1 = max(0, x1 - pad)
        x2 = min(w, x2 + pad)
        icon_mask[y1:y2, x1:x2] = 0
    
    if icon_mask.sum() > content_mask.sum() * MIN_ICON_AREA_RATIO:
        return icon_mask > 0
    
    return None  # Keep full logo


def has_transparency(img):
    """Check if image has meaningful transparency."""
    if img.mode != "RGBA":
        return False
    alpha = np.array(img)[:, :, 3]
    transparent_ratio = (alpha < 255).sum() / alpha.size
    return transparent_ratio > 0.05


def load_source_image(input_path):
    """Read input image and force RGBA."""
    if input_path.endswith(".svg"):
        import cairosvg
        png_data = cairosvg.svg2png(url=input_path)
        return Image.open(io.BytesIO(png_data)).convert("RGBA")
    return Image.open(input_path).convert("RGBA")


def apply_background_removal(src_img):
    """Remove solid background using rembg if needed."""
    if has_transparency(src_img):
        print("Source has transparency, skipping rembg", file=sys.stderr)
        full_logo = src_img.copy()
    else:
        print("Removing background with rembg", file=sys.stderr)
        mask_img = remove(src_img, only_mask=True)
        mask_np = np.array(mask_img) > 128
        src_np = np.array(src_img)
        full_np = src_np.copy()
        full_np[~mask_np, 3] = 0
        full_logo = Image.fromarray(full_np, mode="RGBA")

    bbox = full_logo.getbbox()
    return full_logo.crop(bbox) if bbox else full_logo


def save_logo_variants(full_logo, icon_only, output_dir, stock_code):
    """Generate and save various logo sizes."""
    os.makedirs(output_dir, exist_ok=True)
    output_files = []

    # Save primary variants
    full_logo_path = os.path.join(output_dir, f"{stock_code}.png")
    full_logo.save(full_logo_path, "PNG")
    output_files.append(full_logo_path)

    if icon_only is not None:
        icon_path = os.path.join(output_dir, f"{stock_code}_icon.png")
        icon_only.save(icon_path, "PNG")
        output_files.append(icon_path)

    # Generate standard sizes
    for img_obj, prefix in [(full_logo, ""), (icon_only, "icon_")]:
        if img_obj is None:
            continue

        for size in LOGO_VARIANTS_SIZES:
            w, h = img_obj.size
            if w > h:
                new_w, new_h = size, int(h * (size / w))
            else:
                new_h, new_w = size, int(w * (size / h))

            resized = img_obj.resize((new_w, new_h), Image.Resampling.LANCZOS)
            canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            canvas.paste(resized, ((size - new_w) // 2, (size - new_h) // 2))

            name = f"{stock_code}_{prefix}{size}.png" if prefix else f"{stock_code}_{size}.png"
            size_path = os.path.join(output_dir, name)
            canvas.save(size_path, "PNG")
            output_files.append(size_path)

    return output_files


def process_logo(input_path, output_dir, stock_code):
    """Main logo processing pipeline with smart icon extraction."""
    try:
        print(f"Processing logo for {stock_code}", file=sys.stderr)
        
        # Load and clean image
        src_img = load_source_image(input_path)
        full_logo = apply_background_removal(src_img)
        
        # Analyze logo structure
        print("Analyzing logo structure...", file=sys.stderr)
        analysis = analyze_logo_structure(full_logo)
        
        # Smart icon extraction
        icon_only = None
        icon_mask = extract_icon_smart(full_logo, stock_code, analysis)
        
        if icon_mask is not None:
            icon_np = np.array(full_logo)
            icon_np[~icon_mask, 3] = 0
            icon_only = Image.fromarray(icon_np, mode="RGBA")
            icon_bbox = icon_only.getbbox()
            if icon_bbox:
                icon_only = icon_only.crop(icon_bbox)
            print(f"Icon extracted: {icon_only.size}", file=sys.stderr)
        else:
            print("Using full logo (no separate icon extracted)", file=sys.stderr)
        
        # Save variants
        output_files = save_logo_variants(full_logo, icon_only, output_dir, stock_code)

        return {
            "success": True,
            "stock_code": stock_code,
            "output_files": output_files,
            "has_icon": icon_only is not None,
            "analysis": {
                "has_text": analysis.get('has_text', False),
                "integrated_text_logo": analysis.get('integrated_text_logo', False),
                "has_separate_tagline": analysis.get('has_separate_tagline', False),
            }
        }
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Process company logo with smart icon extraction")
    parser.add_argument("--input", required=True, help="Path to input logo image")
    parser.add_argument("--output-dir", required=True, help="Directory to save processed images")
    parser.add_argument("--stock-code", required=True, help="Stock code for the company")

    args = parser.parse_args()
    result = process_logo(args.input, args.output_dir, args.stock_code)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
