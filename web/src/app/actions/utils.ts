
async function getServerAccessToken() {
    if (typeof window !== 'undefined') {
      throw new Error('getServerAccessToken should only be called on the server');
    }
    const projectId = process.env.GOOGLE_PROJECT_ID ?? 'shorted-dev-aba5688f'
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
        projectId: projectId,
        credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/gm, '\n'),
        },
    });

    const client = await auth.getIdTokenClient(projectId);
    const tokenResponse = await client.idTokenProvider.fetchIdToken(projectId);
    if (!tokenResponse) {
      throw new Error('Failed to obtain ID token');
    }
    return tokenResponse;
  }

  export const getAuthorizationHeader = async (initHeaders: HeadersInit, token: string | undefined): Promise<Headers> => {
    const headers = new Headers(initHeaders);
    let authToken = token;

    if (!authToken && typeof window === 'undefined') {
        // Running on the server, get the token using Google credentials
        authToken = await getServerAccessToken();
    }

    if (authToken) {
        headers.set("Authorization", `Bearer ${authToken}`);
    }
    return headers;
};