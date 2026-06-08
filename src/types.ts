export type ProductKey =
  | "teamviewer-remote"
  | "teamviewer-tensor"
  | "teamviewer-frontline"
  | "teamviewer-assist-ar"
  | "teamviewer-remote-management"
  | "teamviewer-dex";

export type JobType = "debug" | "troubleshoot";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type AgentName =
  | "product-gatekeeper"
  | "session-context"
  | "diagnosis-planner"
  | "connectivity"
  | "auth-policy"
  | "endpoint-health"
  | "log-intelligence"
  | "remediation"
  | "confidence-escalation"
  | "report";

export interface RootCauseCandidate {
  title: string;
  score: number;
  rationale: string;
}

export interface ActionItem {
  step: string;
  risk: "low" | "medium" | "high";
  rollback: string;
  /** Optional ready-to-run, OS-native command extracted for copy-paste. */
  command?: string;
}

export interface AgentExecution {
  name: AgentName;
  status: "completed" | "failed" | "skipped";
  note: string;
}

export interface WorkflowReport {
  summary: string;
  hypotheses: string[];
  evidence: string[];
  rootCauses: RootCauseCandidate[];
  actions: ActionItem[];
  confidence: number;
  escalation: {
    required: boolean;
    reason: string;
  };
  execution: AgentExecution[];
}

export interface JobInput {
  target: string;
  issue: string;
  context?: string;
  /** Optional SSH connection details. When present, all probes execute on
   *  the remote host via SSH instead of locally. */
  connection?: {
    user: string;
    port?: number;
    /** Path to a private key file (otherwise the SSH agent / default key is used). */
    identity?: string;
  };
}

export interface AgentJob {
  id: string;
  product: ProductKey;
  type: JobType;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  input: JobInput;
  output?: string;
  report?: WorkflowReport;
  error?: string;
  pid?: number;
  startedAt?: string;
  completedAt?: string;
}
