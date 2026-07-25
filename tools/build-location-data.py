#!/usr/bin/env python3
"""Generate backend/static/js/location-data.js — the offline coordinate tables the
Settings → Location card uses to turn a US ZIP or a city choice into lat/lng.

Why offline: sun-relative schedules need lat/lng, and we refuse to depend on a
paid/keyed geocoding API. Both tables ship as static JS (same pattern as
palette-data.js), so lookups are instant and work with no internet at all.

US ZIPs are reduced to a **3-digit prefix** (~900 entries, ~20KB) rather than all
~33k ZCTAs (~600KB). A ZIP3 centroid is within roughly 25-50 km of the real ZIP,
and sunrise/sunset moves ~1 minute per 20 km of longitude — so the worst case is
a couple of minutes, which is irrelevant for switching lights on at dusk.

Source: US Census ZCTA Gazetteer (public domain).
Run:  python tools/build-location-data.py
"""
import io
import sys
import zipfile
import urllib.request
from collections import defaultdict
from pathlib import Path

GAZ_URL = ("https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
           "2023_Gazetteer/2023_Gaz_zcta_national.zip")
OUT = Path(__file__).resolve().parent.parent / "backend" / "static" / "js" / "location-data.js"

# Representative world cities for the "nearest city" picker. Curated for coverage
# (every inhabited continent + the major population centres) rather than
# completeness — someone whose city is missing can use the Google Maps route.
# Coordinates are city-centre, rounded to 2dp (~1 km, far tighter than needed).
WORLD_CITIES = [
    # ── North America ──
    ("United States", "New York, NY", 40.71, -74.01),
    ("United States", "Los Angeles, CA", 34.05, -118.24),
    ("United States", "Chicago, IL", 41.88, -87.63),
    ("United States", "Houston, TX", 29.76, -95.37),
    ("United States", "Phoenix, AZ", 33.45, -112.07),
    ("United States", "Philadelphia, PA", 39.95, -75.17),
    ("United States", "San Antonio, TX", 29.42, -98.49),
    ("United States", "San Diego, CA", 32.72, -117.16),
    ("United States", "Dallas, TX", 32.78, -96.80),
    ("United States", "Austin, TX", 30.27, -97.74),
    ("United States", "San Jose, CA", 37.34, -121.89),
    ("United States", "San Francisco, CA", 37.77, -122.42),
    ("United States", "Seattle, WA", 47.61, -122.33),
    ("United States", "Denver, CO", 39.74, -104.98),
    ("United States", "Boston, MA", 42.36, -71.06),
    ("United States", "Atlanta, GA", 33.75, -84.39),
    ("United States", "Miami, FL", 25.76, -80.19),
    ("United States", "Orlando, FL", 28.54, -81.38),
    ("United States", "Tampa, FL", 27.95, -82.46),
    ("United States", "Minneapolis, MN", 44.98, -93.27),
    ("United States", "Detroit, MI", 42.33, -83.05),
    ("United States", "Portland, OR", 45.52, -122.68),
    ("United States", "Las Vegas, NV", 36.17, -115.14),
    ("United States", "Salt Lake City, UT", 40.76, -111.89),
    ("United States", "Kansas City, MO", 39.10, -94.58),
    ("United States", "St. Louis, MO", 38.63, -90.20),
    ("United States", "Nashville, TN", 36.16, -86.78),
    ("United States", "Charlotte, NC", 35.23, -80.84),
    ("United States", "Raleigh, NC", 35.78, -78.64),
    ("United States", "Indianapolis, IN", 39.77, -86.16),
    ("United States", "Columbus, OH", 39.96, -83.00),
    ("United States", "Cleveland, OH", 41.50, -81.69),
    ("United States", "Pittsburgh, PA", 40.44, -79.996),
    ("United States", "Baltimore, MD", 39.29, -76.61),
    ("United States", "Washington, DC", 38.91, -77.04),
    ("United States", "Milwaukee, WI", 43.04, -87.91),
    ("United States", "New Orleans, LA", 29.95, -90.07),
    ("United States", "Oklahoma City, OK", 35.47, -97.52),
    ("United States", "Albuquerque, NM", 35.08, -106.65),
    ("United States", "Sacramento, CA", 38.58, -121.49),
    ("United States", "Honolulu, HI", 21.31, -157.86),
    ("United States", "Anchorage, AK", 61.22, -149.90),
    ("Canada", "Toronto, ON", 43.65, -79.38),
    ("Canada", "Montreal, QC", 45.50, -73.57),
    ("Canada", "Vancouver, BC", 49.28, -123.12),
    ("Canada", "Calgary, AB", 51.05, -114.07),
    ("Canada", "Edmonton, AB", 53.55, -113.49),
    ("Canada", "Ottawa, ON", 45.42, -75.70),
    ("Canada", "Winnipeg, MB", 49.90, -97.14),
    ("Canada", "Halifax, NS", 44.65, -63.58),
    ("Mexico", "Mexico City", 19.43, -99.13),
    ("Mexico", "Guadalajara", 20.66, -103.35),
    ("Mexico", "Monterrey", 25.69, -100.32),
    ("Mexico", "Cancún", 21.16, -86.85),
    ("Mexico", "Tijuana", 32.51, -117.04),
    ("Costa Rica", "San José", 9.93, -84.08),
    ("Panama", "Panama City", 8.98, -79.52),
    ("Guatemala", "Guatemala City", 14.63, -90.51),
    ("Cuba", "Havana", 23.11, -82.37),
    ("Dominican Republic", "Santo Domingo", 18.49, -69.93),
    ("Jamaica", "Kingston", 18.02, -76.80),
    ("Puerto Rico", "San Juan", 18.47, -66.11),
    # ── South America ──
    ("Brazil", "São Paulo", -23.55, -46.63),
    ("Brazil", "Rio de Janeiro", -22.91, -43.17),
    ("Brazil", "Brasília", -15.79, -47.88),
    ("Brazil", "Salvador", -12.97, -38.50),
    ("Brazil", "Fortaleza", -3.73, -38.53),
    ("Brazil", "Porto Alegre", -30.03, -51.23),
    ("Brazil", "Manaus", -3.12, -60.02),
    ("Argentina", "Buenos Aires", -34.60, -58.38),
    ("Argentina", "Córdoba", -31.42, -64.18),
    ("Argentina", "Mendoza", -32.89, -68.84),
    ("Chile", "Santiago", -33.45, -70.67),
    ("Colombia", "Bogotá", 4.71, -74.07),
    ("Colombia", "Medellín", 6.24, -75.58),
    ("Peru", "Lima", -12.05, -77.04),
    ("Ecuador", "Quito", -0.18, -78.47),
    ("Venezuela", "Caracas", 10.48, -66.90),
    ("Uruguay", "Montevideo", -34.90, -56.16),
    ("Bolivia", "La Paz", -16.50, -68.15),
    ("Paraguay", "Asunción", -25.26, -57.58),
    # ── Europe ──
    ("United Kingdom", "London", 51.51, -0.13),
    ("United Kingdom", "Manchester", 53.48, -2.24),
    ("United Kingdom", "Birmingham", 52.49, -1.89),
    ("United Kingdom", "Glasgow", 55.86, -4.25),
    ("United Kingdom", "Edinburgh", 55.95, -3.19),
    ("United Kingdom", "Belfast", 54.60, -5.93),
    ("Ireland", "Dublin", 53.35, -6.26),
    ("France", "Paris", 48.86, 2.35),
    ("France", "Marseille", 43.30, 5.37),
    ("France", "Lyon", 45.76, 4.84),
    ("France", "Toulouse", 43.60, 1.44),
    ("Spain", "Madrid", 40.42, -3.70),
    ("Spain", "Barcelona", 41.39, 2.17),
    ("Spain", "Valencia", 39.47, -0.38),
    ("Spain", "Seville", 37.39, -6.00),
    ("Portugal", "Lisbon", 38.72, -9.14),
    ("Portugal", "Porto", 41.15, -8.61),
    ("Germany", "Berlin", 52.52, 13.40),
    ("Germany", "Munich", 48.14, 11.58),
    ("Germany", "Hamburg", 53.55, 9.99),
    ("Germany", "Frankfurt", 50.11, 8.68),
    ("Germany", "Cologne", 50.94, 6.96),
    ("Netherlands", "Amsterdam", 52.37, 4.90),
    ("Netherlands", "Rotterdam", 51.92, 4.48),
    ("Belgium", "Brussels", 50.85, 4.35),
    ("Switzerland", "Zurich", 47.38, 8.54),
    ("Switzerland", "Geneva", 46.20, 6.14),
    ("Austria", "Vienna", 48.21, 16.37),
    ("Italy", "Rome", 41.90, 12.50),
    ("Italy", "Milan", 45.46, 9.19),
    ("Italy", "Naples", 40.85, 14.27),
    ("Italy", "Turin", 45.07, 7.69),
    ("Greece", "Athens", 37.98, 23.73),
    ("Poland", "Warsaw", 52.23, 21.01),
    ("Poland", "Kraków", 50.06, 19.94),
    ("Czechia", "Prague", 50.08, 14.44),
    ("Hungary", "Budapest", 47.50, 19.04),
    ("Romania", "Bucharest", 44.43, 26.10),
    ("Bulgaria", "Sofia", 42.70, 23.32),
    ("Serbia", "Belgrade", 44.79, 20.45),
    ("Croatia", "Zagreb", 45.81, 15.98),
    ("Sweden", "Stockholm", 59.33, 18.07),
    ("Sweden", "Gothenburg", 57.71, 11.97),
    ("Norway", "Oslo", 59.91, 10.75),
    ("Denmark", "Copenhagen", 55.68, 12.57),
    ("Finland", "Helsinki", 60.17, 24.94),
    ("Iceland", "Reykjavík", 64.15, -21.94),
    ("Estonia", "Tallinn", 59.44, 24.75),
    ("Latvia", "Riga", 56.95, 24.11),
    ("Lithuania", "Vilnius", 54.69, 25.28),
    ("Ukraine", "Kyiv", 50.45, 30.52),
    ("Russia", "Moscow", 55.76, 37.62),
    ("Russia", "Saint Petersburg", 59.93, 30.34),
    ("Turkey", "Istanbul", 41.01, 28.98),
    ("Turkey", "Ankara", 39.93, 32.86),
    # ── Africa & Middle East ──
    ("Egypt", "Cairo", 30.04, 31.24),
    ("Morocco", "Casablanca", 33.57, -7.59),
    ("Morocco", "Marrakesh", 31.63, -8.01),
    ("Algeria", "Algiers", 36.75, 3.06),
    ("Tunisia", "Tunis", 36.81, 10.18),
    ("Nigeria", "Lagos", 6.52, 3.38),
    ("Nigeria", "Abuja", 9.06, 7.49),
    ("Ghana", "Accra", 5.60, -0.19),
    ("Kenya", "Nairobi", -1.29, 36.82),
    ("Ethiopia", "Addis Ababa", 9.03, 38.74),
    ("Tanzania", "Dar es Salaam", -6.79, 39.21),
    ("Uganda", "Kampala", 0.35, 32.58),
    ("South Africa", "Johannesburg", -26.20, 28.05),
    ("South Africa", "Cape Town", -33.92, 18.42),
    ("South Africa", "Durban", -29.86, 31.02),
    ("Senegal", "Dakar", 14.72, -17.47),
    ("Israel", "Tel Aviv", 32.09, 34.78),
    ("Israel", "Jerusalem", 31.77, 35.21),
    ("United Arab Emirates", "Dubai", 25.20, 55.27),
    ("United Arab Emirates", "Abu Dhabi", 24.45, 54.38),
    ("Saudi Arabia", "Riyadh", 24.71, 46.68),
    ("Saudi Arabia", "Jeddah", 21.49, 39.19),
    ("Qatar", "Doha", 25.29, 51.53),
    ("Kuwait", "Kuwait City", 29.38, 47.99),
    ("Jordan", "Amman", 31.95, 35.93),
    ("Lebanon", "Beirut", 33.89, 35.50),
    ("Iraq", "Baghdad", 33.31, 44.36),
    ("Iran", "Tehran", 35.69, 51.39),
    # ── Asia ──
    ("India", "Mumbai", 19.08, 72.88),
    ("India", "Delhi", 28.61, 77.21),
    ("India", "Bengaluru", 12.97, 77.59),
    ("India", "Hyderabad", 17.39, 78.49),
    ("India", "Chennai", 13.08, 80.27),
    ("India", "Kolkata", 22.57, 88.36),
    ("India", "Pune", 18.52, 73.86),
    ("India", "Ahmedabad", 23.02, 72.57),
    ("Pakistan", "Karachi", 24.86, 67.01),
    ("Pakistan", "Lahore", 31.55, 74.34),
    ("Pakistan", "Islamabad", 33.68, 73.05),
    ("Bangladesh", "Dhaka", 23.81, 90.41),
    ("Sri Lanka", "Colombo", 6.93, 79.86),
    ("Nepal", "Kathmandu", 27.72, 85.32),
    ("China", "Beijing", 39.90, 116.41),
    ("China", "Shanghai", 31.23, 121.47),
    ("China", "Guangzhou", 23.13, 113.26),
    ("China", "Shenzhen", 22.54, 114.06),
    ("China", "Chengdu", 30.57, 104.07),
    ("China", "Hong Kong", 22.32, 114.17),
    ("Taiwan", "Taipei", 25.03, 121.57),
    ("Japan", "Tokyo", 35.68, 139.69),
    ("Japan", "Osaka", 34.69, 135.50),
    ("Japan", "Nagoya", 35.18, 136.91),
    ("Japan", "Sapporo", 43.06, 141.35),
    ("Japan", "Fukuoka", 33.59, 130.40),
    ("South Korea", "Seoul", 37.57, 126.98),
    ("South Korea", "Busan", 35.18, 129.08),
    ("Singapore", "Singapore", 1.35, 103.82),
    ("Malaysia", "Kuala Lumpur", 3.14, 101.69),
    ("Thailand", "Bangkok", 13.76, 100.50),
    ("Vietnam", "Ho Chi Minh City", 10.82, 106.63),
    ("Vietnam", "Hanoi", 21.03, 105.85),
    ("Indonesia", "Jakarta", -6.21, 106.85),
    ("Indonesia", "Bali (Denpasar)", -8.65, 115.22),
    ("Philippines", "Manila", 14.60, 120.98),
    ("Kazakhstan", "Almaty", 43.24, 76.89),
    # ── Oceania ──
    ("Australia", "Sydney", -33.87, 151.21),
    ("Australia", "Melbourne", -37.81, 144.96),
    ("Australia", "Brisbane", -27.47, 153.03),
    ("Australia", "Perth", -31.95, 115.86),
    ("Australia", "Adelaide", -34.93, 138.60),
    ("Australia", "Canberra", -35.28, 149.13),
    ("Australia", "Hobart", -42.88, 147.33),
    ("Australia", "Darwin", -12.46, 130.84),
    ("New Zealand", "Auckland", -36.85, 174.76),
    ("New Zealand", "Wellington", -41.29, 174.78),
    ("New Zealand", "Christchurch", -43.53, 172.64),
    ("Fiji", "Suva", -18.14, 178.44),
]


