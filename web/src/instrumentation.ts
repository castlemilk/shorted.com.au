export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Only initialize OTel in Node.js runtime (not Edge)
    const { registerOTel } = await import('@vercel/otel');

    registerOTel({
      serviceName: 'shorted-web',
      // @vercel/otel reads OTEL_EXPORTER_OTLP_ENDPOINT and
      // OTEL_EXPORTER_OTLP_HEADERS from env automatically
    });
  }
}
