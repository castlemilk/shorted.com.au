import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "../conversation";

jest.mock("lucide-react", () => ({
  ArrowDown: ({ className }: { className?: string }) => (
    <svg className={className} aria-hidden="true" />
  ),
}));

/**
 * jsdom has no layout, so the scroller's geometry is set by hand. The content
 * ResizeObserver is replaced with one whose callbacks the test fires, which is
 * how a streaming reply growing is simulated.
 */
let resizeCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalResizeObserver = global.ResizeObserver;

beforeEach(() => {
  resizeCallbacks = [];
  global.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  global.ResizeObserver = originalResizeObserver;
});

function setGeometry(
  element: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: geometry.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: geometry.clientHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: geometry.scrollTop,
  });
}

function renderThread() {
  render(
    <Conversation>
      <ConversationContent>
        <p>Latest reply</p>
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>,
  );
  return screen.getByRole("log");
}

function growContent(log: HTMLElement, scrollHeight: number) {
  setGeometry(log, {
    scrollHeight,
    clientHeight: Number(log.clientHeight),
    scrollTop: log.scrollTop,
  });
  act(() => {
    resizeCallbacks.forEach((callback) => callback());
  });
}

describe("Conversation stick-to-bottom", () => {
  it("follows new content while the reader is at the live edge", () => {
    const log = renderThread();
    setGeometry(log, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });

    growContent(log, 1500);

    expect(log.scrollTop).toBe(1500);
  });

  it("stops following when the reader scrolls up, and offers jump to latest", () => {
    const log = renderThread();
    setGeometry(log, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(log);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).not.toBeInTheDocument();

    log.scrollTop = 100;
    fireEvent.scroll(log);

    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();

    growContent(log, 1500);

    expect(log.scrollTop).toBe(100);
  });

  it("stops following on a few pixels of scroll up, and a streamed line does not pull the reader back", () => {
    // A trackpad's first frames are a few pixels, well inside the live-edge band.
    const log = renderThread();
    setGeometry(log, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(log);

    log.scrollTop = 595;
    fireEvent.scroll(log);

    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();
    growContent(log, 1100);
    expect(log.scrollTop).toBe(595);
  });

  it("jump to latest returns to the live edge and follows again", () => {
    const log = renderThread();
    setGeometry(log, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));

    expect(log.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).not.toBeInTheDocument();

    growContent(log, 1600);
    expect(log.scrollTop).toBe(1600);
  });

  it("keeps the jump button mounted and moves focus to the log when it is used", () => {
    const log = renderThread();
    setGeometry(log, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);

    const button = screen.getByRole("button", { name: "Jump to latest message" });
    button.focus();
    fireEvent.click(button);

    // Hidden, not removed: the focused control is no longer the one under focus.
    const hidden = document.querySelector('button[aria-label="Jump to latest message"]');
    expect(hidden).not.toBeNull();
    expect(hidden).toHaveAttribute("aria-hidden", "true");
    expect(hidden).toHaveAttribute("tabindex", "-1");
    expect(log).toHaveFocus();
  });

  it("re-engages when the reader returns to the bottom by hand", () => {
    const log = renderThread();
    setGeometry(log, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);

    log.scrollTop = 600;
    fireEvent.scroll(log);

    expect(screen.queryByRole("button", { name: "Jump to latest message" })).not.toBeInTheDocument();
    growContent(log, 1500);
    expect(log.scrollTop).toBe(1500);
  });

  it("does not disengage when the browser clamps scrollTop after content shrinks", () => {
    const log = renderThread();
    setGeometry(log, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(log);

    // Content shrank to 700 and the browser clamped the position to its new
    // bottom: that is still the live edge, so the reader keeps following.
    setGeometry(log, { scrollHeight: 700, clientHeight: 400, scrollTop: 300 });
    fireEvent.scroll(log);

    expect(screen.queryByRole("button", { name: "Jump to latest message" })).not.toBeInTheDocument();
  });

  it("lets the content grow past the scroller instead of shrinking to it", () => {
    // A flex item shrinks to its container unless it cannot. jsdom has no
    // layout, so the class is the thing to pin: min-h-full alone let the
    // content shrink, and the newest message then sat below the fold.
    const log = renderThread();
    const content = log.firstElementChild as HTMLElement;

    expect(content.className).toMatch(/\bshrink-0\b/);
    expect(content.className).toMatch(/\bmin-h-full\b/);
  });

  it("is a live log that the thread can mark busy", () => {
    render(
      <Conversation>
        <ConversationContent aria-busy="true">
          <p>Streaming</p>
        </ConversationContent>
      </Conversation>,
    );

    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAttribute("aria-busy", "true");
  });

  it("throws when a part is rendered outside a Conversation", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ConversationContent>x</ConversationContent>)).toThrow(
      /inside <Conversation>/,
    );
    consoleError.mockRestore();
  });
});
