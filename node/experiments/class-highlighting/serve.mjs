import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import process from "node:process";

const generated = new URL("../../.generated/class-highlighting/", import.meta.url);
const files = new Map([
  ["/", [new URL("browser.html", import.meta.url), "text/html"]],
  ["/browser.mjs", [new URL("browser.mjs", import.meta.url), "text/javascript"]],
  ["/custom-theme.css", [new URL("custom-theme.css", import.meta.url), "text/css"]],
  ["/data.json", [new URL("data.json", generated), "application/json"]],
  ["/analysis.json", [new URL("analysis.json", generated), "application/json"]],
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
        if (body.length > 2 * 1024 * 1024) throw new Error("Evidence exceeds size limit");
      }
      const result = JSON.parse(body);
      if (!Array.isArray(result.fidelity) || !Array.isArray(result.tasks))
        throw new Error("Invalid evidence shape");
      await writeFile(
        new URL("browser-results.json", generated),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      process.stdout.write("Browser evidence saved.\n");
      response.writeHead(200).end("Saved");
      return;
    }
    const file = files.get(request.url);
    if (request.method !== "GET" || !file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": `${file[1]}; charset=utf-8`,
      "Cache-Control": "no-store",
    });
    response.end(await readFile(file[0]));
  } catch (error) {
    console.error(error.message);
    response.writeHead(500).end("Experiment request failed");
  }
});
server.listen(0, "127.0.0.1", () =>
  process.stdout.write(`Class-highlighting browser: http://127.0.0.1:${server.address().port}\n`),
);
