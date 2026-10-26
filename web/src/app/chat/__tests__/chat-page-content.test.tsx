import { render, screen } from "@testing-library/react";
import { ChatPageContent } from "../chat-page-content";

// The page is wired to the real hook in the app. Here the hook is a fixed state,
// so what is under test is which of its flags the composer and thread receive.
let mockChatState: Record<string, unknown>;
let mockFetchConversations: jest.Mock;
let mockIsPremium = true;

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "user-1", email: "buyer@example.test" } } }),
}));

jest.mock("~/@/hooks/use-subscription", () => ({
  useSubscription: () => ({ isPremium: mockIsPremium }),
}));

jest.mock("~/@/hooks/use-chat", () => ({
  useChat: () => mockChatState,
}));

jest.mock("~/@/components/chat/chat-conversation-list", () => ({
  ChatConversationList: () => null,
}));

jest.mock("~/@/components/premium/premium-gate", () => ({
  PremiumGate: () => null,
}));

jest.mock("next/navigation", () => ({
  usePathname: () => "/chat",
}));

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function DynamicChatMessageBubble() {
      return null;
    },
}));

jest.mock("lucide-react", () => {
  const Icon = ({ className }: { className?: string }) => (
    <svg className={className} aria-hidden="true" />
  );
  return {
    ArrowDown: Icon,
    Loader2: Icon,
    MessageSquare: Icon,
    Send: Icon,
    Square: Icon,
    User: Icon,
    Bot: Icon,
  };
});

function chatState(overrides: Record<string, unknown> = {}) {
  mockFetchConversations = jest.fn().mockResolvedValue(undefined);
  return {
    messages: [],
    status: "ready",
    isLoading: false,
    isLoadingHistory: false,
    error: null,
    historyError: null,
    conversationId: null,
    conversations: [],
    isLoadingConversations: false,
    sendMessage: jest.fn(),
    retry: jest.fn(),
    clearChat: jest.fn(),
    stopGeneration: jest.fn(),
    fetchConversations: mockFetchConversations,
    loadConversation: jest.fn(),
    deleteConversation: jest.fn(),
    ...overrides,
  };
}

function composer() {
  return screen.getByRole("textbox", { name: "Message Shorted AI" });
}

beforeEach(() => {
  mockIsPremium = true;
});

describe("ChatPageContent conversation list", () => {
  it("loads the conversation list for a subscriber", () => {
    mockChatState = chatState();
    render(<ChatPageContent />);

    expect(mockFetchConversations).toHaveBeenCalledTimes(1);
  });

  it("does not load it for a free user, who only sees the upgrade prompt", () => {
    mockIsPremium = false;
    mockChatState = chatState();
    render(<ChatPageContent />);

    expect(mockFetchConversations).not.toHaveBeenCalled();
  });
});

describe("ChatPageContent composer", () => {
  it("stays open while a reply streams, so the next question can be drafted", () => {
    mockChatState = chatState({ status: "streaming", isLoading: true });
    render(<ChatPageContent />);

    expect(composer()).toBeEnabled();
  });

  it("is held only while a conversation is loading", () => {
    mockChatState = chatState({ isLoadingHistory: true, isLoading: true });
    render(<ChatPageContent />);

    expect(composer()).toBeDisabled();
  });

  it("is open for a fresh thread", () => {
    mockChatState = chatState();
    render(<ChatPageContent />);

    expect(composer()).toBeEnabled();
  });
});
