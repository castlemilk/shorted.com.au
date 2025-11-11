import { render, screen, waitFor } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import SignInPage from "../page";

// Mock next/navigation
jest.mock("next/navigation", () => ({
  useRouter: jest.fn(),
  useSearchParams: jest.fn(),
}));

// Mock next-auth/react
jest.mock("next-auth/react", () => ({
  useSession: jest.fn(),
  signIn: jest.fn(),
}));

// Mock Next.js Image component
jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: any) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

// Mock UI components
jest.mock("~/@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

jest.mock("~/@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

jest.mock("~/@/components/ui/card", () => ({
  Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardDescription: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardHeader: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
}));

jest.mock("lucide-react", () => ({
  Chrome: () => <span>Chrome Icon</span>,
  Loader2: () => <span>Loading Icon</span>,
  AlertCircle: () => <span>Alert Icon</span>,
}));

describe("SignInPage", () => {
  const mockPush = jest.fn();
  const mockGet = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({
      push: mockPush,
    });
    (useSearchParams as jest.Mock).mockReturnValue({
      get: mockGet,
    });
    mockGet.mockReturnValue(null); // default no callbackUrl
  });

  it("shows loading state while checking authentication", () => {
    (useSession as jest.Mock).mockReturnValue({
      data: null,
      status: "loading",
    });

    render(<SignInPage />);

    expect(screen.getByText("Checking authentication...")).toBeInTheDocument();
  });

  it("redirects authenticated users to home page", async () => {
    (useSession as jest.Mock).mockReturnValue({
      data: { user: { email: "test@example.com" } },
      status: "authenticated",
    });

    render(<SignInPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/");
    });
  });

  it("redirects authenticated users to callback URL", async () => {
    mockGet.mockReturnValue("/dashboards");
    (useSession as jest.Mock).mockReturnValue({
      data: { user: { email: "test@example.com" } },
      status: "authenticated",
    });

    render(<SignInPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/dashboards");
    });
  });

  it("shows sign in form for unauthenticated users", () => {
    (useSession as jest.Mock).mockReturnValue({
      data: null,
      status: "unauthenticated",
    });

    render(<SignInPage />);

    expect(screen.getByText("Welcome to Shorted")).toBeInTheDocument();
    expect(screen.getByText("Continue with Google")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("does not redirect when status is unauthenticated", () => {
    (useSession as jest.Mock).mockReturnValue({
      data: null,
      status: "unauthenticated",
    });

    render(<SignInPage />);

    expect(mockPush).not.toHaveBeenCalled();
  });
});

