import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { browseSuccessor } from '../api/browse.js'
import { apiIndexDocument } from '../api/index.js'
import { ERROR_CATALOG, LEGACY_SUNSET_ISO, problemDetails } from './apierror'
import { BROWSE_SUCCESSORS, openapiDocument, openapiJson, SITE } from './openapi'
import type { OperationObject, ResponseObject } from './openapi'
import { ACCOUNT_IP, ACCOUNT_KEY_NAME, ACCOUNT_WINDOW_SEC, API_IP, SEARCH_IP, SEARCH_KEY } from './quotas'
import { policyField, stateField } from './ratelimit-headers'

const doc = openapiDocument()
const operations: [string, OperationObject][] = Object.entries(doc.paths).map(([path, item]) => [path, item.get])
const RATE_LIMIT_HEADERS = ['RateLimit', 'RateLimit-Policy', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset']

function resolveRef(ref: string): unknown {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), doc)
}

function everyRef(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) everyRef(item, found)
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value)
      else everyRef(value, found)
    }
  }
  return found
}

function errorResponses(operation: OperationObject): [string, ResponseObject][] {
  return Object.entries(operation.responses).filter(([status]) => status !== '200')
}

describe('openapi document', () => {
  test('is a 3.1 document that names the production server', () => {
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info.title).toBe('x.md API')
    expect(doc.info.version).toBeTruthy()
    expect(doc.servers[0]?.url).toBe(SITE)
    expect(doc.info.termsOfService).toBe(`${SITE}/terms`)
    expect(doc.info.license).toEqual({ name: 'MIT', identifier: 'MIT' })
    expect(doc.externalDocs.url).toBe(`${SITE}/docs`)
  })

  test('every $ref resolves to a component that exists', () => {
    const dangling = everyRef(doc).filter((ref) => resolveRef(ref) === undefined)
    expect(dangling).toEqual([])
  })

  test('operationIds are unique, and every operation is described', () => {
    const ids = operations.map(([, operation]) => operation.operationId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [path, operation] of operations) {
      expect(operation.operationId, path).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/)
      expect(operation.summary.length, path).toBeGreaterThan(10)
      expect(operation.description.length, path).toBeGreaterThan(80)
      expect(operation.tags.length, path).toBeGreaterThan(0)
    }
  })
})

describe('response schema coverage', () => {
  test('100% of operations return a $ref\'d application/json body on 200', () => {
    const typed = operations.filter(([, operation]) => {
      const content = operation.responses['200']?.content ?? {}
      return typeof content['application/json']?.schema.$ref === 'string'
    })
    expect(typed.length).toBe(operations.length)
  })

  test('application/json is the first media type of every response', () => {
    for (const [path, operation] of operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        expect(Object.keys(response.content ?? {})[0], `${path} ${status}`).toBe('application/json')
      }
    }
  })

  test('no operation documents a text-only response', () => {
    for (const [path, operation] of operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        expect(Object.keys(response.content ?? {}), `${path} ${status}`).toContain('application/json')
      }
    }
  })
})

describe('typed error responses', () => {
  test('every operation documents problem details for every failure it declares', () => {
    for (const [path, operation] of operations) {
      const errors = errorResponses(operation)
      expect(errors.length, path).toBeGreaterThan(0)
      for (const [status, response] of errors) {
        expect(Number(status), `${path} ${status}`).toBeGreaterThanOrEqual(400)
        for (const mediaType of ['application/json', 'application/problem+json']) {
          expect(response.content?.[mediaType]?.schema.$ref, `${path} ${status} ${mediaType}`).toBe('#/components/schemas/Problem')
        }
        const example = Object.values(response.content?.['application/json']?.examples ?? {})[0]
        expect(resolveRef(example?.$ref ?? ''), `${path} ${status} example`).toBeDefined()
      }
    }
  })

  test('every operation declares a 429 and a 500', () => {
    for (const [path, operation] of operations) {
      expect(Object.keys(operation.responses), path).toContain('429')
      expect(Object.keys(operation.responses), path).toContain('500')
    }
  })

  test('an operation with a required parameter declares a 400', () => {
    for (const [path, operation] of operations) {
      if (!operation.parameters.some((parameter) => parameter.required)) continue
      expect(Object.keys(operation.responses), path).toContain('400')
    }
  })

  test('429 and 503 carry Retry-After, 405 carries Allow', () => {
    for (const [path, operation] of operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (status === '429' || status === '503') expect(response.headers?.['Retry-After'], `${path} ${status}`).toBeDefined()
        if (status === '405') expect(response.headers?.['Allow'], path).toBeDefined()
      }
    }
  })

  test('the Problem schema matches what lib/apierror.ts actually emits', () => {
    const emitted = problemDetails('missing_url', { instance: `${SITE}/api/v1/posts`, retryAfter: 41 })
    const schema = doc.components.schemas.Problem
    for (const key of Object.keys(emitted)) expect(Object.keys(schema.properties ?? {}), key).toContain(key)
    for (const key of schema.required ?? []) expect(emitted, key).toHaveProperty(key)
    expect(schema.additionalProperties).toBe(true)
  })

  test('x-error-catalog publishes every code the service can emit from its catalog', () => {
    const published = (doc['x-error-catalog'] as { codes: Record<string, { status: number; title: string; resolution: string }> }).codes
    expect(Object.keys(published).sort()).toEqual(Object.keys(ERROR_CATALOG).sort())
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(published[code]?.status, code).toBe(entry.status)
      expect(published[code]?.title, code).toBe(entry.title)
      expect(published[code]?.resolution, code).toBe(entry.resolution)
    }
  })
})

