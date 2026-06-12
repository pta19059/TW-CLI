import { describe, expect, it } from "vitest";
import {
  applyRerankScores,
  calculateConfidence,
  cleanSummary,
  deduplicateActions,
  prioritizeActions,
  filterActionsAgainstEvidence,
  filterHypothesesAgainstEvidence,
  filterRootCausesAgainstEvidence,
  hasEvidenceAnchor,
  distinctiveStems
} from "../src/mastra/workflows/teamviewerTroubleshootWorkflow.js";

describe("deduplicateActions", () => {
  it("removes duplicates by step text", () => {
    const out = deduplicateActions([
      { step: "A", risk: "low", rollback: "r1" },
      { step: "A", risk: "high", rollback: "r2" },
      { step: "B", risk: "low", rollback: "r3" }
    ]);
    expect(out.length).toBe(2);
    expect(out.find((a) => a.step === "A")?.risk).toBe("high");
  });
});

describe("applyRerankScores", () => {
  it("preserves the score of evidence-anchored causes even when the LLM tries to demote them", () => {
    const candidates = [
      { title: "macOS standby/sleep is dropping the idle TeamViewer connection", score: 0.82, rationale: "NetWatchdog standby", evidenceAnchored: true }
    ];
    // The small model tries to knock it down to 0.2.
    const out = applyRerankScores(candidates, [
      { title: "macOS standby/sleep is dropping the idle TeamViewer connection", score: 0.2 }
    ]);
    expect(out[0].score).toBe(0.82);
  });

  it("keeps a deliberately demoted evidence-anchored signature at its demoted score (LLM cannot re-promote it)", () => {
    const candidates = [
      { title: "Recurring failure signature in TeamViewer logs", score: 0.35, rationale: "RetryHandle — reconnection aftermath", evidenceAnchored: true }
    ];
    const out = applyRerankScores(candidates, [
      { title: "Recurring failure signature in TeamViewer logs", score: 0.7 }
    ]);
    expect(out[0].score).toBe(0.35);
  });

  it("lets the LLM rescore enrichment causes but floors them at 0.6x original", () => {
    const candidates = [
      { title: "Phantom guess", score: 0.5, rationale: "...", evidenceAnchored: false }
    ];
    // LLM raises it.
    expect(applyRerankScores(candidates, [{ title: "Phantom guess", score: 0.8 }])[0].score).toBe(0.8);
    // LLM forgets it -> floored at 0.6x.
    expect(applyRerankScores(candidates, [])[0].score).toBeCloseTo(0.3, 5);
    // LLM tries to zero it -> floored at 0.6x.
    expect(applyRerankScores(candidates, [{ title: "Phantom guess", score: 0 }])[0].score).toBeCloseTo(0.3, 5);
  });

  it("keeps the standby cause ranked above phantom enrichment after rerank", () => {
    const candidates = [
      { title: "macOS standby/sleep is dropping the idle TeamViewer connection", score: 0.82, rationale: "NetWatchdog", evidenceAnchored: true },
      { title: "Disconnected sessions during system shutdown/reboot", score: 0.55, rationale: "guess", evidenceAnchored: false }
    ];
    // Reproduces the real report: the LLM tried to demote standby and scored
    // the phantom enrichment modestly. With anchored protection, standby keeps
    // 0.82 and stays #1 instead of collapsing to the 0.49 floor.
    const out = applyRerankScores(candidates, [
      { title: "macOS standby/sleep is dropping the idle TeamViewer connection", score: 0.3 },
      { title: "Disconnected sessions during system shutdown/reboot", score: 0.42 }
    ]).sort((a, b) => b.score - a.score);
    expect(out[0].title).toContain("standby");
    expect(out[0].score).toBe(0.82);
    expect(out[1].score).toBe(0.42);
  });
});

