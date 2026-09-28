// src/rank.ts
var WEIGHT = { reply: 3, quote: 2.5, mention: 1.5, repost: 1 };
var WINDOW_DAYS = 120;
function same(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}
function decay(at, now) {
  return 0.5 ** (Math.max(0, (now - at) / 86400) / 30);
}
function normalizeAvatar(url) {
  if (!url || !/^https:\/\/pbs\.twimg\.com\//.test(url))
    return null;
  return url.replace(/_(?:normal|bigger|mini|\d+x\d+)(\.\w+)$/, "_400x400$1");
}
function personFrom(author) {
  const handle = author?.screen_name?.trim();
  if (!handle)
    return null;
  return { handle, name: author?.name?.trim() || handle, avatar: normalizeAvatar(author?.avatar_url) };
}
function mergePerson(current, next) {
  if (!next)
    return current;
  if (!current)
    return next;
  const nextName = next.name && next.name.toLowerCase() !== next.handle.toLowerCase() ? next.name : null;
  const currentName = current.name && current.name.toLowerCase() !== current.handle.toLowerCase() ? current.name : null;
  return {
    handle: current.handle,
    name: currentName ?? nextName ?? current.name,
    avatar: current.avatar ?? next.avatar
  };
}
function replyHandle(post) {
  const reply = post.replying_to;
  if (Array.isArray(reply))
    return reply[0]?.replace(/^@/, "") || null;
  return reply?.screen_name?.replace(/^@/, "") || null;
}
function postTime(post) {
  const stamp = post.created_timestamp;
  if (typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0)
    return stamp > 1000000000000 ? stamp / 1000 : stamp;
  if (post.created_at) {
    const parsed = Date.parse(post.created_at);
    if (Number.isFinite(parsed))
      return parsed / 1000;
  }
  return null;
}
function mentionHandles(post) {
  const raw = post.raw_text;
  if (raw && Array.isArray(raw.facets)) {
    const start = raw.display_text_range?.[0] ?? 0;
    return raw.facets.filter((facet) => facet.type === "mention" && facet.original && (facet.indices?.[0] ?? 0) >= start).map((facet) => facet.original.replace(/^@/, ""));
  }
  const isReply = replyHandle(post) != null || (post.replying_to_status?.length ?? 0) > 0;
  return handlesIn(visibleBody(post.text ?? "", isReply));
}
function handlesIn(text) {
  return [...text.matchAll(/@([A-Za-z0-9_]{1,15})\b/g)].map((match) => match[1]);
}
function visibleBody(text, stripReplyPrefix) {
  if (!stripReplyPrefix)
    return text;
  return text.replace(/^(?:@[A-Za-z0-9_]{1,15}[ \t]*)+/, "");
}
function directReplyTo(text, owner) {
  const match = text.match(/^@([A-Za-z0-9_]{1,15})\b/);
  return !!match && same(match[1], owner);
}
function ingestOwn(post, owner, cutoff, push) {
  const at = postTime(post);
  if (at == null || at < cutoff || !post.id)
    return false;
  const author = personFrom(post.author);
  if (post.reposted_by?.screen_name && same(post.reposted_by.screen_name, owner)) {
    if (author && !same(author.handle, owner))
      push({ tweetId: post.id, other: author, direction: "out", kind: "repost", at });
    return true;
  }
  const reposted = /^RT @([A-Za-z0-9_]{1,15})\b/.exec(post.text ?? "");
  if (reposted && author && same(author.handle, owner) && !same(reposted[1], owner)) {
    push({ tweetId: post.id, other: { handle: reposted[1], name: reposted[1], avatar: null }, direction: "out", kind: "repost", at });
    return true;
  }
  if (!author || !same(author.handle, owner))
    return true;
  const replyTo = replyHandle(post);
  if (replyTo && !same(replyTo, owner)) {
    push({ tweetId: post.id, other: { handle: replyTo, name: replyTo, avatar: null }, direction: "out", kind: "reply", at });
  }
  const quoted = personFrom(post.quote?.author);
  if (quoted && !same(quoted.handle, owner))
    push({ tweetId: post.id, other: quoted, direction: "out", kind: "quote", at });
  for (const handle of mentionHandles(post)) {
    if (same(handle, owner))
      continue;
    if (replyTo && same(handle, replyTo))
      continue;
    push({ tweetId: post.id, other: { handle, name: handle, avatar: null }, direction: "out", kind: "mention", at });
  }
  return true;
}
function ingestIncoming(post, owner, cutoff, push) {
  if (post.reposted_by?.screen_name || !post.id)
    return false;
  const at = postTime(post);
  if (at == null || at < cutoff)
    return false;
  const author = personFrom(post.author);
  if (!author || same(author.handle, owner))
    return false;
  const replyTo = replyHandle(post);
  const text = post.text ?? "";
  let kind = null;
  if (replyTo && same(replyTo, owner))
    kind = "reply";
  else if (post.quote?.author?.screen_name && same(post.quote.author.screen_name, owner))
    kind = "quote";
  else if (!replyTo && directReplyTo(text, owner))
    kind = "reply";
  else if (incomingMention(post, owner))
    kind = "mention";
  if (!kind)
    return false;
  push({ tweetId: post.id, other: author, direction: "in", kind, at });
  return true;
}
function incomingMention(post, owner) {
  if (post.raw_text?.facets)
    return mentionHandles(post).some((handle) => same(handle, owner));
  return handlesIn(visibleBody(post.text ?? "", true)).some((handle) => same(handle, owner));
}
function rank(interactions, now = Date.now() / 1000) {
  const rows = new Map;
  for (const interaction of interactions) {
    const key = interaction.other.handle.toLowerCase();
    if (rows.has(key) === false) {
      rows.set(key, { profile: { ...interaction.other }, out: 0, inn: 0, replies: 0, mentions: 0, quotes: 0, reposts: 0, fromYou: 0, fromThem: 0 });
    }
    const row = rows.get(key);
    if (!row.profile.avatar && interaction.other.avatar)
      row.profile = { ...interaction.other };
    else if (row.profile.name.toLowerCase() === row.profile.handle.toLowerCase() && interaction.other.name.toLowerCase() !== interaction.other.handle.toLowerCase()) {
      row.profile = { ...row.profile, name: interaction.other.name };
    }
    const weight = WEIGHT[interaction.kind] * decay(interaction.at, now);
    if (interaction.direction === "out") {
      row.out += weight;
      row.fromYou += 1;
    } else {
      row.inn += weight;
      row.fromThem += 1;
    }
    if (interaction.kind === "reply")
      row.replies += 1;
    else if (interaction.kind === "mention")
      row.mentions += 1;
    else if (interaction.kind === "quote")
      row.quotes += 1;
    else
      row.reposts += 1;
  }
  return [...rows.values()].map((row) => ({
    ...row.profile,
    score: row.out + row.inn + 2 * Math.sqrt(row.out * row.inn),
    replies: row.replies,
    mentions: row.mentions,
    quotes: row.quotes,
    reposts: row.reposts,
    fromYou: row.fromYou,
    fromThem: row.fromThem
  })).filter((member) => member.score > 0).sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
}

// src/engine.ts
class CircleError extends Error {
  code;
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "CircleError";
  }
}
var MENTION_SLICES = 4;
var MENTION_PAGES = 2;
var OWN_SLICES = 4;
var OWN_PAGES = 3;
var REPOST_SLICES = 2;
var REPOST_PAGES = 2;
var RECENT_IMPORT_DAYS = 7;
function baseUrl() {
  return (process.env.X_MD_BASE ?? "https://mdfromx.com").replace(/\/$/, "");
}
function authHeaders() {
  const key = process.env.X_MD_API_KEY;
  if (!key)
    throw new CircleError("missing_key");
  const headers = new Headers;
  headers.set("Authorization", `Bearer ${key}`);
  headers.set("Accept", "application/json");
  return headers;
}
async function problem(response) {
  const body = await response.json().catch(() => null);
  const detail = `${body?.detail ?? ""} ${body?.code ?? ""}`;
  if (response.status === 404 || body?.code === "not_found")
    throw new CircleError(/protect|private/i.test(detail) ? "private" : "not_found");
  if (response.status === 429 || body?.code === "rate_limited")
    throw new CircleError("rate_limited");
  throw new CircleError("unavailable");
}
async function defaultPortrait(handle, signal) {
  const timeout = AbortSignal.timeout(8000);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    const response = await fetch(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}`, {
      signal: combined,
      headers: { Accept: "application/json", "User-Agent": "fast-x-circle" }
    });
    if (!response.ok)
      return null;
    const body = await response.json();
    return personFrom(body.user);
  } catch {
    return null;
  }
}
function slices(nowMs, count) {
  const span = WINDOW_DAYS * 86400000;
  const start = nowMs - span;
  const step = span / count;
  return Array.from({ length: count }, (_, index) => ({
    since: new Date(start + index * step),
    until: new Date(index === count - 1 ? nowMs : start + (index + 1) * step)
  }));
}
async function collectCircle(handle, options) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle))
    throw new CircleError("bad_handle");
  const fetcher = options.fetch ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(55000);
  const nowMs = options.now ?? Date.now();
  const nowSec = nowMs / 1000;
  const cutoff = nowSec - WINDOW_DAYS * 86400;
  const started = performance.now();
  const createdAt = nowMs;
  const interactions = [];
  const seen = new Set;
  const seenOwn = new Set;
  const seenMentions = new Set;
  let ownPosts = 0;
  let mentions = 0;
  let oldest = null;
  let owner = null;
  let mentionOk = false;
  let firstProgressMs = null;
  let firstCircleMs = null;
  const portraits = new Map;
  const portraitJobs = new Map;
  const push = (interaction) => {
    const key = `${interaction.tweetId}:${interaction.other.handle.toLowerCase()}:${interaction.kind}:${interaction.direction}`;
    if (seen.has(key) || same(interaction.other.handle, handle))
      return;
    seen.add(key);
    interactions.push(interaction);
    if (interaction.at && (oldest == null || interaction.at < oldest))
      oldest = interaction.at;
  };
  const rememberOwner = (person) => {
    owner = mergePerson(owner, person);
  };
  const loadPortrait = (name) => {
    const key = name.toLowerCase();
    const existing = portraitJobs.get(key);
    if (existing)
      return existing;
    const job = (options.portrait ?? defaultPortrait)(name, signal).then((person) => {
      portraits.set(key, person);
      return person;
    }).catch(() => null);
    portraitJobs.set(key, job);
    return job;
  };
  const applyPortraits = (members) => members.map((member) => {
    const portrait = portraits.get(member.handle.toLowerCase());
    if (!portrait)
      return member;
    const named = member.name.toLowerCase() === member.handle.toLowerCase() && portrait.name ? portrait.name : member.name;
    return { ...member, name: named, avatar: member.avatar ?? normalizeAvatar(portrait.avatar) ?? portrait.avatar };
  });
  const snapshot = (partial, members) => ({
    partial,
    owner: owner ?? { handle, name: handle, avatar: null },
    members,
    postsRead: ownPosts + mentions,
    ownPosts,
    mentions,
    oldest,
    mentionsRead: partial ? true : mentionOk,
    createdAt
  });
  let closed = false;
  let phase = "posts";
  let progressTimer = null;
  let progressSent = false;
  const sendProgress = () => {
    if (closed)
      return;
    options.onEvent({ type: "progress", phase, posts: ownPosts, mentions, elapsedMs: performance.now() - started });
  };
  const emitProgress = () => {
    if (!progressSent) {
      progressSent = true;
      sendProgress();
      return;
    }
    if (progressTimer)
      return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      sendProgress();
    }, 80);
  };
  let circleTimer = null;
  const publish = (partial) => {
    if (closed)
      return;
    const members = applyPortraits(rank(interactions, nowSec).slice(0, 50));
    for (const member of members)
      if (!member.avatar)
        loadPortrait(member.handle);
    if (partial && members.length === 0)
      return;
    if (firstCircleMs == null && members.length > 0)
      firstCircleMs = performance.now() - started;
    options.onEvent({ type: "circle", ...snapshot(partial, members) });
  };
  const scheduleCircle = () => {
    if (closed)
      return;
    if (firstCircleMs == null) {
      publish(true);
      return;
    }
    if (circleTimer)
      return;
    circleTimer = setTimeout(() => {
      circleTimer = null;
      publish(true);
    }, 180);
  };
  const noteProgress = () => {
    if (firstProgressMs == null && (ownPosts > 0 || mentions > 0))
      firstProgressMs = performance.now() - started;
    emitProgress();
    scheduleCircle();
  };
  const onOwn = (post) => {
    if (post.id && seenOwn.has(post.id))
      return;
    if (post.id)
      seenOwn.add(post.id);
    const author = personFrom(post.author);
    if (author && same(author.handle, handle))
      rememberOwner(author);
    const reposter = personFrom(post.reposted_by);
    if (reposter && same(reposter.handle, handle))
      rememberOwner(reposter);
    if (!ingestOwn(post, handle, cutoff, push))
      return;
    ownPosts += 1;
    noteProgress();
  };
  const onMention = (post) => {
    if (!post.id || seenMentions.has(post.id))
      return;
    if (!ingestIncoming(post, handle, cutoff, push))
      return;
    seenMentions.add(post.id);
    mentions += 1;
    noteProgress();
  };
  const readOwn = async (concurrency) => {
    const url = new URL(`${baseUrl()}/api/v1/profiles/${encodeURIComponent(handle)}/posts`);
    url.searchParams.set("since", new Date(nowMs - RECENT_IMPORT_DAYS * 86400000).toISOString());
    url.searchParams.set("max_posts", "400");
    url.searchParams.set("with_replies", "true");
    url.searchParams.set("with_reposts", "true");
    url.searchParams.set("concurrency", String(concurrency));
    url.searchParams.set("format", "ndjson");
    if (options.fresh)
      url.searchParams.set("refresh", "true");
    const response = await fetcher(url, { headers: authHeaders(), signal });
    if (!response.ok || !response.body)
      await problem(response);
    const reader = response.body.getReader();
    const decoder = new TextDecoder;
    let buffer = "";
    const consume = (line) => {
      if (!line)
        return;
      const message = JSON.parse(line);
      if (message.error) {
        const detail = `${message.error.detail ?? ""} ${message.error.code ?? ""}`;
        if (/protect|private/i.test(detail))
          throw new CircleError("private");
        if (ownPosts === 0)
          throw new CircleError("unavailable");
        return;
      }
      if (message.profile) {
        if (message.profile.protected)
          throw new CircleError("private");
        rememberOwner(personFrom(message.profile));
      }
      if (message.post)
        onOwn(message.post);
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done)
        break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf(`
`);
      while (newline >= 0) {
        consume(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf(`
`);
      }
    }
    consume(buffer.trim());
  };
  const searchQuery = async (query, ranges, pages, onPost) => {
    let saw = false;
    let limited = false;
    const run = async (slice) => {
      let cursor;
      for (let page = 0;page < pages; page += 1) {
        if (signal.aborted)
          throw new CircleError("aborted");
        const url = new URL(`${baseUrl()}/api/v1/search`);
        url.searchParams.set("q", query);
        url.searchParams.set("feed", "latest");
        url.searchParams.set("limit", "100");
        url.searchParams.set("format", "json");
        url.searchParams.set("full", "true");
        url.searchParams.set("since", slice.since.toISOString());
        url.searchParams.set("until", slice.until.toISOString());
        if (options.fresh)
          url.searchParams.set("nocache", "true");
        if (cursor)
          url.searchParams.set("cursor", cursor);
        const response = await fetcher(url, { headers: authHeaders(), signal });
        if (response.status === 429) {
          limited = true;
          return;
        }
        if (!response.ok)
          return;
        const body = await response.json();
        saw = true;
        for (const post of body.posts ?? [])
          onPost(post);
        if (!body.nextCursor)
          return;
        cursor = body.nextCursor;
      }
    };
    await Promise.all(ranges.map(async (slice) => {
      try {
        await run(slice);
      } catch (error) {
        if (error instanceof CircleError && error.code === "aborted")
          throw error;
      }
    }));
    if (saw)
      return "ok";
    return limited ? "limited" : "fail";
  };
  const ownPost = (post) => {
    const author = post.author?.screen_name;
    const repostedBy = post.reposted_by?.screen_name;
    return author != null && same(author, handle) || repostedBy != null && same(repostedBy, handle);
  };
  try {
    if (signal.aborted)
      throw new CircleError("aborted");
    const ownImport = readOwn(8).catch((error) => {
      if (error instanceof CircleError && (error.code === "private" || error.code === "not_found" || error.code === "aborted"))
        throw error;
    });
    const ownSearch = searchQuery(`from:${handle}`, slices(nowMs, OWN_SLICES), OWN_PAGES, (post) => {
      if (ownPost(post))
        onOwn(post);
    });
    const reposts = searchQuery(`from:${handle} filter:nativeretweets`, slices(nowMs, REPOST_SLICES), REPOST_PAGES, (post) => {
      if (ownPost(post))
        onOwn(post);
    });
    const incoming = searchQuery(`@${handle}`, slices(nowMs, MENTION_SLICES), MENTION_PAGES, onMention);
    const [, ownResult, repostResult, mentionResult] = await Promise.all([ownImport, ownSearch, reposts, incoming]);
    if (mentionResult === "ok" || mentionResult === "limited")
      mentionOk = true;
    const limited = ownResult === "limited" || repostResult === "limited" || mentionResult === "limited";
    if (signal.aborted)
      throw new CircleError("aborted");
    if (ownPosts === 0)
      throw new CircleError(limited ? "rate_limited" : "empty");
    const ranked = rank(interactions, nowSec);
    if (ranked.length === 0)
      throw new CircleError("no_one");
    phase = "people";
    sendProgress();
    await Promise.all(ranked.slice(0, 50).filter((member) => !member.avatar).map((member) => loadPortrait(member.handle)));
    closed = true;
    if (circleTimer)
      clearTimeout(circleTimer);
    if (progressTimer)
      clearTimeout(progressTimer);
    const members = applyPortraits(ranked.slice(0, 50));
    const finalSnapshot = snapshot(false, members);
    if (firstCircleMs == null)
      firstCircleMs = performance.now() - started;
    options.onEvent({ type: "circle", ...finalSnapshot });
    const completeMs = performance.now() - started;
    options.onEvent({
      type: "done",
      timing: {
        firstProgressMs,
        firstCircleMs,
        completeMs,
        postsPerSec: finalSnapshot.postsRead / Math.max(completeMs / 1000, 0.001)
      },
      snapshot: finalSnapshot
    });
  } catch (error) {
    if (error instanceof CircleError)
      throw error;
    if (signal.aborted)
      throw new CircleError("aborted");
    throw new CircleError("unavailable");
  }
}

// src/http.ts
var hits = new Map;
var active = 0;
function beginCircle(ip) {
  if (active >= 3)
    return { ok: false, retryAfter: 5 };
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((at) => now - at < 15 * 60 * 1000);
  if (recent.length >= 30)
    return { ok: false, retryAfter: 60 };
  recent.push(now);
  hits.set(ip, recent);
  active += 1;
  return { ok: true, finish: () => {
    active = Math.max(0, active - 1);
  } };
}

// src/vercel-handler.ts
var config = { maxDuration: 60 };
function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0]?.trim() || "unknown";
}
async function handle(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const gate = beginCircle(clientIp(req));
  if (!gate.ok) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Retry-After", String(gate.retryAfter));
    res.end(JSON.stringify({ code: "rate_limited" }));
    return;
  }
  const abort = new AbortController;
  const timer = setTimeout(() => abort.abort(), 55000);
  if (typeof req.on === "function")
    req.on("close", () => abort.abort());
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (event) => {
    if (!res.writableEnded)
      res.write(`data: ${JSON.stringify(event)}

`);
  };
  try {
    await collectCircle(url.searchParams.get("handle") ?? "", {
      fresh: url.searchParams.get("fresh") === "1",
      signal: abort.signal,
      onEvent: send
    });
  } catch (error) {
    const code = error instanceof CircleError ? error.code : "unavailable";
    if (code !== "aborted")
      send({ type: "error", code });
  } finally {
    clearTimeout(timer);
    gate.finish();
    if (!res.writableEnded)
      res.end();
  }
}
async function handler(req, res) {
  try {
    await handle(req, res);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "failed";
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ code: "unavailable", detail }));
    }
  }
}
export {
  config,
  handler as default
};
