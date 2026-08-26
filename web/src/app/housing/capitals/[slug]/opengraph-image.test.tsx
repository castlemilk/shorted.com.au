import { render, screen } from "@testing-library/react";

const getOgLogo = jest.fn(async () => "data:image/png;base64,logo");

jest.mock("next/og", () => ({
  ImageResponse: class MockImageResponse {
    element: React.ReactElement;

    constructor(element: React.ReactElement) {
      this.element = element;
    }
  },
}));
jest.mock("~/@/lib/og/card", () => ({
  OG_SIZE: { width: 1200, height: 630 },
  OG_CONTENT_TYPE: "image/png",
  getOgLogo: () => getOgLogo(),
  OgCard: ({
    eyebrow,
    title,
    subtitle,
  }: {
    eyebrow: string;
    title: string;
    subtitle: string;
  }) => (
    <div>
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  ),
}));

import Image from "./opengraph-image";
import { getCapital } from "~/@/lib/housing/capitals";

describe("capital detail Open Graph image", () => {
  it("uses only the serializable capital registry", async () => {
    const capital = getCapital("greater-brisbane")!;
    const response = (await Image({
      params: Promise.resolve({ slug: capital.slug }),
    })) as unknown as { element: React.ReactElement };

    render(response.element);
    expect(
      screen.getByRole("heading", { name: capital.h1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(capital.dek)).toBeInTheDocument();
    expect(getOgLogo).toHaveBeenCalledTimes(1);
  });
});