def build_zip3():
    print(f"downloading {GAZ_URL} …")
    with urllib.request.urlopen(GAZ_URL, timeout=120) as resp:
        blob = resp.read()
    print(f"  {len(blob):,} bytes")

    zf = zipfile.ZipFile(io.BytesIO(blob))
    name = next(n for n in zf.namelist() if n.lower().endswith(".txt"))
    text = zf.read(name).decode("utf-8", errors="replace")

    header, *rows = text.splitlines()
    cols = [c.strip() for c in header.split("\t")]
    i_geoid = cols.index("GEOID")
    i_lat = cols.index("INTPTLAT")
    i_lon = cols.index("INTPTLONG")

    buckets = defaultdict(list)
    for row in rows:
        parts = row.split("\t")
        if len(parts) <= max(i_geoid, i_lat, i_lon):
            continue
        geoid = parts[i_geoid].strip()
        if len(geoid) != 5 or not geoid.isdigit():
            continue
        try:
            lat, lon = float(parts[i_lat]), float(parts[i_lon])
        except ValueError:
            continue
        buckets[geoid[:3]].append((lat, lon))

    zip3 = {}
    for p, pts in sorted(buckets.items()):
        zip3[p] = (round(sum(a for a, _ in pts) / len(pts), 3),
                   round(sum(b for _, b in pts) / len(pts), 3))
    print(f"  {len(rows):,} ZCTAs -> {len(zip3)} ZIP3 prefixes")
    return zip3


