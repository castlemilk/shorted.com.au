import { render } from "@testing-library/react";
import { EconomyIcon } from "../economy-icon";
import { ECONOMY_ICONS } from "../economy-icons.generated";

// The 24 icon ids the pipeline generates + wires into the economy surface.
const EXPECTED_IDS = [
  // headers
  "cash-rate", "cpi", "unemployment", "participation", "aud-usd",
  "sfd", "exports", "imports", "trade-balance", "diesel", "refinery",
  "company-footprint", "short-interest", "state-finances",
  // SITC commodities
  "food", "beverages-tobacco", "crude-materials", "mineral-fuels", "oils-fats",
  "chemicals", "manufactured-goods", "machinery-transport", "misc-manufactures",
  "other-commodities",
] as const;

describe("economy icon manifest", () => {
  it("resolves every expected icon name to a sprite coordinate", () => {
    for (const id of EXPECTED_IDS) {
      expect(ECONOMY_ICONS.icons).toHaveProperty(id);
      const pos = ECONOMY_ICONS.icons[id as keyof typeof ECONOMY_ICONS.icons];
      expect(pos).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    }
  });

  it("exposes a versioned sprite sheet and coordinates within bounds", () => {
    expect(ECONOMY_ICONS.sheet).toMatch(/^\/economy-icons\/economy-icons\.png\?v=/);
    for (const pos of Object.values(ECONOMY_ICONS.icons)) {
      expect(pos.x).toBeLessThan(ECONOMY_ICONS.width);
      expect(pos.y).toBeLessThan(ECONOMY_ICONS.height);
    }
  });

  it("renders a decorative (aria-hidden) icon by default", () => {
    const { container } = render(<EconomyIcon name="exports" />);
    const span = container.querySelector("span");
    expect(span).not.toBeNull();
    expect(span).toHaveAttribute("aria-hidden", "true");
    expect(span!.style.backgroundImage).toContain("economy-icons.png");
  });

  it("renders an accessible label when a title is passed", () => {
    const { getByRole } = render(<EconomyIcon name="cpi" title="Consumer prices" />);
    expect(getByRole("img", { name: "Consumer prices" })).toBeInTheDocument();
  });
});
