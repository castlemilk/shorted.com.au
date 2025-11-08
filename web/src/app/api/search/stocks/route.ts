import { type NextRequest, NextResponse } from "next/server";
import { rateLimit } from "~/@/lib/rate-limit";

// Note: Cannot use Edge Runtime because auth() requires Node.js runtime

// In a real implementation, this would query your database
// For now, we'll use a comprehensive list of ASX stocks
const ASX_STOCKS = [
  // Top 20 ASX stocks
  { code: "CBA", name: "Commonwealth Bank of Australia", exchange: "ASX" },
  { code: "BHP", name: "BHP Group Limited", exchange: "ASX" },
  { code: "CSL", name: "CSL Limited", exchange: "ASX" },
  { code: "NAB", name: "National Australia Bank", exchange: "ASX" },
  { code: "WBC", name: "Westpac Banking Corporation", exchange: "ASX" },
  {
    code: "ANZ",
    name: "Australia and New Zealand Banking Group",
    exchange: "ASX",
  },
  { code: "WES", name: "Wesfarmers Limited", exchange: "ASX" },
  { code: "MQG", name: "Macquarie Group Limited", exchange: "ASX" },
  { code: "WOW", name: "Woolworths Group Limited", exchange: "ASX" },
  { code: "TLS", name: "Telstra Corporation Limited", exchange: "ASX" },
  { code: "RIO", name: "Rio Tinto Limited", exchange: "ASX" },
  { code: "FMG", name: "Fortescue Metals Group", exchange: "ASX" },
  { code: "GMG", name: "Goodman Group", exchange: "ASX" },
  { code: "TCL", name: "Transurban Group", exchange: "ASX" },
  { code: "WDS", name: "Woodside Energy Group", exchange: "ASX" },
  { code: "NCM", name: "Newcrest Mining Limited", exchange: "ASX" },
  { code: "ALL", name: "Aristocrat Leisure Limited", exchange: "ASX" },
  { code: "COL", name: "Coles Group Limited", exchange: "ASX" },
  { code: "REA", name: "REA Group Limited", exchange: "ASX" },
  { code: "QBE", name: "QBE Insurance Group Limited", exchange: "ASX" },

  // Additional popular stocks
  { code: "APT", name: "Afterpay Limited", exchange: "ASX" },
  { code: "XRO", name: "Xero Limited", exchange: "ASX" },
  { code: "SHL", name: "Sonic Healthcare Limited", exchange: "ASX" },
  { code: "RMD", name: "ResMed Inc", exchange: "ASX" },
  { code: "COH", name: "Cochlear Limited", exchange: "ASX" },
  { code: "IAG", name: "Insurance Australia Group", exchange: "ASX" },
  { code: "SUN", name: "Suncorp Group Limited", exchange: "ASX" },
  { code: "ORG", name: "Origin Energy Limited", exchange: "ASX" },
  { code: "APA", name: "APA Group", exchange: "ASX" },
  { code: "TWE", name: "Treasury Wine Estates", exchange: "ASX" },
  { code: "CPU", name: "Computershare Limited", exchange: "ASX" },
  { code: "MPL", name: "Medibank Private Limited", exchange: "ASX" },
  { code: "AGL", name: "AGL Energy Limited", exchange: "ASX" },
  { code: "ASX", name: "ASX Limited", exchange: "ASX" },
  { code: "STO", name: "Santos Limited", exchange: "ASX" },
  { code: "S32", name: "South32 Limited", exchange: "ASX" },
  { code: "A2M", name: "The a2 Milk Company", exchange: "ASX" },
  { code: "JHX", name: "James Hardie Industries", exchange: "ASX" },
  { code: "SGP", name: "Stockland", exchange: "ASX" },
  { code: "GPT", name: "GPT Group", exchange: "ASX" },

  // Mining & Resources
  { code: "MIN", name: "Mineral Resources Limited", exchange: "ASX" },
  { code: "EVN", name: "Evolution Mining Limited", exchange: "ASX" },
  { code: "NST", name: "Northern Star Resources", exchange: "ASX" },
  { code: "OZL", name: "OZ Minerals Limited", exchange: "ASX" },
  { code: "WHC", name: "Whitehaven Coal Limited", exchange: "ASX" },
  { code: "PLS", name: "Pilbara Minerals Limited", exchange: "ASX" },
  { code: "LYC", name: "Lynas Rare Earths Limited", exchange: "ASX" },
  { code: "IGO", name: "IGO Limited", exchange: "ASX" },
  { code: "NHC", name: "New Hope Corporation", exchange: "ASX" },

  // Tech stocks
  { code: "WTC", name: "WiseTech Global Limited", exchange: "ASX" },
  { code: "ALU", name: "Altium Limited", exchange: "ASX" },
  { code: "NEA", name: "Nearmap Ltd", exchange: "ASX" },
  { code: "APX", name: "Appen Limited", exchange: "ASX" },
  { code: "TNE", name: "Technology One Limited", exchange: "ASX" },

  // Healthcare
  { code: "PME", name: "Pro Medicus Limited", exchange: "ASX" },
  { code: "NAN", name: "Nanosonics Limited", exchange: "ASX" },
  { code: "PNV", name: "PolyNovo Limited", exchange: "ASX" },
  { code: "BOT", name: "Botanix Pharmaceuticals", exchange: "ASX" },
  { code: "IMM", name: "Immutep Limited", exchange: "ASX" },

  // Retail
  { code: "JBH", name: "JB Hi-Fi Limited", exchange: "ASX" },
  { code: "HVN", name: "Harvey Norman Holdings", exchange: "ASX" },
  { code: "SUL", name: "Super Retail Group", exchange: "ASX" },
  { code: "KGN", name: "Kogan.com Ltd", exchange: "ASX" },
  { code: "BRG", name: "Breville Group Limited", exchange: "ASX" },
];

export async function GET(request: NextRequest) {
  // Apply rate limiting: 50 requests/min for anonymous, 500 for authenticated
  const rateLimitResult = await rateLimit(request, {
    anonymousLimit: 50,
    authenticatedLimit: 500,
    windowSeconds: 60,
  });

  if (!rateLimitResult.success) {
    return rateLimitResult.response;
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get("q");

    if (!query || query.length < 1) {
      return NextResponse.json({ results: [] });
    }

    // Filter stocks based on query
    const results = ASX_STOCKS.filter(
      (stock) =>
        stock.code.toLowerCase().includes(query.toLowerCase()) ||
        stock.name.toLowerCase().includes(query.toLowerCase()),
    ).slice(0, 10); // Limit to 10 results

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Error searching stocks:", error);
    return NextResponse.json(
      { error: "Failed to search stocks" },
      { status: 500 },
    );
  }
}