describe('function-calling compatibility', () => {
  test('every parameter carries a concrete type', () => {
    for (const [path, operation] of operations) {
      for (const parameter of operation.parameters) {
        expect(typeof parameter.schema.type, `${path} ${parameter.name}`).toBe('string')
        expect(parameter.description.length, `${path} ${parameter.name}`).toBeGreaterThan(20)
        expect(['query', 'path'], `${path} ${parameter.name}`).toContain(parameter.in)
      }
    }
  })

  test('every path template parameter is declared and required', () => {
    for (const [path, operation] of operations) {
      for (const name of path.matchAll(/\{(\w+)\}/g)) {
        const parameter = operation.parameters.find((candidate) => candidate.name === name[1])
        expect(parameter, `${path} ${name[1]}`).toBeDefined()
        expect(parameter?.in, `${path} ${name[1]}`).toBe('path')
        expect(parameter?.required, `${path} ${name[1]}`).toBe(true)
      }
    }
  })

  test('post operations declare every query parameter lib/converter.ts reads', () => {
    for (const id of ['getPost', 'getPostLegacy']) {
      const operation = operations.find(([, candidate]) => candidate.operationId === id)?.[1]
      const names = operation?.parameters.map((parameter) => parameter.name) ?? []
      expect(names, id).toEqual(expect.arrayContaining(['url', 'handle', 'id', 'format', 'thread', 'userinfo', 'context', 'replies', 'full', 'nocache']))
    }
  })

  test('browse operations declare every query parameter lib/browse.ts reads', () => {
    const search = operations.find(([, candidate]) => candidate.operationId === 'searchPosts')?.[1]
    expect(search?.parameters.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['q', 'feed', 'cursor', 'page', 'limit', 'format', 'full', 'nocache']),
    )
    const legacy = operations.find(([, candidate]) => candidate.operationId === 'browseLegacy')?.[1]
    expect(legacy?.parameters.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['resource', 'handle', 'q', 'feed', 'cursor', 'page', 'limit', 'format', 'full', 'nocache']),
    )
  })

  test('enums and bounds match the handlers', () => {
    const post = operations.find(([, candidate]) => candidate.operationId === 'getPost')?.[1]
    const parameter = (name: string) => post?.parameters.find((candidate) => candidate.name === name)?.schema
    expect(parameter('format')?.enum).toEqual(['markdown', 'obsidian', 'json'])
    expect(parameter('format')?.default).toBe('markdown')
    expect(parameter('userinfo')?.enum).toEqual(['off', 'author', 'all'])
    expect(parameter('context')?.enum).toEqual(['full', 'thread'])
    expect(parameter('replies')?.enum).toEqual(['top', 'recent', 'off'])
    const thread = new RegExp(parameter('thread')?.pattern ?? '')
    for (const value of ['off', 'full', 'conversation', '2', '100', '57']) expect(thread.test(value), value).toBe(true)
    for (const value of ['1', '101', 'sometimes']) expect(thread.test(value), value).toBe(false)
  })

  test('boolean spellings follow the parser each family really uses', () => {
    const spellings = (operationId: string, name: string) =>
      operations.find(([, candidate]) => candidate.operationId === operationId)?.[1].parameters.find((parameter) => parameter.name === name)?.schema.enum
    // lib/converter.ts `parseBoolean` honours `yes`; lib/browse.ts `truthy` does not.
    for (const name of ['full', 'nocache']) {
      expect(spellings('getPost', name), name).toContain('yes')
      expect(spellings('getPostLegacy', name), name).toContain('yes')
      expect(spellings('searchPosts', name), name).not.toContain('yes')
      expect(spellings('getProfile', name), name).not.toContain('yes')
      expect(spellings('browseLegacy', name), name).not.toContain('yes')
    }
  })
})

