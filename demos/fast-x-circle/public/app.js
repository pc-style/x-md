// src/draw.ts
var SIZE = 1200;
function rgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = match ? Number.parseInt(match[1], 16) : 0;
  return [value >> 16 & 255, value >> 8 & 255, value & 255];
}
function luminance(hex) {
  const channels = rgb(hex).map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function rgba(hex, alpha) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function layout(members, style) {
  const picked = members.slice(0, style.count);
  const raw = [];
  const ringRadii = [];
  let remaining = picked.length;
  let outer = 100;
  for (let ring = 0;remaining > 0; ring += 1) {
    let diameter = 200 * Math.max(0.3, 0.72 * 0.81 ** ring) * style.nodeScale;
    let radius = outer + 9 + diameter / 2;
    const capacity = Math.max(1, Math.floor(2 * Math.PI * radius / (diameter + 9)));
    let count = Math.min(capacity, remaining);
    const leftover = remaining - count;
    if (leftover > 0 && remaining >= 6 && leftover <= Math.max(2, Math.floor(0.45 * capacity))) {
      count = remaining;
      diameter = Math.min(diameter, (2 * Math.PI * (outer + 9) / count - 9) / (1 - Math.PI / count));
      radius = outer + 9 + diameter / 2;
    }
    const start = -Math.PI / 2 + 0.53 * ring;
    for (let index = 0;index < count; index += 1) {
      const angle = start + 2 * Math.PI * index / count;
      raw.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle), d: diameter, ring });
    }
    ringRadii.push(radius);
    remaining -= count;
    outer = radius + diameter / 2;
  }
  const scale = Math.min(1.6, 542 / (outer || 100));
  return {
    center: 200 * scale,
    rings: ringRadii.map((radius) => radius * scale),
    nodes: raw.map((node, index) => ({
      member: picked[index],
      rank: index + 1,
      x: 600 + node.x * scale,
      y: 600 + node.y * scale,
      d: node.d * scale,
      ring: node.ring
    }))
  };
}
function disk(ctx, person, x, y, diameter, image, ink, font) {
  const radius = diameter / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.closePath();
  if (image) {
    ctx.clip();
    ctx.drawImage(image, x - radius, y - radius, diameter, diameter);
  } else {
    ctx.fillStyle = rgba(ink, 0.16);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.font = `800 ${Math.round(diameter * 0.42)}px ${font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(person.handle.slice(0, 1).toUpperCase(), x, y + diameter * 0.03);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2.5, diameter * 0.03);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.stroke();
}
function badge(ctx, x, y, lines, align) {
  const gaps = [30, 24];
  const width = Math.max(...lines.map((line) => (ctx.font = line.font, ctx.measureText(line.text).width))) + 36;
  const height = lines.reduce((sum, _line, index) => sum + (gaps[index] ?? 0), 0) + 26 - 6;
  const left = align === "left" ? x : x - width;
  const top = y - height;
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, 12);
  ctx.fillStyle = "rgba(0, 18, 59, 0.86)";
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let cursor = top + 13 + 20;
  lines.forEach((line, index) => {
    ctx.font = line.font;
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, left + 18, cursor);
    cursor += gaps[index + 1] ?? 0;
  });
}
function ellipsis(ctx, text, width) {
  if (ctx.measureText(text).width <= width)
    return text;
  let next = text;
  while (next.length > 1 && ctx.measureText(`${next}…`).width > width)
    next = next.slice(0, -1);
  return `${next}…`;
}
function draw(canvas, circle, style, avatars) {
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    return;
  const font = getComputedStyle(document.body).fontFamily || "Figtree, sans-serif";
  const ink = (style.background === "gradient" ? (luminance(style.color1) + luminance(style.color2)) / 2 : luminance(style.color1)) > 0.36 ? "#00123B" : "#FEF9F4";
  if (style.background === "gradient") {
    const gradient = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    gradient.addColorStop(0, style.color1);
    gradient.addColorStop(1, style.color2);
    ctx.fillStyle = gradient;
  } else
    ctx.fillStyle = style.color1;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const placed = layout(circle.members, style);
  if (style.rings) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(ink, 0.18);
    for (const radius of placed.rings) {
      ctx.beginPath();
      ctx.arc(600, 600, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  for (const node of placed.nodes)
    disk(ctx, node.member, node.x, node.y, node.d, node.member.avatar ? avatars.get(node.member.avatar) : undefined, ink, font);
  if (style.names) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const node of placed.nodes) {
      if (node.d < 44)
        continue;
      const size = Math.max(11, Math.min(19, node.d * 0.13));
      ctx.font = `700 ${size}px ${font}`;
      const label = ellipsis(ctx, `@${node.member.handle}`, node.d * 0.84);
      const width = ctx.measureText(label).width + size * 0.9;
      const height = size * 1.55;
      const y = node.y + node.d * 0.3;
      ctx.beginPath();
      ctx.roundRect(node.x - width / 2, y - height / 2, width, height, height / 2.4);
      ctx.fillStyle = "rgba(0, 18, 59, 0.8)";
      ctx.fill();
      ctx.fillStyle = "#FEF9F4";
      ctx.fillText(label, node.x, y + 1);
    }
  }
  if (style.ranks) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const node of placed.nodes) {
      const radius = Math.max(12, node.d * 0.15);
      const x = node.x + node.d * 0.35;
      const y = node.y - node.d * 0.35;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = "#FEDE95";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#00123B";
      ctx.stroke();
      ctx.fillStyle = "#00123B";
      ctx.font = `800 ${Math.round(radius * (node.rank > 9 ? 0.95 : 1.15))}px ${font}`;
      ctx.fillText(String(node.rank), x, y + 1);
    }
  }
  disk(ctx, circle.owner, 600, 600, placed.center, circle.owner.avatar ? avatars.get(circle.owner.avatar) : undefined, ink, font);
  const date = new Date(circle.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  badge(ctx, 30, 1170, [
    { text: `@${circle.owner.handle}`, font: `800 24px ${font}`, color: "#FEF9F4" },
    { text: `X circle, ${date}`, font: `600 17px ${font}`, color: "rgba(254, 249, 244, 0.78)" }
  ], "left");
  badge(ctx, 1170, 1170, [{ text: "fast x circle", font: `700 19px ${font}`, color: "#FEF9F4" }], "right");
}
function toPngBlob(canvas) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    } catch {
      resolve(null);
    }
  });
}

// src/client.ts
var STEPS = [
  { id: "posts", label: "Reading recent posts and mentions" },
  { id: "people", label: "Scoring people and fetching their photos" }
];
var PRESETS = [
  { name: "Navy", background: "gradient", color1: "#00123B", color2: "#26286B" },
  { name: "Purple", background: "gradient", color1: "#996CFC", color2: "#5946AB" },
  { name: "Gold", background: "gradient", color1: "#FEDE95", color2: "#FEF9F4" },
  { name: "Cream", background: "solid", color1: "#FEF9F4", color2: "#F3EDFF" },
  { name: "Grey", background: "solid", color1: "#B2B4BC", color2: "#DBD8DA" },
  { name: "Night", background: "solid", color1: "#00123B", color2: "#26286B" }
];
var ERRORS = {
  bad_handle: "That is not an X username. It is 1 to 15 letters, numbers or underscores.",
  not_found: "There is no X account with that username. Check the spelling and try again.",
  private: "This account is private, so its posts cannot be read. Fast X Circle works on public accounts only.",
  empty: "This account has no recent public posts to read, so there is no one to put in the circle yet.",
  no_one: "The recent posts of this account do not reply to, quote, repost or mention anyone, so the circle would be empty.",
  unavailable: "X posts could not be read right now. Wait a minute and try again.",
  rate_limited: "Too many circles at once. Wait a minute and try again.",
  missing_key: "The reader is not configured right now."
};
function noun(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
function cleanHandle(value) {
  let text = value.trim();
  const match = /(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i.exec(text);
  if (match?.[1])
    text = match[1];
  text = text.replace(/^@+/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(text) ? text : null;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className)
    node.className = className;
  if (text != null)
    node.textContent = text;
  return node;
}
var form = document.querySelector("#xc-form");
var input = document.querySelector("#xc-handle");
var go = document.querySelector("#xc-go");
var status = document.querySelector("#xc-status");
var error = document.querySelector("#xc-error");
var result = document.querySelector("#xc-result");
var canvas = document.querySelector("#xc-canvas");
var basis = document.querySelector("#xc-basis");
var title = document.querySelector("#xc-result-title");
var people = document.querySelector("#xc-people");
var swatches = document.querySelector("#xc-swatches");
var download = document.querySelector("#xc-download");
var style = { background: "gradient", color1: "#00123B", color2: "#26286B", count: 50, nodeScale: 1, names: false, ranks: false, rings: false };
var snapshot = null;
var hidden = new Set;
var abort = null;
var startedAt = 0;
var clockTimer = 0;
var images = new Map;
var loading = new Map;
function visibleMembers() {
  return (snapshot?.members ?? []).filter((member) => !hidden.has(member.handle.toLowerCase()));
}
function shownMembers() {
  return visibleMembers().slice(0, style.count);
}
function paint() {
  if (!snapshot)
    return;
  draw(canvas, { owner: snapshot.owner, members: shownMembers(), createdAt: snapshot.createdAt }, style, images);
  const count = Math.min(style.count, visibleMembers().length);
  canvas.setAttribute("aria-label", `Interaction circle of @${snapshot.owner.handle}`);
  result.dataset.people = String(count);
  result.dataset.postsRead = String(snapshot.postsRead);
}
function ensureImage(url) {
  if (!url || images.has(url) || loading.has(url))
    return;
  const job = new Promise((resolve) => {
    const image = new Image;
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.onload = () => {
      images.set(url, image);
      paint();
      resolve();
    };
    image.onerror = () => resolve();
    image.src = url;
  });
  loading.set(url, job);
}
function renderPeople() {
  people.replaceChildren();
  if (!snapshot)
    return;
  let shown = 0;
  snapshot.members.slice(0, 50).forEach((member) => {
    const off = hidden.has(member.handle.toLowerCase());
    if (!off)
      shown += 1;
    const inPicture = !off && shown <= style.count;
    const item = el("li", off ? "is-off" : inPicture ? undefined : "is-out");
    item.append(el("span", "xc-rank", inPicture ? String(shown) : ""));
    if (member.avatar) {
      const photo = el("img");
      photo.src = member.avatar;
      photo.alt = "";
      photo.width = 40;
      photo.height = 40;
      photo.crossOrigin = "anonymous";
      photo.referrerPolicy = "no-referrer";
      item.append(photo);
    } else
      item.append(el("span", "xc-initial", member.handle.slice(0, 1).toUpperCase()));
    const who = el("span", "xc-who");
    const link = el("a", undefined, member.name);
    link.href = `https://x.com/${encodeURIComponent(member.handle)}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const at = el("span", undefined, `@${member.handle}`);
    who.append(link, at);
    const why = el("span", "xc-why");
    const counts = [member.replies && noun(member.replies, "reply", "replies"), member.mentions && noun(member.mentions, "mention"), member.quotes && noun(member.quotes, "quote"), member.reposts && noun(member.reposts, "repost")].filter(Boolean).join(", ");
    const way = member.fromYou && member.fromThem ? "Both ways" : member.fromYou ? `Only from @${snapshot.owner.handle}` : `Only to @${snapshot.owner.handle}`;
    why.append(el("span", undefined, counts), el("span", undefined, way));
    const keep = el("label", "xc-keep");
    const box = el("input");
    box.type = "checkbox";
    box.checked = !off;
    box.setAttribute("aria-label", `Show @${member.handle} in the circle`);
    box.addEventListener("change", () => {
      const key = member.handle.toLowerCase();
      const next = new Set(hidden);
      if (next.has(key))
        next.delete(key);
      else
        next.add(key);
      hidden = next;
      renderPeople();
      paint();
    });
    keep.append(box);
    item.append(who, why, keep);
    people.append(item);
  });
}
function renderBasis() {
  if (!snapshot)
    return;
  const count = Math.min(style.count, visibleMembers().length);
  const since = snapshot.oldest ? ` since ${new Date(snapshot.oldest * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : "";
  const seconds = (performance.now() - startedAt) / 1000;
  basis.textContent = `${noun(count, "person", "people")} from ${noun(snapshot.postsRead, "post")}${since}. ${snapshot.partial ? "Still reading." : `Finished in ${seconds.toFixed(1)}s.`}`;
  if (!snapshot.partial && !snapshot.mentionsRead)
    basis.textContent += " Posts by others could not be read, so mentions by others are missing: this circle comes from the account's own posts only.";
}
function showCircle(next) {
  snapshot = next;
  title.textContent = `@${next.owner.handle}'s circle`;
  result.hidden = false;
  result.dataset.state = next.partial ? "partial" : "done";
  for (const person of [next.owner, ...next.members])
    ensureImage(person.avatar);
  renderBasis();
  renderPeople();
  paint();
  if (!next.partial) {
    window.clearInterval(clockTimer);
    status.replaceChildren();
    form.classList.remove("is-working");
    go.hidden = false;
    document.querySelector("#xc-stop").hidden = true;
  }
}
function renderStatus(phase, posts, mentions) {
  const current = phase === "people" ? 1 : 0;
  const progress = phase === "people" ? 0.9 : Math.min(0.86, 0.08 + 0.62 * Math.min(1, posts / 450) + 0.16 * Math.min(1, mentions / 150));
  const percent = Math.round(progress * 100);
  const root = el("div", "scan");
  root.setAttribute("role", "status");
  const head = el("div", "scan-head");
  head.append(el("span", "scan-spin"));
  const copy = el("div");
  copy.append(el("p", "scan-title", `Reading @${cleanHandle(input.value) ?? input.value}'s posts`));
  const sub = el("p", "scan-sub");
  sub.append("The circle draws as posts arrive. ", el("span", "scan-clock", clock()));
  copy.append(sub);
  head.append(copy);
  const bar = el("div", "scan-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(percent));
  const fill = el("span");
  fill.style.width = `${percent}%`;
  bar.append(fill);
  const list = el("ol", "scan-steps");
  STEPS.forEach((step, index) => {
    const state = index < current ? "done" : index === current ? "now" : "next";
    const item = el("li", `is-${state}`);
    item.append(el("span", "scan-dot"));
    const label = el("span");
    label.append(step.label);
    if (state === "now") {
      const detail = el("em");
      detail.dataset.livePosts = String(posts);
      detail.dataset.liveMentions = String(mentions);
      detail.textContent = ` ${noun(posts, "post")}, ${noun(mentions, "reply", "replies")} and mentions`;
      label.append(detail);
    }
    item.append(label);
    list.append(item);
  });
  root.append(head, bar, list);
  status.replaceChildren(root);
}
function clock() {
  const seconds = Math.floor((performance.now() - startedAt) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
async function readStream(response, signal) {
  if (!response.ok || !response.body) {
    const problem = await response.json().catch(() => null);
    throw new Error(problem?.code ?? "unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder;
  let buffer = "";
  const consume = (line) => {
    if (!line.startsWith("data:"))
      return;
    const event = JSON.parse(line.slice(5).trim());
    if (event.type === "progress")
      renderStatus(event.phase ?? "posts", event.posts ?? 0, event.mentions ?? 0);
    if (event.type === "circle")
      showCircle(event);
    if (event.type === "done" && event.snapshot)
      showCircle({ ...event.snapshot, partial: false });
    if (event.type === "error")
      throw new Error(event.code ?? "unavailable");
  };
  while (!signal.aborted) {
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
}
async function run(raw) {
  const handle = cleanHandle(raw);
  if (!handle) {
    error.hidden = false;
    error.textContent = ERRORS.bad_handle;
    return;
  }
  abort?.abort();
  abort = new AbortController;
  const signal = abort.signal;
  startedAt = performance.now();
  window.clearInterval(clockTimer);
  clockTimer = window.setInterval(() => {
    const node = document.querySelector(".scan-clock");
    if (node)
      node.textContent = clock();
  }, 1000);
  snapshot = null;
  hidden = new Set;
  error.hidden = true;
  result.hidden = true;
  result.dataset.state = "";
  form.classList.add("is-working");
  go.hidden = true;
  document.querySelector("#xc-stop").hidden = false;
  renderStatus("posts", 0, 0);
  const fresh = new URLSearchParams(location.search).get("fresh") === "1";
  try {
    const response = await fetch(`/api/circle?handle=${encodeURIComponent(handle)}${fresh ? "&fresh=1" : ""}`, { signal, headers: { Accept: "text/event-stream" } });
    await readStream(response, signal);
    if (!signal.aborted && result.dataset.state !== "done") {
      window.clearInterval(clockTimer);
      error.hidden = false;
      error.textContent = ERRORS.unavailable;
      form.classList.remove("is-working");
      status.replaceChildren();
      go.hidden = false;
      document.querySelector("#xc-stop").hidden = true;
    }
  } catch (caught) {
    if (signal.aborted) {
      window.clearInterval(clockTimer);
      form.classList.remove("is-working");
      status.replaceChildren();
      go.hidden = false;
      document.querySelector("#xc-stop").hidden = true;
      return;
    }
    window.clearInterval(clockTimer);
    const code = caught instanceof Error ? caught.message : "unavailable";
    error.hidden = false;
    error.textContent = ERRORS[code] ?? ERRORS.unavailable;
    form.classList.remove("is-working");
    status.replaceChildren();
    go.hidden = false;
    document.querySelector("#xc-stop").hidden = true;
  }
}
function bindStyle() {
  const paintPresets = () => {
    swatches.replaceChildren();
    for (const preset of PRESETS) {
      const on = style.background === preset.background && style.color1 === preset.color1 && (preset.background === "solid" || style.color2 === preset.color2);
      const button = el("button", `xc-swatch${on ? " is-on" : ""}`);
      button.type = "button";
      button.setAttribute("aria-pressed", String(on));
      const chip = el("span");
      chip.style.background = preset.background === "gradient" ? `linear-gradient(135deg, ${preset.color1}, ${preset.color2})` : preset.color1;
      button.append(chip, document.createTextNode(preset.name));
      button.addEventListener("click", () => {
        style = { ...style, background: preset.background, color1: preset.color1, color2: preset.color2 };
        paintPresets();
        paint();
      });
      swatches.append(button);
    }
  };
  paintPresets();
  document.querySelectorAll("[data-fill]").forEach((button) => {
    button.addEventListener("click", () => {
      style = { ...style, background: button.dataset.fill === "solid" ? "solid" : "gradient" };
      document.querySelectorAll("[data-fill]").forEach((peer) => peer.setAttribute("aria-pressed", String(peer === button)));
      paint();
    });
  });
  const color1 = document.querySelector("#xc-color1");
  const color2 = document.querySelector("#xc-color2");
  color1.addEventListener("input", () => {
    style = { ...style, color1: color1.value };
    paint();
  });
  color2.addEventListener("input", () => {
    style = { ...style, color2: color2.value };
    paint();
  });
  const count = document.querySelector("#xc-count");
  const scale = document.querySelector("#xc-scale");
  const countOut = document.querySelector("#xc-count-out");
  const scaleOut = document.querySelector("#xc-scale-out");
  count.addEventListener("input", () => {
    style = { ...style, count: Number(count.value) };
    countOut.textContent = String(Math.min(style.count, visibleMembers().length));
    renderPeople();
    paint();
  });
  scale.addEventListener("input", () => {
    style = { ...style, nodeScale: Number(scale.value) / 100 };
    scaleOut.textContent = `${scale.value}%`;
    paint();
  });
  document.querySelectorAll("[data-flag]").forEach((box) => {
    box.addEventListener("change", () => {
      const flag = box.dataset.flag;
      style = { ...style, [flag]: box.checked };
      paint();
    });
  });
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.classList.contains("is-working"))
    run(input.value);
});
document.querySelector("#xc-stop").addEventListener("click", () => abort?.abort());
download.addEventListener("click", async () => {
  const blob = await toPngBlob(canvas);
  if (!blob || !snapshot)
    return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `x-circle-${snapshot.owner.handle}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1e4);
});
bindStyle();
var presetHandle = new URLSearchParams(location.search).get("u");
if (presetHandle) {
  input.value = presetHandle.replace(/^@/, "");
  if (new URLSearchParams(location.search).get("autostart") === "1")
    run(input.value);
}
