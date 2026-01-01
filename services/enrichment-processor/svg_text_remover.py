#!/usr/bin/env python3
"""
SVG Text Remover - Removes text elements from SVG logos to extract icon-only versions.

This script parses SVG files and removes text-related elements (<text>, <tspan>, 
text-containing <g> groups) while preserving graphical elements like paths, shapes, etc.

Usage:
    python svg_text_remover.py --input logo.svg --output-dir ./output --stock-code DMP

Output:
    - {stock_code}_icon.svg - SVG with text removed
    - {stock_code}_icon.png - PNG render of icon SVG
    - JSON result to stdout
"""

import sys
import os
import argparse
import json
import re
from typing import Optional, Tuple, List
import xml.etree.ElementTree as ET

# SVG namespace
SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
NAMESPACES = {
    'svg': SVG_NS,
    'xlink': XLINK_NS,
}

# Text-related tag names (with and without namespace)
TEXT_TAGS = {'text', 'tspan', 'textPath', 'altGlyph', 'altGlyphDef', 'altGlyphItem', 'glyphRef'}


def strip_namespace(tag: str) -> str:
    """Remove namespace prefix from tag name."""
    if '}' in tag:
        return tag.split('}')[1]
    return tag


def is_text_element(elem) -> bool:
    """Check if element is a text-related element."""
    tag = strip_namespace(elem.tag)
    return tag.lower() in TEXT_TAGS


def element_contains_only_text(elem) -> bool:
    """
    Check if a group element contains only text elements (no shapes/paths).
    Used to identify text-only <g> groups that should be removed entirely.
    """
    tag = strip_namespace(elem.tag)
    if tag.lower() != 'g':
        return False
    
    has_text = False
    has_graphics = False
    
    for child in elem.iter():
        if child == elem:
            continue
        child_tag = strip_namespace(child.tag).lower()
        
        if child_tag in TEXT_TAGS:
            has_text = True
        elif child_tag in {'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 
                          'polygon', 'image', 'use', 'symbol'}:
            has_graphics = True
            
    return has_text and not has_graphics


def has_text_elements(svg_content: str) -> bool:
    """
    Check if SVG contains any text elements.
    
    Args:
        svg_content: SVG file content as string
        
    Returns:
        True if SVG contains text elements
    """
    try:
        # Quick regex check first for performance
        if not re.search(r'<text[>\s]|<tspan[>\s]', svg_content, re.IGNORECASE):
            return False
        
        # Parse to confirm
        root = ET.fromstring(svg_content)
        for elem in root.iter():
            if is_text_element(elem):
                return True
        return False
    except Exception as e:
        print(f"Error checking for text elements: {e}", file=sys.stderr)
        return False


