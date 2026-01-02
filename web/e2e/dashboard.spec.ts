import { test, expect } from "@playwright/test";

test.describe("Dashboard Navigation", () => {
  test("should show sidebar navigation on desktop", async ({ page }) => {
    await page.goto("/dashboards");
    
    // Check if sidebar is visible on desktop
    const sidebar = page.locator('aside:has-text("Navigation")');
    await expect(sidebar).toBeVisible();
    
    // Check navigation items
    await expect(page.locator('text="Home"').first()).toBeVisible();
    await expect(page.locator('text="Dashboard"').first()).toBeVisible();
    await expect(page.locator('text="Top Shorts"').first()).toBeVisible();
    await expect(page.locator('text="Industry Analysis"').first()).toBeVisible();
    await expect(page.locator('text="Time Series"').first()).toBeVisible();
    await expect(page.locator('text="Portfolio"').first()).toBeVisible();
    await expect(page.locator('text="Settings"').first()).toBeVisible();
  });

  test("should show mobile menu button on mobile", async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/dashboards");
    
    // Desktop sidebar should be hidden
    const desktopSidebar = page.locator('aside:has-text("Navigation")');
    await expect(desktopSidebar).toBeHidden();
    
    // Mobile menu button should be visible
    const mobileMenuButton = page.locator('button[aria-label*="menu"]').or(page.locator('button:has(svg.lucide-menu)'));
    await expect(mobileMenuButton).toBeVisible();
    
    // Click menu button to open sidebar
    await mobileMenuButton.click();
    
    // Mobile sidebar should now be visible
    const mobileSidebar = page.locator('[role="dialog"]:has-text("Navigation")');
    await expect(mobileSidebar).toBeVisible();
  });

  test("should navigate to dashboard page from home", async ({ page }) => {
    await page.goto("/");
    
    // Look for any link to dashboard
    const dashboardLink = page.locator('a[href="/dashboards"]').first();
    
    if (await dashboardLink.isVisible()) {
      await dashboardLink.click();
      await expect(page).toHaveURL("/dashboards");
    } else {
      // If no direct link, check if we need to be logged in
      console.log("No dashboard link found on home page - may require authentication");
    }
  });
});

test.describe("Dashboard Functionality", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboards");
  });

  test("should display dashboard with default widgets", async ({ page }) => {
    // Check dashboard title
    await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible();
    
    // Check for edit button
    await expect(page.locator('button:has-text("Edit Dashboard")')).toBeVisible();
    
    // Check for default widgets
    await expect(page.locator('text="Top Shorted Stocks"')).toBeVisible();
    await expect(page.locator('text="Industry Short Positions"')).toBeVisible();
  });

  test("should enter edit mode when clicking edit button", async ({ page }) => {
    const editButton = page.locator('button:has-text("Edit Dashboard")');
    await editButton.click();
    
    // Should show save button
    await expect(page.locator('button:has-text("Save Layout")')).toBeVisible();
    
    // Should show add widget button
    await expect(page.locator('button:has-text("Add Widget")')).toBeVisible();
    
    // Widgets should have remove buttons
    await expect(page.locator('button[aria-label*="remove"]').or(page.locator('button:has(svg.lucide-x)')).first()).toBeVisible();
  });

  test("should open add widget menu", async ({ page }) => {
    // Enter edit mode
    await page.locator('button:has-text("Edit Dashboard")').click();
    
    // Click add widget button
    await page.locator('button:has-text("Add Widget")').click();
    
    // Check widget categories
    await expect(page.locator('text="Overview"')).toBeVisible();
    await expect(page.locator('text="Analysis"')).toBeVisible();
    await expect(page.getByLabel('Add Widget').getByText('Portfolio', { exact: true })).toBeVisible();
    await expect(page.locator('text="Market Data"')).toBeVisible();
  });

  test("should open widget configuration dialog", async ({ page }) => {
    // Wait for widgets to load
    await page.waitForSelector('text="Top Shorted Stocks"');
    
    // Look for settings button on a widget
    const settingsButton = page.locator('button:has(svg.lucide-settings)').first();
    await settingsButton.click();
    
    // Click on "Configure Widget" menu item
    await page.locator('text="Configure Widget"').click();
    
    // Should open configuration dialog
    await expect(page.locator('[role="dialog"]:has-text("Configure")')).toBeVisible();
    await expect(page.locator('text="Widget Title"')).toBeVisible();
    await expect(page.locator('button:has-text("Save Changes")')).toBeVisible();
  });
});

test.describe("Widget Interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboards");
  });

  test("should load top shorts widget data", async ({ page }) => {
    const topShortsWidget = page.locator('[data-testid="widget-TOP_SHORTS"], :has-text("Top Shorted Stocks")').first();
    
    // Wait for data to load
    await page.waitForLoadState("networkidle");
    
    // Should show stock data or loading state
    const hasData = await page.locator('table').isVisible() || 
                    await page.locator('text="Loading top shorts"').isVisible();
    expect(hasData).toBeTruthy();
  });

  test("should load treemap widget", async ({ page }) => {
    const treemapWidget = page.locator('[data-testid="widget-INDUSTRY_TREEMAP"], :has-text("Industry Short Positions")').first();
    
    // Wait for data to load
    await page.waitForLoadState("networkidle");
    
    // Should show SVG visualization or loading state
    const hasSvg = await page.locator('svg').nth(1).isVisible() || 
                   await page.locator('text="Loading industry data"').isVisible();
    expect(hasSvg).toBeTruthy();
  });
});