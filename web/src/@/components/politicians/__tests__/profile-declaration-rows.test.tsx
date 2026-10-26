/**
 * A declared property links its suburb by the suburb's canonical path.
 *
 * The real-estate row built `/housing/<state>/<slug>?sal=<code>`. The suburb
 * page resolves the SAL from the path and ignores a query, and every other
 * suburb link (suburbHref) and the housing sitemap use the bare path, so the
 * `?sal=` form was one more URL for the same page on every profile that
 * declares a property.
 */
import { create } from "@bufbuild/protobuf";
import { render } from "@testing-library/react";

import { suburbHref } from "@/lib/housing/states";
import {
  DeclaredInterestSchema,
  RegisterHolder,
} from "~/gen/shorts/v1alpha1/politicians_pb";

import { buildDeclarationRows } from "../profile/declaration-rows";

function propertyRow(fields: {
  salCode: string;
  suburbName: string;
  propertyState: string;
}) {
  const [row] = buildDeclarationRows([
    create(DeclaredInterestSchema, {
      itemNo: 3,
      itemLabel: "Real estate",
      holder: RegisterHolder.SELF,
      declaredText: "Residential property, Ascot VIC",
      ...fields,
    }),
  ]);
  const { container } = render(<>{row!.entity}</>);
  return container;
}

describe("declared property suburb link", () => {
  it("links the suburb's canonical path, with no ?sal= query", () => {
    const container = propertyRow({
      salCode: "20085",
      suburbName: "Ascot (Ballarat - Vic.)",
      propertyState: "VIC",
    });
    const href = container.querySelector("a")?.getAttribute("href");

    expect(href).toBe("/housing/vic/ascot-ballarat-vic");
    expect(href).toBe(
      suburbHref("VIC", { salName: "Ascot (Ballarat - Vic.)", postcode: "" }),
    );
    expect(href).not.toContain("?");
  });

  it("links nothing when the declaration was not resolved to a suburb", () => {
    const container = propertyRow({ salCode: "", suburbName: "", propertyState: "" });

    expect(container.querySelector('a[href^="/housing/"]')).toBeNull();
    expect(container.textContent).toContain("Residential property, Ascot VIC");
  });
});
