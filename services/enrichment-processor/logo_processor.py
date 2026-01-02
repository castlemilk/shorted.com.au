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

# Initialize models globally for reuse
_reader = None
_sam_model = None
_sr_model = None

# Configuration constants
MIN_ICON_SIZE = 128
TARGET_UPSCALE_SIZE = 256
NOISE_THRESHOLD_RATIO = 0.005
ICON_ASPECT_RATIO_THRESHOLD = 1.5
LOGO_VARIANTS_SIZES = [64, 128, 256, 512]


def get_sr_model():
    """Get or initialize the super-resolution model (EDSR 4x)."""
    global _sr_model
    if _sr_model is None:
        try:
            sr = cv2.dnn_superres.DnnSuperResImpl_create()
            # Look for model in multiple locations
            model_paths = [
                "models/EDSR_x4.pb",
                "services/enrichment-processor/models/EDSR_x4.pb",
                os.path.join(os.path.dirname(__file__), "models", "EDSR_x4.pb"),
            ]
            model_path = None
            for path in model_paths:
                if os.path.exists(path):
                    model_path = path
                    break

            if model_path is None:
                print(
                    "Warning: EDSR model not found, upscaling disabled",
                    file=sys.stderr,
                )
                _sr_model = False
                return None

            sr.readModel(model_path)
            sr.setModel("edsr", 4)
            _sr_model = sr
            print(f"Loaded EDSR 4x model from {model_path}", file=sys.stderr)
        except Exception as e:
            print(f"Warning: Failed to load SR model: {e}", file=sys.stderr)
            _sr_model = False
            return None
    if _sr_model is False:
        return None
    return _sr_model


def upscale_image(img, target_size=TARGET_UPSCALE_SIZE):
    """
    Upscale a small RGBA image using EDSR super-resolution.
    Returns the upscaled image, or original if upscaling not needed/available.
    """
    w, h = img.size
    max_dim = max(w, h)

    # Don't upscale if already large enough
    if max_dim >= target_size:
        return img

    sr = get_sr_model()
    if sr is None:
        # Fallback to LANCZOS if SR not available
        scale = target_size / max_dim
        new_w, new_h = int(w * scale), int(h * scale)
        return img.resize((new_w, new_h), Image.Resampling.LANCZOS)

    # Calculate how many 4x passes we need
    current_size = max_dim
    img_to_upscale = img

    while current_size < target_size:
        # Convert to numpy for OpenCV
        img_rgba = np.array(img_to_upscale)
        img_rgb = img_rgba[:, :, :3]
        img_alpha = img_rgba[:, :, 3]

        # PRE-PROCESS: Fill transparent areas with edge color to prevent artifacts
        # This stops EDSR from blending garbage pixels into visible edges
        alpha_mask = img_alpha > 128
        if not alpha_mask.all():
            # Dilate the visible area to get edge colors
            kernel = np.ones((3, 3), np.uint8)
            dilated = cv2.dilate(alpha_mask.astype(np.uint8), kernel, iterations=2)
            # Fill transparent areas with nearest visible color using inpainting
            inpaint_mask = ((~alpha_mask) & (dilated > 0)).astype(np.uint8) * 255
            if inpaint_mask.any():
                img_rgb = cv2.inpaint(img_rgb, inpaint_mask, 3, cv2.INPAINT_TELEA)

        img_bgr = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR)

        # Upscale RGB with EDSR
        upscaled_bgr = sr.upsample(img_bgr)
        upscaled_rgb = cv2.cvtColor(upscaled_bgr, cv2.COLOR_BGR2RGB)

        # Upscale alpha with NEAREST to keep edges crisp (not LANCZOS which blurs)
        upscaled_alpha = cv2.resize(
            img_alpha,
            (upscaled_rgb.shape[1], upscaled_rgb.shape[0]),
            interpolation=cv2.INTER_NEAREST,
        )

        # POST-PROCESS: Aggressive edge cleanup
        # 1. Threshold alpha to binary
        upscaled_alpha = np.where(upscaled_alpha > 128, 255, 0).astype(np.uint8)

        # 2. Erode slightly to cut off any edge artifacts (1px)
        erode_kernel = np.ones((3, 3), np.uint8)
        upscaled_alpha = cv2.erode(upscaled_alpha, erode_kernel, iterations=1)

        # 3. Clean up with morphological close to fill small holes
        upscaled_alpha = cv2.morphologyEx(upscaled_alpha, cv2.MORPH_CLOSE, erode_kernel)

        # 4. Color quantization - snap to original palette for crisp color edges
        orig_mask = img_alpha > 128
        orig_colors = img_rgb[orig_mask].reshape(-1, 3)
        if len(orig_colors) > 0:
            unique_colors = np.unique(orig_colors, axis=0)
            if len(unique_colors) <= 64:  # Only for limited palette logos
                upscaled_flat = upscaled_rgb.reshape(-1, 3).astype(np.float32)
                unique_float = unique_colors.astype(np.float32)
                # Find nearest palette color for each pixel
                distances = np.zeros((len(upscaled_flat), len(unique_colors)))
                for i, color in enumerate(unique_float):
                    distances[:, i] = np.sum((upscaled_flat - color) ** 2, axis=1)
                nearest_idx = np.argmin(distances, axis=1)
                upscaled_rgb = unique_colors[nearest_idx].reshape(upscaled_rgb.shape)

        # Combine
        upscaled_rgba = np.dstack([upscaled_rgb, upscaled_alpha])
        img_to_upscale = Image.fromarray(upscaled_rgba, mode="RGBA")

        current_size = max(img_to_upscale.size)
        print(
            f"Upscaled to {img_to_upscale.size} (target: {target_size})",
            file=sys.stderr,
        )

    return img_to_upscale


