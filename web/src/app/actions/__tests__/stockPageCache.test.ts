/// <reference types="jest" />
import { toNextDataCacheValue } from "../stockPageCache";

describe("stock page cache helpers", () => {
  it("returns JSON-serializable values for protobuf-shaped stock data", () => {
    const value = toNextDataCacheValue({
      productCode: "LOT",
      points: [
        {
          timestamp: { seconds: BigInt(1_700_000_000), nanos: 0 },
          shortPosition: 12.34,
        },
      ],
      nested: {
        employeeCount: BigInt(1234),
      },
    });

    expect(JSON.stringify(value)).toContain('"productCode":"LOT"');
    expect(value.points[0].timestamp.seconds).toBe(1_700_000_000);
    expect(value.nested.employeeCount).toBe(1234);
  });
});
