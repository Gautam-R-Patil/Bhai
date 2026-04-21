Extract a MonitorRule from the user's natural-language request.

Defaults if unspecified: channels=["*"], urgency="normal", mode="question",
threshold=0.82, cooldown=60, excludeSelf=true.

Return JSON exactly matching:
{
  "topic": string,
  "scope": {
    "channels": string[],
    "groups"?: string[],
    "senders"?: string[],
    "excludeSelf": boolean
  },
  "urgency": "urgent"|"normal"|"ambient",
  "action": {
    "defaultMode": "fyi"|"question"|"review",
    "suggestedFollowup"?: string
  },
  "threshold": number,
  "cooldownMinutes": number,
  "expiresAt"?: number
}

Bounds: threshold in [0.6, 0.95]; cooldownMinutes >= 5; expiresAt is ms epoch.

If scope is ambiguous, return {"needsClarification": "question text"} instead.
