// Routing. Hash routes rather than pushState because they give every view a
// shareable URL and a real history entry with no server-side deep-link support —
// which is what makes the browser Back button step back instead of exiting.

const ROUTES = ["overview", "experiments", "messages", "coverage", "thread"];
const TITLES = { overview: "Overview", experiments: "Experiments", messages: "Messages",
                 coverage: "Coverage", thread: "Conversation" };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const seg = (path || "overview").split("/").filter(Boolean);
  const name = ROUTES.includes(seg[0]) ? seg[0] : "overview";
  return { name, arg: seg[1] ?? null, params: new URLSearchParams(qs ?? "") };
}
const go = (hash) => { location.hash = hash; };

export { ROUTES, TITLES, parseHash, go };
