import { expect, test, type Locator, type Page } from "@playwright/test";

type ViewportSize = {
  width: number;
  height: number;
};

const viewports: ViewportSize[] = [
  { width: 320, height: 568 },
  { width: 375, height: 812 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1366, height: 900 },
  { width: 1440, height: 900 },
];

const navLabels = ["Command Center", "Artifacts", "Workflows", "Settings"] as const;

async function completeSetupBeforeLoad(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("raven:setup-complete", "true");
  });
}

async function openAppWithCompletedSetup(page: Page, viewport: ViewportSize) {
  await page.setViewportSize(viewport);
  await completeSetupBeforeLoad(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await assertNoHorizontalOverflow(page);
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const offenders = Array.from(document.querySelectorAll("*"))
      .map((element) => {
        const box = element.getBoundingClientRect();
        const overflowLeft = Math.max(0, -box.left);
        const overflowRight = Math.max(0, box.right - viewportWidth);
        const overflow = Math.max(overflowLeft, overflowRight);

        return {
          selector: `${element.tagName.toLowerCase()}${
            element.id ? `#${element.id}` : ""
          }${Array.from(element.classList)
            .slice(0, 3)
            .map((className) => `.${className}`)
            .join("")}`,
          text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
          left: Math.round(box.left),
          right: Math.round(box.right),
          width: Math.round(box.width),
          overflow: Math.round(overflow),
        };
      })
      .filter((entry) => entry.overflow > 1)
      .sort((left, right) => right.overflow - left.overflow)
      .slice(0, 8);

    return { scrollWidth, clientWidth: viewportWidth, offenders };
  });

  expect(
    overflow.scrollWidth,
    `document must not overflow horizontally: scrollWidth=${overflow.scrollWidth}, clientWidth=${overflow.clientWidth}${overflow.offenders.length ? `; offenders=${overflow.offenders.map((offender) => `${offender.selector} [left=${offender.left}, right=${offender.right}, width=${offender.width}, overflow=${offender.overflow}]${offender.text ? ` "${offender.text}"` : ""}`).join(" | ")}` : ""}`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function assertFitsViewport(locator: Locator, label: string) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} should have a layout box`).not.toBeNull();
  if (!box) return;

  const viewport = locator.page().viewportSize();
  expect(viewport, "viewport should be configured").not.toBeNull();
  if (!viewport) return;

  expect(box.x, `${label} left edge should fit viewport`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `${label} top edge should fit viewport`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} right edge should fit viewport`).toBeLessThanOrEqual(
    viewport.width + 1,
  );
  expect(box.y + box.height, `${label} bottom edge should fit viewport`).toBeLessThanOrEqual(
    viewport.height + 1,
  );
}

async function assertPrimaryNavLabelsVisibleAndUnclipped(page: Page) {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav).toBeVisible();

  for (const label of navLabels) {
    const button = nav.getByRole("button", { name: label });
    const text = button.getByText(label, { exact: true });
    await expect(button).toBeVisible();
    await expect(text).toBeVisible();

    const boxes = await Promise.all([button.boundingBox(), text.boundingBox()]);
    const [buttonBox, textBox] = boxes;
    expect(buttonBox, `${label} nav button should have a layout box`).not.toBeNull();
    expect(textBox, `${label} nav label should have a layout box`).not.toBeNull();
    if (!buttonBox || !textBox) continue;

    expect(textBox.width, `${label} nav label should not be clipped to zero width`).toBeGreaterThan(
      1,
    );
    const labelLayout = await text.evaluate((element) => ({
      clientWidth: Math.ceil(element.clientWidth),
      scrollWidth: Math.ceil(element.scrollWidth),
    }));
    expect(
      labelLayout.scrollWidth,
      `${label} nav label should render its full text without clipping`,
    ).toBeLessThanOrEqual(labelLayout.clientWidth + 1);
    expect(textBox.x, `${label} nav label should not clip past button left`).toBeGreaterThanOrEqual(
      buttonBox.x - 1,
    );
    expect(
      textBox.x + textBox.width,
      `${label} nav label should not clip past button right`,
    ).toBeLessThanOrEqual(buttonBox.x + buttonBox.width + 1);
  }
}

test("mobile primary navigation labels render unclipped at 390x844", async ({ page }) => {
  await openAppWithCompletedSetup(page, { width: 390, height: 844 });
  await assertPrimaryNavLabelsVisibleAndUnclipped(page);
});

async function navigateTo(page: Page, label: (typeof navLabels)[number], heading = label) {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: label })
    .click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await assertNoHorizontalOverflow(page);
}

async function expectFocusInside(page: Page, locator: Locator, label: string) {
  const containsFocus = await locator.evaluate((element) =>
    element.contains(document.activeElement),
  );
  expect(containsFocus, `${label} should contain active focus`).toBe(true);
}

async function assertVisibleFormControlsUseMobileSafeTextSize(page: Page) {
  const tooSmall = await page.locator("input, textarea").evaluateAll((controls) =>
    controls
      .filter((control) => {
        const element = control as HTMLElement;
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          box.width > 0 &&
          box.height > 0
        );
      })
      .map((control) => {
        const element = control as HTMLElement;
        return {
          tag: element.tagName.toLowerCase(),
          ariaLabel: element.getAttribute("aria-label"),
          placeholder: element.getAttribute("placeholder"),
          fontSize: Number.parseFloat(window.getComputedStyle(element).fontSize),
        };
      })
      .filter((control) => control.fontSize < 16),
  );

  expect(tooSmall, "visible inputs and textareas should use at least 16px text").toEqual([]);
}

async function assertPrimaryActionHasSolidContrast(page: Page) {
  const primaryAction = page.locator(".primary-action").filter({ hasText: /create workflow/i }).first();
  await expect(primaryAction).toBeVisible();

  const colors = await primaryAction.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      color: style.color,
    };
  });

  const transparent = /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0\s*)?\)|transparent/i;
  expect(colors.color, "primary action foreground must not be transparent").not.toMatch(transparent);
  expect(
    `${colors.backgroundColor} ${colors.backgroundImage}`,
    "primary action background must not be transparent",
  ).not.toMatch(/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0\s*)?\)\s+none$|transparent/i);
  expect(
    `${colors.backgroundColor} ${colors.backgroundImage}`,
    "primary action foreground and background should differ",
  ).not.toContain(colors.color);
}

async function assertVisibleMetadataKeepsReadableOpacity(page: Page) {
  const selectors = [
    ".workspace small",
    ".workflow-roster-name span",
    ".workflow-roster-status small",
    ".workflow-roster-metric span",
  ];

  for (const selector of selectors) {
    const visibleCount = await page.locator(selector).evaluateAll((elements) =>
      elements.filter((element) => {
        const node = element as HTMLElement;
        const style = window.getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          box.width > 0 &&
          box.height > 0
        );
      }).length,
    );

    expect(visibleCount, `${selector} should cover visible metadata`).toBeGreaterThan(0);
  }

  const lowOpacityMetadata = await page.evaluate((targetSelectors) => {
    const selectorText = targetSelectors.join(",");

    return Array.from(document.querySelectorAll(selectorText))
      .filter((element) => {
        const node = element as HTMLElement;
        const style = window.getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          box.width > 0 &&
          box.height > 0
        );
      })
      .map((element) => {
        let effectiveOpacity = 1;
        let current: Element | null = element;

        while (current) {
          const opacity = Number.parseFloat(window.getComputedStyle(current).opacity);
          effectiveOpacity *= Number.isFinite(opacity) ? opacity : 1;
          current = current.parentElement;
        }

        return {
          selector: targetSelectors.find((targetSelector) => element.matches(targetSelector)),
          text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
          opacity: Number(effectiveOpacity.toFixed(3)),
        };
      })
      .filter((entry) => entry.opacity < 0.72);
  }, selectors);

  expect(lowOpacityMetadata, "visible dark-mode metadata should not render below 0.72 opacity").toEqual([]);
}

async function assertReducedMotionHasNoVisibleLongMotion(page: Page) {
  const offenders = await page.evaluate(() => {
    const parseTimes = (value: string) =>
      value.split(",").map((part) => {
        const trimmed = part.trim();
        if (trimmed.endsWith("ms")) return Number.parseFloat(trimmed) / 1000;
        if (trimmed.endsWith("s")) return Number.parseFloat(trimmed);
        return Number.parseFloat(trimmed) || 0;
      });

    return Array.from(document.querySelectorAll("*"))
      .filter((element) => {
        const node = element as HTMLElement;
        const style = window.getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          box.width > 0 &&
          box.height > 0
        );
      })
      .map((element) => {
        const style = window.getComputedStyle(element);
        const animationDurations = parseTimes(style.animationDuration);
        const transitionDurations = parseTimes(style.transitionDuration);
        const animationNames = style.animationName.split(",").map((part) => part.trim());
        const hasAnimation = animationNames.some((name) => name && name !== "none");
        const longestAnimation = Math.max(...animationDurations, 0);
        const longestTransition = Math.max(...transitionDurations, 0);
        return {
          element: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).replace(/\s+/g, ".")}` : ""}`,
          animationName: style.animationName,
          animationDuration: longestAnimation,
          transitionDuration: longestTransition,
        };
      })
      .filter(
        (entry) =>
          (entry.animationName !== "none" && entry.animationDuration > 0.01) ||
          entry.transitionDuration > 0.2,
      );
  });

  expect(
    offenders,
    "visible elements should not use nonessential animation or long transitions under reduced motion",
  ).toEqual([]);
}

for (const viewport of viewports) {
  test(`completed setup core surfaces fit ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await openAppWithCompletedSetup(page, viewport);
    await assertPrimaryNavLabelsVisibleAndUnclipped(page);

    await navigateTo(page, "Workflows");
    await page.getByRole("button", { name: "Open Current Weather details", exact: true }).click();
    await expect(page.getByLabel("Visual workflow builder")).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await navigateTo(page, "Artifacts");
    await navigateTo(page, "Settings");
    await navigateTo(page, "Command Center");
  });
}

