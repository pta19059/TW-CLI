import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import {
  authPolicyAgent,
  connectivityAgent,
  endpointHealthAgent,
  gatewayAgent,
  logIntelligenceAgent
} from "./agents/index.js";
import { teamviewerTroubleshootWorkflow } from "./workflows/teamviewerTroubleshootWorkflow.js";

export const mastra = new Mastra({
  agents: {
    gatewayAgent,
    connectivityAgent,
    authPolicyAgent,
    endpointHealthAgent,
    logIntelligenceAgent
  },
  workflows: {
    teamviewerTroubleshootWorkflow
  },
  logger: new PinoLogger({
    name: "twc-mastra",
    level: "info"
  })
});
