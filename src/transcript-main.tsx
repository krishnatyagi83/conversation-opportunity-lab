import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./transcript-lab.css";

type EvidenceCall = { taskId: string; excerpt: string };
type Candidate = {
  id: string;
  rank: number;
  solution: "AI Agent" | "AI Assistant";
  title: string;
  score: number;
  confidence: string;
  thesis: string;
  operatingModel: string;
  capability: string;
  evidence: string[];
  evidenceCalls: EvidenceCall[];
  successMeasures: string[];
  prerequisites: string[];
  guardrail: string;
};
type Topic = {
  id: string;
  name: string;
  calls: number;
  share: number;
  transferRate: number;
  negativeRate: number;
  averageHoldSeconds: number;
  averageHandleSeconds: number;
  workflow: string;
};
type CallEvidence = {
  taskId: string;
  hasTranscript: boolean;
  primaryTopic: string;
  wordCount: number;
  turnCount: number;
  negativeSignals: number;
  transferCount: number;
  holdDuration: number;
  handleTime: number;
  excerpt: string;
};
type AnalysisReport = {
  generatedAt: string;
  methodologyVersion: string;
  source: string;
  summary: {
    callsRequested: number;
    callsWithTranscript: number;
    transcriptCoverage: number;
    topicCount: number;
    agentCandidateCount: number;
    assistantCandidateCount: number;
    topRecommendation: string;
  };
  baseline: {
    medianHandleSeconds: number;
    p75HandleSeconds: number;
    medianHoldSeconds: number;
    transferCallRate: number;
    negativeLanguageRate: number;
    resolutionLanguageRate: number;
    manualWorkSignalRate: number;
    basis: string;
  };
  topics: Topic[];
  candidates: Candidate[];
  calls: CallEvidence[];
  keywords: { term: string; calls: number }[];
  supplementary: {
    provided: boolean;
    fileName?: string;
    rowCount: number;
    fields: string[];
    signals: string[];
    evidenceRows: {
      topicId: string;
      label: string;
      rowCount: number;
      volume: number | null;
      handleValue: number | null;
      transferValue: number | null;
      outcomeValue: number | null;
    }[];
  };
  evidenceWarnings: string[];
  nextSteps: string[];
  ingestion?: {
    tasksMatched: number;
    captureArtifacts: number;
    transcriptsDownloaded: number;
    inlineTranscripts: number;
    failures: { taskId?: string; message: string }[];
    searchPagesRead: number;
    elapsedMs: number;
    credentialRetention: string;
  };
};

type Supplementary = {
  fileName: string;
  rows: Record<string, string | number | boolean | null>[];
};

const formatPercent = (value: number) => `${Math.round(value * 100)}%`;
const formatSeconds = (value: number) => {
  if (!value) return "Not available";
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

function isoDate(daysAgo: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

const DEMO_CALLS = [
  ["I am locked out again and the password reset link is not working.", "I will verify your account, check the lock status, and send a new link."],
  ["I forgot my password and cannot sign in to the app.", "Let me pull up the reset procedure and verify your identity."],
  ["Where is my order? The tracking has not changed in four days.", "I am checking the shipping system and delivery status now."],
  ["Can you tell me when my order will arrive?", "I found the tracking record. The current delivery estimate is Friday."],
  ["I need to reschedule my appointment to next week.", "I will check the available time slots and update the booking."],
  ["Can I book an appointment for Tuesday morning?", "I am checking availability. I have two time slots."],
  ["My bill has an extra charge and I do not understand the fee.", "I need to review the statement and the billing policy."],
  ["I was charged twice. This is frustrating and I want a supervisor.", "I will open a billing dispute and transfer you with the details."],
  ["The service is offline and I already restarted twice.", "Let me check the outage system, then we will run two diagnostic steps."],
  ["It still does not work after the update.", "I need to look up the error and check the configuration before we escalate."],
  ["What is your return policy?", "Returns are eligible within the published window. I can explain the steps."],
  ["I want to cancel my service because it is too expensive.", "I will review the account and connect you with the retention team."],
].map(([customer, agent], index) => ({
  taskId: `demo-${String(index + 1).padStart(3, "0")}`,
  utterances: [
    { role: "Customer", text: customer },
    { role: "Agent", text: agent },
  ],
  metadata: {
    handleTime: 240_000 + index * 11_000,
    holdDuration: index % 3 === 0 ? 42_000 : 8_000,
    transferCount: index === 7 || index === 11 ? 1 : 0,
    wrapupDuration: 32_000,
  },
}));

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift()?.map((header, index) => header || `column_${index + 1}`) || [];
  return rows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])),
  );
}

