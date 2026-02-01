// Mock for next-auth/react
const mockSession = {
  user: {
    id: "test-user",
    name: "Test User",
    email: "test@example.com",
    image: null,
  },
};

const mockUseSession = jest.fn(() => ({
  data: mockSession,
  status: "authenticated",
  update: jest.fn(),
}));

const mockSignIn = jest.fn();
const mockSignOut = jest.fn();

module.exports = {
  useSession: mockUseSession,
  signIn: mockSignIn,
  signOut: mockSignOut,
  /** @param {{ children: React.ReactNode }} props */
  SessionProvider: ({ children }) => children,
  getCsrfToken: jest.fn(),
  getProviders: jest.fn(),
  getSession: jest.fn(),
};

