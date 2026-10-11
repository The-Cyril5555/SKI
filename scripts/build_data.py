#!/usr/bin/env python3
"""Construit data/font-romeu.js : pistes, remontées et points d'intérêt de la
station Font-Romeu Pyrénées 2000, enrichis des altitudes du terrain.

Sources :
  - OpenStreetMap via l'API Overpass (pistes, remontées, sommets, restaurants…)
  - Modèle numérique de terrain « Terrarium » (Mapzen / AWS Open Data)

Usage :
    python3 scripts/build_data.py            # télécharge puis génère
    python3 scripts/build_data.py --cache .cache   # réutilise les téléchargements

Dépendances : Python 3.9+, Pillow et NumPy.
"""

import argparse
import datetime as dt
import io
import json
import math
import os
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(ROOT, "data", "font-romeu.js")

# Emprise du domaine skiable (sud, ouest, nord, est). Les Angles (au nord) et
# Cambre d'Aze (à l'est) restent en dehors.
STATION_BBOX = (42.495, 1.975, 42.552, 2.075)
# Emprise élargie pour les sommets visibles depuis la station (Carlit…)
PEAKS_BBOX = (42.46, 1.90, 42.60, 2.13)
RESORT_AREA_NAME = "Font-Romeu Pyrénées 2000"
MAIN_PLACES = ("Font-Romeu", "Pyrénées 2000", "Bolquère", "Super Bolquère")
MERGED_COMMUNES = ("Font-Romeu-Odeillo-Via", "Angoustrine-Villeneuve-des-Escaldes")

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
TERRARIUM_URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"
DEM_ZOOM = 14
SAMPLE_STEP_M = 10  # pas d'échantillonnage le long des tracés
PROFILE_POINTS = 60  # points max conservés pour les profils altimétriques

USER_AGENT = "font-romeu-ski-map/1.0 (+https://github.com/the-cyril5555/ski)"

LIFT_LABELS = {
    "cable_car": "Téléphérique",
    "gondola": "Télécabine",
    "mixed_lift": "Télémix",
    "chair_lift": "Télésiège",
    "drag_lift": "Téléski",
    "t-bar": "Téléski (perche à archet)",
    "j-bar": "Téléski",
    "platter": "Téléski (perche)",
    "rope_tow": "Fil neige",
    "magic_carpet": "Tapis roulant",
    "zip_line": "Tyrolienne",
}


# --------------------------------------------------------------------------
# Téléchargements


def http_get(url, data=None, timeout=180):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def overpass_query():
    s, w, n, e = STATION_BBOX
    ps, pw, pn, pe = PEAKS_BBOX
    bb = f"({s},{w},{n},{e})"
    pbb = f"({ps},{pw},{pn},{pe})"
    return f"""
[out:json][timeout:120];
(
  way["piste:type"]{bb};
  way["aerialway"]{bb};
  node["aerialway"="pylon"]{bb};
  way["landuse"="winter_sports"]{bb};
  node["natural"="peak"]["name"]{pbb};
  node["mountain_pass"="yes"]["name"]{bb};
  node["amenity"~"^(restaurant|cafe|bar|first_aid)$"]{bb};
  way["amenity"~"^(restaurant|cafe|bar)$"]{bb};
  node["tourism"="viewpoint"]["name"]{bb};
  node["tourism"="information"]["information"="office"]{bb};
  way["amenity"="parking"]{bb};
  node["place"~"^(town|village|hamlet|suburb|neighbourhood)$"]{pbb};
);
out body geom;
"""


def fetch_osm(cache_dir):
    cache = os.path.join(cache_dir, "osm.json") if cache_dir else None
    if cache and os.path.exists(cache):
        with open(cache, encoding="utf-8") as fh:
            return json.load(fh)
    query = overpass_query()
    last_error = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(2):
            try:
                url = endpoint + "?" + urllib.parse.urlencode({"data": query})
                print(f"Overpass : {endpoint} (essai {attempt + 1})", file=sys.stderr)
                payload = json.loads(http_get(url))
                if cache:
                    with open(cache, "w", encoding="utf-8") as fh:
                        json.dump(payload, fh)
                return payload
            except Exception as exc:  # serveur saturé, réseau…
                last_error = exc
                print(f"  échec : {exc}", file=sys.stderr)
                time.sleep(3 * (attempt + 1))
    raise SystemExit(f"Impossible d'interroger Overpass : {last_error}")


