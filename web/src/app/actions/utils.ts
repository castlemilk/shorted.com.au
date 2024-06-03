import { getIdToken } from '~/server/auth';

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
        // Check if the token is expired
        const isTokenExpired = await checkIfTokenExpired(authToken);
        
        if (isTokenExpired) {
            // Token is expired, get a new token
            authToken = await getIdToken();
        }
        headers.set("Authorization", `Bearer ${authToken}`);
    }
    return headers;
};

// Helper function to check if the token is expired
const checkIfTokenExpired = async (token: string): Promise<boolean> => {
    try {
        const { exp } = JSON.parse(atob(token.split('.')[1]));
        // Token expiration time is in seconds, convert to milliseconds
        const now = Date.now() / 1000;
        return exp < now;
    } catch (error) {
        // If there's an error decoding the token, assume it's expired
        return true;
    }
};