for (const viewport of [
  { width: 1366, height: 900 },
  { width: 1440, height: 900 },
]) {
  test(`workflows roster does not overflow ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await openAppWithCompletedSetup(page, viewport);
    await navigateTo(page, "Workflows");
    await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
}

test("workflows compact mode keeps rows scannable", async ({ page }) => {
  await openAppWithCompletedSetup(page, { width: 1440, height: 900 });
  await navigateTo(page, "Workflows");
  await page.getByRole("button", { name: "Compact" }).click();

  const heights = await page.locator(".workflow-roster-row").evaluateAll((rows) =>
    rows.map((row) => Math.round(row.getBoundingClientRect().height)),
  );

  expect(heights.length).toBeGreaterThan(0);
  expect(Math.max(...heights), `compact row heights: ${heights.join(", ")}`).toBeLessThanOrEqual(190);
});

test("assistant drawer fits without horizontal overflow", async ({ page }) => {
  await openAppWithCompletedSetup(page, { width: 320, height: 568 });

  await page.getByRole("button", { name: "Open Raven assistant" }).click();
  const assistant = page.getByRole("dialog", { name: "Your AI assistant" });
  await assertFitsViewport(assistant, "assistant drawer");
  await expect
    .poll(() => assistant.evaluate((element) => window.getComputedStyle(element).opacity))
    .toBe("1");
  await expect(page.locator(".raven-app-background")).toHaveAttribute("aria-hidden", "true");
  await expectFocusInside(page, assistant, "assistant drawer");
  await page.keyboard.press("Tab");
  await expectFocusInside(page, assistant, "assistant drawer after Tab");
  await assertNoHorizontalOverflow(page);

  const drawerLayout = await assistant.evaluate((element) => {
    const style = window.getComputedStyle(element);
    const messagePane = element.querySelector(".assistant-drawer-messages") as HTMLElement | null;
    const header = element.querySelector(".assistant-drawer-header") as HTMLElement | null;
    const composer = element.querySelector(".assistant-drawer-composer") as HTMLElement | null;
    const emptyState = element.querySelector(".assistant-empty-state") as HTMLElement | null;
    const firstMessageChild = messagePane?.firstElementChild as HTMLElement | null;
    return {
      zIndex: Number.parseInt(style.zIndex, 10),
      backgroundColor: style.backgroundColor,
      scrollLeft: messagePane?.scrollLeft ?? -1,
      scrollTop: messagePane?.scrollTop ?? -1,
      headerTop: header?.getBoundingClientRect().top ?? -1,
      messageTop: messagePane?.getBoundingClientRect().top ?? -1,
      firstChildTop: firstMessageChild?.getBoundingClientRect().top ?? -1,
      emptyTop: emptyState?.getBoundingClientRect().top ?? -1,
      composerBottom: composer?.getBoundingClientRect().bottom ?? -1,
      viewportHeight: window.innerHeight,
    };
  });
  expect(drawerLayout.zIndex, "assistant drawer should sit above status popovers, toasts, and FAB").toBeGreaterThan(90);
  expect(drawerLayout.backgroundColor, "assistant drawer surface should be opaque").not.toMatch(/rgba\([^)]*,\s*0(?:\.0+)?\)/);
  expect(drawerLayout.scrollLeft).toBe(0);
  expect(drawerLayout.scrollTop, "empty assistant should start at top on mobile").toBeLessThanOrEqual(1);
  expect(drawerLayout.headerTop, "assistant header should stay pinned to viewport top").toBeLessThanOrEqual(1);
  expect(drawerLayout.firstChildTop, "assistant content should start at message pane top").toBeGreaterThanOrEqual(drawerLayout.messageTop - 1);
  expect(drawerLayout.emptyTop, "assistant empty card should not open mid-card").toBeGreaterThanOrEqual(drawerLayout.messageTop - 1);
  expect(drawerLayout.composerBottom, "assistant composer should fit at viewport bottom").toBeLessThanOrEqual(drawerLayout.viewportHeight + 1);

  await page.keyboard.press("Escape");
  await expect(assistant).toBeHidden();
  await expect(page.getByRole("button", { name: "Open Raven assistant" })).toBeFocused();
});

test("assistant drawer closes with Escape when reduced motion disables animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openAppWithCompletedSetup(page, { width: 1024, height: 768 });

  await page.getByRole("button", { name: "Open Raven assistant" }).click();
  const assistant = page.getByRole("dialog", { name: "Your AI assistant" });
  await expect(assistant).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(assistant).toBeHidden();
  await expect(page.locator(".raven-app-background")).not.toHaveAttribute("aria-hidden", "true");
  await page.getByRole("button", { name: "Search (Cmd+K)" }).focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
});

test("usage command panel stacks at narrow command-center widths", async ({ page }) => {
  await openAppWithCompletedSetup(page, { width: 1366, height: 900 });

  const usage = page.getByRole("region", { name: "Usage and cost command panel" });
  await expect(usage).toBeVisible();
  await usage.scrollIntoViewIfNeeded();

  const layout = await usage.evaluate((element) => {
    function columns(selector: string) {
      const target = element.querySelector(selector);
      if (!target) return 0;
      const value = window.getComputedStyle(target).gridTemplateColumns;
      return value === "none" ? 0 : value.split(" ").filter(Boolean).length;
    }

    return {
      metrics: columns(".usage-command-metrics"),
      charts: columns(".usage-command-grid"),
      insights: columns(".usage-insight-grid"),
      panelWidth: Math.round(element.getBoundingClientRect().width),
      awkwardBreaks: Array.from(element.querySelectorAll("span, small, strong, p"))
        .filter((node) => {
          const text = (node.textContent ?? "").trim();
          const box = (node as HTMLElement).getBoundingClientRect();
          return text.length > 2 && box.width <= 12 && box.height > 0;
        })
        .map((node) => (node.textContent ?? "").trim())
        .slice(0, 8),
    };
  });

  expect(layout.metrics, `usage metric columns at ${layout.panelWidth}px`).toBe(1);
  expect(layout.charts, `usage chart columns at ${layout.panelWidth}px`).toBe(1);
  expect(layout.insights, `usage insight columns at ${layout.panelWidth}px`).toBe(1);
  expect(layout.awkwardBreaks, "usage panel should avoid single-character text columns").toEqual([]);
});

test("command palette fits without horizontal overflow and is modal", async ({ page }) => {
  await openAppWithCompletedSetup(page, { width: 320, height: 568 });
  await page.getByRole("button", { name: "Search (Cmd+K)" }).focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await assertFitsViewport(palette, "command palette");
  await assertNoHorizontalOverflow(page);
  await expect(palette).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".raven-app-background")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("combobox", { name: "Search workflows, artifacts, and actions" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expectFocusInside(page, palette, "command palette after Tab");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(page.getByRole("button", { name: "Search (Cmd+K)" })).toBeFocused();
});

test("mobile form controls use text large enough to avoid zoom", async ({ page }) => {
  await openAppWithCompletedSetup(page, { width: 375, height: 812 });

  await page.getByRole("button", { name: "Open Raven assistant" }).click();
  await expect(page.getByRole("dialog", { name: "Your AI assistant" })).toBeVisible();
  await assertVisibleFormControlsUseMobileSafeTextSize(page);

  await page.keyboard.press("Escape");
  await navigateTo(page, "Settings");
  await assertVisibleFormControlsUseMobileSafeTextSize(page);
});

test("mobile onboarding keeps primary action visible and tappable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    window.localStorage.removeItem("raven:setup-complete");
    window.localStorage.removeItem("raven:setup-complete");
  });
  await page.goto("/");

  const valueStatement = page.getByText(
    "Set up a local command center for useful workflows, visible context, safe approvals, and traceable output.",
  );
  const getStarted = page.getByRole("button", { name: "Get started" });
  await expect(valueStatement).toBeVisible();
  await expect(getStarted).toBeVisible();

  const [valueBox, actionBox] = await Promise.all([
    valueStatement.boundingBox(),
    getStarted.boundingBox(),
  ]);
  expect(valueBox?.y).toBeGreaterThanOrEqual(0);
  expect(valueBox ? valueBox.y + valueBox.height : undefined).toBeLessThanOrEqual(844);
  expect(actionBox?.height).toBeGreaterThanOrEqual(44);
  expect(actionBox ? actionBox.y + actionBox.height : undefined).toBeLessThanOrEqual(844);
  await assertNoHorizontalOverflow(page);
});

test("setup provider step keeps primary actions reachable at desktop height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.removeItem("raven:setup-complete");
    window.localStorage.removeItem("raven:setup-complete");
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Connect AI provider" })).toBeVisible();

  const actions = page.locator(".wizard-step-actions");
  await expect(actions).toBeVisible();
  await assertFitsViewport(actions, "provider setup actions");
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip" })).toBeVisible();
  await assertNoHorizontalOverflow(page);
});

test("mobile command center priority actions are at least 44px tall", async ({ page }) => {
  await openAppWithCompletedSetup(page, { width: 390, height: 844 });

  const primaryAction = page.locator(".command-center-priority .primary-action").first();
  await expect(primaryAction).toBeVisible();
  const actionBox = await primaryAction.boundingBox();
  expect(actionBox?.height).toBeGreaterThanOrEqual(44);
});

test("mobile artifacts workflow filter is not covered by assistant FAB", async ({ page }) => {
  await openAppWithCompletedSetup(page, { width: 390, height: 844 });
  await navigateTo(page, "Artifacts");

  const workflowFilter = page.locator(".artifact-filters select").last();
  const assistantFab = page.getByRole("button", { name: "Open Raven assistant" });
  await expect(workflowFilter).toBeVisible();
  await expect(assistantFab).toBeVisible();

  const [filterBox, fabBox] = await Promise.all([
    workflowFilter.boundingBox(),
    assistantFab.boundingBox(),
  ]);
  expect(filterBox, "workflow filter should have a layout box").not.toBeNull();
  expect(fabBox, "assistant FAB should have a layout box").not.toBeNull();
  if (!filterBox || !fabBox) return;

  const overlaps =
    filterBox.x < fabBox.x + fabBox.width &&
    filterBox.x + filterBox.width > fabBox.x &&
    filterBox.y < fabBox.y + fabBox.height &&
    filterBox.y + filterBox.height > fabBox.y;

  expect(overlaps, "assistant FAB should not overlap the Artifacts workflow filter").toBe(false);
});

test("primary actions keep nontransparent foreground and background across themes", async ({
  page,
}) => {
  await openAppWithCompletedSetup(page, { width: 1366, height: 900 });

  await assertPrimaryActionHasSolidContrast(page);
  await page.getByRole("button", { name: "Switch to Light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora-light");
  await assertPrimaryActionHasSolidContrast(page);

  await page.getByRole("button", { name: "Switch to Dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora-dark");
  await assertPrimaryActionHasSolidContrast(page);
});

test("dark mode keeps visible metadata readable", async ({ page }) => {
  await openAppWithCompletedSetup(page, { width: 1366, height: 900 });
  const theme = await page.locator("html").getAttribute("data-theme");

  if (theme !== "aurora-dark") {
    await page.getByRole("button", { name: "Switch to Dark mode" }).click();
  }

  await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora-dark");

  await navigateTo(page, "Workflows");
  await page.getByRole("button", { name: "Cards" }).click();
  await expect(page.getByRole("region", { name: "Workflow roster cards" })).toBeVisible();
  await assertVisibleMetadataKeepsReadableOpacity(page);
});

test("red is reserved for primary and danger states", async ({ page }) => {
  await openAppWithCompletedSetup(page, { width: 1366, height: 900 });
  await navigateTo(page, "Workflows");
  await page.getByRole("button", { name: "Open Current Weather details", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Current Weather" })).toBeVisible();

  const baselineColors = await page.evaluate(() => {
    const capture = (selector: string) => {
      const element = document.querySelector(selector) as HTMLElement | null;
      if (!element) throw new Error(`Missing ${selector}`);

      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        color: style.color,
      };
    };

    return {
      primary: capture(".primary-action"),
      danger: capture(".danger-action"),
    };
  });

  await navigateTo(page, "Settings");

  const colors = await page.evaluate(() => {
    const capture = (selector: string) => {
      const element = document.querySelector(selector) as HTMLElement | null;
      if (!element) throw new Error(`Missing ${selector}`);

      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        color: style.color,
      };
    };

    return {
      activeNav: capture(".nav-item.active"),
      settingsActive: capture(".settings-nav-item.active"),
    };
  });

  expect(colors.activeNav.backgroundColor).not.toBe(baselineColors.primary.backgroundColor);
  expect(colors.activeNav.backgroundColor).not.toBe(baselineColors.danger.backgroundColor);
  expect(colors.activeNav.borderColor).not.toBe(baselineColors.primary.borderColor);
  expect(colors.activeNav.borderColor).not.toBe(baselineColors.danger.borderColor);
  expect(colors.activeNav.boxShadow).not.toBe(baselineColors.primary.boxShadow);
  expect(colors.activeNav.boxShadow).not.toBe(baselineColors.danger.boxShadow);

  expect(colors.settingsActive.backgroundColor).not.toBe(baselineColors.primary.backgroundColor);
  expect(colors.settingsActive.backgroundColor).not.toBe(baselineColors.danger.backgroundColor);
  expect(colors.settingsActive.color).not.toBe(baselineColors.primary.color);
  expect(colors.settingsActive.color).not.toBe(baselineColors.danger.color);
});

test("assistant composer keeps neutral default, focus, and error color roles separate", async ({
  page,
}) => {
  await openAppWithCompletedSetup(page, { width: 1366, height: 900 });
  await page.getByRole("button", { name: "Open Raven assistant" }).click();

  const textarea = page.locator(".assistant-drawer-composer textarea");
  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(textarea).toBeVisible();
  await expect(sendButton).toBeDisabled();
  await textarea.focus();
  await textarea.evaluate((element) => {
    (element as HTMLTextAreaElement).blur();
  });

  const defaultStyles = await textarea.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      outlineColor: style.outlineColor,
    };
  });

  await textarea.focus();

  const focusStyles = await textarea.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      outlineColor: style.outlineColor,
    };
  });

  const errorStyles = await textarea.evaluate((element) => {
    element.setAttribute("aria-invalid", "true");
    const style = window.getComputedStyle(element);
    element.removeAttribute("aria-invalid");
    return {
      borderColor: style.borderColor,
      outlineColor: style.outlineColor,
    };
  });

  expect(defaultStyles.borderColor).not.toBe(focusStyles.borderColor);
  expect(defaultStyles.borderColor).not.toBe(errorStyles.borderColor);
  expect(focusStyles.outlineColor).not.toBe(errorStyles.borderColor);
  expect(defaultStyles.borderColor).not.toMatch(/rgb\(220, 38, 38\)|rgb\(214, 63, 68\)/);

  await textarea.fill("Create a workflow that summarizes my week");
  await expect(sendButton).toBeEnabled();
});

test("reduced motion suppresses visible nonessential motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openAppWithCompletedSetup(page, { width: 1366, height: 900 });

  await assertReducedMotionHasNoVisibleLongMotion(page);
  await page.getByRole("button", { name: "Open Raven assistant" }).click();
  await expect(page.getByRole("dialog", { name: "Your AI assistant" })).toBeVisible();
  await assertReducedMotionHasNoVisibleLongMotion(page);
});
