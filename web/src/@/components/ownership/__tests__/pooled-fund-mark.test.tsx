import { render, screen } from "@testing-library/react";
import { POOLED_MARK_SR, PooledFundMark } from "../pooled-fund-mark";

describe("PooledFundMark", () => {
  it("is a letter whose meaning a screen reader hears, and carries no colour", () => {
    const { container } = render(<PooledFundMark />);
    expect(screen.getByText(POOLED_MARK_SR)).toHaveClass("sr-only");
    expect(container.textContent).toBe(`P${POOLED_MARK_SR}`);
    expect(container.innerHTML).not.toMatch(/red|green/);
  });
});
