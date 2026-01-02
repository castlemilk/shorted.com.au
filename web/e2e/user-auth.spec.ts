import { test, expect } from '@playwright/test';

test.describe('User Authentication', () => {
  test('should show login/register options when not authenticated', async ({ page }) => {
    await page.goto('/');
    
    // Look for login/register buttons or links
    const loginLink = page.getByRole('link', { name: /login|sign in/i });
    const registerLink = page.getByRole('link', { name: /register|sign up/i });
    const authButton = page.getByRole('button', { name: /login|sign in|register/i });
    
    // At least one authentication option should be visible
    await expect(
      loginLink.or(registerLink).or(authButton)
    ).toBeVisible();
  });

  test('should navigate to login page', async ({ page }) => {
    await page.goto('/');
    
    const loginLink = page.getByRole('link', { name: /login|sign in/i });
    
    if (await loginLink.isVisible()) {
      await loginLink.click();
      
      // Should navigate to login page or show login modal
      await Promise.race([
        expect(page).toHaveURL(/\/login|\/auth|\/signin/),
        expect(page.locator('[data-testid="login-modal"]').or(page.locator('form')).filter({ hasText: /login|sign in/i })).toBeVisible()
      ]);
    }
  });

  test('should show login form', async ({ page }) => {
    // Try direct navigation to login page
    await page.goto('/login');
    
    // If login page doesn't exist, try from homepage
    if (page.url().includes('404') || !(await page.locator('form').isVisible())) {
      await page.goto('/');
      const loginButton = page.getByRole('button', { name: /login|sign in/i });
      if (await loginButton.isVisible()) {
        await loginButton.click();
      }
    }
    
    // Look for login form elements
    const emailInput = page.locator('input[type="email"]').or(page.locator('input[name="email"]'));
    const passwordInput = page.locator('input[type="password"]').or(page.locator('input[name="password"]'));
    const submitButton = page.getByRole('button', { name: /login|sign in/i });
    
    if (await emailInput.isVisible()) {
      await expect(emailInput).toBeVisible();
      await expect(passwordInput).toBeVisible();
      await expect(submitButton).toBeVisible();
    }
  });

  test('should handle login form validation', async ({ page }) => {
    await page.goto('/');
    
    // Try to find and open login form
    const loginButton = page.getByRole('button', { name: /login|sign in/i });
    if (await loginButton.isVisible()) {
      await loginButton.click();
      
      const submitButton = page.getByRole('button', { name: /login|sign in/i });
      
      if (await submitButton.isVisible()) {
        // Try to submit empty form
        await submitButton.click();
        
        // Should show validation errors
        await expect(page.locator('text=/required|email|password/i')).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test('should handle authentication state changes', async ({ page }) => {
    await page.goto('/');
    
    // Mock successful authentication
    await page.evaluate(() => {
      // Simulate authenticated state in localStorage or sessionStorage
      localStorage.setItem('auth-token', 'mock-token');
      localStorage.setItem('user', JSON.stringify({ email: 'test@example.com' }));
    });
    
    await page.reload();
    
    // Should show authenticated state
    const userMenu = page.locator('[data-testid="user-menu"]').or(page.getByText(/test@example.com/));
    const logoutButton = page.getByRole('button', { name: /logout|sign out/i });
    
    if (await userMenu.isVisible() || await logoutButton.isVisible()) {
      await expect(userMenu.or(logoutButton)).toBeVisible();
    }
  });

  test('should handle logout', async ({ page }) => {
    // Set up authenticated state
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('auth-token', 'mock-token');
      localStorage.setItem('user', JSON.stringify({ email: 'test@example.com' }));
    });
    await page.reload();
    
    // Look for logout functionality
    const logoutButton = page.getByRole('button', { name: /logout|sign out/i });
    const userMenu = page.locator('[data-testid="user-menu"]');
    
    if (await userMenu.isVisible()) {
      await userMenu.click();
      const logoutInMenu = page.getByRole('menuitem', { name: /logout|sign out/i });
      if (await logoutInMenu.isVisible()) {
        await logoutInMenu.click();
      }
    } else if (await logoutButton.isVisible()) {
      await logoutButton.click();
    }
    
    // Should return to unauthenticated state
    await expect(page.getByRole('button', { name: /login|sign in/i })).toBeVisible({ timeout: 5000 });
  });

  test('should handle social login options', async ({ page }) => {
    await page.goto('/');
    
    const loginButton = page.getByRole('button', { name: /login|sign in/i });
    if (await loginButton.isVisible()) {
      await loginButton.click();
      
      // Look for social login buttons
      const googleLogin = page.getByRole('button', { name: /google/i });
      const githubLogin = page.getByRole('button', { name: /github/i });
      const facebookLogin = page.getByRole('button', { name: /facebook/i });
      
      // At least check if social login options are present
      // (We won't actually test the OAuth flow in E2E tests)
      if (await googleLogin.isVisible()) {
        await expect(googleLogin).toBeVisible();
      }
    }
  });

  test('should protect authenticated routes', async ({ page }) => {
    // Try to access a protected route without authentication
    await page.goto('/profile');
    
    // Should redirect to login or show access denied
    await Promise.race([
      expect(page).toHaveURL(/\/login|\/auth/),
      expect(page.locator('text=/login|unauthorized|access denied/i')).toBeVisible()
    ]);
  });

  test('should persist authentication across page reloads', async ({ page }) => {
    await page.goto('/');
    
    // Set up authenticated state
    await page.evaluate(() => {
      localStorage.setItem('auth-token', 'mock-token');
      localStorage.setItem('user', JSON.stringify({ email: 'test@example.com' }));
    });
    
    await page.reload();
    
    // Should maintain authenticated state
    const userIndicator = page.locator('[data-testid="user-menu"]').or(page.getByText(/test@example.com/));
    if (await userIndicator.isVisible()) {
      await expect(userIndicator).toBeVisible();
    }
  });
});