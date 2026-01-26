#!/usr/bin/env python3
"""
SVG to PNG renderer using CairoSVG.

Usage:
    python svg_renderer.py <input_svg> <output_png> [width]

Args:
    input_svg: Path to input SVG file or URL
    output_png: Path to output PNG file
    width: Optional output width in pixels (default: 256)

Output:
    JSON with rendering result to stdout
"""

import sys
import json
import os

try:
    import cairosvg
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "cairosvg not installed. Run: pip install cairosvg"
    }))
    sys.exit(1)


def render_svg(svg_input: str, output_path: str, width: int = 256) -> dict:
    """
    Render an SVG to PNG at the specified width.
    
    Args:
        svg_input: Path to SVG file or SVG string
        output_path: Path to save the PNG
        width: Output width in pixels
        
    Returns:
        dict with success status and metadata
    """
    try:
        # Check if input is a file path or SVG string
        if os.path.exists(svg_input):
            # Render from file
            cairosvg.svg2png(
                url=svg_input,
                write_to=output_path,
                output_width=width
            )
        elif svg_input.strip().startswith('<'):
            # Render from SVG string
            cairosvg.svg2png(
                bytestring=svg_input.encode('utf-8'),
                write_to=output_path,
                output_width=width
            )
        elif svg_input.startswith('http://') or svg_input.startswith('https://'):
            # Render from URL
            cairosvg.svg2png(
                url=svg_input,
                write_to=output_path,
                output_width=width
            )
        else:
            return {
                "success": False,
                "error": f"Invalid SVG input: not a file, URL, or SVG string"
            }
        
        # Get output file size
        file_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0
        
        return {
            "success": True,
            "output_path": output_path,
            "width": width,
            "file_size": file_size
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }


def render_svg_to_bytes(svg_input: str, width: int = 256) -> bytes:
    """
    Render an SVG to PNG bytes without writing to disk.
    
    Args:
        svg_input: Path to SVG file, URL, or SVG string
        width: Output width in pixels
        
    Returns:
        PNG bytes
    """
    if os.path.exists(svg_input):
        return cairosvg.svg2png(url=svg_input, output_width=width)
    elif svg_input.strip().startswith('<'):
        return cairosvg.svg2png(bytestring=svg_input.encode('utf-8'), output_width=width)
    elif svg_input.startswith('http://') or svg_input.startswith('https://'):
        return cairosvg.svg2png(url=svg_input, output_width=width)
    else:
        raise ValueError(f"Invalid SVG input: {svg_input[:50]}...")


def get_svg_dimensions(svg_input: str) -> dict:
    """
    Get the natural dimensions of an SVG.
    
    Returns:
        dict with width, height, viewBox
    """
    try:
        import xml.etree.ElementTree as ET
        
        if os.path.exists(svg_input):
            tree = ET.parse(svg_input)
            root = tree.getroot()
        elif svg_input.strip().startswith('<'):
            root = ET.fromstring(svg_input)
        else:
            return {"error": "Cannot parse SVG dimensions from URL"}
        
        # Get width/height attributes
        width = root.get('width', '')
        height = root.get('height', '')
        viewbox = root.get('viewBox', '')
        
        # Parse viewBox for dimensions
        vb_width, vb_height = None, None
        if viewbox:
            parts = viewbox.split()
            if len(parts) == 4:
                vb_width = float(parts[2])
                vb_height = float(parts[3])
        
        return {
            "width": width,
            "height": height,
            "viewBox": viewbox,
            "viewBox_width": vb_width,
            "viewBox_height": vb_height
        }
        
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({
            "success": False,
            "error": "Usage: svg_renderer.py <input_svg> <output_png> [width]"
        }))
        sys.exit(1)
    
    svg_input = sys.argv[1]
    output_path = sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 256
    
    result = render_svg(svg_input, output_path, width)
    print(json.dumps(result))
    
    sys.exit(0 if result.get("success") else 1)

