import { render, screen } from "@testing-library/react";

import { StateBanner } from "../state-banner";

jest.mock(
  "../state-banner-map-loader",
  () => ({
    StateBannerMap: ({ state, name }: { state: string; name: string }) => (
      <div
        data-testid="state-banner-map"
        data-state={state}
        aria-label={`${name} silhouette`}
      />
    ),
  }),
  { virtual: true },
);

describe("StateBanner", () => {
  it("renders the themed manifest assets and state content around the silhouette", () => {
    const { container } = render(
      <StateBanner
        state="nsw"
        name="New South Wales"
        subtitle="Labour, demand, trade and petroleum."
      />,
    );

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "New South Wales economy",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Labour, demand, trade and petroleum."),
    ).toBeInTheDocument();
    expect(
      container.querySelector('img[src="/economy-banners/bg/nsw.light.avif"]'),
    ).toHaveClass("dark:hidden");
    expect(
      container.querySelector('img[src="/economy-banners/bg/nsw.dark.avif"]'),
    ).toHaveClass("dark:block");
    expect(screen.getByTestId("state-banner-map")).toHaveAttribute(
      "data-state",
      "nsw",
    );
    expect(
      screen.getByLabelText("New South Wales silhouette"),
    ).toBeInTheDocument();
  });
});
