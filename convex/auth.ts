export function requireServerSecret(serverSecret: string | undefined) {
  if (!process.env.CONVEX_SERVER_SECRET || serverSecret !== process.env.CONVEX_SERVER_SECRET) {
    throw new Error('Unauthorized')
  }
}
