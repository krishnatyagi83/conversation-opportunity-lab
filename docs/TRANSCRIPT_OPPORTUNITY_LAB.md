# Conversation Opportunity Lab: API and evidence notes

The Captures API does not select calls by queue. The app therefore:

1. Searches task legs by organization, queue ID, UTC date range, and telephony
   channel.
2. Deduplicates returned call-leg records by task ID.
3. Requests captures in batches of no more than 10 tasks.
4. Downloads available transcript artifacts and normalizes supported JSON,
   vCon-style, caption, and plain-text formats.
5. Redacts common email, phone, payment-card, government-ID, and IP-address
   patterns before evidence is returned to the browser.

The access token must be authorized for the selected organization and the
required Search and Captures operations. The exact permission requirement
depends on the token type and the current Cisco API contract; confirm it in the
official developer documentation for your deployment.

## Upload format

Upload JSON as an array of calls or an object with a `calls` array. A call can
include `text`, `utterances`, `segments`, or a vCon `dialog` field.

```json
{
  "calls": [
    {
      "utterances": [
        { "role": "Customer", "text": "Where is my order?" },
        { "role": "Agent", "text": "I will check the shipping status." }
      ],
      "metadata": { "handleTime": 285000, "transferCount": 0 }
    }
  ]
}
```

Duration metadata uses milliseconds. Uploaded content is processed by the local
service and is not persisted by this application.

## Interpreting results

Search results, transcript artifacts, and usable transcript text are different
counts. A call can be visible in reporting but not match this queue/time search;
a matched task can also lack a retrievable transcript. Check the ingestion
counts before interpreting zero transcript coverage as zero calls.

The recommendation model ranks candidates using recurrence, repeatability,
friction, operational metadata, action needs, risk, sample size, and transcript
coverage. A rank is not a causal ROI claim. Validate candidate workflows with
an intent-matched baseline and customer, operational, quality, and economic
guardrails.
