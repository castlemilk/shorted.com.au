import { RoadmapFeatureList } from "./roadmap-feature-list";
import { RoadmapTree } from "./roadmap-tree";

// A server component, so the list below the tree is in the HTML. The page
// was "use client" whole, which left every feature description in the JS
// bundle and a hover tooltip.
export default function RoadmapPage() {
  return (
    <>
      <RoadmapTree />
      <RoadmapFeatureList />
    </>
  );
}
