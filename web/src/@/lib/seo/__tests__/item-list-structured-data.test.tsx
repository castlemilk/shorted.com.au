import { render } from "@testing-library/react";

import { ItemListStructuredData } from "~/@/components/seo/enhanced-structured-data";

describe("ItemListStructuredData", () => {
  it("uses the requested schema type for non-financial lists", () => {
    const { container } = render(
      <ItemListStructuredData
        name="Cheapest Suburbs in New South Wales"
        itemType="Place"
        items={[
          {
            name: "Alpha",
            url: "https://shorted.com.au/housing/nsw/alpha-2000",
          },
        ]}
      />,
    );

    const script = container.querySelector(
      'script[type="application/ld+json"]',
    );
    const schema = JSON.parse(script?.textContent ?? "{}") as {
      itemListElement?: Array<{ item?: { "@type"?: string } }>;
    };
    expect(schema.itemListElement?.[0]?.item?.["@type"]).toBe("Place");
  });
});
