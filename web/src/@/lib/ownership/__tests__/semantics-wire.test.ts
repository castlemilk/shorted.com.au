import { readFileSync } from "node:fs";
import path from "node:path";
import { fromBinary, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { OwnershipSemanticInputSchema } from "~/gen/shorts/v1alpha1/ownership_semantics_pb";

// The shared Jest setup substitutes the protobuf runtime for UI unit tests.
// Interchange verification must exercise the actual generated codec.
jest.unmock("@bufbuild/protobuf");

// The Go domain/wire tests read these same captured synthetic observations.
// The values intentionally exceed JS integer and floating-point precision.
const fixture = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../../../../services/pkg/ownershipsemantics/testdata/wire_roundtrip.json",
    ),
    "utf8",
  ),
) as JsonValue;

describe("ownership semantic interchange", () => {
  it("retains exact observations, separate statuses and source lineage in the TypeScript client", () => {
    const initial = fromJson(OwnershipSemanticInputSchema, fixture);
    const decoded = fromBinary(
      OwnershipSemanticInputSchema,
      toBinary(OwnershipSemanticInputSchema, initial),
    );

    expect(decoded).toEqual(initial);
    const measure = (code: string) =>
      decoded.measurements.find(
        (value) => value.measure === code && value.period === "present",
      )!;
    expect(measure("A").percent?.value).toBe("5.500000000000000001");
    expect(measure("B").percent?.value).toBe("2.000000000000000001");
    expect(measure("B").votes?.value).toBe("9007199254740993");
    expect(measure("D").percent).toMatchObject({
      status: "reported",
      value: "0.0000",
    });
    expect(measure("E").percent).toMatchObject({
      status: "unknown",
      value: "",
    });
    expect(measure("G").percent?.value).toBe("2.25");
    expect(decoded.interests[0]?.legalBases).toEqual([
      "608(1)(a)",
      "608(3)(b)",
    ]);
    expect(decoded.annexures[0]?.evidence[0]?.sourceSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(decoded.announcedOn).toBe("2026-12-08");
    expect(decoded.publishedAt).toBe("");
    expect(decoded.publicationEligible).toBe(false);
  });
});