def sanity_check(zip3):
    """Fail loudly rather than shipping a silently wrong table."""
    problems = []
    for p, (lat, lon) in zip3.items():
        # US bounding box. Longitude has TWO valid bands: the Americas (mainland,
        # AK, HI, PR) and the western Pacific — prefix 969 (Guam / N. Mariana /
        # Marshall Is. / Micronesia / Palau) sits at ~145E, and prefix 967 mixes
        # Hawaii with American Samoa (96799) at ~14S.
        lat_ok = -15.0 <= lat <= 72.0
        lon_ok = (-180.0 <= lon <= -64.0) or (130.0 <= lon <= 180.0)
        if not lat_ok or not lon_ok:
            problems.append(f"{p} out of range: {lat},{lon}")
    # Spot-check well-known prefixes against hand-known city coordinates.
    spot = {
        "902": (34.05, -118.40, "Beverly Hills CA"),
        "100": (40.75, -73.99, "Manhattan NY"),
        "606": (41.88, -87.65, "Chicago IL"),
        "021": (42.35, -71.06, "Boston MA"),
        "331": (25.77, -80.20, "Miami FL"),
        "981": (47.61, -122.33, "Seattle WA"),
        "787": (30.27, -97.74, "Austin TX"),
    }
    for p, (elat, elon, label) in spot.items():
        if p not in zip3:
            problems.append(f"missing spot-check prefix {p} ({label})")
            continue
        lat, lon = zip3[p]
        dlat, dlon = abs(lat - elat), abs(lon - elon)
        # ZIP3 is an average over many ZCTAs, so allow ~1 degree of slack.
        status = "ok " if (dlat < 1.0 and dlon < 1.0) else "BAD"
        if status == "BAD":
            problems.append(f"{p} ({label}) = {lat},{lon}, expected ~{elat},{elon}")
        print(f"    {status} {p} {label:16} -> {lat},{lon}")
    return problems


