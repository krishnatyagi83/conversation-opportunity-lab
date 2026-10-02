const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BATCH = 10;
const MAX_CALL_LIMIT = 500;

export class WebexApiError extends Error {
  constructor(message, { status = 500, details = null } = {}) {
    super(message);
    this.name = "WebexApiError";
    this.status = status;
    this.details = details;
  }
}

export function normalizeApiBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new WebexApiError("Enter a valid Webex Contact Center API base URL.", {
      status: 400,
    });
  }

  if (url.protocol !== "https:") {
    throw new WebexApiError("The Webex API base URL must use HTTPS.", {
      status: 400,
    });
  }

  const hostname = url.hostname.toLowerCase();
  const isCiscoHost =
    hostname.endsWith(".cisco.com") ||
    hostname.endsWith(".ciscoccservice.com");
  if (!isCiscoHost) {
    throw new WebexApiError(
      "The API base URL must be a Cisco Webex Contact Center host.",
      { status: 400 },
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function assertInput({ accessToken, orgId, queueId, from, to, callLimit }) {
  if (!String(accessToken || "").trim()) {
    throw new WebexApiError("A temporary access token is required.", {
      status: 400,
    });
  }
  if (!String(orgId || "").trim()) {
    throw new WebexApiError("A Control Hub organization ID is required.", {
      status: 400,
    });
  }
  if (!String(queueId || "").trim()) {
    throw new WebexApiError("A queue ID is required.", { status: 400 });
  }

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new WebexApiError("Choose a valid start and end date.", { status: 400 });
  }
  if (toMs > Date.now() + 60_000) {
    throw new WebexApiError("The end date cannot be in the future.", {
      status: 400,
    });
  }

  const limit = Number(callLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CALL_LIMIT) {
    throw new WebexApiError(`Call count must be between 1 and ${MAX_CALL_LIMIT}.`, {
      status: 400,
    });
  }

  return { fromMs, toMs, limit };
}

async function requestJson(url, options, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new WebexApiError(
      error?.name === "TimeoutError"
        ? "The Webex API request timed out. Try a smaller date range."
        : "The Webex API could not be reached from the local service.",
      { status: 502 },
    );
  }

  const raw = await response.text();
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { message: raw.slice(0, 800) };
    }
  }

  if (!response.ok) {
    const safeMessage =
      response.status === 401
        ? "The temporary token was rejected or has expired."
        : response.status === 403
          ? "The token does not have permission for this organization or queue."
          : response.status === 429
            ? "Webex rate-limited the request. Wait briefly and try again."
            : `Webex returned HTTP ${response.status}.`;
    throw new WebexApiError(safeMessage, {
      status: response.status,
      details: payload,
    });
  }

  return payload;
}