describe('pagination', () => {
  const listOperations = operations.filter(([, operation]) => operation.responses['200']?.content?.['application/json']?.schema.$ref === '#/components/schemas/BrowseResponse')

  test('every list operation accepts cursor, page and limit', () => {
    expect(listOperations.length).toBeGreaterThan(4)
    for (const [path, operation] of listOperations) {
      const names = operation.parameters.map((parameter) => parameter.name)
      for (const name of ['cursor', 'page', 'limit']) expect(names, `${path} ${name}`).toContain(name)
      const limit = operation.parameters.find((parameter) => parameter.name === 'limit')?.schema
      expect(limit?.type, path).toBe('integer')
      expect(limit?.maximum, path).toBe(20)
      expect(limit?.default, path).toBe(20)
      expect(operation.parameters.find((parameter) => parameter.name === 'page')?.schema.maximum, path).toBe(10)
    }
  })

  test('the list response types the cursor it hands back', () => {
    const browse = doc.components.schemas.BrowseResponse.properties ?? {}
    expect(browse.nextCursor?.type).toBe('string')
    expect(browse.page?.type).toBe('integer')
    expect(browse.limit?.type).toBe('integer')
    expect(doc.components.schemas.BrowseResponse.required).toEqual(expect.arrayContaining(['page', 'limit']))
  })

  test('the document says cursors are preferred', () => {
    expect(doc['x-pagination']).toMatchObject({ style: 'cursor', preferred: 'cursor', max_limit: 20, max_page: 10 })
    expect((doc['x-pagination'] as { response_fields: Record<string, string> }).response_fields.next_cursor).toBe('nextCursor')
  })
})

describe('versioning and deprecation', () => {
  test('the stable surface is versioned in the URL path', () => {
    expect(Object.keys(doc.paths).filter((path) => path.startsWith('/api/v1/')).length).toBeGreaterThan(4)
    expect(doc['x-api-lifecycle']).toMatchObject({ current_major_version: 'v1', versioning_scheme: 'url-path' })
  })

  test('info.description carries the written policy and names the signal headers', () => {
    const description = String(doc.info.description)
    expect(description).toContain('/api/v1/')
    expect(description).toContain('Deprecation:')
    expect(description).toContain('Sunset:')
    expect(description).toContain('successor-version')
    expect(description).toContain('at least 12 months')
  })

  test('exactly the two unversioned aliases are deprecated', () => {
    const deprecated = operations.filter(([, operation]) => operation.deprecated === true).map(([path]) => path)
    expect(deprecated.sort()).toEqual(['/api/browse', '/api/convert'])
  })

  test('a deprecated operation signals its retirement on every response', () => {
    for (const [path, operation] of operations) {
      if (!operation.deprecated) continue
      expect(operation['x-sunset'], path).toBe(LEGACY_SUNSET_ISO)
      // One route, or one per query value: never neither, never both.
      const single = operation['x-successor-version']
      const map = operation['x-successor-version-map']
      expect(Boolean(single) !== Boolean(map), path).toBe(true)
      for (const target of single ? [single] : Object.values(map?.routes ?? {})) {
        expect(target, path).toMatch(new RegExp(`^${SITE}/api/v1/`))
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        for (const header of ['Deprecation', 'Sunset', 'Link']) {
          expect(response.headers?.[header], `${path} ${status} ${header}`).toBeDefined()
        }
      }
    }
  })

  test('/api/convert names /api/v1/posts as its one successor', () => {
    const convert = doc.paths['/api/convert'].get
    expect(convert['x-successor-version']).toBe(`${SITE}/api/v1/posts`)
    expect(convert.responses['200'].headers?.Link).toEqual({ $ref: '#/components/headers/DeprecationLink' })
  })

  test('/api/browse publishes a successor per resource, not a single route', () => {
    const browse = doc.paths['/api/browse'].get
    expect(browse['x-successor-version']).toBeUndefined()
    expect(browse['x-successor-version-map']).toEqual({
      parameter: 'resource',
      routes: {
        profile: `${SITE}/api/v1/profiles/{handle}`,
        followers: `${SITE}/api/v1/profiles/{handle}/followers`,
        following: `${SITE}/api/v1/profiles/{handle}/following`,
        search: `${SITE}/api/v1/search`,
      },
    })
    // The `resource` values the document maps are exactly the ones it accepts.
    const resource = browse.parameters.find((parameter) => parameter.name === 'resource')
    expect([...(resource?.schema.enum ?? [])].sort()).toEqual(Object.keys(BROWSE_SUCCESSORS).sort())
  })

  test('the published browse successors are the ones api/browse.ts links to', () => {
    for (const [resource, template] of Object.entries(BROWSE_SUCCESSORS)) {
      expect(browseSuccessor(resource, 'jack'), resource).toBe(template.replace('{handle}', 'jack'))
    }
    // Search needs no handle; the profile routes emit no link without one,
    // because a Link target is a URI and never a URI Template.
    expect(browseSuccessor('search')).toBe('/api/v1/search')
    expect(browseSuccessor('profile')).toBeUndefined()
    expect(browseSuccessor('followers', 'not a handle')).toBeUndefined()
    expect(browseSuccessor(undefined, 'jack')).toBeUndefined()
  })

  test('the browse Link example is a browse successor, not the post route', () => {
    const link = String(doc.components.headers.BrowseDeprecationLink.example)
    expect(link).toContain(`<${SITE}/api/v1/profiles/jack/followers>; rel="successor-version"`)
    expect(link).not.toContain('/api/v1/posts')
    for (const response of Object.values(doc.paths['/api/browse'].get.responses)) {
      expect(response.headers?.Link).toEqual({ $ref: '#/components/headers/BrowseDeprecationLink' })
    }
  })

  test('x-api-lifecycle, the written policy and /api tell the same story', () => {
    const lifecycle = doc['x-api-lifecycle'] as { policy: string; deprecated_operations: Record<string, unknown>[] }
    const browse = lifecycle.deprecated_operations.find((entry) => entry.path === '/api/browse')
    expect(browse).toMatchObject({ successor_parameter: 'resource', successors: BROWSE_SUCCESSORS })
    expect(browse?.successor).toBeUndefined()
    for (const [resource, template] of Object.entries(BROWSE_SUCCESSORS)) {
      expect(lifecycle.policy).toContain(`\`resource=${resource}\` → \`${template}\``)
    }

    const alias = apiIndexDocument(SITE).versioning.deprecated_aliases.find((entry) => entry.path === '/api/browse')
    expect(alias?.successor).toBeUndefined()
    expect(alias?.successor_parameter).toBe('resource')
    expect(alias?.successors).toEqual(BROWSE_SUCCESSORS)
  })

  test('a live route is never marked deprecated', () => {
    for (const [path, operation] of operations) {
      if (path.startsWith('/api/v1/') || path.startsWith('/{') || path === '/search' || path === '/oembed') {
        expect(operation.deprecated, path).toBeUndefined()
      }
    }
  })
})