def main():
    zip3 = build_zip3()
    print("  sanity checks:")
    problems = sanity_check(zip3)
    if problems:
        print("\nFAILED:")
        for p in problems:
            print("  " + p)
        sys.exit(1)

    zip_entries = ",".join(f'"{p}":[{lat},{lon}]' for p, (lat, lon) in sorted(zip3.items()))
    city_entries = ",\n".join(
        f'  ["{c}", "{city}", {lat}, {lon}]' for c, city, lat, lon in WORLD_CITIES
    )

    out = f'''// GENERATED FILE — do not edit by hand.
// Regenerate with:  python tools/build-location-data.py
//
// Offline coordinate tables for Settings → Location, so a US ZIP or a city pick
// resolves to lat/lng with no geocoding API (sun schedules need lat/lng, and we
// won't take a paid/keyed dependency for it).
//
// ZIP3_COORDS: US ZIP **3-digit prefix** → [lat, lng], averaged over that
// prefix's ZCTA centroids. Source: US Census {GAZ_URL.rsplit("/", 1)[-1]} (public
// domain). A prefix centroid is ~25-50 km from the true ZIP, which moves
// sunrise/sunset by only a couple of minutes — irrelevant for lighting, and it
// keeps this file ~20KB instead of ~600KB for all {len(zip3)}+ full ZIPs.
const ZIP3_COORDS = {{{zip_entries}}};

// [country, city, lat, lng] — representative, not exhaustive. Someone whose city
// is missing uses the Google Maps route in the same card.
const WORLD_CITIES = [
{city_entries}
];
'''
    OUT.write_text(out, encoding="utf-8")
    print(f"\nwrote {OUT}")
    print(f"  {len(zip3)} ZIP3 prefixes, {len(WORLD_CITIES)} cities, {len(out):,} bytes")


if __name__ == "__main__":
    main()
