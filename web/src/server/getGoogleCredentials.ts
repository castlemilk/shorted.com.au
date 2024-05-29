// lib/getGoogleCredentials.ts


// /**
//  * loads the google credentials from the environment variable GOOGLE_APPLICATION_CREDENTIALS as a JSON string input
//  * @returns 
//  */
// export async function getGoogleCredentials(): Promise<any> {
//     const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
//     if (!credentials) {
//         throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable is not set');
//     }
//     return JSON.parse(credentials) as any;
// }

// export async function getAccessToken(): Promise<string> {
//     const { JWT } = await import('google-auth-library');
//     const jwtClient = new JWT({
//             email: process.env.GOOGLE_CLIENT_EMAIL,
//             key: process.env.GOOGLE_PRIVATE_KEY,
//             scopes: ['https://www.googleapis.com/auth/cloud-platform'],
//     });
//     const token = await jwtClient.fetchIdToken('shorted-service');
//     return token ?? '';
// }

// server/getGoogleCredentials.ts
// import { GoogleAuth } from 'google-auth-library';

// export async function getAccessToken(): Promise<string> {
//   const auth = new GoogleAuth({
//     scopes: ['https://www.googleapis.com/auth/cloud-platform'],
//   });

//   const client = await auth.getClient();
//   const token = await client.getAccessToken();
//   return token.token;
// }
