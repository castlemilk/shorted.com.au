import { decodeColumn, decodeMatchMask, isNullAt } from "./suburb-columns";

describe("suburb column decoding", () => {
  const codes = ["10001", "10002", "10003", "10004", "10005", "10006", "10007", "10008", "10009"];

  test("null mask is LSB-first and a set bit means NULL, so a real zero survives", () => {
    // bits 1 and 8 set → byte0 = 0b00000010, byte1 = 0b00000001
    const mask = new Uint8Array([0b00000010, 0b00000001]);
    const values = [0, 99, 2, 3, 4, 5, 6, 7, 99];
    const decoded = decodeColumn(codes, values, mask);
    expect(decoded.get("10001")).toBe(0);
    expect(decoded.get("10002")).toBeNull();
    expect(decoded.get("10009")).toBeNull();
    expect(decoded.get("10008")).toBe(7);
  });

  test("a short mask reads as no NULLs past its end", () => {
    expect(isNullAt(new Uint8Array([]), 0)).toBe(false);
    expect(isNullAt(new Uint8Array([0xff]), 8)).toBe(false);
    expect(isNullAt(new Uint8Array([0xff]), 7)).toBe(true);
  });

  test("a column whose length disagrees with the index is refused, not misaligned", () => {
    expect(() => decodeColumn(codes, [1, 2], new Uint8Array([0]))).toThrow(/9 suburbs/);
  });

  test("match masks use the same bit order with 1 = match", () => {
    const matches = decodeMatchMask(codes, new Uint8Array([0b10000001, 0b00000001]));
    expect([...matches]).toEqual(["10001", "10008", "10009"]);
  });
});
