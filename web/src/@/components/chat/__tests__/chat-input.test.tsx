import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChatInput } from "../chat-input";

jest.mock("lucide-react", () => {
  const Icon = ({ className }: { className?: string }) => (
    <svg className={className} aria-hidden="true" />
  );
  return {
    Send: Icon,
    Square: Icon,
  };
});

type ChatInputProps = React.ComponentProps<typeof ChatInput>;

function renderInput(overrides: Partial<ChatInputProps> = {}) {
  const onSend = jest.fn();
  const onStop = jest.fn();
  const utils = render(
    <ChatInput onSend={onSend} onStop={onStop} status="ready" {...overrides} />,
  );
  const textarea = screen.getByRole("textbox", { name: "Message Shorted AI" });
  return { ...utils, onSend, onStop, textarea };
}

function typeText(textarea: HTMLElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

describe("ChatInput keyboard", () => {
  it("sends the trimmed text on Enter and clears the composer", () => {
    const { textarea, onSend } = renderInput();

    typeText(textarea, "  Who is most shorted?  ");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("Who is most shorted?");
    expect(textarea).toHaveValue("");
  });

  it("inserts a newline on Shift+Enter instead of sending", () => {
    const { textarea, onSend } = renderInput();

    typeText(textarea, "First line");
    const notPrevented = fireEvent.keyDown(textarea, {
      key: "Enter",
      shiftKey: true,
    });

    expect(notPrevented).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("First line");
  });

  it("does not send while an IME composition is being confirmed", () => {
    const { textarea, onSend } = renderInput();

    typeText(textarea, "ふじ");
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("ふじ");
  });

  it("sends on Enter once the composition has ended", () => {
    const { textarea, onSend } = renderInput();

    typeText(textarea, "富士");
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: false });

    expect(onSend).toHaveBeenCalledWith("富士");
  });

  it("never sends an empty or whitespace-only message", () => {
    const { textarea, onSend } = renderInput();

    typeText(textarea, "   ");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });
});

describe("ChatInput length", () => {
  it("caps the input at 2000 characters", () => {
    const { textarea } = renderInput();

    // No maxlength: the browser counts UTF-16 units, and the cap is in characters.
    expect(textarea).not.toHaveAttribute("maxlength");
    typeText(textarea, "a".repeat(2500));

    expect(textarea).toHaveValue("a".repeat(2000));
  });

  it("counts an emoji as one character, as the service does", () => {
    const { textarea } = renderInput();

    typeText(textarea, "\u{1F4C8}".repeat(1600));

    // 1600 code points, 3200 UTF-16 units: all of it is kept, and the counter
    // reads the characters the service counts.
    expect(textarea).toHaveValue("\u{1F4C8}".repeat(1600));
    expect(screen.getByText("1600/2000")).toBeInTheDocument();
  });

  it("cuts an over-long emoji message on a whole character, never inside a pair", () => {
    const { textarea } = renderInput();

    typeText(textarea, "\u{1F4C8}".repeat(2500));

    const value = (textarea as HTMLTextAreaElement).value;
    expect(Array.from(value)).toHaveLength(2000);
    expect(Array.from(value).every((char) => char === "\u{1F4C8}")).toBe(true);
  });

  it("shows no counter until the person nears the limit", () => {
    const { textarea } = renderInput();

    typeText(textarea, "a".repeat(100));

    expect(screen.queryByText(/\/2000$/)).not.toBeInTheDocument();
    expect(screen.getByText(/Enter to send/)).toBeInTheDocument();
  });

  it("counts down from the threshold", () => {
    const { textarea } = renderInput();

    typeText(textarea, "a".repeat(1600));

    expect(screen.getByText("1600/2000")).toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-describedby");
  });
});

describe("ChatInput generation controls", () => {
  it("shows Stop while a reply streams, and Stop calls stop", () => {
    const { onStop } = renderInput({ status: "streaming" });

    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows Stop while the request is only submitted", () => {
    renderInput({ status: "submitted" });

    expect(screen.getByRole("button", { name: "Stop response" })).toBeInTheDocument();
  });

  it("disables the textarea while the request is submitted", () => {
    const { textarea, rerender, onSend, onStop } = renderInput({ status: "submitted" });

    expect(textarea).toBeDisabled();

    rerender(<ChatInput onSend={onSend} onStop={onStop} status="streaming" />);
    expect(textarea).toBeEnabled();
  });

  it("offers Send again after an errored request", () => {
    const { textarea, onSend } = renderInput({ status: "error" });

    typeText(textarea, "Try that again");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith("Try that again");
  });

  it("keeps Send disabled until there is text", () => {
    const { textarea } = renderInput();

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    typeText(textarea, "Hi");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });
});

describe("ChatInput while a conversation loads", () => {
  it("holds the composer and Send while the thread is busy, though the request is ready", () => {
    const { textarea, onSend } = renderInput({ status: "ready", busy: true });

    expect(textarea).toBeDisabled();
    typeText(textarea, "Hello");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("releases the composer once the thread is no longer busy", () => {
    const { textarea, rerender, onSend, onStop } = renderInput({ status: "ready", busy: true });

    rerender(<ChatInput onSend={onSend} onStop={onStop} status="ready" busy={false} />);
    expect(textarea).toBeEnabled();
  });
});

describe("ChatInput focus", () => {
  it("returns focus to the composer after a send", () => {
    const { textarea } = renderInput();

    typeText(textarea, "Hello");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea).toHaveFocus();
  });

  it("returns focus to the composer when the reply finishes, if focus was lost", () => {
    const { textarea, rerender, onSend, onStop } = renderInput({ status: "submitted" });

    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    rerender(<ChatInput onSend={onSend} onStop={onStop} status="streaming" />);
    rerender(<ChatInput onSend={onSend} onStop={onStop} status="ready" />);

    expect(textarea).toHaveFocus();
  });

  it("leaves focus where the person put it when the reply finishes", () => {
    const { textarea, rerender, onSend, onStop } = renderInput({ status: "streaming" });
    const other = document.createElement("button");
    document.body.appendChild(other);

    act(() => {
      other.focus();
    });
    rerender(<ChatInput onSend={onSend} onStop={onStop} status="ready" />);

    expect(other).toHaveFocus();
    expect(textarea).not.toHaveFocus();
    other.remove();
  });
});