describe('rate limit headers', () => {
  test('every response of every operation declares the quota headers', () => {
    for (const [path, operation] of operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        for (const header of RATE_LIMIT_HEADERS) {
          expect(response.headers?.[header], `${path} ${status} ${header}`).toBeDefined()
        }
      }
    }
  })

  test('the declared policies match the quotas lib/quotas.ts enforces', () => {
    const declared = new Map(doc['x-rate-limit-policy'].map((policy) => [String(policy.name), policy]))
    expect([...declared.keys()]).toEqual([API_IP.name, SEARCH_IP.name, SEARCH_KEY.name, ACCOUNT_IP.name, ACCOUNT_KEY_NAME])
    for (const quota of [API_IP, SEARCH_IP, SEARCH_KEY, ACCOUNT_IP]) {
      expect(declared.get(quota.name)?.quota, quota.name).toBe(quota.quota)
      expect(declared.get(quota.name)?.window_seconds, quota.name).toBe(quota.windowSec)
    }
    // A key's own account allowance is issued with the key, so only its window is fixed.
    expect(declared.get(ACCOUNT_KEY_NAME)?.quota).toBeNull()
    expect(declared.get(ACCOUNT_KEY_NAME)?.window_seconds).toBe(ACCOUNT_WINDOW_SEC)
    for (const policy of doc['x-rate-limit-policy']) expect(typeof policy.partition, String(policy.name)).toBe('string')
  })

  test('the header examples are what lib/ratelimit-headers.ts really serialises', () => {
    expect(doc.components.headers.RateLimitPolicy.example).toBe(policyField([API_IP, SEARCH_IP]))
    expect(doc.components.headers.RateLimit.example).toBe(
      stateField([
        { ...API_IP, remaining: 599, resetSec: 41 },
        { ...SEARCH_IP, remaining: 4, resetSec: 41 },
      ]),
    )
  })
})

describe('the committed document', () => {
  test('public/openapi.json is exactly what openapiDocument() renders', () => {
    const committed = readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8')
    expect(committed).toBe(openapiJson())
  })
})
