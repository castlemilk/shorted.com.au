import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { RichToolBoundary } from "../chat-tool-boundary";

/** A rich view that fails the way a formatter on an unplanned input would. */
function Broken(): ReactNode {
  throw new Error("formatter failed");
}

describe("RichToolBoundary", () => {
  it("draws its children when they render", () => {
    render(
      <RichToolBoundary fallback={<p>Raw result</p>}>
        <p>Rich result</p>
      </RichToolBoundary>,
    );
    expect(screen.getByText("Rich result")).toBeInTheDocument();
    expect(screen.queryByText("Raw result")).not.toBeInTheDocument();
  });

  it("draws the fallback when a child throws, and does not rethrow", () => {
    // React logs a caught error; the test silences that log and checks only the outcome.
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <RichToolBoundary fallback={<p>Raw result</p>}>
          <Broken />
        </RichToolBoundary>,
      );
      expect(screen.getByText("Raw result")).toBeInTheDocument();
    } finally {
      log.mockRestore();
    }
  });
});
