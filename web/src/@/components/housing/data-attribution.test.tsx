import { render, screen } from "@testing-library/react";
import { DataAttribution } from "./data-attribution";

test("renders the required OSM + ABS attributions", () => {
  render(<DataAttribution />);
  expect(screen.getByText(/OpenStreetMap contributors/i)).toBeInTheDocument();
  expect(screen.getByText(/Australian Bureau of Statistics/i)).toBeInTheDocument();
  // OSM credit must link to the copyright page (ODbL requirement).
  const osm = screen.getByRole("link", { name: /OpenStreetMap/i });
  expect(osm).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
});
