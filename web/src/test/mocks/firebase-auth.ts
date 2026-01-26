const vi = { fn: jest.fn };

// Mock Firebase Auth types
export interface MockUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
}

// Mock auth state
let currentUser: MockUser | null = null;
let authStateListeners: ((user: MockUser | null) => void)[] = [];

// Mock Firebase Auth functions
export const mockSignInWithEmailAndPassword = vi.fn(
  async (email: string, password: string): Promise<{ user: MockUser }> => {
    const user: MockUser = {
      uid: 'test-uid-123',
      email,
      displayName: email.split('@')[0] ?? null,
      photoURL: null,
      emailVerified: true,
    };
    currentUser = user;
    authStateListeners.forEach(listener => listener(user));
    return { user };
  }
);

export const mockSignOut = vi.fn(async () => {
  currentUser = null;
  authStateListeners.forEach(listener => listener(null));
});

export const mockOnAuthStateChanged = vi.fn((callback: (user: MockUser | null) => void) => {
  authStateListeners.push(callback);
  // Immediately call with current user
  callback(currentUser);
  
  // Return unsubscribe function
  return () => {
    authStateListeners = authStateListeners.filter(listener => listener !== callback);
  };
});

export const mockCreateUserWithEmailAndPassword = vi.fn(
  async (email: string, password: string): Promise<{ user: MockUser }> => {
    const user: MockUser = {
      uid: `new-user-${Date.now()}`,
      email,
      displayName: null,
      photoURL: null,
      emailVerified: false,
    };
    currentUser = user;
    authStateListeners.forEach(listener => listener(user));
    return { user };
  }
);

export const mockSendPasswordResetEmail = vi.fn(async (email: string) => {
  return Promise.resolve();
});

export const mockUpdateProfile = vi.fn(async (user: MockUser, profile: { displayName?: string; photoURL?: string }) => {
  if (profile.displayName !== undefined) user.displayName = profile.displayName;
  if (profile.photoURL !== undefined) user.photoURL = profile.photoURL;
  return Promise.resolve();
});

// Mock Firebase Admin for backend
export const mockVerifyIdToken = vi.fn(async (token: string) => {
  if (token === 'valid-token') {
    return {
      uid: 'test-uid-123',
      email: 'test@example.com',
      email_verified: true,
    };
  }
  throw new Error('Invalid token');
});

// Reset function for tests
export const resetFirebaseAuth = () => {
  currentUser = null;
  authStateListeners = [];
  mockSignInWithEmailAndPassword.mockClear();
  mockSignOut.mockClear();
  mockOnAuthStateChanged.mockClear();
  mockCreateUserWithEmailAndPassword.mockClear();
  mockSendPasswordResetEmail.mockClear();
  mockUpdateProfile.mockClear();
  mockVerifyIdToken.mockClear();
};

// Set current user for testing
export const setCurrentUser = (user: MockUser | null) => {
  currentUser = user;
  authStateListeners.forEach(listener => listener(user));
};

// Mock NextAuth Firebase adapter
export const mockFirebaseAdapter = {
  createUser: vi.fn(),
  getUser: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByAccount: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  linkAccount: vi.fn(),
  unlinkAccount: vi.fn(),
  createSession: vi.fn(),
  getSessionAndUser: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  createVerificationToken: vi.fn(),
  useVerificationToken: vi.fn(),
};

// Export mocked firebase modules
export const mockFirebaseAuth = {
  signInWithEmailAndPassword: mockSignInWithEmailAndPassword,
  signOut: mockSignOut,
  onAuthStateChanged: mockOnAuthStateChanged,
  createUserWithEmailAndPassword: mockCreateUserWithEmailAndPassword,
  sendPasswordResetEmail: mockSendPasswordResetEmail,
  updateProfile: mockUpdateProfile,
};

export const mockFirebaseAdmin = {
  auth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
};