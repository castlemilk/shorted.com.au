/**
 * Debug endpoint to check environment variables
 * DELETE THIS FILE after debugging!
 */
export function GET() {
  // Only show if variables are SET, not their actual values (for security)
  const envStatus = {
    // Required by env.js
    NEXTAUTH_SECRET: !!process.env.NEXTAUTH_SECRET,
    AUTH_FIREBASE_PROJECT_ID: !!process.env.AUTH_FIREBASE_PROJECT_ID,
    AUTH_FIREBASE_CLIENT_EMAIL: !!process.env.AUTH_FIREBASE_CLIENT_EMAIL,
    AUTH_FIREBASE_PRIVATE_KEY: !!process.env.AUTH_FIREBASE_PRIVATE_KEY,
    AUTH_GOOGLE_ID: !!process.env.AUTH_GOOGLE_ID,
    AUTH_GOOGLE_SECRET: !!process.env.AUTH_GOOGLE_SECRET,
    SHORTS_SERVICE_ENDPOINT: !!process.env.SHORTS_SERVICE_ENDPOINT,
    
    // Enrichment processor
    ENRICHMENT_PROCESSOR_URL: !!process.env.ENRICHMENT_PROCESSOR_URL,
    NEXT_PUBLIC_ENRICHMENT_PROCESSOR_URL: !!process.env.NEXT_PUBLIC_ENRICHMENT_PROCESSOR_URL,
    
    // Show actual values for non-sensitive vars (useful for debugging)
    values: {
      SHORTS_SERVICE_ENDPOINT: process.env.SHORTS_SERVICE_ENDPOINT ?? "(not set)",
      ENRICHMENT_PROCESSOR_URL: process.env.ENRICHMENT_PROCESSOR_URL ?? "(not set)",
      NEXT_PUBLIC_ENRICHMENT_PROCESSOR_URL: process.env.NEXT_PUBLIC_ENRICHMENT_PROCESSOR_URL ?? "(not set)",
      NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT: process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? "(not set)",
      NODE_ENV: process.env.NODE_ENV ?? "(not set)",
    },
  };

  return Response.json(envStatus, { 
    headers: { "Content-Type": "application/json" } 
  });
}
