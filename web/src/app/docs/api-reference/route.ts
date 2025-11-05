import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import path from "path";

// Note: Cannot use Edge runtime as we need fs/path modules
export async function GET() {
  try {
    const filePath = path.join(
      process.cwd(),
      "public",
      "docs",
      "api-reference.md",
    );
    const content = await readFile(filePath, "utf-8");

    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
        "X-Robots-Tag": "index, follow",
        // LLM-specific headers
        "X-LLM-Friendly": "true",
        "X-AI-Indexable": "true",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Documentation not found" },
      { status: 404 },
    );
  }
}
