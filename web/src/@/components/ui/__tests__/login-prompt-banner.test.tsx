import { fireEvent, render, screen } from "@testing-library/react";

// The shared jest setup replaces the banner with a stub, and the icon package
// with div stand-ins. This suite is about the real banner; the stand-ins keep
// their class names, which is all the icons are asked about here.
jest.mock("~/@/components/ui/login-prompt-banner", () =>
  jest.requireActual("~/@/components/ui/login-prompt-banner"),
);
// The real SignIn is a form whose action is a server action, which React 18
// cannot render in jsdom (it warns about a function-valued `action`). The stand-in
// exposes the two props the banner is held to.
jest.mock("~/@/components/ui/sign-in", () => ({
  SignIn: ({ size, variant }: { size?: string; variant?: string }) => (
    <form>
      <button type="submit" data-size={size} data-variant={variant}>
        Sign in
      </button>
    </form>
  ),
}));

import { LoginPromptBanner } from "../login-prompt-banner";

const SHORT_COPY = "Sign in for alerts and portfolios";
const LONG_COPY =
  "Sign in to unlock custom dashboards, portfolio tracking and real-time alerts";

// The banner's own box: the wrapper the page draws round it adds the border.
const banner = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe("LoginPromptBanner", () => {
  afterEach(() => {
    document.documentElement.classList.remove("anon");
  });

  // Critical CSS reserves one height for the slot (44px here, 46px with the
  // wrapper's border). A wrapping line, or a box that grew with its content,
  // would not fit the reservation at some width.
  it("is one 44px line at every width: a fixed-height flex row that cannot wrap", () => {
    const { container } = render(<LoginPromptBanner />);
    const box = banner(container);
    expect(box).toHaveClass("flex", "h-11", "items-center");
    expect(box).not.toHaveClass("flex-wrap");
    // The old banner stacked its copy and its buttons with vertical padding.
    expect(box.className).not.toMatch(/\bpy-/);
    // No border of its own: the page's wrapper draws the 1px frame, and a
    // second one would take 1px of the 44.
    expect(box.className).not.toMatch(/\bborder/);
  });

  it("carries the short copy below sm and the long copy from sm", () => {
    render(<LoginPromptBanner />);
    const short = screen.getByText(SHORT_COPY);
    const long = screen.getByText(LONG_COPY);
    expect(short).toHaveClass("sm:hidden");
    expect(short).not.toHaveClass("hidden");
    expect(long).toHaveClass("hidden", "sm:inline");
  });

  it("truncates the copy rather than wrapping it, in a box that may shrink", () => {
    render(<LoginPromptBanner />);
    const line = screen.getByText(SHORT_COPY).parentElement as HTMLElement;
    expect(line).toHaveClass("min-w-0", "flex-1", "truncate", "text-sm");
  });

  it("draws a 16px icon, and keeps it from being squeezed by the copy", () => {
    const { container } = render(<LoginPromptBanner />);
    const icon = container.querySelector(".sparkles");
    expect(icon).toHaveClass("h-4", "w-4", "shrink-0");
  });

  it("keeps the small ghost sign in button and a 32px dismiss target together at the right", () => {
    render(<LoginPromptBanner />);
    const signIn = screen.getByRole("button", { name: "Sign in" });
    const close = screen.getByRole("button", { name: "Close" });
    expect(signIn).toHaveAttribute("data-size", "sm");
    expect(signIn).toHaveAttribute("data-variant", "ghost");
    expect(close).toHaveClass("h-8", "w-8", "p-0");
    // One group, which does not shrink: the copy is what gives way.
    expect(signIn.closest("form")?.parentElement).toBe(close.parentElement);
    expect(close.parentElement).toHaveClass("shrink-0");
  });

  it("removes itself and the slot's reservation when dismissed", () => {
    document.documentElement.classList.add("anon");
    const { container } = render(<LoginPromptBanner />);
    expect(document.documentElement).toHaveClass("anon");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(container).toBeEmptyDOMElement();
    expect(document.documentElement).not.toHaveClass("anon");
  });
});