class Terrain:
    """Échantillonne l'altitude (m) dans les tuiles Terrarium, en bilinéaire."""

    def __init__(self, cache_dir, zoom=DEM_ZOOM):
        self.zoom = zoom
        self.cache_dir = os.path.join(cache_dir, "terrarium") if cache_dir else None
        self.tiles = {}

    def _tile(self, x, y):
        key = (x, y)
        if key not in self.tiles:
            raw = None
            path = None
            if self.cache_dir:
                path = os.path.join(self.cache_dir, f"{self.zoom}_{x}_{y}.png")
                if os.path.exists(path):
                    with open(path, "rb") as fh:
                        raw = fh.read()
            if raw is None:
                raw = http_get(TERRARIUM_URL.format(z=self.zoom, x=x, y=y), timeout=60)
                if path:
                    os.makedirs(self.cache_dir, exist_ok=True)
                    with open(path, "wb") as fh:
                        fh.write(raw)
            rgb = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.float64)
            self.tiles[key] = rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768
        return self.tiles[key]

    def _pixel(self, px, py):
        x, ix = divmod(px, 256)
        y, iy = divmod(py, 256)
        return self._tile(x, y)[iy, ix]

    def elevation(self, lon, lat):
        scale = 256 * 2 ** self.zoom
        fx = (lon + 180) / 360 * scale - 0.5
        sin = math.sin(math.radians(lat))
        fy = (0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * scale - 0.5
        x0, y0 = math.floor(fx), math.floor(fy)
        tx, ty = fx - x0, fy - y0
        z00 = self._pixel(x0, y0)
        z10 = self._pixel(x0 + 1, y0)
        z01 = self._pixel(x0, y0 + 1)
        z11 = self._pixel(x0 + 1, y0 + 1)
        top = z00 * (1 - tx) + z10 * tx
        bottom = z01 * (1 - tx) + z11 * tx
        return float(top * (1 - ty) + bottom * ty)


# --------------------------------------------------------------------------
# Géométrie


def haversine(a, b):
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def line_length(coords):
    return sum(haversine(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def densify(coords, step=SAMPLE_STEP_M):
    """Points régulièrement espacés le long d'une ligne : [(distance, lon, lat)]."""
    out = [(0.0, coords[0][0], coords[0][1])]
    total = 0.0
    for a, b in zip(coords, coords[1:]):
        seg = haversine(a, b)
        if seg == 0:
            continue
        n = max(1, int(math.ceil(seg / step)))
        for k in range(1, n + 1):
            t = k / n
            out.append((total + seg * t, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        total += seg
    return out


def ring_area_m2(coords):
    lat0 = math.radians(sum(c[1] for c in coords) / len(coords))
    kx = 111320 * math.cos(lat0)
    ky = 110540
    pts = [(c[0] * kx, c[1] * ky) for c in coords]
    return abs(sum(pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1] for i in range(len(pts) - 1))) / 2


def centroid(coords):
    return [sum(c[0] for c in coords) / len(coords), sum(c[1] for c in coords) / len(coords)]


def in_bbox(lon, lat, bbox):
    s, w, n, e = bbox
    return s <= lat <= n and w <= lon <= e


def rounded(coords, nd=6):
    return [[round(c[0], nd), round(c[1], nd)] for c in coords]


def is_closed(coords):
    return len(coords) >= 4 and coords[0] == coords[-1]


# --------------------------------------------------------------------------
# Profils et statistiques


def profile_of(terrain, coords):
    """[(distance, altitude, lon, lat)] tous les SAMPLE_STEP_M mètres."""
    return [(d, terrain.elevation(lon, lat), lon, lat) for d, lon, lat in densify(coords)]


def slope_stats(profile, window=30):
    """Pente moyenne et pente maximale (en %) sur une fenêtre glissante."""
    if len(profile) < 2:
        return 0, 0
    length = profile[-1][0]
    drop = abs(profile[0][1] - profile[-1][1])
    avg = 100 * drop / length if length else 0
    best = 0.0
    j = 0
    for i in range(len(profile)):
        while j < len(profile) and profile[j][0] - profile[i][0] < window:
            j += 1
        if j >= len(profile):
            break
        dz = abs(profile[j][1] - profile[i][1])
        dx = profile[j][0] - profile[i][0]
        best = max(best, 100 * dz / dx)
    return round(avg), round(best)


def compact_profile(profile, n=PROFILE_POINTS):
    if len(profile) <= n:
        picked = profile
    else:
        picked = [profile[round(i * (len(profile) - 1) / (n - 1))] for i in range(n)]
    return [[round(d), round(z), round(lon, 5), round(lat, 5)] for d, z, lon, lat in picked]


def chain_segments(segments, tolerance=100):
    """Enchaîne des tronçons orientés vers l'aval et garde le plus long
    enchaînement : c'est le tracé principal utilisé pour le profil."""
    best, best_length = None, -1
    for first in segments:
        chain = [first]
        remaining = [s for s in segments if s is not first]
        while remaining:
            end = chain[-1]["coords"][-1]
            nxt = min(remaining, key=lambda s: haversine(end, s["coords"][0]))
            if haversine(end, nxt["coords"][0]) > tolerance:
                break
            remaining.remove(nxt)
            chain.append(nxt)
        length = sum(s["props"]["length"] for s in chain)
        if length > best_length:
            best, best_length = chain, length
    coords = []
    for seg in best:
        coords.extend(seg["coords"] if not coords else seg["coords"][1:])
    return coords


# --------------------------------------------------------------------------
# Construction


def normalize(name):
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return " ".join(text.lower().replace("-", " ").split())


def best_variant(names):
    # Variante la plus fréquente, puis la plus accentuée (« Compétition » > « Competition »)
    counts = Counter(names)
    return max(counts, key=lambda n: (counts[n], sum(ord(c) > 127 for c in n)))


def geometry_of(element):
    return [[p["lon"], p["lat"]] for p in element.get("geometry") or [] if p]


def build(osm, terrain):
    elements = osm["elements"]
    features = []
    piste_segments = defaultdict(list)
    lifts = []
    stats = Counter()
    altitudes = []

    def add(geometry, props):
        features.append({"type": "Feature", "geometry": geometry, "properties": props})

    for el in elements:
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        coords = geometry_of(el)
        if len(coords) < 2:
            continue
        mid = centroid(coords)
        if not in_bbox(mid[0], mid[1], STATION_BBOX):
            continue

        # ---- emprise du domaine
        if tags.get("landuse") == "winter_sports":
            if tags.get("name") == RESORT_AREA_NAME and is_closed(coords):
                add({"type": "Polygon", "coordinates": [rounded(coords)]},
                    {"kind": "boundary", "name": tags["name"]})
            continue

        # ---- remontées mécaniques
        aerialway = tags.get("aerialway")
        if aerialway and aerialway not in ("station", "pylon", "goods"):
            if aerialway == "zip_line":
                continue
            if terrain.elevation(*coords[0]) > terrain.elevation(*coords[-1]):
                coords = coords[::-1]  # toujours du bas vers le haut
            prof = profile_of(terrain, coords)
            bottom, top = prof[0][1], prof[-1][1]
            length = prof[-1][0]
            rise = top - bottom
            lift_id = f"lift-{el['id']}"
            props = {
                "kind": "lift",
                "id": lift_id,
                "osm": el["id"],
                "name": tags.get("name", LIFT_LABELS.get(aerialway, "Remontée")),
                "name_ca": tags.get("name:ca"),
                "lift_type": aerialway,
                "type_label": LIFT_LABELS.get(aerialway, aerialway),
                "capacity": int(tags["aerialway:capacity"]) if tags.get("aerialway:capacity", "").isdigit() else None,
                "occupancy": int(tags["aerialway:occupancy"]) if tags.get("aerialway:occupancy", "").isdigit() else None,
                "duration": tags.get("aerialway:duration"),
                "detachable": tags.get("aerialway:detachable"),
                "bubble": tags.get("aerialway:bubble"),
                "summer": tags.get("aerialway:summer:access") in ("both", "entry", "exit"),
                "length": round(length),
                "length_slope": round(math.hypot(length, rise)),
                "bottom": round(bottom),
                "top": round(top),
                "rise": round(rise),
                "avg_slope": round(100 * rise / length) if length else 0,
            }
            add({"type": "LineString", "coordinates": rounded(coords)}, props)
            for idx, role in ((0, "bottom"), (-1, "top")):
                add({"type": "Point", "coordinates": rounded([coords[idx]])[0]},
                    {"kind": "station", "lift": lift_id, "lift_type": aerialway, "role": role,
                     "name": props["name"], "ele": props[role]})
            lifts.append({**props, "profile": compact_profile(prof), "bbox": bbox_of(coords)})
            stats["lifts"] += 1
            altitudes.extend([bottom, top])
            continue

        piste_type = tags.get("piste:type")
        if not piste_type:
            continue

        area = tags.get("area") == "yes" or (is_closed(coords) and piste_type in ("downhill", "snow_park"))
        name = tags.get("name") or tags.get("piste:name")
        difficulty = tags.get("piste:difficulty") or ("freeride" if piste_type == "skitour" else None)

        if piste_type == "snow_park":
            add({"type": "Polygon", "coordinates": [rounded(coords)]} if area else
                {"type": "LineString", "coordinates": rounded(coords)},
                {"kind": "snowpark", "id": f"park-{el['id']}", "name": name or "Snowpark",
                 "lit": tags.get("lit") == "yes"})
            continue

        if piste_type not in ("downhill", "nordic", "hike", "skitour", "sled"):
            continue

        if area:
            add({"type": "Polygon", "coordinates": [rounded(coords)]},
                {"kind": "piste-area", "piste_type": piste_type, "difficulty": difficulty or "unknown",
                 "name": name})
            continue

        start_ele = terrain.elevation(*coords[0])
        end_ele = terrain.elevation(*coords[-1])
        if piste_type == "downhill" and start_ele < end_ele and tags.get("oneway") != "yes":
            coords = coords[::-1]
            start_ele, end_ele = end_ele, start_ele
        prof = profile_of(terrain, coords)
        length = prof[-1][0]
        elevations = [p[1] for p in prof]
        avg_slope, max_slope = slope_stats(prof)

        kind = {"downhill": "piste", "nordic": "nordic", "hike": "hike", "skitour": "skitour", "sled": "sled"}[piste_type]
        if kind == "piste":
            group_key = f"{normalize(name)}|{difficulty}" if name else f"osm-{el['id']}"
        else:
            group_key = f"{kind}|{normalize(name)}" if name else f"{kind}-osm-{el['id']}"
        gid = "g-" + "".join(c if c.isalnum() else "-" for c in group_key)

        props = {
            "kind": kind,
            "gid": gid,
            "osm": el["id"],
            "name": name,
            "name_ca": tags.get("name:ca"),
            "difficulty": difficulty or "unknown",
            "lit": tags.get("lit") == "yes",
            "grooming": tags.get("piste:grooming"),
            "length": round(length),
            "top": round(max(elevations)),
            "bottom": round(min(elevations)),
            "drop": round(max(elevations) - min(elevations)),
            "avg_slope": avg_slope,
            "max_slope": max_slope,
        }
        add({"type": "LineString", "coordinates": rounded(coords)}, props)
        piste_segments[gid].append({"coords": coords, "props": props, "start_ele": start_ele,
                                    "name": name, "profile": prof})
        stats[f"{kind}_m"] += length
        if kind == "piste":
            altitudes.extend([max(elevations), min(elevations)])

    # ---- regroupement des tronçons par piste
    pistes = []
    for gid, segs in piste_segments.items():
        first = segs[0]["props"]
        names = [s["name"] for s in segs if s["name"]]
        display = best_variant(names) if names else None
        for seg in segs:
            seg["props"]["name"] = display
        kind = first["kind"]
        all_coords = [c for s in segs for c in s["coords"]]
        main = chain_segments(segs) if kind == "piste" else max(segs, key=lambda s: s["props"]["length"])["coords"]
        prof = profile_of(terrain, main)
        avg_slope, max_slope = slope_stats(prof)
        top = max(s["props"]["top"] for s in segs)
        bottom = min(s["props"]["bottom"] for s in segs)
        entry = {
            "gid": gid,
            "kind": kind,
            "name": display,
            "name_ca": next((s["props"]["name_ca"] for s in segs if s["props"]["name_ca"]), None),
            "difficulty": first["difficulty"],
            "lit": any(s["props"]["lit"] for s in segs),
            "segments": len(segs),
            "length": round(sum(s["props"]["length"] for s in segs)),
            "top": top,
            "bottom": bottom,
            "drop": top - bottom,
            "avg_slope": avg_slope,
            "max_slope": max(max_slope, max(s["props"]["max_slope"] for s in segs)),
            "profile": compact_profile(prof),
            "bbox": bbox_of(all_coords),
        }
        # Statistiques du groupe recopiées sur chaque tronçon (fiche au clic)
        for seg in segs:
            seg["props"].update({k: entry[k] for k in ("length", "top", "bottom", "drop", "avg_slope", "max_slope", "lit")})
        pistes.append(entry)
        if kind == "piste" and display:
            stats[f"piste_{first['difficulty']}"] += 1

    # ---- pylônes
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "node" and tags.get("aerialway") == "pylon" and in_bbox(el["lon"], el["lat"], STATION_BBOX):
            add({"type": "Point", "coordinates": [round(el["lon"], 6), round(el["lat"], 6)]}, {"kind": "pylon"})

    # ---- points d'intérêt
    features.extend(points_of_interest(elements, terrain))

    order = {"novice": 0, "easy": 1, "intermediate": 2, "advanced": 3, "expert": 4, "freeride": 5, "unknown": 6}
    pistes.sort(key=lambda p: (p["kind"] != "piste", p["name"] is None, order.get(p["difficulty"], 9), normalize(p["name"] or "")))
    lift_order = ["cable_car", "gondola", "mixed_lift", "chair_lift", "drag_lift", "t-bar", "j-bar", "platter", "rope_tow", "magic_carpet"]
    lifts.sort(key=lambda l: (lift_order.index(l["lift_type"]) if l["lift_type"] in lift_order else 99, normalize(l["name"])))

    named_downhill = [p for p in pistes if p["kind"] == "piste" and p["name"]]
    summary = {
        "pistes": len(named_downhill),
        "by_difficulty": {d: sum(1 for p in named_downhill if p["difficulty"] == d)
                          for d in ("novice", "easy", "intermediate", "advanced", "expert")},
        "lifts": stats["lifts"],
        "downhill_km": round(stats["piste_m"] / 1000, 1),
        "nordic_km": round(stats["nordic_m"] / 1000, 1),
        "hike_km": round(stats["hike_m"] / 1000, 1),
        "alt_min": round(min(altitudes)),
        "alt_max": round(max(altitudes)),
    }
    return features, pistes, lifts, summary


def bbox_of(coords):
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return [round(min(lons), 5), round(min(lats), 5), round(max(lons), 5), round(max(lats), 5)]


def points_of_interest(elements, terrain):
    out = []
    seen = set()

    def poi(kind, lon, lat, name, **extra):
        key = (kind, name, round(lon, 3), round(lat, 3))
        if key in seen:
            return
        seen.add(key)
        props = {"kind": kind, "name": name}
        props.update({k: v for k, v in extra.items() if v is not None})
        out.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                    "properties": props})

    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "node":
            lon, lat = el["lon"], el["lat"]
        else:
            coords = geometry_of(el)
            if not coords:
                continue
            lon, lat = centroid(coords)
        name = tags.get("name")

        if tags.get("natural") == "peak" and name:
            ele = parse_ele(tags.get("ele")) or round(terrain.elevation(lon, lat))
            is_pass = normalize(name).startswith(("col ", "coll ", "portella", "port "))
            poi("pass" if is_pass else "peak", lon, lat, name, ele=ele)
        elif tags.get("mountain_pass") == "yes" and name:
            poi("pass", lon, lat, name, ele=parse_ele(tags.get("ele")) or round(terrain.elevation(lon, lat)))
        elif tags.get("place") in ("town", "village", "hamlet") and name:
            if name in MERGED_COMMUNES:
                continue  # doublon du nom de commune : les villages sont déjà présents
            if normalize(name).startswith(("lotissement", "residence")):
                continue
            poi("place", lon, lat, name, rank=1 if name in MAIN_PLACES else 2,
                ele=round(terrain.elevation(lon, lat)))
        elif not in_bbox(lon, lat, STATION_BBOX):
            continue
        elif tags.get("amenity") in ("restaurant", "cafe", "bar") and name:
            # Seulement les établissements sur le domaine, pas ceux du centre-ville
            if lat >= 42.514:
                poi("restaurant", lon, lat, name, ele=round(terrain.elevation(lon, lat)))
        elif tags.get("amenity") == "first_aid":
            poi("first_aid", lon, lat, name or "Poste de secours")
        elif tags.get("tourism") == "viewpoint" and name:
            poi("viewpoint", lon, lat, name, ele=round(terrain.elevation(lon, lat)))
        elif tags.get("tourism") == "information" and tags.get("information") == "office":
            poi("info", lon, lat, name or "Office de tourisme")
        elif tags.get("amenity") == "parking" and el["type"] == "way":
            coords = geometry_of(el)
            capacity = tags.get("capacity")
            area = ring_area_m2(coords) if is_closed(coords) else 0
            if tags.get("access") in ("private", "no", "customers"):
                continue
            if area >= 2500 or (capacity and capacity.isdigit() and int(capacity) >= 80) or name:
                poi("parking", lon, lat, name or "Parking",
                    capacity=int(capacity) if capacity and capacity.isdigit() else None,
                    access=tags.get("access"), fee=tags.get("fee"))
    return out


def parse_ele(value):
    if not value:
        return None
    try:
        return round(float(value.replace(",", ".").replace("m", "").strip()))
    except ValueError:
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", help="répertoire de cache pour les téléchargements")
    parser.add_argument("--output", default=OUTPUT)
    args = parser.parse_args()
    if args.cache:
        os.makedirs(args.cache, exist_ok=True)

    osm = fetch_osm(args.cache)
    terrain = Terrain(args.cache)
    features, pistes, lifts, summary = build(osm, terrain)

    s, w, n, e = STATION_BBOX
    data = {
        "meta": {
            "name": "Font-Romeu Pyrénées 2000",
            "generated": dt.date.today().isoformat(),
            "osm_timestamp": osm.get("osm3s", {}).get("timestamp_osm_base"),
            "bounds": [w, s, e, n],
            "attribution": "Données © contributeurs OpenStreetMap (ODbL) · Altitudes : Mapzen Terrarium / AWS Open Data",
            "summary": summary,
        },
        "geojson": {"type": "FeatureCollection", "features": features},
        "pistes": pistes,
        "lifts": lifts,
    }
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fh:
        fh.write("// Fichier généré par scripts/build_data.py — ne pas modifier à la main.\n")
        fh.write("// Données © contributeurs OpenStreetMap, licence ODbL (https://www.openstreetmap.org/copyright).\n")
        fh.write("window.FONT_ROMEU = ")
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")
    print(f"{args.output} : {len(features)} objets, {summary}", file=sys.stderr)


if __name__ == "__main__":
    main()
