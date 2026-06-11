import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ConvertError, acceptPrefersHtml, convertTweet, markdownResponse } from '../lib/converter.js'
import { logRequest, recordFeatureRun, resolveAuthContext, syncUserToBackends } from '../lib/auth.js'
import { checkPremiumAccess, ensureAutumnCustomer, getPremiumFeature, isPremiumFeatureId, MonetizationError, trackPremiumUsage, type PremiumFeatureId } from '../lib/monetization.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const accept = String(req.headers.accept ?? '')
  const asJson = accept.includes('application/json')
  const asHtml = acceptPrefersHtml(accept)

  const premiumFeatureId = typeof req.query.premium === 'string' ? req.query.premium : undefined
  const auth = await resolveAuthContext(req.headers)
  let premiumFeature: ReturnType<typeof getPremiumFeature> | null = null

  try {
    if (premiumFeatureId) {
      if (!isPremiumFeatureId(premiumFeatureId)) {
        throw new MonetizationError(400, 'invalid_feature', `Unknown premium feature: ${premiumFeatureId}`)
      }
      if (!auth.userId) {
        throw new MonetizationError(401, 'authentication_required', 'Sign in or send an x.md API key to use premium features.')
      }
      premiumFeature = getPremiumFeature(premiumFeatureId)
      await syncUserToBackends(auth)
      await ensureAutumnCustomer(auth.userId, { email: auth.email, name: auth.name })
      await checkPremiumAccess(auth.userId, premiumFeatureId)
    }

    const result = await convertTweet({
      url: typeof req.query.url === 'string' ? req.query.url : undefined,
      handle: typeof req.query.handle === 'string' ? req.query.handle : undefined,
      id: typeof req.query.id === 'string' ? req.query.id : undefined,
      format: typeof req.query.format === 'string' ? req.query.format : undefined,
      thread: typeof req.query.thread === 'string' ? req.query.thread : undefined,
      userinfo: typeof req.query.userinfo === 'string' ? req.query.userinfo : undefined,
      nocache: typeof req.query.nocache === 'string' ? req.query.nocache : undefined,
    })

    if (req.method === 'GET' && premiumFeatureId && auth.userId && premiumFeature) {
      const autumnCheck = await trackPremiumUsage(auth.userId, premiumFeatureId as PremiumFeatureId)
      await recordFeatureRun({
        userId: auth.userId,
        featureId: premiumFeatureId,
        credits: premiumFeature.credits,
        status: 'completed',
        autumnCustomerId: auth.userId,
        autumnCheck,
        input: { url: req.query.url, handle: req.query.handle, id: req.query.id },
        outputSummary: { postCount: result.postCount, source: result.source, cache: result.cache },
      })
    }

    await logRequest({ auth, route: '/api/convert', status: 200, featureId: premiumFeatureId, source: result.source, cache: result.cache })

    const { status, headers, body } = markdownResponse(result, asJson, asHtml)
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value)
    }

    if (req.method === 'HEAD') {
      return res.status(status).end()
    }

    return res.status(status).send(body)
  } catch (error) {
    if (error instanceof MonetizationError) {
      await logRequest({ auth, route: '/api/convert', status: error.status, featureId: premiumFeatureId })
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
      })
    }

    if (error instanceof ConvertError) {
      await logRequest({ auth, route: '/api/convert', status: error.status, featureId: premiumFeatureId })
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
      })
    }

    console.error(error)
    await logRequest({ auth, route: '/api/convert', status: 500, featureId: premiumFeatureId })
    return res.status(500).json({ error: 'Internal converter error' })
  }
}
