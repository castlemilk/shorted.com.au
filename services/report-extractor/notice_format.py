"""Recognise reform layouts that the legacy voting-only reader cannot publish.

This is a withholding guard, not a new-format parser. Dates, economic-interest
phrases and the acronym SHN alone are deliberately insufficient evidence.
The shared synthetic fixtures also exercise legacy notices quoting the reform.
"""
import re
import unicodedata

_TRANSITIONAL_TITLE = re.compile(
    r"^[ \t]*transitional[ \t\r\n]+form[ \t\r\n]+6[ \t]*0[ \t]*([345])[ \t]*(?:\r?$|\|)",
    re.IGNORECASE | re.MULTILINE,
)
_SHN_TITLE = re.compile(
    r"^[ \t]*substantial[ \t\r\n]+holding[ \t\r\n]+notice[ \t]*(?:\r?$|\|)",
    re.IGNORECASE | re.MULTILINE,
)
_REFORM_SECTION = re.compile(r"section\s*671\s*bb\b", re.IGNORECASE)


def unsupported_notice_format(text: str) -> str:
    """Return a recognised unsupported format, or empty for other/unclear text.

    A packet containing both a legacy notice and a structurally identified new
    notice is withheld: this reader cannot safely choose which one is current.
    Mere prose references do not match. Text-free scans and unrecognised
    custom/OCR layouts remain outside this guard's coverage.
    """
    head = "".join(
        "\n" if c == "\f" else " " if unicodedata.category(c) == "Zs" else "" if c in "\ufeff\u200b" else c
        for c in text[:12000]
    )
    for match in _TRANSITIONAL_TITLE.finditer(head):
        if _REFORM_SECTION.search(head[match.end():match.end() + 300]):
            return "transitional_60" + match.group(1)
    for match in _SHN_TITLE.finditer(head):
        body = " ".join(head[match.end():].replace("|", " ").split()).lower()
        # SHN item 3 + item 4, or items 4 + 6. A generic title in a
        # covering letter or a reform article is not enough.
        holding = "holding percentage" in body
        reason = "reason for notice" in body
        derivative = "previous and present derivative-based percentages" in body
        if _REFORM_SECTION.search(head[match.end():match.end() + 300]) and holding and (reason or derivative):
            return "shn"
    return ""
