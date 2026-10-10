// A stand-in for the cook role's chef_report, used only by record.mjs before the
// cook role exists. It returns the same result shape as extension/cook.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CookReportSchema } from "../../extension/domain.ts";

export default function reportTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "chef_report",
    label: "Report to chef",
    description: "Report how this run ended.",
    parameters: CookReportSchema,
    outputSchema: CookReportSchema,
    async execute(_id, report) {
      return { content: [{ type: "text", text: `Reported ${report.status}.` }], details: report, structuredContent: report, terminate: true };
    },
  });
}
