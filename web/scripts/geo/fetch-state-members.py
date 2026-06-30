#!/usr/bin/env python3
"""Fetch current state lower-house members (district -> member + party) from the
Wikipedia 'Members of the X Legislative Assembly' tables, one mechanism for the
6 single-member states. Value-matches each row against the known SED districts +
party names so it is robust to per-state column ordering.

Output: web/public/geo/electorates/state-members.json
  { "NSW": { "Maitland": {"member","party","partyAb"}, ... }, ... }
TAS/ACT are Hare-Clark multi-member and intentionally excluded.
"""
import json, re, html, urllib.parse, urllib.request, sys, os

UA = {"User-Agent": "Mozilla/5.0 Chrome/120"}

# Current-term members-list pages (comma titles, en-dash).
PAGES = {
    "NSW": "Members of the New South Wales Legislative Assembly, 2023–2027",
    "VIC": "Members of the Victorian Legislative Assembly, 2022–2026",
    "QLD": "Members of the Queensland Legislative Assembly, 2024–2028",
    "WA":  "Members of the Western Australian Legislative Assembly, 2025–2029",
    "SA":  "Members of the South Australian House of Assembly, 2022–2026",
    "NT":  "Members of the Northern Territory Legislative Assembly, 2024–2028",
}

# Wikipedia party text -> (label matching the frontend palette, abbreviation).
PARTY = {
    "labor": ("Labor", "ALP"), "australian labor party": ("Labor", "ALP"),
    "liberal": ("Liberal", "LIB"), "liberal party": ("Liberal", "LIB"),
    "national": ("Nationals", "NAT"), "nationals": ("Nationals", "NAT"), "the nationals": ("Nationals", "NAT"),
    "liberal national": ("Liberal National", "LNP"), "liberal national party": ("Liberal National", "LNP"),
    "greens": ("Greens", "GRN"), "the greens": ("Greens", "GRN"), "australian greens": ("Greens", "GRN"),
    "independent": ("Independent", "IND"),
    "one nation": ("One Nation", "ON"), "pauline hanson's one nation": ("One Nation", "ON"),
    "katter's australian party": ("Katter's", "KAP"), "katter's australian": ("Katter's", "KAP"),
    "country liberal": ("Country Liberal", "CLP"), "country liberal party": ("Country Liberal", "CLP"),
    "animal justice": ("Other", "OTH"), "legalise cannabis": ("Other", "OTH"),
    # tables that use the abbreviation directly
    "alp": ("Labor", "ALP"), "lib": ("Liberal", "LIB"), "nat": ("Nationals", "NAT"),
    "lnp": ("Liberal National", "LNP"), "grn": ("Greens", "GRN"), "ind": ("Independent", "IND"),
    "clp": ("Country Liberal", "CLP"), "on": ("One Nation", "ON"), "kap": ("Katter's", "KAP"),
}


def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()


def clean_cell(c):
    c = re.sub(r"<ref[^>]*>.*?</ref>", "", c, flags=re.S)
    c = re.sub(r"<ref[^>]*/>", "", c)
    c = re.sub(r"<style[^>]*>.*?</style>", "", c, flags=re.S)
    c = re.sub(r"<sup[^>]*>.*?</sup>", "", c, flags=re.S)
    c = re.sub(r"<[^>]+>", "", c)
    return norm(html.unescape(c))


def fetch_html(title):
    url = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "parse", "page": title, "prop": "text", "format": "json", "formatversion": "2"})
    d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA)))
    if "error" in d:
        return None
    return d["parse"]["text"]


def parse_party(text):
    t = text.lower()
    for k, v in PARTY.items():
        if t == k:
            return v
    # substring fallback: ONLY full party names (len>4) so short abbreviations
    # (on/ind/nat) don't match member surnames ("Aitchison" → "on"); longest key
    # first so "Liberal National" doesn't match "Liberal".
    for k in sorted((k for k in PARTY if len(k) > 4), key=len, reverse=True):
        if k in t:
            return PARTY[k]
    return None


def is_year_range(t):
    return bool(re.match(r"^\d{4}(–|-|\s*–\s*present|\s*to\s*).*", t))


def main():
    geo_dir = sys.argv[1] if len(sys.argv) > 1 else "web/public/geo/electorates"
    sed = json.load(open(os.path.join(geo_dir, "suburb-sed.json")))
    districts_by_state = {}
    for v in sed.values():
        districts_by_state.setdefault(v["state"], set()).add(v["district"].lower())
    # map ABS state names -> our codes
    name2code = {"New South Wales": "NSW", "Victoria": "VIC", "Queensland": "QLD",
                 "South Australia": "SA", "Western Australia": "WA",
                 "Tasmania": "TAS", "Northern Territory": "NT",
                 "Australian Capital Territory": "ACT"}
    dist = {code: districts_by_state.get(name, set()) for name, code in name2code.items()}

    out = {}
    for code, title in PAGES.items():
        htmltext = fetch_html(title)
        if not htmltext:
            print(f"  {code}: PAGE NOT FOUND ({title})")
            continue
        known = dist.get(code, set())
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", htmltext, re.S)
        found = {}
        for tr in rows:
            cells = [clean_cell(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", tr, re.S)]
            cells = [c for c in cells if c]
            if len(cells) < 3:
                continue
            electorate = next((c for c in cells if c.lower() in known), None)
            if not electorate:
                continue
            party = next((parse_party(c) for c in cells if parse_party(c)), None)
            # member = a name-ish cell that isn't electorate/party-word/year
            member = None
            for c in cells:
                if c == electorate or is_year_range(c) or parse_party(c):
                    continue
                if re.search(r"[A-Za-z]\s+[A-Za-z]", c) and len(c) < 50:
                    member = c
                    break
            if member:
                found[electorate] = {"member": member,
                                     "party": party[0] if party else "Other",
                                     "partyAb": party[1] if party else "OTH"}
        out[code] = found
        print(f"  {code}: {len(found)} / {len(known)} districts")
    open(os.path.join(geo_dir, "state-members.json"), "w").write(json.dumps(out))
    total = sum(len(v) for v in out.values())
    print(f"total state members: {total}")


if __name__ == "__main__":
    main()
