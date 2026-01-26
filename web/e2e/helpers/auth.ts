import { Page, expect } from '@playwright/test';
import testUsers from '../fixtures/test-users.json';

export class AuthHelper {
  constructor(private page: Page) {}

  /**
   * Mock authentication state by setting localStorage tokens
   */
  async mockAuthState(userType: keyof typeof testUsers.validUser | 'validUser' | 'adminUser' | 'premiumUser' = 'validUser') {
    const user = userType === 'validUser' ? testUsers.validUser :
                 userType === 'adminUser' ? testUsers.adminUser :
                 userType === 'premiumUser' ? testUsers.premiumUser :
                 testUsers.validUser;

    await this.page.evaluate((userData) => {
      localStorage.setItem('auth-token', 'mock-jwt-token-' + userData.uid);
      localStorage.setItem('user', JSON.stringify({
        uid: userData.uid,
        email: userData.email,
        name: userData.name,
        role: userData.role || 'user',
        subscription: userData.subscription || 'free'
      }));
      localStorage.setItem('session', JSON.stringify({
        user: {
          uid: userData.uid,
          email: userData.email,
          name: userData.name
        },
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      }));
    }, user);

    await this.page.reload();
  }

  /**
   * Clear authentication state
   */
  async clearAuthState() {
    await this.page.evaluate(() => {
      localStorage.removeItem('auth-token');
      localStorage.removeItem('user');
      localStorage.removeItem('session');
      sessionStorage.clear();
    });
    await this.page.reload();
  }

  /**
   * Attempt to login via the UI
   */
  async loginViaUI(email: string = testUsers.validUser.email, password: string = testUsers.validUser.password) {
    // Look for login button or link
    const loginButton = this.page.getByRole('button', { name: /login|sign in/i });
    const loginLink = this.page.getByRole('link', { name: /login|sign in/i });

    if (await loginButton.isVisible()) {
      await loginButton.click();
    } else if (await loginLink.isVisible()) {
      await loginLink.click();
    } else {
      throw new Error('No login button or link found');
    }

    // Wait for login form
    const emailInput = this.page.locator('input[type="email"]').or(this.page.locator('input[name="email"]'));
    const passwordInput = this.page.locator('input[type="password"]').or(this.page.locator('input[name="password"]'));
    const submitButton = this.page.getByRole('button', { name: /login|sign in/i });

    await expect(emailInput).toBeVisible({ timeout: 5000 });
    await expect(passwordInput).toBeVisible();
    await expect(submitButton).toBeVisible();

    // Fill and submit form
    await emailInput.fill(email);
    await passwordInput.fill(password);
    await submitButton.click();
  }

  /**
   * Attempt to register via the UI
   */
  async registerViaUI(email: string, password: string, name: string) {
    // Look for register button or link
    const registerButton = this.page.getByRole('button', { name: /register|sign up/i });
    const registerLink = this.page.getByRole('link', { name: /register|sign up/i });

    if (await registerButton.isVisible()) {
      await registerButton.click();
    } else if (await registerLink.isVisible()) {
      await registerLink.click();
    } else {
      throw new Error('No register button or link found');
    }

    // Wait for registration form
    const nameInput = this.page.locator('input[name="name"]').or(this.page.locator('input[placeholder*="name"]'));
    const emailInput = this.page.locator('input[type="email"]').or(this.page.locator('input[name="email"]'));
    const passwordInput = this.page.locator('input[type="password"]').or(this.page.locator('input[name="password"]'));
    const submitButton = this.page.getByRole('button', { name: /register|sign up|create account/i });

    await expect(emailInput).toBeVisible({ timeout: 5000 });
    await expect(passwordInput).toBeVisible();
    await expect(submitButton).toBeVisible();

    // Fill and submit form
    if (await nameInput.isVisible()) {
      await nameInput.fill(name);
    }
    await emailInput.fill(email);
    await passwordInput.fill(password);
    await submitButton.click();
  }

  /**
   * Logout via the UI
   */
  async logoutViaUI() {
    // Look for user menu or logout button
    const userMenu = this.page.locator('[data-testid="user-menu"]');
    const logoutButton = this.page.getByRole('button', { name: /logout|sign out/i });
    
    if (await userMenu.isVisible()) {
      await userMenu.click();
      const logoutMenuItem = this.page.getByRole('menuitem', { name: /logout|sign out/i });
      await logoutMenuItem.click();
    } else if (await logoutButton.isVisible()) {
      await logoutButton.click();
    } else {
      throw new Error('No logout option found');
    }
  }

  /**
   * Verify user is authenticated
   */
  async expectAuthenticated(userEmail?: string) {
    // Look for user indicators
    const userMenu = this.page.locator('[data-testid="user-menu"]');
    const logoutButton = this.page.getByRole('button', { name: /logout|sign out/i });
    const userEmailLocator = this.page.getByText(userEmail || testUsers.validUser.email);

    await expect(
      userMenu.or(logoutButton).or(userEmailLocator)
    ).toBeVisible({ timeout: 10000 });

    // Should not see login button
    const loginButton = this.page.getByRole('button', { name: /login|sign in/i });
    await expect(loginButton).not.toBeVisible();
  }

  /**
   * Verify user is not authenticated
   */
  async expectNotAuthenticated() {
    // Should see login/register options
    const loginButton = this.page.getByRole('button', { name: /login|sign in/i });
    const registerButton = this.page.getByRole('button', { name: /register|sign up/i });
    const loginLink = this.page.getByRole('link', { name: /login|sign in/i });

    await expect(
      loginButton.or(registerButton).or(loginLink)
    ).toBeVisible({ timeout: 5000 });

    // Should not see user menu
    const userMenu = this.page.locator('[data-testid="user-menu"]');
    await expect(userMenu).not.toBeVisible();
  }

  /**
   * Verify protected route access
   */
  async expectProtectedRoute(routePath: string) {
    await this.page.goto(routePath);
    
    // Should either redirect to login or show access denied
    await Promise.race([
      expect(this.page).toHaveURL(/\/login|\/auth|\/signin/),
      expect(this.page.locator('text=/login|unauthorized|access denied|please sign in/i')).toBeVisible()
    ]);
  }

  /**
   * Mock Firebase Auth state
   */
  async mockFirebaseAuth(userType: 'validUser' | 'adminUser' | 'premiumUser' = 'validUser') {
    const user = testUsers[userType];
    
    await this.page.addInitScript((userData) => {
      // Mock Firebase Auth
      window.mockFirebaseUser = {
        uid: userData.uid,
        email: userData.email,
        displayName: userData.name,
        emailVerified: true,
        getIdToken: () => Promise.resolve('mock-id-token'),
        getIdTokenResult: () => Promise.resolve({ token: 'mock-id-token', claims: {} })
      };

      // Mock Next-Auth session
      window.__NEXT_AUTH = {
        session: {
          user: {
            id: userData.uid,
            email: userData.email,
            name: userData.name
          },
          expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        }
      };
    }, user);
  }

  /**
   * Wait for authentication state to load
   */
  async waitForAuthState() {
    // Wait for either authenticated or unauthenticated state
    await Promise.race([
      this.page.locator('[data-testid="user-menu"]').waitFor({ state: 'visible', timeout: 10000 }),
      this.page.getByRole('button', { name: /login|sign in/i }).waitFor({ state: 'visible', timeout: 10000 })
    ]);
  }
}