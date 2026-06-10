import { MDX_COMPONENT_SCHEMAS, MDX_COMPONENT_NAMES } from "../manifest";
import { MDX_COMPONENTS } from "../registry";

test("registry and manifest agree on the palette", () => {
  expect(Object.keys(MDX_COMPONENTS).sort()).toEqual([...MDX_COMPONENT_NAMES].sort());
});

test("schemas reject bad props", () => {
  expect(MDX_COMPONENT_SCHEMAS.ShortInterestChart.safeParse({ code: "bhp!" }).success).toBe(false);
  expect(MDX_COMPONENT_SCHEMAS.Stat.safeParse({ label: "Short interest", value: "12.4%" }).success).toBe(true);
});
