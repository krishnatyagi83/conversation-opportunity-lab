const TEXT_KEYS = new Set([
  "text",
  "transcript",
  "utterance",
  "content",
  "message",
  "displaytext",
  "recognizedtext",
]);

export function redactText(value) {
  return String(value || "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\b\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[phone]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[payment-number]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[government-id]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip-address]")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCaptionText(text) {
  return String(text || "")
    .replace(/^WEBVTT[^\n]*\n?/i, "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim() &&
        !/^\d+$/.test(line.trim()) &&
        !/\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->/.test(line),
    )
    .join(" ");
}

function roleFromRecord(record, fallback = "Unknown") {
  const raw = String(
    record?.speaker ||
      record?.role ||
      record?.participant ||
      record?.participantType ||
      record?.direction ||
      record?.from ||
      fallback,
  ).toLowerCase();
  if (/agent|advisor|associate|business|outbound/.test(raw)) return "Agent";
  if (/customer|caller|client|consumer|inbound/.test(raw)) return "Customer";
  if (/bot|virtual|ai/.test(raw)) return "Virtual agent";
  return fallback;
}

function bodyToRecord(body, record) {
  if (typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") return { ...record, ...parsed };
  } catch {
    // The body is already plain transcript text.
  }
  return { ...record, text: body };
}

function extractUtterances(value, context = {}, result = [], seen = new Set()) {
  if (value == null) return result;
  if (typeof value === "string") return result;
  if (typeof value !== "object" || seen.has(value)) return result;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) extractUtterances(item, context, result, seen);
    return result;
  }

  const expanded = value.body ? bodyToRecord(value.body, value) : value;
  const role = roleFromRecord(expanded, context.role || "Unknown");
  for (const [key, child] of Object.entries(expanded)) {
    if (typeof child === "string" && TEXT_KEYS.has(key.toLowerCase())) {
      const text = redactText(child);
      if (text.length >= 2 && !/^https?:\/\//i.test(text)) {
        result.push({
          role,
          text,
          startTime:
            expanded.startTime ?? expanded.start ?? expanded.timestamp ?? null,
          endTime: expanded.endTime ?? expanded.end ?? null,
        });
      }
    }
  }

  for (const [key, child] of Object.entries(expanded)) {
    if (TEXT_KEYS.has(key.toLowerCase()) || key === "body") continue;
    extractUtterances(child, { role }, result, seen);
  }
  return result;
}

function parsePayload(raw) {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to caption/plain-text parsing.
    }
  }
  return cleanCaptionText(trimmed);
}

function deduplicateUtterances(utterances) {
  const seen = new Set();
  return utterances.filter((item) => {
    const key = `${item.role}:${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeTranscript({ taskId, payload, text, metadata = {} }) {
  const source = parsePayload(payload ?? text);
  let utterances = [];
  if (typeof source === "string") {
    utterances = [{ role: "Unknown", text: redactText(source) }];
  } else if (source) {
    utterances = extractUtterances(source);
  }
  utterances = deduplicateUtterances(utterances).filter((item) => item.text);
  return {
    taskId: String(taskId || metadata.taskId || "unknown"),
    metadata,
    utterances,
    text: utterances.map((item) => `${item.role}: ${item.text}`).join("\n"),
  };
}

export function normalizeWebexCollection(collection) {
  const taskMap = new Map(collection.tasks.map((task) => [task.taskId, task]));
  const byTask = new Map();

  for (const artifact of collection.downloaded || []) {
    const normalized = normalizeTranscript({
      taskId: artifact.taskId,
      text: artifact.text,
      metadata: taskMap.get(artifact.taskId) || {},
    });
    const existing = byTask.get(normalized.taskId);
    if (!existing || normalized.text.length > existing.text.length) {
      byTask.set(normalized.taskId, normalized);
    }
  }
  for (const inline of collection.inline || []) {
    const normalized = normalizeTranscript({
      taskId: inline.taskId,
      payload: inline.payload,
      metadata: taskMap.get(inline.taskId) || {},
    });
    const existing = byTask.get(normalized.taskId);
    if (!existing || normalized.text.length > existing.text.length) {
      byTask.set(normalized.taskId, normalized);
    }
  }

  return collection.tasks.map((task) => {
    const normalized = byTask.get(task.taskId);
    return (
      normalized || {
        taskId: task.taskId,
        metadata: task,
        utterances: [],
        text: "",
      }
    );
  });
}

export function normalizeUploadedCalls(calls) {
  if (!Array.isArray(calls)) return [];
  return calls.slice(0, 500).map((call, index) =>
    normalizeTranscript({
      taskId: call?.taskId || call?.id || `uploaded-${index + 1}`,
      payload: call?.utterances || call?.dialog || call?.segments || call?.text || call,
      metadata: call?.metadata || {},
    }),
  );
}
