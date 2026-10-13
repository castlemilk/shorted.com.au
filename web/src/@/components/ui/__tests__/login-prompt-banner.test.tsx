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

// The two lines, word for word. They are sized to the room the page gives them
// (login-prompt-banner.tsx says how): "Get alerts" is 84px of the 99px a 360px
// phone leaves, the long line 277px of the 363px at 640px. A longer line clips,
// so a change to either string is a change to be measured in a browser.
const SHORT_COPY = "Get alerts";
const LONG_COPY = "Dashboards, portfolios and alerts";

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

  // getByText matches a whole string, so the lookups above already fail on a
  // longer or shorter line; this pins the same thing from the line's side: the
  // two spans are all it holds, with nothing else in it (no icon label, no
  // separator) to eat into the room the copy was sized for.
  it("holds exactly the two lines, and nothing else, in its text", () => {
    render(<LoginPromptBanner />);
    const line = screen.getByText(SHORT_COPY).parentElement as HTMLElement;
    expect(Array.from(line.children).map((el) => el.textContent)).toEqual([
      SHORT_COPY,
      LONG_COPY,
    ]);
    expect(line.textContent).toBe(`${SHORT_COPY}${LONG_COPY}`);
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

  // The Overview draws a 1px frame round the banner (the bordered wrapper in
  // page.tsx, `empty:hidden`). A dismissed banner must leave that frame with no
  // child at all, not even a whitespace text node, or `:empty` does not match and
  // the frame stays as a 2px sliver of border above the grid.
  it("leaves the frame round it empty when dismissed, so an `empty:hidden` frame collapses", () => {
    const { getByTestId } = render(
      <div
        data-testid="frame"
        className="overflow-hidden rounded-lg border border-primary/20 empty:hidden"
      >
        <LoginPromptBanner />
      </div>,
    );
    const frame = getByTestId("frame");
    expect(frame.matches(":empty")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(frame.childNodes).toHaveLength(0);
    expect(frame.matches(":empty")).toBe(true);
    expect(frame).toHaveClass("empty:hidden");
  });
});