def has_transparency(img):
    """
    Check if image already has meaningful transparency.
    Returns True if >5% of pixels have alpha < 255.
    """
    if img.mode != "RGBA":
        return False
    alpha = np.array(img)[:, :, 3]
    # Consider transparent if >5% of pixels have alpha < 255
    transparent_ratio = (alpha < 255).sum() / alpha.size
    return transparent_ratio > 0.05


def get_reader():
    global _reader
    if _reader is None:
        import easyocr

        _reader = easyocr.Reader(["en"])
    return _reader


def get_sam_model():
    global _sam_model
    if _sam_model is None:
        try:
            from mobile_sam import sam_model_registry, SamPredictor

            model_type = "vit_t"
            sam_checkpoint = os.environ.get("MOBILE_SAM_CHECKPOINT", "mobile_sam.pt")
            if not os.path.exists(sam_checkpoint):
                # Fallback for local dev if not in container
                sam_checkpoint = "services/enrichment-processor/mobile_sam.pt"

            if not os.path.exists(sam_checkpoint):
                raise FileNotFoundError(
                    f"MobileSAM checkpoint not found at {sam_checkpoint}"
                )

            device = "cuda" if torch.cuda.is_available() else "cpu"
            mobile_sam = sam_model_registry[model_type](checkpoint=sam_checkpoint)
            mobile_sam.to(device=device)
            mobile_sam.eval()
            _sam_model = SamPredictor(mobile_sam)
        except ImportError as e:
            print(
                f"Warning: SAM not available (mobile_sam not installed): {e}",
                file=sys.stderr,
            )
            _sam_model = False  # Mark as unavailable
            return None
        except Exception as e:
            print(f"Warning: Failed to initialize SAM model: {e}", file=sys.stderr)
            _sam_model = False  # Mark as unavailable
            return None
    if _sam_model is False:
        return None
    return _sam_model


