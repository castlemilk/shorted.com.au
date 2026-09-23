/**
 * Council geometry derived from the suburb topology the map already loads.
 *
 * No council boundary file ships: every suburb carries its dominant council
 * (the lga_code column, ABS mesh-block allocation), and TopoJSON's shared arcs
 * give council fills (mergeArcs), outlines (merge) and internal boundaries
 * (mesh) for free. Measured 1–22 ms per state (NSW slowest).
 *
 * The outline is the union of the suburbs whose DOMINANT council this is, so a
 * suburb split between two councils is drawn wholly inside one of them. That
 * is the ABS allocation's granularity, not the gazetted boundary, and the map
 * says so.
 */
import { mergeArcs, merge, mesh } from "topojson-client";
import type { GeometryCollection, GeometryObject, MultiPolygon as TopoMultiPolygon, Topology } from "topojson-specification";
import type { MultiLineString, MultiPolygon } from "geojson";

type Geometries = GeometryCollection["geometries"];

function geometriesOf(topology: Topology, objectName: string): Geometries {
  const obj = topology.objects[objectName] as GeometryCollection | undefined;
  return obj?.geometries ?? [];
}

/** lga_code column values (float) → 5-digit ABS code strings; null stays null. */
export function lgaCodesFromColumn(column: ReadonlyMap<string, number | null> | undefined): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!column) return out;
  for (const [sal, v] of column) out.set(sal, v == null || !Number.isFinite(v) ? null : String(Math.round(v)));
  return out;
}

/**
 * Lines between suburbs in DIFFERENT councils (both known). The state's outer
 * edge and lines inside one council are left out, so it reads as council
 * borders drawn over the suburb map.
 */
export function councilBorders(
  topology: Topology, objectName: string, lgaBySal: ReadonlyMap<string, string | null>,
): MultiLineString | null {
  const obj = topology.objects[objectName] as GeometryCollection | undefined;
  if (!obj || lgaBySal.size === 0) return null;
  const lga = (g: GeometryObject) => lgaBySal.get(String(g.id)) ?? null;
  const lines = mesh(topology, obj, (a, b) => {
    if (a === b) return false;
    const la = lga(a), lb = lga(b);
    return la !== null && lb !== null && la !== lb;
  });
  return lines.coordinates.length ? lines : null;
}

/** The union of a set of suburbs (a council's dominant members), or null. */
export function unionOf(
  topology: Topology, objectName: string, salCodes: ReadonlySet<string>,
): MultiPolygon | null {
  const picked = geometriesOf(topology, objectName).filter((g) => salCodes.has(String(g.id)));
  if (picked.length === 0) return null;
  return merge(topology, picked as never);
}

/**
 * A derived topology with one feature per council (id = ABS LGA code), built
 * by merging each council's suburbs on their shared arcs. Suburbs with no
 * council are dropped. The ChoroplethMap renders it like any other object.
 */
export function councilTopology(
  topology: Topology, objectName: string, lgaBySal: ReadonlyMap<string, string | null>,
): { topology: Topology; objectName: string; councils: number } {
  const groups = new Map<string, Geometries>();
  for (const g of geometriesOf(topology, objectName)) {
    const code = lgaBySal.get(String(g.id));
    if (!code) continue;
    const list = groups.get(code);
    if (list) list.push(g);
    else groups.set(code, [g]);
  }
  const geometries: TopoMultiPolygon[] = [];
  for (const [code, members] of groups) {
    const merged = mergeArcs(topology, members as never);
    geometries.push({ ...merged, id: code });
  }
  return {
    topology: {
      ...topology,
      objects: { councils: { type: "GeometryCollection", geometries } as GeometryCollection },
    },
    objectName: "councils",
    councils: geometries.length,
  };
}
