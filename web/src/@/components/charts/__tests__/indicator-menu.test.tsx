import { createRef, useRef } from "react";
import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Dialog from "@radix-ui/react-dialog";
import { useSession } from "next-auth/react";
import {
  IndicatorMenuPanel,
  useIndicatorAccess,
  useIndicatorMenu,
  type IndicatorMenuPanelProps,
} from "../indicator-menu";
import { menuIndicators, type IndicatorAccess } from "../chart-indicators";

/** The menu beside a trigger, as the chart renders it: the trigger is what the outside press must not close. */
function setup(overrides: Partial<IndicatorMenuPanelProps> = {}) {
  const triggerRef = createRef<HTMLButtonElement>();
  const props: IndicatorMenuPanelProps = {
    id: "menu",
    items: menuIndicators("price"),
    selected: [],
    onToggle: jest.fn(),
    access: "signed-in",
    signIn: { callbackUrl: "/shorts/BHP" },
    onClose: jest.fn(),
    triggerRef,
    ...overrides,
  };
  const utils = render(
    <>
      <button ref={triggerRef} type="button">
        Indicators
      </button>
      <IndicatorMenuPanel {...props} />
    </>,
  );
  return { ...utils, props, triggerRef };
}

describe("IndicatorMenuPanel", () => {
  it("makes every item a toggle for a signed-in visitor, and reports the one pressed", () => {
    const { props } = setup({ access: "signed-in" });
    const sma200 = screen.getByRole("button", { name: "SMA 200" });
    expect(sma200).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(sma200);
    expect(props.onToggle).toHaveBeenCalledWith("sma200");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("locks the advanced indicators for a signed-out visitor, behind a sign-in link", () => {
    setup({ access: "signed-out", signIn: { callbackUrl: "/shorts/BHP" } });
    expect(screen.getByRole("button", { name: "SMA 20" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "SMA 200" })).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in to unlock" })).toHaveAttribute(
      "href",
      "/signin?callbackUrl=%2Fshorts%2FBHP",
    );
  });

  it("offers a button, and no link, when sign-in opens outside the page", () => {
    const onClick = jest.fn();
    const { container } = setup({ access: "signed-out", signIn: { onClick } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in on Shorted" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("shows a sign-in whose link is on its way out as busy, with a spinner, and takes no second press", () => {
    const onClick = jest.fn();
    setup({ access: "signed-out", signIn: { onClick, busy: true } });
    const signIn = screen.getByRole("button", { name: "Sign in on Shorted" });
    expect(signIn).toHaveAttribute("aria-busy", "true");
    expect(signIn.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(signIn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("says it is checking the sign-in, with no sign-in button, while the session loads", () => {
    setup({ access: "checking" });
    expect(screen.getByText("Checking sign-in…")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in to unlock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in on Shorted" })).toBeNull();
  });

  it("closes on Escape from inside the menu, and marks the key handled", () => {
    const { props } = setup();
    // The first toggle has the focus when the menu opens.
    const inside = screen.getByRole("button", { name: "SMA 20" });
    expect(inside).toHaveFocus();
    const event = createEvent.keyDown(inside, { key: "Escape" });
    fireEvent(inside, event);
    expect(props.onClose).toHaveBeenCalledWith(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("closes on a press outside, but not on the trigger, whose click would reopen it", () => {
    const { props, triggerRef } = setup();
    fireEvent.pointerDown(document.body);
    expect(props.onClose).toHaveBeenLastCalledWith(false);

    jest.mocked(props.onClose).mockClear();
    fireEvent.pointerDown(triggerRef.current!);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("does nothing for a panel indicator the chart is too short for", () => {
    const { props } = setup({ panelUnavailable: true });
    const rsi = screen.getByRole("button", { name: /RSI 14/ });
    expect(rsi).toHaveAttribute("aria-disabled", "true");
    expect(rsi).toHaveTextContent("Needs a taller chart");
    fireEvent.click(rsi);
    expect(props.onToggle).not.toHaveBeenCalled();
  });
});

const noop = () => undefined;

/** The menu with its real open state and focus handling, as the stock page renders it. */
function MenuHarness() {
  const menu = useIndicatorMenu();
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        Indicators
      </button>
      {menu.open && (
        <IndicatorMenuPanel
          id={menu.id}
          items={menuIndicators("price")}
          selected={[]}
          onToggle={noop}
          access="signed-in"
          signIn={{ callbackUrl: "/" }}
          onClose={menu.close}
          triggerRef={menu.triggerRef}
        />
      )}
    </>
  );
}

/** The Share dialog as the page opens it over the menu. */
function DialogPage({
  dialogOpen,
  onDialogChange,
  onMenuClose,
}: {
  dialogOpen: boolean;
  onDialogChange: (open: boolean) => void;
  onMenuClose: (returnFocus: boolean) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button">
        Indicators
      </button>
      <IndicatorMenuPanel
        id="menu"
        items={menuIndicators("price")}
        selected={[]}
        onToggle={noop}
        access="signed-in"
        signIn={{ callbackUrl: "/" }}
        onClose={onMenuClose}
        triggerRef={triggerRef}
      />
      <Dialog.Root open={dialogOpen} onOpenChange={onDialogChange}>
        <Dialog.Portal>
          <Dialog.Content aria-describedby={undefined}>
            <Dialog.Title>Share</Dialog.Title>
            <button type="button">Copy link</button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

describe("IndicatorMenuPanel: Escape and focus", () => {
  it("leaves an Escape from elsewhere on the page to that element", () => {
    const onClose = jest.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <>
        <button type="button">Elsewhere</button>
        <button ref={triggerRef} type="button">
          Indicators
        </button>
        <IndicatorMenuPanel
          id="menu"
          items={menuIndicators("price")}
          selected={[]}
          onToggle={noop}
          access="signed-in"
          signIn={{ callbackUrl: "/" }}
          onClose={onClose}
          triggerRef={triggerRef}
        />
      </>,
    );
    // Dispatched where the page would send it, with the menu's focus left alone.
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    const event = createEvent.keyDown(elsewhere, { key: "Escape" });
    fireEvent(elsewhere, event);
    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("lets Escape close a dialog opened over the open menu, and keeps the menu out of it", () => {
    const onDialogChange = jest.fn();
    const onMenuClose = jest.fn();
    const { rerender } = render(
      <DialogPage dialogOpen={false} onDialogChange={onDialogChange} onMenuClose={onMenuClose} />,
    );
    rerender(
      <DialogPage dialogOpen onDialogChange={onDialogChange} onMenuClose={onMenuClose} />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Copy link" }), { key: "Escape" });
    // The menu may close behind the dialog (focus left it), but it never takes the Escape.
    expect(onMenuClose).not.toHaveBeenCalledWith(true);
    expect(onDialogChange).toHaveBeenCalledWith(false);
  });

  it("returns focus to the trigger when Escape closes the menu from inside it", () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Indicators" }));
    const inside = screen.getByRole("button", { name: "SMA 20" });
    expect(inside).toHaveFocus();
    fireEvent.keyDown(inside, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Chart indicators" })).toBeNull();
    expect(screen.getByRole("button", { name: "Indicators" })).toHaveFocus();
  });

  it("closes when focus leaves both the menu and its trigger, and moves no focus", () => {
    const onClose = jest.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <>
        <button type="button">Elsewhere</button>
        <button ref={triggerRef} type="button">
          Indicators
        </button>
        <IndicatorMenuPanel
          id="menu"
          items={menuIndicators("price")}
          selected={[]}
          onToggle={noop}
          access="signed-in"
          signIn={{ callbackUrl: "/" }}
          onClose={onClose}
          triggerRef={triggerRef}
        />
      </>,
    );
    const toggle = screen.getByRole("button", { name: "SMA 20" });
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    fireEvent.focusOut(toggle, { relatedTarget: elsewhere });
    expect(onClose).toHaveBeenCalledWith(false);
    expect(triggerRef.current).not.toHaveFocus();
  });

  it("stays open while focus moves between the menu and its trigger", () => {
    const onClose = jest.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={triggerRef} type="button">
          Indicators
        </button>
        <IndicatorMenuPanel
          id="menu"
          items={menuIndicators("price")}
          selected={[]}
          onToggle={noop}
          access="signed-in"
          signIn={{ callbackUrl: "/" }}
          onClose={onClose}
          triggerRef={triggerRef}
        />
      </>,
    );
    const toggle = screen.getByRole("button", { name: "SMA 20" });
    fireEvent.focusOut(toggle, { relatedTarget: triggerRef.current });
    expect(onClose).not.toHaveBeenCalled();
  });

  // Focus that goes nowhere is not a reason to close: a press on a button WebKit does
  // not focus blurs the toggle with nothing to move to, while the window still has
  // focus, and the press's click has yet to land. Only a move to a real element
  // outside the menu and its trigger closes it (the test below).
  it.each([
    ["the window losing focus", false],
    ["a press that blurs the focused toggle, in a window that has focus", true],
  ])("keeps the menu open when focus goes nowhere: %s", (_case, windowHasFocus) => {
    const onClose = jest.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={triggerRef} type="button">
          Indicators
        </button>
        <IndicatorMenuPanel
          id="menu"
          items={menuIndicators("price")}
          selected={[]}
          onToggle={noop}
          access="signed-in"
          signIn={{ callbackUrl: "/" }}
          onClose={onClose}
          triggerRef={triggerRef}
        />
      </>,
    );
    const hasFocus = jest.spyOn(document, "hasFocus").mockReturnValue(windowHasFocus);
    fireEvent.focusOut(screen.getByRole("button", { name: "SMA 20" }), { relatedTarget: null });
    expect(onClose).not.toHaveBeenCalled();
    hasFocus.mockRestore();
  });

  it("says a base indicator the series is too short for has no history, and leaves the others alone", () => {
    render(
      <IndicatorMenuPanel
        id="menu"
        items={menuIndicators("price")}
        selected={["sma20", "sma50"]}
        noHistory={["sma50"]}
        onToggle={noop}
        access="signed-in"
        signIn={{ callbackUrl: "/" }}
        onClose={noop}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );
    expect(screen.getByRole("button", { name: /SMA 50/ })).toHaveTextContent("Not enough history");
    expect(screen.getByRole("button", { name: "SMA 20" })).not.toHaveTextContent("Not enough history");
  });
});

/** The menu over a trigger, the open state and focus as the stock page drives them. */
function renderMenu(onClose: jest.Mock, onToggle: jest.Mock = jest.fn()) {
  const triggerRef = createRef<HTMLButtonElement>();
  render(
    <>
      <button ref={triggerRef} type="button">
        Indicators
      </button>
      <button type="button">Elsewhere</button>
      <IndicatorMenuPanel
        id="menu"
        items={menuIndicators("combined")}
        selected={[]}
        onToggle={onToggle}
        access="signed-out"
        signIn={{ onClick: noop }}
        onClose={onClose}
        triggerRef={triggerRef}
      />
    </>,
  );
}

// What a press does in a browser: a press on content that cannot take focus leaves the
// focus in the menu (its container takes it), and a press on a toggle takes the focus to
// the toggle. The click that follows is what the reader meant.
describe("IndicatorMenuPanel: presses inside the menu", () => {
  // The reader is in a window that has focus, as a tap in it is.
  let hasFocus: jest.SpyInstance;
  beforeEach(() => {
    hasFocus = jest.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  afterEach(() => hasFocus.mockRestore());

  it("keeps the menu open when a press blurs the focused toggle and focus goes nowhere", () => {
    const onClose = jest.fn();
    renderMenu(onClose);
    const first = screen.getByRole("button", { name: "SMA 20" });
    expect(first).toHaveFocus();
    fireEvent.focusOut(first, { relatedTarget: null });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the menu open on a press on a locked row or a heading", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    renderMenu(onClose);
    await user.click(screen.getByText("SMA 200"));
    await user.click(screen.getByText("Advanced", { exact: true }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Chart indicators" })).toBeInTheDocument();
  });

  it("keeps the focus inside the menu when a press lands on content that cannot take it", async () => {
    const user = userEvent.setup();
    renderMenu(jest.fn());
    await user.click(screen.getByText("Advanced", { exact: true }));
    expect(screen.getByRole("group", { name: "Chart indicators" })).toHaveFocus();
  });

  it("still closes on Escape after a press on content inside the menu", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    renderMenu(onClose);
    await user.click(screen.getByText("Advanced", { exact: true }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("takes a toggle press as a toggle, keeps the menu open, and keeps the focus on it", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const onToggle = jest.fn();
    renderMenu(onClose, onToggle);
    await user.click(screen.getByRole("button", { name: "EMA 20" }));
    expect(onToggle).toHaveBeenCalledWith("ema20");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "EMA 20" })).toHaveFocus();
    // And Escape still closes the menu from there.
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("closes when focus moves to an element outside the menu and its trigger", () => {
    const onClose = jest.fn();
    renderMenu(onClose);
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it("a second press on the trigger closes the menu, even after WebKit blurred the toggle", () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Indicators" });
    fireEvent.click(trigger);
    const toggle = screen.getByRole("button", { name: "SMA 20" });
    // WebKit's press: the toggle blurs, and nothing takes the focus.
    fireEvent.focusOut(toggle, { relatedTarget: null });
    fireEvent.click(trigger);
    expect(screen.queryByRole("group", { name: "Chart indicators" })).toBeNull();
  });
});

describe("useIndicatorAccess", () => {
  function Probe({ unlock }: { unlock: "session" | "never" }) {
    return <span>{useIndicatorAccess(unlock)}</span>;
  }

  it.each<[status: string, unlock: "session" | "never", expected: IndicatorAccess]>([
    ["authenticated", "session", "signed-in"],
    ["loading", "session", "checking"],
    ["unauthenticated", "session", "signed-out"],
    ["authenticated", "never", "signed-out"],
  ])("is %s with unlock %s as %s", (status, unlock, expected) => {
    jest.mocked(useSession).mockReturnValueOnce({
      data: null,
      status,
      update: jest.fn(),
    } as never);
    const { container } = render(<Probe unlock={unlock} />);
    expect(container.textContent).toBe(expected);
  });
});
