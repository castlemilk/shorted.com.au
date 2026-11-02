import { render, screen } from "@testing-library/react";
import { ChatSidebar } from "../chat-sidebar";
import { useSubscription } from "~/@/hooks/use-subscription";

const mockPathname = { value: "/" };
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname.value,
}));

// The full chat is a lazy chunk. The launcher's own button is what these tests check.
jest.mock("next/dynamic", () => () => () => null);

jest.mock("~/@/hooks/use-subscription", () => ({
  useSubscription: jest.fn(() => ({ isPremium: true })),
}));

function renderAt(pathname: string) {
  mockPathname.value = pathname;
  return render(<ChatSidebar />);
}

beforeEach(() => {
  jest.mocked(useSubscription).mockClear();
});

describe("ChatSidebar on the site", () => {
  it("offers the chat launcher to a subscriber, and looks the subscription up", () => {
    renderAt("/");
    expect(
      screen.getByRole("button", { name: "Open Shorted AI chat" }),
    ).toBeInTheDocument();
    expect(useSubscription).toHaveBeenCalled();
  });
});

// The launcher is a fixed button in the bottom corner, which would sit over a chart or an
// Activity's frame. Chrome-less routes own the viewport, so it is not rendered there.
describe("ChatSidebar on chrome-less routes", () => {
  it.each(["/embed/discord", "/embed/chart", "/chart/CBA", "/oauth/authorize"])(
    "renders nothing and looks up no subscription on %s",
    (path) => {
      const { container } = renderAt(path);
      expect(container).toBeEmptyDOMElement();
      expect(useSubscription).not.toHaveBeenCalled();
    },
  );
});
