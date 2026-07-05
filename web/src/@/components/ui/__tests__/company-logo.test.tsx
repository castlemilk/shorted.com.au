import { render, screen } from "@testing-library/react";
import { CompanyLogo } from "../company-logo";

const imageProps: Array<Record<string, unknown>> = [];

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    imageProps.push(props);
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} alt={String(props.alt)} />;
  },
}));

describe("CompanyLogo", () => {
  beforeEach(() => {
    imageProps.length = 0;
  });

  it("does not force a preload for reusable company logos", () => {
    render(<CompanyLogo stockCode="LOT" companyName="Lotus Resources" />);

    expect(screen.getByAltText("Lotus Resources logo")).toBeInTheDocument();
    expect(imageProps[0]).toMatchObject({
      src: expect.stringContaining("/logos-normalized/LOT.png"),
      width: 70,
      height: 70,
    });
    expect(imageProps[0]).not.toHaveProperty("priority");
  });
});
