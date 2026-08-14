#!/usr/bin/env python3
"""On-device OCR backends for scanned register pages.

WHY APPLE VISION AND NOT TESSERACT
----------------------------------
Both are free, on-device and unquota'd, but they fail differently on this corpus,
and only one failure is survivable. Measured on Gosling_48P page 2 (a 0-chars/page
scan) where items 1-3 live:

    Tesseract      '4,'  <- item "1." : digit read as 4, period as comma
                   '2.'  <- number kept, label text lost to another line
    Apple Vision   '1. List shereholdings in public and private companies (...'  conf 1.00
                   '2. List family and business trusts and nominee companies:'  conf 1.00

A misread item NUMBER files shareholdings under directorships — a wrong fact about
a named person. Tesseract produced exactly that; Vision reads the number correctly
and keeps the label on the same line, which is also what
`ITEM_HEADING_RE` + canonical-label validation needs. ("shereholdings" for
"shareholdings" is fine: the parser fuzzy-matches HEADINGS, never values.)

Vision also returns a per-observation confidence and bounding box, which is what
the geometry parser consumes, and it is roughly cell-granular on this form — each
table cell arrives as its own observation rather than one flattened line.

Requires macOS (Vision.framework) plus pyobjc-framework-{Vision,Quartz}. This is
therefore an OPERATOR-MACHINE backend, like the agy tier: the Linux
report-extractor container cannot run it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

log = logging.getLogger("register_ocr")

# Vision's own enum. 0 = accurate (slower, and the only level worth using on a
# photocopied statutory form), 1 = fast.
_LEVEL_ACCURATE = 0

# Below this, an observation is dropped rather than guessed at. Vision reports
# 1.00 for the form's typed values and its item headings; low-confidence output on
# this corpus is watermark bleed and photocopy speckle.
MIN_OCR_CONFIDENCE = 0.35


class OCRUnavailable(RuntimeError):
    """Vision.framework or its Python bridge is missing."""


@dataclass
class OCRWord:
    """Positioned text, shaped like pymupdf's `get_text("words")` tuples."""

    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    confidence: float = 1.0

    def as_tuple(self) -> tuple[float, float, float, float, str]:
        return (self.x0, self.y0, self.x1, self.y1, self.text)


def _require_vision():
    try:
        import Quartz  # noqa: F401
        import Vision  # noqa: F401
        from Foundation import NSURL  # noqa: F401
    except ImportError as exc:  # pragma: no cover - platform dependent
        raise OCRUnavailable(
            "Apple Vision OCR needs macOS plus "
            "`pip install pyobjc-framework-Vision pyobjc-framework-Quartz`. "
            "This backend cannot run in the Linux report-extractor container."
        ) from exc


def vision_lines(png_path: str) -> list[tuple[str, float, float, float, float, float]]:
    """OCR one PNG. Returns (text, confidence, x, y, w, h) in NORMALISED coords.

    Vision's bounding boxes are 0..1 with the origin at the BOTTOM-left, which is
    the opposite vertical convention to PDF text extraction. The flip happens in
    vision_words(), once, rather than at each call site.
    """
    _require_vision()
    import Quartz
    import Vision
    from Foundation import NSURL

    url = NSURL.fileURLWithPath_(png_path)
    source = Quartz.CGImageSourceCreateWithURL(url, None)
    if source is None:
        raise OCRUnavailable(f"could not read image: {png_path}")
    image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)
    if image is None:
        raise OCRUnavailable(f"could not decode image: {png_path}")

    collected: list[tuple[str, float, float, float, float, float]] = []

    def handler(request, error):
        for obs in request.results() or []:
            candidates = obs.topCandidates_(1)
            if not candidates:
                continue
            best = candidates[0]
            box = obs.boundingBox()
            collected.append(
                (
                    best.string(),
                    float(best.confidence()),
                    float(box.origin.x),
                    float(box.origin.y),
                    float(box.size.width),
                    float(box.size.height),
                )
            )

    request = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(handler)
    request.setRecognitionLevel_(_LEVEL_ACCURATE)
    request.setUsesLanguageCorrection_(True)
    vision_handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        image, None
    )
    vision_handler.performRequests_error_([request], None)
    return collected


def vision_words(
    png_path: str,
    page_width: float,
    page_height: float,
    min_confidence: float = MIN_OCR_CONFIDENCE,
) -> list[OCRWord]:
    """OCR a page image into page-space words the geometry parser can consume.

    Each Vision observation is a run of text with one box. It is split into words
    and their x-extents apportioned by character offset within that box. The
    approximation is safe for this parser because it needs (a) a stable y per
    visual line, which is exact, and (b) the x0 of the FIRST word of each column,
    which is exact for the leftmost word of every observation — and on this form
    Vision returns roughly one observation per table cell.
    """
    words: list[OCRWord] = []
    for text, confidence, nx, ny, nw, nh in vision_lines(png_path):
        if confidence < min_confidence:
            continue
        stripped = text.strip()
        if not stripped:
            continue

        # Normalised -> page points, flipping the vertical origin.
        x0 = nx * page_width
        x1 = (nx + nw) * page_width
        y1 = (1.0 - ny) * page_height
        y0 = (1.0 - (ny + nh)) * page_height

        span = max(x1 - x0, 1e-6)
        per_char = span / max(len(stripped), 1)
        cursor = 0
        for token in stripped.split():
            start = stripped.index(token, cursor)
            cursor = start + len(token)
            words.append(
                OCRWord(
                    x0=x0 + start * per_char,
                    y0=y0,
                    x1=x0 + cursor * per_char,
                    y1=y1,
                    text=token,
                    confidence=confidence,
                )
            )
    return words


def page_ocr_words(page, dpi: int = 200, backend: str = "vision") -> list[OCRWord]:
    """Rasterise one pymupdf page and OCR it into page-space words."""
    import os
    import tempfile

    if backend != "vision":
        raise OCRUnavailable(f"unknown OCR backend {backend!r}")

    pix = page.get_pixmap(dpi=dpi)
    fd, path = tempfile.mkstemp(suffix=".png", prefix="register-ocr-")
    os.close(fd)
    try:
        pix.save(path)
        return vision_words(path, page.rect.width, page.rect.height)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
