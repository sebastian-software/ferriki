import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [candidateRoot, sourceCommit] = process.argv.slice(2);
const assetsRoot = join(candidateRoot, "assets/shiki");
const manifest = JSON.parse(readFileSync(join(assetsRoot, "release-manifest.json"), "utf8"));
const prefix = `/${sourceCommit}/assets/shiki/`;
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const relative = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
  const metadata = manifest.assets[relative];
  if (!metadata || !/^(languages|themes)\/[a-z0-9-]+\.fk(?:gram|theme)$/.test(relative)) {
    response.writeHead(404).end();
    return;
  }
  const bytes = readFileSync(join(assetsRoot, relative));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== metadata.size || digest !== metadata.sha256) {
    response.writeHead(500).end("asset fixture does not match release manifest");
    return;
  }
  process.stderr.write(`${relative}\n`);
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": bytes.length,
  });
  response.end(bytes);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${address.port}\n`);
});
