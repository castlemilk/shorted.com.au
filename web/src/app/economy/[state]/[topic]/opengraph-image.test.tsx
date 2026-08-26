import { render, screen } from "@testing-library/react";

const getOgLogo = jest.fn(async () => "data:image/png;base64,logo");

jest.mock("next/og", () => ({
  ImageResponse: class MockImageResponse {
    element: React.ReactElement;
    options: unknown;

    constructor(element: React.ReactElement, options: unknown) {
      this.element = element;
      this.options = options;
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
import { ECONOMY_TOPICS, economyTopicCopyForState } from "~/@/lib/economy/topics";

describe("economy topic Open Graph image", () => {
  it("uses registry copy without loading route data", async () => {
    const response = (await Image({
      params: Promise.resolve({ state: "wa", topic: "wages" }),
    })) as unknown as { element: React.ReactElement };
    const copy = economyTopicCopyForState(ECONOMY_TOPICS.wages, "wa");

    render(response.element);
    expect(
      screen.getByRole("heading", { name: copy.h1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(copy.description)).toBeInTheDocument();
    expect(getOgLogo).toHaveBeenCalledTimes(1);
  });
});
