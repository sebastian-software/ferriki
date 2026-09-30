import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import process from "node:process";
const generated = new URL("../../.generated/class-highlighting/", import.meta.url);
const files = new Map([
  ["/", [new URL("production-browser.html", import.meta.url), "text/html"]],
  [
    "/production-browser.mjs",
    [new URL("production-browser.mjs", import.meta.url), "text/javascript"],
  ],
  ["/production.json", [new URL("production.json", generated), "application/json"]],
]);
const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/results") {
      if (request.headers.origin !== `http://${request.headers.host}`) {
        response.writeHead(403).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 65536) throw new Error("Results exceed limit");
      }
      const result = JSON.parse(body);
      if (!Array.isArray(result.mismatches) || !Number.isInteger(result.checked))
        throw new Error("Invalid result");
      await writeFile(
        new URL("production-browser-results.json", generated),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      response.writeHead(200).end("Saved");
      return;
    }
    const file = files.get(request.url);
    if (request.method !== "GET" || !file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" });
    response.end(await readFile(file[0]));
  } catch (error) {
    console.error(error);
    response.writeHead(500).end("Validation request failed");
  }
});
server.listen(0, "127.0.0.1", () =>
  process.stdout.write(`Production validation: http://127.0.0.1:${server.address().port}\n`),
);
