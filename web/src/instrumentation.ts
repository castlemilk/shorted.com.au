export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Version evidence only. No environment values, credentials or user data.
    // Correlate this record with a serving invocation before claiming runtime acceptance.
    console.info(JSON.stringify({
      type: 'runtime_identity', service: 'shorted-web',
      node: process.version, openssl: process.versions.openssl,
      next_phase: process.env.NEXT_PHASE ?? 'unspecified',
    }));
    // Only initialize OTel in Node.js runtime (not Edge)
    const { registerOTel } = await import('@vercel/otel');

    registerOTel({
      serviceName: 'shorted-web',
      // @vercel/otel reads OTEL_EXPORTER_OTLP_ENDPOINT and
      // OTEL_EXPORTER_OTLP_HEADERS from env automatically
    });
  }
}

