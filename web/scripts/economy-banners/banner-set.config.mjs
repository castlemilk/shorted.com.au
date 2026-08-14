// Economy state-banner backgrounds — one full-bleed landscape scene per state.
//
// This deliberately uses the housing banner STYLE suffix unchanged so both
// surfaces share one editorial visual language. State identity lives only in
// each scene subject; names, silhouettes, and breadcrumbs are rendered by the
// page rather than generated into the bitmap.
import { STYLE as HOUSING_BANNER_STYLE } from "../housing-banners/banner-set.config.mjs";

export const STYLE = HOUSING_BANNER_STYLE;

/**
 * `id` is the public economy route slug and the stable manifest key.
 * Subjects avoid signature sacred sites and leave all text to the web layer.
 */
export const ARCHETYPES = [
  {
    id: "wa",
    name: "Western Australia",
    subject:
      "vast iron-ore country in Western Australia, with terraced ochre mine benches, a long mineral freight train and low rust-red ranges receding into heat haze, entirely generic terrain with no recognisable landmark",
  },
  {
    id: "qld",
    name: "Queensland",
    subject:
      "lush Queensland sugar-cane fields running toward a tropical coastal bulk port, with low storage sheds, simple loading cranes and a cargo ship silhouette beyond the green rows",
  },
  {
    id: "nsw",
    name: "New South Wales",
    subject:
      "a broad working New South Wales harbour city at golden hour, with layered office towers, waterside wharves, a small commuter ferry and calm blue water, avoiding famous landmark architecture",
  },
  {
    id: "vic",
    name: "Victoria",
    subject:
      "a rain-washed Melbourne-style laneway opening toward a layered Victoria city skyline, with brick warehouse facades, cafe awnings, rooftop shapes and plane trees, with every sign surface blank",
  },
  {
    id: "sa",
    name: "South Australia",
    subject:
      "orderly South Australian vineyard rows sweeping across sunlit ochre farmland toward dry folded ranges, with a few low winery sheds and shelterbelt trees in the middle distance",
  },
  {
    id: "tas",
    name: "Tasmania",
    subject:
      "a rugged Tasmanian wilderness coast with dark dolerite cliffs, wind-shaped native forest, pale surf and a small working fishing boat far offshore beneath changing southern light",
  },
  {
    id: "nt",
    name: "Northern Territory",
    subject:
      "expansive Northern Territory red-earth outback with spinifex plains, a straight cattle-station track, a distant road train and low generic escarpments, with no sacred sites or recognisable rock formations",
  },
  {
    id: "act",
    name: "Australian Capital Territory",
    subject:
      "the Australian Capital Territory lake and civic axis seen across calm water, with formal tree-lined lawns, low modern civic buildings, a clean geometric avenue and wooded hills beyond",
  },
];

export const ARCHETYPE_IDS = ARCHETYPES.map(({ id }) => id);
