using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.SubAgents;

/// <summary>
/// Builds a per-run <see cref="ToolHandler"/> + <see cref="ToolDefinition"/>
/// pair that lets a sub-agent terminate its own loop by writing its final
/// report. The caller wires the definition into the sub-agent's tool list
/// and the handler into <see cref="ToolContext.InlineToolHandlers"/>. When
/// the model calls <c>SubmitReport</c>, the handler stashes the report
/// string into a closure exposed via <see cref="GetReport"/>, and the
/// sub-agent runner stops the loop at the next iteration boundary.
///
/// Mirrors the TypeScript helper in
/// <c>src/renderer/src/lib/agent/sub-agents/submit-report-tool.ts</c>.
/// </summary>
public sealed class SubmitReportTool
{
    public const string ToolName = "SubmitReport";

    private string? _submitted;

    public string Name => ToolName;
    public ToolDefinition Definition { get; }
    public ToolHandler Handler { get; }

    public string? GetReport() => _submitted;

    public SubmitReportTool()
    {
        Definition = new ToolDefinition
        {
            Name = ToolName,
            Description =
                "Submit your final work report and end this sub-agent session. " +
                "You MUST call this tool exactly once when you have finished the task — " +
                "the session terminates immediately after the call. " +
                "Do not call any other tools after SubmitReport. " +
                "Put the full report body (conclusion, findings, evidence, next steps) " +
                "into the `report` argument as plain text in the same language as the " +
                "user's request. An empty report is not acceptable.",
            InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "report": {
                      "type": "string",
                      "description": "The complete final report body. Must be non-empty, in the same language as the user's request, and contain every finding, conclusion, and recommendation the caller needs to understand what you did."
                    }
                  },
                  "required": ["report"]
                }
                """)
        };

        Handler = new ToolHandler
        {
            Definition = Definition,
            Execute = (input, _, _) =>
            {
                var report = string.Empty;
                if (input.TryGetValue("report", out var raw) && raw.ValueKind == JsonValueKind.String)
                {
                    report = raw.GetString()?.Trim() ?? string.Empty;
                }

                if (string.IsNullOrEmpty(report))
                {
                    return Task.FromResult(new ToolResultContent
                    {
                        Content = JsonValue.Create(
                            "SubmitReport rejected: the `report` argument was empty. " +
                            "Call SubmitReport again with the full report body — do not call any other tools first.")
                    });
                }

                // First valid submission wins; later calls are ignored but
                // still ack'd so the loop terminates cleanly on the next
                // iteration boundary.
                if (_submitted is null)
                {
                    _submitted = report;
                }

                return Task.FromResult(new ToolResultContent
                {
                    Content = JsonValue.Create(
                        "Report submitted. This sub-agent session will now terminate.")
                });
            },
            RequiresApproval = (_, _) => false
        };
    }

    private static JsonElement ParseSchema(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }
}
