import { MDX_COMPONENT_SCHEMAS, MDX_COMPONENT_NAMES } from "../manifest";
import { MDX_COMPONENTS } from "../registry";

test("registry and manifest agree on the palette", () => {
  expect(Object.keys(MDX_COMPONENTS).sort()).toEqual([...MDX_COMPONENT_NAMES].sort());
});

test("schemas reject bad props", () => {
  expect(MDX_COMPONENT_SCHEMAS.ShortInterestChart.safeParse({ code: "bhp!" }).success).toBe(false);
  expect(MDX_COMPONENT_SCHEMAS.Stat.safeParse({ label: "Short interest", value: "12.4%" }).success).toBe(true);
});

test("BankShortBasket schema validates basket props", () => {
  const s = MDX_COMPONENT_SCHEMAS.BankShortBasket;
  expect(s.safeParse({ banks: "CBA,WBC,NAB,ANZ", window: "1y", mode: "dollar" }).success).toBe(true);
  expect(s.safeParse({}).success).toBe(true); // all optional / defaulted
  expect(s.safeParse({ banks: "cba,wbc" }).success).toBe(false); // lowercase
  expect(s.safeParse({ window: "2y" }).success).toBe(false);
  expect(s.safeParse({ mode: "sideways" }).success).toBe(false);
});

test("ShortBasket schema validates sector props", () => {
  const s = MDX_COMPONENT_SCHEMAS.ShortBasket;
  expect(s.safeParse({ basket: "lithium", window: "1y", mode: "dollar" }).success).toBe(true);
  expect(s.safeParse({}).success).toBe(true); // all optional / defaulted
  expect(s.safeParse({ basket: "Banks" }).success).toBe(false); // uppercase
  expect(s.safeParse({ window: "2y" }).success).toBe(false);
});

test("MultiSeriesChart schema validates dataset", () => {
  const s = MDX_COMPONENT_SCHEMAS.MultiSeriesChart;
  expect(s.safeParse({ dataset: "hormuz-benchmarks" }).success).toBe(true);
  expect(s.safeParse({ dataset: "unknown" }).success).toBe(false);
  expect(s.safeParse({}).success).toBe(false);
});

test("BarChart schema validates dataset", () => {
  const s = MDX_COMPONENT_SCHEMAS.BarChart;
  expect(s.safeParse({ dataset: "hormuz-oil-dependency" }).success).toBe(true);
  expect(s.safeParse({ dataset: "hormuz-gdp-revision" }).success).toBe(true);
  expect(s.safeParse({ dataset: "unknown" }).success).toBe(false);
});

test("FlowChart schema validates dataset", () => {
  const s = MDX_COMPONENT_SCHEMAS.FlowChart;
  expect(s.safeParse({ dataset: "hormuz-oil-flows" }).success).toBe(true);
  expect(s.safeParse({ dataset: "unknown" }).success).toBe(false);
});
