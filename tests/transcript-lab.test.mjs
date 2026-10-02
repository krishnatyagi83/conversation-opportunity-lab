import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCalls } from "../transcript-service/lib/analyzer.mjs";
import {
  normalizeTranscript,
  normalizeUploadedCalls,
  redactText,
} from "../transcript-service/lib/transcript.mjs";
import {
  __test as webexTest,
  listCaptureArtifacts,
  normalizeApiBaseUrl,
} from "../transcript-service/lib/webex.mjs";

test("redacts common identifiers before evidence leaves the service", () => {
  const redacted = redactText(
    "Email jane@example.com or call (408) 555-1212. Card 4111 1111 1111 1111.",
  );
  assert.equal(
    redacted,
    "Email [email] or call [phone]. Card [payment-number].",
  );
});

test("normalizes vCon-style serialized dialog bodies", () => {
  const transcript = normalizeTranscript({
    taskId: "task-1",
    payload: {
      dialog: [
        {
          body: JSON.stringify({
            direction: "inbound",
            text: "I need to reset my password",
          }),
        },
        {
          body: JSON.stringify({
            direction: "outbound",
            text: "I can help with the reset",
          }),
        },
      ],
    },
  });
  assert.equal(transcript.utterances.length, 2);
  assert.equal(transcript.utterances[0].role, "Customer");
  assert.match(transcript.text, /reset my password/);
});

test("ranks recurring self-service and agent-guidance opportunities", () => {
  const calls = normalizeUploadedCalls(
    Array.from({ length: 8 }, (_, index) => ({
      taskId: `call-${index}`,
      utterances: [
        {
          role: "Customer",
          text:
            index < 5
              ? "I forgot my password and cannot sign in"
              : "My service is not working and I already restarted it",
        },
        {
          role: "Agent",
          text: "I will verify the account, check the system, and follow the procedure",
        },
      ],
      metadata: {
        handleTime: 360_000,
        holdDuration: 40_000,
        transferCount: index % 3 === 0 ? 1 : 0,
      },
    })),
  );
  const report = analyzeCalls(calls);
  assert.equal(report.summary.callsWithTranscript, 8);
  assert.ok(report.candidates.some((item) => item.solution === "AI Agent"));
  assert.ok(report.candidates.some((item) => item.solution === "AI Assistant"));
  assert.equal(report.topics[0].name, "Account access & authentication");
  assert.match(report.baseline.basis, /not causal ROI/);
});

test("uses matching Analyzer rows as separate corroborating evidence", () => {
  const calls = normalizeUploadedCalls([
    {
      taskId: "order-call-1",
      text: "Where is my order and what is the delivery status?",
    },
    {
      taskId: "order-call-2",
      text: "I need the tracking status for my shipment.",
    },
  ]);
  const report = analyzeCalls(calls, {
    supplementary: {
      fileName: "analyzer.csv",
      rows: [
        {
          "Contact Driver": "Order status and tracking",
          Interactions: "240",
          "Average Handle Time": "315",
        },
      ],
    },
  });
  assert.equal(report.supplementary.evidenceRows[0].volume, 240);
  assert.ok(
    report.candidates.some((candidate) =>
      candidate.evidence.includes("240 reported interactions in analyzer.csv"),
    ),
  );
});

test("allows only Cisco HTTPS API hosts", () => {
  assert.equal(
    normalizeApiBaseUrl("https://api.wxcc-us1.cisco.com/"),
    "https://api.wxcc-us1.cisco.com",
  );
  assert.throws(() => normalizeApiBaseUrl("http://api.wxcc-us1.cisco.com"));
  assert.throws(() => normalizeApiBaseUrl("https://example.com"));
});

test("extracts transcript URLs and preserves their task IDs", () => {
  const artifacts = webexTest.collectTranscriptArtifacts({
    data: [
      {
        taskId: "task-123",
        transcription: [{ url: "https://signed.example/transcript.json" }],
      },
    ],
  });
  assert.deepEqual(artifacts, [
    {
      taskId: "task-123",
      url: "https://signed.example/transcript.json",
      sourcePath: "data.transcription.url",
    },
  ]);
});

test("requests capture metadata in batches of at most ten tasks", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body.query.taskIds);
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const tasks = Array.from({ length: 23 }, (_, index) => ({
    taskId: `task-${index}`,
  }));
  await listCaptureArtifacts(
    tasks,
    {
      apiBaseUrl: "https://api.wxcc-us1.cisco.com",
      headers: { Authorization: "Bearer hidden" },
      orgId: "org-1",
    },
    { fetchImpl },
  );
  assert.deepEqual(
    requests.map((batch) => batch.length),
    [10, 10, 3],
  );
});
