// Vendored ambient declaration: the npm `topojson-specification` types package was
// unpublished (2023-03-15), but @types/topojson-client still imports from it.
declare module "topojson-specification" {
  import type * as GeoJSON from "geojson";

  export interface Topology<T extends Objects = Objects> {
    type: "Topology";
    objects: T;
    arcs: Position[][];
    transform?: Transform | undefined;
    bbox?: GeoJSON.BBox | undefined;
  }
  export interface Transform { scale: [number, number]; translate: [number, number]; }
  export type Objects = Record<string, GeometryObject>;
  export type Position = number[];
  export type Properties = GeoJSON.GeoJsonProperties;

  export interface GeometryObjectA<P extends Properties = Properties> {
    type: string;
    id?: number | string | undefined;
    properties?: P | undefined;
    bbox?: GeoJSON.BBox | undefined;
  }
  export interface NullObject extends GeometryObjectA { type: null; }
  export interface Point<P extends Properties = Properties> extends GeometryObjectA<P> { type: "Point"; coordinates: Position; }
  export interface MultiPoint<P extends Properties = Properties> extends GeometryObjectA<P> { type: "MultiPoint"; coordinates: Position[]; }
  export interface LineString<P extends Properties = Properties> extends GeometryObjectA<P> { type: "LineString"; arcs: number[]; }
  export interface MultiLineString<P extends Properties = Properties> extends GeometryObjectA<P> { type: "MultiLineString"; arcs: number[][]; }
  export interface Polygon<P extends Properties = Properties> extends GeometryObjectA<P> { type: "Polygon"; arcs: number[][]; }
  export interface MultiPolygon<P extends Properties = Properties> extends GeometryObjectA<P> { type: "MultiPolygon"; arcs: number[][][]; }
  export interface GeometryCollection<P extends Properties = Properties> extends GeometryObjectA<P> {
    type: "GeometryCollection";
    geometries: Array<GeometryObject<P>>;
  }
  export type GeometryObject<P extends Properties = Properties> =
    | NullObject | Point<P> | MultiPoint<P> | LineString<P> | MultiLineString<P>
    | Polygon<P> | MultiPolygon<P> | GeometryCollection<P>;
}