describe("calculateConfidence", () => {
  it("boosts on more evidence and troubleshoot task", () => {
    const score = calculateConfidence([{ title: "x", score: 0.6, rationale: "r" }], 5, "troubleshoot");
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThanOrEqual(0.95);
  });
  it("caps at 0.95", () => {
    const score = calculateConfidence([{ title: "x", score: 0.99, rationale: "r" }], 50, "troubleshoot");
    expect(score).toBe(0.95);
  });
  it("caps at 0.55 when no root cause survives (honest escalation)", () => {
    const score = calculateConfidence([], 20, "troubleshoot");
    expect(score).toBeLessThanOrEqual(0.55);
    expect(score).toBeLessThan(0.6); // escalation gate must trip
  });
});

describe("cleanSummary", () => {
  it("keeps a normal one-line summary", () => {
    expect(cleanSummary("TeamViewer dropped due to firewall.")).toBe("TeamViewer dropped due to firewall.");
  });
  it("strips code fences and keeps first non-empty line", () => {
    expect(cleanSummary("```\nFirst line\nSecond line\n```")).toBe("First line");
  });
  it("rejects tool-call JSON shapes", () => {
    expect(cleanSummary('{"name": "teamviewerDocsTool", "arguments": {"query": "x"}}')).toBe("");
    expect(cleanSummary('{"function": "foo", "parameters": {}}')).toBe("");
  });
  it("rejects bare tool-id mentions", () => {
    expect(cleanSummary("call teamviewerDocsTool with query x")).toBe("");
  });
  it("rejects NOT_IN_CONTEXT marker", () => {
    expect(cleanSummary("NOT_IN_CONTEXT")).toBe("");
  });
  it("returns empty on empty / whitespace input", () => {
    expect(cleanSummary("")).toBe("");
    expect(cleanSummary("   \n\n  ")).toBe("");
  });
  it("skips prompt-label echo and returns the first prose line", () => {
    expect(cleanSummary("Task: troubleshoot\nThe service appears down on the Mac.")).toBe("The service appears down on the Mac.");
    expect(cleanSummary("Issue: TeamViewer drops\nProduct: teamviewer-remote\nA real prose summary here.")).toBe("A real prose summary here.");
  });
  it("returns empty when ALL lines are prompt-label echo", () => {
    expect(cleanSummary("Task: troubleshoot\nProduct: x\nConfidence: 0.20")).toBe("");
  });
  it("strips list bullets before evaluating", () => {
    expect(cleanSummary("- The session drops after a few minutes.")).toBe("The session drops after a few minutes.");
  });
  it("rejects meta-talk paraphrases of the prompt", () => {
    expect(cleanSummary("A brief summary of the troubleshooting outcome is that the system logs were checked.")).toBe("");
    expect(cleanSummary("The summary is that everything looks fine.")).toBe("");
    expect(cleanSummary("Summary of the troubleshooting outcome: nothing found.")).toBe("");
  });
});

