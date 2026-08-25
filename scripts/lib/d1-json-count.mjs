// Reads wrangler d1 --json output on stdin, prints the single integer
// value under result[0].results[0].<key> (default key: "n"). Emits "?"
// on any failure so callers can detect a parse error without crashing.
// Isolated in its own file because git-bash on Windows mangles
// multi-line `node -e` argument strings.

const key = process.argv[2] || "n";

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let start = -1;
  let depth = 0;
  let end = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "[" || ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (start < 0 || end < 0) {
    process.stdout.write("?");
    return;
  }
  try {
    const doc = JSON.parse(raw.substring(start, end + 1));
    const arr = Array.isArray(doc) ? doc : [doc];
    const val = arr[0]?.results?.[0]?.[key];
    process.stdout.write(val === undefined || val === null ? "?" : String(val));
  } catch {
    process.stdout.write("?");
  }
});
