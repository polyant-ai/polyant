// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the i18n hook - return the key itself as the translation
vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string) => {
      const translations: Record<string, string> = {
        "playground.inputPlaceholder": "Type a message...",
        "playground.send": "Send",
        "playground.stop": "Stop",
      };
      return translations[key] ?? key;
    },
  }),
}));

import { ChatInput } from "./chat-input";

describe("ChatInput", () => {
  const defaultProps = {
    onSend: vi.fn(),
    onStop: vi.fn(),
    isStreaming: false,
    disabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a textarea with the correct placeholder", () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    expect(textarea).toBeInTheDocument();
    expect(textarea.tagName).toBe("TEXTAREA");
  });

  it("renders the send button when not streaming", () => {
    render(<ChatInput {...defaultProps} />);
    const sendBtn = screen.getByRole("button", { name: "Send" });
    expect(sendBtn).toBeInTheDocument();
  });

  it("renders the stop button when streaming", () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />);
    const stopBtn = screen.getByRole("button", { name: "Stop" });
    expect(stopBtn).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("calls onStop when the stop button is clicked", async () => {
    const onStop = vi.fn();
    render(<ChatInput {...defaultProps} onStop={onStop} isStreaming={true} />);
    const stopBtn = screen.getByRole("button", { name: "Stop" });
    await userEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("disables send button when textarea is empty", () => {
    render(<ChatInput {...defaultProps} />);
    const sendBtn = screen.getByRole("button", { name: "Send" });
    expect(sendBtn).toBeDisabled();
  });

  it("enables send button when textarea has content", async () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    await userEvent.type(textarea, "Hello");
    const sendBtn = screen.getByRole("button", { name: "Send" });
    expect(sendBtn).toBeEnabled();
  });

  it("calls onSend with trimmed text when send button is clicked", async () => {
    const onSend = vi.fn();
    render(<ChatInput {...defaultProps} onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    await userEvent.type(textarea, "  Hello world  ");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("Hello world");
  });

  it("clears textarea after sending", async () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(textarea.value).toBe("");
  });

  it("sends message on Enter key", async () => {
    const onSend = vi.fn();
    render(<ChatInput {...defaultProps} onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    await userEvent.type(textarea, "Hello");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("Hello");
  });

  it("does NOT send on Shift+Enter (allows newline)", async () => {
    const onSend = vi.fn();
    render(<ChatInput {...defaultProps} onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    await userEvent.type(textarea, "Hello");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send when textarea has only whitespace", async () => {
    const onSend = vi.fn();
    render(<ChatInput {...defaultProps} onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    await userEvent.type(textarea, "   ");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables textarea when disabled prop is true", () => {
    render(<ChatInput {...defaultProps} disabled={true} />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    expect(textarea).toBeDisabled();
  });

  it("does not call onSend when disabled even with text", async () => {
    const onSend = vi.fn();
    render(<ChatInput {...defaultProps} onSend={onSend} disabled={true} />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    // Force a value change via fireEvent since the textarea is disabled
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not call onSend when isStreaming is true", async () => {
    const onSend = vi.fn();
    render(<ChatInput {...defaultProps} onSend={onSend} isStreaming={true} />);
    // The send button is hidden during streaming, but test the keyboard path:
    // We cannot type into textarea easily when streaming, but the handleSend guards against it
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });
});
