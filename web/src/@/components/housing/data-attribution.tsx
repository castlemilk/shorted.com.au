/**
 * Source + licence credits for the suburb insight layers. The OSM line is a hard
 * ODbL requirement wherever OSM-derived metrics (supermarkets, pubs, parks,
 * libraries) are shown; ABS/ACARA/Geoscience Australia/NBN are CC-BY attribution.
 */
export function DataAttribution() {
  return (
    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
      Sources:{" "}
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        © OpenStreetMap contributors
      </a>{" "}
      (ODbL); Australian Bureau of Statistics, ACARA, Geoscience Australia, and
      NBN Co (CC BY 4.0). NSW Bureau of Crime Statistics and Research (CC BY
      4.0; crime rates adjusted to the ABS Crime Victimisation Survey). Amenity
      figures are derived per-suburb counts, not address-level guarantees.
    </p>
  );
}