def remove_text_elements(svg_content: str) -> Tuple[str, bool, int]:
    """
    Remove text elements from SVG content.
    
    Args:
        svg_content: SVG file content as string
        
    Returns:
        Tuple of (modified_svg_content, success, num_removed)
    """
    try:
        # Register namespaces to preserve them in output
        ET.register_namespace('', SVG_NS)
        ET.register_namespace('xlink', XLINK_NS)
        
        root = ET.fromstring(svg_content)
        elements_to_remove = []
        num_removed = 0
        
        # First pass: identify text elements and text-only groups
        for elem in root.iter():
            if is_text_element(elem):
                elements_to_remove.append(elem)
            elif element_contains_only_text(elem):
                elements_to_remove.append(elem)
        
        if not elements_to_remove:
            return svg_content, True, 0
        
        # Second pass: remove identified elements
        # We need to find parents and remove children
        def remove_element(root, target):
            """Remove an element from the tree."""
            for parent in root.iter():
                for child in list(parent):
                    if child == target:
                        parent.remove(child)
                        return True
                    # Recursively check nested elements
                    if remove_element_from_parent(parent, child, target):
                        return True
            return False
        
        def remove_element_from_parent(grandparent, parent, target):
            """Helper to remove nested elements."""
            for child in list(parent):
                if child == target:
                    parent.remove(child)
                    return True
                if remove_element_from_parent(parent, child, target):
                    return True
            return False
        
        for elem in elements_to_remove:
            # Find parent and remove
            for parent in root.iter():
                if elem in list(parent):
                    parent.remove(elem)
                    num_removed += 1
                    break
        
        # Convert back to string
        result = ET.tostring(root, encoding='unicode')
        
        # Add XML declaration if original had it
        if svg_content.strip().startswith('<?xml'):
            result = '<?xml version="1.0" encoding="UTF-8"?>\n' + result
        
        return result, True, num_removed
        
    except Exception as e:
        print(f"Error removing text elements: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return svg_content, False, 0


def get_svg_viewbox(svg_content: str) -> Optional[Tuple[float, float, float, float]]:
    """
    Extract viewBox from SVG.
    
    Returns:
        Tuple of (min_x, min_y, width, height) or None
    """
    try:
        root = ET.fromstring(svg_content)
        viewbox = root.get('viewBox')
        if viewbox:
            parts = viewbox.split()
            if len(parts) == 4:
                return tuple(float(p) for p in parts)
        
        # Try width/height attributes
        width = root.get('width', '').replace('px', '').replace('pt', '')
        height = root.get('height', '').replace('px', '').replace('pt', '')
        if width and height:
            try:
                return (0, 0, float(width), float(height))
            except ValueError:
                pass
        
        return None
    except Exception:
        return None


def render_svg_to_png(svg_path: str, output_path: str, width: int = 256) -> bool:
    """
    Render SVG to PNG using cairosvg.
    
    Args:
        svg_path: Path to input SVG
        output_path: Path for output PNG
        width: Output width in pixels
        
    Returns:
        True if successful
    """
    try:
        import cairosvg
        cairosvg.svg2png(url=svg_path, write_to=output_path, output_width=width)
        return True
    except Exception as e:
        print(f"Error rendering SVG to PNG: {e}", file=sys.stderr)
        return False


def process_svg_logo(input_path: str, output_dir: str, stock_code: str) -> dict:
    """
    Process an SVG logo: remove text and generate icon versions.
    
    Args:
        input_path: Path to input SVG file
        output_dir: Directory to save output files
        stock_code: Stock code for naming files
        
    Returns:
        dict with processing result
    """
    result = {
        "success": False,
        "stock_code": stock_code,
        "has_text": False,
        "text_removed": False,
        "num_text_elements": 0,
        "output_files": [],
        "icon_svg_path": None,
        "icon_png_path": None,
        "error": None
    }
    
    try:
        # Read input SVG
        with open(input_path, 'r', encoding='utf-8') as f:
            svg_content = f.read()
        
        os.makedirs(output_dir, exist_ok=True)
        
        # Check for text elements
        result["has_text"] = has_text_elements(svg_content)
        
        if result["has_text"]:
            # Remove text elements
            clean_svg, success, num_removed = remove_text_elements(svg_content)
            result["text_removed"] = success and num_removed > 0
            result["num_text_elements"] = num_removed
            
            if result["text_removed"]:
                # Save icon SVG
                icon_svg_path = os.path.join(output_dir, f"{stock_code}_icon.svg")
                with open(icon_svg_path, 'w', encoding='utf-8') as f:
                    f.write(clean_svg)
                result["icon_svg_path"] = icon_svg_path
                result["output_files"].append(icon_svg_path)
                print(f"Removed {num_removed} text elements, saved icon SVG", file=sys.stderr)
                
                # Render icon PNG
                icon_png_path = os.path.join(output_dir, f"{stock_code}_icon.png")
                if render_svg_to_png(icon_svg_path, icon_png_path, width=256):
                    result["icon_png_path"] = icon_png_path
                    result["output_files"].append(icon_png_path)
                    print(f"Rendered icon PNG: {icon_png_path}", file=sys.stderr)
                    
                    # Also render larger version for quality
                    icon_png_512 = os.path.join(output_dir, f"{stock_code}_icon_512.png")
                    if render_svg_to_png(icon_svg_path, icon_png_512, width=512):
                        result["output_files"].append(icon_png_512)
            else:
                print("No text elements removed (might be complex structure)", file=sys.stderr)
        else:
            # No <text> elements found - but text might be rendered as paths!
            # This is common in professional logos where text is "converted to outlines".
            # Signal to caller that raster fallback is needed for text detection.
            print("SVG has no <text> elements (text may be paths), signaling raster fallback needed", file=sys.stderr)
            result["text_removed"] = False  # Signal that raster processing is needed
            # Don't generate output files - let raster fallback handle it
        
        # Also save the original/full SVG
        full_svg_path = os.path.join(output_dir, f"{stock_code}.svg")
        with open(full_svg_path, 'w', encoding='utf-8') as f:
            f.write(svg_content)
        result["output_files"].append(full_svg_path)
        
        # Render full PNG
        full_png_path = os.path.join(output_dir, f"{stock_code}.png")
        if render_svg_to_png(full_svg_path, full_png_path, width=256):
            result["output_files"].append(full_png_path)
        
        result["success"] = len(result["output_files"]) > 0
        
    except Exception as e:
        result["error"] = str(e)
        import traceback
        traceback.print_exc(file=sys.stderr)
    
    return result


def main():
    parser = argparse.ArgumentParser(description="Remove text from SVG logos")
    parser.add_argument("--input", required=True, help="Path to input SVG file")
    parser.add_argument("--output-dir", required=True, help="Directory to save output files")
    parser.add_argument("--stock-code", required=True, help="Stock code for naming")
    parser.add_argument("--check-only", action="store_true", help="Only check for text, don't process")
    
    args = parser.parse_args()
    
    if args.check_only:
        with open(args.input, 'r', encoding='utf-8') as f:
            svg_content = f.read()
        has_text = has_text_elements(svg_content)
        print(json.dumps({"has_text": has_text}))
        return
    
    result = process_svg_logo(args.input, args.output_dir, args.stock_code)
    print(json.dumps(result))


if __name__ == "__main__":
    main()

