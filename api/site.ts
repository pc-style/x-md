import notFoundHandler from './notfound.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { problemDetails, problemFrom, requestInstance, sendProblem } from '../lib/apierror.js'
import { requestOrigin } from '../lib/http.js'
import { siteResponse } from '../lib/site.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = requestOrigin(req)
  const instance = requestInstance(req, origin)
  const accept = String(req.headers.accept ?? '')
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return sendProblem(res, problemDetails('method_not_allowed', { instance }), accept, req.method)
  }
  const path = typeof req.query.path === 'string' ? req.query.path : ''
  try {
    const response = await siteResponse(path, origin)
    if (response.status === 404) {
      return notFoundHandler(req, res)
    }
    response.headers.forEach((value, name) => res.setHeader(name, value))
    res.status(response.status)
    return req.method === 'HEAD' ? res.end() : res.send(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    console.error(error)
    return sendProblem(res, problemFrom(error, instance), accept, req.method)
  }
}
