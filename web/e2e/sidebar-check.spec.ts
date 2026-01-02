import { test, expect } from "@playwright/test";

test.describe("Sidebar Navigation Check", () => {
  test("should check home page structure", async ({ page }) => {
    await page.goto("/");
    
    // Take screenshot of home page
    await page.screenshot({ path: "home-page.png", fullPage: true });
    
    // Check if there's any navigation
    const nav = await page.locator("nav").count();
    console.log(`Found ${nav} nav elements on home page`);
    
    // Check for header
    const header = await page.locator("header").count();
    console.log(`Found ${header} header elements`);
    
    // Check for any links to dashboard
    const dashboardLinks = await page.locator('a[href*="dashboard"]').count();
    console.log(`Found ${dashboardLinks} dashboard links`);
  });

  test("should check dashboard page structure", async ({ page }) => {
    await page.goto("/dashboards");
    
    // Take screenshot
    await page.screenshot({ path: "dashboard-page.png", fullPage: true });
    
    // Check page title
    const title = await page.title();
    console.log(`Page title: ${title}`);
    
    // Check for any aside elements (sidebar)
    const asides = await page.locator("aside").count();
    console.log(`Found ${asides} aside elements`);
    
    // Check for navigation text
    const navText = await page.locator('text="Navigation"').count();
    console.log(`Found ${navText} "Navigation" text elements`);
    
    // Check for main content
    const main = await page.locator("main").count();
    console.log(`Found ${main} main elements`);
    
    // Log all visible text
    const bodyText = await page.locator("body").innerText();
    console.log("Page content preview:", bodyText.substring(0, 500));
  });
  
  test("should check CSS classes for sidebar", async ({ page }) => {
    await page.goto("/dashboards");
    
    // Check for sidebar by CSS classes
    const hiddenLg = await page.locator(".hidden.lg\\:flex").count();
    console.log(`Found ${hiddenLg} elements with .hidden.lg:flex`);
    
    // Check viewport size
    const viewport = page.viewportSize();
    console.log(`Viewport size: ${viewport?.width}x${viewport?.height}`);
    
    // Try different viewport sizes
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(1000);
    
    const sidebarDesktop = await page.locator("aside").isVisible();
    console.log(`Sidebar visible on desktop (1400px): ${sidebarDesktop}`);
    
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(1000);
    
    const sidebarMobile = await page.locator("aside").isVisible();
    console.log(`Sidebar visible on mobile (375px): ${sidebarMobile}`);
  });
});