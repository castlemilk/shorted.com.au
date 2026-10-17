import { decodeCategoricalColumn } from "./suburb-columns";

describe("categorical column decoding", () => {
  const codes = ["10001", "10002", "10003", "10004", "10005"];
  const labels = ["Low-density residential", "Centres & mixed use", "Rural"];

  test("indexes into the server's label dictionary; NULL stays null", () => {
    // row 1 NULL (bit 1)
    const decoded = decodeCategoricalColumn(codes, [0, 0, 2, 1, 0], new Uint8Array([0b00000010]), labels);
    expect(decoded.get("10001")).toBe("Low-density residential");
    expect(decoded.get("10002")).toBeNull();
    expect(decoded.get("10003")).toBe("Rural");
    expect(decoded.get("10004")).toBe("Centres & mixed use");
  });

  test("an out-of-range or fractional index is no data, never a neighbouring category", () => {
    const decoded = decodeCategoricalColumn(codes, [3, -1, 1.5, 7, 2], new Uint8Array([0]), labels);
    expect(decoded.get("10001")).toBeNull();
    expect(decoded.get("10002")).toBeNull();
    expect(decoded.get("10003")).toBeNull();
    expect(decoded.get("10004")).toBeNull();
    expect(decoded.get("10005")).toBe("Rural");
  });

  test("a length mismatch is refused, as for numeric columns", () => {
    expect(() => decodeCategoricalColumn(codes, [0, 1], new Uint8Array([0]), labels)).toThrow();
  });
});
