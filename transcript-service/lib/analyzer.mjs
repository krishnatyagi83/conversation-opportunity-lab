const STOP_WORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have he her here him his how i if in into is it its just may me my no not of on or our out please she so that the their them then there they this to up us was we were what when where which who why will with would you your`.split(
    " ",
  ),
);

const TOPIC_CATALOG = [
  {
    id: "account-access",
    name: "Account access & authentication",
    pattern:
      /\b(login|log in|sign in|password|passcode|locked out|unlock|verification|verify identity|authentication|one.time code|otp|reset)\b/gi,
    workflow: "Authenticate the customer, diagnose access state, and complete a governed reset or unlock action.",
    risk: "medium",
  },
  {
    id: "billing-payment",
    name: "Billing & payment",
    pattern:
      /\b(bill|billing|charge|charged|payment|invoice|balance|statement|fee|price|refund|credit card|autopay)\b/gi,
    workflow: "Explain charges, retrieve account-specific billing context, and complete eligible payment or adjustment actions.",
    risk: "high",
  },
  {
    id: "order-status",
    name: "Order or case status",
    pattern:
      /\b(order|shipment|shipping|delivery|delivered|tracking|case status|ticket status|request status|where is|eta)\b/gi,
    workflow: "Authenticate when needed, retrieve current status, explain the next milestone, and offer an escalation path.",
    risk: "low",
  },
  {
    id: "appointments",
    name: "Appointments & scheduling",
    pattern:
      /\b(appointment|schedule|reschedule|cancel.*appointment|availability|available time|time slot|booking|book a)\b/gi,
    workflow: "Find availability, collect required details, book or change the appointment, and confirm the outcome.",
    risk: "low",
  },
  {
    id: "returns-cancellations",
    name: "Returns, refunds & cancellations",
    pattern:
      /\b(return|replacement|replace|refund|cancel|cancellation|exchange|money back|terminate service)\b/gi,
    workflow: "Determine eligibility, explain policy, collect required details, and initiate the approved workflow.",
    risk: "medium",
  },
  {
    id: "technical-support",
    name: "Technical troubleshooting",
    pattern:
      /\b(not working|doesn.t work|error|issue|problem|troubleshoot|restart|reboot|connection|offline|outage|slow|failed|failure|setup|configure)\b/gi,
    workflow: "Identify symptoms, guide a validated diagnostic sequence, observe results, and escalate with context when unresolved.",
    risk: "medium",
  },
  {
    id: "policy-faq",
    name: "Policy, eligibility & FAQs",
    pattern:
      /\b(policy|eligible|eligibility|requirement|how do i|how can i|what is|where can i|hours|location|coverage|included|allowed)\b/gi,
    workflow: "Resolve the question from governed knowledge and make the next eligible action clear.",
    risk: "low",
  },
  {
    id: "profile-changes",
    name: "Account & profile changes",
    pattern:
      /\b(change my|update my|address|phone number|email address|profile|account details|add user|remove user|name change)\b/gi,
    workflow: "Verify identity, gather the change, apply it through an approved action, and confirm completion.",
    risk: "medium",
  },
  {
    id: "retention",
    name: "Cancellation risk & retention",
    pattern:
      /\b(cancel my|close my|leave|switching|competitor|too expensive|not worth|terminate|retention|keep my service)\b/gi,
    workflow: "Recognize cancellation intent, understand the driver, present eligible options, and hand off sensitive negotiations.",
    risk: "high",
  },
];

const NEGATIVE_TERMS =
  /\b(frustrated|angry|upset|unacceptable|ridiculous|terrible|awful|disappointed|confused|annoyed|again|still not|complaint|supervisor|manager)\b/gi;
const ESCALATION_TERMS =
  /\b(supervisor|manager|escalate|complaint|legal|attorney|regulator|fraud|emergency|harm|threat|dispute)\b/gi;
const MANUAL_WORK_TERMS =
  /\b(check|look up|pull up|search|system|another screen|knowledge|procedure|process|form|submit|enter|document|note|case|ticket)\b/gi;
const RESOLUTION_TERMS =
  /\b(resolved|fixed|all set|completed|done|working now|that worked|thank you|thanks for your help)\b/gi;
const REPETITION_TERMS =
  /\b(as i said|already told|again|repeat|repeating|start over|same information)\b/gi;
const SENSITIVE_TERMS =
  /\b(social security|credit card|card number|bank account|medical|diagnosis|attorney|fraud|identity theft)\b/gi;

function countMatches(text, pattern) {
  const matches = String(text || "").match(pattern);
  return matches ? matches.length : 0;
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function durationSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number / 1000;
}

function callFeatures(call) {
  const text = call.text || "";
  const words = text.match(/[A-Za-z][A-Za-z'-]+/g) || [];
  const topicMatches = TOPIC_CATALOG.map((topic) => ({
    ...topic,
    mentions: countMatches(text, topic.pattern),
  })).sort((a, b) => b.mentions - a.mentions);
  const primaryTopic = topicMatches[0]?.mentions ? topicMatches[0] : null;
  const metadata = call.metadata || {};
  const transferCount = Number(metadata.transferCount) || 0;
  const holdDuration = durationSeconds(metadata.holdDuration);
  const handleTime =
    durationSeconds(metadata.handleTime) ||
    durationSeconds(metadata.connectedDuration) ||
    (Number(metadata.endedTime) > Number(metadata.createdTime)
      ? (Number(metadata.endedTime) - Number(metadata.createdTime)) / 1000
      : 0);
  return {
    taskId: call.taskId,
    hasTranscript: text.trim().length > 0,
    wordCount: words.length,
    turnCount: call.utterances?.length || 0,
    primaryTopicId: primaryTopic?.id || "other",
    primaryTopicName: primaryTopic?.name || "Other / not classified",
    topicMatches,
    negativeSignals: countMatches(text, NEGATIVE_TERMS),
    escalationSignals: countMatches(text, ESCALATION_TERMS),
    manualWorkSignals: countMatches(text, MANUAL_WORK_TERMS),
    resolutionSignals: countMatches(text, RESOLUTION_TERMS),
    repetitionSignals: countMatches(text, REPETITION_TERMS),
    sensitiveSignals: countMatches(text, SENSITIVE_TERMS),
    questionCount: countMatches(text, /\?/g),
    transferCount,
    holdDuration,
    handleTime,
    wrapupDuration: durationSeconds(metadata.wrapupDuration),
    queueDuration: durationSeconds(metadata.queueDuration),
    excerpt: evidenceExcerpt(call),
  };
}

function evidenceExcerpt(call) {
  const customer = (call.utterances || []).find(
    (item) => item.role === "Customer" && item.text.length >= 18,
  );
  const source = customer?.text || call.utterances?.[0]?.text || "";
  if (!source) return "Transcript text was unavailable.";
  return source.length > 180 ? `${source.slice(0, 177)}...` : source;
}

function aggregateTopics(features) {
  const withTranscript = features.filter((call) => call.hasTranscript);
  const counts = new Map();
  for (const call of withTranscript) {
    const topic = TOPIC_CATALOG.find((item) => item.id === call.primaryTopicId);
    const key = topic?.id || "other";
    const current = counts.get(key) || {
      id: key,
      name: topic?.name || "Other / not classified",
      calls: 0,
      mentions: 0,
      transferCalls: 0,
      negativeCalls: 0,
      holdSeconds: 0,
      handleSeconds: 0,
      taskIds: [],
      workflow: topic?.workflow || "Review a sample of calls and refine the intent taxonomy.",
      risk: topic?.risk || "medium",
    };
    current.calls += 1;
    current.mentions +=
      call.topicMatches.find((item) => item.id === key)?.mentions || 0;
    current.transferCalls += call.transferCount > 0 ? 1 : 0;
    current.negativeCalls += call.negativeSignals > 0 ? 1 : 0;
    current.holdSeconds += call.holdDuration;
    current.handleSeconds += call.handleTime;
    current.taskIds.push(call.taskId);
    counts.set(key, current);
  }

  return [...counts.values()]
    .map((topic) => ({
      ...topic,
      share: withTranscript.length ? topic.calls / withTranscript.length : 0,
      transferRate: topic.calls ? topic.transferCalls / topic.calls : 0,
      negativeRate: topic.calls ? topic.negativeCalls / topic.calls : 0,
      averageHoldSeconds: topic.calls ? topic.holdSeconds / topic.calls : 0,
      averageHandleSeconds: topic.calls ? topic.handleSeconds / topic.calls : 0,
    }))
    .sort((a, b) => b.calls - a.calls || b.mentions - a.mentions);
}

function scoreTopic(topic, totalCalls) {
  const volume = clamp((topic.calls / Math.max(totalCalls, 1)) * 220);
  const repeatability = clamp(topic.mentions * 4 + topic.calls * 5);
  const friction = clamp(
    topic.transferRate * 35 +
      topic.negativeRate * 30 +
      Math.min(topic.averageHoldSeconds / 6, 20),
  );
  const riskPenalty = topic.risk === "high" ? 24 : topic.risk === "medium" ? 10 : 0;
  const automation = clamp(volume * 0.38 + repeatability * 0.42 + (100 - friction) * 0.2 - riskPenalty);
  const assistance = clamp(volume * 0.25 + repeatability * 0.2 + friction * 0.55 + (topic.risk === "high" ? 12 : 0));
  return { automation: round(automation), assistance: round(assistance), friction: round(friction) };
}

function confidenceFor(topic, totalCalls, transcriptCoverage) {
  const sample = clamp((topic.calls / 10) * 100);
  const share = clamp((topic.calls / Math.max(totalCalls, 1)) * 160);
  const score = sample * 0.45 + share * 0.25 + transcriptCoverage * 100 * 0.3;
  if (score >= 75) return "High";
  if (score >= 45) return "Medium";
  return "Directional";
}

function topEvidence(topic, calls, limit = 3) {
  return topic.taskIds
    .map((id) => calls.find((call) => call.taskId === id))
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.manualWorkSignals + b.negativeSignals + b.transferCount -
        (a.manualWorkSignals + a.negativeSignals + a.transferCount),
    )
    .slice(0, limit)
    .map((call) => ({ taskId: call.taskId, excerpt: call.excerpt }));
}

function supplementaryEvidence(topic, supplement) {
  const match = supplement.evidenceRows?.find((row) => row.topicId === topic.id);
  if (!match) return [];
  return [
    match.volume != null
      ? `${match.volume} reported interactions in ${supplement.fileName}`
      : `Matching ${match.label} row in ${supplement.fileName}`,
  ];
}

function aiAgentCandidate(topic, scores, calls, totalCalls, coverage, supplement) {
  const secureAction = topic.risk === "high" || topic.risk === "medium";
  const supplementalEvidence = supplementaryEvidence(topic, supplement);
  return {
    id: `agent-${topic.id}`,
    solution: "AI Agent",
    title: `${topic.name} self-service`,
    score: clamp(scores.automation + (supplementalEvidence.length ? 6 : 0)),
    confidence: confidenceFor(topic, totalCalls, coverage),
    thesis: `${topic.calls} analyzed calls point to a repeatable ${topic.name.toLowerCase()} journey that can be tested as customer-facing self-service.`,
    operatingModel: topic.workflow,
    capability:
      "Webex AI Agent, using an autonomous agent when knowledge plus actions are required, or a scripted agent when the path must remain tightly defined.",
    evidence: [
      `${topic.calls} calls (${Math.round(topic.share * 100)}% of transcripts)`,
      `${Math.round(topic.transferRate * 100)}% showed a transfer signal`,
      `${Math.round(topic.negativeRate * 100)}% contained negative-experience language`,
      ...supplementalEvidence,
    ],
    evidenceCalls: topEvidence(topic, calls),
    successMeasures: [
      "Eligible intent containment rate",
      "Successful action completion rate",
      "Escalation rate with reason",
      "Customer effort and Auto CSAT guardrails",
    ],
    prerequisites: [
      "Approved intent scope and escalation rules",
      "Governed knowledge source with named content owner",
      secureAction
        ? "Authentication and least-privilege action integration"
        : "Clear answers and handoff destinations",
      "Baseline outcome metrics for the same queue and intent",
    ],
    guardrail:
      topic.risk === "high"
        ? "Begin with explanation, triage, or moderated execution. Keep disputes, fraud, regulated decisions, and exceptions with a human."
        : "Start with a bounded pilot and always provide a context-preserving human handoff.",
  };
}

function aiAssistantCandidate(topic, scores, calls, totalCalls, coverage, supplement) {
  const capability =
    topic.id === "technical-support" || topic.id === "policy-faq"
      ? "Real-time Assist with governed knowledge and recommended next steps"
      : topic.transferRate >= 0.2
        ? "mid-call transfer/consult summaries plus Real-time Assist"
        : "Real-time Assist and AI-generated summaries";
  const supplementalEvidence = supplementaryEvidence(topic, supplement);
  return {
    id: `assistant-${topic.id}`,
    solution: "AI Assistant",
    title: `${topic.name} agent guidance`,
    score: clamp(scores.assistance + (supplementalEvidence.length ? 6 : 0)),
    confidence: confidenceFor(topic, totalCalls, coverage),
    thesis: `${topic.name} calls combine recurring demand with agent effort, making this a candidate for in-workflow guidance before full automation.`,
    operatingModel:
      "Detect the live intent, surface the approved answer or procedure, recommend the next action, and preserve context through transfer and wrap-up.",
    capability: `Cisco AI Assistant: ${capability}. Topic Analytics can monitor the contact driver after launch.`,
    evidence: [
      `${topic.calls} calls (${Math.round(topic.share * 100)}% of transcripts)`,
      `${Math.round(topic.averageHoldSeconds)}s average observed hold time where metadata was present`,
      `${Math.round(topic.averageHandleSeconds)}s average observed handle time where metadata was present`,
      ...supplementalEvidence,
    ],
    evidenceCalls: topEvidence(topic, calls),
    successMeasures: [
      "Recommendation availability and agent adoption",
      "Handle and hold time by matched intent",
      "First-contact resolution proxy",
      "Transfer, repeat-contact, and Auto CSAT guardrails",
    ],
    prerequisites: [
      "Validated procedures and knowledge articles",
      "Queue-level AI Assistant enablement and agent readiness",
      "Intent-level baseline with adoption instrumentation",
      "Feedback loop for incorrect or unhelpful guidance",
    ],
    guardrail:
      "Treat adoption as a leading indicator, not ROI. Compare validated customer and operational outcomes for eligible interactions before claiming value.",
  };
}

function portfolioCandidates(topics, features, coverage, supplement) {
  const total = features.filter((call) => call.hasTranscript).length;
  const candidates = [];
  for (const topic of topics.slice(0, 6)) {
    if (topic.calls < 2 && total >= 10) continue;
    const scores = scoreTopic(topic, total);
    candidates.push(
      aiAgentCandidate(topic, scores, features, total, coverage, supplement),
    );
    candidates.push(
      aiAssistantCandidate(topic, scores, features, total, coverage, supplement),
    );
  }

  const transferred = features.filter((call) => call.transferCount > 0);
  if (transferred.length >= 2) {
    candidates.push({
      id: "assistant-transfer-summary",
      solution: "AI Assistant",
      title: "Context-preserving transfer summaries",
      score: clamp(55 + transferred.length * 3),
      confidence: transferred.length >= 8 ? "High" : "Medium",
      thesis: `${transferred.length} calls include transfer activity. Summaries can reduce repetition and give the receiving agent the reason, work completed, and unresolved need.`,
      operatingModel:
        "Generate a concise summary at transfer or consult, present it to the receiving agent, and retain the source transcript for authorized review.",
      capability: "Cisco AI Assistant mid-call transfer/consult summaries; AI Agent transfer summary when the originating interaction is automated.",
      evidence: [
        `${transferred.length} calls with transfer activity`,
        `${Math.round((transferred.length / Math.max(total, 1)) * 100)}% of transcript-bearing calls`,
      ],
      evidenceCalls: transferred.slice(0, 3).map((call) => ({
        taskId: call.taskId,
        excerpt: call.excerpt,
      })),
      successMeasures: [
        "Customer repetition rate after transfer",
        "Time to first meaningful response after transfer",
        "Transfer completion and Auto CSAT",
      ],
      prerequisites: [
        "Queue and agent enablement",
        "Summary quality sampling",
        "Clear retention and access policy",
      ],
      guardrail: "Review summary accuracy and omission risk before broad rollout.",
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function keywordPhrases(calls) {
  const counts = new Map();
  for (const call of calls.filter((item) => item.hasTranscript)) {
    const words = (call.excerpt.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter(
      (word) => !STOP_WORDS.has(word),
    );
    const unique = new Set(words);
    for (const word of unique) counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([term, calls]) => ({ term, calls }));
}

function supplementarySummary(supplementary) {
  if (!supplementary || !Array.isArray(supplementary.rows)) {
    return {
      provided: false,
      rowCount: 0,
      fields: [],
      signals: [],
      evidenceRows: [],
    };
  }
  const rows = supplementary.rows.slice(0, 5000);
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row || {})))].slice(0, 30);
  const lowerFields = fields.map((field) => field.toLowerCase());
  const signals = [];
  const mappings = [
    ["topic", /topic|contact.?driver|reason/],
    ["volume", /calls|contacts|interactions|volume|count/],
    ["handle time", /aht|handle|talk.?time/],
    ["transfer", /transfer/],
    ["customer outcome", /csat|sentiment|satisfaction/],
    ["queue", /queue/],
  ];
  for (const [name, pattern] of mappings) {
    if (lowerFields.some((field) => pattern.test(field))) signals.push(name);
  }

  const topicField = fields.find((field) => /topic|contact.?driver|reason/i.test(field));
  const volumeField = fields.find((field) => /calls|contacts|interactions|volume|count/i.test(field));
  const handleField = fields.find((field) => /aht|average.*handle|handle.?time/i.test(field));
  const transferField = fields.find((field) => /transfer/i.test(field));
  const outcomeField = fields.find((field) => /csat|sentiment|satisfaction/i.test(field));
  const numeric = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const cleaned = String(value ?? "").replace(/[%,$\s]/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const classified = new Map();
  if (topicField) {
    for (const row of rows) {
      const label = String(row?.[topicField] ?? "").trim();
      if (!label) continue;
      const topic = TOPIC_CATALOG
        .map((item) => ({ item, matches: countMatches(label, item.pattern) }))
        .sort((a, b) => b.matches - a.matches)[0];
      const topicId = topic?.matches ? topic.item.id : null;
      if (!topicId) continue;
      const current = classified.get(topicId) || {
        topicId,
        label,
        rowCount: 0,
        volume: null,
        handleValue: null,
        transferValue: null,
        outcomeValue: null,
      };
      current.rowCount += 1;
      const volume = volumeField ? numeric(row?.[volumeField]) : null;
      if (volume != null) current.volume = (current.volume || 0) + volume;
      current.handleValue ??= handleField ? numeric(row?.[handleField]) : null;
      current.transferValue ??= transferField ? numeric(row?.[transferField]) : null;
      current.outcomeValue ??= outcomeField ? numeric(row?.[outcomeField]) : null;
      classified.set(topicId, current);
    }
  }
  return {
    provided: true,
    fileName: supplementary.fileName || "supplementary data",
    rowCount: rows.length,
    fields,
    signals,
    evidenceRows: [...classified.values()]
      .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
      .slice(0, 12),
  };
}

export function analyzeCalls(calls, { supplementary = null, source = "upload" } = {}) {
  const features = calls.map(callFeatures);
  const transcriptCalls = features.filter((call) => call.hasTranscript);
  const coverage = calls.length ? transcriptCalls.length / calls.length : 0;
  const topics = aggregateTopics(features);
  const supplement = supplementarySummary(supplementary);
  const candidates = portfolioCandidates(topics, features, coverage, supplement);
  const agentCandidates = candidates.filter((item) => item.solution === "AI Agent");
  const assistantCandidates = candidates.filter(
    (item) => item.solution === "AI Assistant",
  );
  const handleValues = features.map((call) => call.handleTime).filter(Boolean);
  const holdValues = features.map((call) => call.holdDuration).filter(Boolean);
  const transferCalls = features.filter((call) => call.transferCount > 0).length;
  const negativeCalls = features.filter((call) => call.negativeSignals > 0).length;
  const resolutionCalls = features.filter((call) => call.resolutionSignals > 0).length;
  const manualWorkCalls = features.filter((call) => call.manualWorkSignals > 1).length;

  return {
    generatedAt: new Date().toISOString(),
    methodologyVersion: "evidence-model-1.0",
    source,
    summary: {
      callsRequested: calls.length,
      callsWithTranscript: transcriptCalls.length,
      transcriptCoverage: round(coverage, 3),
      topicCount: topics.length,
      agentCandidateCount: agentCandidates.length,
      assistantCandidateCount: assistantCandidates.length,
      topRecommendation: candidates[0]?.title || "More transcript evidence needed",
    },
    baseline: {
      medianHandleSeconds: round(percentile(handleValues, 0.5) || 0),
      p75HandleSeconds: round(percentile(handleValues, 0.75) || 0),
      medianHoldSeconds: round(percentile(holdValues, 0.5) || 0),
      transferCallRate: transcriptCalls.length
        ? round(transferCalls / transcriptCalls.length, 3)
        : 0,
      negativeLanguageRate: transcriptCalls.length
        ? round(negativeCalls / transcriptCalls.length, 3)
        : 0,
      resolutionLanguageRate: transcriptCalls.length
        ? round(resolutionCalls / transcriptCalls.length, 3)
        : 0,
      manualWorkSignalRate: transcriptCalls.length
        ? round(manualWorkCalls / transcriptCalls.length, 3)
        : 0,
      basis:
        "Descriptive signals from the selected sample. They are not causal ROI and should be reconciled with Analyzer metrics before setting targets.",
    },
    topics: topics.map((topic) => ({
      ...topic,
      share: round(topic.share, 3),
      transferRate: round(topic.transferRate, 3),
      negativeRate: round(topic.negativeRate, 3),
      averageHoldSeconds: round(topic.averageHoldSeconds),
      averageHandleSeconds: round(topic.averageHandleSeconds),
      taskIds: topic.taskIds.slice(0, 12),
    })),
    candidates,
    calls: features.map((call) => ({
      taskId: call.taskId,
      hasTranscript: call.hasTranscript,
      primaryTopic: call.primaryTopicName,
      wordCount: call.wordCount,
      turnCount: call.turnCount,
      negativeSignals: call.negativeSignals,
      transferCount: call.transferCount,
      holdDuration: round(call.holdDuration),
      handleTime: round(call.handleTime),
      excerpt: call.excerpt,
    })),
    keywords: keywordPhrases(features),
    supplementary: supplement,
    evidenceWarnings: [
      ...(coverage < 0.8
        ? [
            `Transcript coverage is ${Math.round(coverage * 100)}%. Treat ranking as directional until coverage improves.`,
          ]
        : []),
      ...(transcriptCalls.length < 30
        ? ["The sample is smaller than 30 transcript-bearing calls."]
        : []),
      ...(supplement.provided
        ? []
        : [
            "No Analyzer or Topic Analytics export was supplied; volume and outcome triangulation is still pending.",
          ]),
      "Automatically redacted excerpts can still contain business-sensitive context. Review before sharing.",
    ],
    nextSteps: [
      "Review the top call evidence and correct the contact-driver taxonomy.",
      "Reconcile call-level signals with Analyzer volume, handle, transfer, repeat-contact, and outcome measures.",
      "Choose one bounded AI Agent journey and one AI Assistant workflow for discovery.",
      "Define eligibility, knowledge ownership, actions, escalation, safety, and measurement before pilot build.",
      "Pilot against an intent-matched baseline; separate adoption signals from customer, operational, and economic outcomes.",
    ],
  };
}
