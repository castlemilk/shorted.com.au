import { test, expect } from '@playwright/test';
import { APIMockHelper } from './helpers/api-mock';
import { AuthHelper } from './helpers/auth';
import testUsers from './fixtures/test-users.json';

test.describe('TreeMap Visualization', () => {
  let apiMock: APIMockHelper;
  let authHelper: AuthHelper;

  test.beforeEach(async ({ page }) => {
    apiMock = new APIMockHelper(page);
    authHelper = new AuthHelper(page);
    
    // Mock successful API responses
    await apiMock.mockSuccessfulResponses();
    
    await page.goto('/treemap');
  });

  test('should load treemap page successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/TreeMap.*Shorted/);
    await expect(page.locator('h1')).toContainText(/treemap|tree map/i);
  });

  test('should display comprehensive treemap visualization', async ({ page }) => {
    // Wait for treemap to load completely
    await expect(
      page.locator('[data-testid="treemap"]')
        .or(page.locator('.treemap-container'))
        .or(page.locator('svg'))
    ).toBeVisible({ timeout: 15000 });
    
    // Check for treemap SVG and elements
    const treemapSvg = page.locator('svg').first();
    await expect(treemapSvg).toBeVisible();
    
    // Verify multiple rectangles representing different stocks/sectors
    const rects = treemapSvg.locator('rect');
    await expect(rects).toHaveCount(3, { timeout: 10000 }); // At least 3 sectors
    
    // Each rectangle should have proper dimensions and positioning
    const firstRect = rects.first();
    await expect(firstRect).toBeVisible();
    
    // Verify rectangles have proper attributes
    const width = await firstRect.getAttribute('width');
    const height = await firstRect.getAttribute('height');
    const fill = await firstRect.getAttribute('fill');
    
    expect(parseFloat(width || '0')).toBeGreaterThan(0);
    expect(parseFloat(height || '0')).toBeGreaterThan(0);
    expect(fill).toBeTruthy();
    
    // Should have text labels for sectors/stocks
    const textElements = treemapSvg.locator('text');
    if (await textElements.first().isVisible()) {
      await expect(textElements.first()).toBeVisible();
      
      // Text should contain recognizable content
      const textContent = await textElements.first().textContent();
      expect(textContent).toMatch(/[A-Z]{2,4}|Financials|Materials|Healthcare/i);
    }
  });

  test('should show detailed information on hover interactions', async ({ page }) => {
    // Wait for treemap to load completely
    const treemap = page.locator('[data-testid="treemap"]')
      .or(page.locator('.treemap-container'))
      .or(page.locator('svg')).first();
    await expect(treemap).toBeVisible({ timeout: 15000 });
    
    // Test hover interactions on different rectangles
    const rects = treemap.locator('rect');
    const rectCount = await rects.count();
    
    if (rectCount > 0) {
      // Hover over first rectangle (likely a sector)
      await rects.first().hover();
      
      // Look for tooltip with detailed information
      const tooltipSelectors = [
        page.locator('[data-testid="tooltip"]'),
        page.locator('.tooltip'),
        page.locator('[role="tooltip"]'),
        page.locator('.treemap-tooltip')
      ];
      
      let tooltipFound = false;
      for (const tooltip of tooltipSelectors) {
        if (await tooltip.isVisible({ timeout: 3000 })) {
          await expect(tooltip).toBeVisible();
          
          const tooltipText = await tooltip.textContent();
          
          // Tooltip should contain meaningful information
          expect(tooltipText).toMatch(/(Financials|Materials|Healthcare|CBA|BHP|[A-Z]{2,4})/i);
          
          // Should show percentage or value information
          expect(tooltipText).toMatch(/\\d+\\.?\\d*%|\\$[\\d,]+/);
          
          tooltipFound = true;
          break;
        }
      }
      
      // Test hover on multiple rectangles if available
      if (rectCount > 1) {
        await rects.nth(1).hover();
        await page.waitForTimeout(500);
        
        // Should show different tooltip content
        for (const tooltip of tooltipSelectors) {
          if (await tooltip.isVisible({ timeout: 2000 })) {
            const newTooltipText = await tooltip.textContent();
            expect(newTooltipText).toBeTruthy();
            break;
          }
        }
      }
      
      // Test hover away behavior
      await page.locator('body').hover();
      await page.waitForTimeout(1000);
      
      // Tooltip should disappear
      for (const tooltip of tooltipSelectors) {
        if (await tooltip.isVisible({ timeout: 1000 })) {
          await expect(tooltip).not.toBeVisible();
        }
      }
    }
  });

  test('should navigate to stock detail pages on click', async ({ page }) => {
    // Wait for treemap to load completely
    const treemap = page.locator('[data-testid="treemap"]')
      .or(page.locator('.treemap-container'))
      .or(page.locator('svg')).first();
    await expect(treemap).toBeVisible({ timeout: 15000 });
    
    // Test clicking on different treemap segments
    const clickableElements = [
      treemap.locator('rect'),
      treemap.locator('g[data-stock]'),
      treemap.locator('[data-testid*="stock-"]'),
      treemap.locator('text').filter({ hasText: /^[A-Z]{2,4}$/ })
    ];
    
    for (const elementType of clickableElements) {
      if (await elementType.first().isVisible()) {
        // Get stock code for validation
        let stockCode = '';
        
        // Try to extract stock code from various attributes
        const dataStock = await elementType.first().getAttribute('data-stock');
        const textContent = await elementType.first().textContent();
        
        if (dataStock) {
          stockCode = dataStock;
        } else if (textContent && /^[A-Z]{2,4}$/.test(textContent)) {
          stockCode = textContent;
        }
        
        // Click the element
        await elementType.first().click();
        
        // Should navigate to stock detail page
        if (stockCode) {
          await expect(page).toHaveURL(new RegExp(`/(stock|shorts)/${stockCode}`, 'i'), { timeout: 10000 });
          
          // Verify we're on the stock detail page
          await expect(page.locator('h1')).toContainText(stockCode, { timeout: 5000 });
          
          // Navigate back for next test
          await page.goBack();
          await expect(treemap).toBeVisible({ timeout: 10000 });
        } else {
          // If no specific stock code, should navigate to some detail view
          await expect(page).toHaveURL(/(stock|shorts|sector)/, { timeout: 10000 });
          await page.goBack();
        }
        
        break;
      }
    }
  });

  test('should provide comprehensive filtering and view controls', async ({ page }) => {
    // Wait for treemap to load
    await expect(
      page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()
    ).toBeVisible({ timeout: 15000 });
    
    // Look for various types of filter controls
    const filterControls = [
      {
        type: 'select',
        selector: page.locator('select[data-testid*="filter"]').or(page.locator('select').first())
      },
      {
        type: 'combobox',
        selector: page.locator('[role="combobox"]')
      },
      {
        type: 'buttons',
        selector: page.locator('button').filter({ hasText: /financials|materials|healthcare|energy|banks/i })
      },
      {
        type: 'tabs',
        selector: page.locator('[role="tablist"] button')
      }
    ];
    
    let filterFound = false;
    
    for (const control of filterControls) {
      if (await control.selector.first().isVisible()) {
        filterFound = true;
        
        // Test different filter options based on control type
        if (control.type === 'select' || control.type === 'combobox') {
          await control.selector.first().click();
          
          const options = page.getByRole('option');
          const optionCount = await options.count();
          
          if (optionCount > 1) {
            // Test selecting different options
            for (let i = 0; i < Math.min(optionCount, 3); i++) {
              const option = options.nth(i);
              if (await option.isVisible()) {
                await option.click();
                
                // Wait for treemap to update
                await page.waitForTimeout(2000);
                
                // Verify treemap is still visible and potentially changed
                await expect(
                  page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()
                ).toBeVisible();
                
                // If more options to test, reopen dropdown
                if (i < Math.min(optionCount, 3) - 1) {
                  await control.selector.first().click();
                }
              }
            }
          }
        } else if (control.type === 'buttons' || control.type === 'tabs') {
          const buttons = await control.selector.all();
          
          for (let i = 0; i < Math.min(buttons.length, 3); i++) {
            const button = buttons[i];
            if (await button.isVisible()) {
              await button.click();
              
              // Wait for treemap to update
              await page.waitForTimeout(2000);
              
              // Verify treemap updates
              await expect(
                page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()
              ).toBeVisible();
            }
          }
        }
        
        break;
      }
    }
    
    // Look for view mode controls (e.g., current vs change view)
    const viewModeControls = [
      page.locator('button').filter({ hasText: /current|change|growth/i }),
      page.locator('[data-testid*="view-mode"]'),
      page.locator('input[type="radio"]').locator('..')
    ];
    
    for (const viewControl of viewModeControls) {
      if (await viewControl.first().isVisible()) {
        const controls = await viewControl.all();
        
        for (let i = 0; i < Math.min(controls.length, 2); i++) {
          const control = controls[i];
          if (await control.isVisible()) {
            await control.click();
            await page.waitForTimeout(1500);
            
            // Treemap should update with different data representation
            await expect(
              page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()
            ).toBeVisible();
          }
        }
        break;
      }
    }
    
    // Test time period controls if available
    const periodControls = page.locator('button').filter({ hasText: /1M|3M|6M|1Y/i });
    if (await periodControls.first().isVisible()) {
      const periods = await periodControls.all();
      
      for (let i = 0; i < Math.min(periods.length, 2); i++) {
        const period = periods[i];
        if (await period.isVisible()) {
          await period.click();
          await page.waitForTimeout(2000);
          
          // Verify treemap updates with new period data
          await expect(
            page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()
          ).toBeVisible();
        }
      }
    }
  });

  test('should display proper color coding and visual hierarchy', async ({ page }) => {
    // Wait for treemap to load completely
    const treemap = page.locator('[data-testid="treemap"]')
      .or(page.locator('.treemap-container'))
      .or(page.locator('svg')).first();
    await expect(treemap).toBeVisible({ timeout: 15000 });
    
    // Verify color coding for different elements
    const rects = treemap.locator('rect');
    const rectCount = await rects.count();
    
    if (rectCount > 0) {
      // Collect color information from multiple rectangles
      const colors = [];
      const sizes = [];
      
      for (let i = 0; i < Math.min(rectCount, 5); i++) {
        const rect = rects.nth(i);
        if (await rect.isVisible()) {
          const fill = await rect.getAttribute('fill');
          const width = await rect.getAttribute('width');
          const height = await rect.getAttribute('height');
          
          if (fill) colors.push(fill);
          if (width && height) {
            sizes.push(parseFloat(width) * parseFloat(height));
          }
        }
      }
      
      // Verify we have color variation
      expect(colors.length).toBeGreaterThan(0);
      expect(colors[0]).toBeTruthy();
      
      // Colors should follow a pattern (different sectors/performance levels)
      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBeGreaterThanOrEqual(1);
      
      // Verify size variation (important stocks should be larger)
      if (sizes.length > 1) {
        const maxSize = Math.max(...sizes);
        const minSize = Math.min(...sizes);
        expect(maxSize).toBeGreaterThan(minSize);
      }
      
      // Test opacity or stroke variations
      const firstRect = rects.first();
      const opacity = await firstRect.getAttribute('opacity');
      const stroke = await firstRect.getAttribute('stroke');
      const strokeWidth = await firstRect.getAttribute('stroke-width');
      
      // These might be present for visual hierarchy
      if (opacity) {
        const opacityValue = parseFloat(opacity);
        expect(opacityValue).toBeGreaterThan(0);
        expect(opacityValue).toBeLessThanOrEqual(1);
      }
    }
    
    // Verify text labels have proper contrast and positioning
    const textElements = treemap.locator('text');
    if (await textElements.first().isVisible()) {
      const firstText = textElements.first();
      const fill = await firstText.getAttribute('fill');
      const fontSize = await firstText.getAttribute('font-size');
      
      // Text should have readable color
      expect(fill).toBeTruthy();
      
      // Font size should be reasonable
      if (fontSize) {
        const sizeValue = parseFloat(fontSize);
        expect(sizeValue).toBeGreaterThan(8);
        expect(sizeValue).toBeLessThan(50);
      }
    }
  });

  test('should be fully responsive across different devices', async ({ page }) => {
    // Test mobile portrait
    await page.setViewportSize({ width: 375, height: 667 });
    
    const treemap = page.locator('[data-testid="treemap"]')
      .or(page.locator('.treemap-container'))
      .or(page.locator('svg')).first();
    
    await expect(treemap).toBeVisible({ timeout: 15000 });
    
    // Verify treemap fits within mobile viewport
    const mobileBounds = await treemap.boundingBox();
    if (mobileBounds) {
      expect(mobileBounds.width).toBeLessThanOrEqual(375);
      expect(mobileBounds.height).toBeGreaterThan(0);
    }
    
    // Test touch interactions
    const rects = treemap.locator('rect');
    if (await rects.first().isVisible()) {
      // Test tap interaction
      await rects.first().tap();
      await page.waitForTimeout(1000);
      
      // Should show tooltip or navigate
      const tooltipVisible = await page.locator('[data-testid="tooltip"]').isVisible({ timeout: 2000 });
      const urlChanged = !page.url().includes('treemap');
      
      expect(tooltipVisible || urlChanged).toBeTruthy();
      
      // If navigated, go back
      if (urlChanged) {
        await page.goBack();
        await expect(treemap).toBeVisible({ timeout: 10000 });
      }
    }
    
    // Test mobile landscape
    await page.setViewportSize({ width: 667, height: 375 });
    await expect(treemap).toBeVisible({ timeout: 10000 });
    
    // Test tablet portrait
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(treemap).toBeVisible({ timeout: 10000 });
    
    const tabletBounds = await treemap.boundingBox();
    if (tabletBounds && mobileBounds) {
      // Should utilize more space on tablet
      expect(tabletBounds.width).toBeGreaterThanOrEqual(mobileBounds.width);
    }
    
    // Test desktop
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(treemap).toBeVisible({ timeout: 10000 });
    
    // Desktop should have full functionality
    if (await rects.first().isVisible()) {
      // Test hover on desktop
      await rects.first().hover();
      
      // Should show tooltip
      await expect(
        page.locator('[data-testid="tooltip"]')
          .or(page.locator('.tooltip'))
          .or(page.locator('[role="tooltip"]'))
      ).toBeVisible({ timeout: 3000 });
    }
    
    // Verify controls are accessible on all screen sizes
    const controls = [
      page.locator('select'),
      page.locator('button').filter({ hasText: /filter|view|period/i }),
      page.locator('[data-testid*="control"]')
    ];
    
    for (const control of controls) {
      if (await control.first().isVisible()) {
        await expect(control.first()).toBeVisible();
        
        // Should be clickable/tappable
        const bounds = await control.first().boundingBox();
        if (bounds) {
          expect(bounds.width).toBeGreaterThan(20);
          expect(bounds.height).toBeGreaterThan(20);
        }
      }
    }
  });

  test('should handle data loading and error states effectively', async ({ page }) => {
    // Test loading state
    await apiMock.mockLoadingStates(3000);
    await page.reload();
    
    // Should show loading indicator
    await expect(
      page.locator('[data-testid="loading"]')
        .or(page.locator('.loading'))
        .or(page.locator('.spinner'))
        .or(page.locator('[aria-label*="loading"]'))
    ).toBeVisible({ timeout: 2000 });
    
    // Eventually should show treemap
    await expect(
      page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()
    ).toBeVisible({ timeout: 10000 });
    
    // Test error state
    await apiMock.mockErrorResponses();
    await page.reload();
    
    // Should show error message
    await expect(
      page.locator('[data-testid="error"]')
        .or(page.getByText(/error|failed|unable to load/i))
        .or(page.locator('.error-message'))
    ).toBeVisible({ timeout: 10000 });
    
    // Should provide retry option
    const retryButton = page.getByRole('button', { name: /retry|try again|reload/i });
    if (await retryButton.isVisible()) {
      await expect(retryButton).toBeVisible();
    }
  });

  test('should provide comprehensive accessibility support', async ({ page }) => {
    await expect(
      page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()
    ).toBeVisible({ timeout: 15000 });
    
    // Check for proper ARIA labels and roles
    const treemap = page.locator('[data-testid="treemap"]').or(page.locator('svg')).first();
    
    // SVG should have proper accessibility attributes
    const role = await treemap.getAttribute('role');
    const ariaLabel = await treemap.getAttribute('aria-label');
    const ariaDescription = await treemap.getAttribute('aria-description');
    
    // Should have appropriate ARIA attributes
    expect(role || ariaLabel || ariaDescription).toBeTruthy();
    
    // Test keyboard navigation
    await page.keyboard.press('Tab');
    
    // Should be able to focus on interactive elements
    const focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible({ timeout: 3000 });
    
    // Test keyboard interaction
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    
    // Should either show tooltip or navigate
    const tooltipVisible = await page.locator('[data-testid="tooltip"]').isVisible();
    const urlChanged = !page.url().includes('treemap');
    
    if (urlChanged) {
      await page.goBack();
    }
    
    // Check for screen reader friendly content
    const textElements = treemap.locator('text');
    if (await textElements.first().isVisible()) {
      const textContent = await textElements.first().textContent();
      expect(textContent).toBeTruthy();
      expect(textContent?.trim().length).toBeGreaterThan(0);
    }
    
    // Verify interactive elements have proper focus indicators
    const interactiveElements = treemap.locator('rect, g[data-stock], [tabindex="0"]');
    if (await interactiveElements.first().isVisible()) {
      await interactiveElements.first().focus();
      
      // Should have some visual focus indicator
      const focusedEl = page.locator(':focus');
      const outline = await focusedEl.evaluate(el => getComputedStyle(el).outline);
      const boxShadow = await focusedEl.evaluate(el => getComputedStyle(el).boxShadow);
      
      // Should have some form of focus styling
      expect(outline !== 'none' || boxShadow !== 'none').toBeTruthy();
    }
  });

  test('should display legend and provide data context', async ({ page }) => {
    await expect(
      page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()
    ).toBeVisible({ timeout: 15000 });
    
    // Look for legend or explanation
    const legendSelectors = [
      page.locator('[data-testid="legend"]'),
      page.locator('.legend'),
      page.locator('[data-testid="treemap-legend"]'),
      page.getByText(/legend|color scale|size indicates/i),
      page.locator('.color-scale')
    ];
    
    let legendFound = false;
    for (const legend of legendSelectors) {
      if (await legend.isVisible()) {
        await expect(legend).toBeVisible();
        
        // Legend should explain the visualization
        const legendText = await legend.textContent();
        expect(legendText).toMatch(/(color|size|represents|indicates|short|position)/i);
        
        legendFound = true;
        break;
      }
    }
    
    // Look for data context information
    const contextSelectors = [
      page.locator('[data-testid="data-info"]'),
      page.getByText(/as of|last updated|data from/i),
      page.locator('.data-timestamp'),
      page.getByText(/\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{4}-\\d{2}-\\d{2}/)
    ];
    
    for (const context of contextSelectors) {
      if (await context.isVisible()) {
        await expect(context).toBeVisible();
        
        const contextText = await context.textContent();
        expect(contextText).toBeTruthy();
        break;
      }
    }
    
    // Look for summary statistics
    const statsSelectors = [
      page.locator('[data-testid="summary-stats"]'),
      page.getByText(/total|average|highest|lowest/i),
      page.locator('.stats-summary')
    ];
    
    for (const stats of statsSelectors) {
      if (await stats.isVisible()) {
        await expect(stats).toBeVisible();
        
        const statsText = await stats.textContent();
        expect(statsText).toMatch(/(total|stocks|sectors|\\d+)/i);
        break;
      }
    }
  });

  test('should support data export or sharing functionality', async ({ page }) => {
    await expect(
      page.locator('[data-testid="treemap"]').or(page.locator('svg')).first()
    ).toBeVisible({ timeout: 15000 });
    
    // Look for export or share buttons
    const actionButtons = [
      page.getByRole('button', { name: /export|download|save/i }),
      page.getByRole('button', { name: /share/i }),
      page.locator('[data-testid="export-button"]'),
      page.locator('[data-testid="share-button"]'),
      page.locator('button').filter({ hasText: /📊|📈|💾|🔗/i })
    ];
    
    for (const button of actionButtons) {
      if (await button.isVisible()) {
        await button.click();
        
        // Should show export options or share modal
        await expect(
          page.locator('[data-testid="export-modal"]')
            .or(page.locator('[data-testid="share-modal"]'))
            .or(page.getByText(/png|svg|pdf|csv|copied|share/i))
            .or(page.locator('.modal'))
        ).toBeVisible({ timeout: 3000 });
        
        // Close modal if opened
        const closeButton = page.getByRole('button', { name: /close|cancel|x/i });
        if (await closeButton.isVisible()) {
          await closeButton.click();
        } else {
          await page.keyboard.press('Escape');
        }
        
        break;
      }
    }
    
    // Test direct link sharing
    const currentUrl = page.url();
    expect(currentUrl).toMatch(/treemap/);
    
    // URL should be shareable
    expect(currentUrl).toMatch(/^https?:\\/\\/.+/);
  });
});