const QUEUE_CALL_QUERY = `
  query QueueCalls(
    $startTime: Long!
    $endTime: Long!
    $queueId: String!
    $cursor: String
  ) {
    taskLegDetails(
      from: $startTime
      to: $endTime
      filter: {
        and: [
          { queue: { id: { equals: $queueId } } }
          { channelType: { equals: telephony } }
        ]
      }
      pagination: { cursor: $cursor }
    ) {
      taskLegs {
        id
        taskId
        createdTime
        endedTime
        channelType
        queue { id name duration }
        isTaskLegHandled
        connectedDuration
        holdCount
        holdDuration
        consultDuration
        transferCount
        wrapupDuration
        handleTime
        lastWrapupCodeName
        terminationReason
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function extractTaskLegPage(payload) {
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new WebexApiError("The Webex Search query was not accepted.", {
      status: 422,
      details: payload.errors,
    });
  }

  const root = payload?.data?.taskLegDetails ?? payload?.taskLegDetails;
  const taskLegs = root?.taskLegs ?? root?.tasks ?? [];
  if (!Array.isArray(taskLegs)) {
    throw new WebexApiError("The Webex Search response shape was not recognized.", {
      status: 502,
    });
  }
  return {
    taskLegs,
    hasNextPage: Boolean(root?.pageInfo?.hasNextPage),
    endCursor: root?.pageInfo?.endCursor,
  };
}

function mergeTaskLegs(legs, limit) {
  const tasks = new Map();
  for (const leg of legs) {
    const taskId = String(leg?.taskId || "").trim();
    if (!taskId) continue;
    const current = tasks.get(taskId) || {
      taskId,
      createdTime: leg.createdTime ?? null,
      endedTime: leg.endedTime ?? null,
      queueId: leg.queue?.id ?? null,
      queueName: leg.queue?.name ?? null,
      queueDuration: 0,
      connectedDuration: 0,
      holdCount: 0,
      holdDuration: 0,
      consultDuration: 0,
      transferCount: 0,
      wrapupDuration: 0,
      handleTime: 0,
      terminationReason: leg.terminationReason ?? null,
      wrapupCode: leg.lastWrapupCodeName ?? null,
      legCount: 0,
    };
    current.legCount += 1;
    for (const field of [
      "queueDuration",
      "connectedDuration",
      "holdCount",
      "holdDuration",
      "consultDuration",
      "transferCount",
      "wrapupDuration",
      "handleTime",
    ]) {
      const source = field === "queueDuration" ? leg.queue?.duration : leg[field];
      current[field] += Number(source) || 0;
    }
    if (Number(leg.createdTime) < Number(current.createdTime)) {
      current.createdTime = leg.createdTime;
    }
    if (Number(leg.endedTime) > Number(current.endedTime)) {
      current.endedTime = leg.endedTime;
    }
    current.terminationReason ||= leg.terminationReason ?? null;
    current.wrapupCode ||= leg.lastWrapupCodeName ?? null;
    tasks.set(taskId, current);
  }

  return [...tasks.values()]
    .sort((a, b) => Number(b.createdTime || 0) - Number(a.createdTime || 0))
    .slice(0, limit);
}

export async function findQueueTasks(input, { fetchImpl = fetch, onProgress } = {}) {
  const { fromMs, toMs, limit } = assertInput(input);
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const headers = {
    Authorization: `Bearer ${String(input.accessToken).trim()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Encoding": "gzip",
  };
  const collected = [];
  let cursor = "NA";
  let page = 0;

  while (page < 40) {
    page += 1;
    onProgress?.({ stage: "search", page, callsFound: collected.length });
    const payload = await requestJson(
      `${apiBaseUrl}/search?orgId=${encodeURIComponent(String(input.orgId).trim())}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: QUEUE_CALL_QUERY,
          variables: {
            startTime: fromMs,
            endTime: toMs,
            queueId: String(input.queueId).trim(),
            cursor,
          },
        }),
      },
      fetchImpl,
    );
    const result = extractTaskLegPage(payload);
    collected.push(...result.taskLegs);

    const uniqueCount = new Set(
      collected.map((leg) => leg?.taskId).filter(Boolean),
    ).size;
    if (!result.hasNextPage || !result.endCursor || uniqueCount >= limit) break;
    cursor = result.endCursor;
  }

  return {
    apiBaseUrl,
    headers,
    tasks: mergeTaskLegs(collected, limit),
    pagesRead: page,
  };
}

function collectTranscriptArtifacts(value, context = {}, path = [], result = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTranscriptArtifacts(item, context, path, result);
    }
    return result;
  }
  if (!value || typeof value !== "object") return result;

  const taskId =
    value.taskId || value.taskID || value.task?.id || context.taskId || null;
  const nextContext = { ...context, taskId };
  const pathText = path.join(".").toLowerCase();
  const transcriptionContext = /transcri|transcript|vcon/.test(pathText);

  for (const [key, child] of Object.entries(value)) {
    const keyLower = key.toLowerCase();
    const nextPath = [...path, key];
    if (
      typeof child === "string" &&
      /^https:\/\//i.test(child) &&
      (transcriptionContext || /transcri|transcript|vcon/.test(keyLower + child))
    ) {
      result.push({ taskId, url: child, sourcePath: nextPath.join(".") });
      continue;
    }
    collectTranscriptArtifacts(child, nextContext, nextPath, result);
  }
  return result;
}

function collectInlineTranscripts(value, context = {}, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectInlineTranscripts(item, context, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  const taskId = value.taskId || value.taskID || context.taskId || null;
  const nextContext = { taskId };
  if (Array.isArray(value.segments) && value.segments.length) {
    result.push({ taskId, payload: value.segments });
  } else if (Array.isArray(value.dialog) && value.dialog.length) {
    result.push({ taskId, payload: value });
  }
  for (const child of Object.values(value)) {
    collectInlineTranscripts(child, nextContext, result);
  }
  return result;
}

export async function listCaptureArtifacts(
  tasks,
  input,
  { fetchImpl = fetch, onProgress } = {},
) {
  const artifacts = [];
  const inline = [];
  for (let index = 0; index < tasks.length; index += MAX_CAPTURE_BATCH) {
    const batch = tasks.slice(index, index + MAX_CAPTURE_BATCH);
    onProgress?.({
      stage: "captures",
      completed: index,
      total: tasks.length,
    });
    const payload = await requestJson(
      `${input.apiBaseUrl}/v1/captures/query`,
      {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify({
          query: {
            orgId: String(input.orgId).trim(),
            taskIds: batch.map((task) => task.taskId),
            includeSegments: true,
            urlExpiration: 60,
          },
        }),
      },
      fetchImpl,
    );
    artifacts.push(...collectTranscriptArtifacts(payload));
    inline.push(...collectInlineTranscripts(payload));
  }
  return { artifacts, inline };
}

export async function downloadTranscriptArtifact(
  artifact,
  accessToken,
  { fetchImpl = fetch } = {},
) {
  let response;
  try {
    response = await fetchImpl(artifact.url, {
      headers: { Accept: "application/json, text/plain, text/vtt, */*" },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if ((response.status === 401 || response.status === 403) && accessToken) {
      response = await fetchImpl(artifact.url, {
        headers: {
          Authorization: `Bearer ${String(accessToken).trim()}`,
          Accept: "application/json, text/plain, text/vtt, */*",
        },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    }
  } catch {
    throw new WebexApiError("A transcript artifact could not be downloaded.", {
      status: 502,
    });
  }
  if (!response.ok) {
    throw new WebexApiError(
      `A transcript artifact returned HTTP ${response.status}.`,
      { status: 502 },
    );
  }
  const text = await response.text();
  if (text.length > 8_000_000) {
    throw new WebexApiError("A transcript artifact exceeded the 8 MB safety limit.", {
      status: 413,
    });
  }
  return {
    ...artifact,
    contentType: response.headers.get("content-type") || "text/plain",
    text,
  };
}

export async function collectWebexTranscripts(
  input,
  { fetchImpl = fetch, onProgress } = {},
) {
  const search = await findQueueTasks(input, { fetchImpl, onProgress });
  if (!search.tasks.length) {
    return { tasks: [], downloaded: [], inline: [], pagesRead: search.pagesRead };
  }
  const captures = await listCaptureArtifacts(
    search.tasks,
    {
      apiBaseUrl: search.apiBaseUrl,
      headers: search.headers,
      orgId: input.orgId,
    },
    { fetchImpl, onProgress },
  );

  const downloaded = [];
  const failures = [];
  const queue = [...captures.artifacts];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const artifact = queue.shift();
      if (!artifact) return;
      try {
        downloaded.push(
          await downloadTranscriptArtifact(artifact, input.accessToken, {
            fetchImpl,
          }),
        );
      } catch (error) {
        failures.push({
          taskId: artifact.taskId,
          message: error instanceof Error ? error.message : "Download failed",
        });
      }
      onProgress?.({
        stage: "download",
        completed: downloaded.length + failures.length,
        total: captures.artifacts.length,
      });
    }
  });
  await Promise.all(workers);

  return {
    tasks: search.tasks,
    downloaded,
    inline: captures.inline,
    failures,
    pagesRead: search.pagesRead,
    artifactCount: captures.artifacts.length,
  };
}

export const __test = {
  extractTaskLegPage,
  mergeTaskLegs,
  collectTranscriptArtifacts,
  collectInlineTranscripts,
};
