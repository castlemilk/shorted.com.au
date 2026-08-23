import { test, expect } from "@playwright/test";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.AUTH_FIREBASE_PROJECT_ID;
if (!projectId) throw new Error("AUTH_FIREBASE_PROJECT_ID is required");
const stockCode = "CBA";
const seededThreadId = "seeded-community-thread";

function getAdminDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail: process.env.AUTH_FIREBASE_CLIENT_EMAIL ?? "test@example.com",
        privateKey:
          process.env.AUTH_FIREBASE_PRIVATE_KEY ??
          "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n",
      }),
      projectId,
    });
  }

  return getFirestore();
}

test.describe("Stock community public surfaces", () => {
  test.skip(
    !process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST is required for stock community e2e seeding",
  );

  test.beforeAll(async () => {
    const db = getAdminDb();
    const communityDoc = db.collection("stock_communities").doc(stockCode);
    const now = new Date();

    await communityDoc.set({
      headline: "Public seed thread is live",
      subheadline: "1 thread and 1 pulse update live now",
      ctaLabel: "Open community",
      threadCount: 1,
      pulseCount: 1,
      topThread: {
        id: seededThreadId,
        title: "Seeded public catalyst thread",
        commentCount: 0,
        sourceCount: 1,
        lastActivityAt: now,
      },
      latestActivityAt: now,
    });

    await communityDoc.collection("threads").doc(seededThreadId).set({
      stockCode,
      type: "catalyst",
      title: "Seeded public catalyst thread",
      body: "A seeded thread keeps the public read surface deterministic.",
      score: 3,
      commentCount: 0,
      sourceCount: 1,
      highSignal: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      sources: [
        {
          label: "Seed source",
          url: "https://example.com/seed-source",
        },
      ],
    });

    await communityDoc.collection("pulse").doc("seeded-community-pulse").set({
      stockCode,
      body: "Seeded pulse keeps the right rail populated.",
      score: 1,
      replyCount: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });

  test("shows the teaser, community tab, seeded read content, and dedicated thread page", async ({
    page,
  }) => {
    await page.goto(`/shorts/${stockCode}`);

    await expect(page.getByText(`Live on ${stockCode}`)).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByRole("link", { name: /open community/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Community" }),
    ).toBeVisible();

    await page.getByRole("tab", { name: "Community" }).click();

    await expect(page.getByText("Research Threads")).toBeVisible();
    await expect(page.getByText("Live Pulse")).toBeVisible();
    await expect(
      page.getByText("Seeded public catalyst thread"),
    ).toBeVisible();
    await expect(
      page.getByText("Seeded pulse keeps the right rail populated."),
    ).toBeVisible();

    await page.goto(`/shorts/${stockCode}/community/${seededThreadId}`);

    await expect(
      page.getByRole("link", { name: /back to cba community/i }),
    ).toBeVisible();
    await expect(
      page.getByText("Seeded public catalyst thread"),
    ).toBeVisible();
    await expect(page.getByText("Comments")).toBeVisible();
  });
});
