import http from "node:http";
import { fileURLToPath } from "node:url";
import { analyzeCalls } from "./lib/analyzer.mjs";
import {
  normalizeUploadedCalls,
  normalizeWebexCollection,
} from "./lib/transcript.mjs";
import { collectWebexTranscripts, WebexApiError } from "./lib/webex.mjs";

const HOST = process.env.TRANSCRIPT_LAB_HOST || "127.0.0.1";
const PORT = Number(process.env.TRANSCRIPT_LAB_PORT || 3011);
const MAX_BODY_BYTES = 12_000_000;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new WebexApiError("The request exceeded the 12 MB local limit.", {
        status: 413,
      });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new WebexApiError("The request body must be valid JSON.", {
      status: 400,
    });
  }
}

export function createTranscriptServer() {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${HOST}:${PORT}`);

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "conversation-opportunity-lab",
        privacy: "ephemeral",
      });
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    try {
      const body = await readJson(request);
      if (requestUrl.pathname === "/analyze-upload") {
        const calls = normalizeUploadedCalls(body.calls);
        if (!calls.length) {
          throw new WebexApiError("Upload at least one transcript-bearing call.", {
            status: 400,
          });
        }
        sendJson(
          response,
          200,
          analyzeCalls(calls, {
            supplementary: body.supplementary,
            source: body.source || "upload",
          }),
        );
        return;
      }

      if (requestUrl.pathname === "/run") {
        const startedAt = Date.now();
        const collection = await collectWebexTranscripts(body);
        const calls = normalizeWebexCollection(collection);
        const report = analyzeCalls(calls, {
          supplementary: body.supplementary,
          source: "webex-captures",
        });
        sendJson(response, 200, {
          ...report,
          ingestion: {
            tasksMatched: collection.tasks.length,
            captureArtifacts: collection.artifactCount || 0,
            transcriptsDownloaded: collection.downloaded.length,
            inlineTranscripts: collection.inline.length,
            failures: collection.failures || [],
            searchPagesRead: collection.pagesRead,
            elapsedMs: Date.now() - startedAt,
            credentialRetention: "not stored",
          },
        });
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const known = error instanceof WebexApiError;
      sendJson(response, known ? error.status : 500, {
        error: known ? error.message : "The local analysis service failed.",
      });
    }
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createTranscriptServer();
  server.listen(PORT, HOST, () => {
    process.stdout.write(
      `Conversation Opportunity Lab service listening on http://${HOST}:${PORT}\n`,
    );
  });
}