describe("filterActionsAgainstEvidence", () => {
  const evidence5938Ok = [
    "Target scope: 192.168.1.153",
    "DNS resolved 6/6 TeamViewer hosts from 192.168.1.153",
    "TCP 5938 reachability: 3/3 routers OK",
    "HTTPS webapi probe: HTTP 200 in 1395ms",
    "All baseline connectivity probes succeeded."
  ];
  const evidenceHttpsFailedTcpOk = [
    "Target scope: 192.168.1.153",
    "DNS resolved 6/6 TeamViewer hosts from 192.168.1.153",
    "TCP 5938 reachability: 3/3 routers OK",
    "HTTPS webapi probe: failed (curl: (60) SSL certificate problem)",
    "TeamViewer Remote endpoint TCP reachability: 9/9 OK",
    "TeamViewer Remote HTTPS checks: 0/3 OK"
  ];
  it("drops firewall actions that mention the already-proven-open port 5938", () => {
    const out = filterActionsAgainstEvidence(
      [
        { step: "Check firewall settings for port 5938", risk: "low", rollback: "r" },
        { step: "Restart TeamViewer service", risk: "low", rollback: "r" }
      ],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
    expect(out[0].step).toMatch(/restart/i);
  });
  it("drops generic firewall-blocks-teamviewer actions when connectivity is healthy", () => {
    const out = filterActionsAgainstEvidence(
      [
        { step: "Check system settings for firewall rules blocking TeamViewer traffic.", risk: "low", rollback: "r" },
        { step: "Enable launchd plist", risk: "low", rollback: "r" }
      ],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
    expect(out[0].step).toMatch(/launchd/i);
  });
  it("drops generic firewall actions even when only DNS+TCP are OK (HTTPS may fail for non-firewall reasons)", () => {
    const out = filterActionsAgainstEvidence(
      [
        { step: "Check system settings for any firewall rules that might be blocking TeamViewer traffic.", risk: "low", rollback: "r" },
        { step: "Renew the macOS CA bundle", risk: "low", rollback: "r" }
      ],
      evidenceHttpsFailedTcpOk
    );
    expect(out.length).toBe(1);
    expect(out[0].step).toMatch(/CA bundle/i);
  });
  it("keeps non-firewall actions untouched", () => {
    const out = filterActionsAgainstEvidence(
      [{ step: "Restart the TeamViewer daemon", risk: "low", rollback: "r" }],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
  });
  it("drops a generic 'Check the firewall settings' action (plural settings/blocks dodged the old blocking regex)", () => {
    // Exact live-run regression: this leaked into the report at #4 because the
    // word-boundary blocking regex didn't match plural "settings"/"blocks".
    const out = filterActionsAgainstEvidence(
      [
        {
          step: "Check the firewall settings on the system.",
          risk: "low",
          rollback: "If the firewall blocks the service, temporarily disable the firewall to test the connectivity."
        },
        { step: "Restart the TeamViewer app", risk: "low", rollback: "r" }
      ],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
    expect(out[0].step).toMatch(/restart the teamviewer app/i);
  });
  it("keeps transport-stability actions that mention NAT/firewall idle-timeout (different failure mode from blocking)", () => {
    // Real-world regression: our signature-aware "Transport-layer instability"
    // action mentions "upstream NAT/firewall for idle-timeout < 60s" as a
    // diagnostic for long-lived TCP being culled mid-session. The DNS+TCP-OK
    // proof rules out *blocking*, but does NOT rule out idle-timeout culling.
    // The filter must distinguish "block/allow/open-port/rule" recommendations
    // from "check idle-timeout / rate-limiting" diagnostics.
    const out = filterActionsAgainstEvidence(
      [
        {
          step: "Transport-layer instability dominates the log. Measure link quality with ping/tcpdump. Check upstream NAT/firewall for idle-timeout < 60s and any rate-limiting on long-lived TCP sessions; if on Wi-Fi, test on Ethernet.",
          risk: "low",
          rollback: "Observation steps only \u2014 no rollback needed."
        }
      ],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
  });
  it("keeps actions that mention port 5938 in a diagnostic (tcpdump) context even when 5938 is proven open", () => {
    // Regression: capturing `tcpdump -p 5938` is a DIAGNOSTIC, not a firewall
    // change. The filter must only drop firewall actions whose recommendation
    // is to BLOCK/ALLOW/OPEN/RULE on that port.
    const out = filterActionsAgainstEvidence(
      [
        {
          step: "Capture a 2-min tcpdump on port 5938 during a live drop; check upstream NAT/firewall idle-timeout for long-lived sessions.",
          risk: "low",
          rollback: "Observation only."
        }
      ],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
  });
  it("drops placeholder actions whose step is just '...' or near-empty", () => {
    // The small CPU model sometimes emits literal "..." as a step. Without
    // this filter the action survives the union and appears in the report.
    const out = filterActionsAgainstEvidence(
      [
        { step: "...", risk: "low", rollback: "..." },
        { step: "-", risk: "low", rollback: "no rollback" },
        { step: "ok", risk: "low", rollback: "no rollback" },
        { step: "Restart the TeamViewer app", risk: "low", rollback: "no rollback" }
      ],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
    expect(out[0].step).toMatch(/restart the teamviewer app/i);
  });
  it("does NOT filter when no connectivity evidence is present", () => {
    const out = filterActionsAgainstEvidence(
      [{ step: "Check firewall for port 5938", risk: "low", rollback: "r" }],
      ["Target scope: example.com"]
    );
    expect(out.length).toBe(1);
  });
  it("drops launchctl-load-teamviewerd action when TeamViewer_Service is in process list", () => {
    const out = filterActionsAgainstEvidence(
      [
        { step: "Register/start the background service: sudo launchctl load -w /Library/LaunchDaemons/com.teamviewer.teamviewerd.plist", risk: "low", rollback: "r" },
        { step: "Restart the TeamViewer app", risk: "low", rollback: "r" }
      ],
      [
        "Processes running: TeamViewer, TeamViewer_Service, bash, com.teamviewer.KeychainService",
        "No TeamViewer Remote launch agents/daemons registered with launchctl."
      ]
    );
    expect(out.length).toBe(1);
    expect(out[0].step).toMatch(/restart the teamviewer app/i);
  });
  it("keeps launchctl-load action when TeamViewer_Service is NOT in process list", () => {
    const out = filterActionsAgainstEvidence(
      [{ step: "sudo launchctl load -w com.teamviewer.teamviewerd.plist", risk: "low", rollback: "r" }],
      ["Processes running: bash, ssh"]
    );
    expect(out.length).toBe(1);
  });
  it("drops 'Verify DNS resolution' action when DNS resolved N/N hosts", () => {
    const out = filterActionsAgainstEvidence(
      [
        { step: "Verify DNS resolution on the affected machine.", risk: "low", rollback: "Restart DNS service" },
        { step: "Restart the TeamViewer app", risk: "low", rollback: "r" }
      ],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
    expect(out[0].step).toMatch(/restart the teamviewer app/i);
  });
  it("keeps a DNS diagnostic-tool action (dig/nslookup) during live-repro capture", () => {
    const out = filterActionsAgainstEvidence(
      [{ step: "During a live drop, run nslookup router1.teamviewer.com to confirm DNS still resolves", risk: "low", rollback: "r" }],
      evidence5938Ok
    );
    expect(out.length).toBe(1);
  });
});

describe("filterRootCausesAgainstEvidence", () => {
  const evidenceHttpsFailedTcpOk = [
    "DNS resolved 6/6 TeamViewer hosts from 192.168.1.153",
    "TCP 5938 reachability: 3/3 routers OK",
    "HTTPS webapi probe: failed (curl: (60) SSL certificate problem)",
    "TeamViewer Remote endpoint TCP reachability: 9/9 OK"
  ];
  it("drops firewall root causes when DNS+TCP prove connectivity is fine", () => {
    const out = filterRootCausesAgainstEvidence(
      [
        { title: "User's firewall blocking TeamViewer traffic", score: 0.6, rationale: "Firewall rules could be configured to block outgoing connections." },
        { title: "Expired CA bundle on macOS", score: 0.4, rationale: "Old root store fails to validate TeamViewer cert chain." }
      ],
      evidenceHttpsFailedTcpOk
    );
    expect(out.length).toBe(1);
    expect(out[0].title).toMatch(/CA bundle/i);
  });
  it("keeps non-firewall root causes untouched", () => {
    const out = filterRootCausesAgainstEvidence(
      [{ title: "TeamViewer Service not registered", score: 0.5, rationale: "launchctl shows no daemon" }],
      evidenceHttpsFailedTcpOk
    );
    expect(out.length).toBe(1);
  });
  it("does NOT filter when no connectivity evidence is present", () => {
    const out = filterRootCausesAgainstEvidence(
      [{ title: "Firewall blocking outgoing", score: 0.5, rationale: "..." }],
      ["Target scope: example.com"]
    );
    expect(out.length).toBe(1);
  });
  it("drops LLM-invented CA-bundle root cause when the probe-host TLS caveat is in evidence", () => {
    const out = filterRootCausesAgainstEvidence(
      [
        { title: "Outdated CA bundle on the client", score: 0.7, rationale: "Local certificate validation issues likely indicate an outdated CA bundle." },
        { title: "Real product issue", score: 0.5, rationale: "..." }
      ],
      [
        "DNS resolved 6/6 TeamViewer hosts",
        "TCP 5938 reachability: 3/3 routers OK",
        "Note: the HTTPS failure above is a LOCAL certificate-validation issue on the probe host (likely outdated CA bundle, e.g. macOS Monterey)."
      ]
    );
    expect(out.length).toBe(1);
    expect(out[0].title).toMatch(/Real product issue/);
  });
  it("drops LLM-invented 'service not registered' when TeamViewer_Service is in process list", () => {
    const out = filterRootCausesAgainstEvidence(
      [
        { title: "TeamViewer background service not registered", score: 0.7, rationale: "launchctl listed no TeamViewer daemon" },
        { title: "Network jitter", score: 0.4, rationale: "..." }
      ],
      [
        "DNS resolved 6/6 TeamViewer hosts",
        "TCP 5938 reachability: 3/3 routers OK",
        "Processes running: TeamViewer, TeamViewer_Service, bash"
      ]
    );
    expect(out.length).toBe(1);
    expect(out[0].title).toMatch(/Network jitter/);
  });
  it("drops 'Unstable network connectivity' whose rationale just blames firewall when DNS+TCP OK", () => {
    const out = filterRootCausesAgainstEvidence(
      [
        { title: "Unstable network connectivity", score: 0.7, rationale: "Firewall rules preventing inbound/outbound traffic to/from TeamViewer ports" }
      ],
      [
        "DNS resolved 6/6 TeamViewer hosts",
        "TCP 5938 reachability: 3/3 routers OK"
      ]
    );
    expect(out.length).toBe(0);
  });
  it("drops imperative-form root causes (those are actions, not causes)", () => {
    const out = filterRootCausesAgainstEvidence(
      [
        { title: "Check the system logs for any errors related to TeamViewer", score: 0.7, rationale: "System log entries can provide clues." },
        { title: "Restart the TeamViewer service to ensure all components are functioning correctly", score: 0.6, rationale: "Restart helps." },
        { title: "Outdated TeamViewer client", score: 0.5, rationale: "Older clients have known disconnect bugs." }
      ],
      []
    );
    expect(out.length).toBe(1);
    expect(out[0].title).toMatch(/Outdated/);
  });
  it("drops placeholder root causes whose title is just '...' or near-empty", () => {
    const out = filterRootCausesAgainstEvidence(
      [
        { title: "...", score: 0.42, rationale: "..." },
        { title: "-", score: 0.3, rationale: "nothing" },
        { title: "OK", score: 0.5, rationale: "..." },
        { title: "Outdated TeamViewer client", score: 0.5, rationale: "Older clients have known disconnect bugs." }
      ],
      []
    );
    expect(out.length).toBe(1);
    expect(out[0].title).toMatch(/Outdated/);
  });

  // --- Evidence-anchor gate (Round 8): LLM candidates must touch the evidence ---
  it("drops an LLM candidate (evidenceAnchored=false) that shares nothing with the evidence", () => {
    const out = filterRootCausesAgainstEvidence(
      [
        {
          title: "Permissions Issue",
          score: 0.42,
          rationale: "Recurrence suggests permission-related problems",
          evidenceAnchored: false
        }
      ],
      [
        "DNS resolved 6/6 TeamViewer hosts",
        "TCP 5938 reachability: 3/3 routers OK",
        "Log signature: TAF::CMML ValidHours=2 TimeOut=20000 ms (x8)"
      ]
    );
    expect(out.length).toBe(0);
  });

  it("drops 'System lacks necessary permissions' whose only evidence overlap is the generic word 'service'", () => {
    // Regression: the live Mac run kept this LLM guess because its rationale
    // mentions "service", which matched "TeamViewer_Service" in the process
    // list. "service"/"daemon"/"process" are now generic stopwords, so the
    // candidate has no real anchor and is dropped. (Verified: the user IS an
    // admin and TeamViewer_Service runs as root.)
    const out = filterRootCausesAgainstEvidence(
      [
        {
          title: "System lacks necessary permissions",
          score: 0.42,
          rationale: "The TeamViewer service requires administrative privileges to run properly.",
          evidenceAnchored: false
        }
      ],
      [
        "DNS resolved 6/6 TeamViewer hosts",
        "TCP 5938 reachability: 3/3 routers OK",
        "Processes running: TeamViewer, TeamViewer_Service, bash",
        "Top failure signature: RetryHandle::HandleRetry(): Trying resend to 13 failed (x8)"
      ]
    );
    expect(out.length).toBe(0);
  });

  it("keeps an LLM candidate (evidenceAnchored=false) that anchors to an evidence token", () => {
    const out = filterRootCausesAgainstEvidence(
      [
        {
          title: "DNS resolution instability",
          score: 0.5,
          rationale: "Intermittent failures to resolve TeamViewer hosts",
          evidenceAnchored: false
        }
      ],
      [
        "DNS resolution failed for 2/6 TeamViewer hosts during the window",
        "TCP 5938 reachability: 3/3 routers OK"
      ]
    );
    expect(out.length).toBe(1);
    expect(out[0].title).toMatch(/DNS resolution/);
  });

  it("keeps a probe-derived candidate (evidenceAnchored=true) even with no token overlap", () => {
    const out = filterRootCausesAgainstEvidence(
      [
        {
          title: "Recurring failure signature in logs",
          score: 0.41,
          rationale: "Observed 8 matching entries",
          evidenceAnchored: true
        }
      ],
      ["Target scope: example.com"]
    );
    expect(out.length).toBe(1);
  });

  it("keeps untagged candidates (evidenceAnchored undefined) regardless of anchoring", () => {
    const out = filterRootCausesAgainstEvidence(
      [{ title: "Outdated TeamViewer client", score: 0.5, rationale: "Older clients have known disconnect bugs." }],
      ["Target scope: example.com"]
    );
    expect(out.length).toBe(1);
  });
});

describe("hasEvidenceAnchor", () => {
  it("returns false for a vague cause with no overlap", () => {
    const evidence = distinctiveStems("license TimeOut ValidHours telemetry signature");
    expect(
      hasEvidenceAnchor({ title: "Permissions Issue", rationale: "Recurrence suggests permission-related problems" }, evidence)
    ).toBe(false);
  });

  it("returns true when a distinctive stem overlaps the evidence", () => {
    const evidence = distinctiveStems("DNS resolution failed for TeamViewer hosts");
    expect(
      hasEvidenceAnchor({ title: "DNS resolution instability", rationale: "intermittent resolve failures" }, evidence)
    ).toBe(true);
  });

  it("returns false for a purely generic title with no distinctive stems", () => {
    const evidence = distinctiveStems("DNS resolution failed for TeamViewer hosts");
    expect(hasEvidenceAnchor({ title: "TeamViewer issue", rationale: "problem occurs" }, evidence)).toBe(false);
  });

  it("does NOT anchor on the ubiquitous word 'version' (we always print the installed version)", () => {
    // Evidence always contains "TeamViewer installed: version 15.71.4" — an LLM
    // cause like "Incompatible software versions" must NOT auto-anchor on it.
    const evidence = distinctiveStems("TeamViewer installed: version 15.71.4");
    expect(
      hasEvidenceAnchor(
        { title: "Incompatible software versions", rationale: "The current TeamViewer version does not match the required version for monitoring" },
        evidence
      )
    ).toBe(false);
  });
});

describe("prioritizeActions", () => {
  const fix = { step: "Stop the Mac from sleeping: sudo pmset -a sleep 0 standby 0 powernap 1 tcpkeepalive 1", risk: "low" as const, rollback: "Capture pmset -g before changing, then restore prior values." };
  const hygiene = { step: "(Probe hygiene, not a fix) Refresh the host CA bundle / system trust store.", risk: "low" as const, rollback: "Revert to the previous ca-certificates package." };
  const observation = { step: "These RetryHandle bursts line up with the standby wake events; only measure link quality if drops happen while awake.", risk: "low" as const, rollback: "Observation steps only — no rollback needed." };
  const checkLogs = { step: "Check the system logs for any errors related to TeamViewer.", risk: "low" as const, rollback: "Restart the affected process." };
  const verifySleep = { step: "Verify and confirm the presence of sleep mode on the affected machine.", risk: "low" as const, rollback: "Revert to normal settings." };

  it("floats the real fix to the top and sinks hygiene/observation/filler", () => {
    const out = prioritizeActions([hygiene, checkLogs, observation, fix, verifySleep]);
    expect(out[0].step).toMatch(/pmset/); // the actual fix is #1
    // generic "check the logs" / "verify presence" filler ends up last.
    expect(out[out.length - 1].step).toMatch(/check the system logs|verify and confirm/i);
    // hygiene note is below the fix and below the observation step.
    expect(out.indexOf(fix)).toBeLessThan(out.indexOf(hygiene));
    expect(out.indexOf(observation)).toBeLessThan(out.indexOf(hygiene));
  });

  it("is a stable sort within a tier (preserves specialist order)", () => {
    const a = { step: "Restart the TeamViewer service to clear stuck sessions.", risk: "low" as const, rollback: "none" };
    const b = { step: "Reinstall TeamViewer to reset its configuration.", risk: "medium" as const, rollback: "none" };
    const out = prioritizeActions([a, b]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });
});



describe("filterHypothesesAgainstEvidence", () => {
  const evidenceAllGreen = [
    "DNS resolved 6/6 TeamViewer hosts",
    "TCP 5938 reachability: 3/3 routers OK",
    "TeamViewer Remote endpoint TCP reachability: 9/9 OK"
  ];
  it("drops near-duplicate firewall hypotheses when connectivity is healthy", () => {
    const out = filterHypothesesAgainstEvidence(
      [
        "Firewall rules might block TeamViewer traffic.",
        "There might be a firewall blocking TeamViewer traffic.",
        "Verify firewall settings on both the source and destination machines.",
        "TeamViewer service might be misconfigured"
      ],
      evidenceAllGreen
    );
    // All firewall paraphrases dropped; non-firewall hypothesis kept.
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/misconfigured/i);
  });
  it("dedupes paraphrases by normalised text even without evidence", () => {
    const out = filterHypothesesAgainstEvidence(
      [
        "The DNS resolution could be slow.",
        "DNS resolution might be slow.",
        "Slow DNS resolution"
      ],
      []
    );
    expect(out.length).toBeLessThanOrEqual(2);
  });
  it("drops 'background service might be missing' hypothesis when service is running", () => {
    const out = filterHypothesesAgainstEvidence(
      [
        "TeamViewer's background service might be missing due to recent changes in system configuration",
        "Outdated TeamViewer client could cause drops"
      ],
      [
        ...evidenceAllGreen,
        "Processes running: TeamViewer, TeamViewer_Service, bash"
      ]
    );
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/Outdated/);
  });
  it("always drops UI / user-interface hypotheses (no UI probe exists)", () => {
    const out = filterHypothesesAgainstEvidence(
      [
        "User interface issues could prevent proper interaction",
        "Outdated TeamViewer client could cause drops"
      ],
      []
    );
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/Outdated/);
  });
});