def extract_icon(img, stock_code):
    """
    Extract the graphical icon from a logo, removing text.
    Uses EasyOCR for text detection and directly masks out text regions.
    Falls back to aspect ratio heuristics when text detection fails.
    Returns a binary mask of the icon region.
    """
    try:
        # Convert PIL to OpenCV format
        open_cv_image = np.array(img)
        image_bgr = cv2.cvtColor(open_cv_image, cv2.COLOR_RGBA2BGR)
        h, w = image_bgr.shape[:2]

        # Get alpha mask
        alpha = np.array(img.split()[-1])
        content_mask = (alpha > 0).astype(np.uint8) * 255

        # 1. Try to detect text regions using EasyOCR
        reader = get_reader()
        results = reader.readtext(image_bgr)
        print(f"EasyOCR detected {len(results)} text regions", file=sys.stderr)

        # 2. If text was detected, create a mask that excludes text
        if len(results) > 0:
            text_mask = np.zeros((h, w), dtype=np.uint8)
            for bbox, text, prob in results:
                pts = np.array(bbox, np.int32)
                cv2.fillPoly(text_mask, [pts], 255)
                print(f"  Text: '{text}' (conf: {prob:.2f})", file=sys.stderr)

            # Dilate text mask to ensure we remove all text pixels
            kernel = np.ones((7, 7), np.uint8)
            dilated_text_mask = cv2.dilate(text_mask, kernel, iterations=3)

            # Create non-text content mask
            non_text_content = cv2.bitwise_and(
                content_mask, cv2.bitwise_not(dilated_text_mask)
            )

            # Find connected components in non-text area
            nt_num, nt_labels, nt_stats, nt_centroids = (
                cv2.connectedComponentsWithStats(non_text_content)
            )

            if nt_num > 1:
                # Find the largest non-text component (the icon)
                largest = 1 + np.argmax(nt_stats[1:, cv2.CC_STAT_AREA])
                largest_area = nt_stats[largest, cv2.CC_STAT_AREA]
                total_non_text_area = non_text_content.sum() // 255

                print(f"Non-text components: {nt_num-1}", file=sys.stderr)
                print(
                    f"Largest non-text component area: {largest_area}", file=sys.stderr
                )

                # If the largest component is a significant portion of non-text content,
                # use it directly as the icon mask
                if largest_area > total_non_text_area * 0.3:  # At least 30% of non-text
                    icon_mask = nt_labels == largest
                    print(f"Using largest non-text component as icon", file=sys.stderr)
                    return icon_mask

                # Otherwise, use all non-text content
                print(f"Using all non-text content as icon", file=sys.stderr)
                return non_text_content > 0

        # 3. Fallback: No text detected, use aspect ratio heuristics
        print(
            "No text detected, using aspect ratio heuristics to find icon",
            file=sys.stderr,
        )

        # Find connected components in the content
        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
            content_mask
        )

        if num_labels <= 1:
            print("No components found", file=sys.stderr)
            return None

        icon_mask = np.zeros((h, w), dtype=bool)
        for label in range(1, num_labels):
            comp_w = stats[label, cv2.CC_STAT_WIDTH]
            comp_h = stats[label, cv2.CC_STAT_HEIGHT]
            area = stats[label, cv2.CC_STAT_AREA]

            if area < (h * w * NOISE_THRESHOLD_RATIO):  # Skip tiny noise
                continue

            aspect_ratio = comp_w / max(comp_h, 1)

            # Icon heuristic: aspect ratio < 1.5 (compact/square)
            # Text heuristic: aspect ratio > 1.5 (wide and stretched)
            print(
                f"  Component {label}: {comp_w}x{comp_h}, aspect={aspect_ratio:.1f}, area={area}",
                file=sys.stderr,
            )

            if aspect_ratio < ICON_ASPECT_RATIO_THRESHOLD:
                # This looks like an icon, include it
                icon_mask |= labels == label
                print(f"    -> Included as icon", file=sys.stderr)
            else:
                print(f"    -> Excluded (too wide, likely text)", file=sys.stderr)

        if icon_mask.sum() > 0:
            return icon_mask

        # Last resort: return largest component
        print("No icon-like components found, using largest", file=sys.stderr)
        largest_label = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
        return labels == largest_label

    except Exception as e:
        print(f"Error in extract_icon: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc(file=sys.stderr)
        return None


def load_source_image(input_path):
    """Read input image and force RGBA, handling SVG rendering if needed."""
    if input_path.endswith(".svg"):
        import cairosvg

        png_data = cairosvg.svg2png(url=input_path)
        return Image.open(io.BytesIO(png_data)).convert("RGBA")
    return Image.open(input_path).convert("RGBA")


def apply_background_removal(src_img):
    """Remove solid background using rembg if image doesn't have transparency."""
    if has_transparency(src_img):
        print("Source image already has transparency, skipping rembg", file=sys.stderr)
        full_logo = src_img.copy()
    else:
        print("Source image has no transparency, running rembg", file=sys.stderr)
        mask_img = remove(src_img, only_mask=True)
        mask_np = np.array(mask_img) > 128
        src_np = np.array(src_img)
        full_np = src_np.copy()
        full_np[~mask_np, 3] = 0
        full_logo = Image.fromarray(full_np, mode="RGBA")

    bbox = full_logo.getbbox()
    return full_logo.crop(bbox) if bbox else full_logo


def perform_icon_extraction(full_logo, stock_code):
    """Extract icon component from the full logo and upscale if needed."""
    icon_mask = extract_icon(full_logo, stock_code)
    if icon_mask is None:
        return None

    icon_np = np.array(full_logo)
    icon_np[~icon_mask, 3] = 0
    icon_only = Image.fromarray(icon_np, mode="RGBA")

    icon_bbox = icon_only.getbbox()
    if icon_bbox:
        icon_only = icon_only.crop(icon_bbox)

    if max(icon_only.size) < MIN_ICON_SIZE:
        print(f"Icon is small ({icon_only.size}), upscaling...", file=sys.stderr)
        icon_only = upscale_image(icon_only, target_size=TARGET_UPSCALE_SIZE)

    return icon_only


def save_logo_variants(full_logo, icon_only, output_dir, stock_code):
    """Generate and save various logo sizes and variants."""
    os.makedirs(output_dir, exist_ok=True)
    output_files = []

    # Save primary variants
    full_logo_path = os.path.join(output_dir, f"{stock_code}.png")
    full_logo.save(full_logo_path, "PNG")
    output_files.append(full_logo_path)

    if icon_only:
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

            name = (
                f"{stock_code}_{prefix}{size}.png"
                if prefix
                else f"{stock_code}_{size}.png"
            )
            size_path = os.path.join(output_dir, name)
            canvas.save(size_path, "PNG")
            output_files.append(size_path)

    return output_files


def process_logo(input_path, output_dir, stock_code):
    """Main logo processing pipeline entry point."""
    try:
        src_img = load_source_image(input_path)
        full_logo = apply_background_removal(src_img)
        icon_only = perform_icon_extraction(full_logo, stock_code)
        output_files = save_logo_variants(full_logo, icon_only, output_dir, stock_code)

        return {
            "success": True,
            "stock_code": stock_code,
            "output_files": output_files,
            "has_icon": icon_only is not None,
        }
    except Exception as e:
        import traceback

        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Process company logo with SAM")
    parser.add_argument("--input", required=True, help="Path to input logo image")
    parser.add_argument(
        "--output-dir", required=True, help="Directory to save processed images"
    )
    parser.add_argument(
        "--stock-code", required=True, help="Stock code for the company"
    )

    args = parser.parse_args()
    result = process_logo(args.input, args.output_dir, args.stock_code)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