async function parseSupplementary(file: File): Promise<Supplementary> {
  const text = await file.text();
  if (file.name.toLowerCase().endsWith(".json")) {
    const parsed: unknown = JSON.parse(text);
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown[] }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : [];
    return {
      fileName: file.name,
      rows: rows.filter(
        (item): item is Record<string, string | number | boolean | null> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      ),
    };
  }
  return { fileName: file.name, rows: parseCsv(text) };
}

async function requestAnalysis(path: string, body: object): Promise<AnalysisReport> {
  const response = await fetch(`/transcript-api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as AnalysisReport & {
    error?: string;
    details?: unknown;
  };
  if (!response.ok) {
    throw new Error(payload.error || "The analysis request failed.");
  }
  return payload;
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function CandidateCard({ candidate }: { candidate: Candidate }) {
  const [expanded, setExpanded] = useState(candidate.rank <= 2);
  return (
    <article className={`candidate-card ${candidate.solution === "AI Agent" ? "is-agent" : "is-assistant"}`}>
      <div className="candidate-head">
        <div className="rank">{candidate.rank}</div>
        <div>
          <div className="candidate-labels">
            <span>{candidate.solution}</span>
            <span>{candidate.confidence} confidence</span>
          </div>
          <h3>{candidate.title}</h3>
        </div>
        <div className="score" aria-label={`Opportunity score ${candidate.score} out of 100`}>
          <strong>{candidate.score}</strong>
          <span>/100</span>
        </div>
      </div>
      <p className="thesis">{candidate.thesis}</p>
      <div className="evidence-chips">
        {candidate.evidence.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <button className="text-button" type="button" onClick={() => setExpanded((value) => !value)}>
        {expanded ? "Hide recommendation detail" : "Show recommendation detail"}
      </button>
      {expanded ? (
        <div className="candidate-detail">
          <div>
            <h4>How it would work</h4>
            <p>{candidate.operatingModel}</p>
            <h4>Webex solution fit</h4>
            <p>{candidate.capability}</p>
            <h4>Guardrail</h4>
            <p>{candidate.guardrail}</p>
          </div>
          <div>
            <h4>Measures for a pilot</h4>
            <ul>{candidate.successMeasures.map((item) => <li key={item}>{item}</li>)}</ul>
            <h4>Foundation needed</h4>
            <ul>{candidate.prerequisites.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          <div className="call-proof">
            <h4>Calls behind this recommendation</h4>
            {candidate.evidenceCalls.map((call) => (
              <div key={call.taskId}>
                <code>{call.taskId}</code>
                <p>“{call.excerpt}”</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function Results({ report, onReset }: { report: AnalysisReport; onReset: () => void }) {
  const [view, setView] = useState<"opportunities" | "topics" | "calls" | "foundation">("opportunities");
  const [solution, setSolution] = useState<"All" | "AI Agent" | "AI Assistant">("All");
  const candidates = report.candidates.filter(
    (candidate) => solution === "All" || candidate.solution === solution,
  );

  function downloadReport(kind: "json" | "markdown") {
    const markdown = [
      `# Conversation Opportunity Lab`,
      ``,
      `Generated: ${new Date(report.generatedAt).toLocaleString()}`,
      ``,
      `Analyzed ${report.summary.callsWithTranscript} transcript-bearing calls from ${report.summary.callsRequested} selected calls.`,
      ``,
      ...report.candidates.flatMap((candidate) => [
        `## ${candidate.rank}. ${candidate.title} (${candidate.solution})`,
        ``,
        `${candidate.thesis}`,
        ``,
        `Score: ${candidate.score}/100. Confidence: ${candidate.confidence}.`,
        ``,
        `Webex fit: ${candidate.capability}`,
        ``,
        `Guardrail: ${candidate.guardrail}`,
        ``,
      ]),
      `## Evidence cautions`,
      ``,
      ...report.evidenceWarnings.map((item) => `- ${item}`),
    ].join("\n");
    const blob = new Blob([kind === "json" ? JSON.stringify(report, null, 2) : markdown], {
      type: kind === "json" ? "application/json" : "text/markdown",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `conversation-opportunity-report.${kind === "json" ? "json" : "md"}`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <>
      <header className="result-hero">
        <div>
          <div className="eyebrow">Analysis complete</div>
          <h1>{report.summary.topRecommendation}</h1>
          <p>
            {report.summary.callsWithTranscript} usable transcripts produced {report.summary.topicCount} contact drivers and {report.candidates.length} ranked opportunities.
          </p>
        </div>
        <div className="hero-actions">
          <button className="secondary" onClick={() => downloadReport("markdown")}>Export brief</button>
          <button className="secondary" onClick={() => downloadReport("json")}>Export evidence</button>
          <button className="primary" onClick={onReset}>New analysis</button>
        </div>
      </header>

      <section className="metric-grid" aria-label="Analysis coverage">
        <Metric label="Transcript coverage" value={formatPercent(report.summary.transcriptCoverage)} note={`${report.summary.callsWithTranscript} of ${report.summary.callsRequested} calls`} />
        <Metric label="AI Agent paths" value={String(report.summary.agentCandidateCount)} note="Customer-facing automation candidates" />
        <Metric label="AI Assistant paths" value={String(report.summary.assistantCandidateCount)} note="Human-agent workflow candidates" />
        <Metric label="Transfer signal" value={formatPercent(report.baseline.transferCallRate)} note="Calls with observed transfer metadata" />
      </section>

      <nav className="result-tabs" aria-label="Analysis views">
        {(["opportunities", "topics", "calls", "foundation"] as const).map((tab) => (
          <button key={tab} className={view === tab ? "active" : ""} onClick={() => setView(tab)}>
            {tab === "opportunities" ? "Use-case portfolio" : tab === "topics" ? "Contact drivers" : tab === "calls" ? "Call evidence" : "Foundation plan"}
          </button>
        ))}
      </nav>

      {view === "opportunities" ? (
        <section>
          <div className="section-heading">
            <div><span className="eyebrow">Decision view</span><h2>Ranked use-case portfolio</h2></div>
            <div className="segmented">
              {(["All", "AI Agent", "AI Assistant"] as const).map((item) => (
                <button key={item} className={solution === item ? "active" : ""} onClick={() => setSolution(item)}>{item}</button>
              ))}
            </div>
          </div>
          <div className="candidate-list">
            {candidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} />)}
          </div>
        </section>
      ) : null}

      {view === "topics" ? (
        <section className="panel">
          <div className="section-heading"><div><span className="eyebrow">Demand pattern</span><h2>Contact drivers in this sample</h2></div></div>
          <div className="topic-table" role="table">
            <div className="topic-row topic-header" role="row"><span>Contact driver</span><span>Calls</span><span>Share</span><span>Transfer</span><span>Avg handle</span></div>
            {report.topics.map((topic) => (
              <div className="topic-row" role="row" key={topic.id}>
                <span><strong>{topic.name}</strong><small>{topic.workflow}</small></span>
                <span>{topic.calls}</span><span>{formatPercent(topic.share)}</span><span>{formatPercent(topic.transferRate)}</span><span>{formatSeconds(topic.averageHandleSeconds)}</span>
              </div>
            ))}
          </div>
          <div className="keyword-strip">{report.keywords.map((item) => <span key={item.term}>{item.term} <b>{item.calls}</b></span>)}</div>
        </section>
      ) : null}

      {view === "calls" ? (
        <section className="panel">
          <div className="section-heading"><div><span className="eyebrow">Traceability</span><h2>Redacted call evidence</h2></div><p>Raw transcripts remain in memory only. These excerpts were automatically redacted.</p></div>
          <div className="call-list">
            {report.calls.map((call) => (
              <article key={call.taskId}>
                <div><code>{call.taskId}</code><span>{call.primaryTopic}</span></div>
                <p>{call.excerpt}</p>
                <small>{call.wordCount} words · {call.turnCount} turns · {formatSeconds(call.handleTime)} handle · {call.transferCount} transfers</small>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {view === "foundation" ? (
        <section className="foundation-grid">
          <article className="panel">
            <span className="eyebrow">Baseline</span><h2>What the sample says</h2>
            <dl className="baseline-list">
              <div><dt>Median handle</dt><dd>{formatSeconds(report.baseline.medianHandleSeconds)}</dd></div>
              <div><dt>75th percentile handle</dt><dd>{formatSeconds(report.baseline.p75HandleSeconds)}</dd></div>
              <div><dt>Median hold</dt><dd>{formatSeconds(report.baseline.medianHoldSeconds)}</dd></div>
              <div><dt>Negative language signal</dt><dd>{formatPercent(report.baseline.negativeLanguageRate)}</dd></div>
              <div><dt>Manual work signal</dt><dd>{formatPercent(report.baseline.manualWorkSignalRate)}</dd></div>
            </dl>
            <p className="basis-note">{report.baseline.basis}</p>
          </article>
          <article className="panel">
            <span className="eyebrow">Triangulation</span><h2>Supporting evidence</h2>
            {report.supplementary.provided ? (
              <><div className="status-good">{report.supplementary.fileName}: {report.supplementary.rowCount} rows</div><p>Detected evidence families: {report.supplementary.signals.join(", ") || "custom fields"}. {report.supplementary.evidenceRows.length ? `${report.supplementary.evidenceRows.length} contact drivers were reconciled to transcript themes and used as corroborating ranking evidence.` : "No report topics could be safely reconciled to transcript themes."}</p></>
            ) : (
              <><div className="status-warn">Analyzer evidence not yet supplied</div><p>Add queue volume, AHT, transfer, Topic Analytics, sentiment, and outcome fields in the next run.</p></>
            )}
            {report.ingestion ? <p className="ingestion-note">Matched {report.ingestion.tasksMatched} tasks across {report.ingestion.searchPagesRead} Search API pages. Downloaded {report.ingestion.transcriptsDownloaded} transcript artifacts. Token retention: {report.ingestion.credentialRetention}.</p> : null}
          </article>
          <article className="panel next-steps">
            <span className="eyebrow">Activation path</span><h2>Move from signal to pilot</h2>
            <ol>{report.nextSteps.map((item) => <li key={item}>{item}</li>)}</ol>
          </article>
          <article className="panel warning-panel">
            <span className="eyebrow">Evidence limits</span><h2>What not to overclaim</h2>
            <ul>{report.evidenceWarnings.map((item) => <li key={item}>{item}</li>)}</ul>
          </article>
        </section>
      ) : null}
    </>
  );
}

function App() {
  const [mode, setMode] = useState<"live" | "upload">("live");
  const [apiBaseUrl, setApiBaseUrl] = useState("https://api.wxcc-us1.cisco.com");
  const [orgId, setOrgId] = useState("");
  const [queueId, setQueueId] = useState("");
  const [from, setFrom] = useState(isoDate(7));
  const [to, setTo] = useState(isoDate(0));
  const [callLimit, setCallLimit] = useState(100);
  const [accessToken, setAccessToken] = useState("");
  const [uploadedCalls, setUploadedCalls] = useState<unknown[]>([]);
  const [transcriptFileName, setTranscriptFileName] = useState("");
  const [supplementary, setSupplementary] = useState<Supplementary | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState("");
  const dateRangeDays = useMemo(() => Math.max(0, Math.ceil((Date.parse(to) - Date.parse(from)) / 86_400_000)), [from, to]);

  async function runAnalysis() {
    setStatus("running");
    setError("");
    try {
      const result = mode === "live"
        ? await requestAnalysis("/run", {
            apiBaseUrl, orgId, queueId, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z`, callLimit, accessToken, supplementary,
          })
        : await requestAnalysis("/analyze-upload", { calls: uploadedCalls, supplementary, source: "transcript-upload" });
      setReport(result);
      setStatus("idle");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Analysis failed.");
      setStatus("error");
    }
  }

  async function handleTranscriptFile(file: File | undefined) {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const calls = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { calls?: unknown[] }).calls)
          ? (parsed as { calls: unknown[] }).calls
          : [];
      setUploadedCalls(calls);
      setTranscriptFileName(file.name);
      setError(calls.length ? "" : "The JSON file did not contain a calls array.");
    } catch {
      setError("Transcript upload must be valid JSON.");
    }
  }

  if (report) return <main className="lab-shell"><Results report={report} onReset={() => setReport(null)} /></main>;

  return (
    <main className="lab-shell setup-shell">
      <header className="topbar">
        <div className="brand-mark">CX</div>
        <div><strong>Conversation Opportunity Lab</strong><span>Webex Contact Center</span></div>
        <div className="local-badge"><i /> Local and ephemeral</div>
      </header>

      <section className="setup-hero">
        <div>
          <span className="eyebrow">Evidence before automation</span>
          <h1>Turn a queue’s conversations into an AI portfolio.</h1>
          <p>Collect a bounded sample, find recurring customer demand, and separate customer-facing AI Agent opportunities from human-agent AI Assistant opportunities.</p>
        </div>
        <div className="product-legend">
          <div><span className="legend-icon agent">A</span><p><strong>AI Agent</strong> Handles bounded voice or digital journeys with knowledge, actions, and escalation.</p></div>
          <div><span className="legend-icon assistant">✦</span><p><strong>AI Assistant</strong> Supports agents and supervisors with real-time guidance, summaries, topics, sentiment, and outcome insight.</p></div>
        </div>
      </section>

      <section className="setup-grid">
        <div className="setup-form panel">
          <div className="mode-switch">
            <button className={mode === "live" ? "active" : ""} onClick={() => setMode("live")}>Connect to Webex</button>
            <button className={mode === "upload" ? "active" : ""} onClick={() => setMode("upload")}>Upload transcript JSON</button>
          </div>

          {mode === "live" ? (
            <>
              <div className="form-section"><span className="step-number">1</span><div><h2>Choose the queue sample</h2><p>The Search API finds task IDs for this queue and time window.</p></div></div>
              <label className="field full"><span>Webex Contact Center API base URL</span><input value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} /></label>
              <div className="field-grid">
                <label className="field"><span>Control Hub organization ID</span><input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={orgId} onChange={(event) => setOrgId(event.target.value)} /></label>
                <label className="field"><span>Queue ID</span><input placeholder="Queue UUID" value={queueId} onChange={(event) => setQueueId(event.target.value)} /></label>
                <label className="field"><span>From</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
                <label className="field"><span>Through</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
              </div>
              <label className="range-field"><span><b>Calls to analyze</b><strong>{callLimit}</strong></span><input type="range" min="10" max="500" step="10" value={callLimit} onChange={(event) => setCallLimit(Number(event.target.value))} /><small>{dateRangeDays} day window. Captures are requested in compliant batches of 10.</small></label>
              <div className="form-section divider"><span className="step-number">2</span><div><h2>Add a temporary token</h2><p>The local service uses it for this run, then discards it.</p></div></div>
              <label className="field full"><span>Webex access token</span><input type="password" autoComplete="off" placeholder="Paste temporary bearer token" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} /></label>
              <div className="privacy-note"><b>Credential boundary</b><span>The token is sent only to 127.0.0.1 and never logged or written to disk. It stays only in this tab’s memory so you can run another query, and is removed when the tab closes or you clear it.</span><button type="button" className="clear-token" disabled={!accessToken} onClick={() => setAccessToken("")}>Clear token</button></div>
            </>
          ) : (
            <>
              <div className="form-section"><span className="step-number">1</span><div><h2>Upload transcript JSON</h2><p>Use an array of calls or an object with a <code>calls</code> array. Each call can contain text, utterances, segments, or vCon dialog.</p></div></div>
              <label className="upload-box"><input type="file" accept="application/json,.json" onChange={(event) => void handleTranscriptFile(event.target.files?.[0])} /><span>{transcriptFileName || "Choose transcript JSON"}</span><small>{uploadedCalls.length ? `${uploadedCalls.length} calls ready` : "No transcript data leaves this computer"}</small></label>
              <button className="demo-button" type="button" onClick={() => { setUploadedCalls(DEMO_CALLS); setTranscriptFileName("Built-in demonstration sample"); setError(""); }}>Use demonstration sample</button>
            </>
          )}

          <div className="form-section divider"><span className="step-number">3</span><div><h2>Triangulate with reporting</h2><p>Optional now. Add Analyzer or Topic Analytics CSV/JSON to strengthen the baseline.</p></div></div>
          <label className="upload-row"><input type="file" accept="text/csv,application/json,.csv,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void parseSupplementary(file).then(setSupplementary).catch(() => setError("Could not read the supplementary file.")); }} /><span>{supplementary ? `${supplementary.fileName} · ${supplementary.rows.length} rows` : "Add supplementary report"}</span></label>
          {error ? <div className="error-message" role="alert">{error}</div> : null}
          <button className="run-button" disabled={status === "running" || (mode === "live" ? !orgId || !queueId || !accessToken : !uploadedCalls.length)} onClick={() => void runAnalysis()}>
            {status === "running" ? <><i className="spinner" /> Collecting and analyzing evidence…</> : <>Build AI opportunity portfolio <span>→</span></>}
          </button>
        </div>

        <aside className="method-panel">
          <span className="eyebrow">What this run does</span>
          <ol>
            <li><b>Find queue calls</b><span>Paginate Search API task-leg records and deduplicate task IDs.</span></li>
            <li><b>Retrieve captures</b><span>Request transcript artifacts in batches of 10 and tolerate partial artifact failures.</span></li>
            <li><b>Protect the evidence</b><span>Normalize transcript formats, redact common identifiers, and keep raw text in memory.</span></li>
            <li><b>Rank use cases</b><span>Score recurring intent, friction, repeatability, action need, risk, and evidence coverage.</span></li>
            <li><b>Build the foundation</b><span>Define prerequisites, guardrails, pilot measures, and gaps to reconcile.</span></li>
          </ol>
          <div className="method-callout"><strong>Recommendation principle</strong><p>Use AI Agent where the customer journey is bounded and governable. Use AI Assistant where human judgment remains central but knowledge, procedure, summaries, or next actions create leverage.</p></div>
        </aside>
      </section>

      <footer className="lab-footer">
        <span>Local prototype · No credential or transcript persistence</span>
        <span>Methodology separates activity, adoption, operations, customer outcomes, and economics.</span>
      </footer>
    </main>
  );
}

const root = document.getElementById("transcript-root");
if (!root) throw new Error("The transcript application root is missing.");
createRoot(root).render(<StrictMode><App /></StrictMode>);
